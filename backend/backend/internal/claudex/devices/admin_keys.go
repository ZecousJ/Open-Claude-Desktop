package devices

import (
	"database/sql"
	"errors"
	"html"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
)

// User API keys an administrator manages for a user (R13, i1 finding 1).
//
// Owner decision 17 closes /api/v1/keys to regular users until the desktop
// app can manage API keys; administrators still create keys for a user here.
// These are user API keys, not device keys: user_api_keys_enabled does not
// apply (it only gates the users' own endpoint), revoke-all never touches
// them (it only disables keys claudex_devices points to, owner decision 13),
// and device keys cannot be listed, created or deleted through these routes
// (they belong to a device: revoke the device instead).
//
//	GET    /api/v1/admin/claudex/users/:user_id/api-keys
//	POST   /api/v1/admin/claudex/users/:user_id/api-keys          (step-up)
//	DELETE /api/v1/admin/claudex/users/:user_id/api-keys/:key_id  (step-up)

// Limits of the create request.
const (
	userKeyNameMaxRunes  = 100
	userKeyMaxExpiryDays = 3650
	userKeyMaxIPEntries  = 100
	userKeyListLimit     = 200
)

// Errors of the user API key endpoints.
var (
	// ErrReservedKeyName: the name is in the device key namespace.
	ErrReservedKeyName = infraerrors.BadRequest("CLAUDEX_RESERVED_KEY_NAME",
		"Names starting with claudex-device: or claudex-desktop: are reserved for Claudex device keys.")
	// ErrGroupNotAllowed: the user cannot use the group.
	ErrGroupNotAllowed = infraerrors.BadRequest("CLAUDEX_GROUP_NOT_ALLOWED",
		"This user can't use that group. Pick one of the user's groups.")
	// ErrAPIKeyNotFound: no such key of this user.
	ErrAPIKeyNotFound = infraerrors.NotFound("CLAUDEX_API_KEY_NOT_FOUND", "API key not found.")
	// ErrAdminDeviceKeyManaged: the key belongs to a Claudex device (the same
	// reason the users' /api/v1/keys answers, core.ErrDeviceKeyManaged).
	ErrAdminDeviceKeyManaged = infraerrors.Forbidden("CLAUDEX_DEVICE_KEY_MANAGED",
		"This is a Claudex device key. Revoke the device instead.")
)

// reservedKeyPrefixes are the device key names (DeviceKeyName, LegacyKeyName).
var reservedKeyPrefixes = []string{"claudex-device:", "claudex-desktop:"}

// ReservedKeyName reports whether a key name is in the device key namespace
// (case-insensitive, ignoring surrounding spaces).
func ReservedKeyName(name string) bool {
	n := strings.ToLower(strings.TrimSpace(name))
	for _, p := range reservedKeyPrefixes {
		if strings.HasPrefix(n, p) {
			return true
		}
	}
	return false
}

// CreateUserKeyRequest is the body of POST .../users/:user_id/api-keys.
type CreateUserKeyRequest struct {
	Name          string   `json:"name"`
	GroupID       *int64   `json:"group_id"`
	Quota         float64  `json:"quota"`
	ExpiresInDays *int     `json:"expires_in_days"`
	IPWhitelist   []string `json:"ip_whitelist"`
}

// CreatedUserKeyJSON is the answer of the create endpoint: the only place the
// plaintext key is ever shown.
type CreatedUserKeyJSON struct {
	ID        int64      `json:"id"`
	Name      string     `json:"name"`
	Key       string     `json:"key"`
	GroupID   *int64     `json:"group_id"`
	Status    string     `json:"status"`
	Quota     float64    `json:"quota"`
	ExpiresAt *time.Time `json:"expires_at"`
	CreatedAt time.Time  `json:"created_at"`
}

// UserKeyJSON is one item of the list (the key only as a hint).
type UserKeyJSON struct {
	ID         int64      `json:"id"`
	Name       string     `json:"name"`
	KeyHint    string     `json:"key_hint"`
	GroupID    *int64     `json:"group_id"`
	GroupName  string     `json:"group_name"`
	Status     string     `json:"status"`
	Quota      float64    `json:"quota"`
	QuotaUsed  float64    `json:"quota_used"`
	ExpiresAt  *time.Time `json:"expires_at"`
	LastUsedAt *time.Time `json:"last_used_at"`
	CreatedAt  time.Time  `json:"created_at"`
}

func invalidUserKey(field, rule, message string) error {
	return infraerrors.BadRequest("CLAUDEX_API_KEY_INVALID", message).
		WithMetadata(map[string]string{"field": field, "rule": rule})
}

// validate checks and normalizes the request (the name is trimmed).
func (r *CreateUserKeyRequest) validate() error {
	r.Name = strings.TrimSpace(r.Name)
	switch {
	case r.Name == "":
		return invalidUserKey("name", "required", "Enter a name for the key.")
	case utf8.RuneCountInString(r.Name) > userKeyNameMaxRunes:
		return invalidUserKey("name", "max_length", "The name can be at most 100 characters.")
	case ReservedKeyName(r.Name):
		return ErrReservedKeyName
	}
	if r.GroupID != nil && *r.GroupID <= 0 {
		r.GroupID = nil
	}
	if r.Quota < 0 || r.Quota > 1e12 {
		return invalidUserKey("quota", "range", "The quota must be 0 (no limit) or a positive amount.")
	}
	if r.ExpiresInDays != nil && (*r.ExpiresInDays < 1 || *r.ExpiresInDays > userKeyMaxExpiryDays) {
		return invalidUserKey("expires_in_days", "range", "Expiry must be 1 to 3650 days, or empty for never.")
	}
	var ips []string
	for _, ip := range r.IPWhitelist {
		if ip = strings.TrimSpace(ip); ip != "" {
			ips = append(ips, ip)
		}
	}
	if len(ips) > userKeyMaxIPEntries {
		return invalidUserKey("ip_whitelist", "max_items", "The IP allowlist can have at most 100 entries.")
	}
	r.IPWhitelist = ips
	return nil
}

// GET /api/v1/admin/claudex/users/:user_id/api-keys: the user's API keys
// without device keys (newest first, at most 200), keys only as hints.
func (c *Component) adminListUserKeys(g *gin.Context) {
	userID, err := c.requireUser(g)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	rows, err := c.env.DB.QueryContext(g.Request.Context(), `SELECT k.id, k.name, COALESCE(LEFT(k.key, 3), ''), COALESCE(RIGHT(k.key, 4), ''),
	k.group_id, COALESCE(gr.name, ''), k.status, k.quota, k.quota_used, k.expires_at, k.last_used_at, k.created_at
FROM api_keys k
LEFT JOIN groups gr ON gr.id = k.group_id AND gr.deleted_at IS NULL
WHERE k.user_id = $1 AND k.deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM claudex_devices d WHERE d.api_key_id = k.id)
  AND NOT EXISTS (SELECT 1 FROM claudex_device_group_keys gk WHERE gk.api_key_id = k.id)
ORDER BY k.id DESC LIMIT $2`, userID, userKeyListLimit)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	defer func() { _ = rows.Close() }()
	items := []UserKeyJSON{}
	for rows.Next() {
		var it UserKeyJSON
		var prefix, last4 string
		var groupID sql.NullInt64
		var expires, used sql.NullTime
		if err := rows.Scan(&it.ID, &it.Name, &prefix, &last4, &groupID, &it.GroupName, &it.Status,
			&it.Quota, &it.QuotaUsed, &expires, &used, &it.CreatedAt); err != nil {
			response.ErrorFrom(g, err)
			return
		}
		it.Name = html.UnescapeString(it.Name) // the upstream service stores names HTML-escaped
		it.KeyHint = keyHint(prefix, last4)
		it.GroupID, it.ExpiresAt, it.LastUsedAt = nullInt(groupID), nullTime(expires), nullTime(used)
		it.CreatedAt = it.CreatedAt.UTC()
		items = append(items, it)
	}
	if err := rows.Err(); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	response.Success(g, gin.H{"items": items})
}

// POST /api/v1/admin/claudex/users/:user_id/api-keys (step-up): creates a user
// API key through the upstream service. It does not pass the user gate
// (core.APIKeyCreateGate); the plaintext key is in this answer only (the
// audit log keeps the request, never the answer).
func (c *Component) adminCreateUserKey(g *gin.Context) {
	userID, err := c.requireUser(g)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	keys := c.keys()
	if keys == nil {
		response.ErrorFrom(g, errStorageUnavailable)
		return
	}
	var body CreateUserKeyRequest
	if err := decodeBody(g, &body); err != nil {
		response.ErrorFrom(g, invalidUserKey("body", "json", "The request body must be a JSON object."))
		return
	}
	if err := body.validate(); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	ctx := g.Request.Context()
	if body.GroupID != nil {
		allowed, err := c.userMayUseGroup(g, userID, *body.GroupID)
		if err != nil {
			response.ErrorFrom(g, err)
			return
		}
		if !allowed {
			response.ErrorFrom(g, ErrGroupNotAllowed)
			return
		}
	}
	req := service.CreateAPIKeyRequest{
		Name:          body.Name,
		GroupID:       body.GroupID,
		Quota:         body.Quota,
		ExpiresInDays: body.ExpiresInDays,
		IPWhitelist:   body.IPWhitelist,
	}
	key, err := keys.Create(ctx, userID, req)
	if err != nil {
		switch {
		case errors.Is(err, service.ErrGroupNotAllowed), errors.Is(err, service.ErrGroupNotFound):
			response.ErrorFrom(g, ErrGroupNotAllowed)
		case errors.Is(err, service.ErrInvalidIPPattern):
			response.ErrorFrom(g, invalidUserKey("ip_whitelist", "pattern", "Enter IP addresses or CIDR ranges, one per line."))
		default:
			response.ErrorFrom(g, err)
		}
		return
	}
	out := CreatedUserKeyJSON{
		ID:        key.ID,
		Name:      body.Name, // the service stores it HTML-escaped
		Key:       key.Key,
		GroupID:   key.GroupID,
		Status:    key.Status,
		Quota:     key.Quota,
		ExpiresAt: key.ExpiresAt,
		CreatedAt: key.CreatedAt.UTC(),
	}
	if out.ExpiresAt != nil {
		t := out.ExpiresAt.UTC()
		out.ExpiresAt = &t
	}
	if out.CreatedAt.IsZero() {
		out.CreatedAt = c.now().UTC()
	}
	g.Header("Cache-Control", "no-store")
	response.Success(g, out)
}

// userMayUseGroup reports whether the group is one the user can bind (the
// upstream "available groups": active, and public or granted to the user).
func (c *Component) userMayUseGroup(g *gin.Context, userID, groupID int64) (bool, error) {
	groups, err := c.keys().GetAvailableGroups(g.Request.Context(), userID)
	if err != nil {
		if errors.Is(err, service.ErrUserNotFound) {
			return false, ErrUserNotFound
		}
		return false, err
	}
	for i := range groups {
		if groups[i].ID == groupID && groups[i].Status == service.StatusActive {
			return true, nil
		}
	}
	return false, nil
}

// DELETE /api/v1/admin/claudex/users/:user_id/api-keys/:key_id (step-up):
// soft-deletes one of the user's API keys through the upstream service. Device
// keys are refused (revoke the device instead).
func (c *Component) adminDeleteUserKey(g *gin.Context) {
	userID, err := c.requireUser(g)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	keys := c.keys()
	if keys == nil {
		response.ErrorFrom(g, errStorageUnavailable)
		return
	}
	keyID, err := strconv.ParseInt(g.Param("key_id"), 10, 64)
	if err != nil || keyID <= 0 {
		response.ErrorFrom(g, ErrAPIKeyNotFound)
		return
	}
	ctx := g.Request.Context()
	var owner sql.NullInt64
	var device bool
	err = c.env.DB.QueryRowContext(ctx, `SELECT k.user_id, EXISTS (SELECT 1 FROM claudex_devices d WHERE d.api_key_id = k.id)
	OR EXISTS (SELECT 1 FROM claudex_device_group_keys gk WHERE gk.api_key_id = k.id)
FROM api_keys k WHERE k.id = $1 AND k.deleted_at IS NULL`, keyID).Scan(&owner, &device)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		response.ErrorFrom(g, ErrAPIKeyNotFound)
		return
	case err != nil:
		response.ErrorFrom(g, err)
		return
	case !owner.Valid || owner.Int64 != userID:
		response.ErrorFrom(g, ErrAPIKeyNotFound)
		return
	case device:
		response.ErrorFrom(g, ErrAdminDeviceKeyManaged)
		return
	}
	if err := keys.Delete(ctx, keyID, userID); err != nil {
		if errors.Is(err, service.ErrAPIKeyNotFound) || errors.Is(err, service.ErrInsufficientPerms) {
			response.ErrorFrom(g, ErrAPIKeyNotFound)
			return
		}
		response.ErrorFrom(g, err)
		return
	}
	response.Success(g, gin.H{"deleted": true})
}
