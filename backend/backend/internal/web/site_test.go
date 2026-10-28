package web

// CLAUDEX: W-SITE SiteServer dispatch tests (W-SRV 1.1-1.3) on in-memory
// console and web app builds, so they run in every build.

import (
	"context"
	"errors"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"testing/fstest"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func init() {
	gin.SetMode(gin.TestMode)
}

const (
	testConsoleIndex = `<!doctype html><html><head><title>Sub2API - AI API Gateway</title><link rel="icon" href="/admin/logo.svg" /></head><body>console</body></html>`
	testAppIndex     = `<!doctype html><html><head><title>Claudex</title></head><body>webapp</body></html>`
)

func testConsoleFS() fstest.MapFS {
	return fstest.MapFS{
		"index.html":                {Data: []byte(testConsoleIndex)},
		"logo.svg":                  {Data: []byte(`<svg/>`)},
		"assets/index-AbCd1234.js":  {Data: []byte(`console.log("console")`)},
		"assets/index-AbCd1234.css": {Data: []byte(`body{}`)},
	}
}

func testAppFS() fstest.MapFS {
	return fstest.MapFS{
		"index.html":             {Data: []byte(testAppIndex)},
		"favicon.svg":            {Data: []byte(`<svg/>`)},
		"assets/app-Zz9_x-1a.js": {Data: []byte(`console.log("app")`)},
	}
}

type countingSettings struct {
	settings any
	err      error
	calls    atomic.Int32
}

func (p *countingSettings) GetPublicSettingsForInjection(context.Context) (any, error) {
	p.calls.Add(1)
	return p.settings, p.err
}

type fakeWebApp struct {
	enabled bool
	config  any
	err     error
	calls   atomic.Int32
}

func (f *fakeWebApp) WebAppEnabled(context.Context) bool { return f.enabled }
func (f *fakeWebApp) WebAppPublicConfig(context.Context) (any, error) {
	f.calls.Add(1)
	return f.config, f.err
}

func newTestSite(t *testing.T, opts SiteOptions, withApp bool) *SiteServer {
	t.Helper()
	var app fs.FS // a nil fstest.MapFS would still be a non-nil fs.FS
	if withApp {
		app = testAppFS()
	}
	s, err := newSiteServer(opts, testConsoleFS(), app, "", "")
	require.NoError(t, err)
	return s
}

func newTestRouter(s *SiteServer) *gin.Engine {
	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Set(middleware.CSPNonceKey, "test-nonce")
		c.Next()
	})
	r.Use(s.Middleware())
	r.GET("/api/v1/ping", func(c *gin.Context) { c.String(http.StatusOK, "api") })
	r.GET("/health", func(c *gin.Context) { c.String(http.StatusOK, "health") })
	r.GET("/models", func(c *gin.Context) { c.String(http.StatusOK, "models") })
	r.POST("/v1/responses", func(c *gin.Context) { c.String(http.StatusOK, "responses") })
	r.GET("/s/:token", func(c *gin.Context) { c.String(http.StatusOK, "share") })
	r.POST("/login", func(c *gin.Context) { c.String(http.StatusTeapot, "router") })
	return r
}

func do(r http.Handler, method, target string, header ...string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, nil)
	for i := 0; i+1 < len(header); i += 2 {
		req.Header.Set(header[i], header[i+1])
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestSiteServerDispatch(t *testing.T) {
	s := newTestSite(t, SiteOptions{Settings: &countingSettings{settings: map[string]any{"site_name": "Acme"}}}, true)
	r := newTestRouter(s)

	cases := []struct {
		name, method, target string
		code                 int
		body, location       string
	}{
		{"api", http.MethodGet, "/api/v1/ping", 200, "api", ""},
		{"health", http.MethodGet, "/health", 200, "health", ""},
		{"models", http.MethodGet, "/models", 200, "models", ""},
		{"gateway post", http.MethodPost, "/v1/responses", 200, "responses", ""},
		{"share page", http.MethodGet, "/s/abc", 200, "share", ""},

		{"admin", http.MethodGet, "/admin", 200, "console", ""},
		{"admin slash", http.MethodGet, "/admin/", 200, "console", ""},
		{"admin page", http.MethodGet, "/admin/users", 200, "console", ""},
		{"admin asset", http.MethodGet, "/admin/assets/index-AbCd1234.js", 200, `console.log("console")`, ""},
		{"admin logo", http.MethodGet, "/admin/logo.svg", 200, "<svg/>", ""},
		{"admin missing asset", http.MethodGet, "/admin/assets/gone-12345678.js", 404, "", ""},

		{"desktop pay", http.MethodGet, "/desktop-pay", 200, "console", ""},
		{"reset password (the web app's)", http.MethodGet, "/reset-password?token=x", 200, "webapp", ""},
		{"forgot password (the web app's)", http.MethodGet, "/forgot-password", 200, "webapp", ""},
		{"legal", http.MethodGet, "/legal/terms", 200, "console", ""},
		{"oidc callback", http.MethodGet, "/auth/oidc/callback?code=1", 200, "console", ""},
		{"payment result", http.MethodGet, "/payment/result", 200, "console", ""},

		{"legacy dashboard", http.MethodGet, "/dashboard", 302, "", "/admin/my/dashboard"},
		{"legacy keys query", http.MethodGet, "/keys?page=2", 302, "", "/admin/my/keys?page=2"},
		{"legacy setup", http.MethodGet, "/setup", 302, "", "/admin/setup"},
		{"legacy custom", http.MethodGet, "/custom/9", 302, "", "/admin/my/custom/9"},
		{"admin login", http.MethodGet, "/login?redirect=/admin/users", 302, "", "/admin/login?redirect=/admin/users"},

		{"web login", http.MethodGet, "/login", 200, "webapp", ""},
		{"web login redirect", http.MethodGet, "/login?redirect=/chat/1", 200, "webapp", ""},
		{"web register", http.MethodGet, "/register", 200, "webapp", ""},
		{"web root", http.MethodGet, "/", 200, "webapp", ""},
		{"web new", http.MethodGet, "/new", 200, "webapp", ""},
		{"web chat", http.MethodGet, "/chat/1", 200, "webapp", ""},
		{"web asset", http.MethodGet, "/assets/app-Zz9_x-1a.js", 200, `console.log("app")`, ""},
		{"web favicon", http.MethodGet, "/favicon.svg", 200, "<svg/>", ""},
		{"web missing asset", http.MethodGet, "/assets/gone-12345678.js", 404, "", ""},
		{"web unknown", http.MethodGet, "/unknown/deep/path", 200, "webapp", ""},
		{"web head", http.MethodHead, "/chat/1", 200, "", ""},
		{"post goes to router", http.MethodPost, "/login", http.StatusTeapot, "router", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := do(r, tc.method, tc.target)
			assert.Equal(t, tc.code, w.Code, "body=%s", w.Body.String())
			if tc.body != "" {
				assert.Contains(t, w.Body.String(), tc.body)
			}
			if tc.location != "" {
				assert.Equal(t, tc.location, w.Header().Get("Location"))
			}
		})
	}
}

func TestSiteServerCacheHeaders(t *testing.T) {
	r := newTestRouter(newTestSite(t, SiteOptions{}, true))

	w := do(r, http.MethodGet, "/admin/assets/index-AbCd1234.js")
	assert.Equal(t, staticAssetsCacheControl, w.Header().Get("Cache-Control"))
	w = do(r, http.MethodGet, "/assets/app-Zz9_x-1a.js")
	assert.Equal(t, staticAssetsCacheControl, w.Header().Get("Cache-Control"))
	w = do(r, http.MethodGet, "/admin/logo.svg")
	assert.Empty(t, w.Header().Get("Cache-Control"))
	for _, target := range []string{"/admin/", "/chat/1", "/desktop-pay"} {
		w = do(r, http.MethodGet, target)
		assert.Equal(t, "no-cache", w.Header().Get("Cache-Control"), target)
		assert.Contains(t, w.Header().Get("Content-Type"), "text/html", target)
	}
}

func TestSiteServerInjection(t *testing.T) {
	settings := &countingSettings{settings: map[string]any{"site_name": "Acme", "x": "</script><script>"}}
	webApp := &fakeWebApp{enabled: true, config: map[string]any{"site_name": "Acme", "registration": true}}
	s := newTestSite(t, SiteOptions{Settings: settings, WebApp: webApp}, true)
	r := newTestRouter(s)

	console := do(r, http.MethodGet, "/admin/")
	body := console.Body.String()
	assert.Contains(t, body, `<script nonce="test-nonce">window.__APP_CONFIG__=`)
	assert.Contains(t, body, "<title>Acme - AI API Gateway</title>")
	assert.NotContains(t, body, "</script><script>", "settings JSON must stay escaped")
	assert.NotContains(t, body, "__CLAUDEX_WEB__")

	app := do(r, http.MethodGet, "/chat/1")
	body = app.Body.String()
	assert.Contains(t, body, `<script nonce="test-nonce">window.__CLAUDEX_WEB__={"registration":true,"site_name":"Acme"};</script></head>`)
	assert.NotContains(t, body, "__APP_CONFIG__")
	assert.NotContains(t, body, NonceHTMLPlaceholder)

	assert.NotEmpty(t, console.Header().Get("ETag"))
	assert.NotEmpty(t, app.Header().Get("ETag"))
	assert.NotEqual(t, console.Header().Get("ETag"), app.Header().Get("ETag"))

	// Cached: no new provider calls, 304 on a matching ETag.
	do(r, http.MethodGet, "/admin/users")
	do(r, http.MethodGet, "/new")
	assert.Equal(t, int32(1), settings.calls.Load())
	assert.Equal(t, int32(1), webApp.calls.Load())
	assert.Equal(t, http.StatusNotModified, do(r, http.MethodGet, "/admin/", "If-None-Match", console.Header().Get("ETag")).Code)
	assert.Equal(t, http.StatusNotModified, do(r, http.MethodGet, "/", "If-None-Match", app.Header().Get("ETag")).Code)

	// A settings update invalidates both pages.
	s.InvalidateCache()
	do(r, http.MethodGet, "/admin/")
	do(r, http.MethodGet, "/")
	assert.Equal(t, int32(2), settings.calls.Load())
	assert.Equal(t, int32(2), webApp.calls.Load())
}

func TestSiteServerConfigFallbacks(t *testing.T) {
	t.Run("web app without provider injects empty config", func(t *testing.T) {
		r := newTestRouter(newTestSite(t, SiteOptions{}, true))
		assert.Contains(t, do(r, http.MethodGet, "/").Body.String(), `window.__CLAUDEX_WEB__={};`)
	})
	t.Run("web app config error serves empty config uncached", func(t *testing.T) {
		webApp := &fakeWebApp{enabled: true, err: errors.New("db down")}
		r := newTestRouter(newTestSite(t, SiteOptions{WebApp: webApp}, true))
		w := do(r, http.MethodGet, "/")
		assert.Equal(t, http.StatusOK, w.Code)
		assert.Contains(t, w.Body.String(), `window.__CLAUDEX_WEB__={};`)
		assert.Empty(t, w.Header().Get("ETag"))
		do(r, http.MethodGet, "/")
		assert.Equal(t, int32(2), webApp.calls.Load(), "a failed render is not cached")
	})
	t.Run("console settings error serves the build", func(t *testing.T) {
		r := newTestRouter(newTestSite(t, SiteOptions{Settings: &countingSettings{err: context.DeadlineExceeded}}, true))
		w := do(r, http.MethodGet, "/admin/")
		assert.Equal(t, http.StatusOK, w.Code)
		assert.Equal(t, testConsoleIndex, w.Body.String())
	})
}

func TestSiteServerWithoutWebApp(t *testing.T) {
	for name, s := range map[string]*SiteServer{
		"absent":   newTestSite(t, SiteOptions{}, false),
		"disabled": newTestSite(t, SiteOptions{WebApp: &fakeWebApp{enabled: false}}, true),
	} {
		t.Run(name, func(t *testing.T) {
			r := newTestRouter(s)
			w := do(r, http.MethodGet, "/")
			assert.Equal(t, http.StatusFound, w.Code)
			assert.Equal(t, "/admin/", w.Header().Get("Location"))
			w = do(r, http.MethodGet, "/chat/1")
			assert.Equal(t, http.StatusNotFound, w.Code)
			assert.Contains(t, w.Header().Get("Content-Type"), "text/plain")
			// The console and its root pages are unaffected.
			assert.Equal(t, http.StatusOK, do(r, http.MethodGet, "/admin/users").Code)
			assert.Equal(t, http.StatusOK, do(r, http.MethodGet, "/desktop-pay").Code)
			assert.Equal(t, http.StatusFound, do(r, http.MethodGet, "/dashboard").Code)
		})
	}
}

func TestSiteServerSetupMode(t *testing.T) {
	s := newTestSite(t, SiteOptions{SetupMode: true}, true)
	assert.False(t, s.HasWebApp(), "setup mode never serves the web app")
	r := newTestRouter(s)

	w := do(r, http.MethodGet, "/")
	assert.Equal(t, http.StatusFound, w.Code)
	assert.Equal(t, "/admin/setup", w.Header().Get("Location"))
	w = do(r, http.MethodGet, "/setup")
	assert.Equal(t, "/admin/setup", w.Header().Get("Location"))
	w = do(r, http.MethodGet, "/admin/setup")
	assert.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, testConsoleIndex, w.Body.String(), "no settings provider in setup mode")
	assert.Equal(t, http.StatusNotFound, do(r, http.MethodGet, "/chat/1").Code)
}

func TestSiteServerOverrides(t *testing.T) {
	consoleDir, appDir := t.TempDir(), t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(consoleDir, "assets"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(consoleDir, "assets", "index-AbCd1234.js"), []byte("override-console"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(appDir, "robots.txt"), []byte("User-agent: *"), 0o644))

	s, err := newSiteServer(SiteOptions{}, testConsoleFS(), testAppFS(), consoleDir, appDir)
	require.NoError(t, err)
	r := newTestRouter(s)

	w := do(r, http.MethodGet, "/admin/assets/index-AbCd1234.js")
	assert.Equal(t, "override-console", w.Body.String())
	assert.Empty(t, w.Header().Get("Cache-Control"), "override files are never immutable")
	assert.Equal(t, "User-agent: *", do(r, http.MethodGet, "/robots.txt").Body.String())
	// Traversal stays inside the override directory.
	assert.NotContains(t, do(r, http.MethodGet, "/../../etc/passwd").Body.String(), "root:")
}

func TestNewSiteServerAppDir(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "index.html"), []byte(`<html><head></head><body>from-dir</body></html>`), 0o644))
	s, err := NewSiteServer(SiteOptions{AppDir: dir})
	require.NoError(t, err)
	require.True(t, s.HasWebApp())
	assert.Contains(t, do(newTestRouter(s), http.MethodGet, "/chat/1").Body.String(), "from-dir")

	// A directory without index.html falls back to the embedded build.
	_, err = NewSiteServer(SiteOptions{AppDir: t.TempDir()})
	if !HasEmbeddedFrontend() && !HasEmbeddedWebApp() {
		assert.ErrorIs(t, err, ErrNoFrontend)
	}
}

func TestNewSiteServerNeedsAFrontend(t *testing.T) {
	_, err := newSiteServer(SiteOptions{}, nil, nil, "", "")
	assert.ErrorIs(t, err, ErrNoFrontend)
	_, err = newSiteServer(SiteOptions{}, fstest.MapFS{"x.js": {}}, nil, "", "")
	assert.Error(t, err, "a build without index.html is refused")
}

func TestSiteServerNilSafe(t *testing.T) {
	var s *SiteServer
	assert.NotPanics(t, s.InvalidateCache)
	assert.False(t, s.HasConsole())
	assert.False(t, s.HasWebApp())
}

func TestRenderAppIndex(t *testing.T) {
	out := string(renderAppIndex([]byte(testAppIndex), []byte(`{"a":1}`)))
	assert.Equal(t, 1, strings.Count(out, "__CLAUDEX_WEB__"))
	assert.Contains(t, out, `<script nonce="`+NonceHTMLPlaceholder+`">window.__CLAUDEX_WEB__={"a":1};</script></head>`)
}

func TestEmbeddedFrontendBypassesBareVideoAPIRoutes(t *testing.T) {
	for _, path := range []string{
		"/videos/generations",
		"/videos/edits",
		"/videos/extensions",
		"/videos/request-123",
	} {
		require.True(t, shouldBypassEmbeddedFrontend(path), "path=%s", path)
	}
}

// CLAUDEX: H15 the public share pages under /s/ reach the Go handlers; only
// the /s/ prefix is bypassed, so SPA routes that merely start with "s" stay.
func TestEmbeddedFrontendBypassesClaudexSharePages(t *testing.T) {
	for _, path := range []string{"/s/abc", "/s/abc/a/0", "/s/_assets/mermaid.min.js"} {
		require.True(t, shouldBypassEmbeddedFrontend(path), "path=%s", path)
	}
	for _, path := range []string{"/s", "/settings", "/subscriptions", "/sora"} {
		require.False(t, shouldBypassEmbeddedFrontend(path), "path=%s", path)
	}
}

func TestShouldBypassEmbeddedFrontendAPIRoutes(t *testing.T) {
	for _, path := range []string{
		"/api/v1/users", "/models", "/v1/models", "/v1beta/chat",
		"/backend-api/codex/responses", "/backend-api/codex/responses/compact",
		"/antigravity/test", "/setup/init", "/health", "/responses",
		"/responses/compact", "/alpha/search", " /api/v1/x ",
	} {
		assert.True(t, shouldBypassEmbeddedFrontend(path), "path=%s", path)
	}
}

// A new web app build swapped into the app directory is served without a
// restart: the disk index.html is read again (owner, 2026-10-03).
func TestSiteServerReloadsDiskAppIndex(t *testing.T) {
	dir := t.TempDir()
	index := filepath.Join(dir, "index.html")
	require.NoError(t, os.WriteFile(index, []byte(testAppIndex), 0o644))
	s, err := newSiteServer(SiteOptions{}, testConsoleFS(), os.DirFS(dir), "", "")
	require.NoError(t, err)
	s.app.diskIndex = index
	r := newTestRouter(s)

	first := do(r, http.MethodGet, "/new")
	require.Equal(t, http.StatusOK, first.Code)
	assert.Contains(t, first.Body.String(), "webapp")

	require.NoError(t, os.WriteFile(index, []byte(strings.Replace(testAppIndex, "webapp", "next build", 1)), 0o644))
	s.app.indexMu.Lock()
	s.app.checkedAt = time.Time{} // as if indexRecheck passed
	s.app.indexMu.Unlock()
	second := do(r, http.MethodGet, "/new", "If-None-Match", first.Header().Get("ETag"))
	require.Equal(t, http.StatusOK, second.Code)
	assert.Contains(t, second.Body.String(), "next build")
	assert.NotEqual(t, first.Header().Get("ETag"), second.Header().Get("ETag"))
}
