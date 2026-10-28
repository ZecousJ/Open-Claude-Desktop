package voice

// Dictation on the web (W-VOICE). A browser holds no gateway key, so the
// web app opens GET /v1/audio/realtime/transcriptions with a one-time web
// ticket instead:
//
//  1. POST /api/v1/claudex/web/auth/voice-ticket (beside the web sign-in
//     routes: CSRF header and same origin, site switch, bearer access token
//     of an active web session, allowlist) answers {ticket, expires_in}. The
//     ticket is 32 random bytes, lives webproto.TicketTTL (30 s), works once
//     and is bound to the user and the web session (JWT sid and iat) that
//     asked for it; only its SHA-256 is stored.
//  2. The browser offers it in Sec-WebSocket-Protocol ("claudex.v1",
//     "ticket.<t>"), never in the URL, so it stays out of access logs.
//  3. Before API-key authentication (gatewayhook PreAuth, H6) the ticket is
//     redeemed: the upgrade must come from the site's origin, the web session
//     must still be active and not revoked, and the user's managed web key
//     (devices.EnsureWebKey, W-KEY) becomes the request's Authorization. From
//     there the request is an ordinary web-key request: the upstream key
//     checks, the device and usage-rule guards, billing eligibility, the
//     concurrency slot, the relay and the billing of the audio seconds run
//     exactly as for the desktop app, against the web key and its group.
//
// A request that carries its own API key (the desktop app) is never touched.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/devices"
	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/ip"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"

	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
)

// WebTicketRoute is the ticket endpoint under webproto.PathAuth
// (POST /api/v1/claudex/web/auth/voice-ticket).
const WebTicketRoute = webproto.AuthVoiceTicket

// Error codes of the web path.
const (
	// ReasonWebTicket: unknown, used, expired or malformed ticket (401).
	ReasonWebTicket = webproto.ErrCodeBadTicket
	// ReasonWebOrigin: the upgrade did not come from the web app's origin (403).
	ReasonWebOrigin = "CLAUDEX_AUDIO_WEB_ORIGIN"
	// ReasonWebUnavailable: the web session or web key cannot be checked (503).
	ReasonWebUnavailable = "CLAUDEX_AUDIO_WEB_UNAVAILABLE"
)

const webTicketKeyPrefix = "claudex:voice:ticket:"

var (
	errBadWebTicket = infraerrors.Unauthorized(ReasonWebTicket, "The dictation ticket is not valid. Request a new one.")
	errWebDisabled  = infraerrors.NotFound(ReasonDisabled, "Dictation is not enabled on this server")
	errWebNoGate    = infraerrors.ServiceUnavailable(ReasonWebUnavailable, "Dictation is temporarily unavailable. Try again.")
)

// WebSessions is what this package uses from the web component (W-AUTH).
type WebSessions interface {
	// AuthorizeWebPost runs the web auth-route checks; on failure it has
	// written the answer.
	AuthorizeWebPost(g *gin.Context) (userID int64, sessionID string, issuedAt time.Time, ok bool)
	// CheckWebCaller re-checks a web session when its ticket is redeemed.
	CheckWebCaller(ctx context.Context, userID int64, sessionID string, issuedAt time.Time) error
	// SameSiteRequest reports whether the request comes from the site's origin.
	SameSiteRequest(g *gin.Context) bool
}

// webTicket is what a ticket stands for.
type webTicket struct {
	UserID    int64  `json:"u"`
	SessionID string `json:"s"`
	IssuedAt  int64  `json:"i"` // JWT iat, unix nanoseconds (0: none)
}

func (t webTicket) issuedAt() time.Time {
	if t.IssuedAt == 0 {
		return time.Time{}
	}
	return time.Unix(0, t.IssuedAt)
}

// webTicketStore keeps one-time tickets by the SHA-256 of the ticket.
type webTicketStore interface {
	put(ctx context.Context, hash, value string, ttl time.Duration) error
	take(ctx context.Context, hash string) (string, bool, error)
}

func newWebTicketStore(env *core.Env) webTicketStore {
	if env != nil && env.Redis != nil {
		return &redisWebTickets{rdb: env.Redis}
	}
	return &memoryWebTickets{items: map[string]memoryWebTicket{}, now: time.Now}
}

type redisWebTickets struct{ rdb *redis.Client }

func (r *redisWebTickets) put(ctx context.Context, hash, value string, ttl time.Duration) error {
	return r.rdb.Set(ctx, webTicketKeyPrefix+hash, value, ttl).Err()
}

// take is GETDEL: of two concurrent redemptions only one gets the value.
func (r *redisWebTickets) take(ctx context.Context, hash string) (string, bool, error) {
	v, err := r.rdb.GetDel(ctx, webTicketKeyPrefix+hash).Result()
	if errors.Is(err, redis.Nil) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return v, true, nil
}

// memoryWebTickets is the single-node fallback without Redis (tests, dev).
type memoryWebTickets struct {
	mu    sync.Mutex
	items map[string]memoryWebTicket
	now   func() time.Time
}

type memoryWebTicket struct {
	value   string
	expires time.Time
}

const maxMemoryWebTickets = 10000

func (m *memoryWebTickets) put(_ context.Context, hash, value string, ttl time.Duration) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := m.now()
	if len(m.items) >= maxMemoryWebTickets {
		for k, t := range m.items {
			if !now.Before(t.expires) {
				delete(m.items, k)
			}
		}
		if len(m.items) >= maxMemoryWebTickets {
			return errors.New("voice: too many pending web tickets")
		}
	}
	m.items[hash] = memoryWebTicket{value: value, expires: now.Add(ttl)}
	return nil
}

func (m *memoryWebTickets) take(_ context.Context, hash string) (string, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	t, ok := m.items[hash]
	if !ok {
		return "", false, nil
	}
	delete(m.items, hash)
	if !m.now().Before(t.expires) {
		return "", false, nil
	}
	return t.value, true, nil
}

func hashTicket(ticket string) string {
	sum := sha256.Sum256([]byte(ticket))
	return hex.EncodeToString(sum[:])
}

// issueWebTicket stores a new ticket for t and returns it.
func (c *Component) issueWebTicket(ctx context.Context, t webTicket) (string, error) {
	ticket, err := webproto.NewTicket()
	if err != nil {
		return "", err
	}
	value, err := json.Marshal(t)
	if err != nil {
		return "", err
	}
	if err := c.tickets.put(ctx, hashTicket(ticket), string(value), webproto.TicketTTL); err != nil {
		return "", err
	}
	return ticket, nil
}

// redeemWebTicket consumes a ticket: errBadWebTicket for an unknown, used,
// expired or malformed one, errWebNoGate when the store fails.
func (c *Component) redeemWebTicket(ctx context.Context, ticket string) (webTicket, error) {
	if !webproto.ValidTicket(ticket) {
		return webTicket{}, errBadWebTicket
	}
	v, ok, err := c.tickets.take(ctx, hashTicket(ticket))
	if err != nil {
		slog.Error("claudex voice: reading a web ticket failed", "error", err)
		return webTicket{}, errWebNoGate
	}
	if !ok {
		return webTicket{}, errBadWebTicket
	}
	var t webTicket
	if json.Unmarshal([]byte(v), &t) != nil || t.UserID <= 0 || t.SessionID == "" {
		return webTicket{}, errBadWebTicket
	}
	return t, nil
}

// webSessions finds the web component (nil without one).
func (c *Component) webSessions() WebSessions {
	if c.webGate != nil {
		return c.webGate()
	}
	for _, f := range c.env.Components {
		if w, ok := f.(WebSessions); ok {
			return w
		}
	}
	return nil
}

// webKeys finds the web key issuer (the devices component).
func (c *Component) webKeys() devices.WebKeyIssuer {
	if c.webKeyIssuer != nil {
		return c.webKeyIssuer()
	}
	return devices.WebKeys(c.env)
}

// transcriptionOn reports whether dictation is on with an upstream key.
func (c *Component) transcriptionOn(ctx context.Context) bool {
	t := c.setting.Cached(ctx).Transcription
	return t.Enabled && t.KeyConfigured()
}

// RegisterPublicRoutes implements core.PublicRouter: the ticket route sits
// beside the web sign-in routes (same cookie path, no JWT group), and runs
// their checks through the web component.
func (c *Component) RegisterPublicRoutes(g *gin.RouterGroup) {
	g.POST(strings.TrimPrefix(webproto.PathAuth, "/api/v1/claudex")+WebTicketRoute, c.mintWebTicket)
}

// POST web/auth/voice-ticket: a one-time ticket for the dictation socket.
func (c *Component) mintWebTicket(g *gin.Context) {
	web := c.webSessions()
	if web == nil {
		response.ErrorFrom(g, errWebNoGate)
		return
	}
	userID, sessionID, issuedAt, ok := web.AuthorizeWebPost(g)
	if !ok {
		return
	}
	ctx := g.Request.Context()
	if !c.transcriptionOn(ctx) {
		response.ErrorFrom(g, errWebDisabled)
		return
	}
	t := webTicket{UserID: userID, SessionID: sessionID}
	if !issuedAt.IsZero() {
		t.IssuedAt = issuedAt.UnixNano()
	}
	ticket, err := c.issueWebTicket(ctx, t)
	if err != nil {
		slog.Error("claudex voice: issuing a web ticket failed", "error", err)
		response.ErrorFrom(g, errWebNoGate)
		return
	}
	g.Header("Cache-Control", "no-store")
	response.Success(g, webproto.TicketResponse{Ticket: ticket, ExpiresIn: int(webproto.TicketTTL / time.Second)})
}

// webTicketPreAuth is the PreAuth step of RealtimeTranscriptionsPath.
func webTicketPreAuth(g *gin.Context) bool {
	c := active.Load()
	if c == nil {
		return false
	}
	return c.preAuthWebTicket(g)
}

// hasAPIKeyCredentials reports whether the request names a key itself.
func hasAPIKeyCredentials(r *http.Request) bool {
	return r.Header.Get("Authorization") != "" || r.Header.Get("x-api-key") != "" ||
		r.Header.Get("x-goog-api-key") != ""
}

func isWebSocketUpgrade(r *http.Request) bool {
	return strings.EqualFold(strings.TrimSpace(r.Header.Get("Upgrade")), "websocket")
}

// preAuthWebTicket turns a web ticket into the user's web key. It leaves
// requests without a ticket (or with their own key) alone.
func (c *Component) preAuthWebTicket(g *gin.Context) (abort bool) {
	r := g.Request
	offered := r.Header.Values("Sec-WebSocket-Protocol")
	if len(offered) == 0 || !isWebSocketUpgrade(r) || hasAPIKeyCredentials(r) {
		return false
	}
	ticket, ok := webproto.TicketFromSubprotocols(offered)
	if !ok {
		return false // no ticket: the API-key middleware answers 401
	}
	ctx := r.Context()
	web := c.webSessions()
	if web == nil {
		return abortWeb(g, errWebNoGate)
	}
	// Cross-site WebSocket hijacking: the upgrade must come from the site.
	if !web.SameSiteRequest(g) {
		return abortWeb(g, infraerrors.Forbidden(ReasonWebOrigin, "Dictation must be opened from the web app."))
	}
	t, err := c.redeemWebTicket(ctx, ticket)
	if err != nil {
		return abortWeb(g, err)
	}
	if err := web.CheckWebCaller(ctx, t.UserID, t.SessionID, t.issuedAt()); err != nil {
		return abortWeb(g, err)
	}
	keys := c.webKeys()
	if keys == nil {
		return abortWeb(g, errWebNoGate)
	}
	// Dictation uses the plan group's key. Every group has its own web key
	// (MG), so asking without a group never moves a key another turn uses.
	key, err := keys.EnsureWebKey(ctx, devices.WebKeyRequest{
		UserID: t.UserID, SessionID: t.SessionID, IssuedAt: t.issuedAt(), IP: ip.GetClientIP(g),
	})
	if err != nil {
		slog.Warn("claudex voice: no web key for dictation", "user_id", t.UserID, "error", err)
		return abortWeb(g, err)
	}
	if key == nil || key.Key == "" || key.UserID != t.UserID {
		return abortWeb(g, errWebNoGate)
	}
	// From here on this is a web-key request like any other.
	r.Header.Set("Authorization", "Bearer "+key.Key)
	r.Header.Del("x-api-key")
	r.Header.Del("x-goog-api-key")
	// A browser drops a socket whose answer selects no offered protocol; the
	// relay's Accept selects none, so name it here (never the ticket).
	g.Header("Sec-WebSocket-Protocol", webproto.EventsSubprotocol)
	return false
}

// abortWeb answers a refused web upgrade in the gateway's error format.
// ApplicationErrors keep their status and reason; anything else is 503.
func abortWeb(g *gin.Context, err error) bool {
	status, code, message := http.StatusServiceUnavailable, ReasonWebUnavailable, "Dictation is temporarily unavailable. Try again."
	var app *infraerrors.ApplicationError
	if errors.As(err, &app) && app.Code >= 400 && app.Code < 600 {
		status, code, message = int(app.Code), app.Reason, app.Message
	}
	errType := "api_error"
	switch status {
	case http.StatusUnauthorized:
		errType = "authentication_error"
	case http.StatusForbidden:
		errType = "permission_error"
	case http.StatusNotFound:
		errType = "not_found_error"
	case http.StatusTooManyRequests:
		errType = "rate_limit_error"
	}
	g.AbortWithStatusJSON(status, gin.H{"error": gin.H{"type": errType, "code": code, "message": message}})
	return true
}
