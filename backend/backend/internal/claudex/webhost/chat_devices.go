package webhost

import (
	"bytes"
	"context"
	"encoding/json"
	"strconv"

	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
)

func validChatDeviceModes(modes, permissions []string) bool {
	if len(modes) == 0 || len(modes) > 2 || len(permissions) == 0 || len(permissions) > 2 {
		return false
	}
	for _, mode := range modes {
		if mode != "chat" && mode != "cowork" {
			return false
		}
	}
	for _, permission := range permissions {
		if permission != "default" && permission != "auto" {
			return false
		}
	}
	return true
}

// Only an already assigned user's runner reaches this operation (link.go).
// The service owns account scope; there is no organization tenancy in this
// backend, so a non-null organization is not a valid V1 request.
func (c *Component) chatDeviceRequest(ctx context.Context, userID int64, op string, body json.RawMessage) (any, error) {
	if userID <= 0 {
		return nil, errNoToken
	}
	if op == "device.list" {
		c.loadKnownDevices(ctx, userID)
		return map[string]any{"version": 1, "deviceTrustRelayVersion": 1, "accountScope": strconv.FormatInt(userID, 10), "organizationId": nil, "devices": c.devices.list(userID, true)}, nil
	}
	var input struct {
		Version  int               `json:"version"`
		DeviceID string            `json:"deviceId"`
		Method   string            `json:"method"`
		Args     []json.RawMessage `json:"args"`
		Scope    json.RawMessage   `json:"scope,omitempty"`
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || input.Version != 1 || len(input.Args) != 1 {
		return nil, errBadRPC
	}
	switch input.Method {
	case "chatDeviceImport", "chatDeviceSend", "chatDeviceOpen", "chatDeviceRelease", "chatDeviceBlob", "chatDeviceInterrupt", "chatDeviceApprove", "chatDeviceActivate", "deviceTrustChallenge", "deviceTrustEnroll":
	default:
		return nil, errMethodUnavailable
	}
	validScope := func(raw json.RawMessage) bool {
		var scope struct {
			Version        int             `json:"version"`
			AccountScope   string          `json:"accountScope"`
			OrganizationID json.RawMessage `json:"organizationId"`
		}
		return json.Unmarshal(raw, &scope) == nil && scope.Version == 1 && scope.AccountScope == strconv.FormatInt(userID, 10) && string(scope.OrganizationID) == "null"
	}
	handshake := input.Method == "deviceTrustChallenge" || input.Method == "deviceTrustEnroll"
	scopeArgs := input.Args[0]
	if !handshake {
		// Inspect the Chat scope inside a signed envelope without rebuilding
		// any signed arguments. The owning host verifies proof and replay.
		var envelope struct {
			DeviceTrust json.RawMessage   `json:"deviceTrust"`
			Args        []json.RawMessage `json:"args"`
		}
		if json.Unmarshal(scopeArgs, &envelope) != nil {
			return nil, errBadRPC
		}
		if len(envelope.DeviceTrust) != 0 {
			if string(envelope.DeviceTrust) == "null" || len(envelope.Args) != 1 {
				return nil, errBadRPC
			}
			scopeArgs = envelope.Args[0]
		}
	}
	if (len(input.Scope) != 0 && !validScope(input.Scope)) || (handshake && !validScope(input.Scope)) || (!handshake && !validScope(scopeArgs)) {
		return nil, infraerrors.Forbidden("CLAUDEX_DEVICE_SCOPE_CHANGED", "The signed-in account or organization changed. Select the device again.")
	}
	d := c.devices.get(userID, input.DeviceID)
	if d == nil || d.closed() {
		return nil, errDeviceOffline
	}
	if d.info.ChatBindingVersion != 1 || !d.methods[input.Method] {
		return nil, errMethodUnavailable
	}
	res, err := d.call(ctx, input.Method, input.Args, deviceCallTimeout)
	if err != nil {
		return nil, err
	}
	if res.OK == nil || !*res.OK {
		if res.Error != nil {
			return nil, infraerrors.BadRequest(res.Error.Code, res.Error.Message)
		}
		return nil, errBadRPC
	}
	var value any
	if len(res.Value) == 0 {
		return nil, nil
	}
	if json.Unmarshal(res.Value, &value) != nil {
		return nil, errBadRPC
	}
	return value, nil
}
