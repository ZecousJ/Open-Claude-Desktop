//go:build integration

package integration

// The cross-component harness (R13-T, design 3.6 / i1 finding 5): one
// PostgreSQL and one Redis container (labelled for the go.sh run, see
// core/testsupport), every upstream and Claudex migration, and the real
// Claudex module built by claudex.ProvideModule with real upstream services
// (users, groups, API keys, subscriptions, auth, settings, payment) on top.
// The router mounts what internal/server mounts for Claudex: the module's
// public, user (JWT with the H9b check, backend-mode guard, panel rate limit
// on Redis, header validation, audit log) and admin routes, the upstream
// /api/v1/keys and revoke-all handlers (H13, H9), and a /v1 gateway group
// with the real H6 refusal rewriter, body limits and API-key middleware
// (H5/H5b guards).
//
// Behind the gateway middleware the upstream account scheduling of
// internal/handler is not built (it needs the whole server graph): POST
// routes are a pass-through proxy to an httptest upstream (JSON, SSE and
// error bodies), GET /v1/responses is a WebSocket stand-in that checks each
// turn through claudexhook.PrecheckTurn exactly like the real handler (H14),
// and GET /v1/audio/realtime/transcriptions is the real dictation handler
// with a fake transcription service, real billing and the voice session log.
//
// Run: GOLOCK_WEIGHT=3 SCRATCH/golock.sh scripts/backend/go.sh test-integration ./internal/claudex/integration/...

import (
	"bufio"
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	dbent "github.com/Wei-Shaw/sub2api/ent"
	_ "github.com/Wei-Shaw/sub2api/ent/runtime"
	"github.com/Wei-Shaw/sub2api/internal/claudex" //nolint:depguard // the harness builds the real module
	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/core/testsupport"
	"github.com/Wei-Shaw/sub2api/internal/claudex/gatewayhook"
	claudexhook "github.com/Wei-Shaw/sub2api/internal/claudex/hook"
	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/handler" //nolint:depguard // the harness drives the real keys, revoke-all and dictation handlers
	"github.com/Wei-Shaw/sub2api/internal/pkg/logger"
	"github.com/Wei-Shaw/sub2api/internal/pkg/timezone"
	"github.com/Wei-Shaw/sub2api/internal/repository" //nolint:depguard // the harness wires the real upstream repositories
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
	coderws "github.com/coder/websocket"
	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
)

var (
	itDB     *sql.DB
	itClient *dbent.Client
	itRedis  *redis.Client
	itWorld  *world
	seq      atomic.Int64
)

func TestMain(m *testing.M) {
	ctx := context.Background()
	if err := timezone.Init("UTC"); err != nil {
		log.Fatalf("timezone: %v", err)
	}
	// Warnings and errors of the upstream handlers (billing, relay) reach the test log.
	logger.InitBootstrap()
	_ = logger.SetLevel("warn")
	pg, err := testsupport.StartPostgres(ctx, "claudex_crosscomponent_test")
	if err != nil {
		if testsupport.Skip(err) {
			log.Printf("docker is not available; skipping the cross-component tests: %v", err)
			os.Exit(0)
		}
		log.Fatalf("%v", err)
	}
	rd, err := testsupport.StartRedis(ctx)
	if err != nil {
		pg.Terminate(ctx)
		log.Fatalf("%v", err)
	}
	itRedis = rd.Client
	if itDB, err = pg.Open(ctx); err != nil {
		log.Fatalf("%v", err)
	}
	if err := repository.ApplyMigrations(ctx, itDB); err != nil {
		log.Fatalf("migrations: %v", err)
	}
	itClient = dbent.NewClient(dbent.Driver(entsql.OpenDB(dialect.Postgres, itDB)))

	itWorld = newWorld()
	code := m.Run()
	itWorld.close()

	_ = itClient.Close()
	_ = itDB.Close()
	rd.Terminate(ctx)
	pg.Terminate(ctx)
	os.Exit(code)
}

// paymentKey signs payment resume tokens (PaymentConfigService's key).
var paymentKey = bytes.Repeat([]byte{0x42}, 32)

// ---- the world: one module for the whole package ----

type world struct {
	cfg      *config.Config
	module   *claudex.Module
	auth     *service.AuthService
	users    *service.UserService
	keys     *service.APIKeyService
	subs     *service.SubscriptionService
	settings *service.SettingService
	router   *gin.Engine
	server   *httptest.Server
	up       *upstream
	asr      *fakeASR
	audit    *auditRecorder
	admin    *service.User
	stop     []func()
}

func newWorld() *world {
	gin.SetMode(gin.TestMode)
	w := &world{up: newUpstream(), asr: newFakeASR(), audit: &auditRecorder{}}

	cfg := &config.Config{RunMode: config.RunModeStandard}
	cfg.JWT.Secret = "claudex-crosscomponent-integration-secret-0123456789"
	cfg.JWT.AccessTokenExpireMinutes = 60
	cfg.JWT.RefreshTokenExpireDays = 30
	cfg.Gateway.MaxBodySize = 1 << 20
	cfg.Gateway.TextMaxBodySize = 1 << 20
	cfg.Totp.EncryptionKey = strings.Repeat("0f", 32)
	cfg.Totp.EncryptionKeyConfigured = true
	cfg.Default.RateMultiplier = 1
	w.cfg = cfg

	userRepo := repository.NewUserRepository(itClient, itDB)
	groupRepo := repository.NewGroupRepository(itClient, itDB)
	subRepo := repository.NewUserSubscriptionRepository(itClient)
	settingRepo := repository.NewSettingRepository(itClient)
	w.settings = service.NewSettingService(settingRepo, cfg)
	w.keys = service.NewAPIKeyService(repository.NewAPIKeyRepository(itClient, itDB), userRepo, groupRepo, subRepo, nil, nil, cfg)
	w.subs = service.NewSubscriptionService(groupRepo, subRepo, nil, itClient, cfg)
	w.auth = service.NewAuthService(itClient, userRepo, nil, repository.NewRefreshTokenCache(itRedis), cfg, w.settings, nil, nil, nil, nil, nil, nil, nil)
	w.users = service.NewUserService(userRepo, settingRepo, nil, nil)
	paymentConfig := service.NewPaymentConfigService(itClient, settingRepo, paymentKey)
	payments := service.NewPaymentService(itClient, nil, nil, nil, w.subs, paymentConfig, userRepo, groupRepo, nil)

	w.module = claudex.ProvideModule(claudex.Deps{
		SettingRepo: settingRepo, SettingService: w.settings, AuthService: w.auth,
		BuildInfo: service.BuildInfo{Version: "0.2.8+claudex.it", BuildType: "source"},
		DB:        itDB, Redis: itRedis, Config: cfg,
		APIKeys: w.keys, Subscriptions: w.subs, Users: w.users, UserRepo: userRepo, GroupRepo: groupRepo,
		PaymentConfig: paymentConfig, Payment: payments,
	})

	admin, err := itClient.User.Create().
		SetEmail(fmt.Sprintf("it-admin-%d@example.com", time.Now().UnixNano())).
		SetPasswordHash("x").SetRole(service.RoleAdmin).SetStatus(service.StatusActive).Save(context.Background())
	if err != nil {
		log.Fatalf("admin user: %v", err)
	}
	w.admin = &service.User{ID: admin.ID, Role: service.RoleAdmin}

	// The realtime dictation handler (B7) with real billing, as the server builds it.
	billingCache := service.NewBillingCacheService(nil, userRepo, subRepo, nil, nil, nil, cfg, nil)
	w.stop = append(w.stop, billingCache.Stop)
	gatewayService := service.NewOpenAIGatewayService(
		nil, nil, repository.NewUsageBillingRepository(itClient, itDB), userRepo, subRepo, nil, nil, cfg, nil, nil,
		service.NewBillingService(cfg, nil), nil, billingCache, nil,
		service.NewDeferredService(nil, nil, time.Minute), nil, nil, nil, nil, nil, nil, nil,
	)
	openai := handler.NewOpenAIGatewayHandler(gatewayService,
		service.NewConcurrencyService(repository.NewConcurrencyCache(itRedis, 0, 0)),
		billingCache, w.keys, nil, nil, nil, nil, cfg)

	r := gin.New()
	r.Use(gin.Recovery())
	api := r.Group("/api/v1")
	jwt := middleware.NewJWTAuthMiddleware(w.auth, w.users, w.settings, nil)
	limiter := middleware.NewPanelRateLimiter(itRedis, w.settings)
	w.module.RegisterRoutes(api, jwt, middleware.AuditLogMiddleware(w.audit.middleware), w.settings, limiter)
	adminGroup := api.Group("/admin")
	adminGroup.Use(func(c *gin.Context) {
		// Stands in for the admin JWT and AdminComplianceGuard of the real
		// server; the commitment itself is never touched here.
		c.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: admin.ID})
		c.Set(string(middleware.ContextKeyUserRole), service.RoleAdmin)
		c.Next()
	})
	w.module.RegisterAdminRoutes(adminGroup, nil)

	kh := handler.NewAPIKeyHandler(w.keys)
	kg := api.Group("/keys", gin.HandlerFunc(jwt))
	kg.GET("", kh.List)
	kg.POST("", kh.Create)
	kg.DELETE("/:id", kh.Delete)
	ah := handler.NewAuthHandler(cfg, w.auth, w.users, w.settings, nil, nil, nil, nil)
	api.POST("/auth/revoke-all-sessions", gin.HandlerFunc(jwt), ah.RevokeAllSessions)

	v1 := r.Group("/v1")
	v1.Use(gatewayhook.EnrichRefusals(), gatewayhook.BodyLimits(), gin.HandlerFunc(middleware.NewAPIKeyAuthMiddleware(w.keys, w.subs, cfg)))
	v1.POST("/responses", w.up.proxy)
	v1.POST("/chat/completions", w.up.proxy)
	v1.GET("/responses", responsesWebSocket)
	v1.GET("/audio/realtime/transcriptions", openai.ClaudexAudioRealtimeTranscriptions)
	w.router = r
	w.server = httptest.NewServer(r)
	return w
}

func (w *world) close() {
	w.server.Close()
	w.up.srv.Close()
	w.asr.srv.Close()
	for _, f := range w.stop {
		f()
	}
}

// responsesWebSocket stands in for the Responses WebSocket handler: after the
// handshake passed the API-key guards (H5b) it checks every response.create
// turn with the usage rules (H14, claudexhook.PrecheckTurn, what
// handler.claudexPrecheckWSTurn calls) and closes the connection with the
// refusal text, as the real handler does before picking an account.
func responsesWebSocket(c *gin.Context) {
	apiKey, ok := middleware.GetAPIKeyFromContext(c)
	subject, ok2 := middleware.GetAuthSubjectFromContext(c)
	if !ok || !ok2 {
		c.AbortWithStatus(http.StatusUnauthorized)
		return
	}
	conn, err := coderws.Accept(c.Writer, c.Request, nil)
	if err != nil {
		return
	}
	defer func() { _ = conn.CloseNow() }()
	ctx := c.Request.Context()
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		var frame struct {
			Type  string `json:"type"`
			Model string `json:"model"`
		}
		_ = json.Unmarshal(data, &frame)
		if err := claudexhook.PrecheckTurn(ctx, subject.UserID, apiKey.ID, apiKey.GroupID, []string{frame.Model}); err != nil {
			reason := err.Error()
			if len(reason) > 120 {
				reason = reason[:120]
			}
			_ = conn.Close(coderws.StatusPolicyViolation, reason)
			return
		}
		if err := conn.Write(ctx, coderws.MessageText, []byte(`{"type":"response.completed"}`)); err != nil {
			return
		}
	}
}

// ---- upstream: the model provider behind the gateway ----

type upstreamRequest struct {
	Method, Path, Auth string
	Body               []byte
}

type upstreamReply struct {
	Status      int
	ContentType string
	Body        []byte
}

type upstream struct {
	srv      *httptest.Server
	mu       sync.Mutex
	requests []upstreamRequest
	next     *upstreamReply // one-shot reply; nil = success
}

func newUpstream() *upstream {
	u := &upstream{}
	u.srv = httptest.NewServer(http.HandlerFunc(u.serve))
	return u
}

func (u *upstream) serve(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	u.mu.Lock()
	u.requests = append(u.requests, upstreamRequest{Method: r.Method, Path: r.URL.Path, Auth: r.Header.Get("Authorization"), Body: body})
	next := u.next
	u.next = nil
	u.mu.Unlock()
	if next != nil {
		w.Header().Set("Content-Type", next.ContentType)
		w.WriteHeader(next.Status)
		_, _ = w.Write(next.Body)
		return
	}
	var req struct {
		Stream bool `json:"stream"`
	}
	_ = json.Unmarshal(body, &req)
	if !req.Stream {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"resp_it","object":"response","status":"completed","output_text":"OK"}`))
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	flusher, _ := w.(http.Flusher)
	for _, ev := range []string{
		`event: response.created` + "\n" + `data: {"type":"response.created","response":{"id":"resp_it"}}`,
		`event: response.output_text.delta` + "\n" + `data: {"type":"response.output_text.delta","delta":"OK"}`,
		`event: response.completed` + "\n" + `data: {"type":"response.completed","response":{"id":"resp_it","status":"completed"}}`,
	} {
		_, _ = io.WriteString(w, ev+"\n\n")
		if flusher != nil {
			flusher.Flush()
		}
	}
}

// reply sets the next upstream answer.
func (u *upstream) reply(status int, contentType string, body []byte) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.next = &upstreamReply{Status: status, ContentType: contentType, Body: body}
}

func (u *upstream) count() int {
	u.mu.Lock()
	defer u.mu.Unlock()
	return len(u.requests)
}

// proxy forwards the gateway request upstream with the account's key and
// streams the answer back (the part of the real OpenAI gateway handler that
// matters to the Claudex hooks: status, headers and body as the upstream
// sent them).
func (u *upstream) proxy(c *gin.Context) {
	body, err := io.ReadAll(c.Request.Body)
	if err != nil {
		c.AbortWithStatus(http.StatusBadRequest)
		return
	}
	req, err := http.NewRequestWithContext(c.Request.Context(), c.Request.Method, u.srv.URL+c.Request.URL.Path, bytes.NewReader(body))
	if err != nil {
		c.AbortWithStatus(http.StatusInternalServerError)
		return
	}
	req.Header.Set("Authorization", "Bearer sk-upstream-account")
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		c.AbortWithStatus(http.StatusBadGateway)
		return
	}
	defer func() { _ = resp.Body.Close() }()
	c.Header("Content-Type", resp.Header.Get("Content-Type"))
	c.Status(resp.StatusCode)
	buf := make([]byte, 8<<10)
	for {
		n, err := resp.Body.Read(buf)
		if n > 0 {
			_, _ = c.Writer.Write(buf[:n])
			c.Writer.Flush()
		}
		if err != nil {
			return
		}
	}
}

// ---- the realtime transcription service (stand-in) ----

type fakeASR struct {
	srv   *httptest.Server
	mu    sync.Mutex
	audio int
}

const asrKey = "sk-hw-it-0123456789abcdef"

func newFakeASR() *fakeASR {
	a := &fakeASR{}
	a.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+asrKey {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		conn, err := coderws.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer func() { _ = conn.CloseNow() }()
		ctx := r.Context()
		for {
			typ, data, err := conn.Read(ctx)
			if err != nil {
				return
			}
			if typ == coderws.MessageBinary {
				a.mu.Lock()
				a.audio += len(data)
				a.mu.Unlock()
				continue
			}
			var m map[string]any
			_ = json.Unmarshal(data, &m)
			if m["type"] == "finish" {
				_ = conn.Write(ctx, coderws.MessageText, []byte(`{"type":"final","text":"hello"}`))
				_ = conn.Close(coderws.StatusNormalClosure, "")
				return
			}
		}
	}))
	return a
}

// ---- the audit log as the user routes see it ----

type auditEntry struct {
	Route string
	Body  string
}

type auditRecorder struct {
	mu      sync.Mutex
	entries []auditEntry
}

// middleware records the request body the audit layer can read, then puts it
// back (as the upstream audit middleware does).
func (a *auditRecorder) middleware(c *gin.Context) {
	var body []byte
	if c.Request.Body != nil {
		body, _ = io.ReadAll(c.Request.Body)
		c.Request.Body = io.NopCloser(bytes.NewReader(body))
	}
	a.mu.Lock()
	a.entries = append(a.entries, auditEntry{Route: c.Request.Method + " " + c.FullPath(), Body: string(body)})
	a.mu.Unlock()
	c.Next()
}

func (a *auditRecorder) last(route string) (auditEntry, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for i := len(a.entries) - 1; i >= 0; i-- {
		if a.entries[i].Route == route {
			return a.entries[i], true
		}
	}
	return auditEntry{}, false
}

// ---- per-test helpers ----

type harness struct {
	*world
	t   *testing.T
	ctx context.Context
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	return &harness{world: itWorld, t: t, ctx: context.Background()}
}

func uid() int64 { return seq.Add(1) }

func newDeviceID() string {
	return fmt.Sprintf("%08x-9b0d-4c1e-8a57-%012x", uid(), time.Now().UnixNano()&0xffffffffffff)
}

func (h *harness) user() *service.User {
	h.t.Helper()
	u := &service.User{}
	require.NoError(h.t, u.SetPassword("it-password-1"))
	created, err := itClient.User.Create().
		SetEmail(fmt.Sprintf("it-%d-%d@example.com", uid(), time.Now().UnixNano())).
		SetPasswordHash(u.PasswordHash).
		SetRole(service.RoleUser).
		SetStatus(service.StatusActive).
		SetBalance(100).
		SetConcurrency(5).
		Save(h.ctx)
	require.NoError(h.t, err)
	loaded, err := h.users.GetByID(h.ctx, created.ID)
	require.NoError(h.t, err)
	return loaded
}

// planGroup creates a public standard openai group and makes it the only
// plan group (claudex_provisioning.allowed_group_ids).
func (h *harness) planGroup() *service.Group {
	h.t.Helper()
	g, err := itClient.Group.Create().
		SetName(fmt.Sprintf("claudex-it-%d-%d", uid(), time.Now().UnixNano())).
		SetPlatform(service.PlatformOpenAI).
		SetStatus(service.StatusActive).
		SetSubscriptionType(service.SubscriptionTypeStandard).
		SetRateMultiplier(1).
		Save(h.ctx)
	require.NoError(h.t, err)
	h.adminJSON(http.MethodPut, "/provisioning", fmt.Sprintf(`{"allowed_group_ids":[%d]}`, g.ID))
	return &service.Group{ID: g.ID, Name: g.Name, Platform: service.PlatformOpenAI, SubscriptionType: service.SubscriptionTypeStandard}
}

func (h *harness) token(u *service.User) string {
	h.t.Helper()
	loaded, err := h.users.GetByID(h.ctx, u.ID)
	require.NoError(h.t, err)
	tok, err := h.auth.GenerateToken(h.ctx, loaded)
	require.NoError(h.t, err)
	return tok
}

func (h *harness) do(method, path, token string, headers map[string]string, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	h.router.ServeHTTP(rec, req)
	return rec
}

// adminJSON calls an /api/v1/admin/claudex route and requires 200.
func (h *harness) adminJSON(method, path, body string) json.RawMessage {
	h.t.Helper()
	rec := h.do(method, "/api/v1/admin/claudex"+path, "", nil, body)
	require.Equal(h.t, http.StatusOK, rec.Code, "%s %s: %s", method, path, rec.Body.String())
	return decodeEnv(h.t, rec).Data
}

type envelope struct {
	Code     json.RawMessage   `json:"code"`
	Message  string            `json:"message"`
	Reason   string            `json:"reason"`
	Metadata map[string]string `json:"metadata"`
	Data     json.RawMessage   `json:"data"`
}

func decodeEnv(t *testing.T, rec *httptest.ResponseRecorder) envelope {
	t.Helper()
	var e envelope
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &e), rec.Body.String())
	return e
}

// device is a registered desktop: its id headers and device key.
type device struct {
	ID      string
	KeyID   int64
	Key     string
	Headers map[string]string
}

func deviceHeaders(id, version string) map[string]string {
	return map[string]string{
		core.HeaderDeviceID:  id,
		"X-Claudex-Platform": "darwin", "X-Claudex-Arch": "arm64", "X-Claudex-Version": version,
	}
}

func (h *harness) register(token, deviceID string) *httptest.ResponseRecorder {
	return h.do(http.MethodPost, "/api/v1/claudex/devices", token, deviceHeaders(deviceID, "1.4.0"),
		`{"device_name":"IT Mac","platform":"darwin","arch":"arm64","app_version":"1.4.0"}`)
}

func (h *harness) mustRegister(token string) device {
	h.t.Helper()
	id := newDeviceID()
	rec := h.register(token, id)
	require.Equal(h.t, http.StatusOK, rec.Code, rec.Body.String())
	var out struct {
		APIKey struct {
			ID  int64  `json:"id"`
			Key string `json:"key"`
		} `json:"api_key"`
	}
	require.NoError(h.t, json.Unmarshal(decodeEnv(h.t, rec).Data, &out))
	require.NotEmpty(h.t, out.APIKey.Key)
	return device{ID: id, KeyID: out.APIKey.ID, Key: out.APIKey.Key, Headers: deviceHeaders(id, "1.4.0")}
}

// adminUserKey creates a user API key through the administrator route (R13-A).
func (h *harness) adminUserKey(userID, groupID int64, name string) (int64, string) {
	h.t.Helper()
	data := h.adminJSON(http.MethodPost, fmt.Sprintf("/users/%d/api-keys", userID), fmt.Sprintf(`{"name":%q,"group_id":%d}`, name, groupID))
	var out struct {
		ID  int64  `json:"id"`
		Key string `json:"key"`
	}
	require.NoError(h.t, json.Unmarshal(data, &out))
	return out.ID, out.Key
}

// gateway sends a gateway request with a key and optional X-Claudex-* headers.
func (h *harness) gateway(method, path, key string, headers map[string]string, body string) *httptest.ResponseRecorder {
	all := map[string]string{}
	for k, v := range headers {
		if k != core.HeaderDeviceID {
			all[k] = v
		}
	}
	return h.do(method, path, key, all, body)
}

type gatewayRefusal struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Error   *struct {
		Type    string `json:"type"`
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
	Claudex *gatewayhook.RefusalDetail `json:"claudex"`
}

func refusalOf(t *testing.T, rec *httptest.ResponseRecorder) gatewayRefusal {
	t.Helper()
	var out gatewayRefusal
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out), rec.Body.String())
	return out
}

func keyStatus(t *testing.T, id int64) (status string, deleted bool) {
	t.Helper()
	var del sql.NullTime
	require.NoError(t, itDB.QueryRow(`SELECT status, deleted_at FROM api_keys WHERE id = $1`, id).Scan(&status, &del))
	return status, del.Valid
}

// wsURL is the test server's address of a gateway path.
func (h *harness) wsURL(path string) string {
	return "ws" + strings.TrimPrefix(h.server.URL, "http") + path
}

// dial opens a gateway WebSocket with a key and headers.
func (h *harness) dial(path, key string, headers map[string]string) (*coderws.Conn, *http.Response, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	hdr := http.Header{}
	hdr.Set("Authorization", "Bearer "+key)
	for k, v := range headers {
		if k != core.HeaderDeviceID {
			hdr.Set(k, v)
		}
	}
	return coderws.Dial(ctx, h.wsURL(path), &coderws.DialOptions{HTTPHeader: hdr})
}

// sseEvents lists the "event:" names of an SSE body.
func sseEvents(body string) []string {
	var out []string
	sc := bufio.NewScanner(strings.NewReader(body))
	for sc.Scan() {
		if name, ok := strings.CutPrefix(sc.Text(), "event: "); ok {
			out = append(out, name)
		}
	}
	return out
}

// readFixture reads a contract fixture (the JSON the desktop app's tests read).
func readFixtureRaw(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(fixtureDir + "/" + name)
	require.NoError(t, err)
	return raw
}
