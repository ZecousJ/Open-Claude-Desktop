//go:build integration

package devices_test

// Integration tests of multi-group device keys (MG): one device key per group
// the user may use, reconciled at registration, reported by bootstrap, and
// signed out, revoked and reconciled per device; user keys are never touched.

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/devices"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/stretchr/testify/require"
)

// groupKeyRows returns the device's group key rows as group id → key id.
func groupKeyRows(t *testing.T, deviceID int64) map[int64]int64 {
	t.Helper()
	rows, err := itDB.Query(`SELECT group_id, api_key_id FROM claudex_device_group_keys WHERE device_id = $1`, deviceID)
	require.NoError(t, err)
	defer func() { _ = rows.Close() }()
	out := map[int64]int64{}
	for rows.Next() {
		var g, k int64
		require.NoError(t, rows.Scan(&g, &k))
		out[g] = k
	}
	require.NoError(t, rows.Err())
	return out
}

func keysByGroup(r devices.RegisterResponse) map[int64]devices.GroupKeyJSON {
	out := map[int64]devices.GroupKeyJSON{}
	for _, k := range r.APIKeys {
		out[k.GroupID] = k
	}
	return out
}

func TestEveryGroupGetsOneDeviceKey(t *testing.T) {
	h := newHarness(t)
	u := h.user()
	openai := h.group(service.PlatformOpenAI, service.SubscriptionTypeStandard)
	grok := h.group(service.PlatformGrok, service.SubscriptionTypeStandard)
	h.setProvisioning(fmt.Sprintf(`{"allowed_group_ids":[%d,%d],"default_group_id":%d}`, openai.ID, grok.ID, openai.ID))
	tok := h.token(u)
	dev := newDeviceID()

	first := h.mustRegister(tok, dev, "")
	require.Equal(t, openai.ID, first.Plan.GroupID)
	require.Len(t, first.APIKeys, 2)
	byGroup := keysByGroup(first)
	require.True(t, byGroup[openai.ID].Primary)
	require.Equal(t, first.APIKey.ID, byGroup[openai.ID].ID)
	require.Equal(t, first.APIKey.Key, byGroup[openai.ID].Key)
	require.Equal(t, "responses", byGroup[openai.ID].Protocol)
	g := byGroup[grok.ID]
	require.False(t, g.Primary)
	require.Equal(t, "grok", g.Platform)
	require.Equal(t, "chat", g.Protocol)
	require.Equal(t, grok.ID, keyState(t, g.ID).GroupID.Int64, "each key lives in its own group")
	require.Equal(t, map[int64]int64{grok.ID: g.ID}, groupKeyRows(t, first.Device.ID))
	require.Equal(t, 2, activeKeyCount(t, u.ID))

	// Idempotent.
	again := h.mustRegister(tok, dev, "")
	require.False(t, again.Created || again.Moved || again.Rotated)
	require.Equal(t, byGroup[openai.ID].ID, keysByGroup(again)[openai.ID].ID)
	require.Equal(t, g.ID, keysByGroup(again)[grok.ID].ID)
	require.Equal(t, 2, activeKeyCount(t, u.ID))

	// Both keys pass the gateway; the grok key is marked as the same device in the grok group.
	require.Equal(t, http.StatusOK, h.gateway(first.APIKey.Key).Code)
	require.Equal(t, http.StatusOK, h.gateway(g.Key).Code)
	ref, ok := h.comp.LookupByAPIKey(h.ctx, g.ID)
	require.True(t, ok)
	require.Equal(t, first.Device.ID, ref.ID)
	require.Equal(t, g.ID, ref.APIKeyID)
	require.Equal(t, grok.ID, *ref.GroupID)

	// Bootstrap lists both keys (no plaintext) and asks for nothing.
	plan, err := h.comp.ResolvePlan(h.ctx, u.ID, nil)
	require.NoError(t, err)
	section := func() devices.DeviceSection {
		out, err := h.comp.BootstrapSections(h.ctx, &core.BootstrapContext{UserID: u.ID, DeviceID: dev, Plan: plan})
		require.NoError(t, err)
		return out[core.SectionDevice].(devices.DeviceSection)
	}
	s := section()
	require.False(t, s.ReprovisionNeeded)
	require.Len(t, s.Keys, 2)
	require.Equal(t, devices.DeviceKeyStatus{APIKeyID: first.APIKey.ID, GroupID: openai.ID, GroupName: openai.Name,
		Platform: "openai", Protocol: "responses", Primary: true}, s.Keys[0])
	require.Equal(t, grok.ID, s.Keys[1].GroupID)
	ids, err := h.comp.KeyGroupIDs(h.ctx, u.ID, plan)
	require.NoError(t, err)
	require.Equal(t, []int64{openai.ID, grok.ID}, ids)

	// The group key is a device key for /api/v1/keys: masked and read-only.
	rec := h.do(http.MethodGet, "/api/v1/keys", tok, nil, "")
	require.Equal(t, http.StatusOK, rec.Code)
	require.NotContains(t, rec.Body.String(), g.Key)
	rec = h.do(http.MethodDelete, fmt.Sprintf("/api/v1/keys/%d", g.ID), tok, nil, "")
	require.Equal(t, http.StatusForbidden, rec.Code)
	require.Equal(t, "CLAUDEX_DEVICE_KEY_MANAGED", decodeEnv(t, rec).Reason)

	// A third group becomes usable: bootstrap asks, the next sign-in adds only its key.
	third := h.group(service.PlatformOpenAI, service.SubscriptionTypeStandard)
	h.setProvisioning(fmt.Sprintf(`{"allowed_group_ids":[%d,%d,%d]}`, openai.ID, grok.ID, third.ID))
	require.True(t, section().ReprovisionNeeded)
	added := h.mustRegister(tok, dev, "")
	require.Len(t, added.APIKeys, 3)
	require.Equal(t, g.ID, keysByGroup(added)[grok.ID].ID)
	require.False(t, section().ReprovisionNeeded)

	// The grok group is no longer allowed: its key is deleted at the next sign-in.
	h.setProvisioning(fmt.Sprintf(`{"allowed_group_ids":[%d,%d]}`, openai.ID, third.ID))
	require.True(t, section().ReprovisionNeeded)
	dropped := h.mustRegister(tok, dev, "")
	require.Len(t, dropped.APIKeys, 2)
	require.True(t, keyState(t, g.ID).DeletedAt.Valid)
	_, ok = keysByGroup(dropped)[grok.ID]
	require.False(t, ok)

	// A disabled group key is replaced; the plan key stays.
	thirdKey := keysByGroup(dropped)[third.ID].ID
	disabled := service.StatusAPIKeyDisabled
	_, err = h.keys.Update(h.ctx, thirdKey, u.ID, service.UpdateAPIKeyRequest{Status: &disabled})
	require.NoError(t, err)
	require.True(t, section().ReprovisionNeeded)
	fixed := h.mustRegister(tok, dev, "")
	require.False(t, fixed.Rotated, "the plan key was not replaced")
	require.Equal(t, first.APIKey.ID, fixed.APIKey.ID)
	require.NotEqual(t, thirdKey, keysByGroup(fixed)[third.ID].ID)
	require.True(t, keyState(t, thirdKey).DeletedAt.Valid)
}

func TestSigningOutCoversEveryGroupKey(t *testing.T) {
	h := newHarness(t)
	u := h.user()
	openai := h.group(service.PlatformOpenAI, service.SubscriptionTypeStandard)
	grok := h.group(service.PlatformGrok, service.SubscriptionTypeStandard)
	h.setProvisioning(fmt.Sprintf(`{"allowed_group_ids":[%d,%d],"default_group_id":%d}`, openai.ID, grok.ID, openai.ID))
	tokA, tokB := h.token(u), h.token(u)
	devA, devB := newDeviceID(), newDeviceID()
	a := h.mustRegister(tokA, devA, "")
	b := h.mustRegister(tokB, devB, "")
	grokA, grokB := keysByGroup(a)[grok.ID], keysByGroup(b)[grok.ID]
	gid := grok.ID
	own, err := h.keys.Create(h.ctx, u.ID, service.CreateAPIKeyRequest{Name: "my grok script", GroupID: &gid})
	require.NoError(t, err)
	ownBefore := keyState(t, own.ID)

	// The device limit counts devices, not keys.
	var active int
	require.NoError(t, itDB.QueryRow(`SELECT COUNT(*) FROM claudex_devices WHERE user_id = $1 AND revoked_at IS NULL`, u.ID).Scan(&active))
	require.Equal(t, 2, active)
	rec := h.do(http.MethodPut, fmt.Sprintf("/api/v1/admin/claudex/users/%d/device-limit", u.ID), "", nil, `{"max_devices":2}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, http.StatusConflict, h.register(h.token(u), newDeviceID(), "").Code, "a third device is refused")

	// Signing out one device turns off both of its keys only.
	rec = h.do(http.MethodDelete, "/api/v1/claudex/devices/current", tokA, map[string]string{core.HeaderDeviceID: devA}, "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, service.StatusAPIKeyDisabled, keyState(t, a.APIKey.ID).Status)
	require.Equal(t, service.StatusAPIKeyDisabled, keyState(t, grokA.ID).Status)
	_, reason := refusal(t, h.gateway(grokA.Key))
	require.Equal(t, "DEVICE_REVOKED", reason)
	require.Equal(t, http.StatusOK, h.gateway(grokB.Key).Code)

	// Turning the group key back on does not bring it back; the reconciliation turns it off.
	on := service.StatusAPIKeyActive
	_, err = h.keys.Update(h.ctx, grokA.ID, u.ID, service.UpdateAPIKeyRequest{Status: &on})
	require.NoError(t, err)
	_, reason = refusal(t, h.gateway(grokA.Key))
	require.Equal(t, "DEVICE_REVOKED", reason)
	n, err := h.comp.ReconcileNow(h.ctx)
	require.NoError(t, err)
	require.Equal(t, 1, n)
	require.Equal(t, service.StatusAPIKeyDisabled, keyState(t, grokA.ID).Status)

	// Log out of all devices: every device key of every group, never the user's own key.
	rec = h.do(http.MethodPost, "/api/v1/auth/revoke-all-sessions", tokB, nil, "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, service.StatusAPIKeyDisabled, keyState(t, b.APIKey.ID).Status)
	require.Equal(t, service.StatusAPIKeyDisabled, keyState(t, grokB.ID).Status)
	require.Equal(t, ownBefore, keyState(t, own.ID), "the user's own key in the grok group is untouched")
	require.Equal(t, http.StatusOK, h.gateway(own.Key).Code)

	// Signing in again gives the device new keys in both groups.
	waitNextSecond()
	back := h.mustRegister(h.token(u), devB, "")
	require.True(t, back.Rotated)
	require.Len(t, back.APIKeys, 2)
	require.NotEqual(t, grokB.ID, keysByGroup(back)[grok.ID].ID)
	require.True(t, keyState(t, grokB.ID).DeletedAt.Valid)
	require.Equal(t, http.StatusOK, h.gateway(keysByGroup(back)[grok.ID].Key).Code)
}

func TestWebKeyHasOneKeyPerGroupAndNeverMovesThem(t *testing.T) {
	h := newHarness(t)
	u := h.user()
	openai := h.group(service.PlatformOpenAI, service.SubscriptionTypeStandard)
	grok := h.group(service.PlatformGrok, service.SubscriptionTypeStandard)
	h.setProvisioning(fmt.Sprintf(`{"allowed_group_ids":[%d,%d],"default_group_id":%d}`, openai.ID, grok.ID, openai.ID))
	tok := h.token(u)

	web, err := h.comp.EnsureWebKey(h.ctx, h.webKeyRequest(u, tok))
	require.NoError(t, err)
	require.Equal(t, openai.ID, web.GroupID)
	require.Len(t, web.Keys, 2)
	grokKey := web.KeyForGroup(grok.ID)
	require.NotNil(t, grokKey)
	require.Equal(t, grok.ID, *grokKey.GroupID)
	require.Equal(t, http.StatusOK, h.gateway(grokKey.Key).Code)
	userID, ok := h.comp.IsWebKey(h.ctx, grokKey.ID)
	require.True(t, ok, "a web group key is a web key")
	require.Equal(t, u.ID, userID)
	reg := web.Registration()
	require.Len(t, reg.APIKeys, 2)
	require.Equal(t, web.APIKeyID, reg.APIKey.ID)

	// A turn for a grok model asks for the grok group; dictation afterwards
	// (no group) gets the plan key back; no key ever changes its group.
	req := h.webKeyRequest(u, tok)
	req.GroupID = &grok.ID
	forGrok, err := h.comp.EnsureWebKey(h.ctx, req)
	require.NoError(t, err)
	require.Equal(t, grokKey.ID, forGrok.APIKeyID)
	require.True(t, forGrok.Moved)
	dictation, err := h.comp.EnsureWebKey(h.ctx, h.webKeyRequest(u, tok))
	require.NoError(t, err)
	require.Equal(t, web.APIKeyID, dictation.APIKeyID)
	require.Equal(t, openai.ID, keyState(t, web.APIKeyID).GroupID.Int64)
	require.Equal(t, grok.ID, keyState(t, grokKey.ID).GroupID.Int64)
	require.Equal(t, 2, activeKeyCount(t, u.ID))
}
