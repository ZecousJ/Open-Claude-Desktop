package web

// Native clients authenticate through the existing /api/v1/auth token-pair
// endpoints. No password, cookie, API key, or live account is used here.
import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	claudexhook "github.com/Wei-Shaw/sub2api/internal/claudex/hook"
	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

const mobileTicketPath = "/api/v1/claudex/mobile/events-ticket"

// Deliberately does not install JWT middleware: the endpoint must also
// validate its bearer through eventsTicket/bearerUser before issuing a ticket.
// The production RegisterUserRoutes is additionally inside the JWT group.
func mobileFixture(t *testing.T, settings *Settings) (*gateFixture, *gin.Engine, string) {
	t.Helper()
	f := newGateFixture(t, settings)
	user := &service.User{ID: 7, Email: "a@example.com", Status: service.StatusActive, Role: service.RoleUser}
	users := gateUsers{users: map[int64]*service.User{7: user}}
	cfg := f.c.env.Config
	cfg.JWT.Secret = "mobile-unit-test-only-signing-key"
	cfg.JWT.AccessTokenExpireMinutes = 60
	cfg.JWT.ExpireHour = 1
	f.c.env.AuthService = service.NewAuthService(nil, users, nil, nil, cfg, nil, nil, nil, nil, nil, nil, nil, nil)
	token, err := f.c.env.AuthService.GenerateToken(context.Background(), user)
	require.NoError(t, err)
	r := gin.New()
	f.c.RegisterPublicRoutes(r.Group("/api/v1/claudex"))
	f.c.RegisterUserRoutes(r.Group("/api/v1/claudex"))
	return f, r, token
}

func mobileRequest(r *gin.Engine, path, token, body string, extra map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for key, value := range extra {
		req.Header.Set(key, value)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func mobileTicket(t *testing.T, w *httptest.ResponseRecorder) webproto.TicketResponse {
	t.Helper()
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var result struct {
		Code int                     `json:"code"`
		Data webproto.TicketResponse `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &result))
	require.Zero(t, result.Code)
	require.True(t, webproto.ValidTicket(result.Data.Ticket))
	require.Equal(t, 30, result.Data.ExpiresIn)
	require.Equal(t, "no-store", w.Header().Get("Cache-Control"))
	require.Empty(t, w.Header().Values("Set-Cookie"))
	return result.Data
}

func TestMobileEventsTicketAcceptsBearerWithoutBrowserHeaders(t *testing.T) {
	f, r, token := mobileFixture(t, enabled)
	w := mobileRequest(r, mobileTicketPath, token, `{"tabId":"mobile-client-123"}`, nil)
	ticket := mobileTicket(t, w)
	uid, err := f.c.RedeemTicket(context.Background(), ticket.Ticket, "mobile-client-123")
	require.NoError(t, err)
	require.Equal(t, int64(7), uid)
	_, err = f.c.RedeemTicket(context.Background(), ticket.Ticket, "mobile-client-123")
	require.ErrorIs(t, err, ErrBadTicket, "a replay is rejected")
	require.NoError(t, f.mock.ExpectationsWereMet(), "a console/native JWT requires no browser session row")
}

func TestMobileEventsTicketRetainsWebCSRF(t *testing.T) {
	_, r, token := mobileFixture(t, enabled)
	for _, headers := range []map[string]string{
		nil,
		{webproto.HeaderWeb: "1", "Origin": "https://untrusted.example"},
	} {
		w := mobileRequest(r, webproto.PathAuth+webproto.AuthEventsTicket, token, `{"tabId":"mobile-client-123"}`, headers)
		require.Equal(t, http.StatusForbidden, w.Code, "the browser route still enforces its original CSRF checks")
	}
}

func TestMobileEventsTicketRejectsMissingInvalidRevokedAndUnavailableAuth(t *testing.T) {
	f, r, token := mobileFixture(t, enabled)
	for _, invalid := range []string{"", "not-a-token"} {
		w := mobileRequest(r, mobileTicketPath, invalid, `{"tabId":"mobile-client-123"}`, nil)
		require.Equal(t, http.StatusUnauthorized, w.Code)
	}
	w := mobileRequest(r, mobileTicketPath, "", `{"tabId":"mobile-client-123"}`, map[string]string{"Cookie": webproto.RefreshCookie + "=browser-cookie-is-not-native-auth"})
	require.Equal(t, http.StatusUnauthorized, w.Code, "browser cookies cannot authorize the native ticket route")
	f.revoked = claudexhook.Revoked
	w = mobileRequest(r, mobileTicketPath, token, `{"tabId":"mobile-client-123"}`, nil)
	require.Equal(t, http.StatusUnauthorized, w.Code)
	f.revoked = claudexhook.CheckFailed
	w = mobileRequest(r, mobileTicketPath, token, `{"tabId":"mobile-client-123"}`, nil)
	require.Equal(t, http.StatusServiceUnavailable, w.Code, "revocation failures fail closed")
}

func TestMobileEventsTicketHonorsSwitchAndAllowlist(t *testing.T) {
	for _, settings := range []*Settings{
		{Enabled: false, Mode: ModeEveryone},
		{Enabled: true, Mode: ModeAllowlist, AllowlistUserIDs: []int64{8}},
	} {
		_, r, token := mobileFixture(t, settings)
		w := mobileRequest(r, mobileTicketPath, token, `{"tabId":"mobile-client-123"}`, nil)
		require.Equal(t, http.StatusForbidden, w.Code)
	}
}

func TestMobileEventsTicketChecksClientBindingAndExpiry(t *testing.T) {
	f, r, token := mobileFixture(t, enabled)
	w := mobileRequest(r, mobileTicketPath, token, `{"tabId":"mobile-client-123"}`, map[string]string{webproto.HeaderTab: "other-client-123"})
	require.Equal(t, http.StatusBadRequest, w.Code)
	w = mobileRequest(r, mobileTicketPath, token, `{"tabId":"short"}`, nil)
	require.Equal(t, http.StatusBadRequest, w.Code)
	w = mobileRequest(r, mobileTicketPath, token, `{"tabId":"mobile-client-123"}`, nil)
	ticket := mobileTicket(t, w)
	_, err := f.c.RedeemTicket(context.Background(), ticket.Ticket, "other-client-123")
	require.ErrorIs(t, err, ErrBadTicket)
	_, err = f.c.RedeemTicket(context.Background(), ticket.Ticket, "mobile-client-123")
	require.ErrorIs(t, err, ErrBadTicket, "a foreign-client attempt burns the ticket")

	now := time.Now()
	f.c.tickets = &memoryTickets{items: map[string]memoryTicket{}, now: func() time.Time { return now }}
	w = mobileRequest(r, mobileTicketPath, token, `{"tabId":"mobile-client-123"}`, nil)
	ticket = mobileTicket(t, w)
	now = now.Add(webproto.TicketTTL)
	_, err = f.c.RedeemTicket(context.Background(), ticket.Ticket, "mobile-client-123")
	require.ErrorIs(t, err, ErrBadTicket, "expiry is exclusive")
}
