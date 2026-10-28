//go:build integration

package usage

import (
	"context"
	"database/sql"
	"errors"
	"sync"
	"testing"
	"time"

	claudexhook "github.com/Wei-Shaw/sub2api/internal/claudex/hook"

	"github.com/lib/pq"
	"github.com/stretchr/testify/require"
)

var itT0 = time.Date(2026, 9, 26, 1, 0, 0, 0, time.UTC)

func itStore(db *sql.DB) sqlStore { return sqlStore{db: func() *sql.DB { return db }} }

func itRule(t *testing.T, s sqlStore, f ruleFields) int64 {
	t.Helper()
	require.NoError(t, f.normalizeAndValidate())
	id, err := s.createRule(context.Background(), f, nil)
	require.NoError(t, err)
	return id
}

func itCounter(t *testing.T, s sqlStore, ruleID, userID int64) counterRow {
	t.Helper()
	rows, err := s.counters(context.Background(), userID, []int64{ruleID})
	require.NoError(t, err)
	row, ok := rows[ruleID]
	require.True(t, ok, "counter of rule %d user %d", ruleID, userID)
	return row
}

func TestIntegrationUpsertAccumulatesAndRollsOverFirstUseWindows(t *testing.T) {
	db := NewIntegrationDB(t)
	s := itStore(db)
	ctx := context.Background()
	session := itRule(t, s, ruleFields{GroupID: iptr(int64(4)), Kind: KindSession, LimitUSD: 5, Enabled: true, ShowInClient: true})
	weekly := itRule(t, s, ruleFields{GroupID: iptr(int64(4)), Kind: KindAllModels, WindowSeconds: 604800, LimitUSD: 100, Enabled: true, ShowInClient: true})

	add := func(at time.Time, cost float64, rules ...int64) {
		require.NoError(t, s.accumulate(ctx, usageAddition{UserID: 11, At: at, CostUSD: cost, RuleIDs: rules}))
	}
	add(itT0, 0.1, session, weekly)
	row := itCounter(t, s, session, 11)
	require.True(t, row.WindowStart.Equal(itT0))
	require.True(t, row.WindowEnd.Equal(itT0.Add(5*time.Hour)), "the window starts at the first billed request")
	require.Equal(t, 0.1, row.UsedUSD)
	require.Equal(t, int64(1), row.RequestCount)

	add(itT0.Add(time.Hour), 0.2, session, weekly)
	add(itT0.Add(4*time.Hour+59*time.Minute), 0, session) // free requests still count
	row = itCounter(t, s, session, 11)
	require.True(t, row.WindowStart.Equal(itT0), "inside the window the start stays")
	require.Equal(t, 0.3, row.UsedUSD, "NUMERIC keeps 0.1 + 0.2 exact")
	require.Equal(t, int64(3), row.RequestCount)

	// At window_end exactly, the next request opens a new window.
	add(itT0.Add(5*time.Hour), 0.25, session, weekly)
	row = itCounter(t, s, session, 11)
	require.True(t, row.WindowStart.Equal(itT0.Add(5*time.Hour)))
	require.True(t, row.WindowEnd.Equal(itT0.Add(10*time.Hour)))
	require.Equal(t, 0.25, row.UsedUSD)
	require.Equal(t, int64(1), row.RequestCount)

	week := itCounter(t, s, weekly, 11)
	require.True(t, week.WindowEnd.Equal(itT0.Add(7*24*time.Hour)))
	require.Equal(t, 0.55, week.UsedUSD)
	require.Equal(t, int64(3), week.RequestCount)

	// A changed window length applies from the next window on.
	f := ruleFields{GroupID: iptr(int64(4)), Kind: KindSession, WindowSeconds: 3600, LimitUSD: 5, Enabled: true, ShowInClient: true}
	require.NoError(t, f.normalizeAndValidate())
	require.NoError(t, s.updateRule(ctx, session, f))
	add(itT0.Add(6*time.Hour), 1, session)
	row = itCounter(t, s, session, 11)
	require.True(t, row.WindowEnd.Equal(itT0.Add(10*time.Hour)), "the running window keeps its end")
	add(itT0.Add(11*time.Hour), 1, session)
	row = itCounter(t, s, session, 11)
	require.True(t, row.WindowEnd.Equal(itT0.Add(12*time.Hour)), "the next window is one hour")

	// A disabled or deleted rule is skipped, a missing user is a permanent error.
	f.Enabled = false
	require.NoError(t, s.updateRule(ctx, session, f))
	add(itT0.Add(11*time.Hour+time.Minute), 7, session)
	require.Equal(t, 1.0, itCounter(t, s, session, 11).UsedUSD)
	require.NoError(t, s.accumulate(ctx, usageAddition{UserID: 11, At: itT0, CostUSD: 1, RuleIDs: []int64{987654}}))
	err := s.accumulate(ctx, usageAddition{UserID: 999, At: itT0, CostUSD: 1, RuleIDs: []int64{weekly}})
	require.Error(t, err)
	require.True(t, isPermanent(err))
	var pqErr *pq.Error
	require.True(t, errors.As(err, &pqErr))
}

func TestIntegrationConcurrentAccumulationIsExact(t *testing.T) {
	db := NewIntegrationDB(t)
	s := itStore(db)
	session := itRule(t, s, ruleFields{GroupID: iptr(int64(4)), Kind: KindSession, LimitUSD: 5, Enabled: true})
	opus := itRule(t, s, ruleFields{GroupID: iptr(int64(4)), Kind: KindModels, Label: "Opus", ModelPatterns: []string{"claude-opus-*"}, WindowSeconds: 604800, LimitUSD: 20, Enabled: true})

	// 50 goroutines race on a counter row that does not exist yet.
	var wg sync.WaitGroup
	errs := make(chan error, 50)
	start := make(chan struct{})
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			errs <- s.accumulate(context.Background(), usageAddition{UserID: 11, At: itT0.Add(time.Duration(i) * time.Millisecond), CostUSD: 0.01, RuleIDs: []int64{session, opus}})
		}(i)
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		require.NoError(t, err)
	}
	for _, id := range []int64{session, opus} {
		row := itCounter(t, s, id, 11)
		require.Equal(t, 0.5, row.UsedUSD, "rule %d", id)
		require.Equal(t, int64(50), row.RequestCount, "rule %d", id)
	}

	// The same through the hook path, 50 billed requests in parallel.
	c := New(nil)
	c.store = s
	var wg2 sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg2.Add(1)
		go func() {
			defer wg2.Done()
			c.OnUsageApplied(context.Background(), claudexhook.UsageEvent{UserID: 12, GroupID: iptr(int64(4)), RequestedModel: "opus", BilledModel: "claude-opus-4-1", CostUSD: 0.02, At: itT0})
		}()
	}
	wg2.Wait()
	require.Equal(t, 0, c.Metrics().RetryQueue)
	require.Equal(t, 1.0, itCounter(t, s, session, 12).UsedUSD)
	require.Equal(t, int64(50), itCounter(t, s, opus, 12).RequestCount)
}

func TestIntegrationRuleStoreCountersAndReset(t *testing.T) {
	db := NewIntegrationDB(t)
	s := itStore(db)
	ctx := context.Background()
	admin := int64(13)
	f := ruleFields{GroupID: iptr(int64(4)), Kind: KindModels, Label: "Opus", ModelPatterns: []string{"claude-opus-*", "opus"}, WindowSeconds: 604800, LimitUSD: 20.5, Enabled: true, ShowInClient: true, SortOrder: 10}
	require.NoError(t, f.normalizeAndValidate())
	opus, err := s.createRule(ctx, f, &admin)
	require.NoError(t, err)
	global := itRule(t, s, ruleFields{Kind: KindAllModels, WindowSeconds: 604800, LimitUSD: 100, Enabled: true})
	other := itRule(t, s, ruleFields{GroupID: iptr(int64(9)), Kind: KindSession, LimitUSD: 1, Enabled: true})
	disabled := itRule(t, s, ruleFields{GroupID: iptr(int64(4)), Kind: KindSession, LimitUSD: 1})

	rule, err := s.getRule(ctx, opus)
	require.NoError(t, err)
	require.Equal(t, "claudex-pro", *rule.GroupName)
	require.False(t, rule.GroupDeleted)
	require.Equal(t, []string{"claude-opus-*", "opus"}, rule.ModelPatterns)
	require.Equal(t, 20.5, rule.LimitUSD)
	require.Equal(t, admin, *rule.CreatedBy)
	require.Equal(t, 10, rule.SortOrder)
	require.False(t, rule.CreatedAt.IsZero())
	_, err = s.getRule(ctx, 424242)
	require.ErrorIs(t, err, ErrRuleNotFound)

	all, err := s.listRules(ctx, nil)
	require.NoError(t, err)
	require.Len(t, all, 4)
	require.Nil(t, all[0].GroupID, "rules for every group first")
	g4, err := s.listRules(ctx, iptr(int64(4)))
	require.NoError(t, err)
	require.Len(t, g4, 2)

	enabled, err := s.enabledRules(ctx)
	require.NoError(t, err)
	ids := map[int64]bool{}
	for _, r := range enabled {
		ids[r.ID] = true
	}
	require.Equal(t, map[int64]bool{opus: true, global: true, other: true}, ids)

	// A soft-deleted group: its rules stop applying and are marked.
	_, err = db.ExecContext(ctx, `UPDATE groups SET deleted_at = NOW() WHERE id = 9`)
	require.NoError(t, err)
	enabled, err = s.enabledRules(ctx)
	require.NoError(t, err)
	require.Len(t, enabled, 2)
	rule, err = s.getRule(ctx, other)
	require.NoError(t, err)
	require.True(t, rule.GroupDeleted)
	require.Nil(t, rule.GroupName)
	ok, err := s.groupExists(ctx, 9)
	require.NoError(t, err)
	require.False(t, ok)
	ok, err = s.groupExists(ctx, 4)
	require.NoError(t, err)
	require.True(t, ok)

	// A group that does not exist at all.
	bad := f
	bad.GroupID = iptr(int64(777))
	_, err = s.createRule(ctx, bad, nil)
	require.ErrorIs(t, err, ErrGroupMissing)

	// Counters: the precheck read, the admin listing and reset.
	for i, user := range []int64{11, 12, 13} {
		require.NoError(t, s.accumulate(ctx, usageAddition{UserID: user, At: itT0.Add(time.Duration(i) * time.Minute), CostUSD: float64(i + 1), RuleIDs: []int64{opus, global}}))
	}
	rows, err := s.counters(ctx, 12, []int64{opus, global, other})
	require.NoError(t, err)
	require.Len(t, rows, 2)
	require.Equal(t, 2.0, rows[opus].UsedUSD)

	page, total, err := s.listCounters(ctx, opus, nil, 2, 0)
	require.NoError(t, err)
	require.Equal(t, int64(3), total)
	require.Len(t, page, 2)
	require.Equal(t, int64(13), page[0].UserID, "most recently updated first")
	require.Equal(t, "thirteen@example.com", *page[0].UserEmail)
	page, total, err = s.listCounters(ctx, opus, iptr(int64(11)), 20, 0)
	require.NoError(t, err)
	require.Equal(t, int64(1), total)
	require.Equal(t, 1.0, page[0].UsedUSD)

	require.NoError(t, s.resetCounter(ctx, opus, 11))
	rows, err = s.counters(ctx, 11, []int64{opus, global})
	require.NoError(t, err)
	require.NotContains(t, rows, opus)
	require.Contains(t, rows, global, "only that rule's counter")

	// Deleting a rule removes its counters.
	require.NoError(t, s.deleteRule(ctx, opus))
	require.ErrorIs(t, s.deleteRule(ctx, opus), ErrRuleNotFound)
	require.ErrorIs(t, s.updateRule(ctx, opus, f), ErrRuleNotFound)
	var left int
	require.NoError(t, db.QueryRowContext(ctx, `SELECT COUNT(*) FROM claudex_usage_counters WHERE rule_id = $1`, opus).Scan(&left))
	require.Zero(t, left)
	_ = disabled
}
