package devices

// Managed web key (W-KEY, design W-SRV 6): every user has at most one
// claudex_devices row with platform 'web'. Its key is the model key the web
// runner uses for that user's turns, so upstream usage logs, balance,
// subscriptions, the usage rules (B5) and the web search guard apply exactly
// as for a desktop device. The row
//
//   - never counts toward the desktop device limit (owner decision 9);
//   - has its own hash namespace, so no desktop device id can reach it;
//   - has no session family: signing the web key out never signs a browser
//     out, and a browser sign-out never touches the key;
//   - is revoked by "log out of all devices" like every device row (the
//     next turn after a fresh sign-in gets a new key).
//
// The browser never sees the key: only the server side (W-RELAY hands it to
// the runner, which keeps it in memory) calls EnsureWebKey.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/google/uuid"
)

// PlatformWeb is claudex_devices.platform of the web device row.
const PlatformWeb = "web"

// WebDeviceName is the device name of the web device row (shown in the device
// lists).
const WebDeviceName = "Claudex on the web"

// webDeviceNamespace is the UUIDv5 namespace of the web device ids.
var webDeviceNamespace = uuid.MustParse("6a0f3a52-8f1c-5c1e-9b7e-0c1a7d5e2b41")

// WebDeviceID is the stable device id of a user's web device:
// UUIDv5(namespace, "claudex-web-user:<user id>").
func WebDeviceID(userID int64) string {
	return uuid.NewSHA1(webDeviceNamespace, []byte("claudex-web-user:"+strconv.FormatInt(userID, 10))).String()
}

// WebDeviceHash is the stored device_id_hash of a user's web device. It uses
// its own prefix, so DeviceHash of any desktop device id never equals it.
func WebDeviceHash(userID int64) string {
	sum := sha256.Sum256([]byte("claudex-web-device\n" + WebDeviceID(userID)))
	return hex.EncodeToString(sum[:])
}

// WebKeyName is the name of a web key (for administrators only).
func WebKeyName(hash string) string {
	if len(hash) > 12 {
		hash = hash[:12]
	}
	return "claudex-web:" + hash
}

// WebKeyRequest asks for the web key of a user. SessionID and IssuedAt come
// from the access token of the request that starts the turn (JWT sid and
// iat): a token from before the user's last "log out of all devices", or
// before an administrator revoked the web key, gets ErrSessionRevoked.
type WebKeyRequest struct {
	UserID    int64
	GroupID   *int64 // requested plan group; nil: the provisioning strategy
	SessionID string
	IssuedAt  time.Time
	IP        string
}

// WebKey is the answer of EnsureWebKey. Key is the plaintext key: keep it in
// memory only, never log it, never send it to a browser.
type WebKey struct {
	DeviceID int64 // claudex_devices.id
	UserID   int64
	APIKeyID int64  // the plan group's key
	Key      string // the plan group's key in clear
	GroupID  int64
	Plan     *core.PlanRef
	// Keys are the web device's keys, one per group the user may use, the
	// plan group's first (MG). A request for a model of another group uses
	// that group's key (KeyForGroup); keys never move between groups.
	Keys    []GroupKey
	Created bool // a new web device row
	Rotated bool // a new key replaced the previous plan key
	Moved   bool // another existing key of the web device became the plan key
}

// KeyForGroup returns the web device's key of a group, nil when it has none.
func (w *WebKey) KeyForGroup(groupID int64) *service.APIKey {
	if w == nil {
		return nil
	}
	for _, k := range w.Keys {
		if k.Group.ID == groupID {
			return k.Key
		}
	}
	return nil
}

// Registration is the web key in the shape of the POST /claudex/devices
// answer, so the web runner (key.get) reads it with the desktop's code.
func (w *WebKey) Registration() RegisterResponse {
	out := RegisterResponse{
		Device:  DeviceJSON{ID: w.DeviceID, DeviceName: WebDeviceName, Platform: PlatformWeb},
		APIKey:  &KeyJSON{ID: w.APIKeyID, Key: w.Key, Status: service.StatusAPIKeyActive},
		APIKeys: groupKeysJSON(w.Keys),
		Created: w.Created,
		Moved:   w.Moved,
		Rotated: w.Rotated,
		Plan:    w.Plan,
	}
	for _, k := range w.Keys {
		if k.Primary {
			out.APIKey.Status = k.Key.Status
		}
	}
	return out
}

// NoPlanRegistration is the web key answer for an account without a plan
// group (CLAUDEX_NO_PLAN): no key, no plan. The web app signs in anyway and
// runs on the balance alone (owner decision, 2026-10-12); EnsureWebKey keeps
// answering CLAUDEX_NO_PLAN for the callers that need a key.
func NoPlanRegistration() RegisterResponse {
	return RegisterResponse{
		Device:  DeviceJSON{DeviceName: WebDeviceName, Platform: PlatformWeb},
		APIKeys: []GroupKeyJSON{},
	}
}

// WebKeyIssuer is what the web relay uses from this component.
type WebKeyIssuer interface {
	// EnsureWebKey creates or reuses the user's web key (idempotent,
	// serialized per user with the device registrations).
	EnsureWebKey(ctx context.Context, in WebKeyRequest) (*WebKey, error)
	// IsWebKey reports whether apiKeyID is a web key and whose.
	IsWebKey(ctx context.Context, apiKeyID int64) (userID int64, ok bool)
	// RevokeWebKey signs the user's web key out (idempotent; no row is fine).
	RevokeWebKey(ctx context.Context, userID int64, reason string) error
}

var _ WebKeyIssuer = (*Component)(nil)

// WebKeys returns the installed WebKeyIssuer (the devices component), nil
// when there is none. Use it while serving a request or in Start.
func WebKeys(env *core.Env) WebKeyIssuer {
	if env == nil {
		return nil
	}
	for _, f := range env.Components {
		if w, ok := f.(WebKeyIssuer); ok {
			return w
		}
	}
	return nil
}

// EnsureWebKey implements WebKeyIssuer. It follows register (same user lock,
// revocation rules, per-group keys and their rotation, compensation of keys
// created by a transaction that did not commit) without the desktop parts: no
// device limit, no legacy key, no session family. The plan group only decides
// which key is Key; every group keeps its own key, so asking with another
// GroupID (or none, as dictation does) never moves a key between groups.
func (c *Component) EnsureWebKey(ctx context.Context, in WebKeyRequest) (res *WebKey, err error) {
	if in.UserID <= 0 {
		return nil, ErrUserNotFound
	}
	db, keys := c.env.DB, c.keys()
	if db == nil || keys == nil {
		return nil, errStorageUnavailable
	}
	settings := c.settings(ctx)
	if !settings.Enabled {
		return nil, ErrDeviceKeysDisabled
	}
	plan, groups, err := c.resolvePlanAndGroups(ctx, in.UserID, in.GroupID)
	if err != nil {
		return nil, err
	}
	hash := WebDeviceHash(in.UserID)

	var newKeys []int64
	committed := false
	defer func() {
		if !committed && len(newKeys) > 0 {
			c.compensate(ctx, in.UserID, newKeys)
		}
	}()

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("claudex devices: begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := lockUser(ctx, tx, in.UserID); err != nil {
		return nil, err
	}
	state, err := readSessionState(ctx, tx, in.UserID, in.SessionID)
	if err != nil {
		return nil, fmt.Errorf("claudex devices: read session state: %w", err)
	}
	if state.revokes(in.IssuedAt) {
		return nil, ErrSessionRevoked
	}
	row, err := deviceByHash(ctx, tx, in.UserID, hash, true)
	if err != nil {
		return nil, fmt.Errorf("claudex devices: read web device: %w", err)
	}
	if row != nil && row.Platform != PlatformWeb {
		// Cannot happen (own hash namespace); never hand out a desktop key.
		return nil, fmt.Errorf("claudex devices: web device row %d has platform %q", row.ID, row.Platform)
	}

	res = &WebKey{UserID: in.UserID, Plan: plan, GroupID: plan.GroupID}
	rotateAll := false
	switch {
	case row == nil:
		res.Created = true
	case row.RevokedAt != nil:
		if (row.RevokedReason == ReasonAdmin || row.RevokedReason == ReasonRevokeAll) && !state.issuedAfterRevoke(in.IssuedAt, *row.RevokedAt) {
			return nil, ErrSessionRevoked
		}
		rotateAll = true
	}
	var extras []groupKeyRow
	if row != nil {
		if extras, err = groupKeysOfDevice(ctx, tx, row.ID); err != nil {
			return nil, fmt.Errorf("claudex devices: read web device keys: %w", err)
		}
	}
	sync, err := c.syncKeys(ctx, keys, in.UserID, row, extras, groups, plan.GroupID, rotateAll,
		func(groupID int64, primary bool) (*service.APIKey, error) {
			req := deviceKeyRequest(hash, groupID, settings.KeyDefaults)
			req.Name = groupKeyName(WebKeyName(hash), groupID, primary)
			k, err := keys.Create(ctx, in.UserID, req)
			if err != nil {
				return nil, mapKeyError(err)
			}
			newKeys = append(newKeys, k.ID)
			return k, nil
		})
	if err != nil {
		return nil, err
	}
	key := sync.Primary
	if row != nil && row.RevokedAt != nil {
		res.Rotated = true
	} else {
		res.Rotated, res.Moved = sync.Rotated, sync.Moved
	}
	var oldKeys []int64
	for _, e := range extras {
		oldKeys = append(oldKeys, e.APIKeyID)
	}
	if row != nil && row.APIKeyID != nil {
		oldKeys = append(oldKeys, *row.APIKeyID)
	}

	now := c.now()
	if row == nil {
		row, err = scanDevice(tx.QueryRowContext(ctx, `INSERT INTO claudex_devices
	(user_id, device_id_hash, api_key_id, group_id, session_family_id, device_name, platform, arch, app_version,
	 last_seen_at, last_ip, created_at, updated_at)
VALUES ($1, $2, $3, $4, '', $5, $6, '', '', $7, $8, $7, $7)
RETURNING `+deviceColumns,
			in.UserID, hash, key.ID, plan.GroupID, WebDeviceName, PlatformWeb, now, in.IP))
	} else {
		if _, err = tx.ExecContext(ctx, `DELETE FROM claudex_device_group_keys WHERE device_id = $1`, row.ID); err != nil {
			return nil, fmt.Errorf("claudex devices: store web device keys: %w", err)
		}
		row, err = scanDevice(tx.QueryRowContext(ctx, `UPDATE claudex_devices SET
	api_key_id = $2, group_id = $3, last_seen_at = $4, last_ip = $5, revoked_at = NULL, revoked_reason = '', updated_at = $4
WHERE id = $1
RETURNING `+deviceColumns,
			row.ID, key.ID, plan.GroupID, now, in.IP))
	}
	if err != nil {
		return nil, fmt.Errorf("claudex devices: store web device: %w", err)
	}
	if err := writeGroupKeys(ctx, tx, row.ID, in.UserID, sync.extraRows(), now); err != nil {
		return nil, fmt.Errorf("claudex devices: store web device keys: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("claudex devices: commit: %w", err)
	}
	committed = true

	c.forgetKeys(sync, oldKeys)
	res.DeviceID, res.APIKeyID, res.Key, res.Keys = row.ID, key.ID, key.Key, sync.Keys
	return res, nil
}

// IsWebKey implements WebKeyIssuer (cached like LookupByAPIKey; a revoked web
// device's key still counts as a web key).
func (c *Component) IsWebKey(ctx context.Context, apiKeyID int64) (int64, bool) {
	ref, ok := c.LookupByAPIKey(ctx, apiKeyID)
	if !ok || ref.Platform != PlatformWeb {
		return 0, false
	}
	return ref.UserID, true
}

// RevokeWebKey implements WebKeyIssuer: it signs the web device out (the key
// is disabled; the next EnsureWebKey issues a new one when the revocation
// rules allow it).
func (c *Component) RevokeWebKey(ctx context.Context, userID int64, reason string) error {
	switch reason {
	case ReasonUser, ReasonAdmin, ReasonRevokeAll:
	default:
		reason = ReasonAdmin
	}
	err := c.revokeDevice(ctx, revokeTarget{UserID: userID, Hash: WebDeviceHash(userID)}, reason)
	if errors.Is(err, ErrDeviceNotFound) {
		return nil
	}
	return err
}
