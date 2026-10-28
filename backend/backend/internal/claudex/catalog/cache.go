package catalog

import (
	"sync"
	"time"
)

// catalogCache keeps resolved catalogs per group for ttl. A write on this
// node clears it (other nodes catch up within ttl, like the settings cache).
// The generation counter keeps a read that started before a write from
// storing its stale result after the clear.
type catalogCache struct {
	mu      sync.Mutex
	now     func() time.Time
	ttl     time.Duration
	gen     uint64
	entries map[int64]cacheEntry
}

type cacheEntry struct {
	cat     *Catalog
	expires time.Time
}

func newCatalogCache(now func() time.Time, ttl time.Duration) *catalogCache {
	return &catalogCache{now: now, ttl: ttl, entries: map[int64]cacheEntry{}}
}

func (c *catalogCache) get(groupID int64) (*Catalog, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[groupID]
	if !ok || !c.now().Before(e.expires) {
		return nil, false
	}
	return e.cat, true
}

func (c *catalogCache) generation() uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.gen
}

// put stores cat unless the cache was cleared since gen was read.
func (c *catalogCache) put(groupID int64, cat *Catalog, gen uint64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if gen != c.gen {
		return
	}
	c.entries[groupID] = cacheEntry{cat: cat, expires: c.now().Add(c.ttl)}
}

// clear drops every entry (a global row changes every group's catalog).
func (c *catalogCache) clear() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.gen++
	c.entries = map[int64]cacheEntry{}
}
