package devices

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/service"
)

// Background work (Starter).
const (
	reconcileInterval = 5 * time.Minute
	cleanupInterval   = time.Hour
	reconcileBatch    = 500
	defaultRefreshTTL = 30 * 24 * time.Hour
)

// revokeTarget selects the device to sign out: by row id (optionally limited
// to one user) or by the raw device id of a user.
type revokeTarget struct {
	UserID   int64 // 0: any user (admin by row id)
	DeviceID int64 // row id, or 0
	Hash     string
}

// revokeDevice signs one device out (user "Log out", DELETE /devices/...;
// admin revoke): the row is marked revoked, its session family is refused
// from now on (H9b) and its refresh tokens are dropped, and its key is
// disabled. It is idempotent; a device that is already revoked keeps its
// original reason and time.
func (c *Component) revokeDevice(ctx context.Context, target revokeTarget, reason string) error {
	db, keys := c.env.DB, c.keys()
	if db == nil || keys == nil {
		return errStorageUnavailable
	}
	// Find the owner first: the lock is per user.
	var row *deviceRow
	var err error
	if target.DeviceID > 0 {
		row, err = deviceByID(ctx, db, target.UserID, target.DeviceID, false)
	} else {
		row, err = deviceByHash(ctx, db, target.UserID, target.Hash, false)
	}
	if err != nil {
		return fmt.Errorf("claudex devices: find device: %w", err)
	}
	if row == nil {
		return ErrDeviceNotFound
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("claudex devices: begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := lockUser(ctx, tx, row.UserID); err != nil {
		return err
	}
	if row, err = deviceByID(ctx, tx, row.UserID, row.ID, true); err != nil {
		return fmt.Errorf("claudex devices: find device: %w", err)
	}
	if row == nil {
		return ErrDeviceNotFound
	}
	extras, err := groupKeysOfDevice(ctx, tx, row.ID)
	if err != nil {
		return fmt.Errorf("claudex devices: read device keys: %w", err)
	}
	now := c.now()
	if row.RevokedAt == nil {
		if _, err := tx.ExecContext(ctx, `UPDATE claudex_devices SET revoked_at = $2, revoked_reason = $3, updated_at = $2 WHERE id = $1`,
			row.ID, now, reason); err != nil {
			return fmt.Errorf("claudex devices: revoke device: %w", err)
		}
	}
	if row.SessionFamilyID != "" {
		if _, err := tx.ExecContext(ctx, `INSERT INTO claudex_revoked_sessions (session_family_id, user_id, revoked_at, expires_at)
VALUES ($1, $2, $3, $4)
ON CONFLICT (session_family_id) DO UPDATE SET expires_at = GREATEST(claudex_revoked_sessions.expires_at, EXCLUDED.expires_at)`,
			row.SessionFamilyID, row.UserID, now, now.Add(c.refreshTTL()+time.Hour)); err != nil {
			return fmt.Errorf("claudex devices: revoke session: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("claudex devices: commit: %w", err)
	}
	c.invalidateUser(row.UserID)
	if row.APIKeyID != nil {
		c.devices.del(*row.APIKeyID)
	}
	for _, e := range extras {
		c.devices.del(e.APIKeyID)
	}

	// After the commit the guard already refuses the device (revoked_at); a
	// failure below is retried by the caller or by the reconciliation.
	if row.SessionFamilyID != "" && c.env.AuthService != nil {
		if err := c.env.AuthService.RevokeSessionFamily(ctx, row.SessionFamilyID); err != nil {
			// H9b refuses every access token of the family already.
			slog.Warn("claudex devices: could not drop the refresh tokens of a signed-out device", "user_id", row.UserID, "device_id", row.ID, "error", err)
		}
	}
	// Every key of the device (MG: its keys of the other groups too).
	var errs []error
	if row.APIKeyID != nil {
		if err := c.disableKey(ctx, keys, row.UserID, *row.APIKeyID); err != nil {
			errs = append(errs, err)
		}
	}
	for _, e := range extras {
		if err := c.disableKey(ctx, keys, row.UserID, e.APIKeyID); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// revokeAll is "log out of all devices" for the Claudex side (H9 hook and the
// admin revoke-all): every access token issued so far is refused (H9b), every
// device of the user is marked revoked, the session families of its devices
// are recorded as signed out (so a device token from the revoke-all's own
// second is refused too) and every device key is disabled. Only
// keys that claudex_devices points to are touched; the user's own API keys are
// never changed (owner decision 13). It returns how many devices were newly
// revoked. Any failure is returned (the endpoint answers 500 and the client
// retries; the reconciliation also disables leftovers).
func (c *Component) revokeAll(ctx context.Context, userID int64, reason string) (int, error) {
	db, keys := c.env.DB, c.keys()
	if db == nil {
		// Without Claudex storage there are no devices to sign out.
		return 0, nil
	}
	if keys == nil {
		return 0, errStorageUnavailable
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("claudex devices: begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := lockUser(ctx, tx, userID); err != nil {
		return 0, err
	}
	now := c.now()
	if _, err := tx.ExecContext(ctx, `INSERT INTO claudex_session_revocations (user_id, revoked_at, reason) VALUES ($1, $2, $3)
ON CONFLICT (user_id) DO UPDATE SET revoked_at = GREATEST(claudex_session_revocations.revoked_at, EXCLUDED.revoked_at), reason = EXCLUDED.reason`,
		userID, now, reason); err != nil {
		return 0, fmt.Errorf("claudex devices: record revoke-all: %w", err)
	}
	// The web device row (W-KEY) is left alone: its key never leaves the
	// server, browser sessions are signed out by the web component, and a
	// turn already running on the web keeps going (web plan Q7).
	res, err := tx.ExecContext(ctx, `UPDATE claudex_devices SET revoked_at = $2, revoked_reason = $3, updated_at = $2
WHERE user_id = $1 AND revoked_at IS NULL AND platform <> $4`, userID, now, ReasonRevokeAll, PlatformWeb)
	if err != nil {
		return 0, fmt.Errorf("claudex devices: revoke devices: %w", err)
	}
	revoked, _ := res.RowsAffected()
	// Record the session family of every device as signed out too, so an
	// access token from one of them issued in the revoke-all's second is
	// refused while a sign-in right after it is not (issuedAfterRevoke).
	if _, err := tx.ExecContext(ctx, `INSERT INTO claudex_revoked_sessions (session_family_id, user_id, revoked_at, expires_at)
SELECT DISTINCT session_family_id, user_id, $2::timestamptz, $3::timestamptz FROM claudex_devices
WHERE user_id = $1 AND session_family_id <> ''
ON CONFLICT (session_family_id) DO UPDATE SET expires_at = GREATEST(claudex_revoked_sessions.expires_at, EXCLUDED.expires_at)`,
		userID, now, now.Add(c.refreshTTL()+time.Hour)); err != nil {
		return 0, fmt.Errorf("claudex devices: revoke device sessions: %w", err)
	}
	// Every device key of the user that can still be used, including keys of
	// devices revoked earlier.
	rows, err := tx.QueryContext(ctx, `SELECT d.api_key_id FROM claudex_devices d
JOIN api_keys k ON k.id = d.api_key_id AND k.deleted_at IS NULL
WHERE d.user_id = $1 AND k.status <> 'disabled' AND d.platform <> $2
UNION
SELECT gk.api_key_id FROM claudex_device_group_keys gk
JOIN claudex_devices d ON d.id = gk.device_id
JOIN api_keys k ON k.id = gk.api_key_id AND k.deleted_at IS NULL
WHERE d.user_id = $1 AND k.status <> 'disabled' AND d.platform <> $2`, userID, PlatformWeb)
	if err != nil {
		return 0, fmt.Errorf("claudex devices: list device keys: %w", err)
	}
	var keyIDs []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return 0, fmt.Errorf("claudex devices: list device keys: %w", err)
		}
		keyIDs = append(keyIDs, id)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return 0, fmt.Errorf("claudex devices: list device keys: %w", err)
	}
	_ = rows.Close()
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("claudex devices: commit: %w", err)
	}
	c.invalidateUser(userID)

	var errs []error
	for _, id := range keyIDs {
		c.devices.del(id)
		if err := c.disableKey(ctx, keys, userID, id); err != nil {
			errs = append(errs, err)
		}
	}
	if len(errs) > 0 {
		return int(revoked), errors.Join(errs...)
	}
	return int(revoked), nil
}

// OnSessionsRevoked implements core.SessionRevoker (H9): the user logged out of
// all devices. Password resets never call it (owner decision 4).
func (c *Component) OnSessionsRevoked(ctx context.Context, userID int64, reason string) error {
	if reason == "" {
		reason = ReasonRevokeAll
	}
	_, err := c.revokeAll(ctx, userID, reason)
	return err
}

// disableKey turns a device key off through the upstream service (which also
// drops the key from the upstream authentication caches).
func (c *Component) disableKey(ctx context.Context, keys apiKeyStore, userID, keyID int64) error {
	disabled := service.StatusAPIKeyDisabled
	_, err := keys.Update(ctx, keyID, userID, service.UpdateAPIKeyRequest{Status: &disabled})
	c.devices.del(keyID)
	if err != nil && !errors.Is(err, service.ErrAPIKeyNotFound) {
		return fmt.Errorf("claudex devices: disable device key %d: %w", keyID, err)
	}
	return nil
}

// invalidateUser drops this node's cached session states of the user.
func (c *Component) invalidateUser(userID int64) {
	c.sessions.delWhere(func(k sessionKey) bool { return k.UserID == userID })
}

func (c *Component) refreshTTL() time.Duration {
	if c.env != nil && c.env.Config != nil && c.env.Config.JWT.RefreshTokenExpireDays > 0 {
		return time.Duration(c.env.Config.JWT.RefreshTokenExpireDays) * 24 * time.Hour
	}
	return defaultRefreshTTL
}

// Start implements core.Starter: every 5 minutes it disables device keys that
// are still usable although their device is revoked (a failed sign-out, or an
// administrator who turned the key back on in the upstream console), and every
// hour it drops expired signed-out sessions.
func (c *Component) Start(ctx context.Context) {
	if c.env == nil || c.env.DB == nil {
		return
	}
	go c.loop(ctx, time.Minute, reconcileInterval, func(ctx context.Context) {
		if n, err := c.reconcile(ctx); err != nil {
			slog.Error("claudex devices: reconciliation failed", "error", err)
		} else if n > 0 {
			slog.Warn("claudex devices: disabled keys of revoked devices", "count", n)
		}
	})
	go c.loop(ctx, 5*time.Minute, cleanupInterval, func(ctx context.Context) {
		if err := c.cleanupRevokedSessions(ctx); err != nil {
			slog.Error("claudex devices: cleaning signed-out sessions failed", "error", err)
		}
	})
}

func (c *Component) loop(ctx context.Context, first, every time.Duration, run func(context.Context)) {
	timer := time.NewTimer(first)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		func() {
			defer func() {
				if r := recover(); r != nil {
					slog.Error("claudex devices: background job panicked", "panic", r)
				}
			}()
			jobCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
			defer cancel()
			run(jobCtx)
		}()
		timer.Reset(every)
	}
}

// reconcile disables the keys of revoked devices that are not disabled yet and
// returns how many it disabled.
func (c *Component) reconcile(ctx context.Context) (int, error) {
	db, keys := c.env.DB, c.keys()
	if db == nil || keys == nil {
		return 0, nil
	}
	rows, err := db.QueryContext(ctx, `SELECT user_id, api_key_id FROM (
	SELECT d.id, d.user_id, d.api_key_id FROM claudex_devices d
	JOIN api_keys k ON k.id = d.api_key_id AND k.deleted_at IS NULL
	WHERE d.revoked_at IS NOT NULL AND k.status <> 'disabled'
	UNION ALL
	SELECT d.id, d.user_id, gk.api_key_id FROM claudex_device_group_keys gk
	JOIN claudex_devices d ON d.id = gk.device_id
	JOIN api_keys k ON k.id = gk.api_key_id AND k.deleted_at IS NULL
	WHERE d.revoked_at IS NOT NULL AND k.status <> 'disabled'
) keys ORDER BY id, api_key_id LIMIT $1`, reconcileBatch)
	if err != nil {
		return 0, fmt.Errorf("list keys of revoked devices: %w", err)
	}
	type pending struct{ userID, keyID int64 }
	var todo []pending
	for rows.Next() {
		var p pending
		if err := rows.Scan(&p.userID, &p.keyID); err != nil {
			_ = rows.Close()
			return 0, err
		}
		todo = append(todo, p)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return 0, err
	}
	_ = rows.Close()
	var done int
	var errs []error
	for _, p := range todo {
		if err := c.disableKey(ctx, keys, p.userID, p.keyID); err != nil {
			errs = append(errs, err)
			continue
		}
		slog.Warn("claudex devices: disabled the key of a revoked device", "user_id", p.userID, "api_key_id", p.keyID)
		done++
	}
	return done, errors.Join(errs...)
}

func (c *Component) cleanupRevokedSessions(ctx context.Context) error {
	if c.env.DB == nil {
		return nil
	}
	_, err := c.env.DB.ExecContext(ctx, `DELETE FROM claudex_revoked_sessions WHERE expires_at < $1`, c.now())
	return err
}
