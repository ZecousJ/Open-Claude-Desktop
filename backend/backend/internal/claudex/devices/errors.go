package devices

import (
	"fmt"
	"strconv"

	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
)

// Errors of the devices component (design 1.8). Answer them with
// response.ErrorFrom.
var (
	// ErrDeviceKeysDisabled: the administrator turned provisioning off.
	ErrDeviceKeysDisabled = infraerrors.Forbidden("CLAUDEX_DEVICE_KEYS_DISABLED",
		"Your administrator has turned off Claudex sign-in for this service.")
	// ErrRegistrationThrottled: a third registration of one device within 60 s.
	ErrRegistrationThrottled = infraerrors.TooManyRequests("CLAUDEX_DEVICE_REGISTRATION_THROTTLED",
		"Too many sign-in attempts from this device. Try again in a minute.")
	// ErrDeviceNotFound: no such device, or not the caller's.
	ErrDeviceNotFound = infraerrors.NotFound("CLAUDEX_DEVICE_NOT_FOUND", "Device not found.")
	// ErrSessionRevoked: the access token was issued before the device (or all
	// devices) were signed out; the desktop app must sign in again.
	ErrSessionRevoked = infraerrors.Unauthorized("CLAUDEX_SESSION_REVOKED", "This session was signed out. Sign in again.")
	// ErrUserNotFound: an admin request names a missing or deleted user.
	ErrUserNotFound = infraerrors.BadRequest("CLAUDEX_USER_NOT_FOUND", "User not found.")
	// errStorageUnavailable: the component runs without a database (tests or a
	// broken wiring); production always has one.
	errStorageUnavailable = infraerrors.ServiceUnavailable("CLAUDEX_DEVICES_UNAVAILABLE",
		"Device sign-in is temporarily unavailable. Try again later.")
)

// DeviceLimitMessage is the fixed text of CLAUDEX_DEVICE_LIMIT (owner decision 9).
func DeviceLimitMessage(limit int) string {
	return fmt.Sprintf("You're signed in to Claudex on %d devices, the most your account allows. "+
		"Sign out on one of them, then sign in again.", limit)
}

// errDeviceLimit is the 409 answer for a new device over the user's limit.
func errDeviceLimit(limit, active int) error {
	return infraerrors.Conflict("CLAUDEX_DEVICE_LIMIT", DeviceLimitMessage(limit)).
		WithMetadata(map[string]string{"limit": strconv.Itoa(limit), "active": strconv.Itoa(active)})
}

// errDeviceInvalid is the 400 answer for a malformed registration.
func errDeviceInvalid(field, rule, message string) error {
	return infraerrors.BadRequest("CLAUDEX_DEVICE_INVALID", message).
		WithMetadata(map[string]string{"field": field, "rule": rule})
}

// errGroupNotFound is the 400 answer for a setting that names a missing or
// deleted group.
func errGroupNotFound(field string, groupID int64) error {
	return infraerrors.BadRequest("CLAUDEX_GROUP_NOT_FOUND", "Group not found.").
		WithMetadata(map[string]string{"field": field, "group_id": strconv.FormatInt(groupID, 10)})
}
