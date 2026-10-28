package devices

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Revocation reasons (claudex_devices.revoked_reason).
const (
	ReasonUser      = "user"
	ReasonAdmin     = "admin"
	ReasonRevokeAll = "revoke_all"
)

// DeviceHash is the stored form of a raw device id:
// hex(sha256("claudex-device\n" + lower(device_id))). The raw id never
// reaches the database, the request body, a URL or the audit log.
func DeviceHash(deviceID string) string {
	sum := sha256.Sum256([]byte("claudex-device\n" + strings.ToLower(strings.TrimSpace(deviceID))))
	return hex.EncodeToString(sum[:])
}

// DeviceKeyName is the name of a device key (for administrators only; a key
// is a device key because claudex_devices points to it, never by its name).
func DeviceKeyName(hash string) string {
	if len(hash) > 12 {
		hash = hash[:12]
	}
	return "claudex-device:" + hash
}

// LegacyKeyName is the name older desktop clients gave the key they created
// through /api/v1/keys (owner decision 10: disabled, never adopted).
func LegacyKeyName(deviceID string) string { return "claudex-desktop:" + deviceID }

type queryer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// deviceRow is one claudex_devices row.
type deviceRow struct {
	ID              int64
	UserID          int64
	Hash            string
	APIKeyID        *int64
	GroupID         *int64
	SessionFamilyID string
	DeviceName      string
	Platform        string
	Arch            string
	AppVersion      string
	LastSeenAt      *time.Time
	LastIP          string
	RevokedAt       *time.Time
	RevokedReason   string
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

const deviceColumns = `id, user_id, device_id_hash, api_key_id, group_id, session_family_id, device_name, platform, arch,
	app_version, last_seen_at, last_ip, revoked_at, revoked_reason, created_at, updated_at`

// prefixedDeviceColumns are deviceColumns of the claudex_devices alias d.
const prefixedDeviceColumns = `d.id, d.user_id, d.device_id_hash, d.api_key_id, d.group_id, d.session_family_id, d.device_name,
	d.platform, d.arch, d.app_version, d.last_seen_at, d.last_ip, d.revoked_at, d.revoked_reason, d.created_at, d.updated_at`

type rowScanner interface{ Scan(dest ...any) error }

func scanDevice(s rowScanner) (*deviceRow, error) {
	var d deviceRow
	var keyID, groupID sql.NullInt64
	var lastSeen, revoked sql.NullTime
	if err := s.Scan(&d.ID, &d.UserID, &d.Hash, &keyID, &groupID, &d.SessionFamilyID, &d.DeviceName, &d.Platform, &d.Arch,
		&d.AppVersion, &lastSeen, &d.LastIP, &revoked, &d.RevokedReason, &d.CreatedAt, &d.UpdatedAt); err != nil {
		return nil, err
	}
	d.APIKeyID = nullInt(keyID)
	d.GroupID = nullInt(groupID)
	d.LastSeenAt = nullTime(lastSeen)
	d.RevokedAt = nullTime(revoked)
	d.CreatedAt = d.CreatedAt.UTC()
	d.UpdatedAt = d.UpdatedAt.UTC()
	return &d, nil
}

func nullInt(v sql.NullInt64) *int64 {
	if !v.Valid {
		return nil
	}
	n := v.Int64
	return &n
}

func nullTime(v sql.NullTime) *time.Time {
	if !v.Valid {
		return nil
	}
	t := v.Time.UTC()
	return &t
}

// deviceByHash returns the user's row for a device, nil when there is none.
func deviceByHash(ctx context.Context, q queryer, userID int64, hash string, forUpdate bool) (*deviceRow, error) {
	query := `SELECT ` + deviceColumns + ` FROM claudex_devices WHERE user_id = $1 AND device_id_hash = $2`
	if forUpdate {
		query += ` FOR UPDATE`
	}
	d, err := scanDevice(q.QueryRowContext(ctx, query, userID, hash))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return d, err
}

// deviceByID returns a row by id (limited to the user when userID > 0), nil
// when there is none.
func deviceByID(ctx context.Context, q queryer, userID, id int64, forUpdate bool) (*deviceRow, error) {
	query := `SELECT ` + deviceColumns + ` FROM claudex_devices WHERE id = $1 AND ($2::bigint = 0 OR user_id = $2)`
	if forUpdate {
		query += ` FOR UPDATE`
	}
	d, err := scanDevice(q.QueryRowContext(ctx, query, id, userID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return d, err
}

// listedDevice is a row of the user's own device list with the start of its
// current sign-in.
type listedDevice struct {
	*deviceRow
	SignedInAt time.Time
}

// withExtra scans the device columns and then the extra destinations.
type withExtra struct {
	rowScanner
	extra []any
}

func (w withExtra) Scan(dest ...any) error {
	return w.rowScanner.Scan(append(dest, w.extra...)...)
}

// listedDevicesOfUser returns every device row of a user (by id) with when its
// current sign-in began; rows from before claudex_0141 fall back to created_at.
func listedDevicesOfUser(ctx context.Context, q queryer, userID int64) ([]listedDevice, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+deviceColumns+`, COALESCE(signed_in_at, created_at)
FROM claudex_devices WHERE user_id = $1 ORDER BY id`, userID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []listedDevice
	for rows.Next() {
		var signedIn time.Time
		d, err := scanDevice(withExtra{rowScanner: rows, extra: []any{&signedIn}})
		if err != nil {
			return nil, err
		}
		out = append(out, listedDevice{deviceRow: d, SignedInAt: signedIn.UTC()})
	}
	return out, rows.Err()
}

// lockUser serializes every device registration and sign-out of one user for
// the rest of the transaction (so the device limit and revoke-all cannot race).
func lockUser(ctx context.Context, tx *sql.Tx, userID int64) error {
	// A registration holds a connection while it waits; the timeout keeps a
	// burst from pinning the pool.
	if _, err := tx.ExecContext(ctx, `SET LOCAL lock_timeout = '15s'`); err != nil {
		return fmt.Errorf("set lock timeout: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('claudex_device_user:' || $1::text, 0))`, userID); err != nil {
		return fmt.Errorf("lock devices of user %d: %w", userID, err)
	}
	return nil
}

// activeDeviceCount counts the user's active devices that take a slot of the
// device limit: every active row except the web device (W-KEY, platform
// 'web', owner decision 9).
func activeDeviceCount(ctx context.Context, q queryer, userID int64) (int, error) {
	var n int
	err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM claudex_devices WHERE user_id = $1 AND revoked_at IS NULL AND platform <> $2`,
		userID, PlatformWeb).Scan(&n)
	return n, err
}

// userDeviceLimit returns the user's override (claudex_user_device_limits), or
// nil when the default applies.
func userDeviceLimit(ctx context.Context, q queryer, userID int64) (*int, error) {
	var n int
	err := q.QueryRowContext(ctx, `SELECT max_devices FROM claudex_user_device_limits WHERE user_id = $1`, userID).Scan(&n)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &n, nil
}

// sessionState is the revocation state of one user and session family.
type sessionState struct {
	RevokedAt  *time.Time // last revoke-all of the user
	SidRevoked bool       // the session family was signed out
	HasSID     bool       // the token names a session family (JWT sid)
}

type sessionKey struct {
	UserID int64
	SID    string
}

func readSessionState(ctx context.Context, q queryer, userID int64, sid string) (sessionState, error) {
	st := sessionState{HasSID: sid != ""}
	var revoked sql.NullTime
	err := q.QueryRowContext(ctx, `SELECT
	(SELECT revoked_at FROM claudex_session_revocations WHERE user_id = $1),
	EXISTS (SELECT 1 FROM claudex_revoked_sessions WHERE session_family_id = $2 AND user_id = $1 AND $2 <> '')`,
		userID, sid).Scan(&revoked, &st.SidRevoked)
	if err != nil {
		return sessionState{}, err
	}
	st.RevokedAt = nullTime(revoked)
	return st, nil
}

// revokes reports whether the state refuses an access token issued at
// issuedAt: a token from a signed-out session, or one issued before the last
// revoke-all (see issuedAfterRevoke for tokens from the same second).
func (s sessionState) revokes(issuedAt time.Time) bool {
	if s.SidRevoked {
		return true
	}
	return s.RevokedAt != nil && !s.issuedAfterRevoke(issuedAt, *s.RevokedAt)
}

// issuedAfterRevoke reports whether a token issued at issuedAt (JWT iat, whole
// seconds) counts as issued after a revocation at revokedAt:
//
//   - a later second: yes;
//   - an earlier second, or no iat: no;
//   - the same second (i1 finding 3): only a token that names a session
//     family that was not signed out. Every revocation records the session
//     families of the devices it signs out (claudex_revoked_sessions), so a
//     device session from before the revocation is refused while a sign-in
//     right after it is not. A token without a session id is refused.
//
// What stays open: a non-device session (e.g. the web console) issued in the
// same second before a revoke-all keeps its access token until it expires
// (the refresh tokens are gone); the owner accepted this window (R13).
func (s sessionState) issuedAfterRevoke(issuedAt, revokedAt time.Time) bool {
	if issuedAt.IsZero() {
		return false
	}
	switch iat, rev := issuedAt.Unix(), revokedAt.Unix(); {
	case iat > rev:
		return true
	case iat == rev:
		return s.HasSID && !s.SidRevoked
	}
	return false
}
