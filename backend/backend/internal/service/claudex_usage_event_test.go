//go:build unit

package service

// CLAUDEX: tests for the H8 usage event (claudex_usage_event.go).

import (
	"context"
	"testing"
	"time"

	claudexhook "github.com/Wei-Shaw/sub2api/internal/claudex/hook"

	"github.com/stretchr/testify/require"
)

func TestClaudexUsageEventFromUsageLog(t *testing.T) {
	groupID := int64(4)
	keyGroup := int64(9)
	upstream := " claude-opus-4-1 "
	created := time.Date(2026, 9, 26, 2, 0, 0, 0, time.FixedZone("CST", 8*3600))
	ev := claudexUsageEventFrom("req-1", &UsageLog{
		UserID: 7, APIKeyID: 11, GroupID: &groupID,
		Model: "claude-opus-4-1-20250805", RequestedModel: "opus", UpstreamModel: &upstream, CreatedAt: created,
	}, &postUsageBillingParams{
		User: &User{ID: 7}, APIKey: &APIKey{ID: 11, GroupID: &keyGroup}, Cost: &CostBreakdown{TotalCost: 1, ActualCost: 1.5},
	})
	require.Equal(t, claudexhook.UsageEvent{
		RequestID: "req-1", UserID: 7, APIKeyID: 11, GroupID: &groupID,
		RequestedModel: "opus", BilledModel: "claude-opus-4-1-20250805", UpstreamModel: "claude-opus-4-1",
		CostUSD: 1.5, At: created.UTC(),
	}, ev)
}

func TestClaudexUsageEventFallbacks(t *testing.T) {
	keyGroup := int64(9)
	ev := claudexUsageEventFrom("req-2", &UsageLog{Model: "gpt-5.5"}, &postUsageBillingParams{
		User: &User{ID: 3}, APIKey: &APIKey{ID: 5, GroupID: &keyGroup}, Cost: &CostBreakdown{ActualCost: 0},
	})
	require.Equal(t, "gpt-5.5", ev.RequestedModel, "historical rows without a requested model use the billed model")
	require.Equal(t, int64(3), ev.UserID)
	require.Equal(t, int64(5), ev.APIKeyID)
	require.Equal(t, &keyGroup, ev.GroupID)
	require.False(t, ev.At.IsZero())

	ev = claudexUsageEventFrom("req-3", nil, nil)
	require.Equal(t, "req-3", ev.RequestID)
}

// TestApplyUsageBillingReportsAppliedRequests checks the H8 call on the
// legacy fallback path (no billing repository): the event reaches the
// installed hook once.
func TestApplyUsageBillingReportsAppliedRequests(t *testing.T) {
	t.Cleanup(claudexhook.Reset)
	var got []claudexhook.UsageEvent
	claudexhook.Install(claudexhook.Hooks{UsageApplied: func(_ context.Context, ev claudexhook.UsageEvent) {
		got = append(got, ev)
	}})
	p := &postUsageBillingParams{Cost: &CostBreakdown{}, User: &User{ID: 1}, APIKey: &APIKey{ID: 2}}
	applied, err := applyUsageBilling(context.Background(), "req-legacy", &UsageLog{Model: "m"}, p, &billingDeps{}, nil)
	require.NoError(t, err)
	require.True(t, applied)
	require.Len(t, got, 1)
	require.Equal(t, "req-legacy", got[0].RequestID)
	require.Equal(t, "m", got[0].BilledModel)
}
