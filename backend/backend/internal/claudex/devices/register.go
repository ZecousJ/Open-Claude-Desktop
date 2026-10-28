package devices

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"
	"unicode"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/service"
)

// registration is one validated POST /api/v1/claudex/devices request.
type registration struct {
	UserID     int64
	DeviceID   string // raw id from X-Claudex-Device-Id (memory only)
	DeviceName string
	Platform   string
	Arch       string
	AppVersion string
	GroupID    *int64
	SessionID  string    // JWT sid of the caller
	IssuedAt   time.Time // JWT iat of the caller
	IP         string
}

// registrationResult is the outcome of a registration.
type registrationResult struct {
	Device  *deviceRow
	Key     *service.APIKey // the plan group's key; nil without a plan group
	Keys    []GroupKey      // every key of the device, the plan group's first
	Plan    *core.PlanRef   // nil without a plan group (balance only)
	Created bool            // a new device row
	Moved   bool            // another existing key of the device became the plan key
	Rotated bool            // a new key replaced the previous plan key
}

// legacySearchLimit bounds the name search for a legacy key. SearchAPIKeys is
// a case-insensitive substring match ordered by newest first, so names such as
// "claudex-desktop:<id>-backup" also match; the limit leaves room for them.
const legacySearchLimit = 100

// keyOpTimeout bounds the compensating and cleanup calls that run detached
// from the request.
const keyOpTimeout = 10 * time.Second

// register creates or reuses the device keys of (user, device) (design 2.5
// "登记流程", MG: one key per group the user may use). Registrations of one
// user are serialized by an advisory lock, so concurrent calls for one device
// create exactly one key per group and the device limit holds under
// concurrency. API keys are written through the upstream service outside the
// transaction; when the transaction does not commit, the keys it created are
// deleted again.
func (c *Component) register(ctx context.Context, in registration) (res *registrationResult, err error) {
	db, keys := c.env.DB, c.keys()
	if db == nil || keys == nil {
		return nil, errStorageUnavailable
	}
	settings := c.settings(ctx)
	if !settings.Enabled {
		return nil, ErrDeviceKeysDisabled
	}
	plan, groups, err := c.resolvePlanAndGroups(ctx, in.UserID, in.GroupID)
	if err != nil && !errors.Is(err, core.ErrNoPlan) {
		return nil, err
	}
	// Claudex has no subscriptions (owner decision, 2026-10-12): an account
	// without a plan group still signs in. Its device is registered without
	// a key (any key it held is deleted) until a group fits; usage stays
	// metered by the balance in the gateway.
	planGroupID := planGroupOf(plan)
	hash := DeviceHash(in.DeviceID)

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
	// Uncached, under the user lock: a concurrent revoke-all either finished
	// (and this token is refused) or waits and then revokes this device too.
	state, err := readSessionState(ctx, tx, in.UserID, in.SessionID)
	if err != nil {
		return nil, fmt.Errorf("claudex devices: read session state: %w", err)
	}
	if state.revokes(in.IssuedAt) {
		return nil, ErrSessionRevoked
	}
	row, err := deviceByHash(ctx, tx, in.UserID, hash, true)
	if err != nil {
		return nil, fmt.Errorf("claudex devices: read device: %w", err)
	}
	if row != nil && row.Platform == PlatformWeb {
		// The web device has its own hash namespace (WebDeviceHash), so this
		// cannot happen; a desktop sign-in must never take over the web key.
		return nil, errDeviceInvalid("device_id", "reserved", "This device id cannot be used.")
	}

	res = &registrationResult{Plan: plan}
	rotateAll := false
	switch {
	case row == nil:
		if err := c.checkLimit(ctx, tx, in.UserID, settings); err != nil {
			return nil, err
		}
		if err := c.disableLegacyKey(ctx, keys, in.UserID, in.DeviceID); err != nil {
			return nil, err
		}
		res.Created = true
	case row.RevokedAt != nil:
		if (row.RevokedReason == ReasonAdmin || row.RevokedReason == ReasonRevokeAll) && !state.issuedAfterRevoke(in.IssuedAt, *row.RevokedAt) {
			return nil, ErrSessionRevoked
		}
		if err := c.checkLimit(ctx, tx, in.UserID, settings); err != nil {
			return nil, err
		}
		rotateAll = true
	}
	var extras []groupKeyRow
	if row != nil {
		if extras, err = groupKeysOfDevice(ctx, tx, row.ID); err != nil {
			return nil, fmt.Errorf("claudex devices: read device keys: %w", err)
		}
	}
	sync, err := c.syncKeys(ctx, keys, in.UserID, row, extras, groups, planGroupID, rotateAll,
		func(groupID int64, primary bool) (*service.APIKey, error) {
			req := deviceKeyRequest(hash, groupID, settings.KeyDefaults)
			req.Name = groupKeyName(req.Name, groupID, primary)
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
	keyID, groupID := keyAndGroupIDs(key, plan)
	if row != nil && row.RevokedAt != nil {
		res.Rotated = true
	} else {
		res.Rotated, res.Moved = sync.Rotated, sync.Moved
	}

	now := c.now()
	var oldKeys []int64
	for _, e := range extras {
		oldKeys = append(oldKeys, e.APIKeyID)
	}
	if row != nil && row.APIKeyID != nil {
		oldKeys = append(oldKeys, *row.APIKeyID)
	}
	if row == nil {
		row, err = scanDevice(tx.QueryRowContext(ctx, `INSERT INTO claudex_devices
	(user_id, device_id_hash, api_key_id, group_id, session_family_id, device_name, platform, arch, app_version,
	 last_seen_at, last_ip, created_at, updated_at, signed_in_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $10, $10, $10)
RETURNING `+deviceColumns,
			in.UserID, hash, keyID, groupID, in.SessionID, in.DeviceName, in.Platform, in.Arch, in.AppVersion, now, in.IP))
	} else {
		// The group key rows go first: a key promoted to the plan key must
		// leave claudex_device_group_keys before claudex_devices points to it.
		if _, err = tx.ExecContext(ctx, `DELETE FROM claudex_device_group_keys WHERE device_id = $1`, row.ID); err != nil {
			return nil, fmt.Errorf("claudex devices: store device keys: %w", err)
		}
		// A new sign-in (the row was signed out, or another session family
		// registers it) starts the device's Active sessions "Created" time;
		// a key rotation or a plan move within one sign-in keeps it. The
		// right-hand side reads the row's values before this update.
		row, err = scanDevice(tx.QueryRowContext(ctx, `UPDATE claudex_devices SET
	signed_in_at = CASE WHEN revoked_at IS NOT NULL OR signed_in_at IS NULL OR session_family_id <> $4 THEN $9 ELSE signed_in_at END,
	api_key_id = $2, group_id = $3, session_family_id = $4, device_name = $5, platform = $6, arch = $7, app_version = $8,
	last_seen_at = $9, last_ip = $10, revoked_at = NULL, revoked_reason = '', updated_at = $9
WHERE id = $1
RETURNING `+deviceColumns,
			row.ID, keyID, groupID, in.SessionID, in.DeviceName, in.Platform, in.Arch, in.AppVersion, now, in.IP))
	}
	if err != nil {
		return nil, fmt.Errorf("claudex devices: store device: %w", err)
	}
	if err := writeGroupKeys(ctx, tx, row.ID, in.UserID, sync.extraRows(), now); err != nil {
		return nil, fmt.Errorf("claudex devices: store device keys: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("claudex devices: commit: %w", err)
	}
	committed = true

	c.forgetKeys(sync, oldKeys)
	res.Device, res.Key, res.Keys = row, key, sync.Keys
	return res, nil
}

// planGroupOf is the plan group's id, 0 without a plan.
func planGroupOf(plan *core.PlanRef) int64 {
	if plan == nil {
		return 0
	}
	return plan.GroupID
}

// keyAndGroupIDs are the api_key_id and group_id a device row stores: both
// NULL for a device without a plan group (balance only).
func keyAndGroupIDs(key *service.APIKey, plan *core.PlanRef) (keyID, groupID *int64) {
	if key != nil {
		id := key.ID
		keyID = &id
	}
	if plan != nil {
		id := plan.GroupID
		groupID = &id
	}
	return keyID, groupID
}

// checkLimit refuses a new (or re-registered revoked) device when the user
// already has as many active devices as allowed. It runs under the user lock.
func (c *Component) checkLimit(ctx context.Context, tx *sql.Tx, userID int64, settings Provisioning) error {
	limit, _, err := c.effectiveLimit(ctx, tx, userID, settings)
	if err != nil {
		return err
	}
	active, err := activeDeviceCount(ctx, tx, userID)
	if err != nil {
		return fmt.Errorf("claudex devices: count devices: %w", err)
	}
	if active >= limit {
		return errDeviceLimit(limit, active)
	}
	return nil
}

// effectiveLimit returns the user's device limit and whether it is a
// per-user override.
func (c *Component) effectiveLimit(ctx context.Context, q queryer, userID int64, settings Provisioning) (int, bool, error) {
	override, err := userDeviceLimit(ctx, q, userID)
	if err != nil {
		return 0, false, fmt.Errorf("claudex devices: read device limit: %w", err)
	}
	if override != nil {
		return *override, true, nil
	}
	return defaultLimit(settings), false, nil
}

// defaultLimit is the provisioning default device limit.
func defaultLimit(settings Provisioning) int {
	if settings.MaxDevicesPerUser < MinMaxDevices || settings.MaxDevicesPerUser > MaxMaxDevices {
		return DefaultMaxDevices
	}
	return settings.MaxDevicesPerUser
}

// disableLegacyKey turns off the key an older desktop client created for this
// device through /api/v1/keys, named exactly claudex-desktop:<device id>
// (owner decision 10: never adopted, never deleted, its usage history stays).
// Keys whose name merely contains that text are not touched.
func (c *Component) disableLegacyKey(ctx context.Context, keys apiKeyStore, userID int64, deviceID string) error {
	name := LegacyKeyName(deviceID)
	found, err := keys.SearchAPIKeys(ctx, userID, name, legacySearchLimit)
	if err != nil {
		return fmt.Errorf("claudex devices: search legacy key: %w", err)
	}
	disabled := service.StatusAPIKeyDisabled
	for i := range found {
		k := &found[i]
		if k.UserID != userID || !strings.EqualFold(k.Name, name) || k.Status != service.StatusAPIKeyActive {
			continue
		}
		if _, err := keys.Update(ctx, k.ID, userID, service.UpdateAPIKeyRequest{Status: &disabled}); err != nil {
			return fmt.Errorf("claudex devices: disable legacy key %d: %w", k.ID, err)
		}
		slog.Info("claudex devices: disabled legacy desktop key", "user_id", userID, "api_key_id", k.ID)
	}
	return nil
}

// currentKey loads the device's key; nil when it is gone.
func (c *Component) currentKey(ctx context.Context, keys apiKeyStore, row *deviceRow) (*service.APIKey, error) {
	if row.APIKeyID == nil {
		return nil, nil
	}
	k, err := keys.GetByID(ctx, *row.APIKeyID)
	if errors.Is(err, service.ErrAPIKeyNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("claudex devices: load device key: %w", err)
	}
	return k, nil
}

// keyNeedsRotation reports whether a device key can no longer serve the
// device: missing, someone else's, expired, or not active. A key that used up
// its quota is kept (a new key would reset the quota; the refusal tells the
// client not to reprovision).
func keyNeedsRotation(k *service.APIKey, userID int64, now time.Time) bool {
	switch {
	case k == nil, k.UserID != userID:
		return true
	case k.Status == service.StatusAPIKeyExpired, k.ExpiresAt != nil && !now.Before(*k.ExpiresAt):
		return true
	case k.Status == service.StatusAPIKeyQuotaExhausted:
		return false
	default:
		return !k.IsActive()
	}
}

func deviceKeyRequest(hash string, groupID int64, d KeyDefaults) service.CreateAPIKeyRequest {
	g := groupID
	req := service.CreateAPIKeyRequest{
		Name:        DeviceKeyName(hash),
		GroupID:     &g,
		Quota:       d.QuotaUSD,
		RateLimit5h: d.RateLimit5h,
		RateLimit1d: d.RateLimit1d,
		RateLimit7d: d.RateLimit7d,
	}
	if d.ExpiresInDays != nil {
		days := *d.ExpiresInDays
		req.ExpiresInDays = &days
	}
	return req
}

// mapKeyError turns "may not bind this group" (a subscription group without an
// active subscription) into CLAUDEX_NO_PLAN.
func mapKeyError(err error) error {
	if errors.Is(err, service.ErrGroupNotAllowed) || errors.Is(err, service.ErrGroupNotFound) {
		return core.ErrNoPlan
	}
	return fmt.Errorf("claudex devices: write device key: %w", err)
}

// compensate deletes keys created by a registration that did not commit, so
// no unmanaged active key is left behind.
func (c *Component) compensate(ctx context.Context, userID int64, ids []int64) {
	keys := c.keys()
	if keys == nil {
		return
	}
	cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), keyOpTimeout)
	defer cancel()
	for _, id := range ids {
		var err error
		for attempt := 0; attempt < 3; attempt++ {
			if attempt > 0 {
				select {
				case <-cctx.Done():
				case <-time.After(time.Duration(attempt) * 250 * time.Millisecond):
				}
			}
			if err = keys.Delete(cctx, id, userID); err == nil || errors.Is(err, service.ErrAPIKeyNotFound) {
				err = nil
				break
			}
		}
		c.devices.del(id)
		if err != nil {
			// The key was never shown to anyone; an administrator can delete it.
			slog.Error("claudex devices: could not delete the key of a failed registration", "user_id", userID, "api_key_id", id, "error", err)
		}
	}
}

// cleanDeviceName removes control and formatting characters, trims and cuts
// the name to 100 characters.
func cleanDeviceName(name string) string {
	kept := make([]rune, 0, len(name))
	for _, r := range name {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			continue
		}
		kept = append(kept, r)
	}
	out := []rune(strings.TrimSpace(string(kept)))
	if len(out) > 100 {
		out = out[:100]
	}
	return strings.TrimSpace(string(out))
}
