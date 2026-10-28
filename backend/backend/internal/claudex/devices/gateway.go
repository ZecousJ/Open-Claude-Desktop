package devices

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/gatewayhook"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
)

// lastSeenInterval is how often a device's last_seen_at is written from
// gateway traffic.
const lastSeenInterval = 5 * time.Minute

// DeviceRevokedMessage is the refusal text for a signed-out device.
const DeviceRevokedMessage = "This device was signed out. Sign in again to keep working."

// deviceRevokedDetail is the structured refusal for a signed-out device
// (design 2.7 DEVICE_REVOKED).
func deviceRevokedDetail() *gatewayhook.RefusalDetail {
	return &gatewayhook.RefusalDetail{
		V:           1,
		Reason:      "DEVICE_REVOKED",
		Kind:        "key",
		Reprovision: false,
		Action:      "sign_in",
		Message:     DeviceRevokedMessage,
	}
}

// OnKeyResolved implements gatewayhook.KeyMarker (H5): it marks requests made
// with a Claudex device key, revoked devices included. For a revoked device it
// also presets the DEVICE_REVOKED details, so whichever refusal follows (the
// upstream API_KEY_DISABLED for its disabled key, or this component's guard)
// tells the desktop app to sign in again. It never writes a response.
func (c *Component) OnKeyResolved(g *gin.Context, apiKey *service.APIKey) {
	if g == nil || g.Request == nil || apiKey == nil {
		return
	}
	dev, ok := c.LookupByAPIKey(g.Request.Context(), apiKey.ID)
	if !ok {
		return
	}
	gatewayhook.MarkDevice(g, dev)
	if dev.Revoked {
		gatewayhook.SetDetail(g, deviceRevokedDetail())
		return
	}
	c.touch(g.Request.Context(), dev.ID)
}

// Priority implements gatewayhook.RequestGuard.
func (c *Component) Priority() int { return gatewayhook.PriorityDevice }

// OnRequest implements gatewayhook.RequestGuard (H5b): a revoked device is
// refused even when its key was turned back on, because the decision comes
// from claudex_devices.revoked_at, not from the key status.
func (c *Component) OnRequest(g *gin.Context, _ *service.APIKey) bool {
	dev, ok := gatewayhook.Device(g)
	if !ok || !dev.Revoked {
		return false
	}
	gatewayhook.SetDetail(g, deviceRevokedDetail())
	middleware.AbortWithError(g, http.StatusUnauthorized, "API_KEY_DISABLED", "API key is disabled")
	return true
}

// touch writes last_seen_at at most every 5 minutes per device, off the
// request path.
func (c *Component) touch(ctx context.Context, deviceID int64) {
	db := c.env.DB
	if db == nil {
		return
	}
	now := c.now()
	if _, age, ok := c.seen.get(deviceID, now); ok && age < lastSeenInterval {
		return
	}
	c.seen.put(deviceID, struct{}{}, now)
	go func() {
		wctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), lookupTimeout)
		defer cancel()
		if _, err := db.ExecContext(wctx, `UPDATE claudex_devices SET last_seen_at = $2
WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < $2)`, deviceID, now); err != nil {
			slog.Warn("claudex devices: could not record device activity", "device_id", deviceID, "error", err)
		}
	}()
}
