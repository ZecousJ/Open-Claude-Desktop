package devices

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/service"
)

// DeviceSection is the bootstrap "device" section.
type DeviceSection struct {
	Registered bool   `json:"registered"`
	ID         *int64 `json:"id"`
	// KeyGroupID is the group of the device key right now (null without a
	// usable key).
	KeyGroupID *int64 `json:"key_group_id"`
	Revoked    bool   `json:"revoked"`
	// ReprovisionNeeded tells the desktop app to call POST /claudex/devices:
	// no device, a revoked device, no usable key, a key outside the plan
	// group, or (MG) a group of the user without a usable key of the device,
	// or a key of a group the user can no longer use.
	ReprovisionNeeded bool `json:"reprovision_needed"`
	// Keys are the device's usable keys, one per group, the plan group's
	// first (MG; no plaintext: POST /claudex/devices hands those out).
	Keys []DeviceKeyStatus `json:"keys"`
}

// Sections implements core.BootstrapContributor.
func (c *Component) Sections() []string { return []string{core.SectionPlan, core.SectionDevice} }

// BootstrapSections implements core.BootstrapContributor: "plan" is the plan
// B9 resolved (omitted when that failed), "device" describes the caller's
// device (from X-Claudex-Device-Id).
func (c *Component) BootstrapSections(ctx context.Context, bc *core.BootstrapContext) (map[string]any, error) {
	if bc == nil {
		return nil, fmt.Errorf("claudex devices: no bootstrap context")
	}
	device, err := c.deviceSection(ctx, bc.UserID, bc.DeviceID, bc.Plan, bc.NoPlan)
	if err != nil {
		return nil, err
	}
	out := map[string]any{core.SectionDevice: device}
	if bc.Plan != nil {
		out[core.SectionPlan] = bc.Plan
	}
	return out, nil
}

// noPlan: the user has no plan group (CLAUDEX_NO_PLAN). Such a device is
// registered without a key (balance only, owner decision 2026-10-12), so it
// needs a registration only when it is revoked or still holds a key.
func (c *Component) deviceSection(ctx context.Context, userID int64, deviceID string, plan *core.PlanRef, noPlan bool) (DeviceSection, error) {
	none := DeviceSection{ReprovisionNeeded: true, Keys: []DeviceKeyStatus{}}
	if userID <= 0 || !core.ValidDeviceID(deviceID) || c.env.DB == nil {
		return none, nil
	}
	row, err := deviceByHash(ctx, c.env.DB, userID, DeviceHash(deviceID), false)
	if err != nil {
		return DeviceSection{}, fmt.Errorf("claudex devices: read device: %w", err)
	}
	if row == nil {
		return none, nil
	}
	id := row.ID
	out := DeviceSection{Registered: true, ID: &id, Revoked: row.RevokedAt != nil, Keys: []DeviceKeyStatus{}}
	var usable bool
	keys := c.keys()
	if keys != nil && !out.Revoked {
		key, err := c.currentKey(ctx, keys, row)
		if err != nil {
			return DeviceSection{}, err
		}
		if key != nil && !keyNeedsRotation(key, userID, c.now()) {
			usable = true
			out.KeyGroupID = key.GroupID
		}
	}
	out.ReprovisionNeeded = out.Revoked || !usable || out.KeyGroupID == nil ||
		(plan != nil && *out.KeyGroupID != plan.GroupID)
	if noPlan {
		out.ReprovisionNeeded = out.Revoked || row.APIKeyID != nil
	}
	if out.Revoked || keys == nil {
		return out, nil
	}
	drift, err := c.deviceKeys(ctx, keys, userID, row, plan, &out)
	if err != nil {
		// The key list is an addition; the section keeps its old meaning.
		slog.Warn("claudex devices: could not list the device's group keys", "user_id", userID, "error", err)
		return out, nil
	}
	if noPlan {
		// Without a plan group the device should hold no key at all.
		drift = drift || len(out.Keys) > 0
	}
	out.ReprovisionNeeded = out.ReprovisionNeeded || drift
	return out, nil
}

// deviceKeys fills out.Keys with the device's usable keys (the plan group's
// first, then by group id) and reports whether they differ from the groups
// the device should hold a key for (read only: POST /claudex/devices
// reconciles).
func (c *Component) deviceKeys(ctx context.Context, keys apiKeyStore, userID int64, row *deviceRow, plan *core.PlanRef, out *DeviceSection) (bool, error) {
	extras, err := groupKeysOfDevice(ctx, c.env.DB, row.ID)
	if err != nil {
		return false, err
	}
	var want []service.Group
	if plan != nil {
		if want, err = c.keyGroups(ctx, userID, plan.GroupID); err != nil {
			return false, err
		}
	}
	wanted := make(map[int64]service.Group, len(want))
	for _, g := range want {
		wanted[g.ID] = g
	}
	ids := make([]int64, 0, len(extras)+1)
	if row.APIKeyID != nil {
		ids = append(ids, *row.APIKeyID)
	}
	for _, e := range extras {
		ids = append(ids, e.APIKeyID)
	}
	now := c.now()
	have := map[int64]bool{}
	drift := false
	for _, id := range ids {
		k, err := keys.GetByID(ctx, id)
		if errors.Is(err, service.ErrAPIKeyNotFound) {
			drift = true
			continue
		}
		if err != nil {
			return false, err
		}
		if k.GroupID == nil || keyNeedsRotation(k, userID, now) || have[*k.GroupID] {
			drift = true
			continue
		}
		g, ok := wanted[*k.GroupID]
		if plan != nil && !ok {
			drift = true // a group the user can no longer use
			continue
		}
		have[*k.GroupID] = true
		if !ok {
			g = service.Group{ID: *k.GroupID}
		}
		out.Keys = append(out.Keys, DeviceKeyStatus{
			APIKeyID: k.ID, GroupID: g.ID, GroupName: g.Name, Platform: g.Platform,
			Protocol: core.ProtocolForPlatform(g.Platform), Primary: row.APIKeyID != nil && *row.APIKeyID == k.ID,
		})
	}
	for _, g := range want {
		if !have[g.ID] {
			drift = true
		}
	}
	sort.SliceStable(out.Keys, func(i, j int) bool {
		a, b := out.Keys[i], out.Keys[j]
		if a.Primary != b.Primary {
			return a.Primary
		}
		return a.GroupID < b.GroupID
	})
	return drift, nil
}
