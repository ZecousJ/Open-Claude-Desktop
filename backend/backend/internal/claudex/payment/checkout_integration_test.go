//go:build integration

package payment

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	dbent "github.com/Wei-Shaw/sub2api/ent"
	"github.com/Wei-Shaw/sub2api/internal/claudex/core"

	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
	tcredis "github.com/testcontainers/testcontainers-go/modules/redis"
)

func startCheckoutRedis(t *testing.T) *redis.Client {
	t.Helper()
	ctx := context.Background()
	container, err := tcredis.Run(ctx, "redis:8.4-alpine")
	require.NoError(t, err)
	t.Cleanup(func() { _ = container.Terminate(ctx) })
	host, err := container.Host(ctx)
	require.NoError(t, err)
	port, err := container.MappedPort(ctx, "6379/tcp")
	require.NoError(t, err)
	rdb := redis.NewClient(&redis.Options{Addr: fmt.Sprintf("%s:%d", host, port.Int())})
	t.Cleanup(func() { _ = rdb.Close() })
	require.NoError(t, rdb.Ping(ctx).Err())
	return rdb
}

// TestCheckoutTokensInRealRedis checks the token lifetime against a real Redis:
// the key expires with the order (or after 30 minutes), a token is never
// stored under its own name, and an expired token answers 404.
func TestCheckoutTokensInRealRedis(t *testing.T) {
	ctx := context.Background()
	rdb := startCheckoutRedis(t)

	shortOrder := stripeOrder()
	longOrder := stripeOrder()
	longOrder.ID = 4096
	orders := &fakeOrders{orders: map[string]*dbent.PaymentOrder{"resume-short": shortOrder, "resume-long": longOrder}}
	c := New(&core.Env{Deps: core.Deps{Redis: rdb}, Now: time.Now})
	c.orders = orders
	c.configs = &fakeConfig{key: publishableKey}

	now := time.Now()
	shortOrder.ExpiresAt = now.Add(3 * time.Second)
	longOrder.ExpiresAt = now.Add(2 * time.Hour)

	short, err := c.link(ctx, ownerID, LinkRequest{OrderID: shortOrder.ID, ResumeToken: "resume-short", ClientSecret: stripeSecret})
	require.NoError(t, err)
	long, err := c.link(ctx, ownerID, LinkRequest{OrderID: longOrder.ID, ResumeToken: "resume-long", ClientSecret: stripeSecret})
	require.NoError(t, err)

	ttl, err := rdb.PTTL(ctx, storeKey(short.Token)).Result()
	require.NoError(t, err)
	require.Positive(t, ttl)
	require.LessOrEqual(t, ttl, 3*time.Second, "never past the order expiry")
	require.False(t, short.ExpiresAt.After(shortOrder.ExpiresAt))

	ttl, err = rdb.PTTL(ctx, storeKey(long.Token)).Result()
	require.NoError(t, err)
	require.Greater(t, ttl, maxLinkTTL-5*time.Second)
	require.LessOrEqual(t, ttl, maxLinkTTL)

	keys, err := rdb.Keys(ctx, storeKeyPrefix+"*").Result()
	require.NoError(t, err)
	require.Len(t, keys, 2)
	for _, k := range keys {
		require.NotContains(t, k, short.Token)
		require.NotContains(t, k, long.Token)
	}

	view, err := c.checkout(ctx, short.Token)
	require.NoError(t, err)
	require.NotNil(t, view.Stripe)
	require.Equal(t, stripeSecret, view.Stripe.ClientSecret)

	time.Sleep(time.Until(short.ExpiresAt) + 1500*time.Millisecond)
	_, err = c.checkout(ctx, short.Token)
	requireReason(t, err, 404, "CLAUDEX_CHECKOUT_NOT_FOUND")
	exists, err := rdb.Exists(ctx, storeKey(short.Token)).Result()
	require.NoError(t, err)
	require.Zero(t, exists)

	// The long-lived token still works, and a tampered copy does not.
	_, err = c.checkout(ctx, long.Token)
	require.NoError(t, err)
	tampered := strings.ToUpper(long.Token[:1]) + long.Token[1:]
	if tampered == long.Token {
		tampered = strings.ToLower(long.Token[:1]) + long.Token[1:]
	}
	if tampered != long.Token {
		_, err = c.checkout(ctx, tampered)
		requireReason(t, err, 404, "CLAUDEX_CHECKOUT_NOT_FOUND")
	}
}
