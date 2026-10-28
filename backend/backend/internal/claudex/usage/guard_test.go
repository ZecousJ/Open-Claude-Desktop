//go:build unit

package usage

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/Wei-Shaw/sub2api/internal/claudex/gatewayhook"
	claudexhook "github.com/Wei-Shaw/sub2api/internal/claudex/hook"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

var (
	guardNow   = time.Date(2026, 9, 27, 13, 20, 0, 0, time.UTC)
	opusResets = time.Date(2026, 10, 2, 8, 0, 0, 0, time.UTC)
)

func resetHooks(t *testing.T) {
	t.Helper()
	gatewayhook.Reset()
	claudexhook.Reset()
	t.Cleanup(func() {
		gatewayhook.Reset()
		claudexhook.Reset()
	})
}

// testKeys are the keys of user 11 in group 4 (a device key and a key the
// user created) and a key of user 12 in the same group.
func testKeys(group *service.Group) map[string]*service.APIKey {
	gid := group.ID
	user11 := &service.User{ID: 11, Status: service.StatusActive}
	user12 := &service.User{ID: 12, Status: service.StatusActive}
	return map[string]*service.APIKey{
		"sk-device": {ID: 77, UserID: 11, User: user11, GroupID: &gid, Group: group, Name: "claudex-device:abc"},
		"sk-user":   {ID: 79, UserID: 11, User: user11, GroupID: &gid, Group: group, Name: "mine"},
		"sk-other":  {ID: 90, UserID: 12, User: user12, GroupID: &gid, Group: group, Name: "theirs"},
	}
}

// gatewayRouter mimics the upstream route families with an API-key step that
// runs the Claudex guards like H5b (and marks sk-device as a device key).
func gatewayRouter(t *testing.T, c *Component, keys map[string]*service.APIKey) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	resetHooks(t)
	gatewayhook.RegisterRequestGuard(c)
	auth := func(g *gin.Context) {
		key := keys[strings.TrimPrefix(g.GetHeader("Authorization"), "Bearer ")]
		if key == nil {
			g.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"code": "INVALID_API_KEY"})
			return
		}
		if key.ID == 77 {
			gatewayhook.MarkDevice(g, &gatewayhook.DeviceRef{ID: 1, UserID: key.UserID, APIKeyID: key.ID})
		}
		if gatewayhook.KeyAuthorized(g, key) {
			return
		}
		g.Next()
	}
	ok := func(g *gin.Context) { g.JSON(http.StatusOK, gin.H{"ok": true}) }
	r := gin.New()
	v1 := r.Group("/v1", gatewayhook.EnrichRefusals(), auth)
	v1.POST("/responses", ok)
	v1.GET("/responses", ok)
	v1.POST("/chat/completions", ok)
	v1.POST("/messages", ok)
	v1.POST("/messages/count_tokens", ok)
	v1.GET("/models", ok)
	v1.GET("/audio/realtime/transcriptions", ok)
	root := r.Group("", auth)
	root.POST("/responses", ok)
	root.GET("/responses", ok)
	root.POST("/chat/completions", ok)
	codex := r.Group("/backend-api/codex", auth)
	codex.POST("/responses", ok)
	codex.GET("/responses", ok)
	gemini := r.Group("/v1beta", auth)
	gemini.POST("/models/*modelAction", ok)
	return r
}

func send(r http.Handler, method, path, key, body string, header ...string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	var req *http.Request
	if body == "" {
		req = httptest.NewRequest(method, path, nil)
	} else {
		req = httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Authorization", "Bearer "+key)
	for i := 0; i+1 < len(header); i += 2 {
		req.Header.Set(header[i], header[i+1])
	}
	r.ServeHTTP(rec, req)
	return rec
}

func wsHandshake(r http.Handler, path, key string) *httptest.ResponseRecorder {
	return send(r, http.MethodGet, path, key, "", "Connection", "Upgrade", "Upgrade", "websocket")
}

func openAIGroup() *service.Group {
	return &service.Group{ID: 4, Name: "claudex-pro", Platform: service.PlatformOpenAI, Status: service.StatusActive}
}

// opusSetup: group 4 has a 5-hour session rule (not exceeded) and the Opus
// weekly rule of the design fixture, exceeded by user 11.
func opusSetup(t *testing.T) (*Component, *fakeStore, *gin.Engine) {
	t.Helper()
	fs := newFakeStore()
	fs.addRule(Rule{ID: 3, GroupID: ptr(int64(4)), Kind: KindSession, Label: DefaultSessionLabel, WindowSeconds: 18000, LimitUSD: 5, Enabled: true, ShowInClient: true})
	fs.addRule(Rule{ID: 5, GroupID: ptr(int64(4)), Kind: KindModels, Label: "Opus", ModelPatterns: []string{"claude-opus-*"}, WindowSeconds: 604800, LimitUSD: 20, Enabled: true, ShowInClient: true, SortOrder: 10})
	fs.setCounter(3, 11, guardNow.Add(-time.Hour), guardNow.Add(4*time.Hour), 1.2)
	fs.setCounter(5, 11, opusResets.Add(-7*24*time.Hour), opusResets, 20.13)
	c, _ := newTestComponent(fs, guardNow)
	return c, fs, gatewayRouter(t, c, testKeys(openAIGroup()))
}

func TestPrecheckRefusesWithTheDesignBody(t *testing.T) {
	_, _, r := opusSetup(t)
	rec := send(r, http.MethodPost, "/v1/chat/completions", "sk-user", `{"model":"claude-opus-4"}`)
	require.Equal(t, http.StatusTooManyRequests, rec.Code)
	require.Equal(t, "412800", rec.Header().Get("Retry-After"))
	const want = `{"code":"CLAUDEX_USAGE_LIMIT_EXCEEDED","message":"You've reached the Opus limit. It resets Oct 2, 8:00 AM UTC.",
 "claudex":{"v":1,"reason":"RULE_LIMIT","kind":"rule_limit","window":"7d","resets_at":"2026-10-02T08:00:00Z",
   "retry_after_seconds":412800,"limit_usd":20,"used_usd":20.13,"rule_id":5,"rule_kind":"models","label":"Opus","models":["claude-opus-*"],
   "reprovision":false,"action":"wait","message":"You've reached the Opus limit. It resets Oct 2, 8:00 AM UTC."}}`
	require.JSONEq(t, want, rec.Body.String())

	// A device key on /v1 gets the same detail through the refusal rewriter.
	rec = send(r, http.MethodPost, "/v1/responses", "sk-device", `{"model":"claude-opus-4-1"}`)
	require.Equal(t, http.StatusTooManyRequests, rec.Code)
	require.JSONEq(t, want, rec.Body.String())

	// Other models and other users pass.
	require.Equal(t, http.StatusOK, send(r, http.MethodPost, "/v1/chat/completions", "sk-user", `{"model":"gpt-5.5"}`).Code)
	require.Equal(t, http.StatusOK, send(r, http.MethodPost, "/v1/chat/completions", "sk-other", `{"model":"claude-opus-4"}`).Code)
}

func TestPrecheckCoversEveryRouteFamilyAndEveryKeyOfTheGroup(t *testing.T) {
	_, _, r := opusSetup(t)
	for _, key := range []string{"sk-user", "sk-device"} {
		for _, tc := range []struct{ method, path, body string }{
			{http.MethodPost, "/v1/responses", `{"model":"claude-opus-4"}`},
			{http.MethodPost, "/responses", `{"model":"claude-opus-4"}`},
			{http.MethodPost, "/backend-api/codex/responses", `{"model":"claude-opus-4"}`},
			{http.MethodPost, "/chat/completions", `{"model":"claude-opus-4"}`},
			{http.MethodPost, "/v1beta/models/claude-opus-4:generateContent", `{}`},
			{http.MethodPost, "/v1/messages", `{"model":"claude-opus-4-1-20250805"}`},
		} {
			rec := send(r, tc.method, tc.path, key, tc.body)
			require.Equal(t, http.StatusTooManyRequests, rec.Code, "%s %s %s: %s", key, tc.method, tc.path, rec.Body.String())
			require.Contains(t, rec.Body.String(), `"claudex":{`)
			require.Contains(t, rec.Body.String(), CodeLimitExceeded)
		}
	}
}

func TestPrecheckSeesDuplicateKeysCaseVariantsAndMissingModels(t *testing.T) {
	_, _, r := opusSetup(t)
	for _, body := range []string{
		`{"model":"gpt-5.5-mini","model":"claude-opus-4"}`,
		`{"model":"gpt-5.5","MODEL":"claude-opus-4"}`,
		`{"model":"gpt-5.5","model":"claude-opus-4"}`,
		`{"messages":[]}`, // no model at all: every per-model rule applies
	} {
		rec := send(r, http.MethodPost, "/v1/chat/completions", "sk-user", body)
		require.Equal(t, http.StatusTooManyRequests, rec.Code, body)
	}
}

// Dictation is counted as realtime-transcription: another model's exceeded
// rule does not refuse it (found by the I1 live check), a rule for its own
// name and the rules covering every model do.
func TestPrecheckDictationIsCheckedAsItsBilledModel(t *testing.T) {
	c, fs, r := opusSetup(t)
	const path = "/v1/audio/realtime/transcriptions"
	require.Equal(t, http.StatusOK, wsHandshake(r, path, "sk-device").Code)
	require.Equal(t, http.StatusOK, wsHandshake(r, path, "sk-user").Code)

	fs.addRule(Rule{ID: 7, GroupID: ptr(int64(4)), Kind: KindModels, Label: "Dictation", ModelPatterns: []string{RealtimeTranscriptionModel}, WindowSeconds: 604800, LimitUSD: 1, Enabled: true, ShowInClient: true})
	fs.setCounter(7, 11, guardNow.Add(-time.Hour), opusResets, 1)
	c.rules.invalidate()
	rec := wsHandshake(r, path, "sk-device")
	require.Equal(t, http.StatusTooManyRequests, rec.Code)
	require.Contains(t, rec.Body.String(), "You've reached the Dictation limit")

	fs.setCounter(7, 11, guardNow.Add(-time.Hour), opusResets, 0)
	fs.setCounter(3, 11, guardNow.Add(-time.Hour), guardNow.Add(4*time.Hour), 5)
	rec = wsHandshake(r, path, "sk-device")
	require.Equal(t, http.StatusTooManyRequests, rec.Code)
	require.Contains(t, rec.Body.String(), "You've reached your session limit")
}

func TestPrecheckOnWebSocketHandshakeAndTurns(t *testing.T) {
	c, fs, r := opusSetup(t)
	// The handshake has no model: only rules covering every model apply, and
	// the session is not exceeded.
	for _, path := range []string{"/v1/responses", "/responses", "/backend-api/codex/responses"} {
		require.Equal(t, http.StatusOK, wsHandshake(r, path, "sk-user").Code, path)
	}
	// The turn names the model (H14).
	err := c.PrecheckTurn(context.Background(), 11, 79, ptr(int64(4)), []string{"gpt-5.4", "claude-opus-4"})
	require.Error(t, err)
	require.Equal(t, "CLAUDEX_USAGE_LIMIT_EXCEEDED: You've reached the Opus limit. It resets Oct 2, 8:00 AM UTC.", err.Error())
	require.NoError(t, c.PrecheckTurn(context.Background(), 11, 79, ptr(int64(4)), []string{"gpt-5.4"}))

	// Once the session is exceeded, the handshake itself is refused.
	fs.setCounter(3, 11, guardNow.Add(-time.Hour), guardNow.Add(4*time.Hour), 5)
	for _, path := range []string{"/v1/responses", "/responses", "/backend-api/codex/responses"} {
		rec := wsHandshake(r, path, "sk-user")
		require.Equal(t, http.StatusTooManyRequests, rec.Code, path)
		require.Contains(t, rec.Body.String(), "You've reached your session limit")
	}
	require.Error(t, c.PrecheckTurn(context.Background(), 11, 79, ptr(int64(4)), []string{"gpt-5.4"}))

	// Installed as the module does it, the dispatcher returns the same text.
	claudexhook.Install(claudexhook.Hooks{PrecheckTurn: c.PrecheckTurn})
	err = claudexhook.PrecheckTurn(context.Background(), 11, 79, ptr(int64(4)), []string{"gpt-5.4"})
	require.Error(t, err)
	require.True(t, strings.HasPrefix(err.Error(), "CLAUDEX_USAGE_LIMIT_EXCEEDED: "), err.Error())
}

func TestPrecheckReportsTheBreachThatResetsLast(t *testing.T) {
	c, fs, r := opusSetup(t)
	fs.setCounter(3, 11, guardNow.Add(-time.Hour), guardNow.Add(4*time.Hour), 7)
	rec := send(r, http.MethodPost, "/v1/chat/completions", "sk-user", `{"model":"claude-opus-4"}`)
	require.Equal(t, http.StatusTooManyRequests, rec.Code)
	var body struct {
		Claudex gatewayhook.RefusalDetail `json:"claudex"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Equal(t, int64(5), *body.Claudex.RuleID, "the weekly Opus window ends after the session")
	require.Equal(t, KindModels, body.Claudex.RuleKind, "rule_kind names the kind (R13)")
	// Only the session applies to other models.
	rec = send(r, http.MethodPost, "/v1/chat/completions", "sk-user", `{"model":"gpt-5.5"}`)
	require.Equal(t, http.StatusTooManyRequests, rec.Code)
	body.Claudex = gatewayhook.RefusalDetail{}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Equal(t, int64(3), *body.Claudex.RuleID)
	require.Equal(t, KindSession, body.Claudex.RuleKind)
	require.Equal(t, "5h", body.Claudex.Window)
	require.Nil(t, body.Claudex.Models, "a session rule blocks every model")
	require.Equal(t, 4*3600, body.Claudex.RetryAfterSeconds)
	_ = c
}

func TestPrecheckIgnoresEndedWindowsAndNonBillableRoutes(t *testing.T) {
	c, fs, r := opusSetup(t)
	// Token counting and model lists are never checked.
	require.Equal(t, http.StatusOK, send(r, http.MethodPost, "/v1/messages/count_tokens", "sk-user", `{"model":"claude-opus-4"}`).Code)
	require.Equal(t, http.StatusOK, send(r, http.MethodGet, "/v1/models", "sk-user", "").Code)
	loads, counters := fs.calls()
	require.Equal(t, 0, loads+counters, "non-billable requests issue no query")

	// A window that ended no longer blocks (the next billed request opens a
	// new one).
	fs.setCounter(5, 11, opusResets.Add(-7*24*time.Hour), guardNow, 50)
	require.Equal(t, http.StatusOK, send(r, http.MethodPost, "/v1/chat/completions", "sk-user", `{"model":"claude-opus-4"}`).Code)
	_ = c
}

func TestPrecheckIssuesNoQueryWhenTheGroupHasNoRules(t *testing.T) {
	fs := newFakeStore()
	fs.addRule(Rule{ID: 8, GroupID: ptr(int64(9)), Kind: KindSession, Label: DefaultSessionLabel, WindowSeconds: 18000, LimitUSD: 1, Enabled: true})
	fs.setCounter(8, 11, guardNow.Add(-time.Hour), guardNow.Add(time.Hour), 99)
	c, _ := newTestComponent(fs, guardNow)
	r := gatewayRouter(t, c, testKeys(openAIGroup()))
	for i := 0; i < 20; i++ {
		require.Equal(t, http.StatusOK, send(r, http.MethodPost, "/v1/chat/completions", "sk-user", `{"model":"claude-opus-4"}`).Code)
	}
	loads, counters := fs.calls()
	require.Equal(t, 1, loads, "the rule list is loaded once and cached")
	require.Equal(t, 0, counters, "no counter query for a group without rules")

	// No rule at all: still one cached load, never a counter query.
	empty := newFakeStore()
	c2, _ := newTestComponent(empty, guardNow)
	r2 := gatewayRouter(t, c2, testKeys(openAIGroup()))
	for i := 0; i < 5; i++ {
		require.Equal(t, http.StatusOK, send(r2, http.MethodPost, "/v1/responses", "sk-device", `{"model":"gpt-5.5"}`).Code)
	}
	loads, counters = empty.calls()
	require.Equal(t, 1, loads)
	require.Equal(t, 0, counters)
}

// channelRepoStub serves one channel mapping opus-latest to claude-opus-4-1
// in group 4.
type channelRepoStub struct{ service.ChannelRepository }

func (channelRepoStub) ListAll(context.Context) ([]service.Channel, error) {
	return []service.Channel{{
		ID: 1, Name: "main", Status: service.StatusActive, GroupIDs: []int64{4},
		ModelMapping: map[string]map[string]string{service.PlatformOpenAI: {"opus-latest": "claude-opus-4-1", "fast-*": "claude-opus-4"}},
	}}, nil
}

func (channelRepoStub) GetGroupPlatforms(context.Context, []int64) (map[int64]string, error) {
	return map[int64]string{4: service.PlatformOpenAI}, nil
}

func TestPrecheckFollowsChannelMappingsAndGroupDispatch(t *testing.T) {
	c, _, r := opusSetup(t)
	channels := service.NewChannelService(channelRepoStub{}, nil, nil, nil, nil)
	c.mapChannel = channelMapperFrom(func() *service.ChannelService { return channels })

	for _, model := range []string{"opus-latest", "OPUS-LATEST", "fast-lane"} {
		rec := send(r, http.MethodPost, "/v1/chat/completions", "sk-user", `{"model":"`+model+`"}`)
		require.Equal(t, http.StatusTooManyRequests, rec.Code, "%s is served as Opus through the channel", model)
	}
	require.Equal(t, http.StatusOK, send(r, http.MethodPost, "/v1/chat/completions", "sk-user", `{"model":"sonnet-latest"}`).Code)
	require.Error(t, c.PrecheckTurn(context.Background(), 11, 79, ptr(int64(4)), []string{"opus-latest"}), "WebSocket turns follow the mapping too")

	// An OpenAI group that dispatches Claude requests: a rule on the model the
	// group maps Opus to applies to Claude Opus requests.
	fs := newFakeStore()
	fs.addRule(Rule{ID: 6, GroupID: ptr(int64(4)), Kind: KindModels, Label: "GPT-5.4", ModelPatterns: []string{"gpt-5.4"}, WindowSeconds: 604800, LimitUSD: 1, Enabled: true})
	fs.setCounter(6, 11, guardNow.Add(-time.Hour), guardNow.Add(time.Hour), 2)
	c2, _ := newTestComponent(fs, guardNow)
	group := openAIGroup()
	group.AllowMessagesDispatch = true
	r2 := gatewayRouter(t, c2, testKeys(group))
	require.Equal(t, http.StatusTooManyRequests, send(r2, http.MethodPost, "/v1/messages", "sk-user", `{"model":"claude-opus-4-1"}`).Code)
	require.Equal(t, http.StatusOK, send(r2, http.MethodPost, "/v1/messages", "sk-user", `{"model":"claude-sonnet-4"}`).Code)

	// Without dispatch the Claude name stays as it is.
	group.AllowMessagesDispatch = false
	require.Equal(t, http.StatusOK, send(r2, http.MethodPost, "/v1/messages", "sk-user", `{"model":"claude-opus-4-1"}`).Code)
}

func TestPrecheckFailsOpenWhenTheDatabaseIsDown(t *testing.T) {
	c, fs, r := opusSetup(t)
	fs.mu.Lock()
	fs.counterErr = errTestDB
	fs.mu.Unlock()
	require.Equal(t, http.StatusOK, send(r, http.MethodPost, "/v1/chat/completions", "sk-user", `{"model":"claude-opus-4"}`).Code)
	require.Equal(t, uint64(1), c.Metrics().PrecheckErrorsTotal)

	// Rules that cannot be loaded at all: allowed, counted.
	fs2 := newFakeStore()
	fs2.loadErr = errTestDB
	c2, _ := newTestComponent(fs2, guardNow)
	r2 := gatewayRouter(t, c2, testKeys(openAIGroup()))
	require.Equal(t, http.StatusOK, send(r2, http.MethodPost, "/v1/chat/completions", "sk-user", `{"model":"claude-opus-4"}`).Code)
	require.Equal(t, uint64(1), c2.Metrics().PrecheckErrorsTotal)
}

func TestRuleCacheExpiresAndIsInvalidated(t *testing.T) {
	fs := newFakeStore()
	c, clock := newTestComponent(fs, guardNow)
	r := gatewayRouter(t, c, testKeys(openAIGroup()))
	require.Equal(t, http.StatusOK, send(r, http.MethodPost, "/v1/responses", "sk-user", `{"model":"gpt-5.5"}`).Code)

	// A rule written behind the cache's back shows up after 60 s.
	fs.addRule(Rule{ID: 3, GroupID: ptr(int64(4)), Kind: KindSession, Label: DefaultSessionLabel, WindowSeconds: 18000, LimitUSD: 1, Enabled: true})
	fs.setCounter(3, 11, guardNow, guardNow.Add(5*time.Hour), 1)
	require.Equal(t, http.StatusOK, send(r, http.MethodPost, "/v1/responses", "sk-user", `{"model":"gpt-5.5"}`).Code)
	clock.Add(61 * time.Second)
	require.Equal(t, http.StatusTooManyRequests, send(r, http.MethodPost, "/v1/responses", "sk-user", `{"model":"gpt-5.5"}`).Code)

	// An administrator's write on this node applies at once.
	fs.mu.Lock()
	fs.rules[0].Enabled = false
	fs.mu.Unlock()
	require.Equal(t, http.StatusTooManyRequests, send(r, http.MethodPost, "/v1/responses", "sk-user", `{"model":"gpt-5.5"}`).Code)
	c.rules.invalidate()
	require.Equal(t, http.StatusOK, send(r, http.MethodPost, "/v1/responses", "sk-user", `{"model":"gpt-5.5"}`).Code)

	// A failed reload keeps serving the last good rules.
	fs.mu.Lock()
	fs.rules[0].Enabled = true
	fs.mu.Unlock()
	c.rules.invalidate()
	require.Equal(t, http.StatusTooManyRequests, send(r, http.MethodPost, "/v1/responses", "sk-user", `{"model":"gpt-5.5"}`).Code)
	fs.mu.Lock()
	fs.loadErr = errTestDB
	fs.mu.Unlock()
	clock.Add(61 * time.Second)
	require.Equal(t, http.StatusTooManyRequests, send(r, http.MethodPost, "/v1/responses", "sk-user", `{"model":"gpt-5.5"}`).Code)
}

func TestLimitErrorFitsAWebSocketCloseReason(t *testing.T) {
	label := strings.Repeat("模", 60)
	err := &LimitError{Detail: &gatewayhook.RefusalDetail{Message: limitMessage(KindModels, label, opusResets)}}
	text := err.Error()
	require.LessOrEqual(t, len(text), wsReasonLimit)
	require.True(t, utf8.ValidString(text))
	require.True(t, strings.HasPrefix(text, CodeLimitExceeded+": "))
}

// Upstream serves "models/claude-opus-4-5", "claude-opus-4-5" (the OAuth id
// claude-opus-4-5-20251101), "openai/gpt-5.5" or "gpt-5.5-high" as the model
// the rule names; the precheck must see those forms too (review of B5).
func TestPrecheckMatchesTheNamesUpstreamServesAModelAs(t *testing.T) {
	fs := newFakeStore()
	fs.addRule(Rule{ID: 5, GroupID: ptr(int64(4)), Kind: KindModels, Label: "Opus", ModelPatterns: []string{"claude-opus-*"}, WindowSeconds: 604800, LimitUSD: 20, Enabled: true, ShowInClient: true})
	fs.addRule(Rule{ID: 6, GroupID: ptr(int64(4)), Kind: KindModels, Label: "Opus 4.5", ModelPatterns: []string{"claude-opus-4-5-20251101"}, WindowSeconds: 604800, LimitUSD: 1, Enabled: true, ShowInClient: true})
	fs.addRule(Rule{ID: 7, GroupID: ptr(int64(4)), Kind: KindModels, Label: "GPT-5.5", ModelPatterns: []string{"gpt-5.5"}, WindowSeconds: 604800, LimitUSD: 1, Enabled: true, ShowInClient: true})
	fs.setCounter(5, 11, opusResets.Add(-7*24*time.Hour), opusResets, 25)
	fs.setCounter(6, 11, opusResets.Add(-7*24*time.Hour), opusResets.Add(time.Hour), 2)
	fs.setCounter(7, 11, opusResets.Add(-7*24*time.Hour), opusResets.Add(2*time.Hour), 2)
	c, _ := newTestComponent(fs, guardNow)
	r := gatewayRouter(t, c, testKeys(openAIGroup()))

	for body, rule := range map[string]int64{
		`{"model":"models/claude-opus-4-1"}`:    5,
		`{"model":"Models/Claude-Opus-4-1"}`:    5,
		`{"model":"anthropic/claude-opus-4-1"}`: 5,
		`{"model":"claude-opus-4-5"}`:           6,
		`{"model":"claude-opus-4-5-thinking"}`:  6,
		`{"model":"models/claude-opus-4-5"}`:    6,
		`{"model":"openai/gpt-5.5"}`:            7,
		`{"model":"GPT_5.5"}`:                   7,
		`{"model":"gpt5.5"}`:                    7,
		`{"model":"gpt-5.5-high"}`:              7,
		`{"model":"gpt-5.5","model":"gpt-5.4"}`: 7,
		`{"model":"gpt-5.4","model":"GPT-5.5"}`: 7,
	} {
		rec := send(r, http.MethodPost, "/v1/chat/completions", "sk-user", body)
		require.Equal(t, http.StatusTooManyRequests, rec.Code, body)
		var out struct {
			Claudex gatewayhook.RefusalDetail `json:"claudex"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
		require.Equal(t, rule, *out.Claudex.RuleID, body)
	}
	for _, body := range []string{`{"model":"gpt-5.5-mini"}`, `{"model":"claude-sonnet-4-5"}`, `{"model":"models/gemini-2.5-pro"}`} {
		require.Equal(t, http.StatusOK, send(r, http.MethodPost, "/v1/chat/completions", "sk-user", body).Code, body)
	}
	require.Equal(t, http.StatusTooManyRequests, send(r, http.MethodPost, "/v1beta/models/models/claude-opus-4-1:generateContent", "sk-user", `{}`).Code)
	require.Error(t, c.PrecheckTurn(context.Background(), 11, 79, ptr(int64(4)), []string{"openai/gpt-5.5"}))
}
