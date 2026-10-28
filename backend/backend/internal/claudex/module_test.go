package claudex

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/gatewayhook"
	claudexhook "github.com/Wei-Shaw/sub2api/internal/claudex/hook"
	"github.com/Wei-Shaw/sub2api/internal/claudex/onboarding"
	"github.com/Wei-Shaw/sub2api/internal/claudex/routinemail"
	webusage "github.com/Wei-Shaw/sub2api/internal/claudex/web/usage"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// fullFeature implements every optional feature interface.
type fullFeature struct {
	name    string
	signups *[]string
	failErr error
	panics  bool
}

func (f fullFeature) Name() string { return f.name }

func (f fullFeature) RegisterPublicRoutes(g *gin.RouterGroup) {
	g.GET("/"+f.name+"/public", func(c *gin.Context) { c.String(http.StatusOK, "public") })
}

func (f fullFeature) RegisterUserRoutes(g *gin.RouterGroup) {
	g.GET("/"+f.name+"/mine", func(c *gin.Context) { c.String(http.StatusOK, "user") })
	g.POST("/"+f.name+"/echo", func(c *gin.Context) {
		body, _ := io.ReadAll(c.Request.Body)
		c.String(http.StatusOK, string(body))
	})
}

func (f fullFeature) RegisterAdminRoutes(g *gin.RouterGroup, stepUp gin.HandlerFunc) {
	g.GET("/"+f.name+"/config", func(c *gin.Context) { c.String(http.StatusOK, "admin") })
	g.PUT("/"+f.name+"/config", stepUp, func(c *gin.Context) { c.String(http.StatusOK, "saved") })
}

func (f fullFeature) OnSignup(_ context.Context, userID int64) error {
	*f.signups = append(*f.signups, f.name)
	if f.panics {
		panic("feature panic")
	}
	return f.failErr
}

func (f fullFeature) SettingKeys() []string {
	return []string{"claudex_" + f.name + "_b", "claudex_" + f.name + "_a"}
}

type bareFeature struct{}

func (bareFeature) Name() string { return "bare" }

type envelope struct {
	Code   any             `json:"code"`
	Reason string          `json:"reason"`
	Data   json.RawMessage `json:"data"`
}

// auditRecorder stands in for the upstream audit middleware: it reads the
// request body before the handler, like the real one.
type auditRecorder struct{ bodies []string }

func (a *auditRecorder) middleware() middleware.AuditLogMiddleware {
	return middleware.AuditLogMiddleware(func(c *gin.Context) {
		raw, _ := io.ReadAll(c.Request.Body)
		c.Request.Body = io.NopCloser(bytes.NewReader(raw))
		a.bodies = append(a.bodies, string(raw))
		c.Next()
	})
}

func testRouter(t *testing.T, m *Module, audit *auditRecorder, stepUp gin.HandlerFunc) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	v1 := r.Group("/api/v1")
	// Stand-in for the upstream JWT middleware: 401 without a bearer token.
	jwtAuth := middleware.JWTAuthMiddleware(func(c *gin.Context) {
		if c.GetHeader("Authorization") == "" {
			middleware.AbortWithError(c, http.StatusUnauthorized, "UNAUTHORIZED", "Authorization required")
			return
		}
		c.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: 7})
		c.Set(string(middleware.ContextKeyUserRole), service.RoleUser)
		c.Next()
	})
	if audit == nil {
		audit = &auditRecorder{}
	}
	m.RegisterRoutes(v1, jwtAuth, audit.middleware(), nil, nil)
	admin := v1.Group("/admin")
	admin.Use(func(c *gin.Context) {
		if c.GetHeader("X-Admin") == "" {
			middleware.AbortWithError(c, http.StatusForbidden, "FORBIDDEN", "Admin access required")
			return
		}
		c.Next()
	})
	m.RegisterAdminRoutes(admin, stepUp)
	return r
}

func do(r http.Handler, method, path string, header map[string]string, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	for k, v := range header {
		req.Header.Set(k, v)
	}
	r.ServeHTTP(rec, req)
	return rec
}

func get(r http.Handler, path string, header map[string]string) *httptest.ResponseRecorder {
	return do(r, http.MethodGet, path, header, "")
}

func decodeData(t *testing.T, rec *httptest.ResponseRecorder, into any) {
	t.Helper()
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var env envelope
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &env))
	require.EqualValues(t, 0, env.Code)
	require.NoError(t, json.Unmarshal(env.Data, into))
}

func resetHooks(t *testing.T) {
	t.Helper()
	gatewayhook.Reset()
	claudexhook.Reset()
	t.Cleanup(func() {
		gatewayhook.Reset()
		claudexhook.Reset()
	})
}

func TestCoreRoutes(t *testing.T) {
	update := service.NewUpdateService(nil, nil, "0.2.8", "release").DisableSelfUpdate()
	m := NewModule(Deps{UpdateService: update, BuildInfo: service.BuildInfo{Version: "0.2.8", BuildType: "release"}})
	var signups []string
	m.Install(fullFeature{name: "alpha", signups: &signups}, bareFeature{})
	r := testRouter(t, m, nil, nil)

	rec := get(r, "/api/v1/claudex/release", nil)
	var release map[string]any
	decodeData(t, rec, &release)
	require.Equal(t, map[string]any{"api_version": float64(APIVersion), "server": map[string]any{"version": "0.2.8", "build_type": "release"}}, release,
		"without a release peer only the server part is answered")
	require.Equal(t, "public, max-age=60", rec.Header().Get("Cache-Control"))
	require.Equal(t, "X-Claudex-Platform, X-Claudex-Arch, X-Claudex-Version", rec.Header().Get("Vary"))

	require.Equal(t, http.StatusUnauthorized, get(r, "/api/v1/claudex/capabilities", nil).Code)
	rec = get(r, "/api/v1/claudex/capabilities", map[string]string{"Authorization": "Bearer x"})
	var caps Capabilities
	decodeData(t, rec, &caps)
	require.Equal(t, Capabilities{APIVersion: APIVersion, Features: []string{"alpha", "bare"}}, caps)
	require.Equal(t, "no-store", rec.Header().Get("Cache-Control"))

	require.Equal(t, http.StatusForbidden, get(r, "/api/v1/admin/claudex/overview", nil).Code)
	var overview Overview
	decodeData(t, get(r, "/api/v1/admin/claudex/overview", map[string]string{"X-Admin": "1"}), &overview)
	require.Equal(t, Overview{
		APIVersion:         APIVersion,
		Server:             ServerInfo{Version: "0.2.8", BuildType: "release"},
		Upstream:           UpstreamInfo{Repository: UpstreamRepository, Commit: UpstreamCommit},
		SelfUpdateDisabled: true,
		Features: []FeatureInfo{
			{Name: "alpha", SettingKeys: []string{"claudex_alpha_a", "claudex_alpha_b"}},
			{Name: "bare", SettingKeys: []string{}},
		},
	}, overview)
}

func TestFeatureRoutesUseTheRightGroups(t *testing.T) {
	var signups []string
	m := NewModule(Deps{})
	m.Install(fullFeature{name: "alpha", signups: &signups})
	stepUpCalls := 0
	stepUp := func(c *gin.Context) {
		stepUpCalls++
		c.Next()
	}
	r := testRouter(t, m, nil, stepUp)

	require.Equal(t, "public", get(r, "/api/v1/claudex/alpha/public", nil).Body.String())
	require.Equal(t, http.StatusUnauthorized, get(r, "/api/v1/claudex/alpha/mine", nil).Code)
	require.Equal(t, "user", get(r, "/api/v1/claudex/alpha/mine", map[string]string{"Authorization": "Bearer x"}).Body.String())
	require.Equal(t, http.StatusForbidden, get(r, "/api/v1/admin/claudex/alpha/config", nil).Code)
	require.Equal(t, "admin", get(r, "/api/v1/admin/claudex/alpha/config", map[string]string{"X-Admin": "1"}).Body.String())
	require.Equal(t, 0, stepUpCalls)
	require.Equal(t, "saved", do(r, http.MethodPut, "/api/v1/admin/claudex/alpha/config", map[string]string{"X-Admin": "1"}, "{}").Body.String())
	require.Equal(t, 1, stepUpCalls, "the step-up middleware reaches component routes")

	// Without a step-up middleware (tests) the route still works.
	r = testRouter(t, m, nil, nil)
	require.Equal(t, "saved", do(r, http.MethodPut, "/api/v1/admin/claudex/alpha/config", map[string]string{"X-Admin": "1"}, "{}").Body.String())
}

func TestClientHeadersAreValidatedOnClaudexRoutes(t *testing.T) {
	var signups []string
	m := NewModule(Deps{})
	m.Install(fullFeature{name: "alpha", signups: &signups})
	r := testRouter(t, m, nil, nil)
	for _, path := range []string{"/api/v1/claudex/release", "/api/v1/claudex/alpha/public"} {
		rec := get(r, path, map[string]string{core.HeaderPlatform: "beos"})
		require.Equal(t, http.StatusBadRequest, rec.Code, path)
		require.Contains(t, rec.Body.String(), "CLAUDEX_INVALID_CLIENT_HEADER")
	}
	rec := get(r, "/api/v1/claudex/alpha/mine", map[string]string{"Authorization": "Bearer x", core.HeaderDeviceID: "x"})
	require.Equal(t, http.StatusBadRequest, rec.Code)
	require.Equal(t, http.StatusBadRequest, get(r, "/api/v1/claudex/release?channel=beta", nil).Code)
	require.Equal(t, http.StatusBadRequest, get(r, "/api/v1/claudex/release?platform=amiga", nil).Code)
	require.Equal(t, http.StatusOK, get(r, "/api/v1/claudex/alpha/mine", map[string]string{
		"Authorization": "Bearer x", core.HeaderDeviceID: "6f1c2a4e-9b0d-4c1e-8a57-2f3b9d0c7e11",
		core.HeaderPlatform: "win32", core.HeaderArch: "x64", core.HeaderVersion: "1.3.2",
	}).Code)
}

// privateFeature registers the three routes whose bodies stay out of the
// audit log, the way B4, B8 and B10 will.
type privateFeature struct{}

func (privateFeature) Name() string { return "private" }

func (privateFeature) RegisterUserRoutes(g *gin.RouterGroup) {
	echo := func(c *gin.Context) {
		body, _ := io.ReadAll(c.Request.Body)
		c.String(http.StatusOK, string(body))
	}
	g.POST("/diagnostics", echo)
	g.POST("/feedback", echo)
	g.POST("/payment/checkout-links", echo)
	g.POST("/devices", echo)
	// Round 2 (B-S): R1 snapshots and R3 memory text.
	g.POST("/shares", echo)
	g.PUT("/shares/:id", echo)
	g.POST("/sharing/shared-with-me/:token/report", echo)
	g.PUT("/memory/docs/:scope", echo)
	g.POST("/memory/edits", echo)
	g.PUT("/memory/prefs", echo)
}

func TestPrivateBodiesNeverReachTheAuditLog(t *testing.T) {
	m := NewModule(Deps{})
	m.Install(privateFeature{})
	audit := &auditRecorder{}
	r := testRouter(t, m, audit, nil)
	auth := map[string]string{"Authorization": "Bearer x"}

	for _, route := range []struct{ method, path string }{
		{http.MethodPost, "/api/v1/claudex/diagnostics"},
		{http.MethodPost, "/api/v1/claudex/feedback"},
		{http.MethodPost, "/api/v1/claudex/payment/checkout-links"},
		{http.MethodPost, "/api/v1/claudex/shares"},
		{http.MethodPut, "/api/v1/claudex/shares/42"},
		{http.MethodPost, "/api/v1/claudex/sharing/shared-with-me/tok/report"},
		{http.MethodPut, "/api/v1/claudex/memory/docs/global"},
		{http.MethodPost, "/api/v1/claudex/memory/edits"},
	} {
		audit.bodies = nil
		body := `{"comment":"secret words","conversation_excerpt":"prompt","message":"m","client_secret":"pi_1_secret_2","snapshot":{"messages":[]},"content":"memory"}`
		rec := do(r, route.method, route.path, auth, body)
		require.Equal(t, body, rec.Body.String(), "the handler still gets the body: %s %s", route.method, route.path)
		require.Equal(t, []string{""}, audit.bodies, "the audit log sees no body: %s %s", route.method, route.path)
	}
	// Memory preferences carry no memory text and stay audited.
	audit.bodies = nil
	rec := do(r, http.MethodPut, "/api/v1/claudex/memory/prefs", auth, `{"generate":true}`)
	require.Equal(t, `{"generate":true}`, rec.Body.String())
	require.Equal(t, []string{`{"generate":true}`}, audit.bodies)
	// Other routes are audited as before.
	audit.bodies = nil
	rec = do(r, http.MethodPost, "/api/v1/claudex/devices", auth, `{"device_name":"Mac"}`)
	require.Equal(t, `{"device_name":"Mac"}`, rec.Body.String())
	require.Equal(t, []string{`{"device_name":"Mac"}`}, audit.bodies)
}

func TestSignupHooksRunEveryFeatureAndFailOpen(t *testing.T) {
	var signups []string
	m := NewModule(Deps{})
	m.Install(fullFeature{name: "fails", signups: &signups, failErr: errors.New("boom")})
	m.Install(fullFeature{name: "panics", signups: &signups, panics: true})
	m.Install(bareFeature{})
	m.Install(fullFeature{name: "last", signups: &signups})

	require.NoError(t, m.runSignupHooks(context.Background(), 3))
	require.Equal(t, []string{"fails", "panics", "last"}, signups)
}

func TestProvideModuleInstallsEveryComponent(t *testing.T) {
	resetHooks(t)
	// The signup hook itself is covered in the service package
	// (auth_service_claudex_test.go); here ProvideModule must accept both a
	// real AuthService and none.
	for _, auth := range []*service.AuthService{nil, {}} {
		m := ProvideModule(Deps{AuthService: auth, BuildInfo: service.BuildInfo{Version: "0.2.8+claudex.1", BuildType: "source"}})
		require.NotNil(t, m)
		require.Equal(t, []string{
			core.NameWebConsole, core.NameRelease, core.NamePolicy, core.NameCatalog, core.NameDevices,
			core.NameUsage, core.NameRefusal, core.NameVoice, core.NameFeedback, core.NameMemory, core.NameBootstrap,
			core.NamePayment, core.NameSharing, core.NameWebSearchGuard,
			core.NameWeb, core.NameWebStore, core.NameWebHost, core.NameCloud, core.NameGitHub, webusage.Name, core.NameSignIn,
			core.NameAnnouncements,
			core.NameServiceStatus,
			core.NameAccountGuard, core.NameAccountProfile,
			onboarding.Name,
			routinemail.Name,
		}, m.FeatureNames())
		env := m.Env()
		require.NotNil(t, env.Peers.Plans)
		require.NotNil(t, env.Peers.Devices)
		require.NotNil(t, env.Peers.Sessions)
		require.NotNil(t, env.Peers.Release)
		require.NotNil(t, env.Now)
		require.Len(t, env.Components, 27)
		require.True(t, env.Installed(core.NamePayment))
		require.False(t, env.Installed("nope"))
		// B1 (cross-package edit): implemented components add bootstrap sections;
		// each contributor declares only the sections it owns.
		for _, bc := range env.Contributors {
			f, ok := bc.(Feature)
			require.True(t, ok)
			for _, section := range bc.Sections() {
				require.Equal(t, f.Name(), core.SectionOwners[section], section)
			}
		}
	}

	// The stub components are neutral: nothing is revoked, no key is managed,
	// and users cannot create API keys (owner decision 17) while admins can.
	ctx := context.Background()
	require.Equal(t, claudexhook.Valid, claudexhook.JWTRevoked(ctx, 1, time.Now(), "sid"))
	require.Empty(t, claudexhook.ManagedAPIKeyIDs(ctx, 1, []int64{1}))
	require.NoError(t, claudexhook.SessionsRevoked(ctx, 1, "revoke_all"))
	require.NoError(t, claudexhook.CreateAPIKeyAllowed(ctx, 1, true))
	err := claudexhook.CreateAPIKeyAllowed(ctx, 1, false)
	require.Equal(t, "CLAUDEX_USER_API_KEYS_DISABLED", infraerrors.Reason(err))
	require.Equal(t, http.StatusForbidden, infraerrors.Code(err))

	// GET /release merges the release peer (stub: unknown).
	m := ProvideModule(Deps{BuildInfo: service.BuildInfo{Version: "0.2.8+claudex.1", BuildType: "source"}})
	r := testRouter(t, m, nil, nil)
	var release map[string]any
	decodeData(t, get(r, "/api/v1/claudex/release?platform=darwin&arch=arm64&version=1.3.2", nil), &release)
	require.Equal(t, map[string]any{
		"api_version": float64(1), "server": map[string]any{"version": "0.2.8+claudex.1", "build_type": "source"},
		"channel": nil, "latest_version": nil, "minimum_version": nil, "state": "unknown", "enforced": false,
		"download_url": nil, "sha256": nil, "release_notes_url": nil, "release_notes_md": nil, "published_at": nil, "ui": nil,
	}, release)
}

// releaseFeature is a stand-in B1 that records what the module passes.
type releaseFeature struct{ got *[]string }

func (releaseFeature) Name() string { return core.NameRelease }
func (f releaseFeature) Evaluate(_ context.Context, platform, arch, version string) core.ReleaseState {
	*f.got = []string{platform, arch, version}
	published := time.Date(2026, 9, 20, 8, 0, 0, 0, time.UTC)
	return core.ReleaseState{Channel: "stable", LatestVersion: "1.4.0", MinimumVersion: "1.2.0", State: core.ReleaseStateAvailable,
		DownloadURL: "https://dl.example.com/a.zip", PublishedAt: &published}
}

func TestReleaseMergesTheReleasePeerWithHeadersOrQuery(t *testing.T) {
	var got []string
	m := NewModule(Deps{})
	m.Install(releaseFeature{got: &got})
	m.env.Peers.Release = releaseFeature{got: &got}
	r := testRouter(t, m, nil, nil)

	var release map[string]any
	decodeData(t, get(r, "/api/v1/claudex/release", map[string]string{
		core.HeaderPlatform: "win32", core.HeaderArch: "x64", core.HeaderVersion: "1.3.0",
	}), &release)
	require.Equal(t, []string{"win32", "x64", "1.3.0"}, got)
	require.Equal(t, "available", release["state"])
	require.Equal(t, "https://dl.example.com/a.zip", release["download_url"])
	require.Equal(t, "2026-09-20T08:00:00Z", release["published_at"])
	require.Nil(t, release["sha256"])

	decodeData(t, get(r, "/api/v1/claudex/release?platform=darwin&arch=arm64&version=1.3.2&channel=stable", map[string]string{
		core.HeaderPlatform: "win32",
	}), &release)
	require.Equal(t, []string{"darwin", "arm64", "1.3.2"}, got, "query parameters win over headers")
}

type peerFeature struct{ name string }

func (p peerFeature) Name() string { return p.name }
func (peerFeature) ResolvePlan(context.Context, int64, *int64) (*core.PlanRef, error) {
	return nil, core.ErrNoPlan
}

type sectionFeature struct {
	name     string
	sections []string
}

func (s sectionFeature) Name() string       { return s.name }
func (s sectionFeature) Sections() []string { return s.sections }
func (s sectionFeature) BootstrapSections(context.Context, *core.BootstrapContext) (map[string]any, error) {
	return nil, nil
}

func TestBindRequiresExactlyOnePeerAndOwnedSections(t *testing.T) {
	m := NewModule(Deps{})
	m.Install(bareFeature{})
	require.ErrorContains(t, m.bind(), "exactly one implementation")

	full := func(extra ...Feature) *Module {
		m := NewModule(Deps{})
		m.Install(append([]Feature{releaseFeature{got: new([]string)}, deviceStub{}}, extra...)...)
		return m
	}
	require.NoError(t, full().bind())
	require.ErrorContains(t, full(peerFeature{name: "second-planner"}).bind(), "PlanResolver needs exactly one implementation, found 2")
	withPolicy := full(sectionFeature{name: core.NamePolicy, sections: []string{core.SectionPolicy}})
	require.NoError(t, withPolicy.bind())
	require.Len(t, withPolicy.env.Contributors, 1, "B9 finds the contributors in env")
	require.Len(t, withPolicy.env.Components, 3)
	require.ErrorContains(t, full(sectionFeature{name: core.NamePolicy, sections: []string{core.SectionModels}}).bind(), "belongs to")
}

// deviceStub implements the three B4 peers.
type deviceStub struct{}

func (deviceStub) Name() string { return core.NameDevices }
func (deviceStub) ResolvePlan(context.Context, int64, *int64) (*core.PlanRef, error) {
	return nil, core.ErrNoPlan
}
func (deviceStub) LookupByAPIKey(context.Context, int64) (*core.DeviceRef, bool) { return nil, false }
func (deviceStub) LookupByDeviceID(context.Context, int64, string) (*core.DeviceRef, bool) {
	return nil, false
}
func (deviceStub) Check(context.Context, int64, time.Time, string) claudexhook.SessionState {
	return claudexhook.Revoked
}

// hookFeature implements every hook provider and gateway interface.
type hookFeature struct {
	events *[]claudexhook.UsageEvent
}

func (hookFeature) Name() string { return "hooks" }
func (h hookFeature) OnUsageApplied(_ context.Context, ev claudexhook.UsageEvent) {
	*h.events = append(*h.events, ev)
}
func (hookFeature) OnSessionsRevoked(context.Context, int64, string) error {
	return errors.New("db down")
}
func (hookFeature) ManagedAPIKeyIDs(_ context.Context, _ int64, ids []int64) map[int64]bool {
	return map[int64]bool{ids[0]: true}
}
func (hookFeature) PrecheckTurn(context.Context, int64, int64, *int64, []string) error {
	return errors.New("CLAUDEX_USAGE_LIMIT_EXCEEDED: limit")
}
func (hookFeature) AllowUserAPIKeyCreate(context.Context, int64, bool) error { return nil }
func (hookFeature) Priority() int                                            { return gatewayhook.PriorityUsageRules }
func (hookFeature) OnRequest(c *gin.Context, _ *service.APIKey) bool {
	c.AbortWithStatus(http.StatusTeapot)
	return true
}
func (hookFeature) OnKeyResolved(c *gin.Context, k *service.APIKey) {
	gatewayhook.MarkDevice(c, &gatewayhook.DeviceRef{APIKeyID: k.ID})
}
func (hookFeature) Describe(*gin.Context, gatewayhook.Refusal) *gatewayhook.RefusalDetail {
	return nil
}

func TestInstallHooksWiresComponentImplementations(t *testing.T) {
	resetHooks(t)
	var events []claudexhook.UsageEvent
	m := NewModule(Deps{})
	m.Install(releaseFeature{got: new([]string)}, deviceStub{}, hookFeature{events: &events})
	require.NoError(t, m.bind())
	require.NoError(t, m.installHooks())
	ctx := context.Background()

	claudexhook.UsageApplied(ctx, claudexhook.UsageEvent{RequestID: "r1"})
	require.Len(t, events, 1)
	require.EqualError(t, claudexhook.SessionsRevoked(ctx, 1, "revoke_all"), "db down")
	require.Equal(t, claudexhook.Revoked, claudexhook.JWTRevoked(ctx, 1, time.Now(), ""), "JWT check goes to Peers.Sessions")
	require.True(t, claudexhook.ManagedAPIKey(ctx, 1, 9))
	require.Error(t, claudexhook.PrecheckTurn(ctx, 1, 2, nil, []string{"m"}))
	require.NoError(t, claudexhook.CreateAPIKeyAllowed(ctx, 1, false), "a component gate replaces the default refusal")

	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	gatewayhook.KeyResolved(c, &service.APIKey{ID: 5})
	_, marked := gatewayhook.Device(c)
	require.True(t, marked)
	require.True(t, gatewayhook.KeyAuthorized(c, &service.APIKey{ID: 5}))
	require.Equal(t, http.StatusTeapot, rec.Code)

	// Two implementations of a single-owner hook are refused.
	m2 := NewModule(Deps{})
	m2.Install(releaseFeature{got: new([]string)}, deviceStub{}, hookFeature{events: &events}, namedHookFeature{hookFeature{events: &events}})
	require.NoError(t, m2.bind())
	require.ErrorContains(t, m2.installHooks(), "at most one allowed")
}

// countingRevoker is a bare core.SessionRevoker.
type countingRevoker struct {
	name  string
	calls *[]string
	err   error
}

func (r countingRevoker) Name() string { return r.name }
func (r countingRevoker) OnSessionsRevoked(_ context.Context, _ int64, reason string) error {
	*r.calls = append(*r.calls, r.name+":"+reason)
	return r.err
}

// Every SessionRevoker runs (devices and web sessions); errors are joined.
func TestInstallHooksChainsSessionRevokers(t *testing.T) {
	resetHooks(t)
	var calls []string
	m := NewModule(Deps{})
	m.Install(releaseFeature{got: new([]string)}, deviceStub{},
		countingRevoker{name: "rev-a", calls: &calls, err: errors.New("a down")},
		countingRevoker{name: "rev-b", calls: &calls})
	require.NoError(t, m.bind())
	require.NoError(t, m.installHooks())
	require.ErrorContains(t, claudexhook.SessionsRevoked(context.Background(), 1, "revoke_all"), "a down")
	require.ElementsMatch(t, []string{"rev-a:revoke_all", "rev-b:revoke_all"}, calls)
}

type namedHookFeature struct{ hookFeature }

func (namedHookFeature) Name() string { return "hooks-2" }

func TestInstallRejectsDuplicatesAndEmptyNames(t *testing.T) {
	m := NewModule(Deps{})
	m.Install(bareFeature{})
	require.Panics(t, func() { m.Install(bareFeature{}) })
	require.Panics(t, func() { m.Install(fullFeature{}) })
	require.Panics(t, func() { m.Install(nil) })
}

func TestNilModuleIsANoOp(t *testing.T) {
	var m *Module
	gin.SetMode(gin.TestMode)
	r := gin.New()
	require.NotPanics(t, func() {
		m.RegisterRoutes(r.Group("/api/v1"), nil, nil, nil, nil)
		m.RegisterAdminRoutes(r.Group("/api/v1/admin"), nil)
		m.RegisterPageRoutes(r, nil)
	})
	require.Empty(t, r.Routes())
	require.Equal(t, []string{}, m.FeatureNames())
	require.Nil(t, m.Env())
}

// pageFeature registers public pages the way R1 will (core.PageRouter).
type pageFeature struct{}

func (pageFeature) Name() string { return "pages" }

func (pageFeature) RegisterPageRoutes(g *gin.RouterGroup) {
	g.GET("/:token", func(c *gin.Context) { c.String(http.StatusOK, "page "+c.Param("token")) })
	g.POST("/:token/report", func(c *gin.Context) { c.String(http.StatusOK, "reported") })
}

func TestPageRoutesArePublicAndUnderS(t *testing.T) {
	m := NewModule(Deps{})
	m.Install(pageFeature{}, bareFeature{})
	audit := &auditRecorder{}
	r := testRouter(t, m, audit, nil)
	m.RegisterPageRoutes(r, nil)

	var pages []string
	for _, route := range r.Routes() {
		if strings.HasPrefix(route.Path, PagePrefix+"/") {
			pages = append(pages, route.Method+" "+route.Path)
		}
	}
	require.ElementsMatch(t, []string{"GET /s/:token", "POST /s/:token/report"}, pages)

	// No JWT, no audit entry, no X-Claudex-* header check (visitors are browsers).
	rec := get(r, "/s/tok123", map[string]string{core.HeaderPlatform: "beos"})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, "page tok123", rec.Body.String())
	require.Equal(t, "reported", do(r, http.MethodPost, "/s/tok123/report", nil, "reason=spam").Body.String())
	require.Empty(t, audit.bodies)
	require.Equal(t, http.StatusNotFound, get(r, "/s", nil).Code)
}
