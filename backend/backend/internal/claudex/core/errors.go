package core

import (
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
)

// Shared Claudex errors (design 1.8). Answer them with response.ErrorFrom;
// add metadata with WithMetadata, which copies the error.
var (
	// ErrNoPlan: the user has no group Claudex can use.
	ErrNoPlan = infraerrors.Forbidden("CLAUDEX_NO_PLAN",
		"Your account has no plan that Claudex can use. Contact your administrator.")
	// ErrUserAPIKeysDisabled: creating API keys through /api/v1/keys is turned
	// off for users (owner decision 17).
	ErrUserAPIKeysDisabled = infraerrors.Forbidden("CLAUDEX_USER_API_KEYS_DISABLED",
		"Creating API keys is turned off on this server. Contact your administrator.")
	// ErrDeviceKeyManaged: a user tried to change or delete a device key
	// through /api/v1/keys (H13).
	ErrDeviceKeyManaged = infraerrors.Forbidden("CLAUDEX_DEVICE_KEY_MANAGED",
		"This key belongs to a Claudex desktop sign-in. Sign out of that device instead.")
)

// InvalidClientHeader is the 400 answer for a malformed X-Claudex-* header
// (or the matching query parameter of /claudex/release).
func InvalidClientHeader(header string) error {
	return infraerrors.BadRequest("CLAUDEX_INVALID_CLIENT_HEADER", "Invalid "+header+" header").
		WithMetadata(map[string]string{"header": header})
}

// InvalidSetting is the generic 400 for a setting that fails validation.
// Components usually use their own reason (CLAUDEX_POLICY_INVALID, ...) with
// the same metadata keys: field and rule.
func InvalidSetting(reason, field, rule, message string) error {
	if reason == "" {
		reason = "CLAUDEX_SETTING_INVALID"
	}
	return infraerrors.BadRequest(reason, message).WithMetadata(map[string]string{"field": field, "rule": rule})
}
