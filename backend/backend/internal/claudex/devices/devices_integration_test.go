//go:build integration

package devices_test

// Integration tests of the B4 devices component against PostgreSQL with every
// upstream and Claudex migration applied, the real upstream API key service,
// JWT and API-key middlewares, the /api/v1/keys handler (H13) and the
// "log out of all devices" handler (H9).

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
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
	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/core/testsupport"
	"github.com/Wei-Shaw/sub2api/internal/claudex/devices"
	"github.com/Wei-Shaw/sub2api/internal/claudex/gatewayhook"
	claudexhook "github.com/Wei-Shaw/sub2api/internal/claudex/hook"
	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/handler" //nolint:depguard // the test drives the real /api/v1/keys and revoke-all handlers
	"github.com/Wei-Shaw/sub2api/internal/pkg/timezone"
	"github.com/Wei-Shaw/sub2api/internal/repository" //nolint:depguard // the test wires the real upstream repositories
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
	"github.com/gin-gonic/gin"
	_ "github.com/lib/pq"
	"github.com/stretchr/testify/require"
)

var (
	itDB     *sql.DB
	itClient *dbent.Client
	seq      atomic.Int64
)

func TestMain(m *testing.M) {
	ctx := context.Background()
	if err := timezone.Init("UTC"); err != nil {
		log.Fatalf("timezone: %v", err)
	}
	// Labelled for this go.sh run, so the script removes only its own containers.
	pg, err := testsupport.StartPostgres(ctx, "claudex_devices_test")
	if err != nil {
		if testsupport.Skip(err) {
			log.Printf("docker is not available; skipping the devices integration tests: %v", err)
			os.Exit(0)
		}
		log.Fatalf("start postgres: %v", err)
	}
	itDB, err = pg.Open(ctx)
	if err != nil {
		log.Fatalf("open db: %v", err)
	}
	if err := repository.ApplyMigrations(ctx, itDB); err != nil {
		log.Fatalf("migrations: %v", err)
	}
	itClient = dbent.NewClient(dbent.Driver(entsql.OpenDB(dialect.Postgres, itDB)))

	code := m.Run()

	_ = itClient.Close()
	_ = itDB.Close()
	pg.Terminate(ctx)
	os.Exit(code)
}

// ---- fakes ----

type memSettings struct {
	mu     sync.Mutex
	values map[string]string
}

func (m *memSettings) Get(ctx context.Context, key string) (*service.Setting, error) {
	v, err := m.GetValue(ctx, key)
	if err != nil {
		return nil, err
	}
	return &service.Setting{Key: key, Value: v}, nil
}
func (m *memSettings) GetValue(_ context.Context, key string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	v, ok := m.values[key]
	if !ok {
		return "", service.ErrSettingNotFound
	}
	return v, nil
}
func (m *memSettings) Set(_ context.Context, key, value string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.values[key] = value
	return nil
}
func (m *memSettings) GetMultiple(context.Context, []string) (map[string]string, error) {
	return nil, errors.New("not used")
}
func (m *memSettings) SetMultiple(context.Context, map[string]string) error {
	return errors.New("not used")
}
func (m *memSettings) GetAll(context.Context) (map[string]string, error) {
	return nil, errors.New("not used")
}
func (m *memSettings) Delete(context.Context, string) error { return errors.New("not used") }

// refreshCache records the upstream refresh-token revocations.
type refreshCache struct {
	service.RefreshTokenCache
	mu       sync.Mutex
	families []string
	users    []int64
}

func (r *refreshCache) DeleteTokenFamily(_ context.Context, family string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.families = append(r.families, family)
	return nil
}
func (r *refreshCache) DeleteUserRefreshTokens(_ context.Context, userID int64) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.users = append(r.users, userID)
	return nil
}

// flakyKeys wraps the real API key service and fails chosen calls.
type flakyKeys struct {
	*service.APIKeyService
	failDisable  atomic.Bool  // Update with status=disabled
	failDeleteID atomic.Int64 // Delete of this key id
}

func (f *flakyKeys) Update(ctx context.Context, id, userID int64, req service.UpdateAPIKeyRequest) (*service.APIKey, error) {
	if f.failDisable.Load() && req.Status != nil && *req.Status == service.StatusAPIKeyDisabled {
		return nil, errors.New("injected: database unavailable")
	}
	return f.APIKeyService.Update(ctx, id, userID, req)
}

func (f *flakyKeys) Delete(ctx context.Context, id, userID int64) error {
	if id == f.failDeleteID.Load() {
		return errors.New("injected: database unavailable")
	}
	return f.APIKeyService.Delete(ctx, id, userID)
}

// ---- harness ----

type harness struct {
	t       *testing.T
	ctx     context.Context
	cfg     *config.Config
	keys    *service.APIKeyService
	auth    *service.AuthService
	users   *service.UserService
	refresh *refreshCache
	comp    *devices.Component
	router  *gin.Engine
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	gin.SetMode(gin.TestMode)
	gatewayhook.Reset()
	claudexhook.Reset()
	t.Cleanup(func() {
		gatewayhook.Reset()
		claudexhook.Reset()
	})
	cfg := &config.Config{}
	cfg.JWT.Secret = "claudex-devices-integration-secret-0123456789"
	cfg.JWT.AccessTokenExpireMinutes = 60
	cfg.JWT.RefreshTokenExpireDays = 30

	userRepo := repository.NewUserRepository(itClient, itDB)
	groupRepo := repository.NewGroupRepository(itClient, itDB)
	subRepo := repository.NewUserSubscriptionRepository(itClient)
	keys := service.NewAPIKeyService(repository.NewAPIKeyRepository(itClient, itDB), userRepo, groupRepo, subRepo, nil, nil, cfg)
	subs := service.NewSubscriptionService(groupRepo, subRepo, nil, itClient, cfg)
	refresh := &refreshCache{}
	auth := service.NewAuthService(itClient, userRepo, nil, refresh, cfg, nil, nil, nil, nil, nil, nil, nil, nil)
	users := service.NewUserService(userRepo, nil, nil, nil)

	env := &core.Env{Deps: core.Deps{
		SettingRepo: &memSettings{values: map[string]string{}}, AuthService: auth, DB: itDB, Config: cfg,
		APIKeys: keys, Subscriptions: subs, Users: users, UserRepo: userRepo, GroupRepo: groupRepo,
	}, Now: time.Now}
	comp := devices.New(env)
	env.Peers = core.Peers{Plans: comp, Devices: comp, Sessions: comp}
	// What claudex.ProvideModule installs for this component.
	gatewayhook.RegisterKeyMarker(comp)
	gatewayhook.RegisterRequestGuard(comp)
	claudexhook.Install(claudexhook.Hooks{
		JWTRevoked:       comp.Check,
		SessionsRevoked:  comp.OnSessionsRevoked,
		ManagedAPIKeyIDs: comp.ManagedAPIKeyIDs,
		CreateAPIKey:     comp.AllowUserAPIKeyCreate,
	})

	r := gin.New()
	jwt := gin.HandlerFunc(middleware.NewJWTAuthMiddleware(auth, users, nil, nil))
	api := r.Group("/api/v1")
	cx := api.Group("/claudex")
	cx.Use(jwt, core.ValidateClientHeaders())
	comp.RegisterUserRoutes(cx)
	kh := handler.NewAPIKeyHandler(keys)
	kg := api.Group("/keys")
	kg.Use(jwt)
	kg.GET("", kh.List)
	kg.GET("/:id", kh.GetByID)
	kg.POST("", kh.Create)
	kg.PUT("/:id", kh.Update)
	kg.DELETE("/:id", kh.Delete)
	ah := handler.NewAuthHandler(cfg, auth, users, nil, nil, nil, nil, nil)
	api.POST("/auth/revoke-all-sessions", jwt, ah.RevokeAllSessions)
	adminUser, err := itClient.User.Create().
		SetEmail(fmt.Sprintf("admin-%d-%d@example.com", uid(), time.Now().UnixNano())).
		SetPasswordHash("x").SetRole(service.RoleAdmin).SetStatus(service.StatusActive).Save(context.Background())
	require.NoError(t, err)
	admin := api.Group("/admin/claudex")
	admin.Use(func(c *gin.Context) {
		c.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: adminUser.ID})
		c.Set(string(middleware.ContextKeyUserRole), service.RoleAdmin)
		c.Next()
	})
	comp.RegisterAdminRoutes(admin, func(c *gin.Context) { c.Next() })
	v1 := r.Group("/v1")
	v1.Use(gatewayhook.EnrichRefusals(), gin.HandlerFunc(middleware.NewAPIKeyAuthMiddleware(keys, subs, cfg)))
	v1.POST("/messages", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) })

	return &harness{t: t, ctx: context.Background(), cfg: cfg, keys: keys, auth: auth, users: users, refresh: refresh, comp: comp, router: r}
}

func uid() int64 { return seq.Add(1) }

func newDeviceID() string {
	n := uid()
	return fmt.Sprintf("%08x-9b0d-4c1e-8a57-%012x", n, time.Now().UnixNano()&0xffffffffffff)
}

func (h *harness) user() *service.User {
	h.t.Helper()
	u := &service.User{}
	require.NoError(h.t, u.SetPassword("old-password-1"))
	created, err := itClient.User.Create().
		SetEmail(fmt.Sprintf("dev-%d-%d@example.com", uid(), time.Now().UnixNano())).
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

func (h *harness) group(platform, subscriptionType string) *service.Group {
	h.t.Helper()
	g, err := itClient.Group.Create().
		SetName(fmt.Sprintf("claudex-it-%d-%d", uid(), time.Now().UnixNano())).
		SetPlatform(platform).
		SetStatus(service.StatusActive).
		SetSubscriptionType(subscriptionType).
		SetRateMultiplier(1).
		Save(h.ctx)
	require.NoError(h.t, err)
	return &service.Group{ID: g.ID, Name: g.Name, Platform: platform, SubscriptionType: subscriptionType}
}

// planGroup creates a public standard openai group and makes it the only
// plan group of this harness (the database also holds the seeded default
// group and the groups of other tests).
func (h *harness) planGroup() *service.Group {
	h.t.Helper()
	g := h.group(service.PlatformOpenAI, service.SubscriptionTypeStandard)
	h.setProvisioning(fmt.Sprintf(`{"allowed_group_ids":[%d]}`, g.ID))
	return g
}

func (h *harness) subscribe(userID, groupID int64, expires time.Duration) {
	h.t.Helper()
	now := time.Now()
	_, err := itClient.UserSubscription.Create().
		SetUserID(userID).SetGroupID(groupID).
		SetStartsAt(now.Add(-time.Hour)).SetExpiresAt(now.Add(expires)).
		SetStatus(service.SubscriptionStatusActive).SetAssignedAt(now).
		Save(h.ctx)
	require.NoError(h.t, err)
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
	req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
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

type envelope struct {
	Code     int               `json:"code"`
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

func (h *harness) register(token, deviceID, body string) *httptest.ResponseRecorder {
	if body == "" {
		body = `{"device_name":"Test Mac","platform":"darwin","arch":"arm64","app_version":"1.3.2"}`
	}
	return h.do(http.MethodPost, "/api/v1/claudex/devices", token, map[string]string{core.HeaderDeviceID: deviceID}, body)
}

func (h *harness) mustRegister(token, deviceID, body string) devices.RegisterResponse {
	h.t.Helper()
	rec := h.register(token, deviceID, body)
	require.Equal(h.t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(h.t, "no-store", rec.Header().Get("Cache-Control"))
	var out devices.RegisterResponse
	require.NoError(h.t, json.Unmarshal(decodeEnv(h.t, rec).Data, &out))
	return out
}

func (h *harness) gateway(key string) *httptest.ResponseRecorder {
	return h.do(http.MethodPost, "/v1/messages", key, nil, `{"model":"gpt-5","messages":[]}`)
}

func (h *harness) setProvisioning(body string) {
	h.t.Helper()
	rec := h.do(http.MethodPut, "/api/v1/admin/claudex/provisioning", "", nil, body)
	require.Equal(h.t, http.StatusOK, rec.Code, rec.Body.String())
}

type keyRow struct {
	Status    string
	Quota     float64
	DeletedAt sql.NullTime
	UpdatedAt time.Time
	Name      string
	GroupID   sql.NullInt64
}

func keyState(t *testing.T, id int64) keyRow {
	t.Helper()
	var k keyRow
	require.NoError(t, itDB.QueryRow(`SELECT status, quota, deleted_at, updated_at, name, group_id FROM api_keys WHERE id = $1`, id).
		Scan(&k.Status, &k.Quota, &k.DeletedAt, &k.UpdatedAt, &k.Name, &k.GroupID))
	return k
}

func activeKeyCount(t *testing.T, userID int64) int {
	t.Helper()
	var n int
	require.NoError(t, itDB.QueryRow(`SELECT COUNT(*) FROM api_keys WHERE user_id = $1 AND deleted_at IS NULL AND status = 'active'`, userID).Scan(&n))
	return n
}

func deviceCount(t *testing.T, userID int64) int {
	t.Helper()
	var n int
	require.NoError(t, itDB.QueryRow(`SELECT COUNT(*) FROM claudex_devices WHERE user_id = $1`, userID).Scan(&n))
	return n
}

// refusal decodes a gateway error with its "claudex" object.
func refusal(t *testing.T, rec *httptest.ResponseRecorder) (code, reason string) {
	t.Helper()
	var body struct {
		Code    string `json:"code"`
		Claudex *struct {
			Reason string `json:"reason"`
			Action string `json:"action"`
		} `json:"claudex"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body), rec.Body.String())
	if body.Claudex != nil {
		reason = body.Claudex.Reason
	}
	return body.Code, reason
}

// waitNextSecond sleeps until a new wall-clock second so a token issued now
// is later than a revocation made before (JWT iat has whole seconds).
func waitNextSecond() {
	time.Sleep(time.Until(time.Now().Truncate(time.Second).Add(time.Second + 20*time.Millisecond)))
}

// ---- tests ----

func TestRegisterIsIdempotentUnderConcurrency(t *testing.T) {
	h := newHarness(t)
	u := h.user()
	g := h.planGroup()
	tok := h.token(u)
	dev := newDeviceID()

	const n = 10
	var wg sync.WaitGroup
	results := make([]*httptest.ResponseRecorder, n)
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			results[i] = h.register(tok, dev, "")
		}(i)
	}
	close(start)
	wg.Wait()

	var keyID int64
	var key string
	created := 0
	for _, rec := range results {
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var out devices.RegisterResponse
		require.NoError(t, json.Unmarshal(decodeEnv(t, rec).Data, &out))
		if keyID == 0 {
			keyID, key = out.APIKey.ID, out.APIKey.Key
		}
		require.Equal(t, keyID, out.APIKey.ID, "every registration returns the same key")
		require.Equal(t, key, out.APIKey.Key)
		require.Equal(t, g.ID, out.Plan.GroupID)
		if out.Created {
			created++
		}
	}
	require.Equal(t, 1, created, "exactly one registration created the device")
	require.Equal(t, 1, deviceCount(t, u.ID))
	require.Equal(t, 1, activeKeyCount(t, u.ID), "exactly one key")
	k := keyState(t, keyID)
	require.True(t, strings.HasPrefix(k.Name, "claudex-device:"), k.Name)
	require.Equal(t, g.ID, k.GroupID.Int64)

	// The raw device id is stored nowhere.
	var leaked int
	require.NoError(t, itDB.QueryRow(`SELECT COUNT(*) FROM claudex_devices WHERE device_id_hash = $1 OR device_name = $1 OR session_family_id = $1`,
		dev).Scan(&leaked))
	require.Zero(t, leaked)
	var hash string
	require.NoError(t, itDB.QueryRow(`SELECT device_id_hash FROM claudex_devices WHERE user_id = $1`, u.ID).Scan(&hash))
	require.Equal(t, devices.DeviceHash(dev), hash)

	// Later sign-ins reuse the key; the key works on the gateway.
	again := h.mustRegister(tok, dev, `{"device_name":"Renamed","app_version":"1.4.0"}`)
	require.False(t, again.Created || again.Moved || again.Rotated)
	require.Equal(t, keyID, again.APIKey.ID)
	require.Equal(t, "Renamed", again.Device.DeviceName)
	require.Equal(t, "1.4.0", again.Device.AppVersion)
	require.Equal(t, http.StatusOK, h.gateway(key).Code)

	// The gateway use is recorded as activity (asynchronously, at most every 5 minutes).
	_, err := itDB.Exec(`UPDATE claudex_devices SET last_seen_at = NULL WHERE user_id = $1`, u.ID)
	require.NoError(t, err)
	h2 := newHarness(t) // fresh caches
	require.Equal(t, http.StatusOK, h2.gateway(key).Code)
	require.Eventually(t, func() bool {
		var seen sql.NullTime
		_ = itDB.QueryRow(`SELECT last_seen_at FROM claudex_devices WHERE user_id = $1`, u.ID).Scan(&seen)
		return seen.Valid
	}, 3*time.Second, 50*time.Millisecond)
}

func TestDeviceLimitHoldsUnderConcurrency(t *testing.T) {
	h := newHarness(t)
	u := h.user()
	h.planGroup()
	tok := h.token(u)

	const n = 10
	var wg sync.WaitGroup
	codes := make([]*httptest.ResponseRecorder, n)
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			codes[i] = h.register(tok, newDeviceID(), "")
		}(i)
	}
	close(start)
	wg.Wait()
	ok, conflict := 0, 0
	for _, rec := range codes {
		switch rec.Code {
		case http.StatusOK:
			ok++
		case http.StatusConflict:
			conflict++
			e := decodeEnv(t, rec)
			require.Equal(t, "CLAUDEX_DEVICE_LIMIT", e.Reason)
			require.Equal(t, devices.DeviceLimitMessage(5), e.Message)
			require.Equal(t, map[string]string{"limit": "5", "active": "5"}, e.Metadata)
		default:
			t.Fatalf("unexpected answer %d: %s", rec.Code, rec.Body.String())
		}
	}
	require.Equal(t, 5, ok)
	require.Equal(t, 5, conflict)
	require.Equal(t, 5, deviceCount(t, u.ID))
	require.Equal(t, 5, activeKeyCount(t, u.ID), "refused sign-ins create no key")

	// Per-user limit: raise to 6, one more device fits.
	path := fmt.Sprintf("/api/v1/admin/claudex/users/%d/device-limit", u.ID)
	rec := h.do(http.MethodPut, path, "", nil, `{"max_devices":6}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var lim devices.DeviceLimitJSON
	require.NoError(t, json.Unmarshal(decodeEnv(t, rec).Data, &lim))
	require.Equal(t, devices.DeviceLimitJSON{UserID: u.ID, MaxDevices: 6, Default: 5, Source: "user", ActiveDevices: 5}, lim)
	sixth := newDeviceID()
	h.mustRegister(tok, sixth, "")
	rec = h.register(tok, newDeviceID(), "")
	require.Equal(t, http.StatusConflict, rec.Code)
	require.Equal(t, devices.DeviceLimitMessage(6), decodeEnv(t, rec).Message)
	require.Equal(t, http.StatusBadRequest, h.do(http.MethodPut, path, "", nil, `{"max_devices":51}`).Code)

	// Back to the default: nothing is signed out, only new devices are refused.
	rec = h.do(http.MethodDelete, path, "", nil, "")
	require.Equal(t, http.StatusOK, rec.Code)
	require.NoError(t, json.Unmarshal(decodeEnv(t, rec).Data, &lim))
	require.Equal(t, devices.DeviceLimitJSON{UserID: u.ID, MaxDevices: 5, Default: 5, Source: "default", ActiveDevices: 6}, lim)
	require.Equal(t, 6, activeKeyCount(t, u.ID))
	h.mustRegister(tok, sixth, "") // an existing device still signs in
	require.Equal(t, http.StatusConflict, h.register(tok, newDeviceID(), "").Code)

	// Signing out on two devices frees room for a new one.
	rec = h.do(http.MethodDelete, "/api/v1/claudex/devices/current", tok, map[string]string{core.HeaderDeviceID: sixth}, "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	tok2 := h.token(u) // the first token's session was just signed out
	var mine struct {
		Items []devices.MyDeviceJSON `json:"items"`
		Limit int                    `json:"limit"`
	}
	rec = h.do(http.MethodGet, "/api/v1/claudex/devices", tok2, nil, "")
	require.Equal(t, http.StatusOK, rec.Code)
	require.NoError(t, json.Unmarshal(decodeEnv(t, rec).Data, &mine))
	require.Equal(t, 5, mine.Limit)
	var active []devices.MyDeviceJSON
	for _, d := range mine.Items {
		if !d.Revoked {
			active = append(active, d)
		}
	}
	require.Len(t, active, 5)
	rec = h.do(http.MethodDelete, fmt.Sprintf("/api/v1/claudex/devices/%d", active[0].ID), tok2, nil, "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	tok3 := h.token(u)
	h.mustRegister(tok3, newDeviceID(), "")

	// Unknown user for the limit endpoints.
	require.Equal(t, "CLAUDEX_USER_NOT_FOUND", decodeEnv(t, h.do(http.MethodGet, "/api/v1/admin/claudex/users/999999999/device-limit", "", nil, "")).Reason)
}

func TestLegacyKeyIsDisabledNotAdopted(t *testing.T) {
	h := newHarness(t)
	u := h.user()
	g := h.planGroup()
	dev := newDeviceID()
	gid := g.ID
	legacy, err := h.keys.Create(h.ctx, u.ID, service.CreateAPIKeyRequest{Name: "claudex-desktop:" + dev, GroupID: &gid})
	require.NoError(t, err)
	backup, err := h.keys.Create(h.ctx, u.ID, service.CreateAPIKeyRequest{Name: "claudex-desktop:" + dev + "-backup", GroupID: &gid})
	require.NoError(t, err)
	backupBefore := keyState(t, backup.ID)

	out := h.mustRegister(h.token(u), dev, "")
	require.True(t, out.Created)
	require.NotEqual(t, legacy.ID, out.APIKey.ID, "the legacy key is not adopted")
	require.NotEqual(t, legacy.Key, out.APIKey.Key)
	require.True(t, strings.HasPrefix(keyState(t, out.APIKey.ID).Name, "claudex-device:"))

	l := keyState(t, legacy.ID)
	require.Equal(t, service.StatusAPIKeyDisabled, l.Status, "the legacy key is disabled")
	require.False(t, l.DeletedAt.Valid, "and kept with its usage history")
	require.Equal(t, backupBefore, keyState(t, backup.ID), "a key that only contains the legacy name is untouched")
	require.Equal(t, http.StatusUnauthorized, h.gateway(legacy.Key).Code)
	require.Equal(t, http.StatusOK, h.gateway(backup.Key).Code)
	require.Equal(t, http.StatusOK, h.gateway(out.APIKey.Key).Code)

	// The legacy key is a user key, not a device key.
	require.Equal(t, map[int64]bool{out.APIKey.ID: true}, h.comp.ManagedAPIKeyIDs(h.ctx, u.ID, []int64{legacy.ID, backup.ID, out.APIKey.ID}))
}

func TestPlanChangeMovesTheKeyAndBootstrapSeesIt(t *testing.T) {
	h := newHarness(t)
	u := h.user()
	public := h.group(service.PlatformAnthropic, service.SubscriptionTypeStandard)
	pro := h.group(service.PlatformOpenAI, service.SubscriptionTypeSubscription)
	h.setProvisioning(fmt.Sprintf(`{"allowed_group_ids":[%d,%d]}`, public.ID, pro.ID))
	tok := h.token(u)
	dev := newDeviceID()

	first := h.mustRegister(tok, dev, "")
	require.Equal(t, public.ID, first.Plan.GroupID)
	require.Equal(t, "chat", first.Plan.Protocol)
	require.False(t, first.Plan.Subscribed)

	section := func(plan *core.PlanRef) devices.DeviceSection {
		out, err := h.comp.BootstrapSections(h.ctx, &core.BootstrapContext{UserID: u.ID, DeviceID: dev, Plan: plan})
		require.NoError(t, err)
		return out[core.SectionDevice].(devices.DeviceSection)
	}
	plan, err := h.comp.ResolvePlan(h.ctx, u.ID, nil)
	require.NoError(t, err)
	s := section(plan)
	require.True(t, s.Registered)
	require.Equal(t, first.Device.ID, *s.ID)
	require.Equal(t, public.ID, *s.KeyGroupID)
	require.False(t, s.ReprovisionNeeded)

	// A subscription makes the subscription group the plan; the next sign-in moves the key.
	h.subscribe(u.ID, pro.ID, 30*24*time.Hour)
	plan, err = h.comp.ResolvePlan(h.ctx, u.ID, nil)
	require.NoError(t, err)
	require.Equal(t, pro.ID, plan.GroupID)
	require.True(t, plan.Subscribed)
	require.Equal(t, "responses", plan.Protocol)
	require.True(t, section(plan).ReprovisionNeeded, "key group differs from the plan")

	// MG: keys never move between groups. The device gets a key in the new
	// plan group, which becomes its plan key; the public group keeps its key.
	moved := h.mustRegister(tok, dev, "")
	require.True(t, moved.Moved)
	require.False(t, moved.Rotated || moved.Created)
	require.NotEqual(t, first.APIKey.ID, moved.APIKey.ID)
	require.Equal(t, pro.ID, keyState(t, moved.APIKey.ID).GroupID.Int64)
	require.Equal(t, public.ID, keyState(t, first.APIKey.ID).GroupID.Int64)
	require.Equal(t, service.StatusAPIKeyActive, keyState(t, first.APIKey.ID).Status)
	require.Len(t, moved.APIKeys, 2)
	require.Equal(t, []int64{pro.ID, public.ID}, []int64{moved.APIKeys[0].GroupID, moved.APIKeys[1].GroupID})
	require.False(t, section(plan).ReprovisionNeeded)
	ref, ok := h.comp.LookupByDeviceID(h.ctx, u.ID, dev)
	require.True(t, ok)
	require.Equal(t, moved.APIKey.ID, ref.APIKeyID)
	require.Equal(t, pro.ID, *ref.GroupID)

	// The client may ask for another group it can use: its key becomes the plan key.
	back := h.mustRegister(tok, dev, fmt.Sprintf(`{"group_id":%d}`, public.ID))
	require.True(t, back.Moved)
	require.Equal(t, public.ID, back.Plan.GroupID)
	require.Equal(t, first.APIKey.ID, back.APIKey.ID)
	require.Equal(t, 2, activeKeyCount(t, u.ID))

	// A disabled or deleted group is never a plan.
	_, err = itClient.Group.UpdateOneID(pro.ID).SetStatus("disabled").Save(h.ctx)
	require.NoError(t, err)
	plan, err = h.comp.ResolvePlan(h.ctx, u.ID, &pro.ID)
	require.NoError(t, err)
	require.Equal(t, public.ID, plan.GroupID)
	_, err = itDB.Exec(`UPDATE groups SET deleted_at = NOW() WHERE id = $1`, public.ID)
	require.NoError(t, err)
	_, err = h.comp.ResolvePlan(h.ctx, u.ID, nil)
	require.ErrorIs(t, err, core.ErrNoPlan)

	// Balance only (owner decision, 2026-10-12): an account without a plan
	// group still signs in; its devices hold no key until a group fits.
	none := h.mustRegister(tok, newDeviceID(), "")
	require.True(t, none.Created)
	require.Nil(t, none.APIKey)
	require.Empty(t, none.APIKeys)
	require.Nil(t, none.Plan)
	gone := h.mustRegister(tok, dev, "")
	require.False(t, gone.Created)
	require.Nil(t, gone.APIKey)
	require.Empty(t, gone.APIKeys)
	require.Equal(t, 0, activeKeyCount(t, u.ID), "the keys of groups the account lost are deleted")
	_, ok = h.comp.LookupByDeviceID(h.ctx, u.ID, dev)
	require.False(t, ok, "a device without a key is no gateway device")
	sections, err := h.comp.BootstrapSections(h.ctx, &core.BootstrapContext{UserID: u.ID, DeviceID: dev, NoPlan: true})
	require.NoError(t, err)
	s = sections[core.SectionDevice].(devices.DeviceSection)
	require.True(t, s.Registered)
	require.False(t, s.ReprovisionNeeded, "nothing to register again without a plan group")
	require.Nil(t, s.KeyGroupID)
	require.Empty(t, s.Keys)
	_, hasPlan := sections[core.SectionPlan]
	require.False(t, hasPlan)
}

func TestUnusableKeysAreRotatedAndFailuresCompensated(t *testing.T) {
	h := newHarness(t)
	u := h.user()
	h.planGroup()
	tok := h.token(u)
	dev := newDeviceID()
	first := h.mustRegister(tok, dev, "")

	// Quota used up: the key is kept (a new key would reset the quota).
	exhausted := service.StatusAPIKeyQuotaExhausted
	_, err := h.keys.Update(h.ctx, first.APIKey.ID, u.ID, service.UpdateAPIKeyRequest{Status: &exhausted})
	require.NoError(t, err)
	same := h.mustRegister(tok, dev, "")
	require.False(t, same.Rotated)
	require.Equal(t, first.APIKey.ID, same.APIKey.ID)

	// Expired: rotated, the old key is deleted.
	past := time.Now().Add(-time.Minute)
	active := service.StatusAPIKeyActive
	_, err = h.keys.Update(h.ctx, first.APIKey.ID, u.ID, service.UpdateAPIKeyRequest{Status: &active, ExpiresAt: &past})
	require.NoError(t, err)
	rotated := h.mustRegister(tok, dev, "")
	require.True(t, rotated.Rotated)
	require.NotEqual(t, first.APIKey.ID, rotated.APIKey.ID)
	require.True(t, keyState(t, first.APIKey.ID).DeletedAt.Valid)
	require.Equal(t, 1, activeKeyCount(t, u.ID))

	// Disabled upstream while the device is signed in: rotated as well.
	disabled := service.StatusAPIKeyDisabled
	_, err = h.keys.Update(h.ctx, rotated.APIKey.ID, u.ID, service.UpdateAPIKeyRequest{Status: &disabled})
	require.NoError(t, err)
	again := h.mustRegister(tok, dev, "")
	require.True(t, again.Rotated)

	// A failure after the new key was created leaves no unmanaged key behind.
	_, err = h.keys.Update(h.ctx, again.APIKey.ID, u.ID, service.UpdateAPIKeyRequest{Status: &disabled})
	require.NoError(t, err)
	flaky := &flakyKeys{APIKeyService: h.keys}
	flaky.failDeleteID.Store(again.APIKey.ID) // the replaced key cannot be deleted
	h.comp.UseKeyStore(flaky)
	rec := h.register(tok, dev, "")
	require.Equal(t, http.StatusInternalServerError, rec.Code, rec.Body.String())
	var newest int64
	require.NoError(t, itDB.QueryRow(`SELECT MAX(id) FROM api_keys WHERE user_id = $1`, u.ID).Scan(&newest))
	require.Greater(t, newest, again.APIKey.ID, "a replacement key was created")
	require.True(t, keyState(t, newest).DeletedAt.Valid, "and deleted again before the answer")
	var pointed int64
	require.NoError(t, itDB.QueryRow(`SELECT api_key_id FROM claudex_devices WHERE user_id = $1`, u.ID).Scan(&pointed))
	require.Equal(t, again.APIKey.ID, pointed, "the device still points at its old key")
	require.Zero(t, activeKeyCount(t, u.ID))
	h.comp.UseKeyStore(h.keys)
	final := h.mustRegister(tok, dev, "")
	require.True(t, final.Rotated)
	require.Equal(t, 1, activeKeyCount(t, u.ID))
}

// TestRevokeAllKeepsUserCreatedKeys pins owner decision 13: "log out of all
// devices" disables device keys only.
func TestRevokeAllKeepsUserCreatedKeys(t *testing.T) {
	h := newHarness(t)
	u := h.user()
	g := h.planGroup()
	tok := h.token(u)
	devA, devB := newDeviceID(), newDeviceID()
	a := h.mustRegister(tok, devA, "")
	b := h.mustRegister(tok, devB, "")
	gid := g.ID
	own, err := h.keys.Create(h.ctx, u.ID, service.CreateAPIKeyRequest{Name: "my script", GroupID: &gid, Quota: 25})
	require.NoError(t, err)
	lookalike, err := h.keys.Create(h.ctx, u.ID, service.CreateAPIKeyRequest{Name: "claudex-desktop:" + newDeviceID(), GroupID: &gid})
	require.NoError(t, err)
	ownBefore, lookBefore := keyState(t, own.ID), keyState(t, lookalike.ID)

	rec := h.do(http.MethodPost, "/api/v1/auth/revoke-all-sessions", tok, nil, "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, []int64{u.ID}, h.refresh.users, "the upstream refresh tokens are revoked too")

	require.Equal(t, service.StatusAPIKeyDisabled, keyState(t, a.APIKey.ID).Status)
	require.Equal(t, service.StatusAPIKeyDisabled, keyState(t, b.APIKey.ID).Status)
	require.Equal(t, ownBefore, keyState(t, own.ID), "status, quota, deleted_at and updated_at unchanged")
	require.Equal(t, lookBefore, keyState(t, lookalike.ID), "a claudex-desktop: name alone does not make a device key")
	require.Equal(t, http.StatusOK, h.gateway(own.Key).Code, "user keys still pass gateway auth")
	require.Equal(t, http.StatusOK, h.gateway(lookalike.Key).Code)

	for _, key := range []string{a.APIKey.Key, b.APIKey.Key} {
		rec := h.gateway(key)
		require.Equal(t, http.StatusUnauthorized, rec.Code)
		code, reason := refusal(t, rec)
		require.Equal(t, "API_KEY_DISABLED", code)
		require.Equal(t, "DEVICE_REVOKED", reason)
	}
	// Old access tokens are refused on every JWT endpoint.
	for _, probe := range []struct{ method, path string }{
		{http.MethodGet, "/api/v1/keys"},
		{http.MethodGet, "/api/v1/claudex/devices"},
		{http.MethodPost, "/api/v1/claudex/devices"},
	} {
		rec := h.do(probe.method, probe.path, tok, map[string]string{core.HeaderDeviceID: devA}, "{}")
		require.Equal(t, http.StatusUnauthorized, rec.Code, probe.path)
		require.Contains(t, rec.Body.String(), "CLAUDEX_SESSION_REVOKED", probe.path)
	}

	// Turning a device key back on does not bring the device back.
	active := service.StatusAPIKeyActive
	_, err = h.keys.Update(h.ctx, a.APIKey.ID, u.ID, service.UpdateAPIKeyRequest{Status: &active})
	require.NoError(t, err)
	rec = h.gateway(a.APIKey.Key)
	require.Equal(t, http.StatusUnauthorized, rec.Code)
	code, reason := refusal(t, rec)
	require.Equal(t, "API_KEY_DISABLED", code)
	require.Equal(t, "DEVICE_REVOKED", reason)
	n, err := h.comp.ReconcileNow(h.ctx)
	require.NoError(t, err)
	require.Equal(t, 1, n, "the reconciliation turns it off again")
	require.Equal(t, service.StatusAPIKeyDisabled, keyState(t, a.APIKey.ID).Status)
	ownAfter := keyState(t, own.ID) // its gateway use above moved updated_at (last used), nothing else
	require.Equal(t, service.StatusAPIKeyActive, ownAfter.Status)
	require.Equal(t, ownBefore.Quota, ownAfter.Quota)
	require.False(t, ownAfter.DeletedAt.Valid)

	// Signing in again (a new token) re-registers the device with a new key.
	waitNextSecond()
	fresh := h.token(u)
	back := h.mustRegister(fresh, devA, "")
	require.True(t, back.Rotated)
	require.NotEqual(t, a.APIKey.ID, back.APIKey.ID)
	require.Equal(t, http.StatusOK, h.gateway(back.APIKey.Key).Code)
	require.Equal(t, http.StatusOK, h.do(http.MethodGet, "/api/v1/keys", fresh, nil, "").Code)
}

func TestRevokeAllFailureIsReportedAndReconciled(t *testing.T) {
	h := newHarness(t)
	u := h.user()
	h.planGroup()
	tok := h.token(u)
	a := h.mustRegister(tok, newDeviceID(), "")
	b := h.mustRegister(tok, newDeviceID(), "")

	flaky := &flakyKeys{APIKeyService: h.keys}
	flaky.failDisable.Store(true)
	h.comp.UseKeyStore(flaky)
	rec := h.do(http.MethodPost, "/api/v1/auth/revoke-all-sessions", tok, nil, "")
	require.Equal(t, http.StatusInternalServerError, rec.Code, "the failure is not reported as success")
	require.Equal(t, service.StatusAPIKeyActive, keyState(t, a.APIKey.ID).Status)
	// The devices are already refused on the gateway (revocation record).
	for _, key := range []string{a.APIKey.Key, b.APIKey.Key} {
		rec := h.gateway(key)
		require.Equal(t, http.StatusUnauthorized, rec.Code)
		_, reason := refusal(t, rec)
		require.Equal(t, "DEVICE_REVOKED", reason)
	}
	n, err := h.comp.ReconcileNow(h.ctx)
	require.Error(t, err, "still failing")
	require.Zero(t, n)

	flaky.failDisable.Store(false)
	n, err = h.comp.ReconcileNow(h.ctx)
	require.NoError(t, err)
	require.Equal(t, 2, n)
	require.Equal(t, service.StatusAPIKeyDisabled, keyState(t, a.APIKey.ID).Status)
	require.Equal(t, service.StatusAPIKeyDisabled, keyState(t, b.APIKey.ID).Status)
	n, err = h.comp.ReconcileNow(h.ctx)
	require.NoError(t, err)
	require.Zero(t, n)
}

// TestSignedInAtFollowsSignIns (claudex_0141, Settings → Account → Active
// sessions): registering again within one sign-in keeps the device's
// sign-in time; signing in again after the device was signed out from
// another device starts it anew. GET /devices answers it as signed_in_at.
func TestSignedInAtFollowsSignIns(t *testing.T) {
	h := newHarness(t)
	u := h.user()
	h.planGroup()
	old := time.Now().Add(-48 * time.Hour).UTC().Truncate(time.Second)
	signedInAt := func(id int64) time.Time {
		t.Helper()
		var at time.Time
		require.NoError(t, itDB.QueryRow(`SELECT signed_in_at FROM claudex_devices WHERE id = $1`, id).Scan(&at))
		return at
	}
	backdate := func(id int64) {
		t.Helper()
		_, err := itDB.Exec(`UPDATE claudex_devices SET signed_in_at = $2 WHERE id = $1`, id, old)
		require.NoError(t, err)
	}

	tokA, devA := h.token(u), newDeviceID()
	a := h.mustRegister(tokA, devA, "")
	require.WithinDuration(t, time.Now(), signedInAt(a.Device.ID), time.Minute)
	backdate(a.Device.ID)
	h.mustRegister(tokA, devA, "")
	require.True(t, old.Equal(signedInAt(a.Device.ID)), "the same sign-in")

	tokB, devB := h.token(u), newDeviceID()
	b := h.mustRegister(tokB, devB, "")
	backdate(b.Device.ID)
	// A logs B out (the Active sessions table's Terminate).
	rec := h.do(http.MethodDelete, fmt.Sprintf("/api/v1/claudex/devices/%d", b.Device.ID), tokA, map[string]string{core.HeaderDeviceID: devA}, "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	tokC := h.token(u)
	h.mustRegister(tokC, devB, "")
	require.True(t, signedInAt(b.Device.ID).After(old), "a new sign-in")

	rec = h.do(http.MethodGet, "/api/v1/claudex/devices", tokC, map[string]string{core.HeaderDeviceID: devB}, "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var mine struct {
		Items []devices.MyDeviceJSON `json:"items"`
	}
	require.NoError(t, json.Unmarshal(decodeEnv(t, rec).Data, &mine))
	require.Len(t, mine.Items, 2)
	require.True(t, old.Equal(mine.Items[0].SignedInAt))
	require.False(t, mine.Items[0].Current)
	require.True(t, mine.Items[1].Current)
	require.False(t, mine.Items[1].Revoked)
	require.True(t, mine.Items[1].SignedInAt.After(old))
}

func TestSignOutOneDevice(t *testing.T) {
	h := newHarness(t)
	u := h.user()
	h.planGroup()
	tokA, tokB := h.token(u), h.token(u)
	devA, devB := newDeviceID(), newDeviceID()
	a := h.mustRegister(tokA, devA, "")
	b := h.mustRegister(tokB, devB, "")

	rec := h.do(http.MethodDelete, "/api/v1/claudex/devices/current", tokA, map[string]string{core.HeaderDeviceID: devA}, "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.JSONEq(t, `{"revoked":true}`, string(decodeEnv(t, rec).Data))
	require.Equal(t, service.StatusAPIKeyDisabled, keyState(t, a.APIKey.ID).Status)
	require.Len(t, h.refresh.families, 1, "the device's refresh-token family is dropped")
	var reason string
	require.NoError(t, itDB.QueryRow(`SELECT revoked_reason FROM claudex_devices WHERE id = $1`, a.Device.ID).Scan(&reason))
	require.Equal(t, devices.ReasonUser, reason)

	// Only that session ends; the other device keeps working.
	rec = h.do(http.MethodGet, "/api/v1/claudex/devices", tokA, nil, "")
	require.Equal(t, http.StatusUnauthorized, rec.Code)
	require.Contains(t, rec.Body.String(), "CLAUDEX_SESSION_REVOKED")
	_, reasonA := refusal(t, h.gateway(a.APIKey.Key))
	require.Equal(t, "DEVICE_REVOKED", reasonA)
	require.Equal(t, http.StatusOK, h.gateway(b.APIKey.Key).Code)
	rec = h.do(http.MethodGet, "/api/v1/claudex/devices", tokB, map[string]string{core.HeaderDeviceID: devB}, "")
	require.Equal(t, http.StatusOK, rec.Code)
	var mine struct {
		Items []devices.MyDeviceJSON `json:"items"`
	}
	require.NoError(t, json.Unmarshal(decodeEnv(t, rec).Data, &mine))
	require.Len(t, mine.Items, 2)
	require.True(t, mine.Items[0].Revoked)
	require.False(t, mine.Items[0].Current)
	require.True(t, mine.Items[1].Current)
	require.NotContains(t, rec.Body.String(), b.APIKey.Key, "the device list has no keys")

	// Signing out is idempotent; other users' devices are not found.
	require.Equal(t, http.StatusOK, h.do(http.MethodDelete, fmt.Sprintf("/api/v1/claudex/devices/%d", a.Device.ID), tokB, nil, "").Code)
	other := h.user()
	rec = h.do(http.MethodDelete, fmt.Sprintf("/api/v1/claudex/devices/%d", b.Device.ID), h.token(other), nil, "")
	require.Equal(t, http.StatusNotFound, rec.Code)
	require.Equal(t, "CLAUDEX_DEVICE_NOT_FOUND", decodeEnv(t, rec).Reason)
	require.Equal(t, http.StatusOK, h.gateway(b.APIKey.Key).Code)

	// The user signs in again on A: a new key.
	back := h.mustRegister(h.token(u), devA, "")
	require.True(t, back.Rotated)
	require.Equal(t, http.StatusOK, h.gateway(back.APIKey.Key).Code)

	// Expired signed-out sessions are cleaned up.
	_, err := itDB.Exec(`UPDATE claudex_revoked_sessions SET expires_at = NOW() - INTERVAL '1 minute' WHERE user_id = $1`, u.ID)
	require.NoError(t, err)
	require.NoError(t, h.comp.CleanupNow(h.ctx))
	var left int
	require.NoError(t, itDB.QueryRow(`SELECT COUNT(*) FROM claudex_revoked_sessions WHERE user_id = $1`, u.ID).Scan(&left))
	require.Zero(t, left)
}

func TestAdminDevicesRevokeAndRevokeAll(t *testing.T) {
	h := newHarness(t)
	u := h.user()
	g := h.planGroup()
	oldTok := h.token(u)
	regTok := h.token(u)
	dev := newDeviceID()
	d := h.mustRegister(regTok, dev, `{"device_name":"Ada's MacBook Pro","platform":"darwin","arch":"arm64","app_version":"1.3.2"}`)

	// Admin list: hints only, filters, pagination.
	rec := h.do(http.MethodGet, fmt.Sprintf("/api/v1/admin/claudex/devices?user_id=%d&status=active&q=%s", u.ID, "macbook"), "", nil, "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.NotContains(t, rec.Body.String(), d.APIKey.Key, "never the full key")
	var list struct {
		Items    []devices.AdminDeviceJSON `json:"items"`
		Total    int64                     `json:"total"`
		Page     int                       `json:"page"`
		PageSize int                       `json:"page_size"`
		Pages    int                       `json:"pages"`
	}
	require.NoError(t, json.Unmarshal(decodeEnv(t, rec).Data, &list))
	require.EqualValues(t, 1, list.Total)
	require.Equal(t, 1, list.Page)
	it := list.Items[0]
	require.Equal(t, d.Device.ID, it.ID)
	require.Equal(t, u.Email, it.UserEmail)
	require.Equal(t, "Ada's MacBook Pro", it.DeviceName)
	require.Equal(t, g.Name, it.GroupName)
	require.Equal(t, "sk-…"+d.APIKey.Key[len(d.APIKey.Key)-4:], it.APIKeyHint)
	require.Equal(t, "active", it.APIKeyStatus)
	require.Nil(t, it.RevokedAt)
	rec = h.do(http.MethodGet, fmt.Sprintf("/api/v1/admin/claudex/devices?user_id=%d&status=revoked", u.ID), "", nil, "")
	require.NoError(t, json.Unmarshal(decodeEnv(t, rec).Data, &list))
	require.Zero(t, list.Total)
	rec = h.do(http.MethodGet, "/api/v1/admin/claudex/devices?q="+strings.Split(u.Email, "@")[0], "", nil, "")
	require.NoError(t, json.Unmarshal(decodeEnv(t, rec).Data, &list))
	require.EqualValues(t, 1, list.Total)
	rec = h.do(http.MethodGet, "/api/v1/admin/claudex/devices?q=%25", "", nil, "")
	require.Equal(t, http.StatusOK, rec.Code, "LIKE wildcards are escaped")

	// Admin revoke: the device must sign in again; its old sessions cannot re-register it.
	// (Revoke in a later second than oldTok: a session from the revocation's own
	// second that was not the device's counts as a new sign-in, see R13.)
	waitNextSecond()
	rec = h.do(http.MethodPost, fmt.Sprintf("/api/v1/admin/claudex/devices/%d/revoke", d.Device.ID), "", nil, "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	_, reason := refusal(t, h.gateway(d.APIKey.Key))
	require.Equal(t, "DEVICE_REVOKED", reason)
	rec = h.register(regTok, dev, "")
	require.Equal(t, http.StatusUnauthorized, rec.Code, "the registering session was signed out (H9b)")
	require.Contains(t, rec.Body.String(), "CLAUDEX_SESSION_REVOKED")
	rec = h.register(oldTok, dev, "")
	require.Equal(t, http.StatusUnauthorized, rec.Code, "a session issued before the revocation cannot re-register")
	require.Equal(t, "CLAUDEX_SESSION_REVOKED", decodeEnv(t, rec).Reason)
	waitNextSecond()
	back := h.mustRegister(h.token(u), dev, "")
	require.True(t, back.Rotated)

	// Admin revoke-all: refresh tokens, sessions and device keys; user keys untouched.
	gid := g.ID
	own, err := h.keys.Create(h.ctx, u.ID, service.CreateAPIKeyRequest{Name: "own", GroupID: &gid})
	require.NoError(t, err)
	ownBefore := keyState(t, own.ID)
	rec = h.do(http.MethodPost, fmt.Sprintf("/api/v1/admin/claudex/users/%d/devices/revoke-all", u.ID), "", nil, "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.JSONEq(t, `{"revoked":1}`, string(decodeEnv(t, rec).Data))
	require.Contains(t, h.refresh.users, u.ID)
	require.Equal(t, service.StatusAPIKeyDisabled, keyState(t, back.APIKey.ID).Status)
	require.Equal(t, ownBefore, keyState(t, own.ID))
	require.Equal(t, http.StatusUnauthorized, h.do(http.MethodGet, "/api/v1/keys", oldTok, nil, "").Code)
	require.Equal(t, "CLAUDEX_USER_NOT_FOUND",
		decodeEnv(t, h.do(http.MethodPost, "/api/v1/admin/claudex/users/999999999/devices/revoke-all", "", nil, "")).Reason)
	require.Equal(t, "CLAUDEX_DEVICE_NOT_FOUND",
		decodeEnv(t, h.do(http.MethodPost, "/api/v1/admin/claudex/devices/999999999/revoke", "", nil, "")).Reason)
}

// TestDeviceKeysAreReadOnlyInTheKeysAPI covers H13 end to end: the plaintext of
// a device key appears only in the POST /claudex/devices answer.
func TestDeviceKeysAreReadOnlyInTheKeysAPI(t *testing.T) {
	h := newHarness(t)
	u := h.user()
	g := h.planGroup()
	tok := h.token(u)
	d := h.mustRegister(tok, newDeviceID(), "")
	gid := g.ID
	own, err := h.keys.Create(h.ctx, u.ID, service.CreateAPIKeyRequest{Name: "own", GroupID: &gid})
	require.NoError(t, err)

	rec := h.do(http.MethodGet, "/api/v1/keys", tok, nil, "")
	require.Equal(t, http.StatusOK, rec.Code)
	body := rec.Body.String()
	require.NotContains(t, body, d.APIKey.Key)
	require.Contains(t, body, "sk-…"+d.APIKey.Key[len(d.APIKey.Key)-4:])
	require.Contains(t, body, own.Key, "the user's own key is shown as before")
	rec = h.do(http.MethodGet, fmt.Sprintf("/api/v1/keys/%d", d.APIKey.ID), tok, nil, "")
	require.Equal(t, http.StatusOK, rec.Code)
	require.NotContains(t, rec.Body.String(), d.APIKey.Key)

	for _, method := range []string{http.MethodPut, http.MethodDelete} {
		rec := h.do(method, fmt.Sprintf("/api/v1/keys/%d", d.APIKey.ID), tok, nil, `{"status":"active","quota":1000}`)
		require.Equal(t, http.StatusForbidden, rec.Code, method)
		require.Equal(t, "CLAUDEX_DEVICE_KEY_MANAGED", decodeEnv(t, rec).Reason, method)
	}
	require.Equal(t, service.StatusAPIKeyActive, keyState(t, d.APIKey.ID).Status)
	require.False(t, keyState(t, d.APIKey.ID).DeletedAt.Valid)
	require.Equal(t, http.StatusOK, h.do(http.MethodPut, fmt.Sprintf("/api/v1/keys/%d", own.ID), tok, nil, `{"name":"renamed"}`).Code)

	// Owner decision 17: users create keys only when the administrator allows it.
	rec = h.do(http.MethodPost, "/api/v1/keys", tok, nil, fmt.Sprintf(`{"name":"new","group_id":%d}`, g.ID))
	require.Equal(t, http.StatusForbidden, rec.Code)
	require.Equal(t, "CLAUDEX_USER_API_KEYS_DISABLED", decodeEnv(t, rec).Reason)
	h.setProvisioning(`{"user_api_keys_enabled":true}`)
	rec = h.do(http.MethodPost, "/api/v1/keys", tok, nil, fmt.Sprintf(`{"name":"new","group_id":%d}`, g.ID))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	// A revoked device's key stays read-only (the registering session is
	// signed out with the device, so use another one).
	other := h.token(u)
	require.Equal(t, http.StatusOK, h.do(http.MethodPost, fmt.Sprintf("/api/v1/admin/claudex/devices/%d/revoke", d.Device.ID), "", nil, "").Code)
	require.Equal(t, http.StatusUnauthorized, h.do(http.MethodGet, "/api/v1/keys", tok, nil, "").Code)
	rec = h.do(http.MethodPut, fmt.Sprintf("/api/v1/keys/%d", d.APIKey.ID), other, nil, `{"status":"active"}`)
	require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
	require.Equal(t, "CLAUDEX_DEVICE_KEY_MANAGED", decodeEnv(t, rec).Reason)
	require.Equal(t, service.StatusAPIKeyDisabled, keyState(t, d.APIKey.ID).Status)
}

// TestPasswordChangeKeepsDeviceKeys pins owner decision 4: a password change or
// reset ends the old access tokens (upstream token version) but signs no
// device out and keeps every device key working.
func TestPasswordChangeKeepsDeviceKeys(t *testing.T) {
	h := newHarness(t)
	u := h.user()
	h.planGroup()
	tok := h.token(u)
	d := h.mustRegister(tok, newDeviceID(), "")

	require.NoError(t, h.users.ChangePassword(h.ctx, u.ID, service.ChangePasswordRequest{
		CurrentPassword: "old-password-1", NewPassword: "new-password-2",
	}))
	rec := h.do(http.MethodGet, "/api/v1/claudex/devices", tok, nil, "")
	require.Equal(t, http.StatusUnauthorized, rec.Code)
	require.Contains(t, rec.Body.String(), "TOKEN_REVOKED", "upstream ends the old access token")
	require.Equal(t, service.StatusAPIKeyActive, keyState(t, d.APIKey.ID).Status)
	var revoked sql.NullTime
	require.NoError(t, itDB.QueryRow(`SELECT revoked_at FROM claudex_devices WHERE id = $1`, d.Device.ID).Scan(&revoked))
	require.False(t, revoked.Valid)
	require.Equal(t, http.StatusOK, h.gateway(d.APIKey.Key).Code)
	var revocations int
	require.NoError(t, itDB.QueryRow(`SELECT COUNT(*) FROM claudex_session_revocations WHERE user_id = $1`, u.ID).Scan(&revocations))
	require.Zero(t, revocations)
}

func TestProvisioningSettingsAndSwitches(t *testing.T) {
	h := newHarness(t)
	u := h.user()
	g := h.planGroup()
	tok := h.token(u)

	rec := h.do(http.MethodPut, "/api/v1/admin/claudex/provisioning", "", nil, `{"default_group_id":999999999,"allowed_group_ids":[]}`)
	require.Equal(t, http.StatusBadRequest, rec.Code)
	e := decodeEnv(t, rec)
	require.Equal(t, "CLAUDEX_GROUP_NOT_FOUND", e.Reason)
	require.Equal(t, "default_group_id", e.Metadata["field"])
	rec = h.do(http.MethodPut, "/api/v1/admin/claudex/provisioning", "", nil, `{"allowed_group_ids":[999999999]}`)
	require.Equal(t, "CLAUDEX_GROUP_NOT_FOUND", decodeEnv(t, rec).Reason)

	h.setProvisioning(fmt.Sprintf(`{"strategy":"fixed","default_group_id":%d,"key_defaults":{"quota_usd":12.5,"expires_in_days":30,"rate_limit_5h":2}}`, g.ID))
	d := h.mustRegister(tok, newDeviceID(), "")
	var quota, rl5h float64
	var expires sql.NullTime
	require.NoError(t, itDB.QueryRow(`SELECT quota, rate_limit_5h, expires_at FROM api_keys WHERE id = $1`, d.APIKey.ID).Scan(&quota, &rl5h, &expires))
	require.Equal(t, 12.5, quota)
	require.Equal(t, 2.0, rl5h)
	require.True(t, expires.Valid)
	require.WithinDuration(t, time.Now().Add(30*24*time.Hour), expires.Time, time.Hour)

	h.setProvisioning(`{"enabled":false}`)
	rec = h.register(tok, newDeviceID(), "")
	require.Equal(t, http.StatusForbidden, rec.Code)
	require.Equal(t, "CLAUDEX_DEVICE_KEYS_DISABLED", decodeEnv(t, rec).Reason)
	rec = h.do(http.MethodGet, "/api/v1/admin/claudex/provisioning", "", nil, "")
	var p devices.Provisioning
	require.NoError(t, json.Unmarshal(decodeEnv(t, rec).Data, &p))
	require.False(t, p.Enabled)
	require.Equal(t, devices.StrategyFixed, p.Strategy)
}

// issuedSecond is the JWT iat of a token (whole seconds).
func (h *harness) issuedSecond(tok string) time.Time {
	h.t.Helper()
	claims, err := h.auth.ValidateToken(tok)
	require.NoError(h.t, err)
	require.NotNil(h.t, claims.IssuedAt)
	return claims.IssuedAt.Time.Truncate(time.Second)
}

// TestRevokeAllThenImmediateLoginWorks (R13, i1 finding 3): a sign-in in the
// same second as a revoke-all (JWT iat has whole seconds) is not refused, on
// the JWT endpoints and when it re-registers the signed-out device.
func TestRevokeAllThenImmediateLoginWorks(t *testing.T) {
	h := newHarness(t)
	u := h.user()
	h.planGroup()
	old := h.token(u)
	dev := newDeviceID()
	a := h.mustRegister(old, dev, "")

	fresh := h.token(u)
	second := h.issuedSecond(fresh)
	// The revoke-all happens late in the second the new session was issued in.
	h.comp.UseClock(func() time.Time { return second.Add(900 * time.Millisecond) })
	rec := h.do(http.MethodPost, fmt.Sprintf("/api/v1/admin/claudex/users/%d/devices/revoke-all", u.ID), "", nil, "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	h.comp.UseClock(time.Now)

	rec = h.do(http.MethodGet, "/api/v1/claudex/devices", fresh, map[string]string{core.HeaderDeviceID: dev}, "")
	require.Equal(t, http.StatusOK, rec.Code, "a new session of the same second: %s", rec.Body.String())
	back := h.mustRegister(fresh, dev, "")
	require.True(t, back.Rotated)
	require.NotEqual(t, a.APIKey.ID, back.APIKey.ID)
	require.Equal(t, http.StatusOK, h.gateway(back.APIKey.Key).Code)
	require.Equal(t, service.StatusAPIKeyDisabled, keyState(t, a.APIKey.ID).Status)

	// The signed-out device session stays refused.
	rec = h.do(http.MethodGet, "/api/v1/keys", old, nil, "")
	require.Equal(t, http.StatusUnauthorized, rec.Code)
	require.Contains(t, rec.Body.String(), "CLAUDEX_SESSION_REVOKED")
}

// TestRevokeAllSameSecondOldSessionRefused: a device session issued in the
// revoke-all's own second is refused although its iat equals the revocation
// second (its session family was recorded as signed out).
func TestRevokeAllSameSecondOldSessionRefused(t *testing.T) {
	h := newHarness(t)
	u := h.user()
	h.planGroup()
	old := h.token(u)
	dev := newDeviceID()
	a := h.mustRegister(old, dev, "")
	second := h.issuedSecond(old)
	h.comp.UseClock(func() time.Time { return second.Add(900 * time.Millisecond) })
	rec := h.do(http.MethodPost, "/api/v1/auth/revoke-all-sessions", old, nil, "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	h.comp.UseClock(time.Now)

	var recorded int
	require.NoError(t, itDB.QueryRow(`SELECT COUNT(*) FROM claudex_revoked_sessions WHERE user_id = $1`, u.ID).Scan(&recorded))
	require.Equal(t, 1, recorded, "the device's session family")
	for _, probe := range []struct{ method, path string }{
		{http.MethodGet, "/api/v1/keys"},
		{http.MethodGet, "/api/v1/claudex/devices"},
	} {
		rec := h.do(probe.method, probe.path, old, map[string]string{core.HeaderDeviceID: dev}, "")
		require.Equal(t, http.StatusUnauthorized, rec.Code, probe.path)
		require.Contains(t, rec.Body.String(), "CLAUDEX_SESSION_REVOKED", probe.path)
	}
	rec = h.register(old, dev, "")
	require.Equal(t, http.StatusUnauthorized, rec.Code, "it cannot re-register the device")
	_, reason := refusal(t, h.gateway(a.APIKey.Key))
	require.Equal(t, "DEVICE_REVOKED", reason)
}

// TestAdminCreatedUserKeys (R13, i1 finding 1): with user_api_keys_enabled
// off, an administrator still creates a key for the user; it is a user API
// key, so revoke-all leaves it alone (owner decision 13), and device keys
// can neither be listed nor deleted through these routes.
func TestAdminCreatedUserKeys(t *testing.T) {
	h := newHarness(t)
	u := h.user()
	g := h.planGroup()
	tok := h.token(u)
	d := h.mustRegister(tok, newDeviceID(), "")

	rec := h.do(http.MethodPost, "/api/v1/keys", tok, nil, fmt.Sprintf(`{"name":"mine","group_id":%d}`, g.ID))
	require.Equal(t, "CLAUDEX_USER_API_KEYS_DISABLED", decodeEnv(t, rec).Reason, "users cannot create keys themselves")

	path := fmt.Sprintf("/api/v1/admin/claudex/users/%d/api-keys", u.ID)
	rec = h.do(http.MethodPost, path, "", nil, fmt.Sprintf(`{"name":"CI & deploy","group_id":%d,"quota":5,"expires_in_days":30}`, g.ID))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
	var created devices.CreatedUserKeyJSON
	require.NoError(t, json.Unmarshal(decodeEnv(t, rec).Data, &created))
	require.Equal(t, "CI & deploy", created.Name)
	require.True(t, strings.HasPrefix(created.Key, "sk-"))
	require.Equal(t, g.ID, *created.GroupID)
	require.NotNil(t, created.ExpiresAt)
	require.Equal(t, http.StatusOK, h.gateway(created.Key).Code)

	// Refused: device key names, groups the user cannot use, missing users.
	rec = h.do(http.MethodPost, path, "", nil, `{"name":"claudex-device:0123456789ab"}`)
	require.Equal(t, "CLAUDEX_RESERVED_KEY_NAME", decodeEnv(t, rec).Reason)
	exclusive := h.group(service.PlatformOpenAI, service.SubscriptionTypeStandard)
	_, err := itDB.Exec(`UPDATE groups SET is_exclusive = true WHERE id = $1`, exclusive.ID)
	require.NoError(t, err)
	rec = h.do(http.MethodPost, path, "", nil, fmt.Sprintf(`{"name":"x","group_id":%d}`, exclusive.ID))
	require.Equal(t, "CLAUDEX_GROUP_NOT_ALLOWED", decodeEnv(t, rec).Reason)
	rec = h.do(http.MethodPost, "/api/v1/admin/claudex/users/999999999/api-keys", "", nil, `{"name":"x"}`)
	require.Equal(t, "CLAUDEX_USER_NOT_FOUND", decodeEnv(t, rec).Reason)

	// The list has the user's keys without device keys and without plaintext.
	rec = h.do(http.MethodGet, path, "", nil, "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.NotContains(t, rec.Body.String(), created.Key)
	var list struct {
		Items []devices.UserKeyJSON `json:"items"`
	}
	require.NoError(t, json.Unmarshal(decodeEnv(t, rec).Data, &list))
	require.Len(t, list.Items, 1)
	require.Equal(t, created.ID, list.Items[0].ID)
	require.Equal(t, "CI & deploy", list.Items[0].Name)
	require.Equal(t, "sk-…"+created.Key[len(created.Key)-4:], list.Items[0].KeyHint)
	require.Equal(t, g.Name, list.Items[0].GroupName)

	// Revoke-all (the user's and the administrator's) never touches it.
	before := keyState(t, created.ID)
	rec = h.do(http.MethodPost, "/api/v1/auth/revoke-all-sessions", tok, nil, "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	rec = h.do(http.MethodPost, fmt.Sprintf("/api/v1/admin/claudex/users/%d/devices/revoke-all", u.ID), "", nil, "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, service.StatusAPIKeyDisabled, keyState(t, d.APIKey.ID).Status)
	after := keyState(t, created.ID) // updated_at may move with the last-used touch of the gateway call above
	require.Equal(t, service.StatusAPIKeyActive, after.Status)
	require.Equal(t, before.Quota, after.Quota)
	require.Equal(t, before.Name, after.Name)
	require.Equal(t, before.GroupID, after.GroupID)
	require.False(t, after.DeletedAt.Valid)
	require.Equal(t, http.StatusOK, h.gateway(created.Key).Code)

	// Deleting: device keys are refused, another user's path finds nothing.
	rec = h.do(http.MethodDelete, fmt.Sprintf("%s/%d", path, d.APIKey.ID), "", nil, "")
	require.Equal(t, http.StatusForbidden, rec.Code)
	require.Equal(t, "CLAUDEX_DEVICE_KEY_MANAGED", decodeEnv(t, rec).Reason)
	other := h.user()
	rec = h.do(http.MethodDelete, fmt.Sprintf("/api/v1/admin/claudex/users/%d/api-keys/%d", other.ID, created.ID), "", nil, "")
	require.Equal(t, "CLAUDEX_API_KEY_NOT_FOUND", decodeEnv(t, rec).Reason)
	rec = h.do(http.MethodDelete, fmt.Sprintf("%s/%d", path, created.ID), "", nil, "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.True(t, keyState(t, created.ID).DeletedAt.Valid)
	require.Equal(t, http.StatusUnauthorized, h.gateway(created.Key).Code)
	rec = h.do(http.MethodDelete, fmt.Sprintf("%s/%d", path, created.ID), "", nil, "")
	require.Equal(t, http.StatusNotFound, rec.Code, "already deleted")
}
