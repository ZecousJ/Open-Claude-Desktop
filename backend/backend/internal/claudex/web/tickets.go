package web

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"

	"github.com/redis/go-redis/v9"
)

// ErrBadTicket is returned by RedeemTicket for an unknown, used, expired or
// foreign ticket.
var ErrBadTicket = infraerrors.Unauthorized(webproto.ErrCodeBadTicket, "The events ticket is not valid. Request a new one.")

const ticketKeyPrefix = "claudex:web:ticket:"

// ticketStore keeps one-time events tickets. Only the SHA-256 of a ticket is
// stored; the value is "<user id>:<tab id>".
type ticketStore interface {
	put(ctx context.Context, hash, value string, ttl time.Duration) error
	take(ctx context.Context, hash string) (string, bool, error)
}

func newTicketStore(env *core.Env) ticketStore {
	if env != nil && env.Redis != nil {
		return &redisTickets{rdb: env.Redis}
	}
	return &memoryTickets{items: map[string]memoryTicket{}, now: time.Now}
}

type redisTickets struct{ rdb *redis.Client }

func (r *redisTickets) put(ctx context.Context, hash, value string, ttl time.Duration) error {
	return r.rdb.Set(ctx, ticketKeyPrefix+hash, value, ttl).Err()
}

func (r *redisTickets) take(ctx context.Context, hash string) (string, bool, error) {
	v, err := r.rdb.GetDel(ctx, ticketKeyPrefix+hash).Result()
	if errors.Is(err, redis.Nil) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return v, true, nil
}

// memoryTickets is the single-node fallback without Redis (tests, dev).
type memoryTickets struct {
	mu    sync.Mutex
	items map[string]memoryTicket
	now   func() time.Time
}

type memoryTicket struct {
	value   string
	expires time.Time
}

const maxMemoryTickets = 10000

func (m *memoryTickets) put(_ context.Context, hash, value string, ttl time.Duration) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := m.now()
	if len(m.items) >= maxMemoryTickets {
		for k, t := range m.items {
			if !now.Before(t.expires) {
				delete(m.items, k)
			}
		}
		if len(m.items) >= maxMemoryTickets {
			return errors.New("claudex web: too many pending tickets")
		}
	}
	m.items[hash] = memoryTicket{value: value, expires: now.Add(ttl)}
	return nil
}

func (m *memoryTickets) take(_ context.Context, hash string) (string, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	t, ok := m.items[hash]
	if !ok {
		return "", false, nil
	}
	delete(m.items, hash)
	if !m.now().Before(t.expires) {
		return "", false, nil
	}
	return t.value, true, nil
}

func hashTicket(ticket string) string {
	sum := sha256.Sum256([]byte(ticket))
	return hex.EncodeToString(sum[:])
}

// issueTicket creates a ticket for the user's tab.
func (c *Component) issueTicket(ctx context.Context, userID int64, tabID string) (string, error) {
	ticket, err := webproto.NewTicket()
	if err != nil {
		return "", err
	}
	if err := c.tickets.put(ctx, hashTicket(ticket), strconv.FormatInt(userID, 10)+":"+tabID, webproto.TicketTTL); err != nil {
		return "", err
	}
	return ticket, nil
}

// RedeemTicket consumes an events ticket (the events endpoint, W-RELAY) and
// returns its user. The ticket works once, within webproto.TicketTTL, and
// only for the tab it was issued to.
func (c *Component) RedeemTicket(ctx context.Context, ticket, tabID string) (int64, error) {
	if !webproto.ValidTicket(ticket) || !webproto.ValidTabID(tabID) {
		return 0, ErrBadTicket
	}
	v, ok, err := c.tickets.take(ctx, hashTicket(ticket))
	if err != nil {
		return 0, infraerrors.ServiceUnavailable("CLAUDEX_WEB_TICKET_UNAVAILABLE", "Service temporarily unavailable. Try again.")
	}
	if !ok {
		return 0, ErrBadTicket
	}
	uidText, tab, found := strings.Cut(v, ":")
	if !found || subtle.ConstantTimeCompare([]byte(tab), []byte(tabID)) != 1 {
		return 0, ErrBadTicket
	}
	uid, err := strconv.ParseInt(uidText, 10, 64)
	if err != nil || uid <= 0 {
		return 0, ErrBadTicket
	}
	return uid, nil
}
