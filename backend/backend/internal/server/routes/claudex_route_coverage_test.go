//go:build unit

package routes

// CLAUDEX: file added by the Claudex fork (see backend/CLAUDEX_CHANGES.md).
//
// Route coverage for the Claudex module (design 2.1 #8). It enumerates the
// registered routes at run time, so the routes every B package adds are
// covered automatically once they are merged:
//   1-3. every /api/v1/admin/claudex/* route answers 401 without credentials,
//        403 to a non-admin JWT and 423 to an admin before the compliance
//        commitment is accepted;
//   4.   every /api/v1/claudex/* route needs a JWT except the public list;
//   5.   the compliance bypass list is the upstream one;
//   6.   every gateway route, in both API-key middlewares and both run modes,
//        runs the Claudex guards (KeyAuthorized) and the key marker, and the
//        billable classification matches the design's whitelist;
//   7.   the private request bodies never reach audit_logs (round 2 adds the
//        R1 share snapshots and the R3 memory text);
//   9.   every public page under /s (core.PageRouter, R1 hosted shares) is
//        reachable without credentials, writes no audit entry and is one of
//        the listed pages.
// The "only claudex_ settings keys" rule (#8) is tested in internal/claudex
// (guard_test.go) and internal/claudex/core.

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex"
	"github.com/Wei-Shaw/sub2api/internal/claudex/gatewayhook"
	claudexhook "github.com/Wei-Shaw/sub2api/internal/claudex/hook"
	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/handler"
	servermiddleware "github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// coverageUserRepo serves the users of the coverage test.
type coverageUserRepo struct {
	service.UserRepository
	users map[int64]*service.User
}

func (r *coverageUserRepo) GetByID(_ context.Context, id int64) (*service.User, error) {
	if u, ok := r.users[id]; ok {
		copied := *u
		return &copied, nil
	}
	return nil, service.ErrUserNotFound
}

func (r *coverageUserRepo) GetUserAvatar(context.Context, int64) (*service.UserAvatar, error) {
	return nil, nil
}

func (r *coverageUserRepo) UpdateUserLastActiveAt(context.Context, int64, time.Time) error {
	return nil
}

type coverageAuth struct {
	auth       *service.AuthService
	users      *service.UserService
	userToken  string
	adminToken string
}

func newCoverageAuth(t *testing.T) coverageAuth {
	t.Helper()
	user := &service.User{ID: 11, Email: "user@example.com", Role: service.RoleUser, Status: service.StatusActive, TokenVersion: 1, Concurrency: 1}
	admin := &service.User{ID: 12, Email: "admin@example.com", Role: service.RoleAdmin, Status: service.StatusActive, TokenVersion: 1, Concurrency: 1}
	repo := &coverageUserRepo{users: map[int64]*service.User{11: user, 12: admin}}
	cfg := &config.Config{}
	cfg.JWT.Secret = "claudex-coverage-secret-32-bytes!!"
	cfg.JWT.AccessTokenExpireMinutes = 60
	auth := service.NewAuthService(nil, repo, nil, nil, cfg, nil, nil, nil, nil, nil, nil, nil, nil)
	userToken, err := auth.GenerateToken(context.Background(), user)
	require.NoError(t, err)
	adminToken, err := auth.GenerateToken(context.Background(), admin)
	require.NoError(t, err)
	return coverageAuth{auth: auth, users: service.NewUserService(repo, nil, nil, nil), userToken: userToken, adminToken: adminToken}
}

// probeFeature registers extra routes on the Claudex groups (with step-up on
// the admin write) so the chains are exercised beyond the built-in routes.
type probeFeature struct{ userWrites []privateRoute }

// privateRoute is a user route whose body must stay out of audit_logs: the
// registered pattern (under /api/v1/claudex) and a concrete path for it.
type privateRoute struct{ method, pattern, path string }

func (probeFeature) Name() string { return "coverage-probe" }

func (probeFeature) RegisterPublicRoutes(g *gin.RouterGroup) {
	g.GET("/coverage-probe/public", func(c *gin.Context) { c.Status(http.StatusNoContent) })
}

func (p probeFeature) RegisterUserRoutes(g *gin.RouterGroup) {
	g.GET("/coverage-probe/mine", func(c *gin.Context) { c.Status(http.StatusNoContent) })
	for _, route := range p.userWrites {
		g.Handle(route.method, route.pattern, func(c *gin.Context) {
			var body map[string]any
			_ = json.NewDecoder(c.Request.Body).Decode(&body)
			c.JSON(http.StatusOK, body)
		})
	}
}

func (probeFeature) RegisterAdminRoutes(g *gin.RouterGroup, stepUp gin.HandlerFunc) {
	g.GET("/coverage-probe/config", func(c *gin.Context) { c.Status(http.StatusNoContent) })
	g.PUT("/coverage-probe/config", stepUp, func(c *gin.Context) { c.Status(http.StatusNoContent) })
	g.DELETE("/coverage-probe/items/:id", stepUp, func(c *gin.Context) { c.Status(http.StatusNoContent) })
}

func resetClaudexHooks(t *testing.T) {
	t.Helper()
	gatewayhook.Reset()
	claudexhook.Reset()
	t.Cleanup(func() {
		gatewayhook.Reset()
		claudexhook.Reset()
	})
}

var routeParam = regexp.MustCompile(`[:*][A-Za-z_]+`)

func concretePath(route string) string {
	return routeParam.ReplaceAllStringFunc(route, func(p string) string {
		switch p {
		case "*modelAction":
			return "gemini-2.5-pro:generateContent"
		case "*subpath":
			return "compact"
		case "*path":
			return "index.js"
		}
		return "1"
	})
}

func serveRoute(r http.Handler, method, path string, header map[string]string, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range header {
		req.Header.Set(k, v)
	}
	r.ServeHTTP(rec, req)
	return rec
}

func TestClaudexAdminRoutesRequireAdminAndCompliance(t *testing.T) {
	resetClaudexHooks(t)
	gin.SetMode(gin.TestMode)
	auth := newCoverageAuth(t)
	module := claudex.ProvideModule(claudex.Deps{})
	module.Install(probeFeature{})
	router := gin.New()
	adminAuth := servermiddleware.NewAdminAuthMiddleware(auth.auth, auth.users, nil, nil)
	noop := func(c *gin.Context) { c.Next() }
	settings := service.NewSettingService(complianceSettingRepo{acknowledged: false}, nil)
	RegisterAdminRoutes(router.Group("/api/v1"), &handler.Handlers{Admin: &handler.AdminHandlers{}, Claudex: module},
		adminAuth, servermiddleware.AuditLogMiddleware(noop), servermiddleware.StepUpAuthMiddleware(noop), settings, nil)

	var checked []string
	for _, route := range router.Routes() {
		if !strings.HasPrefix(route.Path, "/api/v1/admin/claudex") {
			continue
		}
		path := concretePath(route.Path)
		label := route.Method + " " + route.Path
		checked = append(checked, label)

		rec := serveRoute(router, route.Method, path, nil, `{}`)
		require.Equal(t, http.StatusUnauthorized, rec.Code, "%s without credentials: %s", label, rec.Body.String())

		rec = serveRoute(router, route.Method, path, map[string]string{"Authorization": "Bearer " + auth.userToken}, `{}`)
		require.Equal(t, http.StatusForbidden, rec.Code, "%s with a user JWT: %s", label, rec.Body.String())

		rec = serveRoute(router, route.Method, path, map[string]string{"Authorization": "Bearer " + auth.adminToken}, `{}`)
		require.Equal(t, http.StatusLocked, rec.Code, "%s before the compliance commitment: %s", label, rec.Body.String())
		require.Contains(t, rec.Body.String(), "ADMIN_COMPLIANCE_ACK_REQUIRED", label)
	}
	sort.Strings(checked)
	require.Contains(t, checked, "GET /api/v1/admin/claudex/overview")
	require.Contains(t, checked, "PUT /api/v1/admin/claudex/coverage-probe/config")
	require.Contains(t, checked, "DELETE /api/v1/admin/claudex/coverage-probe/items/:id")
}

// TestAdminComplianceBypassListIsUpstream pins the upstream bypass list: the
// only paths that skip the compliance gate are /api/v1/admin/compliance[/...].
func TestAdminComplianceBypassListIsUpstream(t *testing.T) {
	src, err := os.ReadFile("../middleware/admin_compliance.go")
	require.NoError(t, err)
	fn := regexp.MustCompile(`(?s)func isAdminComplianceBypassPath\(path string\) bool \{.*?\n\}`).Find(src)
	require.NotNil(t, fn, "isAdminComplianceBypassPath must exist")
	require.Equal(t, `func isAdminComplianceBypassPath(path string) bool {
	path = strings.TrimSpace(path)
	return path == "/api/v1/admin/compliance" || strings.HasPrefix(path, "/api/v1/admin/compliance/")
}`, string(fn))
	require.NotContains(t, string(src), "claudex", "the compliance guard must not know about Claudex")
}

// claudexPublicRoutes are the only /api/v1/claudex routes callable without a
// JWT (design 7.2 #1); the probe route exists only in this test.
var claudexPublicRoutes = map[string]bool{
	"GET /api/v1/claudex/release":               true,
	"GET /api/v1/claudex/web-console":           true,
	"POST /api/v1/claudex/payment/checkout":     true,
	"GET /api/v1/claudex/coverage-probe/public": true,
	// R1 (registered by B-S before R1-B lands): anonymous abuse reports.
	"POST /api/v1/claudex/shared/:token/reports": true,
	// W-AUTH: the web sign-in routes (CSRF-guarded, no JWT: they share the
	// refresh cookie path; revoke-all and events-ticket check the bearer
	// themselves).
	"POST /api/v1/claudex/web/auth/login":                true,
	"POST /api/v1/claudex/web/auth/2fa":                  true,
	"POST /api/v1/claudex/web/auth/2fa/cancel":           true,
	"POST /api/v1/claudex/web/auth/register":             true,
	"POST /api/v1/claudex/web/auth/send-code":            true,
	"POST /api/v1/claudex/web/auth/forgot-password":      true,
	"POST /api/v1/claudex/web/auth/reset-password":       true,
	"POST /api/v1/claudex/web/auth/passkey/login/begin":  true,
	"POST /api/v1/claudex/web/auth/passkey/login/finish": true,
	"POST /api/v1/claudex/web/auth/refresh":              true,
	"POST /api/v1/claudex/web/auth/logout":               true,
	"POST /api/v1/claudex/web/auth/revoke-all":           true,
	"POST /api/v1/claudex/web/auth/events-ticket":        true,
	// Several accounts per browser: the account cookies it sends (ids only).
	"POST /api/v1/claudex/web/auth/accounts": true,
	// W-VOICE: the dictation ticket (registered by voice, same checks).
	"POST /api/v1/claudex/web/auth/voice-ticket": true,
	// W-RELAY: routes with their own credential: the events socket (one-time
	// ticket in Sec-WebSocket-Protocol), the runner link (runner token) and
	// artifact previews (short-lived signature; an iframe sends no bearer).
	"GET /api/v1/claudex/web/events":      true,
	"GET /api/v1/claudex/web/runner/link": true,
	"GET /api/v1/claudex/web/preview/:id": true,
	// W-GITHUB: GitHub redirects the browser here after the user approves
	// the app; the single-use state ties it to the user who started the flow.
	"GET /api/v1/claudex/web/github/callback": true,
	// LOGIN: sign-in page options and the email code sign-in (desktop and
	// web; per-IP limits fail closed, no audit log).
	"GET /api/v1/claudex/sign-in/options":            true,
	"POST /api/v1/claudex/auth/email-code/send":      true,
	"POST /api/v1/claudex/auth/email-code/login":     true,
	"POST /api/v1/claudex/web/auth/email-code/send":  true,
	"POST /api/v1/claudex/web/auth/email-code/login": true,
	// LOGIN-GOOGLE: the Google ID token is the credential.
	"POST /api/v1/claudex/auth/google/login":     true,
	"POST /api/v1/claudex/web/auth/google/login": true,
	// The phones' link to the account's computers: a one-time ticket
	// authenticates the socket.
	"GET /api/v1/claudex/web/device/link": true,
	// The public downloads page lists the published apps.
	"GET /api/v1/claudex/apps": true,
}

// claudexOwnTokenRoutes check a bearer token of their own instead of a user
// JWT, so they answer 401 to both a missing and a user token.
var claudexOwnTokenRoutes = map[string]bool{
	// A scheduled task's API trigger.
	"POST /api/v1/claudex/routines/:id/fire": true,
	// A scheduled task's GitHub webhook, signed with the trigger's secret.
	"POST /api/v1/claudex/github/hooks/:id": true,
}

// TestClaudexWebAuthRoutesAreCSRFGuarded: the public web auth routes refuse
// a request without the web app header and origin before any other check.
func TestClaudexWebAuthRoutesAreCSRFGuarded(t *testing.T) {
	resetClaudexHooks(t)
	gin.SetMode(gin.TestMode)
	module := claudex.ProvideModule(claudex.Deps{})
	router := gin.New()
	router.Use(gin.Recovery())
	noop := servermiddleware.AuditLogMiddleware(func(c *gin.Context) { c.Next() })
	module.RegisterRoutes(router.Group("/api/v1"), servermiddleware.JWTAuthMiddleware(func(c *gin.Context) { c.Next() }), noop, nil, nil)
	var n int
	for _, route := range router.Routes() {
		if !strings.HasPrefix(route.Path, "/api/v1/claudex/web/auth/") {
			continue
		}
		n++
		label := route.Method + " " + route.Path
		require.True(t, claudexPublicRoutes[label], "%s is listed", label)
		rec := serveRoute(router, route.Method, route.Path, map[string]string{"Origin": "https://evil.example"}, `{}`)
		require.Equal(t, http.StatusForbidden, rec.Code, "%s: %s", label, rec.Body.String())
		require.NotContains(t, rec.Header().Get("Set-Cookie"), "claudex_web_rt=", label)
	}
	require.Equal(t, 18, n)
}

func TestClaudexUserRoutesRequireAJWT(t *testing.T) {
	resetClaudexHooks(t)
	gin.SetMode(gin.TestMode)
	auth := newCoverageAuth(t)
	module := claudex.ProvideModule(claudex.Deps{})
	module.Install(probeFeature{})
	router := gin.New()
	router.Use(gin.Recovery())
	noop := servermiddleware.AuditLogMiddleware(func(c *gin.Context) { c.Next() })
	jwt := servermiddleware.NewJWTAuthMiddleware(auth.auth, auth.users, nil, nil)
	module.RegisterRoutes(router.Group("/api/v1"), jwt, noop, nil, nil)

	releaseRoutes := 0
	var userRoutes int
	for _, route := range router.Routes() {
		label := route.Method + " " + route.Path
		if label == "GET /api/v1/claudex/release" {
			releaseRoutes++
		}
		if claudexOwnTokenRoutes[label] {
			continue
		}
		rec := serveRoute(router, route.Method, concretePath(route.Path), nil, `{}`)
		if claudexPublicRoutes[label] {
			require.NotEqual(t, http.StatusUnauthorized, rec.Code, "%s is public", label)
			continue
		}
		userRoutes++
		require.Equal(t, http.StatusUnauthorized, rec.Code, "%s must require a JWT: %s", label, rec.Body.String())
		rec = serveRoute(router, route.Method, concretePath(route.Path), map[string]string{"Authorization": "Bearer " + auth.userToken}, `{}`)
		require.NotEqual(t, http.StatusUnauthorized, rec.Code, "%s accepts a valid user JWT", label)
	}
	require.Equal(t, 1, releaseRoutes, "GET /api/v1/claudex/release is registered once (by the module)")
	require.GreaterOrEqual(t, userRoutes, 2)

	// A revoked session is refused on every Claudex user route (H9b).
	claudexhook.Install(claudexhook.Hooks{JWTRevoked: func(context.Context, int64, time.Time, string) claudexhook.SessionState {
		return claudexhook.Revoked
	}})
	rec := serveRoute(router, http.MethodGet, "/api/v1/claudex/capabilities", map[string]string{"Authorization": "Bearer " + auth.userToken}, "")
	require.Equal(t, http.StatusUnauthorized, rec.Code)
	require.Contains(t, rec.Body.String(), "CLAUDEX_SESSION_REVOKED")
}

// coverageKeyRepo authenticates every gateway request as one active key.
type coverageKeyRepo struct{ service.APIKeyRepository }

func (coverageKeyRepo) key() *service.APIKey {
	return &service.APIKey{ID: 77, UserID: 11, Key: "sk-coverage-key", Name: "k", Status: service.StatusActive,
		User: &service.User{ID: 11, Role: service.RoleUser, Status: service.StatusActive, Balance: 100, Concurrency: 5}}
}
func (r coverageKeyRepo) GetByKey(context.Context, string) (*service.APIKey, error) {
	return r.key(), nil
}
func (r coverageKeyRepo) GetByKeyForAuth(context.Context, string) (*service.APIKey, error) {
	return r.key(), nil
}
func (coverageKeyRepo) UpdateLastUsed(context.Context, int64, time.Time) error { return nil }

type coverageGuard struct {
	mu       sync.Mutex
	billable map[string]bool
}

func (g *coverageGuard) Priority() int { return 0 }
func (g *coverageGuard) OnRequest(c *gin.Context, _ *service.APIKey) bool {
	g.mu.Lock()
	g.billable[c.Request.Method+" "+c.FullPath()] = gatewayhook.IsBillableRequest(c)
	g.mu.Unlock()
	c.AbortWithStatus(http.StatusTeapot)
	return true
}

type coverageMarker struct{ calls int }

func (m *coverageMarker) OnKeyResolved(*gin.Context, *service.APIKey) { m.calls++ }

// claudexNonBillableRoutes is the design 2.6 whitelist (plus task
// cancellation/deletion and Gemini countTokens, which never consume usage).
var claudexNonBillableRoutes = []string{
	"POST /v1/messages/count_tokens", "POST /messages/count_tokens", "POST /antigravity/v1/messages/count_tokens",
	"GET /v1/usage", "GET /antigravity/v1/usage", "GET /v1/sub2api/billing",
	"GET /v1/models", "GET /v1/models/:model", "GET /models", "GET /models/:model",
	"GET /backend-api/codex/models", "GET /antigravity/models", "GET /antigravity/v1/models",
	"GET /v1beta/models", "GET /v1beta/models/:model", "GET /antigravity/v1beta/models", "GET /antigravity/v1beta/models/:model",
	"GET /v1/images/tasks/:task_id", "GET /images/tasks/:task_id",
	"GET /v1/images/batches", "GET /v1/images/batches/models", "GET /v1/images/batches/:id",
	"GET /v1/images/batches/:id/items", "GET /v1/images/batches/:id/items/:custom_id/content",
	"GET /v1/images/batches/:id/download", "POST /v1/images/batches/:id/cancel",
	"DELETE /v1/images/batches/:id", "DELETE /v1/images/batches/:id/outputs",
}

func init() {
	for _, prefix := range []string{"/v1", ""} {
		for _, p := range []string{"/videos/:request_id", "/videos/:request_id/content", "/videos/generations/:request_id",
			"/videos/generations/:request_id/content", "/videos/edits/:request_id", "/videos/edits/:request_id/content",
			"/videos/extensions/:request_id", "/videos/extensions/:request_id/content"} {
			claudexNonBillableRoutes = append(claudexNonBillableRoutes, "GET "+prefix+p)
		}
	}
	for _, prefix := range []string{"/api/v3", "/v3", "/v1", ""} {
		claudexNonBillableRoutes = append(claudexNonBillableRoutes,
			"GET "+prefix+"/contents/generations/tasks/:task_id", "DELETE "+prefix+"/contents/generations/tasks/:task_id")
	}
}

func TestEveryGatewayRouteRunsTheClaudexGuards(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, mode := range []string{config.RunModeStandard, config.RunModeSimple} {
		t.Run(mode, func(t *testing.T) {
			resetClaudexHooks(t)
			guard := &coverageGuard{billable: map[string]bool{}}
			marker := &coverageMarker{}
			gatewayhook.RegisterRequestGuard(guard)
			gatewayhook.RegisterKeyMarker(marker)

			cfg := &config.Config{RunMode: mode, Gateway: config.GatewayConfig{MaxBodySize: 1 << 20, TextMaxBodySize: 1 << 20}}
			keys := service.NewAPIKeyService(coverageKeyRepo{}, nil, nil, nil, nil, nil, cfg)
			router := gin.New()
			RegisterGatewayRoutes(router, &handler.Handlers{
				Gateway: &handler.GatewayHandler{}, OpenAIGateway: &handler.OpenAIGatewayHandler{},
				AsyncImage: handler.NewAsyncImageHandler(nil, nil),
			}, servermiddleware.NewAPIKeyAuthMiddleware(keys, nil, cfg), keys, nil, nil, nil, nil, cfg)

			routes := router.Routes()
			require.NotEmpty(t, routes)
			var websockets int
			for _, route := range routes {
				label := route.Method + " " + route.Path
				rec := serveRoute(router, route.Method, concretePath(route.Path), map[string]string{
					"Authorization": "Bearer sk-coverage-key", "x-goog-api-key": "sk-coverage-key",
				}, `{"model":"gpt-5"}`)
				require.Equal(t, http.StatusTeapot, rec.Code, "%s must run the Claudex guards: %s", label, rec.Body.String())
				_, ran := guard.billable[label]
				require.True(t, ran, "%s: guard did not see the route", label)
				switch label {
				case "GET /v1/responses", "GET /responses", "GET /backend-api/codex/responses":
					websockets++
				}
			}
			require.Equal(t, 3, websockets, "the three Responses WebSocket routes are covered")
			require.Equal(t, len(routes), marker.calls, "every route marks its key (H5)")

			expected := map[string]bool{}
			for _, label := range claudexNonBillableRoutes {
				expected[label] = true
			}
			for label, billable := range guard.billable {
				require.Equal(t, !expected[label], billable, "billable classification of %s", label)
			}
			for label := range expected {
				_, registered := guard.billable[label]
				require.True(t, registered, "whitelisted route %s is not registered upstream any more", label)
			}
		})
	}
}

// auditCaptureRepo keeps the audit entries the real audit service writes.
type auditCaptureRepo struct {
	service.AuditLogRepository
	mu      sync.Mutex
	entries []*service.AuditLog
}

func (r *auditCaptureRepo) BatchInsert(_ context.Context, logs []*service.AuditLog) (int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.entries = append(r.entries, logs...)
	return int64(len(logs)), nil
}

func (r *auditCaptureRepo) Insert(ctx context.Context, log *service.AuditLog) error {
	_, err := r.BatchInsert(ctx, []*service.AuditLog{log})
	return err
}

func TestClaudexPrivateBodiesStayOutOfAuditLogs(t *testing.T) {
	resetClaudexHooks(t)
	gin.SetMode(gin.TestMode)
	auth := newCoverageAuth(t)
	private := []privateRoute{
		{http.MethodPost, "/diagnostics", "/diagnostics"},
		{http.MethodPost, "/feedback", "/feedback"},
		{http.MethodPost, "/payment/checkout-links", "/payment/checkout-links"},
		{http.MethodPost, "/devices", "/devices"},
		// Round 2 (B-S): R1 share snapshots and R3 memory text.
		{http.MethodPost, "/shares", "/shares"},
		{http.MethodPut, "/shares/:id", "/shares/1"},
		{http.MethodPut, "/memory/docs/:scope", "/memory/docs/global"},
		{http.MethodPost, "/memory/edits", "/memory/edits"},
		// Web app (W-SITE): RPC arguments, uploads and the auth bodies.
		{http.MethodPost, "/web/rpc/:method", "/web/rpc/threads.list"},
		{http.MethodPost, "/web/uploads", "/web/uploads"},
		{http.MethodPost, "/web/auth/login", "/web/auth/login"},
		{http.MethodPost, "/web/auth/2fa", "/web/auth/2fa"},
		{http.MethodPost, "/web/auth/register", "/web/auth/register"},
		{http.MethodPost, "/web/auth/reset-password", "/web/auth/reset-password"},
	}

	// Routes a merged B package already registers are tested as they are;
	// the others get a probe handler so the chain itself is exercised now.
	existing := map[string]bool{}
	{
		module := claudex.ProvideModule(claudex.Deps{})
		r := gin.New()
		noop := servermiddleware.AuditLogMiddleware(func(c *gin.Context) { c.Next() })
		module.RegisterRoutes(r.Group("/api/v1"), servermiddleware.JWTAuthMiddleware(func(c *gin.Context) { c.Next() }), noop, nil, nil)
		for _, route := range r.Routes() {
			existing[route.Method+" "+route.Path] = true
		}
	}
	var missing []privateRoute
	for _, p := range private {
		if !existing[p.method+" /api/v1/claudex"+p.pattern] {
			missing = append(missing, p)
		}
	}

	repo := &auditCaptureRepo{}
	audit := service.NewAuditLogService(repo, nil)
	audit.Start()
	module := claudex.ProvideModule(claudex.Deps{})
	module.Install(probeFeature{userWrites: missing})
	router := gin.New()
	router.Use(gin.Recovery())
	module.RegisterRoutes(router.Group("/api/v1"), servermiddleware.NewJWTAuthMiddleware(auth.auth, auth.users, nil, nil),
		servermiddleware.NewAuditLogMiddleware(audit), nil, nil)

	headers := map[string]string{
		"Authorization":       "Bearer " + auth.userToken,
		"X-Claudex-Device-Id": "6f1c2a4e-9b0d-4c1e-8a57-2f3b9d0c7e11",
		"X-Claudex-Platform":  "darwin",
		"X-Claudex-Version":   "1.3.2",
	}
	bodies := map[string]string{
		"/diagnostics":             `{"consent":true,"reports":[{"id":"8a0f0000-0000-4000-8000-000000000000","kind":"gateway_refusal","code":"USAGE_LIMIT_EXCEEDED","message":"secret upstream text","context":{"surface":"code"}}]}`,
		"/feedback":                `{"consent":true,"id":"c1d20000-0000-4000-8000-000000000000","rating":"down","comment":"secret comment","conversation_excerpt":"secret prompt"}`,
		"/payment/checkout-links":  `{"order_id":1024,"resume_token":"secret-resume","client_secret":"pi_1_secret_2","message":"secret"}`,
		"/devices":                 `{"device_name":"Mac","platform":"darwin","arch":"arm64","app_version":"1.3.2","group_id":null}`,
		"/shares":                  `{"kind":"conversation","source_key":"k","title":"secret title","snapshot":{"messages":[{"role":"user","text":"secret prompt"}]}}`,
		"/shares/:id":              `{"snapshot":{"messages":[{"role":"assistant","text":"secret reply"}]}}`,
		"/memory/docs/:scope":      `{"content":"secret memory","source":"user","base_revision":1}`,
		"/memory/edits":            `{"scope":"global","text":"secret memory edit"}`,
		"/web/rpc/:method":         `{"id":"1","args":{"content":"secret prompt"}}`,
		"/web/uploads":             `{"name":"secret.txt","content":"secret file"}`,
		"/web/auth/login":          `{"email":"a@example.com","password":"secret-password"}`,
		"/web/auth/2fa":            `{"code":"123456","message":"secret"}`,
		"/web/auth/register":       `{"email":"a@example.com","password":"secret-password"}`,
		"/web/auth/reset-password": `{"token":"secret-token","password":"secret-password"}`,
	}
	for _, p := range private {
		serveRoute(router, p.method, "/api/v1/claudex"+p.path, headers, bodies[p.pattern])
	}
	audit.Stop()

	repo.mu.Lock()
	defer repo.mu.Unlock()
	require.NotEmpty(t, repo.entries, "the audit middleware recorded the requests")
	for _, entry := range repo.entries {
		for _, secret := range []string{"device_id", "6f1c2a4e-9b0d-4c1e-8a57-2f3b9d0c7e11", "comment", "conversation_excerpt", "message", "secret", "snapshot", "content"} {
			require.NotContains(t, entry.RequestBody, secret, "%s %s", entry.Method, entry.Path)
		}
	}
}

// claudexPublicPages are the only routes under /s (core.PageRouter). The R1
// pages are listed by B-S before R1-V registers them; the probe page exists
// only in this test.
var claudexPublicPages = map[string]bool{
	"GET /s/:token":             true,
	"GET /s/:token/a/:n":        true,
	"GET /s/:token/raw/:n":      true,
	"POST /s/:token/report":     true,
	"GET /s/:token/screenshot":  true,
	"GET /s/:token/embed":       true,
	"GET /s/_assets/*path":      true,
	"GET /s/coverage-probe/:id": true,
}

type pageProbe struct{}

func (pageProbe) Name() string { return "coverage-page-probe" }

func (pageProbe) RegisterPageRoutes(g *gin.RouterGroup) {
	g.GET("/coverage-probe/:id", func(c *gin.Context) { c.String(http.StatusOK, "page") })
}

func TestClaudexPagesArePublicAndListed(t *testing.T) {
	resetClaudexHooks(t)
	gin.SetMode(gin.TestMode)
	repo := &auditCaptureRepo{}
	audit := service.NewAuditLogService(repo, nil)
	audit.Start()
	module := claudex.ProvideModule(claudex.Deps{})
	module.Install(pageProbe{})
	router := gin.New()
	router.Use(gin.Recovery())
	// The API groups first, as registerRoutes does, so a page route cannot
	// hide behind them.
	auth := newCoverageAuth(t)
	module.RegisterRoutes(router.Group("/api/v1"), servermiddleware.NewJWTAuthMiddleware(auth.auth, auth.users, nil, nil),
		servermiddleware.NewAuditLogMiddleware(audit), nil, nil)
	module.RegisterPageRoutes(router, nil)

	var pages int
	for _, route := range router.Routes() {
		label := route.Method + " " + route.Path
		if !strings.HasPrefix(route.Path, claudex.PagePrefix+"/") {
			require.True(t, strings.HasPrefix(route.Path, "/api/v1/claudex/"), "%s: the module registers nothing else", label)
			continue
		}
		pages++
		require.True(t, claudexPublicPages[label], "%s is not a listed public page", label)
		rec := serveRoute(router, route.Method, concretePath(route.Path), nil, "")
		require.NotEqual(t, http.StatusUnauthorized, rec.Code, "%s needs no credentials", label)
		require.NotEqual(t, http.StatusForbidden, rec.Code, "%s needs no credentials", label)
	}
	require.GreaterOrEqual(t, pages, 1)
	audit.Stop()
	repo.mu.Lock()
	defer repo.mu.Unlock()
	require.Empty(t, repo.entries, "public pages write no audit entries")
}

// The listed pages must fit in one gin route tree (static _assets next to
// :token) and dispatch to the intended handler, so R1-V can register them
// as listed without a start-up panic.
func TestClaudexPublicPagesFitOneRouteTree(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	require.NotPanics(t, func() {
		for label := range claudexPublicPages {
			method, path, _ := strings.Cut(label, " ")
			router.Handle(method, path, func(c *gin.Context) { c.String(http.StatusOK, c.FullPath()) })
		}
	})
	for path, want := range map[string]string{
		"/s/tok123":                 "/s/:token",
		"/s/tok123/a/0":             "/s/:token/a/:n",
		"/s/tok123/raw/2":           "/s/:token/raw/:n",
		"/s/_assets/mermaid.min.js": "/s/_assets/*path",
		"/s/_assets/fonts/a.woff2":  "/s/_assets/*path",
		"/s/coverage-probe/7":       "/s/coverage-probe/:id",
		"/s/coverage-probe-tok/a/1": "/s/:token/a/:n",
	} {
		rec := serveRoute(router, http.MethodGet, path, nil, "")
		require.Equal(t, http.StatusOK, rec.Code, path)
		require.Equal(t, want, rec.Body.String(), path)
	}
	rec := serveRoute(router, http.MethodPost, "/s/tok123/report", nil, "")
	require.Equal(t, "/s/:token/report", rec.Body.String())
}
