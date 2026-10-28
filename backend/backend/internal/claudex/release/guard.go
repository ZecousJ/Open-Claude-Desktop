package release

import (
	"net/http"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/gatewayhook"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
)

// Gateway minimum version (design 2.2, owner decision 7).

// UpgradeRequiredCode is the gateway error code of the 426 answer.
const UpgradeRequiredCode = "CLAUDEX_UPGRADE_REQUIRED"

// missingVersion is the version assumed when a device-key request has no
// (valid) X-Claudex-Version header.
const missingVersion = "0.0.0"

// Priority implements gatewayhook.RequestGuard: after the revoked-device
// check (B4, 10), before the usage rules (B5, 30).
func (c *Component) Priority() int { return gatewayhook.PriorityVersion }

// OnRequest implements gatewayhook.RequestGuard (hook H5b). It runs after
// every upstream API-key check passed, so a disabled key, a blocked IP or an
// inactive user get their upstream error first (API_KEY_DISABLED, ...).
//
// It refuses with 426 only when all hold: the key is a Claudex device key
// (B4 marked the request), enforce_minimum_on_gateway is on (off by
// default), a minimum version is configured, and the X-Claudex-Version
// header (missing or malformed counts as 0.0.0) is below it. Other keys are
// never affected. The version header can be forged: this is a product
// check, not a security boundary.
func (c *Component) OnRequest(g *gin.Context, _ *service.APIKey) bool {
	if _, ok := gatewayhook.Device(g); !ok {
		return false
	}
	platform, arch, version, _ := core.ClientInfo(g)
	checked := version
	if checked == "" {
		checked = missingVersion
	}
	rs := c.Evaluate(g.Request.Context(), platform, arch, checked)
	if !rs.Enforced || rs.State != core.ReleaseStateRequired {
		return false
	}
	message := upgradeMessage(version, rs.LatestVersion)
	detail := &gatewayhook.RefusalDetail{
		V:              1,
		Reason:         "UPGRADE_REQUIRED",
		Kind:           "upgrade",
		Reprovision:    false,
		Action:         "update",
		MinimumVersion: rs.MinimumVersion,
		LatestVersion:  rs.LatestVersion,
		DownloadURL:    rs.DownloadURL,
		Message:        message,
	}
	// The preset detail is what the /v1 refusal rewriter puts in "claudex";
	// the body carries the same object for the route families the rewriter
	// does not cover (root aliases, /backend-api/codex, /v1beta, /antigravity).
	gatewayhook.SetDetail(g, detail)
	g.AbortWithStatusJSON(http.StatusUpgradeRequired, gin.H{
		"code":    UpgradeRequiredCode,
		"message": message,
		"claudex": detail,
	})
	return true
}

func upgradeMessage(version, latest string) string {
	current := "This version of Claudex"
	if version != "" {
		current += " (" + version + ")"
	}
	return current + " is no longer supported. Update to " + latest + " to keep working."
}

var _ gatewayhook.RequestGuard = (*Component)(nil)
