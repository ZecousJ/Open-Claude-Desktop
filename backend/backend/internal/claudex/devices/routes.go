package devices

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/geoip"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/ip"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"

	"github.com/gin-gonic/gin"
)

// Request limits.
const (
	maxBodyBytes          = 16 << 10
	registerPerUserLimit  = 10 // POST /devices per user per minute
	registerPerDevice     = 2  // registrations of one device per minute
	maxSessionFamilyBytes = 64
)

// RegisterUserRoutes implements core.UserRouter (/api/v1/claudex; JWT with the
// H9b check, backend-mode guard, panel rate limit, X-Claudex-* validation,
// audit log). The raw device id is only ever read from X-Claudex-Device-Id.
func (c *Component) RegisterUserRoutes(g *gin.RouterGroup) {
	g.POST("/devices", c.env.RateLimitPerUser("devices.register", registerPerUserLimit, time.Minute), c.postDevice)
	g.GET("/devices", c.getMyDevices)
	g.DELETE("/devices/current", c.deleteCurrentDevice)
	g.DELETE("/devices/:id", c.deleteMyDevice)
}

// RegisterAdminRoutes implements core.AdminRouter (/api/v1/admin/claudex,
// behind the admin compliance gate). Writes that widen or end access go
// through step-up.
func (c *Component) RegisterAdminRoutes(g *gin.RouterGroup, stepUp gin.HandlerFunc) {
	g.GET("/provisioning", c.adminGetProvisioning)
	g.PUT("/provisioning", stepUp, c.adminPutProvisioning)
	g.GET("/devices", c.adminListDevices)
	g.POST("/devices/:id/revoke", stepUp, c.adminRevokeDevice)
	g.POST("/users/:user_id/devices/revoke-all", stepUp, c.adminRevokeAll)
	g.GET("/users/:user_id/device-limit", c.adminGetDeviceLimit)
	g.PUT("/users/:user_id/device-limit", stepUp, c.adminPutDeviceLimit)
	g.DELETE("/users/:user_id/device-limit", stepUp, c.adminDeleteDeviceLimit)
	// User API keys an administrator manages for a user (admin_keys.go).
	g.GET("/users/:user_id/api-keys", c.adminListUserKeys)
	g.POST("/users/:user_id/api-keys", stepUp, c.adminCreateUserKey)
	g.DELETE("/users/:user_id/api-keys/:key_id", stepUp, c.adminDeleteUserKey)
}

// ---- user endpoints ----

type registerBody struct {
	DeviceName string `json:"device_name"`
	Platform   string `json:"platform"`
	Arch       string `json:"arch"`
	AppVersion string `json:"app_version"`
	GroupID    *int64 `json:"group_id"`
}

// DeviceJSON is the device in the POST /devices answer.
type DeviceJSON struct {
	ID         int64      `json:"id"`
	DeviceName string     `json:"device_name"`
	Platform   string     `json:"platform"`
	Arch       string     `json:"arch"`
	AppVersion string     `json:"app_version"`
	CreatedAt  time.Time  `json:"created_at"`
	LastSeenAt *time.Time `json:"last_seen_at"`
}

// KeyJSON is the device key in the POST /devices answer: the only place its
// plaintext is ever shown.
type KeyJSON struct {
	ID     int64  `json:"id"`
	Key    string `json:"key"`
	Status string `json:"status"`
}

// RegisterResponse is the answer of POST /api/v1/claudex/devices.
type RegisterResponse struct {
	Device DeviceJSON `json:"device"`
	// APIKey is the plan group's key (what clients before MG use); null for
	// an account without a plan group, which signs in on its balance alone.
	APIKey *KeyJSON `json:"api_key"`
	// APIKeys are all of the device's keys, one per group, the plan
	// group's first (MG).
	APIKeys []GroupKeyJSON `json:"api_keys"`
	Created bool           `json:"created"`
	Moved   bool           `json:"moved"`
	Rotated bool           `json:"rotated"`
	Plan    *core.PlanRef  `json:"plan"`
}

// POST /api/v1/claudex/devices
func (c *Component) postDevice(g *gin.Context) {
	g.Header("Cache-Control", "no-store")
	userID, ok := core.Subject(g)
	if !ok {
		response.ErrorFrom(g, infraerrors.Unauthorized("UNAUTHORIZED", "Sign in first."))
		return
	}
	in, err := c.readRegistration(g, userID)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	ctx := g.Request.Context()
	if !c.settings(ctx).Enabled {
		response.ErrorFrom(g, ErrDeviceKeysDisabled)
		return
	}
	// A client caught in a reprovision loop is stopped here (design 2.5).
	throttleKey := "devices.register.device:" + strconv.FormatInt(userID, 10) + ":" + DeviceHash(in.DeviceID)
	if allowed, retryAfter := c.env.Allow(ctx, throttleKey, registerPerDevice, time.Minute); !allowed {
		seconds := int64((retryAfter + time.Second - 1) / time.Second)
		if seconds < 1 {
			seconds = 1
		}
		s := strconv.FormatInt(seconds, 10)
		g.Header("Retry-After", s)
		response.ErrorFrom(g, ErrRegistrationThrottled.WithMetadata(map[string]string{"retry_after_seconds": s}))
		return
	}
	res, err := c.register(ctx, in)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	var key *KeyJSON
	if res.Key != nil {
		key = &KeyJSON{ID: res.Key.ID, Key: res.Key.Key, Status: res.Key.Status}
	}
	response.Success(g, RegisterResponse{
		Device: DeviceJSON{
			ID: res.Device.ID, DeviceName: res.Device.DeviceName, Platform: res.Device.Platform, Arch: res.Device.Arch,
			AppVersion: res.Device.AppVersion, CreatedAt: res.Device.CreatedAt, LastSeenAt: res.Device.LastSeenAt,
		},
		APIKey:  key,
		APIKeys: groupKeysJSON(res.Keys),
		Created: res.Created,
		Moved:   res.Moved,
		Rotated: res.Rotated,
		Plan:    res.Plan,
	})
}

// readRegistration validates the request: the device id from the header, the
// rest from the body (platform, arch and version fall back to the headers).
func (c *Component) readRegistration(g *gin.Context, userID int64) (registration, error) {
	platform, arch, version, deviceID := core.ClientInfo(g)
	if deviceID == "" {
		return registration{}, errDeviceInvalid(core.HeaderDeviceID, "required", "The "+core.HeaderDeviceID+" header is required.")
	}
	var body registerBody
	if err := decodeBody(g, &body); err != nil {
		return registration{}, errDeviceInvalid("body", "json", "The request body must be a JSON object.")
	}
	in := registration{
		UserID:     userID,
		DeviceID:   deviceID,
		DeviceName: cleanDeviceName(body.DeviceName),
		Platform:   strings.TrimSpace(body.Platform),
		Arch:       strings.TrimSpace(body.Arch),
		AppVersion: strings.TrimSpace(body.AppVersion),
		GroupID:    body.GroupID,
		SessionID:  core.SessionID(g),
		IssuedAt:   c.tokenIssuedAt(g),
		IP:         ip.GetClientIP(g),
	}
	if in.Platform == "" {
		in.Platform = platform
	} else if !core.ValidPlatform(in.Platform) {
		return registration{}, errDeviceInvalid("platform", "enum", "Platform must be darwin, win32 or linux.")
	}
	if in.Arch == "" {
		in.Arch = arch
	} else if !core.ValidArch(in.Arch) {
		return registration{}, errDeviceInvalid("arch", "enum", "Arch must be arm64 or x64.")
	}
	if in.AppVersion == "" {
		in.AppVersion = version
	} else if !core.ValidVersion(in.AppVersion) {
		return registration{}, errDeviceInvalid("app_version", "version", "App version must be a version of at most 32 characters.")
	}
	if in.GroupID != nil && *in.GroupID <= 0 {
		return registration{}, errDeviceInvalid("group_id", "positive", "Group must be a group id.")
	}
	if len(in.SessionID) > maxSessionFamilyBytes {
		in.SessionID = in.SessionID[:maxSessionFamilyBytes]
	}
	if len(in.IP) > 64 {
		in.IP = in.IP[:64]
	}
	return in, nil
}

// tokenIssuedAt returns the iat of the caller's access token (the JWT
// middleware already validated it; it keeps only the subject and sid).
func (c *Component) tokenIssuedAt(g *gin.Context) time.Time {
	if c.env == nil || c.env.AuthService == nil {
		return time.Time{}
	}
	parts := strings.SplitN(g.GetHeader("Authorization"), " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return time.Time{}
	}
	claims, err := c.env.AuthService.ValidateToken(strings.TrimSpace(parts[1]))
	if err != nil || claims == nil || claims.IssuedAt == nil {
		return time.Time{}
	}
	return claims.IssuedAt.Time
}

func decodeBody(g *gin.Context, v any) error {
	if g.Request.Body == nil {
		return nil
	}
	dec := json.NewDecoder(http.MaxBytesReader(g.Writer, g.Request.Body, maxBodyBytes))
	if err := dec.Decode(v); err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	return nil
}

// MyDeviceJSON is one item of GET /api/v1/claudex/devices (no key).
type MyDeviceJSON struct {
	ID         int64      `json:"id"`
	DeviceName string     `json:"device_name"`
	Platform   string     `json:"platform"`
	Arch       string     `json:"arch"`
	AppVersion string     `json:"app_version"`
	GroupID    *int64     `json:"group_id"`
	Current    bool       `json:"current"`
	Revoked    bool       `json:"revoked"`
	LastSeenAt *time.Time `json:"last_seen_at"`
	CreatedAt  time.Time  `json:"created_at"`
	// SignedInAt is when the device's current sign-in began (Settings →
	// Account → Active sessions shows it as Created).
	SignedInAt   time.Time      `json:"signed_in_at"`
	LocationInfo geoip.Location `json:"location_info"`
}

// GET /api/v1/claudex/devices
func (c *Component) getMyDevices(g *gin.Context) {
	g.Header("Cache-Control", "no-store")
	userID, ok := core.Subject(g)
	if !ok {
		response.ErrorFrom(g, infraerrors.Unauthorized("UNAUTHORIZED", "Sign in first."))
		return
	}
	db := c.env.DB
	if db == nil {
		response.ErrorFrom(g, errStorageUnavailable)
		return
	}
	ctx := g.Request.Context()
	all, err := listedDevicesOfUser(ctx, db, userID)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	// The web device row is the server's own key for the web app, not a
	// device the user signed in on: the desktop list leaves it out.
	rows := all[:0:0]
	for _, d := range all {
		if d.Platform != PlatformWeb {
			rows = append(rows, d)
		}
	}
	limit, _, err := c.effectiveLimit(ctx, db, userID, c.settings(ctx))
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	current := ""
	if _, _, _, deviceID := core.ClientInfo(g); deviceID != "" {
		current = DeviceHash(deviceID)
	}
	items := make([]MyDeviceJSON, 0, len(rows))
	for _, d := range rows {
		items = append(items, MyDeviceJSON{
			ID: d.ID, DeviceName: d.DeviceName, Platform: d.Platform, Arch: d.Arch, AppVersion: d.AppVersion,
			GroupID: d.GroupID, Current: current != "" && d.Hash == current, Revoked: d.RevokedAt != nil,
			LastSeenAt: d.LastSeenAt, CreatedAt: d.CreatedAt, SignedInAt: d.SignedInAt,
			LocationInfo: geoip.Lookup(d.LastIP),
		})
	}
	response.Success(g, gin.H{"items": items, "limit": limit})
}

// DELETE /api/v1/claudex/devices/current (this device, from X-Claudex-Device-Id)
func (c *Component) deleteCurrentDevice(g *gin.Context) {
	g.Header("Cache-Control", "no-store")
	userID, ok := core.Subject(g)
	if !ok {
		response.ErrorFrom(g, infraerrors.Unauthorized("UNAUTHORIZED", "Sign in first."))
		return
	}
	_, _, _, deviceID := core.ClientInfo(g)
	if deviceID == "" {
		response.ErrorFrom(g, errDeviceInvalid(core.HeaderDeviceID, "required", "The "+core.HeaderDeviceID+" header is required."))
		return
	}
	if err := c.revokeDevice(g.Request.Context(), revokeTarget{UserID: userID, Hash: DeviceHash(deviceID)}, ReasonUser); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	response.Success(g, gin.H{"revoked": true})
}

// DELETE /api/v1/claudex/devices/:id (one of the caller's devices)
func (c *Component) deleteMyDevice(g *gin.Context) {
	g.Header("Cache-Control", "no-store")
	userID, ok := core.Subject(g)
	if !ok {
		response.ErrorFrom(g, infraerrors.Unauthorized("UNAUTHORIZED", "Sign in first."))
		return
	}
	id, err := strconv.ParseInt(g.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		response.ErrorFrom(g, ErrDeviceNotFound)
		return
	}
	if err := c.revokeDevice(g.Request.Context(), revokeTarget{UserID: userID, DeviceID: id}, ReasonUser); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	response.Success(g, gin.H{"revoked": true})
}

// ---- admin endpoints ----

// GET /api/v1/admin/claudex/provisioning
func (c *Component) adminGetProvisioning(g *gin.Context) {
	p, err := c.provisioning.Get(g.Request.Context())
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	response.Success(g, p)
}

// PUT /api/v1/admin/claudex/provisioning (step-up). Fields left out of the
// body keep their current value.
func (c *Component) adminPutProvisioning(g *gin.Context) {
	ctx := g.Request.Context()
	cur, err := c.provisioning.Get(ctx)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	next := cur
	next.AllowedGroupIDs = append([]int64(nil), cur.AllowedGroupIDs...)
	if err := decodeBody(g, &next); err != nil {
		response.ErrorFrom(g, invalidProvisioning("body", "json", "The request body must be a JSON object."))
		return
	}
	normalizeProvisioning(&next)
	if err := validateProvisioning(&next); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	if next.DefaultGroupID != nil {
		if err := c.requireGroup(g, "default_group_id", *next.DefaultGroupID); err != nil {
			response.ErrorFrom(g, err)
			return
		}
	}
	for _, id := range next.AllowedGroupIDs {
		if err := c.requireGroup(g, "allowed_group_ids", id); err != nil {
			response.ErrorFrom(g, err)
			return
		}
	}
	saved, err := c.provisioning.Set(ctx, next)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	response.Success(g, saved)
}

// requireGroup checks that a group exists and is not deleted.
func (c *Component) requireGroup(g *gin.Context, field string, id int64) error {
	if c.env.DB == nil {
		return errStorageUnavailable
	}
	var exists bool
	if err := c.env.DB.QueryRowContext(g.Request.Context(),
		`SELECT EXISTS (SELECT 1 FROM groups WHERE id = $1 AND deleted_at IS NULL)`, id).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return errGroupNotFound(field, id)
	}
	return nil
}

// requireUser parses :user_id and checks that the user exists and is not
// deleted.
func (c *Component) requireUser(g *gin.Context) (int64, error) {
	userID, err := strconv.ParseInt(g.Param("user_id"), 10, 64)
	if err != nil || userID <= 0 {
		return 0, ErrUserNotFound
	}
	if c.env.DB == nil {
		return 0, errStorageUnavailable
	}
	var exists bool
	if err := c.env.DB.QueryRowContext(g.Request.Context(),
		`SELECT EXISTS (SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL)`, userID).Scan(&exists); err != nil {
		return 0, err
	}
	if !exists {
		return 0, ErrUserNotFound
	}
	return userID, nil
}

// AdminDeviceJSON is one item of GET /api/v1/admin/claudex/devices. The key
// appears only as a hint (prefix and last four characters).
type AdminDeviceJSON struct {
	ID               int64      `json:"id"`
	UserID           int64      `json:"user_id"`
	UserEmail        string     `json:"user_email"`
	DeviceName       string     `json:"device_name"`
	Platform         string     `json:"platform"`
	Arch             string     `json:"arch"`
	AppVersion       string     `json:"app_version"`
	GroupID          *int64     `json:"group_id"`
	GroupName        string     `json:"group_name"`
	APIKeyID         *int64     `json:"api_key_id"`
	APIKeyHint       string     `json:"api_key_hint"`
	APIKeyStatus     string     `json:"api_key_status"` // active|disabled|expired|quota_exhausted|deleted|""
	APIKeyLastUsedAt *time.Time `json:"api_key_last_used_at"`
	LastSeenAt       *time.Time `json:"last_seen_at"`
	LastIP           string     `json:"last_ip"`
	RevokedAt        *time.Time `json:"revoked_at"`
	RevokedReason    string     `json:"revoked_reason"`
	CreatedAt        time.Time  `json:"created_at"`
}

// GET /api/v1/admin/claudex/devices?user_id=&q=&status=active|revoked|all&page=&page_size=
func (c *Component) adminListDevices(g *gin.Context) {
	db := c.env.DB
	if db == nil {
		response.ErrorFrom(g, errStorageUnavailable)
		return
	}
	page, pageSize := response.ParsePagination(g)
	if pageSize > 100 {
		pageSize = 100
	}
	var userID int64
	if raw := strings.TrimSpace(g.Query("user_id")); raw != "" {
		v, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || v <= 0 {
			response.ErrorFrom(g, ErrUserNotFound)
			return
		}
		userID = v
	}
	status := strings.TrimSpace(g.Query("status"))
	if status != "active" && status != "revoked" {
		status = ""
	}
	q := strings.TrimSpace(g.Query("q"))
	if r := []rune(q); len(r) > 100 {
		q = string(r[:100])
	}
	pattern := ""
	if q != "" {
		pattern = "%" + likeEscaper.Replace(q) + "%"
	}
	ctx := g.Request.Context()
	const where = `
FROM claudex_devices d
LEFT JOIN users u ON u.id = d.user_id AND u.deleted_at IS NULL
LEFT JOIN groups g ON g.id = d.group_id AND g.deleted_at IS NULL
LEFT JOIN api_keys k ON k.id = d.api_key_id
WHERE ($1::bigint = 0 OR d.user_id = $1)
  AND ($2::text = '' OR (d.revoked_at IS NULL) = ($2::text = 'active'))
  AND ($3::text = '' OR u.email ILIKE $3 ESCAPE '\' OR d.device_name ILIKE $3 ESCAPE '\')`
	var total int64
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*)`+where, userID, status, pattern).Scan(&total); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	rows, err := db.QueryContext(ctx, `SELECT d.id, d.user_id, COALESCE(u.email, ''), d.device_name, d.platform, d.arch, d.app_version,
	d.group_id, COALESCE(g.name, ''), d.api_key_id, COALESCE(LEFT(k.key, 3), ''), COALESCE(RIGHT(k.key, 4), ''),
	COALESCE(k.status, ''), COALESCE(k.deleted_at IS NOT NULL, false), k.last_used_at,
	d.last_seen_at, d.last_ip, d.revoked_at, d.revoked_reason, d.created_at`+where+`
ORDER BY d.id DESC LIMIT $4 OFFSET $5`, userID, status, pattern, pageSize, (page-1)*pageSize)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	defer func() { _ = rows.Close() }()
	items := []AdminDeviceJSON{}
	for rows.Next() {
		var it AdminDeviceJSON
		var groupID, keyID sql.NullInt64
		var prefix, last4 string
		var keyDeleted bool
		var keyUsed, seen, revoked sql.NullTime
		if err := rows.Scan(&it.ID, &it.UserID, &it.UserEmail, &it.DeviceName, &it.Platform, &it.Arch, &it.AppVersion,
			&groupID, &it.GroupName, &keyID, &prefix, &last4, &it.APIKeyStatus, &keyDeleted, &keyUsed,
			&seen, &it.LastIP, &revoked, &it.RevokedReason, &it.CreatedAt); err != nil {
			response.ErrorFrom(g, err)
			return
		}
		it.GroupID, it.APIKeyID = nullInt(groupID), nullInt(keyID)
		it.APIKeyLastUsedAt, it.LastSeenAt, it.RevokedAt = nullTime(keyUsed), nullTime(seen), nullTime(revoked)
		it.CreatedAt = it.CreatedAt.UTC()
		if it.APIKeyID != nil {
			it.APIKeyHint = keyHint(prefix, last4)
			if keyDeleted {
				it.APIKeyStatus = "deleted"
			}
		}
		items = append(items, it)
	}
	if err := rows.Err(); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	response.Paginated(g, items, total, page, pageSize)
}

var likeEscaper = strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)

// keyHint shows a key as "sk-…a1b2" (prefix only for sk- keys).
func keyHint(prefix, last4 string) string {
	if last4 == "" {
		return ""
	}
	if prefix != "sk-" {
		prefix = ""
	}
	return prefix + "…" + last4
}

// POST /api/v1/admin/claudex/devices/:id/revoke (step-up)
func (c *Component) adminRevokeDevice(g *gin.Context) {
	id, err := strconv.ParseInt(g.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		response.ErrorFrom(g, ErrDeviceNotFound)
		return
	}
	if err := c.revokeDevice(g.Request.Context(), revokeTarget{DeviceID: id}, ReasonAdmin); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	response.Success(g, gin.H{"revoked": true})
}

// POST /api/v1/admin/claudex/users/:user_id/devices/revoke-all (step-up): the
// same as the user's "log out of all devices", plus every refresh token.
func (c *Component) adminRevokeAll(g *gin.Context) {
	userID, err := c.requireUser(g)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	ctx := g.Request.Context()
	if c.env.AuthService != nil {
		if err := c.env.AuthService.RevokeAllUserTokens(ctx, userID); err != nil {
			response.ErrorFrom(g, err)
			return
		}
	}
	n, err := c.revokeAll(ctx, userID, ReasonAdmin)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	response.Success(g, gin.H{"revoked": n})
}

// DeviceLimitJSON is the answer of the device-limit endpoints.
type DeviceLimitJSON struct {
	UserID        int64  `json:"user_id"`
	MaxDevices    int    `json:"max_devices"`
	Default       int    `json:"default"`
	Source        string `json:"source"` // user | default
	ActiveDevices int    `json:"active_devices"`
}

func (c *Component) deviceLimit(g *gin.Context, userID int64) (DeviceLimitJSON, error) {
	ctx := g.Request.Context()
	settings := c.settings(ctx)
	limit, override, err := c.effectiveLimit(ctx, c.env.DB, userID, settings)
	if err != nil {
		return DeviceLimitJSON{}, err
	}
	active, err := activeDeviceCount(ctx, c.env.DB, userID)
	if err != nil {
		return DeviceLimitJSON{}, err
	}
	source := "default"
	if override {
		source = "user"
	}
	return DeviceLimitJSON{UserID: userID, MaxDevices: limit, Default: defaultLimit(settings), Source: source, ActiveDevices: active}, nil
}

// GET /api/v1/admin/claudex/users/:user_id/device-limit
func (c *Component) adminGetDeviceLimit(g *gin.Context) {
	userID, err := c.requireUser(g)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	out, err := c.deviceLimit(g, userID)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	response.Success(g, out)
}

// PUT /api/v1/admin/claudex/users/:user_id/device-limit (step-up) {"max_devices": 1..50}.
// Lowering the limit never signs devices out; it applies to new sign-ins.
func (c *Component) adminPutDeviceLimit(g *gin.Context) {
	userID, err := c.requireUser(g)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	var body struct {
		MaxDevices *int `json:"max_devices"`
	}
	if err := decodeBody(g, &body); err != nil {
		response.ErrorFrom(g, invalidProvisioning("body", "json", "The request body must be a JSON object."))
		return
	}
	if body.MaxDevices == nil || *body.MaxDevices < MinMaxDevices || *body.MaxDevices > MaxMaxDevices {
		response.ErrorFrom(g, invalidProvisioning("max_devices", "range", "Max devices must be 1 to 50."))
		return
	}
	var updatedBy any
	if adminID, ok := core.Subject(g); ok {
		updatedBy = adminID
	}
	if _, err := c.env.DB.ExecContext(g.Request.Context(), `INSERT INTO claudex_user_device_limits (user_id, max_devices, updated_by, updated_at)
VALUES ($1, $2, $3, NOW())
ON CONFLICT (user_id) DO UPDATE SET max_devices = EXCLUDED.max_devices, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
		userID, *body.MaxDevices, updatedBy); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	c.adminGetDeviceLimit(g)
}

// DELETE /api/v1/admin/claudex/users/:user_id/device-limit (step-up): back to the default.
func (c *Component) adminDeleteDeviceLimit(g *gin.Context) {
	userID, err := c.requireUser(g)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	if _, err := c.env.DB.ExecContext(g.Request.Context(), `DELETE FROM claudex_user_device_limits WHERE user_id = $1`, userID); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	c.adminGetDeviceLimit(g)
}
