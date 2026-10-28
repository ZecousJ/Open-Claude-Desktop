//go:build unit

package handler

// CLAUDEX: file added by the Claudex fork (see backend/CLAUDEX_CHANGES.md).
// W-VOICE: dictation from the web app with a one-time web ticket goes through
// the same handler, usage rules, concurrency slot and billing as the desktop
// app; only the key differs (the user's managed web key).

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/devices"
	"github.com/Wei-Shaw/sub2api/internal/claudex/gatewayhook"
	"github.com/Wei-Shaw/sub2api/internal/claudex/voice"
	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
	"github.com/Wei-Shaw/sub2api/internal/config"
	middleware2 "github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/DATA-DOG/go-sqlmock"
	coderws "github.com/coder/websocket"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// claudexWebGate is the web component seen by voice: one active session.
type claudexWebGate struct{ origin string }

func (claudexWebGate) Name() string { return core.NameWeb }

func (g claudexWebGate) AuthorizeWebPost(c *gin.Context) (int64, string, time.Time, bool) {
	if c.GetHeader(webproto.HeaderWeb) != "1" {
		c.AbortWithStatus(http.StatusForbidden)
		return 0, "", time.Time{}, false
	}
	return 7, "sid-web", time.Unix(1_790_000_000, 0), true
}

func (claudexWebGate) CheckWebCaller(_ context.Context, userID int64, sid string, _ time.Time) error {
	if userID != 7 || sid != "sid-web" {
		return devices.ErrSessionRevoked
	}
	return nil
}

func (g claudexWebGate) SameSiteRequest(c *gin.Context) bool {
	return c.GetHeader("Origin") == g.origin
}

// claudexWebKeys is the devices component seen by voice.
type claudexWebKeys struct{}

func (claudexWebKeys) Name() string { return core.NameDevices }

func (claudexWebKeys) EnsureWebKey(_ context.Context, in devices.WebKeyRequest) (*devices.WebKey, error) {
	return &devices.WebKey{UserID: in.UserID, APIKeyID: 19, Key: "sk-web", GroupID: 31}, nil
}
func (claudexWebKeys) IsWebKey(context.Context, int64) (int64, bool)     { return 7, true }
func (claudexWebKeys) RevokeWebKey(context.Context, int64, string) error { return nil }

func TestClaudexRealtimeWebTicketMetersLikeTheDesktop(t *testing.T) {
	h := newClaudexAudioHarness(t)

	// A voice component that sees the web gate and the web key issuer, with
	// its own session log (it replaces the harness's as the active one).
	db, sessions, err := sqlmock.New()
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	cfg := &config.Config{}
	cfg.Totp.EncryptionKey = strings.Repeat("0f", 32)
	cfg.Totp.EncryptionKeyConfigured = true
	env := &core.Env{Deps: core.Deps{SettingRepo: &claudexAudioSettingRepo{values: map[string]string{}}, DB: db, Config: cfg}, Now: time.Now}
	component := voice.New(env)

	desktopKey := h.apiKey
	webKey := *h.apiKey
	webKey.ID, webKey.Key = 19, "sk-web"
	keys := map[string]*service.APIKey{"sk-device": desktopKey, "sk-web": &webKey}

	router := gin.New()
	component.RegisterPublicRoutes(router.Group("/api/v1/claudex"))
	admin := gin.New()
	component.RegisterAdminRoutes(admin.Group("/admin"), nil)
	auth := func(c *gin.Context) {
		k := keys[strings.TrimPrefix(c.GetHeader("Authorization"), "Bearer ")]
		if k == nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": gin.H{"code": "INVALID_API_KEY"}})
			return
		}
		c.Set(string(middleware2.ContextKeyAPIKey), k)
		c.Set(string(middleware2.ContextKeyUser), middleware2.AuthSubject{UserID: k.UserID, Concurrency: 2})
		gatewayhook.MarkDevice(c, &gatewayhook.DeviceRef{ID: k.ID, UserID: k.UserID, APIKeyID: k.ID, GroupID: k.GroupID})
		c.Next()
	}
	// The /v1 group order (H6): refusals, body limits and pre-auth, API-key auth.
	v1 := router.Group("/v1", gatewayhook.EnrichRefusals(), gatewayhook.BodyLimits(), auth)
	v1.GET("/audio/realtime/transcriptions", h.handler.ClaudexAudioRealtimeTranscriptions)
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)
	env.Components = []core.Feature{component, claudexWebGate{origin: server.URL}, claudexWebKeys{}}

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPut, "/admin/voice", strings.NewReader(`{"transcription":{"enabled":true,"upstream_url":"ws`+
		strings.TrimPrefix(h.asr.srv.URL, "http")+`/v1/audio/realtime/transcriptions","api_key":"sk-hw-0123456789abcdef","max_bytes":64000}}`))
	req.Header.Set("Content-Type", "application/json")
	admin.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	for _, keyID := range []int64{9, 19} {
		sessions.ExpectExec(regexp.QuoteMeta("INSERT INTO claudex_voice_sessions")).
			WithArgs(prefixArg("claudex_audio:"), int64(7), keyID, int64(31), int64(16000), 0.5, approxArg(0.0001), true,
				sqlmock.AnyArg(), "finished").
			WillReturnResult(sqlmock.NewResult(0, 1))
	}

	session := func(opts *coderws.DialOptions) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		client, _, err := coderws.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/v1/audio/realtime/transcriptions", opts)
		require.NoError(t, err)
		defer func() { _ = client.CloseNow() }()
		require.NoError(t, client.Write(ctx, coderws.MessageText, []byte(`{"type":"start"}`)))
		for i := 0; i < 5; i++ {
			require.NoError(t, client.Write(ctx, coderws.MessageBinary, make([]byte, 3200)))
		}
		require.NoError(t, client.Write(ctx, coderws.MessageText, []byte(`{"type":"finish"}`)))
		_, data, err := client.Read(ctx)
		require.NoError(t, err)
		require.JSONEq(t, `{"type":"final","text":"hello"}`, string(data))
		_, _, err = client.Read(ctx)
		require.Equal(t, coderws.StatusNormalClosure, coderws.CloseStatus(err))
	}

	// Desktop: its device key.
	session(&coderws.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer sk-device"}}})
	require.Eventually(t, func() bool { return len(h.billing.snapshot()) == 1 }, 3*time.Second, 10*time.Millisecond)

	// Web: a ticket from the web session, offered as a sub-protocol.
	w = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, webproto.PathAuth+voice.WebTicketRoute, strings.NewReader(`{}`))
	req.Header.Set(webproto.HeaderWeb, "1")
	router.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var minted struct {
		Data webproto.TicketResponse `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &minted))
	session(&coderws.DialOptions{
		HTTPHeader:   http.Header{"Origin": {server.URL}},
		Subprotocols: []string{webproto.EventsSubprotocol, webproto.TicketSubprotocolPrefix + minted.Data.Ticket},
	})
	require.Eventually(t, func() bool { return len(h.billing.snapshot()) == 2 && len(h.events()) == 2 }, 3*time.Second, 10*time.Millisecond)
	require.Eventually(t, func() bool { return sessions.ExpectationsWereMet() == nil }, 3*time.Second, 10*time.Millisecond)

	// Same metering, same rules, same billing; only the key differs.
	cmds, events := h.billing.snapshot(), h.events()
	desktop, web := cmds[0], cmds[1]
	require.Equal(t, int64(9), desktop.APIKeyID)
	require.Equal(t, int64(19), web.APIKeyID)
	require.Equal(t, desktop.UserID, web.UserID)
	require.Equal(t, desktop.Model, web.Model)
	require.Equal(t, voice.BilledModel, web.Model)
	require.InDelta(t, desktop.BalanceCost, web.BalanceCost, 1e-12)
	require.InDelta(t, 0.0001, web.BalanceCost, 1e-12)
	require.Equal(t, *events[0].GroupID, *events[1].GroupID)
	require.InDelta(t, events[0].CostUSD, events[1].CostUSD, 1e-12)
	require.Equal(t, events[0].BilledModel, events[1].BilledModel)
	require.Equal(t, [][]string{{voice.BilledModel}, {voice.BilledModel}}, h.prechecks, "the billed model's usage rules both times")
	require.Equal(t, 32000, h.asr.audio)
	h.slots.mu.Lock()
	require.Equal(t, 2, h.slots.userAcquired, "the user's concurrency slot both times")
	h.slots.mu.Unlock()

	// The ticket worked once.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, resp, err := coderws.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/v1/audio/realtime/transcriptions", &coderws.DialOptions{
		HTTPHeader:   http.Header{"Origin": {server.URL}},
		Subprotocols: []string{webproto.EventsSubprotocol, webproto.TicketSubprotocolPrefix + minted.Data.Ticket},
	})
	require.Error(t, err)
	require.NotNil(t, resp)
	require.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}
