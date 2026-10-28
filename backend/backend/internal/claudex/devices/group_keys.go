package devices

// Multi-group device keys (MG): a device holds one device key for every group
// its user may use (keyGroupsFor), so the desktop app can offer the models of
// all of them and send each request with the key of the model's group. Usage
// rules, subscriptions and billing stay per group because every key lives in
// exactly one group.
//
//   - claudex_devices.api_key_id is the key of the plan group (the "primary"
//     key older clients use); claudex_device_group_keys holds the keys of the
//     device's other groups (migrations/claudex_0021_device_group_keys.sql).
//   - Keys never move between groups: when the plan changes, the device's key
//     of the new plan group becomes the primary one.
//   - Signing out, revoke-all, the reconciliation and the device limit work
//     per device and cover every key of the device; a user's own API keys are
//     never touched (owner decision 13).

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strconv"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/service"
)

// MaxKeyGroups bounds the groups one device holds a key for (the plan group
// is always one of them).
const MaxKeyGroups = 10

// keyGroupsFor lists the groups a device of the user holds a key for: every
// plan candidate (active, allowed) the user may bind, the plan group first,
// then by id, at most MaxKeyGroups. The plan group is always included.
func keyGroupsFor(p Provisioning, groups []service.Group, planGroupID int64) []service.Group {
	var plan *service.Group
	others := make([]service.Group, 0, len(groups))
	seen := map[int64]bool{}
	for i := range groups {
		g := groups[i]
		if !planCandidate(p, &g) || seen[g.ID] {
			continue
		}
		seen[g.ID] = true
		if g.ID == planGroupID {
			plan = &g
			continue
		}
		others = append(others, g)
	}
	sort.Slice(others, func(i, j int) bool { return others[i].ID < others[j].ID })
	out := make([]service.Group, 0, len(others)+1)
	if plan != nil {
		out = append(out, *plan)
	}
	for _, g := range others {
		if len(out) >= MaxKeyGroups {
			break
		}
		out = append(out, g)
	}
	return out
}

// KeyGroupIDs lists the groups whose models a device of the user can use: the
// plan group first, then the user's other key groups by id. The catalog merges
// their model catalogs (bootstrap "models", GET /claudex/models).
func (c *Component) KeyGroupIDs(ctx context.Context, userID int64, plan *core.PlanRef) ([]int64, error) {
	if plan == nil || plan.GroupID <= 0 {
		return nil, nil
	}
	groups, err := c.keyGroups(ctx, userID, plan.GroupID)
	if err != nil {
		return nil, err
	}
	ids := make([]int64, 0, len(groups))
	for _, g := range groups {
		ids = append(ids, g.ID)
	}
	if len(ids) == 0 || ids[0] != plan.GroupID {
		ids = append([]int64{plan.GroupID}, ids...)
	}
	return ids, nil
}

// keyGroups reads the user's available groups and applies keyGroupsFor.
func (c *Component) keyGroups(ctx context.Context, userID, planGroupID int64) ([]service.Group, error) {
	keys := c.keys()
	if keys == nil || userID <= 0 {
		return nil, nil
	}
	groups, err := keys.GetAvailableGroups(ctx, userID)
	if err != nil {
		if errors.Is(err, service.ErrUserNotFound) {
			return nil, nil
		}
		return nil, fmt.Errorf("claudex devices: list available groups: %w", err)
	}
	return keyGroupsFor(c.settings(ctx), groups, planGroupID), nil
}

// groupKeyRow is one claudex_device_group_keys row.
type groupKeyRow struct {
	GroupID  int64
	APIKeyID int64
}

// groupKeysOfDevice returns the device's keys of its other groups.
func groupKeysOfDevice(ctx context.Context, q queryer, deviceID int64) ([]groupKeyRow, error) {
	rows, err := q.QueryContext(ctx, `SELECT group_id, api_key_id FROM claudex_device_group_keys WHERE device_id = $1 ORDER BY group_id`, deviceID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []groupKeyRow
	for rows.Next() {
		var r groupKeyRow
		if err := rows.Scan(&r.GroupID, &r.APIKeyID); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// writeGroupKeys replaces the device's group key rows (under the user lock).
func writeGroupKeys(ctx context.Context, q queryer, deviceID, userID int64, keys []groupKeyRow, now time.Time) error {
	if _, err := q.ExecContext(ctx, `DELETE FROM claudex_device_group_keys WHERE device_id = $1`, deviceID); err != nil {
		return err
	}
	for _, k := range keys {
		if _, err := q.ExecContext(ctx, `INSERT INTO claudex_device_group_keys (device_id, user_id, group_id, api_key_id, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $5)`, deviceID, userID, k.GroupID, k.APIKeyID, now); err != nil {
			return err
		}
	}
	return nil
}

// GroupKey is one key of a device with its group. Key is the plaintext key:
// it only ever leaves the server in the POST /claudex/devices answer (and to
// the web runner's memory for the web device).
type GroupKey struct {
	Group   service.Group
	Key     *service.APIKey
	Primary bool // the plan group's key (claudex_devices.api_key_id)
	Created bool // created by this reconciliation
}

// keySync is the outcome of syncKeys.
type keySync struct {
	Keys    []GroupKey // in keyGroupsFor order: the plan group first
	Primary *service.APIKey
	Created []int64 // keys created (deleted again when the transaction fails)
	Deleted []int64 // keys deleted (no longer needed or unusable)
	Rotated bool    // the primary key is new and replaces the previous one
	Moved   bool    // the plan is served by another key of the device now
}

// syncKeys reconciles a device's keys with its groups (MG): every key the
// device has (primary and group keys) is sorted by its actual group; each
// group keeps one usable key (keyNeedsRotation; quota-exhausted keys are kept)
// or gets a new one; every other key of the device is deleted. rotateAll
// replaces every key (a revoked device signing in again). planGroupID 0 (an
// account without a plan group) keeps no key: Primary is then nil and every
// key of the device is deleted. newKey creates a
// key in a group. It runs inside the registration transaction; the caller
// stores the result and compensates Created when it does not commit.
func (c *Component) syncKeys(ctx context.Context, keys apiKeyStore, userID int64, row *deviceRow, extras []groupKeyRow,
	groups []service.Group, planGroupID int64, rotateAll bool, newKey func(groupID int64, primary bool) (*service.APIKey, error)) (*keySync, error) {
	now := c.now()
	out := &keySync{}
	var existing []int64
	var oldPrimary *int64
	if row != nil && row.APIKeyID != nil {
		id := *row.APIKeyID
		oldPrimary = &id
		existing = append(existing, id)
	}
	for _, e := range extras {
		if oldPrimary == nil || e.APIKeyID != *oldPrimary {
			existing = append(existing, e.APIKeyID)
		}
	}
	pool := map[int64]*service.APIKey{}
	var drop []int64
	for _, id := range existing {
		k, err := keys.GetByID(ctx, id)
		if errors.Is(err, service.ErrAPIKeyNotFound) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("claudex devices: load device key: %w", err)
		}
		if rotateAll || k.GroupID == nil || keyNeedsRotation(k, userID, now) || pool[*k.GroupID] != nil {
			if k.UserID == userID {
				drop = append(drop, k.ID)
			}
			continue
		}
		pool[*k.GroupID] = k
	}
	for _, g := range groups {
		primary := g.ID == planGroupID
		k := pool[g.ID]
		if k != nil {
			delete(pool, g.ID)
		} else {
			created, err := newKey(g.ID, primary)
			if err != nil {
				if !primary && errors.Is(err, core.ErrNoPlan) {
					// The group became unusable meanwhile (e.g. a subscription
					// ended): the device goes without it until the next sync.
					slog.Warn("claudex devices: skipped a group key", "user_id", userID, "group_id", g.ID)
					continue
				}
				return nil, err
			}
			out.Created = append(out.Created, created.ID)
			k = created
		}
		gk := GroupKey{Group: g, Key: k, Primary: primary, Created: k != nil && containsID(out.Created, k.ID)}
		if primary {
			out.Primary = k
		}
		out.Keys = append(out.Keys, gk)
	}
	if out.Primary == nil && planGroupID != 0 {
		return nil, core.ErrNoPlan
	}
	for _, k := range pool {
		drop = append(drop, k.ID)
	}
	sort.Slice(drop, func(i, j int) bool { return drop[i] < drop[j] })
	for _, id := range drop {
		if err := keys.Delete(ctx, id, userID); err != nil && !errors.Is(err, service.ErrAPIKeyNotFound) {
			return nil, fmt.Errorf("claudex devices: delete replaced key: %w", err)
		}
		out.Deleted = append(out.Deleted, id)
	}
	if oldPrimary != nil && out.Primary != nil && out.Primary.ID != *oldPrimary {
		kept := false
		for _, k := range out.Keys {
			kept = kept || k.Key.ID == *oldPrimary
		}
		if containsID(out.Created, out.Primary.ID) && !kept {
			out.Rotated = true // the plan key was replaced
		} else {
			out.Moved = true // another key of the device serves the plan now
		}
	}
	return out, nil
}

// extraRows are the group key rows of a sync (every key but the primary).
func (s *keySync) extraRows() []groupKeyRow {
	var out []groupKeyRow
	for _, k := range s.Keys {
		if !k.Primary {
			out = append(out, groupKeyRow{GroupID: k.Group.ID, APIKeyID: k.Key.ID})
		}
	}
	return out
}

// forgetKeys drops the cached lookups of every key a sync touched.
func (c *Component) forgetKeys(s *keySync, old []int64) {
	for _, k := range s.Keys {
		c.devices.del(k.Key.ID)
	}
	for _, id := range append(append([]int64(nil), s.Deleted...), old...) {
		c.devices.del(id)
	}
}

// groupKeyName names a device key of a group other than the plan group at
// creation (names are for administrators only).
func groupKeyName(base string, groupID int64, primary bool) string {
	if primary {
		return base
	}
	return base + ":g" + strconv.FormatInt(groupID, 10)
}

// GroupKeyJSON is one key of POST /claudex/devices "api_keys".
type GroupKeyJSON struct {
	ID        int64  `json:"id"`
	Key       string `json:"key"`
	Status    string `json:"status"`
	GroupID   int64  `json:"group_id"`
	GroupName string `json:"group_name"`
	Platform  string `json:"platform"`
	Protocol  string `json:"protocol"`
	Primary   bool   `json:"primary"`
}

func groupKeysJSON(keys []GroupKey) []GroupKeyJSON {
	out := make([]GroupKeyJSON, 0, len(keys))
	for _, k := range keys {
		out = append(out, GroupKeyJSON{
			ID: k.Key.ID, Key: k.Key.Key, Status: k.Key.Status,
			GroupID: k.Group.ID, GroupName: k.Group.Name, Platform: k.Group.Platform,
			Protocol: core.ProtocolForPlatform(k.Group.Platform), Primary: k.Primary,
		})
	}
	return out
}

// DeviceKeyStatus is one usable key of bootstrap device.keys (no plaintext).
type DeviceKeyStatus struct {
	APIKeyID  int64  `json:"api_key_id"`
	GroupID   int64  `json:"group_id"`
	GroupName string `json:"group_name"`
	Platform  string `json:"platform"`
	Protocol  string `json:"protocol"`
	Primary   bool   `json:"primary"`
}
