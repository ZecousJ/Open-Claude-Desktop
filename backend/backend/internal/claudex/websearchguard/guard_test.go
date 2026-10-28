package websearchguard

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/gatewayhook"
	"github.com/Wei-Shaw/sub2api/internal/claudex/policy"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func init() { gin.SetMode(gin.TestMode) }

// fakePolicy stands in for the client-policy component.
type fakePolicy struct {
	mu       sync.Mutex
	section  any
	err      error
	panics   bool
	contexts []core.BootstrapContext
}

func (f *fakePolicy) Name() string       { return core.NamePolicy }
func (f *fakePolicy) Sections() []string { return []string{core.SectionPolicy} }
func (f *fakePolicy) BootstrapSections(_ context.Context, bc *core.BootstrapContext) (map[string]any, error) {
	f.mu.Lock()
	f.contexts = append(f.contexts, *bc)
	f.mu.Unlock()
	if f.panics {
		panic("boom")
	}
	if f.err != nil {
		return nil, f.err
	}
	if f.section == nil {
		return map[string]any{}, nil
	}
	return map[string]any{core.SectionPolicy: f.section}, nil
}

func policySection(webSearch, xSearch bool) map[string]any {
	return map[string]any{
		"web_search": webSearch,
		"research":   map[string]any{"enabled": webSearch, "x_search": xSearch, "max_searches_per_turn": 30},
	}
}

func newGuard(components ...core.Feature) *Guard {
	return New(&core.Env{Components: components})
}

func groupID(v int64) *int64 { return &v }

func deviceKey() *service.APIKey {
	return &service.APIKey{ID: 501, UserID: 42, GroupID: groupID(7)}
}

// request builds a gin context for a POST; device marks it as a Claudex
// device-key request (what B4's KeyMarker does).
func request(t *testing.T, path, contentType, body string, device bool) (*gin.Context, *httptest.ResponseRecorder) {
	t.Helper()
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	c.Request = httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	if contentType != "" {
		c.Request.Header.Set("Content-Type", contentType)
	}
	if device {
		gatewayhook.MarkDevice(c, &gatewayhook.DeviceRef{ID: 3, UserID: 42, APIKeyID: 501, GroupID: groupID(7), Platform: "darwin"})
	}
	return c, rec
}

func readBody(t *testing.T, c *gin.Context) string {
	t.Helper()
	b, err := io.ReadAll(c.Request.Body)
	require.NoError(t, err)
	return string(b)
}

const (
	webSearchBody  = `{"model":"gpt-5.5","input":"hi","tools":[{"type":"function","name":"f"},{"type":"web_search","external_web_access":true}],"include":["web_search_call.action.sources"]}`
	xSearchBody    = `{"model":"grok-4.3","input":"hi","tools":[{"type":"x_search"}],"include":["x_search_call.action.sources"]}`
	plainBody      = `{"model":"gpt-5.5","input":"search for nothing","tools":[{"type":"function","name":"web_search_helper"}]}`
	additionalBody = `{"model":"gpt-5.5","input":[{"type":"additional_tools","tools":[{"type":"web_search_preview"}]},{"type":"message","role":"user","content":"hi"}]}`
)

func TestGuardIsARequestGuardAfterUsageRules(t *testing.T) {
	var g any = New(nil)
	rg, ok := g.(gatewayhook.RequestGuard)
	require.True(t, ok, "the module registers the guard only when it implements RequestGuard")
	require.Equal(t, gatewayhook.PriorityWebSearch, rg.Priority())
	require.Greater(t, rg.Priority(), gatewayhook.PriorityUsageRules)
	require.Equal(t, core.NameWebSearchGuard, New(nil).Name())
}

func TestWebSearchOffRefusesDeviceKeyRequests(t *testing.T) {
	pol := &fakePolicy{section: policySection(false, false)}
	g := newGuard(pol)
	for _, tc := range []struct{ name, path, body string }{
		{"responses", "/v1/responses", webSearchBody},
		{"root alias", "/responses", webSearchBody},
		{"codex direct", "/backend-api/codex/responses", webSearchBody},
		{"x search", "/v1/responses", xSearchBody},
		{"additional tools carrier", "/v1/responses", additionalBody},
		{"dated preview tool", "/v1/responses", `{"tools":[{"type":"web_search_preview_2025_03_11"}]}`},
		{"anthropic web search", "/v1/messages", `{"tools":[{"type":"web_search_20250305","name":"web_search"}]}`},
		{"chat web_search_options", "/v1/chat/completions", `{"model":"gpt-5.5","messages":[],"web_search_options":{}}`},
		{"xai search_parameters", "/v1/chat/completions", `{"model":"grok-4.3","messages":[],"search_parameters":{"mode":"auto"}}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, rec := request(t, tc.path, "application/json", tc.body, true)
			require.True(t, g.OnRequest(c, deviceKey()))
			require.True(t, c.IsAborted())
			require.Equal(t, http.StatusForbidden, rec.Code)
			var out struct {
				Error struct{ Type, Code, Message string } `json:"error"`
			}
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
			require.Equal(t, "permission_error", out.Error.Type)
			require.Equal(t, CodeWebSearchDisabled, out.Error.Code)
			require.Equal(t, MessageWebSearchDisabled, out.Error.Message)
			d := gatewayhook.PresetDetail(c)
			require.NotNil(t, d)
			require.Equal(t, ReasonWebSearchDisabled, d.Reason)
			require.Equal(t, "policy", d.Kind)
			require.Equal(t, "none", d.Action)
			require.False(t, d.Reprovision)
		})
	}
	// The policy is resolved for the user, the key's group and the device platform.
	require.NotEmpty(t, pol.contexts)
	bc := pol.contexts[0]
	require.Equal(t, int64(42), bc.UserID)
	require.Equal(t, "darwin", bc.Platform)
	require.NotNil(t, bc.Plan)
	require.Equal(t, int64(7), bc.Plan.GroupID)
}

func TestWebSearchOnAllowsSearchAndKeepsTheBody(t *testing.T) {
	g := newGuard(&fakePolicy{section: policySection(true, true)})
	for _, body := range []string{webSearchBody, xSearchBody, additionalBody} {
		c, _ := request(t, "/v1/responses", "application/json", body, true)
		require.False(t, g.OnRequest(c, deviceKey()))
		require.False(t, c.IsAborted())
		require.False(t, c.Writer.Written())
		require.Equal(t, body, readBody(t, c), "the handler reads the same bytes")
	}
}

func TestXSearchOffRefusesOnlyXSearch(t *testing.T) {
	g := newGuard(&fakePolicy{section: policySection(true, false)})

	c, rec := request(t, "/v1/responses", "application/json", xSearchBody, true)
	require.True(t, g.OnRequest(c, deviceKey()))
	require.Equal(t, http.StatusForbidden, rec.Code)
	require.Contains(t, rec.Body.String(), CodeWebSearchDisabled)
	require.Equal(t, ReasonXSearchDisabled, gatewayhook.PresetDetail(c).Reason)
	require.Equal(t, MessageXSearchDisabled, gatewayhook.PresetDetail(c).Message)

	c, _ = request(t, "/v1/responses", "application/json", webSearchBody, true)
	require.False(t, g.OnRequest(c, deviceKey()), "web search stays allowed")

	both := `{"tools":[{"type":"web_search"},{"type":"x_search"}]}`
	c, _ = request(t, "/v1/responses", "application/json", both, true)
	require.True(t, g.OnRequest(c, deviceKey()))
}

func TestUserAPIKeysAndOtherRequestsPass(t *testing.T) {
	pol := &fakePolicy{section: policySection(false, false)}
	g := newGuard(pol)

	// A user's own API key (no device mark) is never checked.
	c, _ := request(t, "/v1/responses", "application/json", webSearchBody, false)
	require.False(t, g.OnRequest(c, deviceKey()))
	require.Equal(t, webSearchBody, readBody(t, c))

	// A revoked device is B4's refusal, not this guard's.
	c, _ = request(t, "/v1/responses", "application/json", webSearchBody, false)
	gatewayhook.MarkDevice(c, &gatewayhook.DeviceRef{ID: 3, UserID: 42, Revoked: true})
	require.False(t, g.OnRequest(c, deviceKey()))

	// No search asked: passes without resolving the policy.
	for _, body := range []string{
		plainBody,
		`{"model":"gpt-5.5","input":"hi"}`,
		`{"model":"grok-4.3","messages":[],"search_parameters":{"mode":"off"}}`,
		`{"model":"gpt-5.5","messages":[],"web_search_options":null}`,
		`not json but mentions web_search`,
		`["web_search"]`,
	} {
		c, _ = request(t, "/v1/responses", "application/json", body, true)
		require.False(t, g.OnRequest(c, deviceKey()), body)
		require.Equal(t, body, readBody(t, c))
	}

	// Real multipart uploads are not inspected, and their bytes are kept.
	upload := "--x\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.wav\"\r\n\r\n" +
		strings.Repeat("web_search ", 200) + "\r\n--x--\r\n"
	c, _ = request(t, "/v1/audio/transcriptions", "multipart/form-data; boundary=x", upload, true)
	require.False(t, g.OnRequest(c, deviceKey()))
	require.Equal(t, upload, readBody(t, c))

	// GET (a WebSocket handshake) has no body to inspect.
	rec := httptest.NewRecorder()
	c, _ = gin.CreateTestContext(rec)
	c.Request = httptest.NewRequest(http.MethodGet, "/v1/responses", nil)
	gatewayhook.MarkDevice(c, &gatewayhook.DeviceRef{ID: 3, UserID: 42})
	require.False(t, g.OnRequest(c, deviceKey()))

	require.Empty(t, pol.contexts, "the policy is only resolved for search requests")
}

func TestJSONUnderAnyNonFormContentTypeIsChecked(t *testing.T) {
	g := newGuard(&fakePolicy{section: policySection(false, false)})
	for _, ct := range []string{"", "text/plain", "application/json; charset=utf-8", "application/vnd.api+json", "bogus;;"} {
		c, _ := request(t, "/v1/responses", ct, webSearchBody, true)
		require.True(t, g.OnRequest(c, deviceKey()), ct)
	}
	// The JSON handlers ignore the declared type: a JSON body labelled as a
	// form is checked too.
	for _, ct := range []string{"application/x-www-form-urlencoded", "multipart/form-data; boundary=x"} {
		c, _ := request(t, "/v1/responses", ct, "  \n"+webSearchBody, true)
		require.True(t, g.OnRequest(c, deviceKey()), ct)
	}
	// A form body that is not JSON passes untouched.
	c, _ := request(t, "/v1/responses", "application/x-www-form-urlencoded", "a=web_search&b=1", true)
	require.False(t, g.OnRequest(c, deviceKey()))
	require.Equal(t, "a=web_search&b=1", readBody(t, c))
}

// Bodies that encoding/json (the upstream decoder) reads as search requests
// must not slip past through spelling: letter case of keys and values,
// \u escapes, duplicate keys.
func TestSpellingsCannotBypassTheGuard(t *testing.T) {
	g := newGuard(&fakePolicy{section: policySection(false, false)})
	for _, body := range []string{
		`{"Tools":[{"type":"web_search"}]}`,
		`{"TOOLS":[{"Type":"WEB_SEARCH"}]}`,
		`{"tools":[{"type":"web_\u0073earch"}]}`,
		`{"\u0074ools":[{"type":"web_\u0053EARCH"}]}`,
		`{"tools":[],"tools":[{"type":"web_search"}]}`,
		`{"tools":[{"type":"web_search"}],"tools":[]}`,
		`{"tools":[{"type":"function","type":"web_search"}]}`,
		`{"input":[{"Type":"Additional_Tools","Tools":[{"type":"x_search"}]}]}`,
		`{"input":[{"type":"message","type":"additional_tools","tools":[{"type":"web_search"}]}]}`,
		`{"Web_Search_Options":{}}`,
		`{"search_parameters":{"mode":"off","mode":"on"}}`,
		`{"SEARCH_PARAMETERS":{"Mode":"auto"}}`,
	} {
		c, _ := request(t, "/v1/responses", "application/json", body, true)
		require.True(t, g.OnRequest(c, deviceKey()), body)
	}
}

type namedOnly struct{}

func (namedOnly) Name() string { return core.NamePolicy }

func TestUnresolvablePolicyLetsTheRequestThrough(t *testing.T) {
	for name, g := range map[string]*Guard{
		"no env":            New(nil),
		"no component":      newGuard(),
		"error":             newGuard(&fakePolicy{err: errors.New("db down")}),
		"panic":             newGuard(&fakePolicy{panics: true}),
		"no section":        newGuard(&fakePolicy{}),
		"no web_search":     newGuard(&fakePolicy{section: map[string]any{"research": map[string]any{}}}),
		"not an object":     newGuard(&fakePolicy{section: "nope"}),
		"not a contributor": newGuard(namedOnly{}),
	} {
		c, rec := request(t, "/v1/responses", "application/json", webSearchBody, true)
		require.False(t, g.OnRequest(c, deviceKey()), name)
		require.False(t, c.Writer.Written(), name)
		require.Equal(t, http.StatusOK, rec.Code, name)
		require.Equal(t, webSearchBody, readBody(t, c), name)
	}
}

func TestMissingXSearchFieldFollowsWebSearch(t *testing.T) {
	g := newGuard(&fakePolicy{section: map[string]any{"web_search": true}})
	c, _ := request(t, "/v1/responses", "application/json", xSearchBody, true)
	require.False(t, g.OnRequest(c, deviceKey()))
}

func TestGroupComesFromTheKeyThenTheDevice(t *testing.T) {
	pol := &fakePolicy{section: policySection(true, true)}
	g := newGuard(pol)
	c, _ := request(t, "/v1/responses", "application/json", webSearchBody, true)
	require.False(t, g.OnRequest(c, &service.APIKey{ID: 501, User: &service.User{ID: 42}}))
	require.Equal(t, int64(7), pol.contexts[0].Plan.GroupID, "the device's group when the key has none")
	require.Equal(t, int64(42), pol.contexts[0].UserID)

	c, _ = request(t, "/v1/responses", "application/json", webSearchBody, true)
	require.False(t, g.OnRequest(c, &service.APIKey{ID: 502, UserID: 42, Group: &service.Group{ID: 9}}))
	require.Equal(t, int64(9), pol.contexts[1].Plan.GroupID, "the key actually used decides the group (one key per group)")
}

// memSettings is an in-memory service.SettingRepository for the real
// client-policy component.
type memSettings struct{ values map[string]string }

func (r *memSettings) Get(ctx context.Context, key string) (*service.Setting, error) {
	v, err := r.GetValue(ctx, key)
	if err != nil {
		return nil, err
	}
	return &service.Setting{Key: key, Value: v}, nil
}

func (r *memSettings) GetValue(_ context.Context, key string) (string, error) {
	v, ok := r.values[key]
	if !ok {
		return "", service.ErrSettingNotFound
	}
	return v, nil
}

func (r *memSettings) Set(_ context.Context, key, value string) error {
	r.values[key] = value
	return nil
}

func (r *memSettings) GetMultiple(_ context.Context, keys []string) (map[string]string, error) {
	out := map[string]string{}
	for _, k := range keys {
		if v, ok := r.values[k]; ok {
			out[k] = v
		}
	}
	return out, nil
}

func (r *memSettings) SetMultiple(context.Context, map[string]string) error { return nil }

func (r *memSettings) GetAll(context.Context) (map[string]string, error) { return r.values, nil }

func (r *memSettings) Delete(_ context.Context, key string) error {
	delete(r.values, key)
	return nil
}

// The guard reads the real client-policy component: defaults, group and user
// overrides apply exactly as for the desktop client.
func TestRealPolicyComponent(t *testing.T) {
	doc := `{"version":1,"revision":3,"defaults":{},
"group_overrides":{"7":{"web_search":false},"8":{"research":{"x_search":false}}},
"user_overrides":{"43":{"web_search":true}}}`
	repo := &memSettings{values: map[string]string{policy.SettingKey: doc}}
	env := &core.Env{Deps: core.Deps{SettingRepo: repo}}
	env.Components = []core.Feature{policy.New(env)}
	g := New(env)

	check := func(userID, group int64, body string) bool {
		c, _ := request(t, "/v1/responses", "application/json", body, true)
		return g.OnRequest(c, &service.APIKey{ID: 1, UserID: userID, GroupID: groupID(group)})
	}
	require.True(t, check(42, 7, webSearchBody), "group 7 turns web search off")
	require.True(t, check(42, 7, xSearchBody), "X search needs web search")
	require.False(t, check(43, 7, webSearchBody), "the user override turns it back on")
	require.False(t, check(42, 1, webSearchBody), "other groups keep the built-in default (on)")
	require.False(t, check(42, 1, xSearchBody))
	require.True(t, check(42, 8, xSearchBody), "group 8 turns X search off")
	require.False(t, check(42, 8, webSearchBody))
}

// Through the gateway chain: the guard registered like the module does, and
// EnrichRefusals adds the preset detail to the 403 for the desktop client.
func TestChainAddsTheRefusalDetail(t *testing.T) {
	gatewayhook.Reset()
	t.Cleanup(gatewayhook.Reset)
	gatewayhook.RegisterRequestGuard(newGuard(&fakePolicy{section: policySection(false, false)}))

	r := gin.New()
	r.Use(gatewayhook.EnrichRefusals())
	handled := false
	r.POST("/v1/responses", func(c *gin.Context) {
		gatewayhook.MarkDevice(c, &gatewayhook.DeviceRef{ID: 3, UserID: 42, APIKeyID: 501, GroupID: groupID(7)})
		if gatewayhook.KeyAuthorized(c, deviceKey()) {
			return
		}
		handled = true
		body, _ := io.ReadAll(c.Request.Body)
		c.Data(http.StatusOK, "application/json", body)
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(webSearchBody))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(rec, req)
	require.False(t, handled)
	require.Equal(t, http.StatusForbidden, rec.Code)
	var out struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
		Claudex struct {
			V       int    `json:"v"`
			Reason  string `json:"reason"`
			Kind    string `json:"kind"`
			Action  string `json:"action"`
			Message string `json:"message"`
		} `json:"claudex"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	require.Equal(t, CodeWebSearchDisabled, out.Error.Code)
	require.Equal(t, 1, out.Claudex.V)
	require.Equal(t, ReasonWebSearchDisabled, out.Claudex.Reason)
	require.Equal(t, "policy", out.Claudex.Kind)
	require.Equal(t, "none", out.Claudex.Action)
	require.Equal(t, MessageWebSearchDisabled, out.Claudex.Message)

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(plainBody))
	r.ServeHTTP(rec, req)
	require.True(t, handled)
	require.Equal(t, http.StatusOK, rec.Code)
	require.Equal(t, plainBody, rec.Body.String(), "the handler got the whole body")
}

func TestSearchToolKind(t *testing.T) {
	for in, want := range map[string]string{
		"web_search": "web", " WEB_SEARCH ": "web", "web_search_preview": "web",
		"web_search_2025_08_26": "web", "web_search_20250305": "web",
		"x_search": "x", "x_search_2026": "x",
		"function": "", "websearch": "", "": "", "file_search": "", "tool_search": "",
	} {
		require.Equal(t, want, searchToolKind(in), in)
	}
}
