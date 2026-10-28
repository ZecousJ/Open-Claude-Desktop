package voice

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// stepUpAdmins serves the administrator the step-up middleware loads (TOTP on).
type stepUpAdmins struct{ service.UserRepository }

func (stepUpAdmins) GetByID(_ context.Context, id int64) (*service.User, error) {
	return &service.User{ID: id, Role: service.RoleAdmin, Status: service.StatusActive, TotpEnabled: true}, nil
}

func (stepUpAdmins) GetUserAvatar(context.Context, int64) (*service.UserAvatar, error) {
	return nil, nil
}

// stepUpGrants answers HasStepUpGrant with a switch (the upstream TOTP cache).
type stepUpGrants struct {
	service.TotpCache
	granted bool
}

func (g *stepUpGrants) HasStepUpGrant(context.Context, int64, string) (bool, error) {
	return g.granted, nil
}

// TestAdminPutRequiresStepUp: PUT /voice stores the upstream API key, so it
// goes through the upstream step-up gate (R13); GET stays readable.
func TestAdminPutRequiresStepUp(t *testing.T) {
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { active.Store(nil) })
	repo := newMemorySettingRepo()
	require.NoError(t, repo.Set(context.Background(), service.SettingKeyStepUpEnabled, "true"))
	settings := service.NewSettingService(repo, nil)
	grants := &stepUpGrants{}
	users := service.NewUserService(stepUpAdmins{}, nil, nil, nil)
	stepUp := gin.HandlerFunc(middleware.NewStepUpAuthMiddleware(
		service.NewTotpService(stepUpAdmins{}, nil, grants, settings, nil, nil), users, settings))

	c := New(&core.Env{Deps: core.Deps{SettingRepo: repo, Config: fixedKeyConfig()}, Now: time.Now})
	r := gin.New()
	admin := r.Group("/api/v1/admin/claudex")
	admin.Use(func(g *gin.Context) {
		g.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: 1})
		g.Set(string(middleware.ContextKeyUserRole), service.RoleAdmin)
		g.Next()
	})
	c.RegisterAdminRoutes(admin, stepUp)

	put := func() *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPut, "/api/v1/admin/claudex/voice",
			strings.NewReader(`{"transcription":{"upstream_url":"wss://transcribe.example.com/v1/audio/realtime/transcriptions","enabled":true,"api_key":"sk-test-0123456789abcdef"}}`))
		req.Header.Set("Content-Type", "application/json")
		r.ServeHTTP(w, req)
		return w
	}

	w := put()
	require.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "STEP_UP_REQUIRED")
	require.Empty(t, repo.values[SettingKey], "nothing is stored without step-up")

	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/admin/claudex/voice", nil))
	require.Equal(t, http.StatusOK, w.Code, "reads need no step-up: %s", w.Body.String())

	grants.granted = true
	w = put()
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Contains(t, repo.values[SettingKey], `"api_key_ciphertext"`)

	// The upstream switch off (its default): the write goes through without a grant.
	grants.granted = false
	require.NoError(t, repo.Set(context.Background(), service.SettingKeyStepUpEnabled, "false"))
	require.Equal(t, http.StatusOK, put().Code)
}

// TestAdminRoutesWithoutStepUpMiddleware: a nil step-up handler (tests,
// modules mounted without one) still registers a working PUT.
func TestAdminRoutesWithoutStepUpMiddleware(t *testing.T) {
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { active.Store(nil) })
	c := New(&core.Env{Deps: core.Deps{SettingRepo: newMemorySettingRepo(), Config: fixedKeyConfig()}, Now: time.Now})
	r := gin.New()
	c.RegisterAdminRoutes(r.Group("/api/v1/admin/claudex"), nil)
	w, _ := do(t, r, http.MethodPut, "/api/v1/admin/claudex/voice", `{"transcription":{"max_session_seconds":60}}`)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
}
