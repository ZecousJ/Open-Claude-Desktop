package bootstrap_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/claudex"
	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/gatewayhook"
	claudexhook "github.com/Wei-Shaw/sub2api/internal/claudex/hook"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
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

// moduleRouter mounts the real module's user routes behind a stand-in JWT
// middleware (401 without "Authorization: Bearer ok").
func moduleRouter(m *claudex.Module) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	jwt := middleware.JWTAuthMiddleware(func(c *gin.Context) {
		if c.GetHeader("Authorization") != "Bearer ok" {
			c.AbortWithStatus(http.StatusUnauthorized)
			return
		}
		c.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: 7})
		c.Set(middleware.ContextKeySessionID, "sid-7")
		c.Next()
	})
	audit := middleware.AuditLogMiddleware(func(c *gin.Context) { c.Next() })
	m.RegisterRoutes(r.Group("/api/v1"), jwt, audit, nil, nil)
	return r
}

func get(r http.Handler, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "/api/v1/claudex/bootstrap", nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

// The module installs B9 on the user chain: JWT required, malformed client
// headers refused by the module, and with the B0 stubs of the other
// components the document still answers (no plan yet, no sections, every
// component feature off).
func TestBootstrapThroughTheModule(t *testing.T) {
	resetHooks(t)
	m := claudex.ProvideModule(claudex.Deps{BuildInfo: service.BuildInfo{Version: "0.2.8+claudex.1", BuildType: "source"}})
	require.Contains(t, m.FeatureNames(), core.NameBootstrap)
	for _, bc := range m.Env().Contributors {
		f, ok := bc.(core.Feature)
		require.True(t, ok)
		require.NotEqual(t, core.NameBootstrap, f.Name(), "B9 adds no section of its own")
	}
	r := moduleRouter(m)

	require.Equal(t, http.StatusUnauthorized, get(r, nil).Code)

	bad := get(r, map[string]string{"Authorization": "Bearer ok", core.HeaderPlatform: "macos"})
	require.Equal(t, http.StatusBadRequest, bad.Code)
	require.Contains(t, bad.Body.String(), "CLAUDEX_INVALID_CLIENT_HEADER")

	headers := map[string]string{"Authorization": "Bearer ok", core.HeaderPlatform: "darwin", core.HeaderArch: "arm64",
		core.HeaderVersion: "1.3.2", core.HeaderDeviceID: "6f1c2a4e-9b0d-4c1e-8a57-2f3b9d0c7e11"}
	rec := get(r, headers)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var body struct {
		Data map[string]json.RawMessage `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	for _, key := range []string{"schema_version", "generated_at", "server", "features", "errors"} {
		require.Contains(t, body.Data, key)
	}
	var features map[string]bool
	require.NoError(t, json.Unmarshal(body.Data["features"], &features))
	require.Len(t, features, 13)
	require.False(t, features["self_delete"])
	require.True(t, features["announcements"])

	// Unchanged document: 304 through the module chain.
	etag := rec.Header().Get("ETag")
	require.NotEmpty(t, etag)
	headers["If-None-Match"] = etag
	notModified := get(r, headers)
	require.Equal(t, http.StatusNotModified, notModified.Code)
	require.Empty(t, notModified.Body.Bytes())
}
