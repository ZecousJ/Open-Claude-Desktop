package usage

import (
	"context"
	"log/slog"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/sync/singleflight"
)

const (
	ruleCacheTTL      = 60 * time.Second
	ruleCacheErrorTTL = 5 * time.Second
	ruleLoadTimeout   = 3 * time.Second
)

// ruleSet is one snapshot of the enabled rules, indexed by group. The lists
// are built once per load and shared: callers must not modify them.
type ruleSet struct {
	global  []*activeRule
	byGroup map[int64][]*activeRule // the group's rules merged with global
	count   int
}

func newRuleSet(rules []activeRule) *ruleSet {
	rs := &ruleSet{byGroup: map[int64][]*activeRule{}}
	own := map[int64][]*activeRule{}
	for _, r := range rules {
		cr := compileRule(r)
		if cr.GroupID == nil {
			rs.global = append(rs.global, cr)
		} else {
			own[*cr.GroupID] = append(own[*cr.GroupID], cr)
		}
		rs.count++
	}
	sortRules(rs.global)
	for gid, list := range own {
		merged := make([]*activeRule, 0, len(list)+len(rs.global))
		merged = append(merged, rs.global...)
		merged = append(merged, list...)
		sortRules(merged)
		rs.byGroup[gid] = merged
	}
	return rs
}

// sortRules orders rules the way usage-status lists them: session, all
// models, per model; then sort_order and id.
func sortRules(list []*activeRule) {
	sort.SliceStable(list, func(i, j int) bool {
		if a, b := kindRank(list[i].Kind), kindRank(list[j].Kind); a != b {
			return a < b
		}
		if list[i].SortOrder != list[j].SortOrder {
			return list[i].SortOrder < list[j].SortOrder
		}
		return list[i].ID < list[j].ID
	})
}

// forGroup returns the rules of a request made with a key of this group: the
// group's own rules plus the rules for every group (shared, read-only).
func (rs *ruleSet) forGroup(groupID *int64) []*activeRule {
	if rs == nil || rs.count == 0 {
		return nil
	}
	if groupID != nil {
		if merged, ok := rs.byGroup[*groupID]; ok {
			return merged
		}
	}
	return rs.global
}

type ruleCacheEntry struct {
	set       *ruleSet
	expiresAt time.Time
	err       error
}

// ruleCache serves the enabled rules from memory for 60 s (design 1.10: rule
// lists are cached, counters never are). A write on this node invalidates it
// at once; other nodes see a change within 60 s. When loading fails, the last
// good snapshot is kept for 5 s before the next attempt; without one, the
// error is returned (the caller fails open, see guard.go).
type ruleCache struct {
	load func(ctx context.Context) ([]activeRule, error)
	now  func() time.Time

	entry atomic.Pointer[ruleCacheEntry]
	gen   atomic.Uint64
	sf    singleflight.Group
	mu    sync.Mutex
}

func (rc *ruleCache) get(ctx context.Context) (*ruleSet, error) {
	now := rc.now()
	if e := rc.entry.Load(); e != nil && now.Before(e.expiresAt) {
		return e.set, e.err
	}
	v, err, _ := rc.sf.Do("rules", func() (any, error) {
		if e := rc.entry.Load(); e != nil && rc.now().Before(e.expiresAt) {
			return e, nil
		}
		gen := rc.gen.Load()
		loadCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), ruleLoadTimeout)
		defer cancel()
		rules, err := rc.load(loadCtx)
		next := &ruleCacheEntry{}
		if err != nil {
			slog.Warn("claudex usage: loading rules failed", "error", err)
			next.expiresAt = rc.now().Add(ruleCacheErrorTTL)
			if prev := rc.entry.Load(); prev != nil && prev.set != nil {
				next.set = prev.set // keep serving the last good rules
			} else {
				next.err = err
			}
		} else {
			next.set = newRuleSet(rules)
			next.expiresAt = rc.now().Add(ruleCacheTTL)
		}
		// Do not publish a snapshot loaded before an invalidation.
		rc.mu.Lock()
		if rc.gen.Load() == gen {
			rc.entry.Store(next)
		}
		rc.mu.Unlock()
		return next, nil
	})
	if err != nil {
		return nil, err
	}
	e, ok := v.(*ruleCacheEntry)
	if !ok || e == nil {
		return nil, errNoDB
	}
	return e.set, e.err
}

// invalidate drops the snapshot (after an administrator changed a rule).
func (rc *ruleCache) invalidate() {
	rc.mu.Lock()
	rc.gen.Add(1)
	rc.entry.Store(nil)
	rc.mu.Unlock()
	rc.sf.Forget("rules")
}
