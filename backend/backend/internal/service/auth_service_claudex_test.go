//go:build unit

package service

// CLAUDEX: tests for the signup hooks (auth_service_claudex.go).

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"
)

type claudexRecordingSubAssigner struct {
	events *[]string
}

func (a claudexRecordingSubAssigner) AssignOrExtendSubscription(_ context.Context, input *AssignSubscriptionInput) (*UserSubscription, bool, error) {
	*a.events = append(*a.events, "assign")
	return &UserSubscription{UserID: input.UserID, GroupID: input.GroupID}, true, nil
}

func TestClaudexSignupHooksRunAfterDefaultSubscriptions(t *testing.T) {
	var events []string
	svc := &AuthService{
		settingService:     &SettingService{},
		defaultSubAssigner: claudexRecordingSubAssigner{events: &events},
	}
	svc.AddSignupHook("first", func(ctx context.Context, userID int64) error {
		require.Equal(t, int64(42), userID)
		_, hasDeadline := ctx.Deadline()
		require.True(t, hasDeadline, "each hook runs with a timeout")
		events = append(events, "first")
		return errors.New("boom")
	})
	svc.AddSignupHook("panics", func(context.Context, int64) error {
		events = append(events, "panics")
		panic("hook panic")
	})
	svc.AddSignupHook("last", func(context.Context, int64) error {
		events = append(events, "last")
		return nil
	})

	require.NotPanics(t, func() {
		svc.assignSubscriptions(context.Background(), 42, []DefaultSubscriptionSetting{{GroupID: 7, ValidityDays: 30}}, "auto assigned by signup defaults")
	})
	require.Equal(t, []string{"assign", "first", "panics", "last"}, events)
}

func TestClaudexSignupHooksRunWithoutDefaultSubscriptions(t *testing.T) {
	// assignSubscriptions returns early without a setting service or assigner;
	// the hooks still run for the new user.
	calls := 0
	svc := &AuthService{}
	svc.AddSignupHook("only", func(context.Context, int64) error { calls++; return nil })
	svc.assignSubscriptions(context.Background(), 5, nil, "auto assigned by signup defaults")
	require.Equal(t, 1, calls)
}

func TestClaudexSignupHooksSurviveCanceledRequest(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var hookErr error
	svc := &AuthService{}
	svc.AddSignupHook("ctx", func(ctx context.Context, _ int64) error { hookErr = ctx.Err(); return nil })
	svc.assignSubscriptions(ctx, 9, nil, "auto assigned by signup defaults")
	require.NoError(t, hookErr)
}

func TestClaudexSignupHooksIgnoreInvalidInput(t *testing.T) {
	calls := 0
	svc := &AuthService{}
	svc.AddSignupHook("", func(context.Context, int64) error { calls++; return nil })
	svc.AddSignupHook("nil", nil)
	svc.runSignupHooks(context.Background(), 0)
	require.Equal(t, 0, calls)
	svc.runSignupHooks(context.Background(), 1)
	require.Equal(t, 1, calls)

	var nilSvc *AuthService
	require.NotPanics(t, func() {
		nilSvc.AddSignupHook("x", func(context.Context, int64) error { return nil })
		nilSvc.runSignupHooks(context.Background(), 1)
	})
}
