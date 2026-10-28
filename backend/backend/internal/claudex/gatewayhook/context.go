package gatewayhook

import (
	"github.com/gin-gonic/gin"
)

// DeviceRef identifies the Claudex device a gateway request's API key belongs
// to. A key is a device key only when claudex_devices.api_key_id points to it
// (B4 decides and calls MarkDevice from its KeyMarker).
type DeviceRef struct {
	ID         int64
	UserID     int64
	APIKeyID   int64
	GroupID    *int64
	Platform   string
	AppVersion string
	// Revoked is true when the device was signed out (claudex_devices.revoked_at
	// is set); B4's RequestGuard refuses such requests.
	Revoked bool
}

const (
	ctxKeyDevice = "claudex.gateway.device"
	ctxKeyDetail = "claudex.gateway.refusal_detail"
)

// MarkDevice records that the request uses a Claudex device key.
func MarkDevice(c *gin.Context, d *DeviceRef) {
	if c == nil || d == nil {
		return
	}
	c.Set(ctxKeyDevice, d)
}

// Device returns the device marked on the request, if any.
func Device(c *gin.Context) (*DeviceRef, bool) {
	if c == nil {
		return nil, false
	}
	v, ok := c.Get(ctxKeyDevice)
	if !ok {
		return nil, false
	}
	d, ok := v.(*DeviceRef)
	return d, ok && d != nil
}

// SetDetail presets the structured details of a refusal the caller is about
// to write (B1 426, B4 revoked device, B5 usage rule). For device-key requests
// EnrichRefusals uses this detail instead of asking the describers; it always
// replaces any "claudex" object in the written body.
func SetDetail(c *gin.Context, d *RefusalDetail) {
	if c == nil || d == nil {
		return
	}
	c.Set(ctxKeyDetail, d)
}

// PresetDetail returns the detail set with SetDetail, if any.
func PresetDetail(c *gin.Context) *RefusalDetail {
	if c == nil {
		return nil
	}
	v, ok := c.Get(ctxKeyDetail)
	if !ok {
		return nil
	}
	d, _ := v.(*RefusalDetail)
	return d
}
