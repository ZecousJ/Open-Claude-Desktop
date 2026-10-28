package core

import (
	"context"
	"log/slog"
	"strconv"
	"time"

	ratelimit "github.com/Wei-Shaw/sub2api/internal/middleware"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"

	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
)

// Allow counts one event in a Redis fixed window ("claudex:<key>") and reports
// whether it is within limit; retryAfter is the time left in the window when
// it is not. Without Redis, or on a Redis error, it allows (fail-open: rate
// limits protect the server, they must not take it down).
func Allow(ctx context.Context, rdb *redis.Client, key string, limit int, window time.Duration) (allowed bool, retryAfter time.Duration) {
	if rdb == nil || limit <= 0 || window <= 0 {
		return true, 0
	}
	res, err := ratelimit.NewRateLimiter(rdb).Allow(ctx, "claudex:"+key, limit, window)
	if err != nil {
		slog.Warn("claudex rate limit check failed, allowing", "key", key, "error", err)
		return true, 0
	}
	return res.Allowed, res.RetryAfter
}

// Allow is Allow with the environment's Redis client.
func (e *Env) Allow(ctx context.Context, key string, limit int, window time.Duration) (bool, time.Duration) {
	if e == nil {
		return true, 0
	}
	return Allow(ctx, e.Redis, key, limit, window)
}

// RateLimitPerUser limits a user route to limit requests per window per user
// (key names the route, e.g. "devices.register"). Over the limit it answers
// 429 CLAUDEX_RATE_LIMITED with Retry-After. Redis failures fail open.
func RateLimitPerUser(rdb *redis.Client, key string, limit int, window time.Duration) gin.HandlerFunc {
	return func(c *gin.Context) {
		userID, ok := Subject(c)
		if !ok {
			c.Next()
			return
		}
		allowed, retryAfter := Allow(c.Request.Context(), rdb, key+":user:"+strconv.FormatInt(userID, 10), limit, window)
		if !allowed {
			AbortRateLimited(c, retryAfter)
			return
		}
		c.Next()
	}
}

// RateLimitPerUser is RateLimitPerUser with the environment's Redis client.
func (e *Env) RateLimitPerUser(key string, limit int, window time.Duration) gin.HandlerFunc {
	var rdb *redis.Client
	if e != nil {
		rdb = e.Redis
	}
	return RateLimitPerUser(rdb, key, limit, window)
}

// AbortRateLimited answers 429 CLAUDEX_RATE_LIMITED with Retry-After (whole
// seconds, at least 1) and metadata retry_after_seconds.
func AbortRateLimited(c *gin.Context, retryAfter time.Duration) {
	seconds := int64((retryAfter + time.Second - 1) / time.Second)
	if seconds < 1 {
		seconds = 1
	}
	s := strconv.FormatInt(seconds, 10)
	c.Header("Retry-After", s)
	response.ErrorFrom(c, infraerrors.TooManyRequests("CLAUDEX_RATE_LIMITED", "Too many requests. Try again in "+s+" seconds.").
		WithMetadata(map[string]string{"retry_after_seconds": s}))
	c.Abort()
}
