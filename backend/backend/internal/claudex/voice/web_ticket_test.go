package voice

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/devices"
	"github.com/Wei-Shaw/sub2api/internal/claudex/gatewayhook"
	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

const webTestOrigin = "https://claudex.example.com"

// fakeWebGate stands in for the web component (W-AUTH): sessions by JWT
// sid, the caller of a POST from test headers.
type fakeWebGate struct {
	mu       sync.Mutex
	sessions map[string]fakeWebSession
	checks   int
}

type fakeWebSession struct {
	userID  int64
	revoked bool
}

var errFakeSessionEnded = infraerrors.Unauthorized("CLAUDEX_WEB_SESSION_ENDED", "This web session ended. Sign in again.")

func (f *fakeWebGate) AuthorizeWebPost(g *gin.Context) (int64, string, time.Time, bool) {
	if g.GetHeader(webproto.HeaderWeb) != "1" || g.GetHeader("Origin") != webTestOrigin {
		response.ErrorFrom(g, infraerrors.Forbidden(webproto.ErrCodeBadRequest, "This request must come from the web app."))
		return 0, "", time.Time{}, false
	}
	sid := g.GetHeader("X-Test-Session")
	f.mu.Lock()
	s, ok := f.sessions[sid]
	f.mu.Unlock()
	if !ok || s.revoked {
		response.ErrorFrom(g, errFakeSessionEnded)
		return 0, "", time.Time{}, false
	}
	return s.userID, sid, webTestIssuedAt, true
}

func (f *fakeWebGate) CheckWebCaller(_ context.Context, userID int64, sid string, issuedAt time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.checks++
	s, ok := f.sessions[sid]
	if !ok || s.revoked || s.userID != userID || !issuedAt.Equal(webTestIssuedAt) {
		return errFakeSessionEnded
	}
	return nil
}

func (f *fakeWebGate) SameSiteRequest(g *gin.Context) bool {
	return g.GetHeader("Origin") == webTestOrigin
}

func (f *fakeWebGate) set(sid string, s fakeWebSession) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sessions[sid] = s
}

var webTestIssuedAt = time.Date(2026, 9, 28, 8, 0, 0, 0, time.UTC)

// fakeWebKeys is devices.WebKeyIssuer: one key per user.
type fakeWebKeys struct {
	mu       sync.Mutex
	requests []devices.WebKeyRequest
	err      error
	owner    int64 // when set, the key answered belongs to this user
}

func (f *fakeWebKeys) EnsureWebKey(_ context.Context, in devices.WebKeyRequest) (*devices.WebKey, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.requests = append(f.requests, in)
	if f.err != nil {
		return nil, f.err
	}
	owner := in.UserID
	if f.owner != 0 {
		owner = f.owner
	}
	return &devices.WebKey{UserID: owner, APIKeyID: 900 + owner, Key: webKeyOf(owner), GroupID: 31}, nil
}

func (f *fakeWebKeys) IsWebKey(context.Context, int64) (int64, bool)     { return 0, false }
func (f *fakeWebKeys) RevokeWebKey(context.Context, int64, string) error { return nil }

func (f *fakeWebKeys) calls() []devices.WebKeyRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]devices.WebKeyRequest(nil), f.requests...)
}

func webKeyOf(userID int64) string { return "sk-web-user-" + strconv.FormatInt(userID, 10) }

// webFixture: the ticket route, and a /v1 group like the gateway's (H6
// BodyLimits in front of a recording API-key middleware).
type webFixture struct {
	t      *testing.T
	c      *Component
	gate   *fakeWebGate
	keys   *fakeWebKeys
	mem    *memoryWebTickets
	now    time.Time
	engine *gin.Engine

	mu    sync.Mutex
	auths []string // Authorization seen by the API-key middleware
}

func newWebFixture(t *testing.T, enabled bool) *webFixture {
	t.Helper()
	repo := newMemorySettingRepo()
	c, admin := newTestComponent(t, core.Deps{SettingRepo: repo, Config: fixedKeyConfig()})
	if enabled {
		w, _ := do(t, admin, http.MethodPut, "/api/v1/admin/claudex/voice",
			`{"transcription":{"upstream_url":"wss://transcribe.example.com/v1/audio/realtime/transcriptions","enabled":true,"api_key":"sk-test-0123456789abcdef"}}`)
		require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	}
	f := &webFixture{t: t, c: c, now: time.Date(2026, 9, 28, 8, 0, 5, 0, time.UTC)}
	f.gate = &fakeWebGate{sessions: map[string]fakeWebSession{"sid-a": {userID: 7}, "sid-b": {userID: 8}}}
	f.keys = &fakeWebKeys{}
	f.mem = &memoryWebTickets{items: map[string]memoryWebTicket{}, now: func() time.Time { return f.now }}
	c.tickets = f.mem
	c.webGate = func() WebSessions { return f.gate }
	c.webKeyIssuer = func() devices.WebKeyIssuer { return f.keys }

	r := gin.New()
	c.RegisterPublicRoutes(r.Group("/api/v1/claudex"))
	v1 := r.Group("/v1", gatewayhook.BodyLimits(), func(g *gin.Context) {
		f.mu.Lock()
		f.auths = append(f.auths, g.GetHeader("Authorization"))
		f.mu.Unlock()
		if g.GetHeader("Authorization") == "" {
			g.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": gin.H{"code": "API_KEY_REQUIRED"}})
			return
		}
		g.Next()
	})
	v1.GET("/audio/realtime/transcriptions", func(g *gin.Context) { g.String(http.StatusOK, "relayed") })
	f.engine = r
	return f
}

type mintReply struct {
	status int
	header http.Header
	env    envelope
	ticket webproto.TicketResponse
}

func (f *webFixture) mint(sid string, headers map[string]string) mintReply {
	f.t.Helper()
	req := httptest.NewRequest(http.MethodPost, webproto.PathAuth+WebTicketRoute, strings.NewReader(`{"tabId":"tab-12345678"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(webproto.HeaderWeb, "1")
	req.Header.Set("Origin", webTestOrigin)
	req.Header.Set("X-Test-Session", sid)
	for k, v := range headers {
		if v == "" {
			req.Header.Del(k)
		} else {
			req.Header.Set(k, v)
		}
	}
	w := httptest.NewRecorder()
	f.engine.ServeHTTP(w, req)
	out := mintReply{status: w.Code, header: w.Header()}
	require.NoError(f.t, json.Unmarshal(w.Body.Bytes(), &out.env), w.Body.String())
	if w.Code == http.StatusOK {
		require.NoError(f.t, json.Unmarshal(out.env.Data, &out.ticket))
	}
	return out
}

func (f *webFixture) ticket(sid string) string {
	f.t.Helper()
	r := f.mint(sid, nil)
	require.Equal(f.t, http.StatusOK, r.status, "%+v", r.env)
	return r.ticket.Ticket
}

type upgradeReply struct {
	status int
	header http.Header
	code   string
}

// upgrade sends the browser's dictation upgrade (the handshake headers the
// relay's Accept reads are not needed: the fixture stops at the key).
func (f *webFixture) upgrade(protocols string, headers map[string]string) upgradeReply {
	f.t.Helper()
	req := httptest.NewRequest(http.MethodGet, RealtimeTranscriptionsPath, nil)
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Origin", webTestOrigin)
	if protocols != "" {
		req.Header.Set("Sec-WebSocket-Protocol", protocols)
	}
	for k, v := range headers {
		if v == "" {
			req.Header.Del(k)
		} else {
			req.Header.Set(k, v)
		}
	}
	w := httptest.NewRecorder()
	f.engine.ServeHTTP(w, req)
	out := upgradeReply{status: w.Code, header: w.Header()}
	if w.Code != http.StatusOK {
		var body struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		_ = json.Unmarshal(w.Body.Bytes(), &body)
		out.code = body.Error.Code
	}
	return out
}

func offer(ticket string) string {
	return webproto.EventsSubprotocol + ", " + webproto.TicketSubprotocolPrefix + ticket
}

func (f *webFixture) seenAuths() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.auths...)
}

func TestWebTicketBecomesTheUsersWebKey(t *testing.T) {
	f := newWebFixture(t, true)
	r := f.mint("sid-a", nil)
	require.Equal(t, http.StatusOK, r.status, "%+v", r.env)
	require.True(t, webproto.ValidTicket(r.ticket.Ticket))
	require.Equal(t, int(webproto.TicketTTL/time.Second), r.ticket.ExpiresIn)
	require.Equal(t, "no-store", r.header.Get("Cache-Control"))
	for k, v := range f.mem.items {
		require.NotContains(t, k, r.ticket.Ticket, "only the hash is stored")
		require.NotContains(t, v.value, r.ticket.Ticket)
	}

	u := f.upgrade(offer(r.ticket.Ticket), nil)
	require.Equal(t, http.StatusOK, u.status, u.code)
	require.Equal(t, webproto.EventsSubprotocol, u.header.Get("Sec-WebSocket-Protocol"), "the browser needs an offered protocol back, never the ticket")
	require.Equal(t, []string{"Bearer " + webKeyOf(7)}, f.seenAuths(), "the API-key middleware sees the web key")
	calls := f.keys.calls()
	require.Len(t, calls, 1)
	require.Equal(t, int64(7), calls[0].UserID)
	require.Equal(t, "sid-a", calls[0].SessionID)
	require.True(t, calls[0].IssuedAt.Equal(webTestIssuedAt), "the access token's iat goes to the revocation rules")
	require.Nil(t, calls[0].GroupID, "the web key's plan group")
}

func TestWebTicketWorksOnce(t *testing.T) {
	f := newWebFixture(t, true)
	ticket := f.ticket("sid-a")
	require.Equal(t, http.StatusOK, f.upgrade(offer(ticket), nil).status)
	u := f.upgrade(offer(ticket), nil)
	require.Equal(t, http.StatusUnauthorized, u.status)
	require.Equal(t, ReasonWebTicket, u.code)
	require.Len(t, f.keys.calls(), 1)
	require.Len(t, f.seenAuths(), 1, "a reused ticket never reaches API-key authentication")
}

func TestWebTicketExpires(t *testing.T) {
	f := newWebFixture(t, true)
	ticket := f.ticket("sid-a")
	f.now = f.now.Add(webproto.TicketTTL)
	u := f.upgrade(offer(ticket), nil)
	require.Equal(t, http.StatusUnauthorized, u.status)
	require.Equal(t, ReasonWebTicket, u.code)
	require.Empty(t, f.keys.calls())

	// Just inside the TTL it works.
	ticket = f.ticket("sid-a")
	f.now = f.now.Add(webproto.TicketTTL - time.Millisecond)
	require.Equal(t, http.StatusOK, f.upgrade(offer(ticket), nil).status)
}

func TestWebTicketIsBoundToItsUserAndSession(t *testing.T) {
	f := newWebFixture(t, true)

	// The session now belongs to another user (or never belonged to the
	// ticket's user): refused, no key.
	ticket := f.ticket("sid-a")
	f.gate.set("sid-a", fakeWebSession{userID: 8})
	u := f.upgrade(offer(ticket), nil)
	require.Equal(t, http.StatusUnauthorized, u.status)
	require.Equal(t, "CLAUDEX_WEB_SESSION_ENDED", u.code)
	require.Empty(t, f.keys.calls())

	// Each user's ticket yields that user's key only.
	f.gate.set("sid-a", fakeWebSession{userID: 7})
	a, b := f.ticket("sid-a"), f.ticket("sid-b")
	require.Equal(t, http.StatusOK, f.upgrade(offer(b), nil).status)
	require.Equal(t, http.StatusOK, f.upgrade(offer(a), nil).status)
	require.Equal(t, []string{"Bearer " + webKeyOf(8), "Bearer " + webKeyOf(7)}, f.seenAuths())

	// A key of another user is never used.
	f.keys.owner = 8
	u = f.upgrade(offer(f.ticket("sid-a")), nil)
	require.Equal(t, http.StatusServiceUnavailable, u.status)
	require.Equal(t, ReasonWebUnavailable, u.code)
	require.Len(t, f.seenAuths(), 2)

	// A forged ticket (right shape, never issued) is refused.
	forged, err := webproto.NewTicket()
	require.NoError(t, err)
	u = f.upgrade(offer(forged), nil)
	require.Equal(t, http.StatusUnauthorized, u.status)
	require.Equal(t, ReasonWebTicket, u.code)
}

func TestWebTicketOfARevokedSessionIsRefused(t *testing.T) {
	f := newWebFixture(t, true)
	ticket := f.ticket("sid-a")
	// Sign-out (or "log out of all devices") between the ticket and the socket.
	f.gate.set("sid-a", fakeWebSession{userID: 7, revoked: true})
	u := f.upgrade(offer(ticket), nil)
	require.Equal(t, http.StatusUnauthorized, u.status)
	require.Equal(t, "CLAUDEX_WEB_SESSION_ENDED", u.code)
	require.Empty(t, f.keys.calls())
	require.Empty(t, f.seenAuths())

	// A revoked session cannot get a new ticket either.
	r := f.mint("sid-a", nil)
	require.Equal(t, http.StatusUnauthorized, r.status)

	// The web key issuer's own revocation answer (a token from before the
	// last revoke-all) keeps its status.
	f.gate.set("sid-a", fakeWebSession{userID: 7})
	f.keys.err = devices.ErrSessionRevoked
	u = f.upgrade(offer(f.ticket("sid-a")), nil)
	require.Equal(t, http.StatusUnauthorized, u.status)
	require.Equal(t, "CLAUDEX_SESSION_REVOKED", u.code)
	require.Empty(t, f.seenAuths())
}

func TestWebTicketNeedsTheSitesOrigin(t *testing.T) {
	f := newWebFixture(t, true)
	ticket := f.ticket("sid-a")
	u := f.upgrade(offer(ticket), map[string]string{"Origin": "https://evil.example"})
	require.Equal(t, http.StatusForbidden, u.status)
	require.Equal(t, ReasonWebOrigin, u.code)
	u = f.upgrade(offer(ticket), map[string]string{"Origin": ""})
	require.Equal(t, http.StatusForbidden, u.status)
	require.Empty(t, f.keys.calls())
	require.Equal(t, http.StatusOK, f.upgrade(offer(ticket), nil).status, "a refused origin does not burn the ticket")
}

func TestDesktopRequestsAreLeftAlone(t *testing.T) {
	f := newWebFixture(t, true)
	ticket := f.ticket("sid-a")

	// Its own key wins; the ticket is neither read nor consumed.
	u := f.upgrade(offer(ticket), map[string]string{"Authorization": "Bearer sk-device"})
	require.Equal(t, http.StatusOK, u.status)
	require.Empty(t, u.header.Get("Sec-WebSocket-Protocol"))
	u = f.upgrade("", map[string]string{"Authorization": "Bearer sk-device"})
	require.Equal(t, http.StatusOK, u.status)
	require.Equal(t, []string{"Bearer sk-device", "Bearer sk-device"}, f.seenAuths())

	// No key and no ticket (or a malformed offer): the API-key middleware
	// answers as before.
	require.Equal(t, http.StatusUnauthorized, f.upgrade("", nil).status)
	require.Equal(t, http.StatusUnauthorized, f.upgrade("ticket."+ticket, nil).status, "the ticket needs claudex.v1 beside it")
	require.Equal(t, http.StatusUnauthorized, f.upgrade(offer(ticket)+", ticket."+ticket, nil).status, "exactly one ticket")
	// Not a WebSocket upgrade: never redeemed.
	u = f.upgrade(offer(ticket), map[string]string{"Upgrade": ""})
	require.Equal(t, http.StatusUnauthorized, u.status)
	require.Empty(t, f.keys.calls())

	require.Equal(t, http.StatusOK, f.upgrade(offer(ticket), nil).status, "still unused")
}

func TestWebTicketMintRefusals(t *testing.T) {
	f := newWebFixture(t, false)
	r := f.mint("sid-a", nil)
	require.Equal(t, http.StatusNotFound, r.status, "dictation off")
	require.Equal(t, ReasonDisabled, r.env.Reason)
	require.Empty(t, f.mem.items)

	f = newWebFixture(t, true)
	r = f.mint("sid-a", map[string]string{webproto.HeaderWeb: ""})
	require.Equal(t, http.StatusForbidden, r.status, "CSRF header")
	r = f.mint("sid-a", map[string]string{"Origin": "https://evil.example"})
	require.Equal(t, http.StatusForbidden, r.status, "CSRF origin")
	r = f.mint("sid-unknown", nil)
	require.Equal(t, http.StatusUnauthorized, r.status, "no web session")
	require.Empty(t, f.mem.items)

	f.c.webGate = func() WebSessions { return nil }
	r = f.mint("sid-a", nil)
	require.Equal(t, http.StatusServiceUnavailable, r.status, "no web component")
	require.Equal(t, ReasonWebUnavailable, r.env.Reason)
}

func TestWebTicketWithoutWebComponentsFailsClosed(t *testing.T) {
	f := newWebFixture(t, true)
	ticket := f.ticket("sid-a")
	f.c.webKeyIssuer = func() devices.WebKeyIssuer { return nil }
	u := f.upgrade(offer(ticket), nil)
	require.Equal(t, http.StatusServiceUnavailable, u.status)
	require.Equal(t, ReasonWebUnavailable, u.code)

	ticket = f.ticket("sid-a")
	f.c.webGate = func() WebSessions { return nil }
	u = f.upgrade(offer(ticket), nil)
	require.Equal(t, http.StatusServiceUnavailable, u.status)
	require.Empty(t, f.seenAuths())
}

func TestWebTicketStoreBounds(t *testing.T) {
	now := time.Now()
	m := &memoryWebTickets{items: map[string]memoryWebTicket{}, now: func() time.Time { return now }}
	ctx := context.Background()
	for i := 0; i < maxMemoryWebTickets; i++ {
		require.NoError(t, m.put(ctx, "hash-"+strconv.Itoa(i), "v", time.Second))
	}
	require.Error(t, m.put(ctx, "one-more", "v", time.Second), "full of live tickets")
	now = now.Add(time.Second)
	require.NoError(t, m.put(ctx, "one-more", "v", time.Second), "expired ones are dropped")
	require.Len(t, m.items, 1)
}

// The real web component satisfies WebSessions (compile-time check lives in
// the web package's gate.go; here: the lookup finds it through Components).
func TestWebSessionsLookup(t *testing.T) {
	c, _ := newTestComponent(t, core.Deps{})
	gate := &fakeWebGate{}
	c.env.Components = []core.Feature{c, namedGate{gate}}
	require.Equal(t, WebSessions(namedGate{gate}), c.webSessions())
	require.Nil(t, c.webKeys(), "no devices component installed")
}

type namedGate struct{ *fakeWebGate }

func (namedGate) Name() string { return "web" }
