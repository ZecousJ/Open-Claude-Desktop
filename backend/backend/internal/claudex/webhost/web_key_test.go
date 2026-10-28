package webhost

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/devices"

	"github.com/stretchr/testify/require"
)

// fakeWebKeys is a WebKeyIssuer whose EnsureWebKey answers err.
type fakeWebKeys struct{ err error }

func (fakeWebKeys) Name() string { return "devices" }
func (f fakeWebKeys) EnsureWebKey(context.Context, devices.WebKeyRequest) (*devices.WebKey, error) {
	return nil, f.err
}
func (fakeWebKeys) IsWebKey(context.Context, int64) (int64, bool)     { return 0, false }
func (fakeWebKeys) RevokeWebKey(context.Context, int64, string) error { return nil }

func TestWebKeyWithoutAPlanSignsInWithoutAKey(t *testing.T) {
	env := &core.Env{Components: []core.Feature{fakeWebKeys{err: core.ErrNoPlan}}}
	answer, err := webKeyFrom(env)(context.Background(), KeyRequest{UserID: 7})
	require.NoError(t, err, "an account without a plan group still opens on the web (balance only)")
	raw, err := json.Marshal(answer)
	require.NoError(t, err)
	var wire struct {
		DeviceID     string `json:"deviceId"`
		Registration struct {
			APIKey  *json.RawMessage  `json:"api_key"`
			APIKeys []json.RawMessage `json:"api_keys"`
			Plan    *json.RawMessage  `json:"plan"`
			Device  struct {
				Platform  string `json:"platform"`
				CreatedAt string `json:"created_at"`
			} `json:"device"`
		} `json:"registration"`
	}
	require.NoError(t, json.Unmarshal(raw, &wire))
	require.Equal(t, devices.WebDeviceID(7), wire.DeviceID)
	require.Nil(t, wire.Registration.APIKey, "no key without a plan group")
	require.NotNil(t, wire.Registration.APIKeys, "an empty list, not null")
	require.Empty(t, wire.Registration.APIKeys)
	require.Nil(t, wire.Registration.Plan)
	require.Equal(t, devices.PlatformWeb, wire.Registration.Device.Platform)
	require.NotEmpty(t, wire.Registration.Device.CreatedAt)
}

func TestWebKeyOtherFailuresStillFail(t *testing.T) {
	boom := errors.New("boom")
	env := &core.Env{Components: []core.Feature{fakeWebKeys{err: boom}}}
	_, err := webKeyFrom(env)(context.Background(), KeyRequest{UserID: 7})
	require.ErrorIs(t, err, boom)
}
