package usage

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/gatewayhook"
	claudexhook "github.com/Wei-Shaw/sub2api/internal/claudex/hook"
	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
	"github.com/Wei-Shaw/sub2api/internal/pkg/ctxkey"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// memSettings is an in-memory service.SettingRepository.
type memSettings struct {
	mu     sync.Mutex
	values map[string]string
}

func (r *memSettings) Get(ctx context.Context, key string) (*service.Setting, error) {
	v, err := r.GetValue(ctx, key)
	if err != nil {
		return nil, err
	}
	return &service.Setting{Key: key, Value: v}, nil
}

func (r *memSettings) GetValue(_ context.Context, key string) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	v, ok := r.values[key]
	if !ok {
		return "", service.ErrSettingNotFound
	}
	return v, nil
}

func (r *memSettings) Set(_ context.Context, key, value string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.values[key] = value
	return nil
}

func (r *memSettings) GetMultiple(_ context.Context, keys []string) (map[string]string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := map[string]string{}
	for _, k := range keys {
		if v, ok := r.values[k]; ok {
			out[k] = v
		}
	}
	return out, nil
}

func (r *memSettings) SetMultiple(_ context.Context, values map[string]string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for k, v := range values {
		r.values[k] = v
	}
	return nil
}

func (r *memSettings) GetAll(context.Context) (map[string]string, error) { return nil, nil }
func (r *memSettings) Delete(context.Context, string) error              { return nil }

// fakeDevices answers LookupByAPIKey from a map.
type fakeDevices map[int64]core.DeviceRef

func (f fakeDevices) LookupByAPIKey(_ context.Context, id int64) (*core.DeviceRef, bool) {
	d, ok := f[id]
	if !ok {
		return nil, false
	}
	return &d, true
}

func (f fakeDevices) LookupByDeviceID(context.Context, int64, string) (*core.DeviceRef, bool) {
	return nil, false
}

type clock struct{ t time.Time }

func (c *clock) now() time.Time      { return c.t }
func (c *clock) add(d time.Duration) { c.t = c.t.Add(d) }

var t0 = time.Date(2026, 9, 28, 8, 0, 0, 0, time.UTC)

func newTestComponent(t *testing.T, settings string) (*Component, *clock) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	clk := &clock{t: t0}
	repo := &memSettings{values: map[string]string{}}
	if settings != "" {
		repo.values[SettingKey] = settings
	}
	env := &core.Env{Deps: core.Deps{SettingRepo: repo}, Now: clk.now}
	env.Peers.Devices = fakeDevices{
		7: {ID: 1, UserID: 70, APIKeyID: 7, Platform: platformWeb},
		8: {ID: 2, UserID: 80, APIKeyID: 8, Platform: "darwin"},
	}
	return New(env), clk
}

func withSQL(t *testing.T, c *Component) sqlmock.Sqlmock {
	t.Helper()
	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	c.db = db
	return mock
}

// keyRequest runs the KeyMarker for a gateway request with these headers.
func keyRequest(c *Component, keyID int64, clientID string, headers map[string]string) *http.Request {
	rec := httptest.NewRecorder()
	g, _ := gin.CreateTestContext(rec)
	req := httptest.NewRequest(http.MethodPost, "/v1/responses", nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	ctx := req.Context()
	if clientID != "" {
		ctx = context.WithValue(ctx, ctxkey.ClientRequestID, clientID)
	}
	ctx = context.WithValue(ctx, ctxkey.RequestID, "r-"+clientID)
	g.Request = req.WithContext(ctx)
	c.OnKeyResolved(g, &service.APIKey{ID: keyID})
	return g.Request
}

func TestKeyMarkerRemembersWebConversationsAndStripsHeaders(t *testing.T) {
	c, clk := newTestComponent(t, "")
	req := keyRequest(c, 7, "c1", map[string]string{HeaderConversation: "conv-1", HeaderWebSession: "ws_1"})
	require.Empty(t, req.Header.Get(HeaderConversation), "never forwarded upstream")
	require.Empty(t, req.Header.Get(HeaderWebSession))

	a, ok := c.tracker.take("client:c1", 7, clk.now())
	require.True(t, ok)
	require.Equal(t, attribution{UserID: 70, APIKeyID: 7, Conversation: "conv-1", WebSession: "ws_1", At: t0}, a)
	// The local request id is the second billing id; a stable id falls back to the key.
	a, ok = c.tracker.take("local:r-c1", 7, clk.now())
	require.True(t, ok)
	require.Equal(t, "conv-1", a.Conversation)
	a, ok = c.tracker.take("web_search:xyz", 7, clk.now())
	require.True(t, ok)
	require.Equal(t, "conv-1", a.Conversation)
	_, ok = c.tracker.take("web_search:xyz", 99, clk.now())
	require.False(t, ok, "another key")

	// A desktop key: headers stripped, nothing remembered.
	req = keyRequest(c, 8, "c2", map[string]string{HeaderConversation: "conv-2"})
	require.Empty(t, req.Header.Get(HeaderConversation))
	_, ok = c.tracker.take("client:c2", 8, clk.now())
	require.False(t, ok)

	// A web request without (or with a bad) conversation is not claimed by the
	// key's previous conversation.
	keyRequest(c, 7, "c3", map[string]string{HeaderConversation: "bad id with spaces"})
	_, ok = c.tracker.take("client:c3", 7, clk.now())
	require.False(t, ok)

	// A marked device (the devices KeyMarker ran first) is used as is.
	rec := httptest.NewRecorder()
	g, _ := gin.CreateTestContext(rec)
	g.Request = httptest.NewRequest(http.MethodPost, "/v1/responses", nil)
	g.Request.Header.Set(HeaderConversation, "conv-9")
	gatewayhook.MarkDevice(g, &core.DeviceRef{UserID: 90, APIKeyID: 9, Platform: platformWeb})
	c.OnKeyResolved(g, &service.APIKey{ID: 9})
	a, ok = c.tracker.take("anything", 9, clk.now())
	require.True(t, ok)
	require.Equal(t, int64(90), a.UserID)

	// Expiry.
	clk.add(keyTTL)
	_, ok = c.tracker.take("web_search:late", 7, clk.now())
	require.False(t, ok)
	c.tracker.prune(clk.now())
	require.Empty(t, c.tracker.byKey)
	require.Empty(t, c.tracker.byRequest)
}

func TestUsageObserverWritesLinks(t *testing.T) {
	c, _ := newTestComponent(t, "")
	mock := withSQL(t, c)
	keyRequest(c, 7, "c1", map[string]string{HeaderConversation: "conv-1", HeaderWebSession: "ws_1"})

	mock.ExpectExec(`INSERT INTO claudex_web_usage_links`).
		WithArgs("client:c1", int64(7), int64(70), "conv-1", "ws_1", "gpt-5", 0.25, t0).
		WillReturnResult(sqlmock.NewResult(1, 1))
	c.OnUsageApplied(context.Background(), claudexhook.UsageEvent{
		RequestID: "client:c1", UserID: 70, APIKeyID: 7, RequestedModel: "gpt-5", BilledModel: "gpt-5-2026", CostUSD: 0.25, At: t0,
	})
	// Other users' or unknown keys' usage is ignored (no SQL expected).
	c.OnUsageApplied(context.Background(), claudexhook.UsageEvent{RequestID: "client:c1", UserID: 71, APIKeyID: 7})
	c.OnUsageApplied(context.Background(), claudexhook.UsageEvent{RequestID: "client:zz", UserID: 80, APIKeyID: 8})
	c.OnUsageApplied(context.Background(), claudexhook.UsageEvent{})
	require.NoError(t, mock.ExpectationsWereMet())
}

func TestAcquireEnforcesUserAndGlobalLimits(t *testing.T) {
	c, clk := newTestComponent(t, `{"max_concurrent_sessions_per_user":2,"max_concurrent_sessions":3,"max_session_minutes":10}`)
	ctx := context.Background()
	a, err := c.Acquire(ctx, SlotRequest{UserID: 1, ConversationID: "c-a"})
	require.NoError(t, err)
	require.Equal(t, ModeChat, a.Info().Mode)
	require.Equal(t, t0.Add(10*time.Minute), a.Deadline())
	_, err = c.Acquire(ctx, SlotRequest{UserID: 1, Mode: ModeCowork})
	require.NoError(t, err)

	_, err = c.Acquire(ctx, SlotRequest{UserID: 1})
	require.True(t, IsCapacity(err))
	status, body := infraerrors.ToHTTP(err)
	require.Equal(t, http.StatusServiceUnavailable, status)
	require.Equal(t, webproto.ErrCodeCapacity, body.Reason)
	require.Equal(t, map[string]string{"scope": ScopeUser, "limit": "2", "active": "2"}, body.Metadata)
	require.Equal(t, CapacityUserMessage, body.Message)

	_, err = c.Acquire(ctx, SlotRequest{UserID: 2})
	require.NoError(t, err)
	_, err = c.Acquire(ctx, SlotRequest{UserID: 3})
	_, body = infraerrors.ToHTTP(err)
	require.Equal(t, map[string]string{"scope": ScopeGlobal, "limit": "3", "active": "3"}, body.Metadata)
	require.Equal(t, CapacityGlobalMessage, body.Message)
	require.Len(t, c.ActiveSlots(0), 3)
	require.Len(t, c.ActiveSlots(1), 2)

	// Releasing (without a database nothing is written) frees the slot once.
	clk.add(90 * time.Second)
	require.NoError(t, a.Release(ctx, SlotEnd{ExitReason: "completed"}))
	require.NoError(t, a.Release(ctx, SlotEnd{}))
	require.Len(t, c.ActiveSlots(0), 2)
	_, err = c.Acquire(ctx, SlotRequest{UserID: 3, Mode: ModeCode})
	require.NoError(t, err)

	for _, bad := range []SlotRequest{{}, {UserID: 1, Mode: "voice"}, {UserID: 1, ConversationID: "a b"}, {UserID: 1, RunnerID: "x/y"}} {
		_, err := c.Acquire(ctx, bad)
		require.Equal(t, webproto.ErrCodeBadRequest, infraerrors.Reason(err), "%+v", bad)
	}
}

func TestReleaseRecordsRunnerUsage(t *testing.T) {
	c, clk := newTestComponent(t, "")
	mock := withSQL(t, c)
	ctx := context.Background()
	s, err := c.Acquire(ctx, SlotRequest{UserID: 5, ConversationID: "conv-5", Mode: ModeChat, RunnerID: "dc6"})
	require.NoError(t, err)
	clk.add(2 * time.Minute)
	mock.ExpectExec(`INSERT INTO claudex_web_runner_usage`).
		WithArgs(int64(5), "conv-5", "wsl-1", ModeChat, 120.0, 3.5, t0, t0.Add(2*time.Minute), "timeout").
		WillReturnResult(sqlmock.NewResult(1, 1))
	require.NoError(t, s.Release(ctx, SlotEnd{RunnerID: "wsl-1", CPUSeconds: 3.5, ExitReason: " Timeout!! "}))
	require.NoError(t, mock.ExpectationsWereMet())

	// Direct records are cleaned up.
	mock.ExpectExec(`INSERT INTO claudex_web_runner_usage`).
		WithArgs(int64(5), "", "", ModeCode, 0.0, 0.0, clk.now(), clk.now(), "").
		WillReturnResult(sqlmock.NewResult(1, 1))
	require.NoError(t, c.RecordRunnerUsage(ctx, RunnerUsage{UserID: 5, Mode: ModeCode, ConversationID: "bad id", RunnerID: "bad/id", CPUSeconds: -1}))
	require.Error(t, c.RecordRunnerUsage(ctx, RunnerUsage{UserID: 0}))
	require.Error(t, c.RecordRunnerUsage(ctx, RunnerUsage{UserID: 1, Mode: "voice"}))
	require.NoError(t, mock.ExpectationsWereMet())
}

func TestSettingsValidation(t *testing.T) {
	s := defaultSettings()
	require.NoError(t, validateSettings(&s))
	var empty Settings
	normalizeSettings(&empty)
	require.Equal(t, defaultSettings(), empty)
	for _, bad := range []Settings{
		{MaxConcurrentPerUser: 0, MaxConcurrent: 2, MaxSessionMinutes: 30},
		{MaxConcurrentPerUser: 3, MaxConcurrent: 2, MaxSessionMinutes: 30},
		{MaxConcurrentPerUser: 1, MaxConcurrent: 501, MaxSessionMinutes: 30},
		{MaxConcurrentPerUser: 1, MaxConcurrent: 2, MaxSessionMinutes: 0},
		{MaxConcurrentPerUser: 1, MaxConcurrent: 2, MaxSessionMinutes: 30, RunnerMinutePriceUSD: -1},
		{MaxConcurrentPerUser: 1, MaxConcurrent: 2, MaxSessionMinutes: 30, RunnerMinutePriceUSD: 101},
	} {
		require.Equal(t, ReasonSettingsInvalid, infraerrors.Reason(validateSettings(&bad)), "%+v", bad)
	}
}

type envelope struct {
	Code     int               `json:"code"`
	Reason   string            `json:"reason"`
	Metadata map[string]string `json:"metadata"`
	Data     json.RawMessage   `json:"data"`
}

func serve(t *testing.T, c *Component, method, path, body string, userID int64) (*httptest.ResponseRecorder, envelope) {
	t.Helper()
	r := gin.New()
	auth := func(g *gin.Context) {
		if userID > 0 {
			g.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: userID})
		}
		g.Next()
	}
	c.RegisterUserRoutes(r.Group("/api/v1/claudex", auth))
	c.RegisterAdminRoutes(r.Group("/api/v1/admin/claudex", auth), func(g *gin.Context) { g.Next() })
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(rec, req)
	var e envelope
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &e), rec.Body.String())
	return rec, e
}

func TestAdminSettingsRoutes(t *testing.T) {
	c, _ := newTestComponent(t, "")
	rec, e := serve(t, c, http.MethodGet, "/api/v1/admin/claudex/web/usage/settings", "", 1)
	require.Equal(t, http.StatusOK, rec.Code)
	var s Settings
	require.NoError(t, json.Unmarshal(e.Data, &s))
	require.Equal(t, defaultSettings(), s)

	rec, e = serve(t, c, http.MethodPut, "/api/v1/admin/claudex/web/usage/settings",
		`{"max_concurrent_sessions_per_user":2,"max_concurrent_sessions":4,"max_session_minutes":45,"runner_minute_price_usd":0.01,"revision":0}`, 1)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.NoError(t, json.Unmarshal(e.Data, &s))
	require.Equal(t, int64(1), s.Revision)
	require.Equal(t, 4, s.MaxConcurrent)
	require.Equal(t, int64(1), *s.UpdatedBy)

	rec, e = serve(t, c, http.MethodPut, "/api/v1/admin/claudex/web/usage/settings",
		`{"max_concurrent_sessions_per_user":2,"max_concurrent_sessions":4,"max_session_minutes":45,"revision":0}`, 1)
	require.Equal(t, http.StatusConflict, rec.Code)
	require.Equal(t, ReasonSettingsConflict, e.Reason)
	rec, e = serve(t, c, http.MethodPut, "/api/v1/admin/claudex/web/usage/settings",
		`{"max_concurrent_sessions_per_user":0,"max_concurrent_sessions":4,"max_session_minutes":45,"revision":1}`, 1)
	require.Equal(t, http.StatusBadRequest, rec.Code)
	require.Equal(t, ReasonSettingsInvalid, e.Reason)
	rec, _ = serve(t, c, http.MethodPut, "/api/v1/admin/claudex/web/usage/settings", `{"max_concurrent_sessions":4}`, 1)
	require.Equal(t, http.StatusBadRequest, rec.Code, "revision is required")

	// The new limits apply to Acquire.
	c.setting.Invalidate()
	_, err := c.Acquire(context.Background(), SlotRequest{UserID: 3})
	require.NoError(t, err)
	rec, e = serve(t, c, http.MethodGet, "/api/v1/admin/claudex/web/usage/active?user_id=3", "", 1)
	require.Equal(t, http.StatusOK, rec.Code)
	var active ActiveResponse
	require.NoError(t, json.Unmarshal(e.Data, &active))
	require.Len(t, active.Slots, 1)
	require.Equal(t, 2, active.Settings.MaxConcurrentPerUser)

	rec, _ = serve(t, c, http.MethodGet, "/api/v1/admin/claudex/web/usage/active?user_id=x", "", 1)
	require.Equal(t, http.StatusBadRequest, rec.Code)
	rec, e = serve(t, c, http.MethodGet, "/api/v1/admin/claudex/web/usage/runners", "", 1)
	require.Equal(t, http.StatusServiceUnavailable, rec.Code, "no database")
	require.Equal(t, "CLAUDEX_WEB_USAGE_UNAVAILABLE", e.Reason)
}

func TestUserConversationRoute(t *testing.T) {
	c, _ := newTestComponent(t, "")
	mock := withSQL(t, c)
	first, last := t0, t0.Add(time.Hour)
	mock.ExpectQuery(`FROM claudex_web_usage_links WHERE user_id = \$1 AND conversation_id = \$2`).
		WithArgs(int64(70), "conv-1").
		WillReturnRows(sqlmock.NewRows([]string{"model", "count", "sum", "min", "max"}).
			AddRow("gpt-5", 3, 0.5, first, first.Add(time.Minute)).
			AddRow("grok-4", 1, 0.25, last, last))
	mock.ExpectQuery(`FROM claudex_web_runner_usage WHERE user_id = \$1 AND conversation_id = \$2`).
		WithArgs(int64(70), "conv-1").
		WillReturnRows(sqlmock.NewRows([]string{"count", "wall", "cpu"}).AddRow(2, 300.0, 12.5))
	rec, e := serve(t, c, http.MethodGet, "/api/v1/claudex/web/usage/conversations/conv-1", "", 70)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var out ConversationUsage
	require.NoError(t, json.Unmarshal(e.Data, &out))
	require.Equal(t, int64(4), out.Requests)
	require.InDelta(t, 0.75, out.CostUSD, 1e-9)
	require.Len(t, out.Models, 2)
	require.Equal(t, RunnerTotals{Runs: 2, WallSeconds: 300, CPUSeconds: 12.5}, out.Runner)
	require.True(t, out.FirstAt.Equal(first))
	require.True(t, out.LastAt.Equal(last))
	require.NoError(t, mock.ExpectationsWereMet())

	rec, _ = serve(t, c, http.MethodGet, "/api/v1/claudex/web/usage/conversations/bad%20id", "", 70)
	require.Equal(t, http.StatusBadRequest, rec.Code)
	rec, _ = serve(t, c, http.MethodGet, "/api/v1/claudex/web/usage/conversations/conv-1", "", 0)
	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestFromFindsTheInstalledComponent(t *testing.T) {
	c, _ := newTestComponent(t, "")
	require.Nil(t, From(nil))
	require.Nil(t, From(&core.Env{}))
	require.Same(t, c, From(&core.Env{Components: []core.Feature{c}}))
	require.Equal(t, Name, c.Name())
	require.Equal(t, []string{SettingKey}, c.SettingKeys())
}
