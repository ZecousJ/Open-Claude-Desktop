//go:build unit

package service

// CLAUDEX: file added by the Claudex fork (see backend/CLAUDEX_CHANGES.md).

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	claudexhook "github.com/Wei-Shaw/sub2api/internal/claudex/hook"
	"github.com/Wei-Shaw/sub2api/internal/config"

	"github.com/stretchr/testify/require"
)

type claudexRealtimeBillingRepo struct {
	UsageBillingRepository
	mu      sync.Mutex
	cmds    []*UsageBillingCommand
	applied bool
	err     error
}

func (r *claudexRealtimeBillingRepo) Apply(_ context.Context, cmd *UsageBillingCommand) (*UsageBillingApplyResult, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.cmds = append(r.cmds, cmd)
	if r.err != nil {
		return nil, r.err
	}
	return &UsageBillingApplyResult{Applied: r.applied}, nil
}

func newClaudexRealtimeService(t *testing.T, cfg *config.Config) (*OpenAIGatewayService, *claudexRealtimeBillingRepo, *[]claudexhook.UsageEvent) {
	t.Helper()
	repo := &claudexRealtimeBillingRepo{applied: true}
	var events []claudexhook.UsageEvent
	var mu sync.Mutex
	claudexhook.Install(claudexhook.Hooks{UsageApplied: func(_ context.Context, ev claudexhook.UsageEvent) {
		mu.Lock()
		defer mu.Unlock()
		events = append(events, ev)
	}})
	t.Cleanup(claudexhook.Reset)
	cache := NewBillingCacheService(nil, nil, nil, nil, nil, nil, cfg, nil)
	t.Cleanup(cache.Stop)
	svc := &OpenAIGatewayService{
		cfg: cfg, usageBillingRepo: repo, billingService: NewBillingService(cfg, nil), billingCacheService: cache,
		deferredService: NewDeferredService(nil, nil, time.Minute),
	}
	return svc, repo, &events
}

func claudexRealtimeKey(group *Group) *APIKey {
	return &APIKey{ID: 9, UserID: 7, Key: "sk-device", GroupID: &group.ID, Group: group, User: &User{ID: 7, Balance: 5}}
}

func TestClaudexRealtimeAudioSeconds(t *testing.T) {
	require.Zero(t, ClaudexRealtimeAudioSeconds(0))
	require.Zero(t, ClaudexRealtimeAudioSeconds(-5))
	require.Equal(t, 1.0, ClaudexRealtimeAudioSeconds(32000))
	require.Equal(t, 0.1, ClaudexRealtimeAudioSeconds(3200))
}

func TestRecordClaudexRealtimeTranscriptionBillsTheBalance(t *testing.T) {
	cfg := &config.Config{}
	svc, repo, events := newClaudexRealtimeService(t, cfg)
	price := 0.72
	key := claudexRealtimeKey(&Group{ID: 31, Platform: PlatformOpenAI, RateMultiplier: 1.5, AudioSTTPricePerHour: &price})
	out, err := svc.RecordClaudexRealtimeTranscription(context.Background(), &ClaudexRealtimeUsageInput{
		RequestID: "claudex_audio:abc", APIKey: key, User: key.User, Model: "realtime-transcription", AudioBytes: 32000 * 10,
	})
	require.NoError(t, err)
	require.True(t, out.Applied)
	require.Equal(t, 10.0, out.Seconds)
	// 10 s at $0.72/hour = $0.002, times 1.5.
	require.InDelta(t, 0.003, out.CostUSD, 1e-12)
	require.Len(t, repo.cmds, 1)
	cmd := repo.cmds[0]
	require.Equal(t, "claudex_audio:abc", cmd.RequestID)
	require.InDelta(t, 0.003, cmd.BalanceCost, 1e-12)
	require.Zero(t, cmd.SubscriptionCost)
	require.Zero(t, cmd.AccountID)
	require.Zero(t, cmd.AccountQuotaCost)
	require.Equal(t, "realtime-transcription", cmd.Model)
	require.Equal(t, BillingTypeBalance, cmd.BillingType)
	require.Len(t, *events, 1)
	ev := (*events)[0]
	require.Equal(t, "claudex_audio:abc", ev.RequestID)
	require.Equal(t, int64(7), ev.UserID)
	require.Equal(t, int64(9), ev.APIKeyID)
	require.Equal(t, "realtime-transcription", ev.BilledModel)
	require.Equal(t, "realtime-transcription", ev.RequestedModel)
	require.InDelta(t, 0.003, ev.CostUSD, 1e-12)
}

func TestRecordClaudexRealtimeTranscriptionDefaultsAndSubscriptions(t *testing.T) {
	cfg := &config.Config{}
	svc, repo, events := newClaudexRealtimeService(t, cfg)
	group := &Group{ID: 31, Platform: PlatformAnthropic, RateMultiplier: 1, SubscriptionType: SubscriptionTypeSubscription}
	key := claudexRealtimeKey(group)
	out, err := svc.RecordClaudexRealtimeTranscription(context.Background(), &ClaudexRealtimeUsageInput{
		RequestID: "claudex_audio:sub", APIKey: key, User: key.User, Subscription: &UserSubscription{ID: 55},
		Model: "realtime-transcription", AudioBytes: 32000 * 36,
	})
	require.NoError(t, err)
	// No group price: the built-in $0.10/hour, 36 s = $0.001.
	require.InDelta(t, 0.001, out.CostUSD, 1e-12)
	cmd := repo.cmds[0]
	require.Zero(t, cmd.BalanceCost)
	require.InDelta(t, 0.001, cmd.SubscriptionCost, 1e-12)
	require.Equal(t, int64(55), *cmd.SubscriptionID)
	require.Equal(t, BillingTypeSubscription, cmd.BillingType)
	require.Len(t, *events, 1)
}

func TestRecordClaudexRealtimeTranscriptionSkipsAndFails(t *testing.T) {
	cfg := &config.Config{}
	svc, repo, events := newClaudexRealtimeService(t, cfg)
	key := claudexRealtimeKey(&Group{ID: 31, RateMultiplier: 1})
	in := func(id string, bytes int64) *ClaudexRealtimeUsageInput {
		return &ClaudexRealtimeUsageInput{RequestID: id, APIKey: key, User: key.User, Model: "m", AudioBytes: bytes}
	}

	out, err := svc.RecordClaudexRealtimeTranscription(context.Background(), in("claudex_audio:empty", 0))
	require.NoError(t, err)
	require.False(t, out.Applied)
	require.Empty(t, repo.cmds, "no audio, no billing")

	_, err = svc.RecordClaudexRealtimeTranscription(context.Background(), in("client:abc", 32000))
	require.Error(t, err, "only claudex_audio: request ids")
	_, err = svc.RecordClaudexRealtimeTranscription(context.Background(), nil)
	require.Error(t, err)

	// A duplicate request id is not applied twice and reports no event.
	repo.applied = false
	out, err = svc.RecordClaudexRealtimeTranscription(context.Background(), in("claudex_audio:dup", 32000))
	require.NoError(t, err)
	require.False(t, out.Applied)
	require.Empty(t, *events)

	repo.err = errors.New("db down")
	_, err = svc.RecordClaudexRealtimeTranscription(context.Background(), in("claudex_audio:err", 32000))
	require.Error(t, err)
	require.Empty(t, *events)

	// Simple mode without key windows: priced but not billed.
	simple := &config.Config{RunMode: config.RunModeSimple}
	svc2, repo2, events2 := newClaudexRealtimeService(t, simple)
	out, err = svc2.RecordClaudexRealtimeTranscription(context.Background(), in("claudex_audio:simple", 32000))
	require.NoError(t, err)
	require.False(t, out.Applied)
	require.Empty(t, repo2.cmds)
	require.Empty(t, *events2)
}
