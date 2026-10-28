//go:build integration

package devices_test

// Integration tests of the managed web key (W-KEY): one platform='web'
// device row per user, outside the desktop device limit, revoked by "log out
// of all devices" and never reachable from a desktop device id.

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/devices"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/stretchr/testify/require"
)

func (h *harness) webKeyRequest(u *service.User, tok string) devices.WebKeyRequest {
	h.t.Helper()
	claims, err := h.auth.ValidateToken(tok)
	require.NoError(h.t, err)
	return devices.WebKeyRequest{UserID: u.ID, SessionID: claims.SessionID, IssuedAt: claims.IssuedAt.Time, IP: "203.0.113.9"}
}

func webRow(t *testing.T, userID int64) (id int64, platform, name, family string, keyID int64, revoked bool) {
	t.Helper()
	var revokedAt *time.Time
	require.NoError(t, itDB.QueryRow(`SELECT id, platform, device_name, session_family_id, api_key_id, revoked_at FROM claudex_devices
WHERE user_id = $1 AND device_id_hash = $2`, userID, devices.WebDeviceHash(userID)).
		Scan(&id, &platform, &name, &family, &keyID, &revokedAt))
	return id, platform, name, family, keyID, revokedAt != nil
}

func TestWebKeyIsIdempotentUnderConcurrency(t *testing.T) {
	h := newHarness(t)
	u := h.user()
	g := h.planGroup()
	req := h.webKeyRequest(u, h.token(u))

	const n = 8
	var wg sync.WaitGroup
	out := make([]*devices.WebKey, n)
	errs := make([]error, n)
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			out[i], errs[i] = h.comp.EnsureWebKey(h.ctx, req)
		}(i)
	}
	close(start)
	wg.Wait()
	created := 0
	for i := range out {
		require.NoError(t, errs[i])
		require.Equal(t, out[0].APIKeyID, out[i].APIKeyID)
		require.Equal(t, out[0].Key, out[i].Key)
		require.NotEmpty(t, out[i].Key)
		require.Equal(t, g.ID, out[i].GroupID)
		if out[i].Created {
			created++
		}
	}
	require.Equal(t, 1, created)
	require.Equal(t, 1, deviceCount(t, u.ID))
	require.Equal(t, 1, activeKeyCount(t, u.ID))

	id, platform, name, family, keyID, revoked := webRow(t, u.ID)
	require.Equal(t, out[0].DeviceID, id)
	require.Equal(t, devices.PlatformWeb, platform)
	require.Equal(t, devices.WebDeviceName, name)
	require.Empty(t, family, "the web key is bound to no browser session")
	require.Equal(t, out[0].APIKeyID, keyID)
	require.False(t, revoked)
	require.Equal(t, devices.WebKeyName(devices.WebDeviceHash(u.ID)), keyState(t, keyID).Name)

	// The key works on the gateway and is a managed key.
	require.Equal(t, http.StatusOK, h.gateway(out[0].Key).Code)
	owner, ok := h.comp.IsWebKey(h.ctx, keyID)
	require.True(t, ok)
	require.Equal(t, u.ID, owner)
	require.True(t, h.comp.ManagedAPIKeyIDs(h.ctx, u.ID, []int64{keyID})[keyID])

	// The desktop device directory never sees it, not even by its device id.
	_, found := h.comp.LookupByDeviceID(h.ctx, u.ID, devices.WebDeviceID(u.ID))
	require.False(t, found)
	require.NotEqual(t, devices.DeviceHash(devices.WebDeviceID(u.ID)), devices.WebDeviceHash(u.ID))
	require.Equal(t, devices.WebDeviceID(u.ID), devices.WebDeviceID(u.ID), "stable per user")
	require.NotEqual(t, devices.WebDeviceID(u.ID), devices.WebDeviceID(u.ID+1))
}

func TestWebKeyDoesNotCountTowardTheDeviceLimit(t *testing.T) {
	h := newHarness(t)
	u := h.user()
	h.planGroup()
	tok := h.token(u)
	_, err := h.comp.EnsureWebKey(h.ctx, h.webKeyRequest(u, tok))
	require.NoError(t, err)

	for i := 0; i < 5; i++ {
		h.mustRegister(tok, newDeviceID(), "")
	}
	rec := h.register(tok, newDeviceID(), "")
	require.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())
	e := decodeEnv(t, rec)
	require.Equal(t, "CLAUDEX_DEVICE_LIMIT", e.Reason)
	require.Equal(t, map[string]string{"limit": "5", "active": "5"}, e.Metadata)
	require.Equal(t, 6, deviceCount(t, u.ID), "five desktop devices plus the web device")

	rec = h.do(http.MethodGet, fmt.Sprintf("/api/v1/admin/claudex/users/%d/device-limit", u.ID), "", nil, "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var lim devices.DeviceLimitJSON
	require.NoError(t, json.Unmarshal(decodeEnv(t, rec).Data, &lim))
	require.Equal(t, 5, lim.ActiveDevices)

	// With five desktop devices the web key is still issued.
	again, err := h.comp.EnsureWebKey(h.ctx, h.webKeyRequest(u, tok))
	require.NoError(t, err)
	require.False(t, again.Created)
}

func TestWebKeyRevokeAllAndReissue(t *testing.T) {
	h := newHarness(t)
	u := h.user()
	h.planGroup()
	old := h.token(u)
	first, err := h.comp.EnsureWebKey(h.ctx, h.webKeyRequest(u, old))
	require.NoError(t, err)

	// The revoke-all in a later second than the token (a token of the
	// revocation's own second whose session is not signed out counts as after).
	waitNextSecond()
	rec := h.do(http.MethodPost, "/api/v1/auth/revoke-all-sessions", old, nil, "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	// Revoke-all leaves the web row and its key alone, so a turn already
	// running on the web keeps going (web plan Q7); the browser sessions are
	// signed out by the web component.
	require.NotEqual(t, service.StatusAPIKeyDisabled, keyState(t, first.APIKeyID).Status)
	_, _, _, _, _, revoked := webRow(t, u.ID)
	require.False(t, revoked)
	require.Equal(t, http.StatusOK, h.gateway(first.Key).Code)

	// A token from before the revoke-all cannot get a key.
	_, err = h.comp.EnsureWebKey(h.ctx, h.webKeyRequest(u, old))
	require.True(t, errors.Is(err, devices.ErrSessionRevoked), "%v", err)

	// A new sign-in gets the same, still valid key.
	waitNextSecond()
	fresh := h.token(u)
	next, err := h.comp.EnsureWebKey(h.ctx, h.webKeyRequest(u, fresh))
	require.NoError(t, err)
	require.Equal(t, first.APIKeyID, next.APIKeyID)
	require.Equal(t, first.DeviceID, next.DeviceID, "same web device row")
	require.Equal(t, http.StatusOK, h.gateway(next.Key).Code)

	// RevokeWebKey: a user-reason sign-out is reissued on the next call.
	require.NoError(t, h.comp.RevokeWebKey(h.ctx, u.ID, devices.ReasonUser))
	require.Equal(t, service.StatusAPIKeyDisabled, keyState(t, next.APIKeyID).Status)
	third, err := h.comp.EnsureWebKey(h.ctx, h.webKeyRequest(u, fresh))
	require.NoError(t, err)
	require.True(t, third.Rotated)

	// An admin revocation needs a sign-in after it (a later second: a token of
	// the revocation's own second with a live session counts as after it).
	waitNextSecond()
	require.NoError(t, h.comp.RevokeWebKey(h.ctx, u.ID, devices.ReasonAdmin))
	_, err = h.comp.EnsureWebKey(h.ctx, h.webKeyRequest(u, fresh))
	require.True(t, errors.Is(err, devices.ErrSessionRevoked), "%v", err)
	waitNextSecond()
	fourth, err := h.comp.EnsureWebKey(h.ctx, h.webKeyRequest(u, h.token(u)))
	require.NoError(t, err)
	require.True(t, fourth.Rotated)
	require.Equal(t, http.StatusOK, h.gateway(fourth.Key).Code)

	// A user without a web device: revoking is a no-op.
	other := h.user()
	require.NoError(t, h.comp.RevokeWebKey(h.ctx, other.ID, devices.ReasonAdmin))
}

func TestWebKeyNeedsAPlanAndProvisioning(t *testing.T) {
	h := newHarness(t)
	u := h.user()
	h.planGroup()
	tok := h.token(u)

	h.setProvisioning(`{"enabled":false}`)
	_, err := h.comp.EnsureWebKey(h.ctx, h.webKeyRequest(u, tok))
	require.Equal(t, "CLAUDEX_DEVICE_KEYS_DISABLED", infraerrors.Reason(err))

	_, err = h.comp.EnsureWebKey(h.ctx, devices.WebKeyRequest{})
	require.Equal(t, "CLAUDEX_USER_NOT_FOUND", infraerrors.Reason(err))
	require.Equal(t, 0, deviceCount(t, u.ID))
}
