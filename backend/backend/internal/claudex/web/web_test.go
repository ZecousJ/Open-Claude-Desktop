package web

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
	"github.com/Wei-Shaw/sub2api/internal/config"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"

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

func (r *memSettings) SetMultiple(context.Context, map[string]string) error {
	return errors.New("not used")
}
func (r *memSettings) GetAll(context.Context) (map[string]string, error) {
	return nil, errors.New("not used")
}
func (r *memSettings) Delete(context.Context, string) error { return errors.New("not used") }

// fakeBackend answers the upstream flows.
type fakeBackend struct {
	core.WebAuthBackend
	user      *service.User
	challenge any
	err       error
	calls     int
	codeUser  *service.User
}

func (f *fakeBackend) Login(*gin.Context) (*service.User, any, error) {
	f.calls++
	return f.user, f.challenge, f.err
}

func (f *fakeBackend) SendCode(*gin.Context) (any, error) {
	f.calls++
	return gin.H{"countdown": 60}, f.err
}

func (f *fakeBackend) CodeLogin(_ *gin.Context, u *service.User) (*service.User, any, error) {
	f.calls++
	f.codeUser = u
	if f.err != nil || f.challenge != nil {
		return nil, f.challenge, f.err
	}
	return u, nil, nil
}

// fakeEmailCodes stands in for the signin component.
type fakeEmailCodes struct {
	user   *service.User
	err    error
	sends  int
	origin string
}

func (f *fakeEmailCodes) SendEmailCode(g *gin.Context) (any, error) {
	f.sends++
	f.origin = g.GetString(core.EmailLinkOriginKey)
	if f.err != nil {
		return nil, f.err
	}
	return gin.H{"countdown": 60}, nil
}

func (f *fakeEmailCodes) VerifyEmailCode(*gin.Context) (*service.User, error) {
	return f.user, f.err
}

type fixture struct {
	t        *testing.T
	c        *Component
	settings *memSettings
	backend  *fakeBackend
	engine   *gin.Engine
}

const testOrigin = "https://claudex.example.com"

func newFixture(t *testing.T, stored *Settings) *fixture {
	t.Helper()
	gin.SetMode(gin.TestMode)
	f := &fixture{t: t, settings: &memSettings{values: map[string]string{}}, backend: &fakeBackend{}}
	if stored != nil {
		data, err := json.Marshal(stored)
		require.NoError(t, err)
		f.settings.values[SettingKey] = string(data)
	}
	cfg := &config.Config{}
	cfg.Server.FrontendURL = testOrigin
	cfg.JWT.RefreshTokenExpireDays = 7
	env := &core.Env{Deps: core.Deps{SettingRepo: f.settings, Config: cfg}}
	env.Now = func() time.Time { return time.Date(2026, 9, 28, 8, 0, 0, 0, time.UTC) }
	f.c = New(env)
	f.c.backend = f.backend

	r := gin.New()
	f.c.RegisterPublicRoutes(r.Group("/api/v1/claudex"))
	user := r.Group("/api/v1/claudex", func(c *gin.Context) {
		if id, err := strconv.ParseInt(c.GetHeader("X-Test-User"), 10, 64); err == nil {
			c.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: id})
		}
		c.Next()
	})
	f.c.RegisterUserRoutes(user)
	admin := r.Group("/api/v1/admin", func(c *gin.Context) {
		c.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: 1})
		c.Next()
	})
	f.c.RegisterAdminRoutes(admin.Group("/claudex"), func(c *gin.Context) { c.Next() })
	f.engine = r
	return f
}

type reply struct {
	status int
	header http.Header
	reason string
	data   json.RawMessage
}

func (f *fixture) do(method, path, body string, headers map[string]string) reply {
	f.t.Helper()
	req := httptest.NewRequest(method, path, bytes.NewReader([]byte(body)))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	f.engine.ServeHTTP(w, req)
	out := reply{status: w.Code, header: w.Header()}
	var env struct {
		Reason string          `json:"reason"`
		Data   json.RawMessage `json:"data"`
	}
	if w.Body.Len() > 0 {
		require.NoError(f.t, json.Unmarshal(w.Body.Bytes(), &env), "body: %s", w.Body.String())
	}
	out.reason, out.data = env.Reason, env.Data
	return out
}

func webHeaders() map[string]string {
	return map[string]string{webproto.HeaderWeb: "1", "Origin": testOrigin}
}

func (f *fixture) auth(name, body string, headers map[string]string) reply {
	return f.do(http.MethodPost, webproto.PathAuth+name, body, headers)
}

var enabled = &Settings{Enabled: true, Mode: ModeEveryone, MaxSessionsPerUser: 10, Revision: 1}

func TestCSRF(t *testing.T) {
	f := newFixture(t, enabled)
	cases := []struct {
		name    string
		headers map[string]string
		ok      bool
	}{
		{"no header", map[string]string{"Origin": testOrigin}, false},
		{"wrong header", map[string]string{webproto.HeaderWeb: "true", "Origin": testOrigin}, false},
		{"foreign origin", map[string]string{webproto.HeaderWeb: "1", "Origin": "https://evil.example"}, false},
		{"null origin", map[string]string{webproto.HeaderWeb: "1", "Origin": "null"}, false},
		{"scheme mismatch", map[string]string{webproto.HeaderWeb: "1", "Origin": "http://claudex.example.com"}, false},
		{"no origin cross-site", map[string]string{webproto.HeaderWeb: "1", "Sec-Fetch-Site": "cross-site"}, false},
		{"no origin nothing", map[string]string{webproto.HeaderWeb: "1"}, false},
		{"same origin", webHeaders(), true},
		{"default port", map[string]string{webproto.HeaderWeb: "1", "Origin": "HTTPS://Claudex.Example.com:443"}, true},
		{"sec-fetch fallback", map[string]string{webproto.HeaderWeb: "1", "Sec-Fetch-Site": "same-origin"}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := f.auth(webproto.AuthSendCode, `{}`, tc.headers)
			if tc.ok {
				require.Equal(t, http.StatusOK, r.status)
			} else {
				require.Equal(t, http.StatusForbidden, r.status)
				require.Equal(t, webproto.ErrCodeBadRequest, r.reason)
			}
		})
	}
}

func TestRequestOriginFallbackTrustedProxy(t *testing.T) {
	gin.SetMode(gin.TestMode)
	cfg := &config.Config{}
	c := New(&core.Env{Deps: core.Deps{Config: cfg}})
	mk := func(remote string) *gin.Context {
		w := httptest.NewRecorder()
		g, _ := gin.CreateTestContext(w)
		g.Request = httptest.NewRequest(http.MethodPost, "http://app.example/x", nil)
		g.Request.RemoteAddr = remote + ":1234"
		g.Request.Header.Set("X-Forwarded-Proto", "https")
		return g
	}
	// No trusted proxies: a client cannot claim https.
	require.Equal(t, "http://app.example", c.siteOrigin(mk("10.0.0.5")))
	cfg.Server.TrustedProxiesConfigured = true
	cfg.Server.TrustedProxies = []string{"10.0.0.0/8"}
	require.Equal(t, "https://app.example", c.siteOrigin(mk("10.0.0.5")))
	require.Equal(t, "http://app.example", c.siteOrigin(mk("192.168.1.9")))
}

func TestDisabled(t *testing.T) {
	f := newFixture(t, nil)
	r := f.auth(webproto.AuthLogin, `{}`, webHeaders())
	require.Equal(t, http.StatusForbidden, r.status)
	require.Equal(t, webproto.ErrCodeDisabled, r.reason)
	require.Zero(t, f.backend.calls)

	r = f.do(http.MethodGet, webproto.PathBase+"/sessions", "", map[string]string{"X-Test-User": "5"})
	require.Equal(t, http.StatusForbidden, r.status)
	require.Equal(t, webproto.ErrCodeDisabled, r.reason)
}

func TestLoginChallengePassesThrough(t *testing.T) {
	f := newFixture(t, enabled)
	f.backend.challenge = gin.H{"requires_2fa": true, "temp_token": "t"}
	r := f.auth(webproto.AuthLogin, `{}`, webHeaders())
	require.Equal(t, http.StatusOK, r.status)
	require.JSONEq(t, `{"requires_2fa":true,"temp_token":"t"}`, string(r.data))
	require.Empty(t, r.header.Values("Set-Cookie"))
}

func TestEmailCodeRoutes(t *testing.T) {
	require.True(t, selfService[webproto.AuthEmailCodeSend], "backend mode blocks sending codes")
	require.False(t, selfService[webproto.AuthEmailCodeLogin])

	// No signin component: 503.
	f := newFixture(t, enabled)
	r := f.auth(webproto.AuthEmailCodeSend, `{"email":"a@example.com"}`, webHeaders())
	require.Equal(t, http.StatusServiceUnavailable, r.status)

	ec := &fakeEmailCodes{}
	f.c.emailCodes = ec
	r = f.auth(webproto.AuthEmailCodeSend, `{"email":"a@example.com"}`, webHeaders())
	require.Equal(t, http.StatusOK, r.status)
	require.JSONEq(t, `{"countdown":60}`, string(r.data))
	require.Equal(t, 1, ec.sends)
	require.Equal(t, testOrigin, ec.origin)

	// CSRF first.
	r = f.auth(webproto.AuthEmailCodeSend, `{}`, map[string]string{"Origin": "https://evil.example"})
	require.Equal(t, http.StatusForbidden, r.status)
	require.Equal(t, 1, ec.sends)

	// A wrong code: the signin error as is, no upstream login.
	ec.err = infraErr400("CLAUDEX_EMAIL_CODE_INVALID")
	r = f.auth(webproto.AuthEmailCodeLogin, `{"email":"a@example.com","code":"000000"}`, webHeaders())
	require.Equal(t, http.StatusBadRequest, r.status)
	require.Equal(t, "CLAUDEX_EMAIL_CODE_INVALID", r.reason)
	require.Zero(t, f.backend.calls)

	// 2FA: the challenge passes through like login (auth/2fa completes it).
	ec.err = nil
	ec.user = &service.User{ID: 5, Email: "a@example.com", Role: service.RoleUser, Status: service.StatusActive}
	f.backend.challenge = gin.H{"requires_2fa": true, "temp_token": "t"}
	r = f.auth(webproto.AuthEmailCodeLogin, `{"email":"a@example.com","code":"123456"}`, webHeaders())
	require.Equal(t, http.StatusOK, r.status)
	require.JSONEq(t, `{"requires_2fa":true,"temp_token":"t"}`, string(r.data))
	require.Empty(t, r.header.Values("Set-Cookie"))
	require.Equal(t, int64(5), f.backend.codeUser.ID)

	// Signed in: the same session checks as login (allowlist here).
	g := newFixture(t, &Settings{Enabled: true, Mode: ModeAllowlist, AllowlistUserIDs: []int64{9}, MaxSessionsPerUser: 10})
	g.c.emailCodes = ec
	r = g.auth(webproto.AuthEmailCodeLogin, `{"email":"a@example.com","code":"123456"}`, webHeaders())
	require.Equal(t, http.StatusForbidden, r.status)
	require.Equal(t, webproto.ErrCodeNotAllowed, r.reason)
	require.Empty(t, r.header.Values("Set-Cookie"))

	// Upstream refusals (backend mode) pass through.
	g.backend.err = infraErr403("BACKEND_MODE_ADMIN_ONLY")
	r = g.auth(webproto.AuthEmailCodeLogin, `{"email":"a@example.com","code":"123456"}`, webHeaders())
	require.Equal(t, http.StatusForbidden, r.status)
	require.Equal(t, "BACKEND_MODE_ADMIN_ONLY", r.reason)
}

func infraErr400(reason string) error { return infraerrors.BadRequest(reason, reason) }
func infraErr403(reason string) error { return infraerrors.Forbidden(reason, reason) }

func TestLoginNotAllowed(t *testing.T) {
	f := newFixture(t, &Settings{Enabled: true, Mode: ModeAllowlist, AllowlistUserIDs: []int64{9}, MaxSessionsPerUser: 10})
	f.backend.user = &service.User{ID: 5, Email: "a@example.com", Role: service.RoleUser, Status: service.StatusActive}
	r := f.auth(webproto.AuthLogin, `{}`, webHeaders())
	require.Equal(t, http.StatusForbidden, r.status)
	require.Equal(t, webproto.ErrCodeNotAllowed, r.reason)
	require.Empty(t, r.header.Values("Set-Cookie"))
}

func TestNoBackend(t *testing.T) {
	f := newFixture(t, enabled)
	f.c.backend = nil
	core.SetWebAuthBackend(nil)
	r := f.auth(webproto.AuthLogin, `{}`, webHeaders())
	require.Equal(t, http.StatusServiceUnavailable, r.status)
}

func TestRefreshWithoutCookie(t *testing.T) {
	f := newFixture(t, enabled)
	r := f.auth(webproto.AuthRefresh, ``, webHeaders())
	require.Equal(t, http.StatusUnauthorized, r.status)
	require.Equal(t, ReasonNoSession, r.reason)
}

func TestLogoutAlwaysClearsCookie(t *testing.T) {
	f := newFixture(t, enabled)
	r := f.auth(webproto.AuthLogout, ``, webHeaders())
	require.Equal(t, http.StatusOK, r.status)
	sc := r.header.Get("Set-Cookie")
	require.Contains(t, sc, webproto.RefreshCookie+"=;")
	require.Contains(t, sc, "Max-Age=0")
}

func TestRefreshCookieAttributes(t *testing.T) {
	f := newFixture(t, enabled)
	w := httptest.NewRecorder()
	g, _ := gin.CreateTestContext(w)
	f.c.setRefreshCookie(g, "rt-value")
	sc := w.Header().Get("Set-Cookie")
	require.Contains(t, sc, webproto.RefreshCookie+"=rt-value")
	require.Contains(t, sc, "Path=/api/v1/claudex/web/auth;")
	require.NotContains(t, sc, "Path=/api/v1/claudex/web/auth/")
	require.Contains(t, sc, "Max-Age="+strconv.Itoa(7*24*3600))
	require.Contains(t, sc, "HttpOnly")
	require.Contains(t, sc, "Secure")
	require.Contains(t, sc, "SameSite=Strict")
}

func TestAuthLimitsCoverEveryRoute(t *testing.T) {
	f := newFixture(t, enabled)
	for _, r := range f.engine.Routes() {
		if !strings.HasPrefix(r.Path, webproto.PathAuth) {
			continue
		}
		name := strings.TrimPrefix(r.Path, webproto.PathAuth)
		require.Equal(t, http.MethodPost, r.Method, r.Path)
		require.Positive(t, authLimits[name], "no limit for %s", name)
	}
}

func TestSettings(t *testing.T) {
	s := Settings{Mode: " Allowlist ", AllowlistUserIDs: []int64{3, 1, 3}, AllowlistEmails: []string{" B@x.io", "b@x.io", ""}}
	normalizeSettings(&s)
	require.Equal(t, ModeAllowlist, s.Mode)
	require.Equal(t, DefaultMaxSessions, s.MaxSessionsPerUser)
	require.Equal(t, []int64{1, 3}, s.AllowlistUserIDs)
	require.Equal(t, []string{"b@x.io"}, s.AllowlistEmails)
	require.NoError(t, validateSettings(&s))

	require.True(t, s.allows(1, "", false))
	require.True(t, s.allows(7, "B@X.io", false))
	require.False(t, s.allows(7, "c@x.io", false))
	require.True(t, s.allows(7, "c@x.io", true), "admins are always allowed")
	require.True(t, Settings{Mode: ModeEveryone}.allows(7, "", false))
	require.False(t, Settings{Mode: "bogus"}.allows(7, "", false), "unknown mode fails closed")

	for _, bad := range []Settings{
		{Mode: "bogus", MaxSessionsPerUser: 1},
		{Mode: ModeAllowlist, MaxSessionsPerUser: 51},
		{Mode: ModeAllowlist, MaxSessionsPerUser: -1},
		{Mode: ModeAllowlist, MaxSessionsPerUser: 1, AllowlistUserIDs: []int64{0}},
		{Mode: ModeAllowlist, MaxSessionsPerUser: 1, AllowlistEmails: []string{"nope"}},
	} {
		require.Error(t, validateSettings(&bad), "%+v", bad)
	}
}

func TestAdminSettings(t *testing.T) {
	f := newFixture(t, nil)
	r := f.do(http.MethodGet, "/api/v1/admin/claudex/web/settings", "", nil)
	require.Equal(t, http.StatusOK, r.status)
	var got Settings
	require.NoError(t, json.Unmarshal(r.data, &got))
	require.False(t, got.Enabled)
	require.Equal(t, ModeAllowlist, got.Mode)
	require.Equal(t, DefaultMaxSessions, got.MaxSessionsPerUser)
	require.Zero(t, got.Revision)

	r = f.do(http.MethodPut, "/api/v1/admin/claudex/web/settings", `{"enabled":true,"mode":"everyone","max_web_sessions_per_user":3}`, nil)
	require.Equal(t, http.StatusBadRequest, r.status, "revision is required")

	r = f.do(http.MethodPut, "/api/v1/admin/claudex/web/settings", `{"enabled":true,"mode":"everyone","max_web_sessions_per_user":3,"revision":0}`, nil)
	require.Equal(t, http.StatusOK, r.status)
	require.NoError(t, json.Unmarshal(r.data, &got))
	require.Equal(t, int64(1), got.Revision)
	require.NotNil(t, got.UpdatedBy)
	require.Equal(t, int64(1), *got.UpdatedBy)
	require.True(t, f.c.WebAppEnabled(context.Background()), "cache refreshed")

	r = f.do(http.MethodPut, "/api/v1/admin/claudex/web/settings", `{"enabled":false,"mode":"everyone","revision":0}`, nil)
	require.Equal(t, http.StatusConflict, r.status)
	require.Equal(t, ReasonSettingsConflict, r.reason)

	r = f.do(http.MethodPut, "/api/v1/admin/claudex/web/settings", `{"mode":"bogus","revision":1}`, nil)
	require.Equal(t, http.StatusBadRequest, r.status)
	require.Equal(t, ReasonSettingsInvalid, r.reason)
}

func TestTickets(t *testing.T) {
	now := time.Date(2026, 9, 28, 8, 0, 0, 0, time.UTC)
	c := New(nil)
	mem := &memoryTickets{items: map[string]memoryTicket{}, now: func() time.Time { return now }}
	c.tickets = mem
	ctx := context.Background()
	tab := "tab-12345678"

	ticket, err := c.issueTicket(ctx, 42, tab)
	require.NoError(t, err)
	require.True(t, webproto.ValidTicket(ticket))
	for k := range mem.items {
		require.NotContains(t, k, ticket, "only the hash is stored")
	}
	uid, err := c.RedeemTicket(ctx, ticket, tab)
	require.NoError(t, err)
	require.Equal(t, int64(42), uid)
	_, err = c.RedeemTicket(ctx, ticket, tab)
	require.ErrorIs(t, err, ErrBadTicket, "one use only")

	ticket, err = c.issueTicket(ctx, 42, tab)
	require.NoError(t, err)
	_, err = c.RedeemTicket(ctx, ticket, "other-tab-123")
	require.ErrorIs(t, err, ErrBadTicket, "bound to its tab")
	_, err = c.RedeemTicket(ctx, ticket, tab)
	require.ErrorIs(t, err, ErrBadTicket, "a wrong-tab try burns it")

	ticket, err = c.issueTicket(ctx, 42, tab)
	require.NoError(t, err)
	now = now.Add(webproto.TicketTTL)
	_, err = c.RedeemTicket(ctx, ticket, tab)
	require.ErrorIs(t, err, ErrBadTicket, "expired")

	_, err = c.RedeemTicket(ctx, "short", tab)
	require.ErrorIs(t, err, ErrBadTicket)
}

func TestPublicConfig(t *testing.T) {
	var out PublicConfig
	fillPublicConfig(&out, &service.PublicSettings{
		SiteName: "Claudex", RegistrationEnabled: true, PasswordResetEnabled: true,
		TurnstileEnabled: true, TurnstileSiteKey: "site-key", PasskeyEnabled: true,
	}, true)
	require.Equal(t, "Claudex", out.SiteName)
	require.True(t, out.BackendModeEnabled)
	require.False(t, out.RegistrationEnabled, "backend mode blocks registration")
	require.False(t, out.PasswordResetEnabled, "backend mode blocks reset")
	require.True(t, out.PasskeyEnabled)
	require.Equal(t, turnstileConfig{Enabled: true, SiteKey: "site-key"}, out.Turnstile)

	f := newFixture(t, &Settings{Enabled: true, Mode: ModeAllowlist, AllowlistEmails: []string{"secret@x.io"}, MaxSessionsPerUser: 4})
	v, err := f.c.WebAppPublicConfig(context.Background())
	require.NoError(t, err)
	data, err := json.Marshal(v)
	require.NoError(t, err)
	require.Contains(t, string(data), `"enabled":true`)
	require.NotContains(t, string(data), "secret@x.io")
	require.NotContains(t, string(data), "max_web_sessions")
}

func TestUserRoutesNeedDB(t *testing.T) {
	f := newFixture(t, enabled)
	r := f.do(http.MethodGet, webproto.PathBase+"/sessions", "", nil)
	require.Equal(t, http.StatusUnauthorized, r.status)
	r = f.do(http.MethodDelete, webproto.PathBase+"/sessions/abc", "", map[string]string{"X-Test-User": "5"})
	require.Equal(t, http.StatusBadRequest, r.status)
	r = f.do(http.MethodGet, webproto.PathBase+"/session", "", map[string]string{"X-Test-User": "5"})
	require.Equal(t, http.StatusOK, r.status)
	var cur CurrentSession
	require.NoError(t, json.Unmarshal(r.data, &cur))
	require.True(t, cur.Allowed)
	require.Nil(t, cur.Session)
}

func TestClip(t *testing.T) {
	require.Equal(t, "ab", clip("  ab  ", 10))
	require.Equal(t, "a", clip("aé", 2), "cut on a rune boundary")
}
