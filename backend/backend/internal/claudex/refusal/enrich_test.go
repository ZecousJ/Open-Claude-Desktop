package refusal

// End-to-end checks of the B6 acceptance criteria: the real upstream API key
// middleware (with the real APIKeyService and SubscriptionService over fake
// repositories) behind gatewayhook.EnrichRefusals, with this component built
// by New(env) and registered as the describer, like ProvideModule does.

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/gatewayhook"
	"github.com/Wei-Shaw/sub2api/internal/config"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/DATA-DOG/go-sqlmock"
	coderws "github.com/coder/websocket"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// fakeKeyRepo serves the API keys of the gateway fixture. The embedded
// interface is nil: a call the fixture does not expect panics.
type fakeKeyRepo struct {
	service.APIKeyRepository
	mu    sync.Mutex
	byKey map[string]*service.APIKey
	rate  map[int64]*service.APIKeyRateLimitData
}

func (r *fakeKeyRepo) find(match func(*service.APIKey) bool) (*service.APIKey, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, k := range r.byKey {
		if match(k) {
			cp := *k
			if k.User != nil {
				u := *k.User
				cp.User = &u
			}
			if k.Group != nil {
				g := *k.Group
				cp.Group = &g
			}
			return &cp, nil
		}
	}
	return nil, service.ErrAPIKeyNotFound
}

func (r *fakeKeyRepo) GetByKeyForAuth(_ context.Context, key string) (*service.APIKey, error) {
	return r.find(func(k *service.APIKey) bool { return k.Key == key })
}

func (r *fakeKeyRepo) GetByKey(ctx context.Context, key string) (*service.APIKey, error) {
	return r.GetByKeyForAuth(ctx, key)
}

func (r *fakeKeyRepo) GetByID(_ context.Context, id int64) (*service.APIKey, error) {
	return r.find(func(k *service.APIKey) bool { return k.ID == id })
}

func (r *fakeKeyRepo) GetRateLimitData(_ context.Context, id int64) (*service.APIKeyRateLimitData, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if d, ok := r.rate[id]; ok {
		cp := *d
		return &cp, nil
	}
	return &service.APIKeyRateLimitData{}, nil
}

func (r *fakeKeyRepo) UpdateLastUsed(context.Context, int64, time.Time) error { return nil }

// fakeSubRepo serves one subscription.
type fakeSubRepo struct {
	service.UserSubscriptionRepository
	sub *service.UserSubscription
}

func (r *fakeSubRepo) GetActiveByUserIDAndGroupID(_ context.Context, userID, groupID int64) (*service.UserSubscription, error) {
	if r.sub == nil || r.sub.UserID != userID || r.sub.GroupID != groupID {
		return nil, service.ErrSubscriptionNotFound
	}
	cp := *r.sub
	return &cp, nil
}

func (r *fakeSubRepo) GetByID(_ context.Context, id int64) (*service.UserSubscription, error) {
	if r.sub == nil || r.sub.ID != id {
		return nil, service.ErrSubscriptionNotFound
	}
	cp := *r.sub
	return &cp, nil
}

type fakeSettingRepo struct {
	service.SettingRepository
	values map[string]string
}

func (r *fakeSettingRepo) GetMultiple(_ context.Context, keys []string) (map[string]string, error) {
	out := map[string]string{}
	for _, k := range keys {
		if v, ok := r.values[k]; ok {
			out[k] = v
		}
	}
	return out, nil
}

// deviceMarker is B4's KeyMarker in miniature: keys listed here are device keys.
type deviceMarker map[int64]gatewayhook.DeviceRef

func (m deviceMarker) OnKeyResolved(c *gin.Context, k *service.APIKey) {
	if d, ok := m[k.ID]; ok {
		gatewayhook.MarkDevice(c, &d)
	}
}

// The fixture: user 7 (balance 12) and user 8 (balance 0).
const (
	fxUser        int64 = 7
	fxBrokeUser   int64 = 8
	fxSubGroup    int64 = 4 // subscription group, weekly limit 100
	fxStdGroup    int64 = 3 // standard (balance) group
	fxSubID       int64 = 77
	fxWeeklyLimit       = 100.0
)

type fixture struct {
	keys    *fakeKeyRepo
	sub     *service.UserSubscription
	mock    sqlmock.Sqlmock
	enrich  *gin.Engine // /v1 with EnrichRefusals, like the fork
	plain   *gin.Engine // the same chain without it (upstream baseline)
	devices deviceMarker
}

func weeklyLimit() *float64 { v := fxWeeklyLimit; return &v }

func newFixture(t *testing.T) *fixture {
	t.Helper()
	gatewayhook.Reset()
	t.Cleanup(gatewayhook.Reset)

	now := time.Now()
	subGroup := &service.Group{ID: fxSubGroup, Name: "claudex-pro", Platform: "openai", Status: service.StatusActive,
		SubscriptionType: service.SubscriptionTypeSubscription, WeeklyLimitUSD: weeklyLimit(), RateMultiplier: 1}
	stdGroup := &service.Group{ID: fxStdGroup, Name: "claudex-std", Platform: "openai", Status: service.StatusActive,
		SubscriptionType: service.SubscriptionTypeStandard, RateMultiplier: 1}
	user := func(id int64, balance float64) *service.User {
		return &service.User{ID: id, Status: service.StatusActive, Balance: balance, Concurrency: 5, Role: "user"}
	}
	key := func(id int64, raw string, u *service.User, g *service.Group, mod func(*service.APIKey)) *service.APIKey {
		k := &service.APIKey{ID: id, UserID: u.ID, Key: raw, Name: raw, Status: service.StatusActive, User: u, Group: g}
		gid := g.ID
		k.GroupID = &gid
		if mod != nil {
			mod(k)
		}
		return k
	}
	windowStart := now.Add(-time.Hour)
	keys := &fakeKeyRepo{byKey: map[string]*service.APIKey{}, rate: map[int64]*service.APIKeyRateLimitData{}}
	for _, k := range []*service.APIKey{
		// Each case has a device key (even id) and the user's own key (odd id).
		key(100, "sk-sub-device", user(fxUser, 12), subGroup, nil),
		key(101, "sk-sub-own", user(fxUser, 12), subGroup, nil),
		key(110, "sk-quota-device", user(fxUser, 12), stdGroup, func(k *service.APIKey) {
			k.Status, k.Quota, k.QuotaUsed = service.StatusAPIKeyQuotaExhausted, 50, 50
		}),
		key(111, "sk-quota-own", user(fxUser, 12), stdGroup, func(k *service.APIKey) {
			k.Status, k.Quota, k.QuotaUsed = service.StatusAPIKeyQuotaExhausted, 50, 50
		}),
		key(120, "sk-disabled-device", user(fxUser, 12), stdGroup, func(k *service.APIKey) { k.Status = service.StatusAPIKeyDisabled }),
		key(121, "sk-disabled-own", user(fxUser, 12), stdGroup, func(k *service.APIKey) { k.Status = service.StatusAPIKeyDisabled }),
		key(122, "sk-revoked-device", user(fxUser, 12), stdGroup, func(k *service.APIKey) { k.Status = service.StatusAPIKeyDisabled }),
		key(130, "sk-broke-device", user(fxBrokeUser, 0), stdGroup, nil),
		key(131, "sk-broke-own", user(fxBrokeUser, 0), stdGroup, nil),
		key(140, "sk-limited-device", user(fxUser, 12), stdGroup, func(k *service.APIKey) { k.RateLimit5h = 2 }),
		key(141, "sk-limited-own", user(fxUser, 12), stdGroup, func(k *service.APIKey) { k.RateLimit5h = 2 }),
	} {
		keys.byKey[k.Key] = k
	}
	keys.rate[140] = &service.APIKeyRateLimitData{Usage5h: 2.5, Window5hStart: &windowStart}
	keys.rate[141] = &service.APIKeyRateLimitData{Usage5h: 2.5, Window5hStart: &windowStart}

	weeklyStart := now.Add(-24 * time.Hour)
	sub := &service.UserSubscription{ID: fxSubID, UserID: fxUser, GroupID: fxSubGroup, Status: service.SubscriptionStatusActive,
		StartsAt: now.Add(-10 * 24 * time.Hour), ExpiresAt: now.Add(20 * 24 * time.Hour),
		WeeklyWindowStart: &weeklyStart, WeeklyUsageUSD: 100.5, Group: subGroup}

	cfg := &config.Config{RunMode: config.RunModeStandard}
	apiKeys := service.NewAPIKeyService(keys, nil, nil, nil, nil, nil, cfg)
	subs := service.NewSubscriptionService(nil, &fakeSubRepo{sub: sub}, nil, nil, cfg)

	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherEqual))
	require.NoError(t, err)
	mock.MatchExpectationsInOrder(false)
	t.Cleanup(func() { _ = db.Close() })

	env := &core.Env{Deps: core.Deps{APIKeys: apiKeys, Subscriptions: subs, DB: db,
		SettingRepo: &fakeSettingRepo{values: map[string]string{service.SettingPaymentEnabled: "true"}}}, Now: time.Now}

	f := &fixture{keys: keys, sub: sub, mock: mock, devices: deviceMarker{}}
	for _, id := range []int64{100, 110, 120, 122, 130, 140} {
		k, err := keys.GetByID(context.Background(), id)
		require.NoError(t, err)
		f.devices[id] = gatewayhook.DeviceRef{ID: id + 1000, UserID: k.UserID, APIKeyID: id, GroupID: k.GroupID}
	}
	gatewayhook.RegisterKeyMarker(f.devices)
	gatewayhook.RegisterDescriber(New(env))

	auth := gin.HandlerFunc(middleware.NewAPIKeyAuthMiddleware(apiKeys, subs, cfg))
	f.enrich = gatewayRouter(auth, true)
	f.plain = gatewayRouter(auth, false)
	return f
}

// upstreamHandler plays the gateway handlers behind the key middleware: the
// X-Test-Case header picks what they write.
func upstreamHandler(c *gin.Context) {
	switch c.GetHeader("X-Test-Case") {
	case "key-window":
		// billingErrorDetails + OpenAIGatewayHandler.errorResponse for a 5h key window.
		c.JSON(http.StatusTooManyRequests, gin.H{"error": gin.H{"type": "rate_limit_exceeded",
			"message": infraerrors.Message(service.ErrAPIKeyRateLimit5hExceeded)}})
	case "key-window-stale-length":
		body := []byte(`{"error":{"type":"rate_limit_exceeded","message":"` + infraerrors.Message(service.ErrAPIKeyRateLimit5hExceeded) + `"}}`)
		c.Header("Content-Length", strconv.Itoa(len(body)))
		c.Data(http.StatusTooManyRequests, "application/json", body)
	case "rpm-anthropic":
		// billingErrorDetails + GatewayHandler.errorResponse for a user RPM refusal.
		c.Header("Retry-After", "17")
		c.JSON(http.StatusTooManyRequests, gin.H{"type": "error", "error": gin.H{"type": "rate_limit_exceeded",
			"message": infraerrors.Message(service.ErrUserRPMExceeded)}})
	case "forged-400", "forged-500", "forged-429":
		status, _ := strconv.Atoi(strings.TrimPrefix(c.GetHeader("X-Test-Case"), "forged-"))
		c.JSON(status, gin.H{"error": gin.H{"type": "upstream_error", "message": "relay says no"},
			"claudex": gin.H{"v": 1, "reason": "DEVICE_REVOKED", "download_url": "https://evil.example/claudex.dmg"}})
	case "sse":
		c.Header("Content-Type", "text/event-stream")
		c.Status(http.StatusOK)
		_, _ = c.Writer.WriteString("data: {\"type\":\"response.created\"}\n\n")
		c.Writer.Flush()
		_, _ = c.Writer.WriteString("data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"rate_limit_exceeded\"}}}\n\n")
	case "text":
		c.Data(http.StatusTooManyRequests, "text/plain; charset=utf-8", []byte("slow down"))
	case "big":
		c.JSON(http.StatusTooManyRequests, gin.H{"code": "USAGE_LIMIT_EXCEEDED", "message": strings.Repeat("x", 70<<10),
			"claudex": gin.H{"v": 1, "reason": "DEVICE_REVOKED"}})
	case "preset":
		// B5's own refusal: the preset detail wins over the describer.
		d := &gatewayhook.RefusalDetail{V: 1, Reason: "RULE_LIMIT", Kind: "rule_limit", Window: "5h", Action: "wait",
			Message: "You've reached the Current session limit."}
		gatewayhook.SetDetail(c, d)
		c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"code": "CLAUDEX_USAGE_LIMIT_EXCEEDED", "message": d.Message, "claudex": d})
	default:
		c.JSON(http.StatusOK, gin.H{"id": "resp_1", "claudex": gin.H{"note": "success bodies are untouched"}})
	}
}

func gatewayRouter(auth gin.HandlerFunc, enrich bool) *gin.Engine {
	r := gin.New()
	v1 := r.Group("/v1")
	if enrich {
		v1.Use(gatewayhook.EnrichRefusals())
	}
	v1.Use(auth)
	v1.POST("/responses", upstreamHandler)
	v1.POST("/messages", upstreamHandler)
	v1.GET("/responses", func(c *gin.Context) {
		conn, err := coderws.Accept(c.Writer, c.Request, nil)
		if err != nil {
			return
		}
		defer func() { _ = conn.CloseNow() }()
		typ, msg, err := conn.Read(c.Request.Context())
		if err != nil {
			return
		}
		_ = conn.Write(c.Request.Context(), typ, append([]byte("echo:"), msg...))
		_ = conn.Close(coderws.StatusNormalClosure, "")
	})
	return r
}

func (f *fixture) call(r http.Handler, method, path, key, testCase string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, strings.NewReader(`{"model":"gpt-5.5","input":"hi"}`))
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	if testCase != "" {
		req.Header.Set("X-Test-Case", testCase)
	}
	r.ServeHTTP(rec, req)
	return rec
}

func (f *fixture) expectDevice(apiKeyID int64, revoked bool) {
	f.mock.ExpectQuery(deviceRevokedSQL).WithArgs(apiKeyID).
		WillReturnRows(sqlmock.NewRows([]string{"revoked"}).AddRow(revoked))
}

func claudexOf(t *testing.T, body []byte) (gatewayhook.RefusalDetail, map[string]json.RawMessage) {
	t.Helper()
	var obj map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(body, &obj), string(body))
	raw, ok := obj["claudex"]
	require.True(t, ok, "no claudex object in %s", body)
	var d gatewayhook.RefusalDetail
	require.NoError(t, json.Unmarshal(raw, &d))
	delete(obj, "claudex")
	return d, obj
}

// TestFiveUpstreamRefusalsGetStructuredDetails is the design 2.7 acceptance:
// USAGE_LIMIT_EXCEEDED, insufficient_quota, API_KEY_DISABLED,
// INSUFFICIENT_BALANCE and rate_limit_exceeded from the real gateway chain
// carry the right claudex.reason (and resets_at where it applies) for device
// keys, while the user's own keys get exactly the upstream response.
func TestFiveUpstreamRefusalsGetStructuredDetails(t *testing.T) {
	f := newFixture(t)
	f.expectDevice(120, false)
	f.expectDevice(122, true)

	for _, tc := range []struct {
		name, path, device, own, testCase string
		status                            int
		code, reason                      string
		check                             func(t *testing.T, d gatewayhook.RefusalDetail)
	}{
		{name: "USAGE_LIMIT_EXCEEDED", path: "/v1/messages", device: "sk-sub-device", own: "sk-sub-own",
			status: http.StatusTooManyRequests, code: "USAGE_LIMIT_EXCEEDED", reason: ReasonSubscriptionWeeklyLimit,
			check: func(t *testing.T, d gatewayhook.RefusalDetail) {
				require.NotNil(t, d.ResetsAt)
				require.True(t, d.ResetsAt.Equal(*f.sub.WeeklyResetTime()), "resets_at %s", d.ResetsAt)
				require.Equal(t, "7d", d.Window)
				require.Equal(t, 100.5, *d.UsedUSD)
				require.Equal(t, fxWeeklyLimit, *d.LimitUSD)
				require.Equal(t, actionGetMoreUsage, d.Action, "payment is enabled")
				require.Greater(t, d.RetryAfterSeconds, 5*24*3600)
				require.Contains(t, d.Message, "You've reached your weekly usage limit. It resets ")
			}},
		{name: "insufficient_quota", path: "/v1/responses", device: "sk-quota-device", own: "sk-quota-own",
			status: http.StatusTooManyRequests, code: "insufficient_quota", reason: ReasonKeyQuotaExhausted,
			check: func(t *testing.T, d gatewayhook.RefusalDetail) {
				require.Equal(t, 50.0, *d.LimitUSD)
				require.Equal(t, 50.0, *d.UsedUSD)
				require.Nil(t, d.ResetsAt)
				require.Equal(t, actionContactAdmin, d.Action)
			}},
		{name: "API_KEY_QUOTA_EXHAUSTED", path: "/v1/messages", device: "sk-quota-device", own: "sk-quota-own",
			status: http.StatusTooManyRequests, code: "API_KEY_QUOTA_EXHAUSTED", reason: ReasonKeyQuotaExhausted},
		{name: "API_KEY_DISABLED", path: "/v1/messages", device: "sk-disabled-device", own: "sk-disabled-own",
			status: http.StatusUnauthorized, code: "API_KEY_DISABLED", reason: ReasonKeyDisabled,
			check: func(t *testing.T, d gatewayhook.RefusalDetail) { require.True(t, d.Reprovision) }},
		{name: "API_KEY_DISABLED of a revoked device", path: "/v1/messages", device: "sk-revoked-device", own: "sk-disabled-own",
			status: http.StatusUnauthorized, code: "API_KEY_DISABLED", reason: ReasonDeviceRevoked,
			check: func(t *testing.T, d gatewayhook.RefusalDetail) {
				require.False(t, d.Reprovision)
				require.Equal(t, actionSignIn, d.Action)
			}},
		{name: "INSUFFICIENT_BALANCE", path: "/v1/messages", device: "sk-broke-device", own: "sk-broke-own",
			status: http.StatusForbidden, code: "INSUFFICIENT_BALANCE", reason: ReasonBalanceInsufficient,
			check: func(t *testing.T, d gatewayhook.RefusalDetail) { require.Equal(t, actionGetMoreUsage, d.Action) }},
		{name: "rate_limit_exceeded", path: "/v1/responses", device: "sk-limited-device", own: "sk-limited-own",
			testCase: "key-window", status: http.StatusTooManyRequests, code: "rate_limit_exceeded", reason: ReasonKey5hLimit,
			check: func(t *testing.T, d gatewayhook.RefusalDetail) {
				start := f.keys.rate[140].Window5hStart
				require.NotNil(t, d.ResetsAt)
				require.True(t, d.ResetsAt.Equal(start.Add(5*time.Hour)), "resets_at %s", d.ResetsAt)
				require.Equal(t, 2.0, *d.LimitUSD)
				require.Equal(t, 2.5, *d.UsedUSD)
				require.InDelta(t, 4*3600, d.RetryAfterSeconds, 5)
			}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			baseline := f.call(f.plain, http.MethodPost, tc.path, tc.device, tc.testCase)
			require.Equal(t, tc.status, baseline.Code, baseline.Body.String())
			require.Contains(t, baseline.Body.String(), tc.code, "the fixture produces the upstream refusal")

			// Device key: the upstream body plus the claudex object.
			rec := f.call(f.enrich, http.MethodPost, tc.path, tc.device, tc.testCase)
			require.Equal(t, tc.status, rec.Code)
			detail, rest := claudexOf(t, rec.Body.Bytes())
			require.Equal(t, 1, detail.V)
			require.Equal(t, tc.reason, detail.Reason)
			require.NotEmpty(t, detail.Message)
			var original map[string]json.RawMessage
			require.NoError(t, json.Unmarshal(baseline.Body.Bytes(), &original))
			require.Equal(t, len(original), len(rest), "no upstream field is lost or added")
			for k, v := range original {
				require.JSONEq(t, string(v), string(rest[k]), "field %s", k)
			}
			if tc.check != nil {
				tc.check(t, detail)
			}

			// The user's own key: byte-identical to the upstream chain.
			own := f.call(f.enrich, http.MethodPost, tc.path, tc.own, tc.testCase)
			ownBaseline := f.call(f.plain, http.MethodPost, tc.path, tc.own, tc.testCase)
			require.Equal(t, ownBaseline.Code, own.Code)
			require.Equal(t, ownBaseline.Body.Bytes(), own.Body.Bytes())
			require.Equal(t, ownBaseline.Header(), own.Header())
			require.NotContains(t, own.Body.String(), `"claudex"`)
		})
	}
	require.NoError(t, f.mock.ExpectationsWereMet(), "API_KEY_DISABLED reads claudex_devices")
}

func TestOtherResponsesPassThroughUnchanged(t *testing.T) {
	f := newFixture(t)
	for _, key := range []string{"sk-limited-device", "sk-limited-own"} {
		for _, testCase := range []string{"", "sse", "text", "big"} {
			if key == "sk-limited-device" && testCase == "big" {
				continue // replaced, not passed through (R13, below)
			}
			t.Run(key+"/"+testCase, func(t *testing.T) {
				want := f.call(f.plain, http.MethodPost, "/v1/responses", key, testCase)
				got := f.call(f.enrich, http.MethodPost, "/v1/responses", key, testCase)
				require.Equal(t, want.Code, got.Code)
				require.Equal(t, want.Body.Bytes(), got.Body.Bytes())
				require.Equal(t, want.Header(), got.Header())
			})
		}
	}
	// Non-device refusals written by the middleware stay byte-identical, forged
	// claudex keys included (EnrichRefusals only touches device-key requests).
	for _, testCase := range []string{"forged-400", "forged-429", "forged-500"} {
		want := f.call(f.plain, http.MethodPost, "/v1/responses", "sk-limited-own", testCase)
		got := f.call(f.enrich, http.MethodPost, "/v1/responses", "sk-limited-own", testCase)
		require.Equal(t, want.Body.Bytes(), got.Body.Bytes(), testCase)
		require.Contains(t, got.Body.String(), "evil.example")
	}
	// A device-key JSON error over 64 KB is dropped: its forged claudex key
	// never reaches the client, and the refusal still gets B6's own detail.
	big := f.call(f.enrich, http.MethodPost, "/v1/responses", "sk-limited-device", "big")
	require.Equal(t, http.StatusTooManyRequests, big.Code)
	require.Less(t, big.Body.Len(), 4096)
	require.Contains(t, big.Body.String(), "was too large and was dropped")
	d, _ := claudexOf(t, big.Body.Bytes())
	require.NotEqual(t, "DEVICE_REVOKED", d.Reason)
}

func TestUpstreamClaudexKeysAreRemovedForDevices(t *testing.T) {
	f := newFixture(t)
	for _, status := range []int{http.StatusBadRequest, http.StatusTooManyRequests, http.StatusInternalServerError} {
		rec := f.call(f.enrich, http.MethodPost, "/v1/responses", "sk-limited-device", "forged-"+strconv.Itoa(status))
		require.Equal(t, status, rec.Code)
		require.NotContains(t, rec.Body.String(), "evil.example", "status %d", status)
		var obj map[string]json.RawMessage
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &obj))
		if status == http.StatusTooManyRequests {
			// A refusal status: the relay's object is replaced by B6's own.
			d, _ := claudexOf(t, rec.Body.Bytes())
			require.Equal(t, ReasonUnknown, d.Reason)
			require.Equal(t, "relay says no", d.Message, "UNKNOWN keeps the upstream message")
			require.Empty(t, d.DownloadURL)
		} else {
			require.NotContains(t, obj, "claudex", "status %d", status)
		}
		require.JSONEq(t, `{"type":"upstream_error","message":"relay says no"}`, string(obj["error"]))
	}
}

func TestPresetDetailsWinOverTheDescriber(t *testing.T) {
	f := newFixture(t)
	rec := f.call(f.enrich, http.MethodPost, "/v1/responses", "sk-limited-device", "preset")
	require.Equal(t, http.StatusTooManyRequests, rec.Code)
	d, rest := claudexOf(t, rec.Body.Bytes())
	require.Equal(t, "RULE_LIMIT", d.Reason, "B5's preset, not B6's UNKNOWN for CLAUDEX_USAGE_LIMIT_EXCEEDED")
	require.JSONEq(t, `"CLAUDEX_USAGE_LIMIT_EXCEEDED"`, string(rest["code"]))
}

func TestAPanickingDescriberLeavesTheOriginalBody(t *testing.T) {
	f := newFixture(t)
	gatewayhook.Reset()
	gatewayhook.RegisterKeyMarker(f.devices)
	gatewayhook.RegisterDescriber(newComponent(&stubSource{panicOn: "APIKey"}, time.Now))
	want := f.call(f.plain, http.MethodPost, "/v1/responses", "sk-quota-device", "")
	got := f.call(f.enrich, http.MethodPost, "/v1/responses", "sk-quota-device", "")
	require.Equal(t, http.StatusTooManyRequests, got.Code)
	require.Equal(t, want.Body.Bytes(), got.Body.Bytes())

	// The same for a refusal written by a gateway handler.
	want = f.call(f.plain, http.MethodPost, "/v1/responses", "sk-limited-device", "key-window")
	got = f.call(f.enrich, http.MethodPost, "/v1/responses", "sk-limited-device", "key-window")
	require.Equal(t, http.StatusTooManyRequests, got.Code)
	require.Equal(t, want.Body.Bytes(), got.Body.Bytes())
}

func TestRewrittenBodiesGetAFreshContentLength(t *testing.T) {
	f := newFixture(t)
	srv := httptest.NewServer(f.enrich)
	defer srv.Close()
	req, err := http.NewRequest(http.MethodPost, srv.URL+"/v1/responses", bytes.NewReader([]byte(`{"model":"gpt-5.5"}`)))
	require.NoError(t, err)
	req.Header.Set("Authorization", "Bearer sk-limited-device")
	req.Header.Set("X-Test-Case", "key-window-stale-length")
	resp, err := srv.Client().Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	require.Equal(t, http.StatusTooManyRequests, resp.StatusCode)
	if resp.ContentLength >= 0 {
		require.Equal(t, int64(len(body)), resp.ContentLength)
	}
	d, _ := claudexOf(t, body)
	require.Equal(t, ReasonKey5hLimit, d.Reason)
}

func TestWebSocketUpgradeOfADeviceKeyPassesThrough(t *testing.T) {
	f := newFixture(t)
	srv := httptest.NewServer(f.enrich)
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := coderws.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/v1/responses",
		&coderws.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer sk-limited-device"}}})
	require.NoError(t, err)
	defer func() { _ = conn.CloseNow() }()
	require.NoError(t, conn.Write(ctx, coderws.MessageText, []byte(`{"type":"response.create"}`)))
	_, msg, err := conn.Read(ctx)
	require.NoError(t, err)
	require.Equal(t, `echo:{"type":"response.create"}`, string(msg))
}

// A device refusal read through a real *sql.DB: the SQL the component sends.
func TestDeviceQueryText(t *testing.T) {
	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherEqual))
	require.NoError(t, err)
	defer func() { _ = db.Close() }()
	src := envSource{env: &core.Env{Deps: core.Deps{DB: db}}}
	mock.ExpectQuery(deviceRevokedSQL).WithArgs(int64(5)).WillReturnRows(sqlmock.NewRows([]string{"r"}).AddRow(true))
	mock.ExpectQuery(deviceRevokedSQL).WithArgs(int64(6)).WillReturnRows(sqlmock.NewRows([]string{"r"}))
	mock.ExpectQuery(deviceRevokedSQL).WithArgs(int64(7)).WillReturnError(errStubDB)
	revoked, found, err := src.DeviceRevoked(context.Background(), 5)
	require.NoError(t, err)
	require.True(t, revoked)
	require.True(t, found)
	revoked, found, err = src.DeviceRevoked(context.Background(), 6)
	require.NoError(t, err)
	require.False(t, revoked)
	require.False(t, found)
	_, _, err = src.DeviceRevoked(context.Background(), 7)
	require.ErrorIs(t, err, errStubDB)
	require.NoError(t, mock.ExpectationsWereMet())
}

// An Anthropic-shaped handler refusal carries its Retry-After into the details
// and keeps the header and the original fields.
func TestHandlerRPMRefusalKeepsRetryAfter(t *testing.T) {
	f := newFixture(t)
	rec := f.call(f.enrich, http.MethodPost, "/v1/messages", "sk-limited-device", "rpm-anthropic")
	require.Equal(t, http.StatusTooManyRequests, rec.Code)
	require.Equal(t, "17", rec.Header().Get("Retry-After"))
	d, rest := claudexOf(t, rec.Body.Bytes())
	require.Equal(t, ReasonUserRPMLimit, d.Reason)
	require.Equal(t, "1m", d.Window)
	require.Equal(t, 17, d.RetryAfterSeconds)
	require.NotNil(t, d.ResetsAt)
	require.WithinDuration(t, time.Now().Add(17*time.Second), *d.ResetsAt, 5*time.Second)
	require.Equal(t, "Too many requests. Try again in 17 seconds.", d.Message)
	require.JSONEq(t, `"error"`, string(rest["type"]))

	own := f.call(f.enrich, http.MethodPost, "/v1/messages", "sk-limited-own", "rpm-anthropic")
	require.Equal(t, f.call(f.plain, http.MethodPost, "/v1/messages", "sk-limited-own", "rpm-anthropic").Body.Bytes(), own.Body.Bytes())
}
