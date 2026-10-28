//go:build unit

package handler

// CLAUDEX: file added by the Claudex fork (see backend/CLAUDEX_CHANGES.md).
// B7 gateway tests for GET /v1/audio/realtime/transcriptions with a fake
// upstream WebSocket, fake billing repositories and the real voice component.

import (
	"context"
	"database/sql/driver"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/gatewayhook"
	claudexhook "github.com/Wei-Shaw/sub2api/internal/claudex/hook"
	claudexusage "github.com/Wei-Shaw/sub2api/internal/claudex/usage"
	"github.com/Wei-Shaw/sub2api/internal/claudex/voice"
	"github.com/Wei-Shaw/sub2api/internal/config"
	middleware2 "github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/Wei-Shaw/sub2api/internal/testutil"

	"github.com/DATA-DOG/go-sqlmock"
	coderws "github.com/coder/websocket"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// ---- fakes -----------------------------------------------------------------

type claudexAudioBilling struct {
	service.UsageBillingRepository
	mu   sync.Mutex
	cmds []*service.UsageBillingCommand
}

func (r *claudexAudioBilling) Apply(_ context.Context, cmd *service.UsageBillingCommand) (*service.UsageBillingApplyResult, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.cmds = append(r.cmds, cmd)
	balance := 9.0
	return &service.UsageBillingApplyResult{Applied: true, NewBalance: &balance}, nil
}

func (r *claudexAudioBilling) snapshot() []*service.UsageBillingCommand {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]*service.UsageBillingCommand(nil), r.cmds...)
}

type claudexAudioUsers struct {
	service.UserRepository
	balance float64
}

func (r claudexAudioUsers) GetByID(_ context.Context, id int64) (*service.User, error) {
	return &service.User{ID: id, Balance: r.balance, Status: service.StatusActive}, nil
}

type claudexAudioSlots struct {
	testutil.StubConcurrencyCache
	mu                         sync.Mutex
	userAcquired, userReleased int
	denyUser                   bool
}

func (s *claudexAudioSlots) AcquireUserSlot(context.Context, int64, int, string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.denyUser {
		return false, nil
	}
	s.userAcquired++
	return true, nil
}

func (s *claudexAudioSlots) ReleaseUserSlot(context.Context, int64, string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.userReleased++
	return nil
}

func (s *claudexAudioSlots) IncrementWaitCount(context.Context, int64, int) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return !s.denyUser, nil
}

type claudexAudioSettingRepo struct {
	service.SettingRepository
	mu     sync.Mutex
	values map[string]string
}

func (r *claudexAudioSettingRepo) GetValue(_ context.Context, key string) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	v, ok := r.values[key]
	if !ok {
		return "", service.ErrSettingNotFound
	}
	return v, nil
}

func (r *claudexAudioSettingRepo) Set(_ context.Context, key, value string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.values[key] = value
	return nil
}

// claudexFakeASR is a realtime transcription service that answers a finish
// with a final transcript.
type claudexFakeASR struct {
	srv    *httptest.Server
	mu     sync.Mutex
	auths  []string
	audio  int
	reject bool
}

func newClaudexFakeASR(t *testing.T) *claudexFakeASR {
	u := &claudexFakeASR{}
	u.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u.mu.Lock()
		u.auths = append(u.auths, r.Header.Get("Authorization"))
		reject := u.reject
		u.mu.Unlock()
		if r.Header.Get("Authorization") != "Bearer sk-hw-0123456789abcdef" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		c, err := coderws.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer func() { _ = c.CloseNow() }()
		ctx := r.Context()
		for {
			typ, data, err := c.Read(ctx)
			if err != nil {
				return
			}
			if typ == coderws.MessageBinary {
				u.mu.Lock()
				u.audio += len(data)
				u.mu.Unlock()
				continue
			}
			var m map[string]any
			_ = json.Unmarshal(data, &m)
			switch {
			case m["type"] == "start" && reject:
				_ = c.Write(ctx, coderws.MessageText, []byte(`{"type":"error","code":"MODEL_NOT_FOUND","message":"unavailable"}`))
				_ = c.Close(coderws.StatusInvalidFramePayloadData, "MODEL_NOT_FOUND")
				return
			case m["type"] == "finish":
				_ = c.Write(ctx, coderws.MessageText, []byte(`{"type":"final","text":"hello"}`))
				_ = c.Close(coderws.StatusNormalClosure, "")
				return
			}
		}
	}))
	t.Cleanup(u.srv.Close)
	return u
}

// ---- harness ---------------------------------------------------------------

type claudexAudioHarness struct {
	t       *testing.T
	handler *OpenAIGatewayHandler
	asr     *claudexFakeASR
	billing *claudexAudioBilling
	slots   *claudexAudioSlots
	apiKey  *service.APIKey
	db      sqlmock.Sqlmock
	server  *httptest.Server
	admin   *gin.Engine
	device  bool

	mu          sync.Mutex
	usageEvents []claudexhook.UsageEvent
	prechecks   [][]string
	precheckErr error
}

func newClaudexAudioHarness(t *testing.T) *claudexAudioHarness {
	t.Helper()
	gin.SetMode(gin.TestMode)
	gatewayhook.Reset()
	claudexhook.Reset()
	t.Cleanup(func() {
		gatewayhook.Reset()
		claudexhook.Reset()
	})

	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	cfg := &config.Config{}
	cfg.Totp.EncryptionKey = strings.Repeat("0f", 32)
	cfg.Totp.EncryptionKeyConfigured = true
	h := &claudexAudioHarness{t: t, db: mock, device: true, asr: newClaudexFakeASR(t)}
	component := voice.New(&core.Env{Deps: core.Deps{
		SettingRepo: &claudexAudioSettingRepo{values: map[string]string{}}, DB: db, Config: cfg,
	}, Now: time.Now})
	h.admin = gin.New()
	component.RegisterAdminRoutes(h.admin.Group("/admin"), nil)

	claudexhook.Install(claudexhook.Hooks{
		UsageApplied: func(_ context.Context, ev claudexhook.UsageEvent) {
			h.mu.Lock()
			defer h.mu.Unlock()
			h.usageEvents = append(h.usageEvents, ev)
		},
		PrecheckTurn: func(_ context.Context, _, _ int64, _ *int64, models []string) error {
			h.mu.Lock()
			defer h.mu.Unlock()
			h.prechecks = append(h.prechecks, append([]string(nil), models...))
			return h.precheckErr
		},
	})

	h.billing = &claudexAudioBilling{}
	h.slots = &claudexAudioSlots{}
	users := claudexAudioUsers{balance: 10}
	billingService := service.NewBillingService(cfg, nil)
	billingCache := service.NewBillingCacheService(nil, users, nil, nil, nil, nil, cfg, nil)
	t.Cleanup(billingCache.Stop)
	gatewayService := service.NewOpenAIGatewayService(
		nil, nil, h.billing, users, nil, nil, nil, cfg, nil, nil, billingService, nil, billingCache, nil,
		service.NewDeferredService(nil, nil, time.Minute), nil, nil, nil, nil, nil, nil, nil,
	)
	h.handler = NewOpenAIGatewayHandler(
		gatewayService,
		service.NewConcurrencyService(h.slots),
		billingCache,
		service.NewAPIKeyService(nil, nil, nil, nil, nil, nil, cfg),
		nil, nil, nil, nil,
		cfg,
	)

	groupID := int64(31)
	group := &service.Group{
		ID: groupID, Name: "claudex-pro", Platform: service.PlatformOpenAI, Status: service.StatusActive,
		RateMultiplier: 2, AudioSTTPricePerHour: claudexFloat(0.36),
	}
	h.apiKey = &service.APIKey{
		ID: 9, UserID: 7, Key: "sk-device", Status: service.StatusActive, GroupID: &groupID, Group: group,
		User: &service.User{ID: 7, Balance: 10, Status: service.StatusActive, Concurrency: 2},
	}

	router := gin.New()
	auth := func(c *gin.Context) {
		c.Set(string(middleware2.ContextKeyAPIKey), h.apiKey)
		c.Set(string(middleware2.ContextKeyUser), middleware2.AuthSubject{UserID: 7, Concurrency: 2})
		if h.device {
			gatewayhook.MarkDevice(c, &gatewayhook.DeviceRef{ID: 1, UserID: 7, APIKeyID: 9, GroupID: &groupID})
		}
		c.Next()
	}
	// Same order as the /v1 group (H6): structured refusals, then API-key auth.
	v1 := router.Group("/v1", gatewayhook.EnrichRefusals(), auth)
	v1.GET("/audio/realtime/transcriptions", h.handler.ClaudexAudioRealtimeTranscriptions)
	h.server = httptest.NewServer(router)
	t.Cleanup(h.server.Close)
	return h
}

func claudexFloat(v float64) *float64 { return &v }

func (h *claudexAudioHarness) configure(body string) {
	h.t.Helper()
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPut, "/admin/voice", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	h.admin.ServeHTTP(w, req)
	require.Equal(h.t, http.StatusOK, w.Code, w.Body.String())
}

func (h *claudexAudioHarness) enable() {
	h.configure(`{"transcription":{"enabled":true,"upstream_url":"ws` + strings.TrimPrefix(h.asr.srv.URL, "http") +
		`/v1/audio/realtime/transcriptions","api_key":"sk-hw-0123456789abcdef","max_bytes":64000}}`)
}

func (h *claudexAudioHarness) dial() (*coderws.Conn, *http.Response, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return coderws.Dial(ctx, "ws"+strings.TrimPrefix(h.server.URL, "http")+"/v1/audio/realtime/transcriptions", nil)
}

func (h *claudexAudioHarness) refusal() (int, string, http.Header) {
	h.t.Helper()
	_, resp, err := h.dial()
	require.Error(h.t, err)
	require.NotNil(h.t, resp)
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if resp.Body != nil {
		_ = json.NewDecoder(resp.Body).Decode(&body)
	}
	return resp.StatusCode, body.Error.Code, resp.Header
}

func (h *claudexAudioHarness) events() []claudexhook.UsageEvent {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]claudexhook.UsageEvent(nil), h.usageEvents...)
}

type prefixArg string

func (p prefixArg) Match(v driver.Value) bool {
	s, ok := v.(string)
	return ok && strings.HasPrefix(s, string(p))
}

type approxArg float64

func (a approxArg) Match(v driver.Value) bool {
	f, ok := v.(float64)
	return ok && f > float64(a)-1e-12 && f < float64(a)+1e-12
}

// ---- tests -----------------------------------------------------------------

func TestClaudexRealtimeRelaysAndBillsTheAudioSeconds(t *testing.T) {
	h := newClaudexAudioHarness(t)
	h.enable()
	h.db.ExpectExec(regexp.QuoteMeta("INSERT INTO claudex_voice_sessions")).
		WithArgs(prefixArg("claudex_audio:"), int64(7), int64(9), int64(31), int64(16000), 0.5, approxArg(0.0001), true,
			sqlmock.AnyArg(), "finished").
		WillReturnResult(sqlmock.NewResult(0, 1))

	client, _, err := h.dial()
	require.NoError(t, err)
	defer func() { _ = client.CloseNow() }()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	require.NoError(t, client.Write(ctx, coderws.MessageText, []byte(`{"type":"start","requestId":"r1"}`)))
	for i := 0; i < 5; i++ {
		require.NoError(t, client.Write(ctx, coderws.MessageBinary, make([]byte, 3200)))
	}
	require.NoError(t, client.Write(ctx, coderws.MessageText, []byte(`{"type":"finish"}`)))
	_, data, err := client.Read(ctx)
	require.NoError(t, err)
	require.JSONEq(t, `{"type":"final","text":"hello"}`, string(data))
	_, _, err = client.Read(ctx)
	require.Equal(t, coderws.StatusNormalClosure, coderws.CloseStatus(err))

	require.Eventually(t, func() bool { return len(h.billing.snapshot()) == 1 && len(h.events()) == 1 }, 3*time.Second, 10*time.Millisecond)
	cmd := h.billing.snapshot()[0]
	require.True(t, strings.HasPrefix(cmd.RequestID, "claudex_audio:"), cmd.RequestID)
	require.Equal(t, int64(9), cmd.APIKeyID)
	require.Equal(t, int64(7), cmd.UserID)
	require.Zero(t, cmd.AccountID, "no upstream account")
	require.Zero(t, cmd.AccountQuotaCost)
	require.Equal(t, voice.BilledModel, cmd.Model)
	// 16000 bytes = 0.5 s at $0.36/hour times the group multiplier 2.
	require.InDelta(t, 0.0001, cmd.BalanceCost, 1e-12)
	ev := h.events()[0]
	require.Equal(t, cmd.RequestID, ev.RequestID)
	require.Equal(t, voice.BilledModel, ev.BilledModel)
	require.Equal(t, int64(31), *ev.GroupID)
	require.InDelta(t, 0.0001, ev.CostUSD, 1e-12)
	require.Eventually(t, func() bool { return h.db.ExpectationsWereMet() == nil }, 3*time.Second, 10*time.Millisecond)

	require.Equal(t, [][]string{{voice.BilledModel}}, h.prechecks)
	require.Equal(t, []string{"Bearer sk-hw-0123456789abcdef"}, h.asr.auths)
	require.Equal(t, 16000, h.asr.audio)
	h.slots.mu.Lock()
	require.Equal(t, 1, h.slots.userAcquired)
	h.slots.mu.Unlock()
	require.Eventually(t, func() bool { h.slots.mu.Lock(); defer h.slots.mu.Unlock(); return h.slots.userReleased == 1 },
		3*time.Second, 10*time.Millisecond)
}

func TestClaudexRealtimeDoesNotBillARejectedSession(t *testing.T) {
	h := newClaudexAudioHarness(t)
	h.enable()
	h.asr.reject = true
	client, _, err := h.dial()
	require.NoError(t, err)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	require.NoError(t, client.Write(ctx, coderws.MessageText, []byte(`{"type":"start"}`)))
	_, data, err := client.Read(ctx)
	require.NoError(t, err)
	require.Contains(t, string(data), "MODEL_NOT_FOUND")
	_, _, err = client.Read(ctx)
	require.Equal(t, coderws.StatusInvalidFramePayloadData, coderws.CloseStatus(err))
	time.Sleep(100 * time.Millisecond)
	require.Empty(t, h.billing.snapshot())
	require.Empty(t, h.events())
	require.NoError(t, h.db.ExpectationsWereMet(), "no session row")
}

func TestClaudexRealtimeRefusals(t *testing.T) {
	h := newClaudexAudioHarness(t)

	// Not a WebSocket upgrade.
	resp, err := http.Get(h.server.URL + "/v1/audio/realtime/transcriptions")
	require.NoError(t, err)
	_ = resp.Body.Close()
	require.Equal(t, http.StatusUpgradeRequired, resp.StatusCode)

	// Off by default.
	status, code, _ := h.refusal()
	require.Equal(t, http.StatusNotFound, status)
	require.Equal(t, voice.ReasonDisabled, code)

	h.enable()
	// Only Claudex device keys.
	h.device = false
	status, code, _ = h.refusal()
	require.Equal(t, http.StatusForbidden, status)
	require.Equal(t, voice.ReasonDeviceKeyRequired, code)
	h.device = true

	// The usage rules of the billed model, with the structured detail.
	h.precheckErr = &claudexusage.LimitError{Detail: &gatewayhook.RefusalDetail{
		Reason: "RULE_LIMIT", Message: "Weekly dictation limit reached", RetryAfterSeconds: 60}}
	status, code, header := h.refusal()
	require.Equal(t, http.StatusTooManyRequests, status)
	require.Equal(t, claudexusage.CodeLimitExceeded, code)
	require.Equal(t, "60", header.Get("Retry-After"))
	h.precheckErr = nil

	// The user's concurrency slot.
	h.slots.denyUser = true
	status, _, _ = h.refusal()
	require.Equal(t, http.StatusTooManyRequests, status)
	h.slots.denyUser = false

	// The upstream handshake fails (wrong key): 502, and the key is not echoed.
	h.configure(`{"transcription":{"api_key":"sk-hw-wrong-key-000000"}}`)
	status, code, _ = h.refusal()
	require.Equal(t, http.StatusBadGateway, status)
	require.Equal(t, voice.ReasonUpstreamUnavailable, code)

	// A key that cannot be decrypted any more: 503.
	cfg := &config.Config{}
	cfg.Totp.EncryptionKey = strings.Repeat("1e", 32)
	cfg.Totp.EncryptionKeyConfigured = true
	repo := &claudexAudioSettingRepo{values: map[string]string{
		voice.SettingKey: `{"transcription":{"enabled":true,"upstream_url":"wss://x.test/a","api_key_ciphertext":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}}`,
	}}
	voice.New(&core.Env{Deps: core.Deps{SettingRepo: repo, Config: cfg}, Now: time.Now})
	status, code, _ = h.refusal()
	require.Equal(t, http.StatusServiceUnavailable, status)
	require.Equal(t, voice.ReasonUnavailable, code)

	require.Empty(t, h.billing.snapshot())
}
