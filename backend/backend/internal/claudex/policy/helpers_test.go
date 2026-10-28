package policy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// memSettings is an in-memory service.SettingRepository.
type memSettings struct {
	mu       sync.Mutex
	values   map[string]string
	getErr   error
	multiErr error
}

func newMemSettings() *memSettings { return &memSettings{values: map[string]string{}} }

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
	if r.getErr != nil {
		return "", r.getErr
	}
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
	if r.multiErr != nil {
		return nil, r.multiErr
	}
	out := map[string]string{}
	for _, k := range keys {
		if v, ok := r.values[k]; ok {
			out[k] = v
		}
	}
	return out, nil
}

func (r *memSettings) SetMultiple(context.Context, map[string]string) error {
	return errors.New("not used")
}

func (r *memSettings) GetAll(context.Context) (map[string]string, error) {
	return nil, errors.New("not used")
}

func (r *memSettings) Delete(context.Context, string) error { return errors.New("not used") }

func (r *memSettings) value(key string) (string, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	v, ok := r.values[key]
	return v, ok
}

func (r *memSettings) put(key, value string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.values[key] = value
}

// fakeGroups implements the one GroupRepository method the component uses.
type fakeGroups struct {
	service.GroupRepository
	mu     sync.Mutex
	groups map[int64]string
	err    error
}

func (f *fakeGroups) GetByIDLite(_ context.Context, id int64) (*service.Group, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return nil, f.err
	}
	name, ok := f.groups[id]
	if !ok {
		return nil, service.ErrGroupNotFound
	}
	return &service.Group{ID: id, Name: name}, nil
}

// fakeUsers implements the one UserRepository method the component uses.
type fakeUsers struct {
	service.UserRepository
	mu    sync.Mutex
	users map[int64]string
	err   error
}

func (f *fakeUsers) GetByID(_ context.Context, id int64) (*service.User, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return nil, f.err
	}
	email, ok := f.users[id]
	if !ok {
		return nil, service.ErrUserNotFound
	}
	return &service.User{ID: id, Email: email}, nil
}

// fakePlans resolves plans like B4 promises: the requested group when the
// user may use it, otherwise the user's plan group, ErrNoPlan without one.
type fakePlans struct {
	mu      sync.Mutex
	plan    map[int64]int64   // user -> plan group
	allowed map[int64][]int64 // user -> usable groups
	err     error
	calls   []*int64
}

func (f *fakePlans) ResolvePlan(_ context.Context, userID int64, requested *int64) (*core.PlanRef, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, requested)
	if f.err != nil {
		return nil, f.err
	}
	if requested != nil {
		for _, g := range f.allowed[userID] {
			if g == *requested {
				return &core.PlanRef{GroupID: g}, nil
			}
		}
	}
	g, ok := f.plan[userID]
	if !ok {
		return nil, core.ErrNoPlan
	}
	return &core.PlanRef{GroupID: g}, nil
}

// fixture bundles a component with its fakes.
type fixture struct {
	t        *testing.T
	c        *Component
	settings *memSettings
	groups   *fakeGroups
	users    *fakeUsers
	plans    *fakePlans
	now      time.Time
	engine   *gin.Engine
	stepUp   gin.HandlerFunc
	audit    map[string]any
	auditMu  sync.Mutex
	// beforeSwap runs inside the swap (tests use it as a barrier).
	beforeSwap func()
}

const adminID = 1

func newFixture(t *testing.T) *fixture {
	t.Helper()
	gin.SetMode(gin.TestMode)
	f := &fixture{
		t:        t,
		settings: newMemSettings(),
		groups:   &fakeGroups{groups: map[int64]string{3: "claudex-standard", 4: "claudex-pro"}},
		users:    &fakeUsers{users: map[int64]string{123: "a@example.com", 200: "b@example.com", 300: "c@example.com"}},
		plans: &fakePlans{
			plan:    map[int64]int64{123: 4, 200: 4, 300: 3},
			allowed: map[int64][]int64{123: {3, 4}, 200: {4}, 300: {3}},
		},
		now: time.Date(2026, 9, 26, 2, 0, 0, 0, time.UTC),
	}
	env := &core.Env{
		Deps: core.Deps{SettingRepo: f.settings, GroupRepo: f.groups, UserRepo: f.users},
		Now:  func() time.Time { return f.now },
	}
	env.Peers.Plans = f.plans
	f.c = New(env)
	// The real swap is one SQL statement (see the integration test); here the
	// same compare-and-swap runs on the in-memory settings under its lock.
	f.c.swap = func(_ context.Context, expectedRaw string, next Document) (Document, bool, error) {
		if f.beforeSwap != nil {
			f.beforeSwap()
		}
		normalizeDocument(&next)
		if err := validateDocument(&next); err != nil {
			return Document{}, false, err
		}
		data, err := json.Marshal(next)
		if err != nil {
			return Document{}, false, err
		}
		f.settings.mu.Lock()
		cur, exists := f.settings.values[SettingKey]
		ok := (expectedRaw == "" && (!exists || cur == "")) || (expectedRaw != "" && exists && cur == expectedRaw)
		if ok {
			f.settings.values[SettingKey] = string(data)
		}
		f.settings.mu.Unlock()
		if !ok {
			return Document{}, false, nil
		}
		f.c.setting.Invalidate()
		return next, true, nil
	}
	f.stepUp = func(c *gin.Context) { c.Next() }
	f.buildEngine()
	return f
}

// buildEngine registers the routes like the module: user routes read the
// user id from X-Test-User (the JWT middleware's job), admin routes run as
// adminID; an outer middleware records the audit extras.
func (f *fixture) buildEngine() {
	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Next()
		if v, ok := c.Get("audit_extra"); ok {
			if m, ok := v.(map[string]any); ok {
				f.auditMu.Lock()
				f.audit = m
				f.auditMu.Unlock()
			}
		}
	})
	user := r.Group("/api/v1/claudex", func(c *gin.Context) {
		if id, err := strconv.ParseInt(c.GetHeader("X-Test-User"), 10, 64); err == nil {
			c.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: id})
		}
		c.Next()
	})
	f.c.RegisterUserRoutes(user)
	admin := r.Group("/api/v1/admin", func(c *gin.Context) {
		c.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: adminID})
		c.Next()
	})
	f.c.RegisterAdminRoutes(admin.Group("/claudex"), func(c *gin.Context) { f.stepUp(c) })
	f.engine = r
}

type reply struct {
	status  int
	header  http.Header
	body    []byte
	env     map[string]json.RawMessage
	data    json.RawMessage
	reason  string
	field   string
	rule    string
	message string
}

func (f *fixture) do(method, path string, body any, headers map[string]string) reply {
	f.t.Helper()
	var rd *bytes.Reader
	switch b := body.(type) {
	case nil:
		rd = bytes.NewReader(nil)
	case string:
		rd = bytes.NewReader([]byte(b))
	case []byte:
		rd = bytes.NewReader(b)
	default:
		data, err := json.Marshal(b)
		require.NoError(f.t, err)
		rd = bytes.NewReader(data)
	}
	req := httptest.NewRequest(method, path, rd)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	f.engine.ServeHTTP(w, req)
	out := reply{status: w.Code, header: w.Header(), body: w.Body.Bytes()}
	if len(out.body) > 0 {
		require.NoError(f.t, json.Unmarshal(out.body, &out.env), "body: %s", out.body)
		out.data = out.env["data"]
		if raw, ok := out.env["reason"]; ok {
			_ = json.Unmarshal(raw, &out.reason)
		}
		if raw, ok := out.env["message"]; ok {
			_ = json.Unmarshal(raw, &out.message)
		}
		if raw, ok := out.env["metadata"]; ok {
			var md map[string]string
			_ = json.Unmarshal(raw, &md)
			out.field, out.rule = md["field"], md["rule"]
		}
	}
	return out
}

func (f *fixture) getPolicy(userID int64, query string, headers map[string]string) reply {
	f.t.Helper()
	h := map[string]string{"X-Test-User": strconv.FormatInt(userID, 10)}
	for k, v := range headers {
		h[k] = v
	}
	path := "/api/v1/claudex/policy"
	if query != "" {
		path += "?" + query
	}
	return f.do(http.MethodGet, path, nil, h)
}

func (f *fixture) put(body any) reply {
	f.t.Helper()
	return f.do(http.MethodPut, "/api/v1/admin/claudex/policy", body, nil)
}

func (f *fixture) preview(body any) reply {
	f.t.Helper()
	return f.do(http.MethodPost, "/api/v1/admin/claudex/policy/preview", body, nil)
}

func (f *fixture) adminGet() reply {
	f.t.Helper()
	return f.do(http.MethodGet, "/api/v1/admin/claudex/policy", nil, nil)
}

// store writes a raw stored document and drops the node cache.
func (f *fixture) store(raw string) {
	f.settings.put(SettingKey, raw)
	f.c.setting.Invalidate()
}

func (f *fixture) storedDocument() Document {
	f.t.Helper()
	raw, ok := f.settings.value(SettingKey)
	require.True(f.t, ok, "policy not stored")
	var d Document
	require.NoError(f.t, json.Unmarshal([]byte(raw), &d))
	return d
}

// designDocument is the stored example of design 2.3.
const designDocument = `{
  "version": 1,
  "revision": 17,
  "updated_at": "2026-09-26T02:00:00Z",
  "updated_by": 1,
  "defaults": {
    "permission_modes": {"default": ["auto","manual","acceptEdits","plan"], "win32": ["manual","plan"]},
    "web_search_default": false,
    "attachments": {"max_megabytes": 10, "types": ["png","jpg","jpeg","webp","gif","txt","md","csv","json","py","ts"]},
    "links": {"help": "https://docs.example.com", "get_more_usage": "https://claudex.example.com/plans",
              "learn_more": [{"label": "Usage policy", "url": "https://claudex.example.com/policy"}]},
    "usage_banner": {"warn_percent": 80}
  },
  "group_overrides": {
    "4": {"permission_modes": ["auto","manual","acceptEdits","plan"], "plan_label": "Max",
          "connectors": [{"name": "github", "url_prefix": "https://api.githubcopilot.com/mcp"}, "linear"]},
    "3": {"plan_label": "Pro", "voice": false}
  },
  "user_overrides": {
    "123": {"external_links": false, "trusted_link_domains": ["docs.example.com", "*.example.org"]}
  }
}`

// captureLogs sends slog output to a buffer for the test.
func captureLogs(t *testing.T) *syncBuffer {
	t.Helper()
	buf := &syncBuffer{}
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return buf
}

type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// jsonEq compares two JSON texts structurally.
func jsonEq(t *testing.T, want, got string, msgAndArgs ...any) {
	t.Helper()
	require.JSONEq(t, want, got, msgAndArgs...)
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	data, err := json.Marshal(v)
	require.NoError(t, err)
	return string(data)
}

func containsFold(s, sub string) bool {
	return strings.Contains(strings.ToLower(s), strings.ToLower(sub))
}
