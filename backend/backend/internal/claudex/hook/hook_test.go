package claudexhook

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestDispatchWithoutHooksReturnsZeroValues(t *testing.T) {
	Reset()
	t.Cleanup(Reset)
	ctx := context.Background()

	require.NotPanics(t, func() { UsageApplied(ctx, UsageEvent{RequestID: "r"}) })
	require.NoError(t, SessionsRevoked(ctx, 1, "revoke_all"))
	require.Equal(t, Valid, JWTRevoked(ctx, 1, time.Now(), "sid"))
	ids := ManagedAPIKeyIDs(ctx, 1, []int64{1, 2})
	require.NotNil(t, ids)
	require.Empty(t, ids)
	require.False(t, ManagedAPIKey(ctx, 1, 2))
	require.NoError(t, PrecheckTurn(ctx, 1, 2, nil, []string{"m"}))
	require.NoError(t, CreateAPIKeyAllowed(ctx, 1, false))

	// An installed Hooks value with nil fields behaves the same.
	Install(Hooks{})
	require.NoError(t, SessionsRevoked(ctx, 1, "revoke_all"))
	require.Equal(t, Valid, JWTRevoked(ctx, 1, time.Now(), ""))
	require.Empty(t, ManagedAPIKeyIDs(ctx, 1, []int64{1}))
	require.NoError(t, CreateAPIKeyAllowed(ctx, 1, false))
}

func TestDispatchCallsInstalledHooks(t *testing.T) {
	t.Cleanup(Reset)
	ctx := context.Background()
	var got UsageEvent
	usageDone := make(chan struct{}, 1)
	revokeErr := errors.New("db down")
	Install(Hooks{
		UsageApplied: func(hctx context.Context, ev UsageEvent) {
			deadline, ok := hctx.Deadline()
			require.True(t, ok, "usage hook runs with a timeout")
			require.WithinDuration(t, time.Now().Add(usageTimeout), deadline, time.Second)
			got = ev
			usageDone <- struct{}{}
		},
		SessionsRevoked: func(_ context.Context, userID int64, reason string) error {
			require.Equal(t, int64(7), userID)
			require.Equal(t, "revoke_all", reason)
			return revokeErr
		},
		JWTRevoked: func(_ context.Context, userID int64, _ time.Time, sid string) SessionState {
			if sid == "gone" {
				return Revoked
			}
			return CheckFailed
		},
		ManagedAPIKeyIDs: func(_ context.Context, _ int64, ids []int64) map[int64]bool {
			return map[int64]bool{ids[0]: true}
		},
		PrecheckTurn: func(_ context.Context, _, _ int64, _ *int64, models []string) error {
			return errors.New("limit " + models[0])
		},
		CreateAPIKey: func(_ context.Context, _ int64, isAdmin bool) error {
			if isAdmin {
				return nil
			}
			return errors.New("disabled")
		},
	})

	// The caller's cancellation does not reach the usage hook.
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	UsageApplied(cancelled, UsageEvent{RequestID: "req-1", CostUSD: 0.5})
	<-usageDone
	require.Equal(t, "req-1", got.RequestID)

	require.ErrorIs(t, SessionsRevoked(ctx, 7, "revoke_all"), revokeErr)
	require.Equal(t, Revoked, JWTRevoked(ctx, 1, time.Now(), "gone"))
	require.Equal(t, CheckFailed, JWTRevoked(ctx, 1, time.Now(), "x"))
	require.True(t, ManagedAPIKey(ctx, 1, 5))
	require.EqualError(t, PrecheckTurn(ctx, 1, 2, nil, []string{"opus"}), "limit opus")
	require.NoError(t, CreateAPIKeyAllowed(ctx, 1, true))
	require.EqualError(t, CreateAPIKeyAllowed(ctx, 1, false), "disabled")
}

func TestDispatchSwallowsPanics(t *testing.T) {
	t.Cleanup(Reset)
	ctx := context.Background()
	boom := func() { panic("boom") }
	Install(Hooks{
		UsageApplied:     func(context.Context, UsageEvent) { boom() },
		SessionsRevoked:  func(context.Context, int64, string) error { boom(); return nil },
		JWTRevoked:       func(context.Context, int64, time.Time, string) SessionState { boom(); return Valid },
		ManagedAPIKeyIDs: func(context.Context, int64, []int64) map[int64]bool { boom(); return nil },
		PrecheckTurn:     func(context.Context, int64, int64, *int64, []string) error { boom(); return nil },
		CreateAPIKey:     func(context.Context, int64, bool) error { boom(); return nil },
	})
	require.NotPanics(t, func() { UsageApplied(ctx, UsageEvent{}) })
	// A failing revocation must surface so the endpoint answers 500.
	require.Error(t, SessionsRevoked(ctx, 1, "revoke_all"))
	// A failing token check fails closed.
	require.Equal(t, CheckFailed, JWTRevoked(ctx, 1, time.Now(), ""))
	// Both fail closed: a broken device-key lookup masks and locks every key,
	// a broken usage check refuses the WebSocket turn.
	require.Equal(t, map[int64]bool{1: true, 2: true}, ManagedAPIKeyIDs(ctx, 1, []int64{1, 2}))
	require.True(t, ManagedAPIKey(ctx, 1, 3))
	require.ErrorContains(t, PrecheckTurn(ctx, 1, 1, nil, nil), "CLAUDEX_USAGE_CHECK_FAILED")
	require.Error(t, CreateAPIKeyAllowed(ctx, 1, false))
}

func TestMaskKey(t *testing.T) {
	require.Equal(t, "sk-…a1b2", MaskKey("sk-0123456789abcdefa1b2"))
	require.Equal(t, "sk-…", MaskKey("sk-a1b2"))
	require.Equal(t, "…wxyz", MaskKey("custom-key-wxyz"))
	require.Equal(t, "…", MaskKey(""))
	require.NotContains(t, MaskKey("sk-secretsecretsecret"), "secretsecret")
}
