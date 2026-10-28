package webconsole

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// memoryRepo is an in-memory service.SettingRepository.
type memoryRepo struct {
	mu     sync.Mutex
	values map[string]string
	getErr error
}

func newMemoryRepo() *memoryRepo { return &memoryRepo{values: map[string]string{}} }

func (r *memoryRepo) Get(ctx context.Context, key string) (*service.Setting, error) {
	v, err := r.GetValue(ctx, key)
	if err != nil {
		return nil, err
	}
	return &service.Setting{Key: key, Value: v}, nil
}

func (r *memoryRepo) GetValue(_ context.Context, key string) (string, error) {
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

func (r *memoryRepo) Set(_ context.Context, key, value string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.values[key] = value
	return nil
}

func (r *memoryRepo) raw(key string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.values[key]
}

func (r *memoryRepo) GetMultiple(context.Context, []string) (map[string]string, error) {
	return nil, errors.New("not used")
}
func (r *memoryRepo) SetMultiple(context.Context, map[string]string) error {
	return errors.New("not used")
}
func (r *memoryRepo) GetAll(context.Context) (map[string]string, error) {
	return nil, errors.New("not used")
}
func (r *memoryRepo) Delete(context.Context, string) error { return errors.New("not used") }

type adminUserRepo struct{ service.UserRepository }

func (adminUserRepo) GetByID(_ context.Context, id int64) (*service.User, error) {
	return &service.User{ID: id, Role: service.RoleAdmin, Status: service.StatusActive}, nil
}

func (adminUserRepo) GetUserAvatar(context.Context, int64) (*service.UserAvatar, error) {
	return nil, nil
}

func signedInAdmin(c *gin.Context) {
	c.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: 1})
	c.Set(string(middleware.ContextKeyUserRole), service.RoleAdmin)
	c.Next()
}

func passThrough(c *gin.Context) { c.Next() }

func newComponent(repo service.SettingRepository, settings *service.SettingService) *Component {
	return New(&core.Env{Deps: core.Deps{SettingRepo: repo, SettingService: settings}})
}

// router mounts the public routes on /api/v1/claudex (no authentication)
// and the admin routes on /api/v1/admin/claudex behind chain.
func router(c *Component, stepUp gin.HandlerFunc, chain ...gin.HandlerFunc) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	c.RegisterPublicRoutes(r.Group("/api/v1/claudex"))
	admin := r.Group("/api/v1/admin")
	admin.Use(chain...)
	c.RegisterAdminRoutes(admin.Group("/claudex"), stepUp)
	return r
}

func serve(r http.Handler, method, path, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(rec, req)
	return rec
}

type envelope struct {
	Code     int               `json:"code"`
	Reason   string            `json:"reason"`
	Metadata map[string]string `json:"metadata"`
	Data     json.RawMessage   `json:"data"`
}

func decode(t *testing.T, rec *httptest.ResponseRecorder) envelope {
	t.Helper()
	var env envelope
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &env), rec.Body.String())
	return env
}

func TestAdminOnlyDefaultsToTrue(t *testing.T) {
	ctx := context.Background()
	require.True(t, New(nil).setting.Cached(ctx).AdminOnly, "no settings storage")
	require.True(t, newComponent(nil, nil).setting.Cached(ctx).AdminOnly)
	for raw, want := range map[string]bool{
		"":                           true, // missing key
		"{not json":                  true, // corrupt
		`{}`:                         true,
		`{"admin_only":null}`:        true,
		`{"admin_only":"no"}`:        true,
		`{"admin_only":0}`:           true,
		`{"admin_only":true}`:        true,
		`{"admin_only":false}`:       false,
		`{"admin_only":false,"x":1}`: false,
	} {
		repo := newMemoryRepo()
		if raw != "" {
			require.NoError(t, repo.Set(ctx, SettingKey, raw))
		}
		require.Equal(t, want, newComponent(repo, nil).setting.Cached(ctx).AdminOnly, raw)
	}
}

func TestPublicWebConsoleSetting(t *testing.T) {
	repo := newMemoryRepo()
	c := newComponent(repo, nil)
	r := router(c, passThrough, signedInAdmin)

	rec := serve(r, http.MethodGet, "/api/v1/claudex/web-console", "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.JSONEq(t, `{"code":0,"message":"success","data":{"admin_only":true}}`, rec.Body.String())
	require.Equal(t, "public, max-age=60", rec.Header().Get("Cache-Control"))
	require.Equal(t, "X-Claudex-Platform, X-Claudex-Arch, X-Claudex-Version", rec.Header().Get("Vary"))

	// A database error on the public read still answers true (fail closed).
	failing := newMemoryRepo()
	failing.getErr = errors.New("database down")
	rec = serve(router(newComponent(failing, nil), passThrough), http.MethodGet, "/api/v1/claudex/web-console", "")
	require.Equal(t, http.StatusOK, rec.Code)
	require.JSONEq(t, `{"admin_only":true}`, string(decode(t, rec).Data))
}

func TestAdminGetAndPutWebConsole(t *testing.T) {
	repo := newMemoryRepo()
	require.NoError(t, repo.Set(context.Background(), service.SettingKeyBackendModeEnabled, "true"))
	c := newComponent(repo, service.NewSettingService(repo, nil))
	r := router(c, passThrough, signedInAdmin)

	rec := serve(r, http.MethodGet, "/api/v1/admin/claudex/web-console", "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.JSONEq(t, `{"admin_only":true,"backend_mode_enabled":true}`, string(decode(t, rec).Data))

	rec = serve(r, http.MethodPut, "/api/v1/admin/claudex/web-console", `{"admin_only":false}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.JSONEq(t, `{"admin_only":false,"backend_mode_enabled":true}`, string(decode(t, rec).Data))
	require.JSONEq(t, `{"admin_only":false}`, repo.raw(SettingKey))
	// The public answer changes at once on this node.
	require.JSONEq(t, `{"admin_only":false}`, string(decode(t, serve(r, http.MethodGet, "/api/v1/claudex/web-console", "")).Data))

	// GET output can be sent back; backend_mode_enabled is read only here.
	rec = serve(r, http.MethodPut, "/api/v1/admin/claudex/web-console", `{"admin_only":true,"backend_mode_enabled":false}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.JSONEq(t, `{"admin_only":true,"backend_mode_enabled":true}`, string(decode(t, rec).Data))
	require.Equal(t, "true", repo.raw(service.SettingKeyBackendModeEnabled), "Backend mode is not changed here")

	for _, tc := range []struct{ body, field, rule string }{
		{`{}`, "admin_only", "required"},
		{`{"admin_only":null}`, "admin_only", "required"},
		{`{"admin_only":"false"}`, "admin_only", "type"},
		{`{"admin_only":false,"adminOnly":true}`, "adminOnly", "unknown_field"},
		{`[false]`, "body", "json_object"},
		{``, "body", "json_object"},
		{`{"admin_only":`, "body", "json"},
		{`{"admin_only":false}{}`, "body", "json"},
	} {
		rec = serve(r, http.MethodPut, "/api/v1/admin/claudex/web-console", tc.body)
		require.Equal(t, http.StatusBadRequest, rec.Code, tc.body)
		env := decode(t, rec)
		require.Equal(t, "CLAUDEX_SETTING_INVALID", env.Reason, tc.body)
		require.Equal(t, map[string]string{"field": tc.field, "rule": tc.rule}, env.Metadata, tc.body)
	}
	require.JSONEq(t, `{"admin_only":true}`, repo.raw(SettingKey), "invalid PUTs change nothing")

	// The admin read goes to the database: an error is a 500, not the default.
	repo.getErr = errors.New("database down")
	require.Equal(t, http.StatusInternalServerError, serve(r, http.MethodGet, "/api/v1/admin/claudex/web-console", "").Code)
}

func TestAdminWebConsolePutRequiresStepUpWhenEnabled(t *testing.T) {
	repo := newMemoryRepo()
	settings := service.NewSettingService(repo, nil)
	c := newComponent(repo, settings)
	stepUp := gin.HandlerFunc(middleware.NewStepUpAuthMiddleware(nil, service.NewUserService(adminUserRepo{}, nil, nil, nil), settings))
	r := router(c, stepUp, signedInAdmin)

	require.NoError(t, repo.Set(context.Background(), service.SettingKeyStepUpEnabled, "true"))
	rec := serve(r, http.MethodPut, "/api/v1/admin/claudex/web-console", `{"admin_only":false}`)
	require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
	require.Contains(t, rec.Body.String(), "STEP_UP_TOTP_NOT_ENABLED")
	require.Empty(t, repo.raw(SettingKey))
	require.Equal(t, http.StatusOK, serve(r, http.MethodGet, "/api/v1/admin/claudex/web-console", "").Code)

	require.NoError(t, repo.Set(context.Background(), service.SettingKeyStepUpEnabled, "false"))
	rec = serve(r, http.MethodPut, "/api/v1/admin/claudex/web-console", `{"admin_only":false}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
}

func TestAdminWebConsoleRoutesSitBehindComplianceGuard(t *testing.T) {
	repo := newMemoryRepo()
	settings := service.NewSettingService(repo, nil) // no acknowledgement stored
	r := router(newComponent(repo, settings), passThrough, signedInAdmin, middleware.AdminComplianceGuard(settings))
	for _, method := range []string{http.MethodGet, http.MethodPut} {
		rec := serve(r, method, "/api/v1/admin/claudex/web-console", `{"admin_only":false}`)
		require.Equal(t, http.StatusLocked, rec.Code, "%s %s", method, rec.Body.String())
		require.Contains(t, rec.Body.String(), "ADMIN_COMPLIANCE_ACK_REQUIRED")
	}
	require.Empty(t, repo.raw(SettingKey))
	// The public route is not an admin route: no guard, no sign-in.
	require.Equal(t, http.StatusOK, serve(r, http.MethodGet, "/api/v1/claudex/web-console", "").Code)
}

func TestComponentBasics(t *testing.T) {
	c := New(&core.Env{})
	require.Equal(t, core.NameWebConsole, c.Name())
	require.Equal(t, []string{SettingKey}, c.SettingKeys())
	require.Equal(t, "claudex_web_console_admin_only", SettingKey)
}
