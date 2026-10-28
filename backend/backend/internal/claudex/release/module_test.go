package release_test

// The public GET /api/v1/claudex/release is registered by the module, which
// merges release.Component.Evaluate into its answer. These tests go through
// claudex.ProvideModule so they check the JSON clients actually receive.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/claudex"
	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/gatewayhook"
	claudexhook "github.com/Wei-Shaw/sub2api/internal/claudex/hook"
	"github.com/Wei-Shaw/sub2api/internal/claudex/release"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

const moduleSHA = "3f5c2c7e0d9b4a1f8e6d5c4b3a291807f6e5d4c3b2a1908f7e6d5c4b3a291807"

func moduleRouter(t *testing.T, repo service.SettingRepository) (*claudex.Module, *gin.Engine) {
	t.Helper()
	gatewayhook.Reset()
	claudexhook.Reset()
	t.Cleanup(func() {
		gatewayhook.Reset()
		claudexhook.Reset()
	})
	m := claudex.ProvideModule(claudex.Deps{
		SettingRepo: repo,
		BuildInfo:   service.BuildInfo{Version: "0.2.8+claudex.1", BuildType: "source"},
	})
	gin.SetMode(gin.TestMode)
	r := gin.New()
	v1 := r.Group("/api/v1")
	jwtAuth := middleware.JWTAuthMiddleware(func(c *gin.Context) {
		middleware.AbortWithError(c, http.StatusUnauthorized, "UNAUTHORIZED", "Authorization required")
	})
	audit := middleware.AuditLogMiddleware(func(c *gin.Context) { c.Next() })
	m.RegisterRoutes(v1, jwtAuth, audit, nil, nil)
	admin := v1.Group("/admin")
	admin.Use(func(c *gin.Context) {
		c.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: 1})
		c.Set(string(middleware.ContextKeyUserRole), service.RoleAdmin)
		c.Next()
	})
	m.RegisterAdminRoutes(admin, nil)
	return m, r
}

func get(r http.Handler, path string, header map[string]string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	for k, v := range header {
		req.Header.Set(k, v)
	}
	r.ServeHTTP(rec, req)
	return rec
}

func data(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var env struct {
		Code int             `json:"code"`
		Data json.RawMessage `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &env), rec.Body.String())
	require.Equal(t, 0, env.Code)
	return string(env.Data)
}

func TestModuleReleaseAnswersTheDesignJSON(t *testing.T) {
	repo := release.NewMemorySettingRepo()
	m, r := moduleRouter(t, repo)

	// The route is registered once, by the module.
	n := 0
	for _, route := range r.Routes() {
		if route.Method == http.MethodGet && route.Path == "/api/v1/claudex/release" {
			n++
		}
	}
	require.Equal(t, 1, n)

	// Nothing configured: every client field is null, state unknown.
	rec := get(r, "/api/v1/claudex/release?platform=darwin&arch=arm64&version=1.3.2", nil)
	require.Equal(t, http.StatusOK, rec.Code)
	require.JSONEq(t, `{"api_version":1,"server":{"version":"0.2.8+claudex.1","build_type":"source"},
		"channel":null,"latest_version":null,"minimum_version":null,"state":"unknown","enforced":false,
		"download_url":null,"sha256":null,"release_notes_url":null,"release_notes_md":null,"published_at":null,"ui":null}`, data(t, rec))

	// The administrator stores the design example through the admin route.
	put := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPut, "/api/v1/admin/claudex/release", strings.NewReader(`{
	  "channels": {"stable": {
	    "latest_version": "1.4.0", "minimum_version": "1.2.0", "published_at": "2026-09-20T08:00:00Z",
	    "release_notes_url": "https://claudex.example.com/releases/1.4.0",
	    "release_notes_md": "## 1.4.0\n- Plan usage limits now show the current session.",
	    "downloads": {
	      "darwin-arm64": {"url": "https://dl.example.com/Claudex-1.4.0-arm64.zip", "sha256": "`+moduleSHA+`"},
	      "win32-x64": {"url": "https://dl.example.com/Claudex-Setup-1.4.0.exe", "sha256": ""},
	      "linux-x64": null}}},
	  "enforce_minimum_on_gateway": false}`))
	r.ServeHTTP(put, req)
	require.Equal(t, http.StatusOK, put.Code, put.Body.String())

	want := `{"api_version":1,"server":{"version":"0.2.8+claudex.1","build_type":"source"},
		"channel":"stable","latest_version":"1.4.0","minimum_version":"1.2.0","state":"available","enforced":false,
		"download_url":"https://dl.example.com/Claudex-1.4.0-arm64.zip","sha256":"` + moduleSHA + `",
		"release_notes_url":"https://claudex.example.com/releases/1.4.0",
		"release_notes_md":"## 1.4.0\n- Plan usage limits now show the current session.",
		"published_at":"2026-09-20T08:00:00Z","ui":null}`

	// Query parameters (design example) ...
	rec = get(r, "/api/v1/claudex/release?platform=darwin&arch=arm64&channel=stable&version=1.3.2", nil)
	require.Equal(t, http.StatusOK, rec.Code)
	require.JSONEq(t, want, data(t, rec))
	require.Equal(t, "public, max-age=60", rec.Header().Get("Cache-Control"))
	require.Equal(t, "X-Claudex-Platform, X-Claudex-Arch, X-Claudex-Version", rec.Header().Get("Vary"))

	// ... or the X-Claudex-* headers of the desktop client, without any sign-in.
	rec = get(r, "/api/v1/claudex/release", map[string]string{
		"X-Claudex-Platform": "darwin", "X-Claudex-Arch": "arm64", "X-Claudex-Version": "1.3.2",
	})
	require.Equal(t, http.StatusOK, rec.Code)
	require.JSONEq(t, want, data(t, rec))

	// State follows the version; the download follows platform and arch.
	for version, state := range map[string]string{"1.1.0": "required", "1.4.0": "current", "1.4.0-beta.3": "available", "": "unknown"} {
		var got map[string]any
		require.NoError(t, json.Unmarshal([]byte(data(t, get(r, "/api/v1/claudex/release?platform=win32&arch=x64&version="+version, nil))), &got))
		require.Equal(t, state, got["state"], version)
		require.Equal(t, "https://dl.example.com/Claudex-Setup-1.4.0.exe", got["download_url"])
		require.Nil(t, got["sha256"], "an empty checksum is null")
	}
	var linux map[string]any
	require.NoError(t, json.Unmarshal([]byte(data(t, get(r, "/api/v1/claudex/release?platform=linux&arch=x64&version=1.3.2", nil))), &linux))
	require.Nil(t, linux["download_url"], "a platform without a download has no link")
	require.Equal(t, "available", linux["state"])

	// The bootstrap section is the same answer without api_version and server.
	var contributor core.BootstrapContributor
	for _, bc := range m.Env().Contributors {
		for _, s := range bc.Sections() {
			if s == core.SectionRelease {
				contributor = bc
			}
		}
	}
	require.NotNil(t, contributor, "the release component contributes the bootstrap release section")
	sections, err := contributor.BootstrapSections(context.Background(), &core.BootstrapContext{Platform: "darwin", Arch: "arm64", AppVersion: "1.3.2"})
	require.NoError(t, err)
	section, err := json.Marshal(sections[core.SectionRelease])
	require.NoError(t, err)
	var full map[string]any
	require.NoError(t, json.Unmarshal([]byte(want), &full))
	delete(full, "api_version")
	delete(full, "server")
	expected, err := json.Marshal(full)
	require.NoError(t, err)
	require.JSONEq(t, string(expected), string(section))

	// The peer the module merges is this component.
	require.Equal(t, "stable", m.Env().Peers.Release.Evaluate(context.Background(), "", "", "").Channel)
}
