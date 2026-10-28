package memory

import (
	"net/http"
	"strconv"

	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
)

// Errors of the memory endpoints (design R3 3.2). The desktop app switches on
// the reason; the messages are shown as they are.
var (
	// ErrMemoryDisabled: the administrator's policy turned memory (or the part
	// being switched on or written) off. Reads and deletes still work.
	ErrMemoryDisabled = infraerrors.Forbidden("CLAUDEX_MEMORY_DISABLED",
		"Memory is turned off by your administrator.")
	// ErrEncryptionKeyMissing: the server has no fixed secret key, so memory
	// text cannot be stored (it is never stored in plain text).
	ErrEncryptionKeyMissing = infraerrors.ServiceUnavailable("CLAUDEX_MEMORY_ENCRYPTION_KEY_MISSING",
		"Memory isn't available on this server yet. Contact your administrator.")
	// ErrTooLarge: the memory document is over MaxDocBytes.
	ErrTooLarge = infraerrors.New(http.StatusRequestEntityTooLarge, "CLAUDEX_MEMORY_TOO_LARGE",
		"This memory is too long. Shorten it and try again.").
		WithMetadata(map[string]string{"limit": "doc_bytes", "max": strconv.Itoa(MaxDocBytes)})
	// ErrBadScope: the scope is neither "global" nor "project:<uuid>".
	ErrBadScope = infraerrors.BadRequest("CLAUDEX_MEMORY_BAD_SCOPE",
		"Unknown memory scope.")
	// ErrSensitive: a memory edit looks like a credential or a card number.
	ErrSensitive = infraerrors.New(http.StatusUnprocessableEntity, "CLAUDEX_MEMORY_SENSITIVE",
		"Memory can't store passwords, keys, tokens or card numbers.")
	// ErrEditNotFound: no memory edit with that id belongs to the user.
	ErrEditNotFound = infraerrors.NotFound("CLAUDEX_MEMORY_EDIT_NOT_FOUND",
		"That memory edit doesn't exist or was already removed.")
	// ErrUserNotFound: admin routes, no user with that id.
	ErrUserNotFound = infraerrors.NotFound("CLAUDEX_MEMORY_USER_NOT_FOUND",
		"That user doesn't exist.")

	errStoreFailed = infraerrors.InternalServer("CLAUDEX_MEMORY_STORE_FAILED",
		"Couldn't read or save memory. Try again later.")
	errPolicyUnavailable = infraerrors.ServiceUnavailable("CLAUDEX_MEMORY_POLICY_UNAVAILABLE",
		"Couldn't check the memory settings. Try again later.")
	errUnauthorized = infraerrors.Unauthorized("UNAUTHORIZED", "Sign in first.")
)

// disabledFor is ErrMemoryDisabled naming the switch that is off
// ("memory", "search_chats" or "generate").
func disabledFor(field string) error {
	return ErrMemoryDisabled.WithMetadata(map[string]string{"field": field})
}

// conflict is the 409 of a stale base_revision; current_revision is the
// stored revision (0 when the document was deleted), so the client reloads
// GET /memory?scope=… and merges again.
func conflict(current int64) error {
	return infraerrors.Conflict("CLAUDEX_MEMORY_CONFLICT",
		"Memory changed on another device. Reload it and try again.").
		WithMetadata(map[string]string{"current_revision": strconv.FormatInt(current, 10)})
}

// limitReached is the 422 of a count or length limit (metadata limit and
// max).
func limitReached(limit string, max int) error {
	return infraerrors.New(http.StatusUnprocessableEntity, "CLAUDEX_MEMORY_LIMIT",
		"Memory is full. Remove something and try again.").
		WithMetadata(map[string]string{"limit": limit, "max": strconv.Itoa(max)})
}

// invalid is the 400 of a malformed request (metadata field and rule).
func invalid(field, rule, message string) error {
	return infraerrors.BadRequest("CLAUDEX_MEMORY_INVALID", message).
		WithMetadata(map[string]string{"field": field, "rule": rule})
}
