package devices

import (
	"sync"
	"time"
)

// Cache timings (design 1.10): device lookups and session revocation states
// are served from a per-process cache for 5 s; this node's writes invalidate
// the affected entries at once, other nodes see them within 5 s. When the
// database fails, an entry up to staleTTL old is served instead of failing.
const (
	freshTTL        = 5 * time.Second
	staleTTL        = 2 * time.Minute
	lookupCacheMax  = 50000
	sessionCacheMax = 50000
)

type cacheEntry[V any] struct {
	value V
	at    time.Time
}

// ttlCache is a small mutex-guarded map with a size bound. Entries carry the
// time they were stored; callers decide what is fresh or stale.
type ttlCache[K comparable, V any] struct {
	mu      sync.Mutex
	entries map[K]cacheEntry[V]
	limit   int
}

func newTTLCache[K comparable, V any](limit int) *ttlCache[K, V] {
	return &ttlCache[K, V]{entries: map[K]cacheEntry[V]{}, limit: limit}
}

// get returns the value and its age.
func (c *ttlCache[K, V]) get(k K, now time.Time) (V, time.Duration, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[k]
	if !ok {
		var zero V
		return zero, 0, false
	}
	return e.value, now.Sub(e.at), true
}

func (c *ttlCache[K, V]) put(k K, v V, now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.entries) >= c.limit {
		for key, e := range c.entries {
			if now.Sub(e.at) > staleTTL {
				delete(c.entries, key)
			}
		}
		if len(c.entries) >= c.limit {
			c.entries = map[K]cacheEntry[V]{}
		}
	}
	c.entries[k] = cacheEntry[V]{value: v, at: now}
}

func (c *ttlCache[K, V]) del(k K) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.entries, k)
}

func (c *ttlCache[K, V]) delWhere(match func(K) bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for k := range c.entries {
		if match(k) {
			delete(c.entries, k)
		}
	}
}
