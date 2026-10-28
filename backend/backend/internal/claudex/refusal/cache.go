package refusal

import (
	"context"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"
)

// factCache keeps the supplementary data of refusals for a short time so that a
// burst of refused requests (a client retrying against a full window) costs at
// most one lookup per key and data kind every ttl. Concurrent misses of the
// same entry share one lookup (singleflight). Failed lookups are cached too:
// a database outage must not turn every refusal into a query.
type factCache struct {
	ttl time.Duration
	max int
	now func() time.Time

	mu      sync.Mutex
	entries map[string]cachedFact
	flight  singleflight.Group
}

type cachedFact struct {
	value   any
	expires time.Time
}

func newFactCache(ttl time.Duration, maxEntries int, now func() time.Time) *factCache {
	return &factCache{ttl: ttl, max: maxEntries, now: now, entries: map[string]cachedFact{}}
}

// cached returns the value stored under key, loading it with load on a miss.
// load gets a context detached from the caller's cancellation (with its own
// timeout) because its result is shared with other requests.
func cached[T any](ctx context.Context, fc *factCache, key string, load func(context.Context) T) T {
	if v, ok := fc.lookup(key); ok {
		if t, ok := v.(T); ok {
			return t
		}
	}
	v, _, _ := fc.flight.Do(key, func() (any, error) {
		if v, ok := fc.lookup(key); ok {
			return v, nil
		}
		loadCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), lookupTimeout)
		defer cancel()
		value := load(loadCtx)
		fc.store(key, value)
		return value, nil
	})
	t, _ := v.(T)
	return t
}

func (fc *factCache) lookup(key string) (any, bool) {
	fc.mu.Lock()
	defer fc.mu.Unlock()
	e, ok := fc.entries[key]
	if !ok {
		return nil, false
	}
	if !fc.now().Before(e.expires) {
		delete(fc.entries, key)
		return nil, false
	}
	return e.value, true
}

func (fc *factCache) store(key string, value any) {
	fc.mu.Lock()
	defer fc.mu.Unlock()
	now := fc.now()
	if len(fc.entries) >= fc.max {
		for k, e := range fc.entries {
			if !now.Before(e.expires) {
				delete(fc.entries, k)
			}
		}
		// Still full: every entry is fresh, drop them all rather than grow
		// without bound (the cache only saves lookups, it is never needed).
		if len(fc.entries) >= fc.max {
			fc.entries = map[string]cachedFact{}
		}
	}
	fc.entries[key] = cachedFact{value: value, expires: now.Add(fc.ttl)}
}

// size reports the number of stored entries (tests).
func (fc *factCache) size() int {
	fc.mu.Lock()
	defer fc.mu.Unlock()
	return len(fc.entries)
}
