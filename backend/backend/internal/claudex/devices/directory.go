package devices

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	claudexhook "github.com/Wei-Shaw/sub2api/internal/claudex/hook"

	"github.com/lib/pq"
)

// lookupTimeout bounds the database reads on hot paths (gateway, JWT check).
const lookupTimeout = 2 * time.Second

// Check implements core.SessionGuard (H9b, called for every JWT request): an
// access token is refused when it was issued no later than the second of the
// user's last revoke-all, or when its session family was signed out. The
// state is cached per user and session for 5 s (this node's writes drop it at
// once). When the database fails and nothing is cached, the answer is
// CheckFailed (503, fail closed).
func (c *Component) Check(ctx context.Context, userID int64, issuedAt time.Time, sessionID string) claudexhook.SessionState {
	if c.env == nil || c.env.DB == nil {
		// No Claudex storage (tests): nothing was ever revoked.
		return claudexhook.Valid
	}
	key := sessionKey{UserID: userID, SID: sessionID}
	now := c.now()
	cached, age, ok := c.sessions.get(key, now)
	if ok && age < freshTTL {
		return verdict(cached, issuedAt)
	}
	qctx, cancel := context.WithTimeout(ctx, lookupTimeout)
	defer cancel()
	state, err := readSessionState(qctx, c.env.DB, userID, sessionID)
	if err != nil {
		if ok && age < staleTTL {
			slog.Warn("claudex devices: session check failed, using the cached state", "user_id", userID, "error", err)
			return verdict(cached, issuedAt)
		}
		slog.Error("claudex devices: session check failed", "user_id", userID, "error", err)
		return claudexhook.CheckFailed
	}
	c.sessions.put(key, state, now)
	return verdict(state, issuedAt)
}

func verdict(s sessionState, issuedAt time.Time) claudexhook.SessionState {
	if s.revokes(issuedAt) {
		return claudexhook.Revoked
	}
	return claudexhook.Valid
}

// deviceLookup is a cached LookupByAPIKey answer (found=false caches a miss).
type deviceLookup struct {
	ref   core.DeviceRef
	found bool
}

// LookupByAPIKey implements core.DeviceDirectory: the device whose key this
// is, revoked devices included. Answers (misses too) are cached for 5 s; on a
// database error a cached answer up to 2 minutes old is used, otherwise the
// key counts as not a device key.
func (c *Component) LookupByAPIKey(ctx context.Context, apiKeyID int64) (*core.DeviceRef, bool) {
	if c.env == nil || c.env.DB == nil || apiKeyID <= 0 {
		return nil, false
	}
	now := c.now()
	cached, age, ok := c.devices.get(apiKeyID, now)
	if ok && age < freshTTL {
		return cached.result()
	}
	qctx, cancel := context.WithTimeout(ctx, lookupTimeout)
	defer cancel()
	d, keyGroup, err := deviceByAnyKey(qctx, c.env.DB, apiKeyID)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		c.devices.put(apiKeyID, deviceLookup{}, now)
		return nil, false
	case err != nil:
		if ok && age < staleTTL {
			return cached.result()
		}
		slog.Warn("claudex devices: device lookup failed", "api_key_id", apiKeyID, "error", err)
		return nil, false
	}
	ref := d.ref()
	if keyGroup != nil {
		// A key of another group of the device (MG): the request is billed
		// and checked in that group.
		ref.APIKeyID, ref.GroupID = apiKeyID, keyGroup
	}
	entry := deviceLookup{ref: ref, found: true}
	c.devices.put(apiKeyID, entry, now)
	return entry.result()
}

func (l deviceLookup) result() (*core.DeviceRef, bool) {
	if !l.found {
		return nil, false
	}
	ref := l.ref // callers get their own copy
	if ref.GroupID != nil {
		g := *ref.GroupID
		ref.GroupID = &g
	}
	return &ref, true
}

// LookupByDeviceID implements core.DeviceDirectory: the user's device with
// this raw device id (not cached).
func (c *Component) LookupByDeviceID(ctx context.Context, userID int64, rawDeviceID string) (*core.DeviceRef, bool) {
	if c.env == nil || c.env.DB == nil || userID <= 0 || !core.ValidDeviceID(rawDeviceID) {
		return nil, false
	}
	qctx, cancel := context.WithTimeout(ctx, lookupTimeout)
	defer cancel()
	d, err := deviceByHash(qctx, c.env.DB, userID, DeviceHash(rawDeviceID), false)
	if err != nil {
		slog.Warn("claudex devices: device lookup failed", "user_id", userID, "error", err)
		return nil, false
	}
	if d == nil || d.APIKeyID == nil || d.Platform == PlatformWeb {
		// The web device (W-KEY) is never a desktop device.
		return nil, false
	}
	ref := d.ref()
	return &ref, true
}

func (d *deviceRow) ref() core.DeviceRef {
	ref := core.DeviceRef{
		ID:         d.ID,
		UserID:     d.UserID,
		GroupID:    d.GroupID,
		Platform:   d.Platform,
		AppVersion: d.AppVersion,
		Revoked:    d.RevokedAt != nil,
	}
	if d.APIKeyID != nil {
		ref.APIKeyID = *d.APIKeyID
	}
	return ref
}

// ManagedAPIKeyIDs implements core.ManagedKeyOwner (H13): which of the user's
// keys are device keys (revoked devices included). A failed lookup counts
// every id as a device key, so /api/v1/keys masks and locks them rather than
// showing a device key's plaintext.
func (c *Component) ManagedAPIKeyIDs(ctx context.Context, userID int64, ids []int64) map[int64]bool {
	out := make(map[int64]bool, len(ids))
	if len(ids) == 0 || c.env == nil || c.env.DB == nil {
		return out
	}
	qctx, cancel := context.WithTimeout(ctx, lookupTimeout)
	defer cancel()
	rows, err := c.env.DB.QueryContext(qctx, `SELECT api_key_id FROM claudex_devices WHERE user_id = $1 AND api_key_id = ANY($2)
UNION SELECT api_key_id FROM claudex_device_group_keys WHERE user_id = $1 AND api_key_id = ANY($2)`,
		userID, pq.Array(ids))
	if err != nil {
		return allManaged(ids, err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return allManaged(ids, err)
		}
		out[id] = true
	}
	if err := rows.Err(); err != nil {
		return allManaged(ids, err)
	}
	return out
}

func allManaged(ids []int64, err error) map[int64]bool {
	slog.Error("claudex devices: device key lookup failed, treating every key as a device key", "error", err)
	out := make(map[int64]bool, len(ids))
	for _, id := range ids {
		out[id] = true
	}
	return out
}

// deviceByAnyKey finds the device a key belongs to: its plan key
// (claudex_devices.api_key_id) or one of its group keys (MG), with the group
// of a group key (nil for the plan key). sql.ErrNoRows when it is no device key.
func deviceByAnyKey(ctx context.Context, q queryer, apiKeyID int64) (*deviceRow, *int64, error) {
	var groupID sql.NullInt64
	var d deviceRow
	var keyID, rowGroup sql.NullInt64
	var lastSeen, revoked sql.NullTime
	err := q.QueryRowContext(ctx, `SELECT `+deviceColumns+`, NULL::bigint FROM claudex_devices WHERE api_key_id = $1
UNION ALL
SELECT `+prefixedDeviceColumns+`, gk.group_id FROM claudex_device_group_keys gk JOIN claudex_devices d ON d.id = gk.device_id
WHERE gk.api_key_id = $1
LIMIT 1`, apiKeyID).Scan(&d.ID, &d.UserID, &d.Hash, &keyID, &rowGroup, &d.SessionFamilyID, &d.DeviceName, &d.Platform, &d.Arch,
		&d.AppVersion, &lastSeen, &d.LastIP, &revoked, &d.RevokedReason, &d.CreatedAt, &d.UpdatedAt, &groupID)
	if err != nil {
		return nil, nil, err
	}
	d.APIKeyID = nullInt(keyID)
	d.GroupID = nullInt(rowGroup)
	d.LastSeenAt = nullTime(lastSeen)
	d.RevokedAt = nullTime(revoked)
	d.CreatedAt = d.CreatedAt.UTC()
	d.UpdatedAt = d.UpdatedAt.UTC()
	return &d, nullInt(groupID), nil
}
