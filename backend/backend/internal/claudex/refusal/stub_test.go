package refusal

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/gatewayhook"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
)

func init() { gin.SetMode(gin.TestMode) }

// testNow is the fixed clock of the unit tests.
var testNow = time.Date(2026, 9, 26, 2, 30, 0, 0, time.UTC)

// clock is a settable clock for cache tests.
type clock struct {
	mu sync.Mutex
	t  time.Time
}

func newClock() *clock { return &clock{t: testNow} }

func (c *clock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *clock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

// stubSource is a source with canned answers that counts its calls.
type stubSource struct {
	mu    sync.Mutex
	calls map[string]int

	key         *service.APIKey
	keyErr      error
	rate        *service.APIKeyRateLimitData
	rateErr     error
	sub         *service.UserSubscription
	subErr      error
	progress    *service.SubscriptionProgress
	progressErr error
	subStatus   string
	subFound    bool
	subStateErr error
	revoked     bool
	deviceFound bool
	deviceErr   error
	settings    map[string]string
	settingsErr error

	delay   time.Duration // every call sleeps this long (concurrency tests)
	panicOn string        // the call that panics
}

// hit records a call; like a database driver it fails on a done context.
func (s *stubSource) hit(ctx context.Context, name string) error {
	s.mu.Lock()
	if s.calls == nil {
		s.calls = map[string]int{}
	}
	s.calls[name]++
	delay, panicOn := s.delay, s.panicOn
	s.mu.Unlock()
	if delay > 0 {
		time.Sleep(delay)
	}
	if panicOn == name {
		panic("stub " + name + " exploded")
	}
	return ctx.Err()
}

func (s *stubSource) count(name string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls[name]
}

func (s *stubSource) APIKey(ctx context.Context, _ int64) (*service.APIKey, error) {
	if err := s.hit(ctx, "APIKey"); err != nil {
		return nil, err
	}
	if s.keyErr != nil {
		return nil, s.keyErr
	}
	if s.key == nil {
		return nil, service.ErrAPIKeyNotFound
	}
	k := *s.key
	return &k, nil
}

func (s *stubSource) RateLimitData(ctx context.Context, _ int64) (*service.APIKeyRateLimitData, error) {
	if err := s.hit(ctx, "RateLimitData"); err != nil {
		return nil, err
	}
	if s.rateErr != nil {
		return nil, s.rateErr
	}
	if s.rate == nil {
		return &service.APIKeyRateLimitData{}, nil
	}
	r := *s.rate
	return &r, nil
}

func (s *stubSource) ActiveSubscription(ctx context.Context, _, _ int64) (*service.UserSubscription, error) {
	if err := s.hit(ctx, "ActiveSubscription"); err != nil {
		return nil, err
	}
	if s.subErr != nil {
		return nil, s.subErr
	}
	if s.sub == nil {
		return nil, service.ErrSubscriptionNotFound
	}
	return s.sub, nil
}

func (s *stubSource) SubscriptionProgress(ctx context.Context, _ int64) (*service.SubscriptionProgress, error) {
	if err := s.hit(ctx, "SubscriptionProgress"); err != nil {
		return nil, err
	}
	if s.progressErr != nil {
		return nil, s.progressErr
	}
	if s.progress == nil {
		return nil, service.ErrSubscriptionNotFound
	}
	return s.progress, nil
}

func (s *stubSource) SubscriptionStatus(ctx context.Context, _, _ int64) (string, bool, error) {
	if err := s.hit(ctx, "SubscriptionStatus"); err != nil {
		return "", false, err
	}
	return s.subStatus, s.subFound, s.subStateErr
}

func (s *stubSource) DeviceRevoked(ctx context.Context, _ int64) (bool, bool, error) {
	if err := s.hit(ctx, "DeviceRevoked"); err != nil {
		return false, false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.revoked, s.deviceFound, s.deviceErr
}

func (s *stubSource) setRevoked(revoked bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.revoked, s.deviceFound = revoked, true
}

func (s *stubSource) Settings(ctx context.Context, _ []string) (map[string]string, error) {
	if err := s.hit(ctx, "Settings"); err != nil {
		return nil, err
	}
	if s.settingsErr != nil {
		return nil, s.settingsErr
	}
	return s.settings, nil
}

var errStubDB = errors.New("stub: database is down")

// Test identities: device 51 of user 7 uses key 812 in group 4.
const (
	testUserID   int64 = 7
	testAPIKeyID int64 = 812
	testGroupID  int64 = 4
)

func int64p(v int64) *int64 { return &v }

func f64p(v float64) *float64 { return &v }

func timep(t time.Time) *time.Time { return &t }

// describeCtx builds the gin context EnrichRefusals hands to a describer: a
// marked device, the key the gateway loaded, and the response headers written
// so far.
func describeCtx(headers map[string]string) *gin.Context {
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/responses", nil)
	gatewayhook.MarkDevice(c, &gatewayhook.DeviceRef{ID: 51, UserID: testUserID, APIKeyID: testAPIKeyID, GroupID: int64p(testGroupID)})
	middleware.SetOpsFallbackAPIKey(c, &service.APIKey{ID: testAPIKeyID, UserID: testUserID, GroupID: int64p(testGroupID)})
	for k, v := range headers {
		c.Writer.Header().Set(k, v)
	}
	return c
}

func testRefusal(status int, code, message string) gatewayhook.Refusal {
	return gatewayhook.Refusal{Status: status, Code: code, Message: message,
		APIKeyID: testAPIKeyID, UserID: testUserID, GroupID: int64p(testGroupID)}
}
