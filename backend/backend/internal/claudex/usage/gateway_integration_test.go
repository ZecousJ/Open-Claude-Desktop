//go:build integration

package usage_test

// End-to-end check of the usage rules on the real upstream gateway routes
// (routes.RegisterGatewayRoutes with the real API-key middlewares and their
// H5/H5b hooks) against PostgreSQL: design 2.6 acceptance. The test builds
// the router the way internal/server/routes' own Claudex tests do; importing
// internal/handler here is test-only wiring (the component never imports it).

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/gatewayhook"
	claudexhook "github.com/Wei-Shaw/sub2api/internal/claudex/hook"
	"github.com/Wei-Shaw/sub2api/internal/claudex/usage"
	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/handler"
	servermiddleware "github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/server/routes"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

var t0 = time.Date(2026, 9, 26, 1, 0, 0, 0, time.UTC)

// keyRepo serves user 11's keys: a device key and a key the user created in
// group 4, and a key in group 6.
type keyRepo struct{ service.APIKeyRepository }

func (keyRepo) lookup(key string) (*service.APIKey, error) {
	user := &service.User{ID: 11, Role: service.RoleUser, Status: service.StatusActive, Balance: 100, Concurrency: 5}
	g4 := &service.Group{ID: 4, Name: "claudex-pro", Platform: service.PlatformOpenAI, Status: service.StatusActive, SubscriptionType: service.SubscriptionTypeStandard}
	g6 := &service.Group{ID: 6, Name: "pay-as-you-go", Platform: service.PlatformOpenAI, Status: service.StatusActive, SubscriptionType: service.SubscriptionTypeStandard}
	id4, id6 := int64(4), int64(6)
	switch key {
	case "sk-device":
		return &service.APIKey{ID: 77, UserID: 11, Key: key, Name: "claudex-device:1", Status: service.StatusActive, User: user, GroupID: &id4, Group: g4}, nil
	case "sk-user":
		return &service.APIKey{ID: 79, UserID: 11, Key: key, Name: "mine", Status: service.StatusActive, User: user, GroupID: &id4, Group: g4}, nil
	case "sk-group6":
		return &service.APIKey{ID: 80, UserID: 11, Key: key, Name: "other", Status: service.StatusActive, User: user, GroupID: &id6, Group: g6}, nil
	}
	return nil, service.ErrAPIKeyNotFound
}
func (r keyRepo) GetByKey(_ context.Context, key string) (*service.APIKey, error) {
	return r.lookup(key)
}
func (r keyRepo) GetByKeyForAuth(_ context.Context, key string) (*service.APIKey, error) {
	return r.lookup(key)
}
func (keyRepo) UpdateLastUsed(context.Context, int64, time.Time) error { return nil }

type deviceMarker struct{}

func (deviceMarker) OnKeyResolved(c *gin.Context, apiKey *service.APIKey) {
	if apiKey.ID == 77 {
		gatewayhook.MarkDevice(c, &gatewayhook.DeviceRef{ID: 1, UserID: apiKey.UserID, APIKeyID: apiKey.ID, GroupID: apiKey.GroupID})
	}
}

type plans struct{}

func (plans) ResolvePlan(context.Context, int64, *int64) (*core.PlanRef, error) {
	return &core.PlanRef{GroupID: 4, GroupName: "claudex-pro", Platform: "openai", SubscriptionType: service.SubscriptionTypeStandard}, nil
}

type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }

// setup wires the component like claudex.ProvideModule does (guard, H8 and
// H14 hooks) into the real gateway routes, plus its user and admin routes.
func setup(t *testing.T) (*gin.Engine, *usage.Component, *clock) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	db := usage.NewIntegrationDB(t)
	clk := &clock{t: t0}
	env := &core.Env{Deps: core.Deps{DB: db}, Now: clk.now}
	env.Peers.Plans = plans{}
	c := usage.New(env)

	gatewayhook.Reset()
	claudexhook.Reset()
	t.Cleanup(func() {
		gatewayhook.Reset()
		claudexhook.Reset()
	})
	gatewayhook.RegisterKeyMarker(deviceMarker{})
	gatewayhook.RegisterRequestGuard(c)
	claudexhook.Install(claudexhook.Hooks{UsageApplied: c.OnUsageApplied, PrecheckTurn: c.PrecheckTurn})

	cfg := &config.Config{RunMode: config.RunModeStandard, Gateway: config.GatewayConfig{MaxBodySize: 1 << 20, TextMaxBodySize: 1 << 20}}
	keys := service.NewAPIKeyService(keyRepo{}, nil, nil, nil, nil, nil, cfg)
	r := gin.New()
	r.Use(gin.Recovery())
	routes.RegisterGatewayRoutes(r, &handler.Handlers{
		Gateway: &handler.GatewayHandler{}, OpenAIGateway: &handler.OpenAIGatewayHandler{},
		AsyncImage: handler.NewAsyncImageHandler(nil, nil),
	}, servermiddleware.NewAPIKeyAuthMiddleware(keys, nil, cfg), keys, nil, nil, nil, nil, cfg)

	subject := func(id int64) gin.HandlerFunc {
		return func(g *gin.Context) {
			g.Set(string(servermiddleware.ContextKeyUser), servermiddleware.AuthSubject{UserID: id})
			g.Next()
		}
	}
	c.RegisterUserRoutes(r.Group("/api/v1/claudex", subject(11)))
	c.RegisterAdminRoutes(r.Group("/api/v1/admin/claudex", subject(13)), func(g *gin.Context) { g.Next() })
	return r, c, clk
}

func call(r http.Handler, method, path, key, body string, header ...string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	var req *http.Request
	if body == "" {
		req = httptest.NewRequest(method, path, nil)
	} else {
		req = httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
	}
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
		req.Header.Set("x-goog-api-key", key)
	}
	for i := 0; i+1 < len(header); i += 2 {
		req.Header.Set(header[i], header[i+1])
	}
	r.ServeHTTP(rec, req)
	return rec
}

type refusal struct {
	Code    string                    `json:"code"`
	Message string                    `json:"message"`
	Claudex gatewayhook.RefusalDetail `json:"claudex"`
}

func refusalOf(t *testing.T, rec *httptest.ResponseRecorder) refusal {
	t.Helper()
	require.Equal(t, http.StatusTooManyRequests, rec.Code, rec.Body.String())
	var out refusal
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out), rec.Body.String())
	return out
}

func createRule(t *testing.T, r http.Handler, body string) int64 {
	t.Helper()
	rec := call(r, http.MethodPost, "/api/v1/admin/claudex/usage-rules", "", body)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var out struct {
		Data struct {
			ID int64 `json:"id"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	return out.Data.ID
}

// bill reports a billed request the way H8 does.
func bill(requested, billed string, cost float64, at time.Time) {
	g4 := int64(4)
	claudexhook.UsageApplied(context.Background(), claudexhook.UsageEvent{
		RequestID: "req-" + strconv.FormatInt(at.UnixNano(), 10), UserID: 11, APIKeyID: 79, GroupID: &g4,
		RequestedModel: requested, BilledModel: billed, CostUSD: cost, At: at,
	})
}

// wsUpgrade is the Responses WebSocket handshake.
func wsUpgrade(r http.Handler, path, key string) *httptest.ResponseRecorder {
	return call(r, http.MethodGet, path, key, "", "Connection", "Upgrade", "Upgrade", "websocket", "Sec-WebSocket-Version", "13", "Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
}

func TestSessionRuleRefusesEveryGatewayEntryAfterABreach(t *testing.T) {
	r, _, clk := setup(t)
	ruleID := createRule(t, r, `{"group_id":4,"kind":"session","limit_usd":0.01}`)

	// First request passes the rule (the zero-value handler behind it may
	// fail; only the usage refusal matters here) and is billed.
	require.NotEqual(t, http.StatusTooManyRequests, call(r, http.MethodPost, "/v1/chat/completions", "sk-user", `{"model":"gpt-5.5"}`).Code)
	bill("gpt-5.5", "gpt-5.5", 0.02, t0)
	clk.t = t0.Add(10 * time.Minute)

	// The second request is refused, resets_at = first request + 5 h.
	ref := refusalOf(t, call(r, http.MethodPost, "/v1/chat/completions", "sk-user", `{"model":"gpt-5.5"}`))
	require.Equal(t, usage.CodeLimitExceeded, ref.Code)
	require.Equal(t, "RULE_LIMIT", ref.Claudex.Reason)
	require.Equal(t, "5h", ref.Claudex.Window)
	require.True(t, ref.Claudex.ResetsAt.Equal(t0.Add(5*time.Hour)), "resets_at %s", ref.Claudex.ResetsAt)
	require.Equal(t, int((4*time.Hour + 50*time.Minute).Seconds()), ref.Claudex.RetryAfterSeconds)
	require.Equal(t, ruleID, *ref.Claudex.RuleID)
	require.Equal(t, 0.02, *ref.Claudex.UsedUSD)

	for _, key := range []string{"sk-user", "sk-device"} {
		for _, tc := range []struct{ method, path, body string }{
			{http.MethodPost, "/v1/responses", `{"model":"gpt-5.5"}`},
			{http.MethodPost, "/responses", `{"model":"gpt-5.5"}`},
			{http.MethodPost, "/backend-api/codex/responses", `{"model":"gpt-5.5"}`},
			{http.MethodPost, "/chat/completions", `{"model":"gpt-5.5"}`},
			{http.MethodPost, "/v1/chat/completions", `{"model":"gpt-5.5"}`},
			{http.MethodPost, "/v1/messages", `{"model":"claude-sonnet-4"}`},
			{http.MethodPost, "/v1beta/models/x:generateContent", `{}`},
		} {
			rec := call(r, tc.method, tc.path, key, tc.body)
			ref := refusalOf(t, rec)
			require.Equal(t, usage.CodeLimitExceeded, ref.Code, "%s %s %s", key, tc.method, tc.path)
			require.Equal(t, "RULE_LIMIT", ref.Claudex.Reason, "%s %s: every key of the group gets the detail", key, tc.path)
			require.NotEmpty(t, rec.Header().Get("Retry-After"))
		}
		for _, path := range []string{"/v1/responses", "/responses", "/backend-api/codex/responses", "/v1/audio/realtime/transcriptions"} {
			ref := refusalOf(t, wsUpgrade(r, path, key))
			require.Equal(t, usage.CodeLimitExceeded, ref.Code, "WebSocket handshake %s", path)
		}
	}
	// The next WebSocket turn of a connection opened earlier (H14).
	err := claudexhook.PrecheckTurn(context.Background(), 11, 79, ptr(int64(4)), []string{"gpt-5.5"})
	require.Error(t, err)
	require.True(t, strings.HasPrefix(err.Error(), usage.CodeLimitExceeded+": "), err.Error())

	// Not billable: token counting and model lists; another group's key.
	require.NotEqual(t, http.StatusTooManyRequests, call(r, http.MethodPost, "/v1/messages/count_tokens", "sk-user", `{"model":"claude-sonnet-4"}`).Code)
	require.NotEqual(t, http.StatusTooManyRequests, call(r, http.MethodGet, "/v1/models", "sk-user", "").Code)
	require.NotEqual(t, http.StatusTooManyRequests, call(r, http.MethodPost, "/v1/chat/completions", "sk-group6", `{"model":"gpt-5.5"}`).Code)

	// usage-status shows the Current session row, exceeded and blocking.
	rec := call(r, http.MethodGet, "/api/v1/claudex/usage-status", "", "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var status struct {
		Data usage.Status `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &status))
	require.NotEmpty(t, status.Data.Windows)
	w := status.Data.Windows[0]
	require.Equal(t, "session", w.Kind)
	require.Equal(t, "Current session", w.Label)
	require.True(t, w.Active)
	require.True(t, w.Exceeded)
	require.Equal(t, 100, w.Percent)
	require.True(t, status.Data.Blocked.Blocked)
	require.True(t, status.Data.Blocked.ResetsAt.Equal(t0.Add(5*time.Hour)))

	// Resetting the counter lifts the block at once.
	rec = call(r, http.MethodPost, "/api/v1/admin/claudex/usage-rules/"+strconv.FormatInt(ruleID, 10)+"/reset", "", `{"user_id":11}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.NotEqual(t, http.StatusTooManyRequests, call(r, http.MethodPost, "/responses", "sk-user", `{"model":"gpt-5.5"}`).Code)
	require.NoError(t, claudexhook.PrecheckTurn(context.Background(), 11, 79, ptr(int64(4)), []string{"gpt-5.5"}))

	// After the window ends the rule no longer blocks either.
	bill("gpt-5.5", "gpt-5.5", 1, clk.t)
	require.Equal(t, http.StatusTooManyRequests, call(r, http.MethodPost, "/responses", "sk-user", `{"model":"gpt-5.5"}`).Code)
	clk.t = clk.t.Add(5 * time.Hour)
	require.NotEqual(t, http.StatusTooManyRequests, call(r, http.MethodPost, "/responses", "sk-user", `{"model":"gpt-5.5"}`).Code)
}

func TestPerModelRuleFollowsDuplicateKeysMappedNamesAndTurns(t *testing.T) {
	r, c, clk := setup(t)
	createRule(t, r, `{"group_id":4,"kind":"models","label":"Opus","model_patterns":["claude-opus-*"],"window_seconds":604800,"limit_usd":20,"sort_order":10}`)

	// The client asked for an alias; the request was billed as Opus.
	bill("opus-latest", "claude-opus-4-1", 20.13, t0)
	clk.t = t0.Add(time.Hour)
	require.Equal(t, 0, c.Metrics().RetryQueue)

	for _, body := range []string{`{"model":"claude-opus-4"}`, `{"model":"gpt-5.5-mini","model":"claude-opus-4"}`, `{"model":"gpt-5.5","MODEL":"Claude-Opus-4-1"}`} {
		ref := refusalOf(t, call(r, http.MethodPost, "/v1/chat/completions", "sk-user", body))
		require.Equal(t, "Opus", ref.Claudex.Label)
		require.Equal(t, []string{"claude-opus-*"}, ref.Claudex.Models)
		require.Equal(t, "7d", ref.Claudex.Window)
		require.True(t, ref.Claudex.ResetsAt.Equal(t0.Add(7*24*time.Hour)))
		require.Equal(t, "You've reached the Opus limit. It resets Oct 3, 1:00 AM UTC.", ref.Message)
	}
	refusalOf(t, call(r, http.MethodPost, "/v1beta/models/claude-opus-4:streamGenerateContent", "sk-user", `{}`))

	// Other models pass; the WebSocket handshake has no model yet and passes,
	// the turn that names Opus is refused.
	require.NotEqual(t, http.StatusTooManyRequests, call(r, http.MethodPost, "/v1/chat/completions", "sk-user", `{"model":"gpt-5.5"}`).Code)
	require.NotEqual(t, http.StatusTooManyRequests, wsUpgrade(r, "/v1/responses", "sk-device").Code)
	require.Error(t, claudexhook.PrecheckTurn(context.Background(), 11, 77, ptr(int64(4)), []string{"gpt-5.4", "claude-opus-4"}))
	require.NoError(t, claudexhook.PrecheckTurn(context.Background(), 11, 77, ptr(int64(4)), []string{"gpt-5.4"}))
}

func ptr[T any](v T) *T { return &v }
