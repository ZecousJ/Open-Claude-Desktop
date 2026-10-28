//go:build unit

package usage

import (
	"bytes"
	"context"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	claudexhook "github.com/Wei-Shaw/sub2api/internal/claudex/hook"

	"github.com/lib/pq"
	"github.com/stretchr/testify/require"
)

var countNow = time.Date(2026, 9, 26, 1, 0, 0, 0, time.UTC)

// countingSetup: group 4 has a session rule, an Opus rule and a hidden Sonnet
// rule; a rule for every group; group 9 has its own session rule.
func countingSetup() (*Component, *fakeStore, *testClock) {
	fs := newFakeStore()
	fs.addRule(Rule{ID: 1, GroupID: ptr(int64(4)), Kind: KindSession, Label: DefaultSessionLabel, WindowSeconds: 18000, LimitUSD: 5, Enabled: true, ShowInClient: true})
	fs.addRule(Rule{ID: 2, GroupID: ptr(int64(4)), Kind: KindModels, Label: "Opus", ModelPatterns: []string{"claude-opus-*"}, WindowSeconds: 604800, LimitUSD: 20, Enabled: true, ShowInClient: true})
	fs.addRule(Rule{ID: 3, GroupID: ptr(int64(4)), Kind: KindModels, Label: "Sonnet", ModelPatterns: []string{"claude-sonnet-*"}, WindowSeconds: 604800, LimitUSD: 20, Enabled: true})
	fs.addRule(Rule{ID: 4, Kind: KindAllModels, Label: DefaultAllModelsLabel, WindowSeconds: 604800, LimitUSD: 100, Enabled: true, ShowInClient: true})
	fs.addRule(Rule{ID: 5, GroupID: ptr(int64(9)), Kind: KindSession, Label: DefaultSessionLabel, WindowSeconds: 18000, LimitUSD: 5, Enabled: true})
	fs.addRule(Rule{ID: 6, GroupID: ptr(int64(4)), Kind: KindModels, Label: "Off", ModelPatterns: []string{"claude-opus-*"}, WindowSeconds: 604800, LimitUSD: 20})
	c, clock := newTestComponent(fs, countNow)
	return c, fs, clock
}

func lastAddition(t *testing.T, fs *fakeStore) usageAddition {
	t.Helper()
	fs.mu.Lock()
	defer fs.mu.Unlock()
	require.NotEmpty(t, fs.additions)
	add := fs.additions[len(fs.additions)-1]
	sort.Slice(add.RuleIDs, func(i, j int) bool { return add.RuleIDs[i] < add.RuleIDs[j] })
	return add
}

func TestUsageCountsEveryMatchingRuleOnceByAnyModelName(t *testing.T) {
	c, fs, _ := countingSetup()
	g4 := ptr(int64(4))
	for name, tc := range map[string]struct {
		ev   claudexhook.UsageEvent
		want []int64
	}{
		"requested name":  {claudexhook.UsageEvent{RequestedModel: "claude-opus-4", BilledModel: "gpt-5.4"}, []int64{1, 2, 4}},
		"billed name":     {claudexhook.UsageEvent{RequestedModel: "opus-latest", BilledModel: "claude-opus-4-1-20250805"}, []int64{1, 2, 4}},
		"upstream name":   {claudexhook.UsageEvent{RequestedModel: "best", BilledModel: "best", UpstreamModel: "CLAUDE-OPUS-4-1"}, []int64{1, 2, 4}},
		"two model rules": {claudexhook.UsageEvent{RequestedModel: "claude-opus-4", UpstreamModel: "claude-sonnet-4"}, []int64{1, 2, 3, 4}},
		"no model rule":   {claudexhook.UsageEvent{RequestedModel: "gpt-5.5", BilledModel: "gpt-5.5"}, []int64{1, 4}},
		"no model at all": {claudexhook.UsageEvent{}, []int64{1, 4}},
	} {
		t.Run(name, func(t *testing.T) {
			ev := tc.ev
			ev.RequestID, ev.UserID, ev.APIKeyID, ev.GroupID, ev.CostUSD, ev.At = "req-"+name, 11, 79, g4, 0.25, countNow
			c.OnUsageApplied(context.Background(), ev)
			add := lastAddition(t, fs)
			require.Equal(t, tc.want, add.RuleIDs, "each matching enabled rule once; disabled rule 6 and group 9's rule never")
			require.Equal(t, int64(11), add.UserID)
			require.Equal(t, 0.25, add.CostUSD)
			require.True(t, add.At.Equal(countNow))
		})
	}

	// A key without a group only meets the rules for every group; free
	// requests still count (request_count), negative costs never subtract.
	c.OnUsageApplied(context.Background(), claudexhook.UsageEvent{UserID: 11, RequestedModel: "claude-opus-4", CostUSD: -1, At: countNow})
	add := lastAddition(t, fs)
	require.Equal(t, []int64{4}, add.RuleIDs)
	require.Equal(t, 0.0, add.CostUSD)

	// Nothing to count: no write at all.
	fs.mu.Lock()
	n := len(fs.additions)
	fs.mu.Unlock()
	fs.mu.Lock()
	fs.rules = fs.rules[:3] // drop the rule for every group
	fs.mu.Unlock()
	c.rules.invalidate()
	c.OnUsageApplied(context.Background(), claudexhook.UsageEvent{UserID: 11, GroupID: ptr(int64(77)), At: countNow})
	c.OnUsageApplied(context.Background(), claudexhook.UsageEvent{UserID: 0, GroupID: g4, At: countNow})
	fs.mu.Lock()
	require.Len(t, fs.additions, n, "no matching rule or no user: nothing written")
	fs.mu.Unlock()
}

func TestUsageRetriesFailedWritesWithBackoff(t *testing.T) {
	c, fs, clock := countingSetup()
	fs.accumulateErr = []error{errTestDB, errTestDB, nil}
	ev := claudexhook.UsageEvent{RequestID: "req-1", UserID: 11, GroupID: ptr(int64(4)), RequestedModel: "claude-opus-4", CostUSD: 1.5, At: countNow}
	c.OnUsageApplied(context.Background(), ev)
	require.Equal(t, 1, c.Metrics().RetryQueue, "the failed write waits for a retry")

	c.retryDue(context.Background())
	require.Equal(t, 1, c.Metrics().RetryQueue, "not due before the first backoff")
	clock.Add(time.Second)
	c.retryDue(context.Background())
	require.Equal(t, 1, c.Metrics().RetryQueue, "second failure, queued again")
	clock.Add(time.Second)
	c.retryDue(context.Background())
	require.Equal(t, 1, c.Metrics().RetryQueue, "the backoff doubled to 2 s")
	clock.Add(time.Second)
	c.retryDue(context.Background())
	require.Equal(t, 0, c.Metrics().RetryQueue)
	require.Equal(t, uint64(2), c.Metrics().RetriedTotal)

	add := lastAddition(t, fs)
	require.Equal(t, []int64{1, 2, 4}, add.RuleIDs)
	require.True(t, add.At.Equal(countNow), "the retry keeps the billing time")
	fs.mu.Lock()
	require.Equal(t, 1.5, fs.counterRows[[2]int64{2, 11}].UsedUSD)
	fs.mu.Unlock()

	for attempts, want := range map[int]time.Duration{1: time.Second, 2: 2 * time.Second, 3: 4 * time.Second, 9: 256 * time.Second, 10: 5 * time.Minute, 50: 5 * time.Minute} {
		require.Equal(t, want, backoff(attempts), "attempt %d", attempts)
	}
}

// captureLogs sends slog output to a buffer for the test.
func captureLogs(t *testing.T) *syncBuffer {
	t.Helper()
	buf := &syncBuffer{}
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return buf
}

type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func TestUsageOverflowIsLoggedAndCountedNeverSilent(t *testing.T) {
	logs := captureLogs(t)
	c, fs, _ := countingSetup()
	c.queue = newRetryQueue(2)
	fs.accumulateErr = []error{errTestDB, errTestDB, errTestDB}
	for _, id := range []string{"req-a", "req-b", "req-c"} {
		c.OnUsageApplied(context.Background(), claudexhook.UsageEvent{RequestID: id, UserID: 11, GroupID: ptr(int64(4)), RequestedModel: "claude-opus-4", CostUSD: 0.75, At: countNow})
	}
	m := c.Metrics()
	require.Equal(t, 2, m.RetryQueue)
	require.Equal(t, uint64(1), m.DroppedTotal)
	out := logs.String()
	require.Contains(t, out, "level=ERROR")
	require.Contains(t, out, "retry queue full")
	require.Contains(t, out, "request_id=req-c")
	require.Contains(t, out, "user_id=11")
	require.Contains(t, out, "cost_usd=0.75")
	require.Contains(t, out, "rule_ids=\"[1 4 2]\"", "session, all-models, then per-model rules")
	require.Contains(t, out, "claudex_usage_counter_dropped_total=1")
}

func TestUsageRetryDropsAdditionsWhoseWindowsEnded(t *testing.T) {
	logs := captureLogs(t)
	c, fs, clock := countingSetup()
	fs.accumulateErr = []error{errTestDB}
	c.OnUsageApplied(context.Background(), claudexhook.UsageEvent{RequestID: "req-old", UserID: 11, GroupID: ptr(int64(4)), RequestedModel: "gpt-5.5", CostUSD: 1, At: countNow})
	clock.Add(7*24*time.Hour + time.Second) // past the longest matching window (7 d)
	c.retryDue(context.Background())
	m := c.Metrics()
	require.Equal(t, 0, m.RetryQueue)
	require.Equal(t, uint64(1), m.ExpiredTotal)
	require.Contains(t, logs.String(), "claudex_usage_counter_expired_total=1")
	fs.mu.Lock()
	require.Empty(t, fs.additions, "never written into a later window")
	fs.mu.Unlock()
}

func TestUsageRetryStopsOnPermanentErrors(t *testing.T) {
	c, fs, clock := countingSetup()
	fs.accumulateErr = []error{errTestDB, &pq.Error{Code: "23503", Message: "user gone"}}
	c.OnUsageApplied(context.Background(), claudexhook.UsageEvent{RequestID: "req-x", UserID: 11, GroupID: ptr(int64(4)), At: countNow})
	clock.Add(time.Second)
	c.retryDue(context.Background())
	require.Equal(t, 0, c.Metrics().RetryQueue)
	require.Equal(t, uint64(0), c.Metrics().DroppedTotal)
}

func TestUsageEventsWaitWhenRulesCannotBeLoaded(t *testing.T) {
	c, fs, clock := countingSetup()
	fs.loadErr = errTestDB
	c.OnUsageApplied(context.Background(), claudexhook.UsageEvent{RequestID: "req-r", UserID: 11, GroupID: ptr(int64(4)), RequestedModel: "claude-opus-4", CostUSD: 2, At: countNow})
	require.Equal(t, 1, c.Metrics().RetryQueue)
	fs.mu.Lock()
	fs.loadErr = nil
	fs.mu.Unlock()
	clock.Add(6 * time.Second) // past the backoff and the 5 s error cache
	c.retryDue(context.Background())
	require.Equal(t, 0, c.Metrics().RetryQueue)
	add := lastAddition(t, fs)
	require.Equal(t, []int64{1, 2, 4}, add.RuleIDs)
	require.Equal(t, 2.0, add.CostUSD)
}

func TestRetryWorkerRunsUntilCancelled(t *testing.T) {
	c, fs, clock := countingSetup()
	fs.accumulateErr = []error{errTestDB}
	c.OnUsageApplied(context.Background(), claudexhook.UsageEvent{RequestID: "req-w", UserID: 11, GroupID: ptr(int64(4)), At: countNow})
	clock.Add(time.Second)
	ctx, cancel := context.WithCancel(context.Background())
	c.Start(ctx)
	c.Start(ctx) // idempotent
	require.Eventually(t, func() bool { return c.Metrics().RetryQueue == 0 }, 5*time.Second, 20*time.Millisecond)
	cancel()
}

func TestRetryProbesOncePerTickWhileTheDatabaseIsDown(t *testing.T) {
	c, fs, clock := countingSetup()
	fs.accumulateErr = []error{errTestDB, errTestDB, errTestDB, errTestDB}
	for _, id := range []string{"req-1", "req-2", "req-3"} {
		c.OnUsageApplied(context.Background(), claudexhook.UsageEvent{RequestID: id, UserID: 11, GroupID: ptr(int64(4)), CostUSD: 1, At: countNow})
	}
	require.Equal(t, 3, c.Metrics().RetryQueue)
	clock.Add(time.Second)
	c.retryDue(context.Background())
	fs.mu.Lock()
	require.Equal(t, 4, fs.accumulations, "one probe, the other two put back untried")
	fs.mu.Unlock()
	require.Equal(t, 3, c.Metrics().RetryQueue)

	// The database is back: the untried ones go through at once, the probe
	// after its backoff.
	c.retryDue(context.Background())
	require.Equal(t, 1, c.Metrics().RetryQueue)
	clock.Add(2 * time.Second)
	c.retryDue(context.Background())
	require.Equal(t, 0, c.Metrics().RetryQueue)
	fs.mu.Lock()
	require.Len(t, fs.additions, 3)
	require.Equal(t, 3.0, fs.counterRows[[2]int64{1, 11}].UsedUSD)
	fs.mu.Unlock()
}

func TestRetryKeepsTheQueueOnShutdown(t *testing.T) {
	c, fs, clock := countingSetup()
	fs.accumulateErr = []error{errTestDB, errTestDB}
	for _, id := range []string{"req-1", "req-2"} {
		c.OnUsageApplied(context.Background(), claudexhook.UsageEvent{RequestID: id, UserID: 11, GroupID: ptr(int64(4)), At: countNow})
	}
	clock.Add(time.Second)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	c.retryDue(ctx)
	require.Equal(t, 2, c.Metrics().RetryQueue, "nothing is lost when the worker stops mid-batch")
	fs.mu.Lock()
	require.Equal(t, 2, fs.accumulations)
	fs.mu.Unlock()
}

func TestUsageCountsTheNamesUpstreamServesAModelAs(t *testing.T) {
	c, fs, _ := countingSetup()
	c.OnUsageApplied(context.Background(), claudexhook.UsageEvent{RequestID: "req-m", UserID: 11, GroupID: ptr(int64(4)),
		RequestedModel: "models/claude-opus-4-5", BilledModel: "models/claude-opus-4-5", CostUSD: 1, At: countNow})
	require.Equal(t, []int64{1, 2, 4}, lastAddition(t, fs).RuleIDs, "the Opus rule counts the prefixed name")
}

func TestShutdownWritesTheQueueOrLogsEveryEventInFull(t *testing.T) {
	logs := captureLogs(t)
	c, fs, _ := countingSetup()
	fs.accumulateErr = []error{errTestDB, errTestDB, errTestDB}
	for _, id := range []string{"req-1", "req-2", "req-3"} {
		c.OnUsageApplied(context.Background(), claudexhook.UsageEvent{RequestID: id, UserID: 11, GroupID: ptr(int64(4)), CostUSD: 1, At: countNow})
	}
	require.Equal(t, 3, c.Metrics().RetryQueue)

	// The database answers again at shutdown: the first write goes through,
	// the second fails and the rest is not tried but logged in full.
	fs.accumulateErr = []error{nil, errTestDB}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	c.retryLoop(ctx)
	require.Equal(t, 0, c.Metrics().RetryQueue)
	require.Equal(t, uint64(2), c.Metrics().DroppedTotal)
	fs.mu.Lock()
	require.Len(t, fs.additions, 1)
	fs.mu.Unlock()
	var lost []string
	for _, line := range strings.Split(logs.String(), "\n") {
		if strings.Contains(line, "not written at shutdown") {
			lost = append(lost, line)
		}
	}
	require.Len(t, lost, 2, "req-1 was written; req-2 failed; req-3 was not tried")
	require.Contains(t, lost[0], "level=ERROR")
	require.Contains(t, lost[0], "request_id=req-2")
	require.Contains(t, lost[0], "rule_ids=")
	require.Contains(t, lost[1], "request_id=req-3")

	// A billing task that fails after the worker stopped is logged at once.
	fs.accumulateErr = []error{errTestDB}
	c.OnUsageApplied(context.Background(), claudexhook.UsageEvent{RequestID: "req-late", UserID: 11, GroupID: ptr(int64(4)), CostUSD: 1, At: countNow})
	require.Equal(t, 0, c.Metrics().RetryQueue)
	require.Equal(t, uint64(3), c.Metrics().DroppedTotal)
	require.Contains(t, logs.String(), "dropped, shutting down")
	require.Contains(t, logs.String(), "request_id=req-late")
}
