package devices

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/x509"
	"encoding/base64"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/gin-gonic/gin"
)

type signingDeviceBody struct {
	DeviceID         *string `json:"device_id"`
	DisplayName      string  `json:"display_name"`
	Platform         string  `json:"platform"`
	PublicKey        *string `json:"public_key"`
	IsHardwareBacked *bool   `json:"is_hardware_backed"`
	CredentialClass  string  `json:"credential_class"`
}

func (c *Component) signingDeviceRoute(handle func(*gin.Context, int64) error) gin.HandlerFunc {
	return func(g *gin.Context) {
		g.Header("Cache-Control", "no-store")
		userID, ok := core.Subject(g)
		if !ok {
			response.ErrorFrom(g, infraerrors.Unauthorized("UNAUTHORIZED", "Sign in first."))
			return
		}
		if c.env.DB == nil {
			response.ErrorFrom(g, errSigningRegistryUnavailable)
			return
		}
		response.ErrorFrom(g, handle(g, userID))
	}
}

func (c *Component) getSigningDevices(g *gin.Context, userID int64) error {
	devices, err := c.listSigningDevices(g.Request.Context(), userID)
	if err != nil {
		return err
	}
	response.Success(g, gin.H{"devices": devices})
	return nil
}

func (c *Component) postSigningDevice(g *gin.Context, userID int64) error {
	var body signingDeviceBody
	if err := decodeBody(g, &body); err != nil {
		return invalidSigningDevice("The request body must be a JSON object.")
	}
	in, err := parseSigningDevice(body)
	if err != nil {
		return err
	}
	d, err := c.registerSigningDevice(g.Request.Context(), userID, in)
	if err != nil {
		return err
	}
	response.Success(g, d)
	return nil
}

func (c *Component) patchSigningDevice(g *gin.Context, userID int64) error {
	id := g.Param("id")
	if !core.ValidDeviceID(id) {
		return errSigningDeviceNotFound
	}
	var body struct {
		DisplayName string `json:"display_name"`
	}
	if err := decodeBody(g, &body); err != nil {
		return invalidSigningDevice("The request body must be a JSON object.")
	}
	name, err := signingDisplayName(body.DisplayName)
	if err != nil {
		return err
	}
	d, err := c.renameSigningDevice(g.Request.Context(), userID, id, name)
	if err != nil {
		return err
	}
	response.Success(g, d)
	return nil
}

func (c *Component) deleteSigningDevice(g *gin.Context, userID int64) error {
	id := g.Param("id")
	if !core.ValidDeviceID(id) {
		return errSigningDeviceNotFound
	}
	if err := c.revokeSigningDevice(g.Request.Context(), userID, id); err != nil {
		return err
	}
	response.Success(g, nil)
	return nil
}

func parseSigningDevice(body signingDeviceBody) (signingDeviceRegistration, error) {
	name, err := signingDisplayName(body.DisplayName)
	if err != nil {
		return signingDeviceRegistration{}, err
	}
	in := signingDeviceRegistration{DisplayName: name, Platform: body.Platform}
	if !core.ValidPlatform(in.Platform) {
		return in, invalidSigningDevice("Platform must be darwin, win32 or linux.")
	}
	if body.DeviceID != nil {
		if !core.ValidDeviceID(*body.DeviceID) {
			return in, invalidSigningDevice("The device ID must be a UUID.")
		}
		in.DeviceID = strings.ToLower(*body.DeviceID)
	}
	if body.CredentialClass == "keyless" && body.PublicKey == nil && (body.IsHardwareBacked == nil || !*body.IsHardwareBacked) {
		return in, nil
	}
	if body.CredentialClass != "" || in.DeviceID == "" || body.PublicKey == nil || body.IsHardwareBacked == nil {
		return in, invalidSigningDevice("A signing registration requires a device ID, public key, and hardware-backed flag.")
	}
	key, err := base64.StdEncoding.DecodeString(*body.PublicKey)
	if err != nil {
		return in, invalidSigningDevice("The public key must be a base64-encoded P-256 SPKI key.")
	}
	parsed, err := x509.ParsePKIXPublicKey(key)
	publicKey, ok := parsed.(*ecdsa.PublicKey)
	if err != nil || !ok || publicKey.Curve != elliptic.P256() {
		return in, invalidSigningDevice("The public key must be a base64-encoded P-256 SPKI key.")
	}
	in.PublicKey, err = x509.MarshalPKIXPublicKey(publicKey)
	if err != nil {
		return in, err
	}
	in.IsHardwareBacked = *body.IsHardwareBacked
	return in, nil
}

func signingDisplayName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	switch {
	case name == "":
		return "", invalidSigningDevice("A display name is required.")
	case utf8.RuneCountInString(name) > 255:
		return "", invalidSigningDevice("A display name can have at most 255 characters.")
	}
	for _, r := range name {
		if unicode.IsControl(r) || unicode.Is(unicode.Bidi_Control, r) || r == '\u2028' || r == '\u2029' {
			return "", invalidSigningDevice("The display name contains invalid characters.")
		}
	}
	return name, nil
}

func invalidSigningDevice(message string) error {
	return infraerrors.BadRequest("cowork_remote_device_invalid", message)
}
