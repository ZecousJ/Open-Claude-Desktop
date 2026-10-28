package webhost

import (
	"sync"
	"time"
)

// tokenCache keeps the newest access token of each user who called the
// relay: the runner gets it with every call (its Sub2API user calls run as
// the user) and Go's own calls on the user's behalf (the deadline
// interrupt, the snapshot of a resuming tab, key.get's revocation rule) use
// it too. Memory only; a token past its expiry is never used.
type tokenCache struct {
	mu sync.Mutex
	m  map[int64]userToken
}

type userToken struct {
	raw    string
	claims Claims
	ip     string
}

func newTokenCache() *tokenCache { return &tokenCache{m: map[int64]userToken{}} }

// put records a token unless a newer one (later iat) is already known.
func (c *tokenCache) put(userID int64, t userToken) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if cur, ok := c.m[userID]; ok && cur.claims.IssuedAt.After(t.claims.IssuedAt) {
		return
	}
	c.m[userID] = t
}

func (c *tokenCache) get(userID int64, now time.Time) (userToken, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	t, ok := c.m[userID]
	if !ok {
		return userToken{}, false
	}
	if !t.claims.ExpiresAt.IsZero() && !now.Before(t.claims.ExpiresAt) {
		delete(c.m, userID)
		return userToken{}, false
	}
	return t, true
}

func (c *tokenCache) forget(userID int64) {
	c.mu.Lock()
	delete(c.m, userID)
	c.mu.Unlock()
}

func (c *tokenCache) sweep(now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for id, t := range c.m {
		if !t.claims.ExpiresAt.IsZero() && !now.Before(t.claims.ExpiresAt) {
			delete(c.m, id)
		}
	}
}
