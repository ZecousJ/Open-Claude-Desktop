//go:build unit

package usage

import (
	"context"
	"errors"
	"sort"
	"sync"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
)

// fakeStore is an in-memory store that counts queries.
type fakeStore struct {
	mu            sync.Mutex
	rules         []Rule
	nextID        int64
	counterRows   map[[2]int64]counterRow // (rule, user)
	groups        map[int64]bool
	loadCalls     int
	counterCalls  int
	loadErr       error
	counterErr    error
	accumulateErr []error // consumed one per call; nil entries succeed
	accumulations int     // accumulate calls, failed ones included
	additions     []usageAddition
}

func newFakeStore() *fakeStore {
	return &fakeStore{counterRows: map[[2]int64]counterRow{}, groups: map[int64]bool{}, nextID: 1}
}

func (f *fakeStore) addRule(r Rule) int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.ID == 0 {
		r.ID = f.nextID
	}
	if r.ID >= f.nextID {
		f.nextID = r.ID + 1
	}
	if r.ModelPatterns == nil {
		r.ModelPatterns = []string{"*"}
	}
	f.rules = append(f.rules, r)
	return r.ID
}

func (f *fakeStore) setCounter(ruleID, userID int64, start, end time.Time, used float64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.counterRows[[2]int64{ruleID, userID}] = counterRow{RuleID: ruleID, UserID: userID, WindowStart: start, WindowEnd: end, UsedUSD: used, RequestCount: 1, UpdatedAt: start}
}

func (f *fakeStore) calls() (loads, counters int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.loadCalls, f.counterCalls
}

func (f *fakeStore) enabledRules(context.Context) ([]activeRule, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.loadCalls++
	if f.loadErr != nil {
		return nil, f.loadErr
	}
	var out []activeRule
	for _, r := range f.rules {
		if !r.Enabled || r.GroupDeleted {
			continue
		}
		out = append(out, activeRule{ID: r.ID, GroupID: r.GroupID, Kind: r.Kind, Label: r.Label, Patterns: r.ModelPatterns,
			WindowSeconds: r.WindowSeconds, LimitUSD: r.LimitUSD, ShowInClient: r.ShowInClient, SortOrder: r.SortOrder})
	}
	return out, nil
}

func (f *fakeStore) counters(_ context.Context, userID int64, ruleIDs []int64) (map[int64]counterRow, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.counterCalls++
	if f.counterErr != nil {
		return nil, f.counterErr
	}
	out := map[int64]counterRow{}
	for _, id := range ruleIDs {
		if row, ok := f.counterRows[[2]int64{id, userID}]; ok {
			out[id] = row
		}
	}
	return out, nil
}

func (f *fakeStore) accumulate(_ context.Context, add usageAddition) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.accumulations++
	if len(f.accumulateErr) > 0 {
		err := f.accumulateErr[0]
		f.accumulateErr = f.accumulateErr[1:]
		if err != nil {
			return err
		}
	}
	f.additions = append(f.additions, add)
	for _, id := range add.RuleIDs {
		var window int
		for _, r := range f.rules {
			if r.ID == id {
				window = r.WindowSeconds
			}
		}
		key := [2]int64{id, add.UserID}
		row, ok := f.counterRows[key]
		if !ok || !row.WindowEnd.After(add.At) {
			row = counterRow{RuleID: id, UserID: add.UserID, WindowStart: add.At, WindowEnd: add.At.Add(time.Duration(window) * time.Second)}
		}
		row.UsedUSD += add.CostUSD
		row.RequestCount++
		row.UpdatedAt = add.At
		f.counterRows[key] = row
	}
	return nil
}

func (f *fakeStore) listRules(_ context.Context, groupID *int64) ([]Rule, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := []Rule{}
	for _, r := range f.rules {
		if groupID != nil && (r.GroupID == nil || *r.GroupID != *groupID) {
			continue
		}
		out = append(out, r)
	}
	return out, nil
}

func (f *fakeStore) getRule(_ context.Context, id int64) (*Rule, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, r := range f.rules {
		if r.ID == id {
			copied := r
			return &copied, nil
		}
	}
	return nil, ErrRuleNotFound
}

func (f *fakeStore) createRule(_ context.Context, fl ruleFields, createdBy *int64) (int64, error) {
	now := time.Date(2026, 9, 26, 0, 0, 0, 0, time.UTC)
	id := f.addRule(Rule{GroupID: fl.GroupID, Kind: fl.Kind, Label: fl.Label, ModelPatterns: fl.ModelPatterns,
		WindowSeconds: fl.WindowSeconds, LimitUSD: fl.LimitUSD, Enabled: fl.Enabled, ShowInClient: fl.ShowInClient,
		SortOrder: fl.SortOrder, CreatedBy: createdBy, CreatedAt: now, UpdatedAt: now})
	return id, nil
}

func (f *fakeStore) updateRule(_ context.Context, id int64, fl ruleFields) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i, r := range f.rules {
		if r.ID == id {
			r.GroupID, r.Kind, r.Label, r.ModelPatterns = fl.GroupID, fl.Kind, fl.Label, fl.ModelPatterns
			r.WindowSeconds, r.LimitUSD, r.Enabled, r.ShowInClient, r.SortOrder = fl.WindowSeconds, fl.LimitUSD, fl.Enabled, fl.ShowInClient, fl.SortOrder
			f.rules[i] = r
			return nil
		}
	}
	return ErrRuleNotFound
}

func (f *fakeStore) deleteRule(_ context.Context, id int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i, r := range f.rules {
		if r.ID == id {
			f.rules = append(f.rules[:i], f.rules[i+1:]...)
			for k := range f.counterRows {
				if k[0] == id {
					delete(f.counterRows, k)
				}
			}
			return nil
		}
	}
	return ErrRuleNotFound
}

func (f *fakeStore) listCounters(_ context.Context, ruleID int64, userID *int64, limit, offset int) ([]counterRow, int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var all []counterRow
	for k, row := range f.counterRows {
		if k[0] != ruleID || (userID != nil && k[1] != *userID) {
			continue
		}
		all = append(all, row)
	}
	sort.Slice(all, func(i, j int) bool { return all[i].UserID < all[j].UserID })
	total := int64(len(all))
	if offset >= len(all) {
		return []counterRow{}, total, nil
	}
	all = all[offset:]
	if len(all) > limit {
		all = all[:limit]
	}
	return all, total, nil
}

func (f *fakeStore) resetCounter(_ context.Context, ruleID, userID int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.counterRows, [2]int64{ruleID, userID})
	return nil
}

func (f *fakeStore) groupExists(_ context.Context, id int64) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.groups[id], nil
}

// testClock is a settable clock.
type testClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *testClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *testClock) Set(t time.Time) {
	c.mu.Lock()
	c.t = t
	c.mu.Unlock()
}

func (c *testClock) Add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

// newTestComponent builds the component on a fake store and a fixed clock.
func newTestComponent(fs *fakeStore, now time.Time) (*Component, *testClock) {
	clock := &testClock{t: now}
	env := &core.Env{Now: clock.Now}
	c := New(env)
	c.store = fs
	c.mapChannel = nil
	return c, clock
}

func ptr[T any](v T) *T { return &v }

var errTestDB = errors.New("database is down")
