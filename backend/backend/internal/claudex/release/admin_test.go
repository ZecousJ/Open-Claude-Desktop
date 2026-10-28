package release

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// adminUserRepo serves the administrator the step-up middleware loads.
type adminUserRepo struct {
	service.UserRepository
	totp bool
}

func (r adminUserRepo) GetByID(_ context.Context, id int64) (*service.User, error) {
	return &service.User{ID: id, Role: service.RoleAdmin, Status: service.StatusActive, TotpEnabled: r.totp}, nil
}

func (adminUserRepo) GetUserAvatar(context.Context, int64) (*service.UserAvatar, error) {
	return nil, nil
}

// signedInAdmin stands in for the upstream admin auth middleware.
func signedInAdmin(c *gin.Context) {
	c.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: 1})
	c.Set(string(middleware.ContextKeyUserRole), service.RoleAdmin)
	c.Next()
}

// adminRouter mounts the component's admin routes under
// /api/v1/admin/claudex behind the given middleware (like the upstream admin
// group).
func adminRouter(c *Component, stepUp gin.HandlerFunc, chain ...gin.HandlerFunc) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	admin := r.Group("/api/v1/admin")
	admin.Use(chain...)
	c.RegisterAdminRoutes(admin.Group("/claudex"), stepUp)
	return r
}

func passThrough(c *gin.Context) { c.Next() }

func serve(r http.Handler, method, path, body string, header map[string]string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range header {
		req.Header.Set(k, v)
	}
	r.ServeHTTP(rec, req)
	return rec
}

type envelope struct {
	Code     int               `json:"code"`
	Message  string            `json:"message"`
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

func TestAdminGetAndPutRelease(t *testing.T) {
	c, repo := newComponent(t, "")
	written := time.Date(2026, 9, 21, 9, 30, 0, 0, time.UTC)
	repo.Now = func() time.Time { return written }
	r := adminRouter(c, passThrough, signedInAdmin)
	ctx := context.Background()

	// Nothing stored yet.
	rec := serve(r, http.MethodGet, "/api/v1/admin/claudex/release", "", nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.JSONEq(t, `{"channels":{},"enforce_minimum_on_gateway":false,"updated_at":null}`, string(decode(t, rec).Data))

	// PUT the design example: answered in GET shape, stored, effective at once.
	rec = serve(r, http.MethodPut, "/api/v1/admin/claudex/release", designSetting(), nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	want := `{"channels":{"stable":{
		"latest_version":"1.4.0","minimum_version":"1.2.0","published_at":"2026-09-20T08:00:00Z",
		"release_notes_url":"https://claudex.example.com/releases/1.4.0","release_notes_md":` + mustJSON(t, testNote) + `,
		"downloads":{
			"darwin-arm64":{"url":"https://dl.example.com/Claudex-1.4.0-arm64.zip","sha256":"` + testSHA + `"},
			"darwin-x64":{"url":"https://dl.example.com/Claudex-1.4.0-x64.zip","sha256":""},
			"win32-x64":{"url":"https://dl.example.com/Claudex-Setup-1.4.0.exe","sha256":""},
			"linux-x64":null}}},
		"enforce_minimum_on_gateway":false,"updated_at":"2026-09-21T09:30:00Z"}`
	require.JSONEq(t, want, string(decode(t, rec).Data))
	rec = serve(r, http.MethodGet, "/api/v1/admin/claudex/release", "", nil)
	require.JSONEq(t, want, string(decode(t, rec).Data))
	require.Equal(t, core.ReleaseStateRequired, c.Evaluate(ctx, "darwin", "arm64", "1.1.0").State, "this node's cache is refreshed by the write")

	// GET output can be sent back as is (updated_at is ignored).
	rec = serve(r, http.MethodPut, "/api/v1/admin/claudex/release", want, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	// An invalid PUT changes nothing.
	stored := repo.Raw(SettingKey)
	rec = serve(r, http.MethodPut, "/api/v1/admin/claudex/release",
		`{"channels":{"stable":{"latest_version":"1.4.0","minimum_version":"1.5.0"}},"enforce_minimum_on_gateway":true}`, nil)
	require.Equal(t, http.StatusBadRequest, rec.Code)
	env := decode(t, rec)
	require.Equal(t, "CLAUDEX_RELEASE_INVALID", env.Reason)
	require.Equal(t, map[string]string{"field": "channels.stable.minimum_version", "rule": "above_latest_version"}, env.Metadata)
	require.Equal(t, stored, repo.Raw(SettingKey))
	rec = serve(r, http.MethodPut, "/api/v1/admin/claudex/release", `{"channels":{"beta":{}}}`, nil)
	require.Equal(t, http.StatusBadRequest, rec.Code)
	require.Equal(t, "channels.beta", decode(t, rec).Metadata["field"])
	require.Equal(t, stored, repo.Raw(SettingKey))

	// PUT replaces the whole setting.
	rec = serve(r, http.MethodPut, "/api/v1/admin/claudex/release", `{"enforce_minimum_on_gateway":true}`, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.JSONEq(t, `{"channels":{},"enforce_minimum_on_gateway":true,"updated_at":"2026-09-21T09:30:00Z"}`, string(decode(t, rec).Data))
	require.Equal(t, core.ReleaseState{State: core.ReleaseStateUnknown, Enforced: true}, c.Evaluate(ctx, "darwin", "arm64", "1.1.0"))

	// Oversized bodies are refused.
	big := `{"channels":{"stable":{"release_notes_md":"` + string(bytes.Repeat([]byte("x"), maxBodyBytes)) + `"}}}`
	rec = serve(r, http.MethodPut, "/api/v1/admin/claudex/release", big, nil)
	require.Equal(t, http.StatusBadRequest, rec.Code)
	require.Equal(t, "max_size", decode(t, rec).Metadata["rule"])

	// A database error on GET is a 500, not the defaults.
	repo.GetErr = context.DeadlineExceeded
	rec = serve(r, http.MethodGet, "/api/v1/admin/claudex/release", "", nil)
	require.Equal(t, http.StatusInternalServerError, rec.Code)
}

func TestAdminReleasePutRequiresStepUpWhenEnabled(t *testing.T) {
	c, repo := newComponent(t, "")
	settings := service.NewSettingService(repo, nil)
	stepUp := gin.HandlerFunc(middleware.NewStepUpAuthMiddleware(nil, service.NewUserService(adminUserRepo{}, nil, nil, nil), settings))
	r := adminRouter(c, stepUp, signedInAdmin)

	// Step-up on (upstream step_up_enabled): an administrator without a
	// verified second factor cannot write, but can read.
	require.NoError(t, repo.Set(context.Background(), service.SettingKeyStepUpEnabled, "true"))
	rec := serve(r, http.MethodPut, "/api/v1/admin/claudex/release", designSetting(), nil)
	require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
	require.Contains(t, rec.Body.String(), "STEP_UP_TOTP_NOT_ENABLED")
	require.Empty(t, repo.Raw(SettingKey))
	rec = serve(r, http.MethodGet, "/api/v1/admin/claudex/release", "", nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	// Step-up off (upstream default): the PUT goes through.
	require.NoError(t, repo.Set(context.Background(), service.SettingKeyStepUpEnabled, "false"))
	rec = serve(r, http.MethodPut, "/api/v1/admin/claudex/release", designSetting(), nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.NotEmpty(t, repo.Raw(SettingKey))
}

func TestAdminReleaseRoutesSitBehindComplianceGuard(t *testing.T) {
	c, repo := newComponent(t, "")
	settings := service.NewSettingService(repo, nil) // no acknowledgement stored
	r := adminRouter(c, passThrough, signedInAdmin, middleware.AdminComplianceGuard(settings))
	for _, method := range []string{http.MethodGet, http.MethodPut} {
		rec := serve(r, method, "/api/v1/admin/claudex/release", designSetting(), nil)
		require.Equal(t, http.StatusLocked, rec.Code, "%s %s", method, rec.Body.String())
		require.Contains(t, rec.Body.String(), "ADMIN_COMPLIANCE_ACK_REQUIRED")
	}
	require.Empty(t, repo.Raw(SettingKey), "nothing is written before the commitment")
}
