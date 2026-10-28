package usage

import (
	"context"
	"log/slog"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/gatewayhook"
	claudexhook "github.com/Wei-Shaw/sub2api/internal/claudex/hook"
	"github.com/Wei-Shaw/sub2api/internal/pkg/ctxkey"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
)

// Headers the runner sends with every model call it makes with a web key
// (design W-SRV 6 "回合归属"). They are read only for web keys and always
// removed from the request, so they never reach an upstream provider.
const (
	HeaderWebSession   = "X-Claudex-Web-Session"
	HeaderConversation = "X-Claudex-Conversation"
)

// platformWeb is claudex_devices.platform of the web device (devices.PlatformWeb;
// not imported to keep this package free of the devices component).
const platformWeb = "web"

// Attribution lifetimes: a request id is billed shortly after its request
// ends; the per-key fallback covers requests billed under a stable id (web
// search, Responses WebSocket turns) for as long as a long run can last.
const (
	requestTTL     = 2 * time.Hour
	keyTTL         = 26 * time.Hour
	maxAttribution = 50000
	linkTimeout    = 3 * time.Second
)

var idPattern = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,64}$`)

// ValidID reports whether s can be a conversation, web session or runner id.
func ValidID(s string) bool { return idPattern.MatchString(s) }

type attribution struct {
	UserID       int64
	APIKeyID     int64
	Conversation string
	WebSession   string
	At           time.Time
}

// tracker remembers which conversation a web-key request serves until the
// gateway bills it (H8 runs after the request, on another goroutine, and only
// carries the request id and the key).
type tracker struct {
	mu        sync.Mutex
	byRequest map[string]attribution // billing request id ("client:<id>", "local:<id>")
	byKey     map[int64]attribution  // latest request per web key
}

func newTracker() *tracker {
	return &tracker{byRequest: map[string]attribution{}, byKey: map[int64]attribution{}}
}

// put remembers a web-key request. An attribution without a conversation
// only marks its request ids (so the per-key fallback does not claim them).
func (t *tracker) put(ids []string, a attribution) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if len(t.byRequest)+len(ids) > maxAttribution {
		t.pruneLocked(a.At)
		if len(t.byRequest)+len(ids) > maxAttribution {
			// Still full: drop the per-request entries, the per-key fallback
			// keeps attributing.
			t.byRequest = map[string]attribution{}
		}
	}
	for _, id := range ids {
		t.byRequest[id] = a
	}
	if a.Conversation != "" {
		t.byKey[a.APIKeyID] = a
	}
}

// take returns the attribution of a billed request: by its request id, else
// the key's latest request.
func (t *tracker) take(requestID string, apiKeyID int64, now time.Time) (attribution, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if a, ok := t.byRequest[requestID]; ok {
		delete(t.byRequest, requestID)
		if a.APIKeyID == apiKeyID && now.Sub(a.At) < requestTTL {
			return a, a.Conversation != ""
		}
	}
	if a, ok := t.byKey[apiKeyID]; ok && now.Sub(a.At) < keyTTL {
		return a, true
	}
	return attribution{}, false
}

func (t *tracker) prune(now time.Time) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.pruneLocked(now)
}

func (t *tracker) pruneLocked(now time.Time) {
	for id, a := range t.byRequest {
		if now.Sub(a.At) >= requestTTL {
			delete(t.byRequest, id)
		}
	}
	for id, a := range t.byKey {
		if now.Sub(a.At) >= keyTTL {
			delete(t.byKey, id)
		}
	}
}

// billingRequestIDs are the ids the gateway may bill this request under
// (resolveUsageBillingRequestID: the client request id, else the local one).
func billingRequestIDs(ctx context.Context) []string {
	var ids []string
	if v, _ := ctx.Value(ctxkey.ClientRequestID).(string); strings.TrimSpace(v) != "" {
		ids = append(ids, "client:"+strings.TrimSpace(v))
	}
	if v, _ := ctx.Value(ctxkey.RequestID).(string); strings.TrimSpace(v) != "" {
		ids = append(ids, "local:"+strings.TrimSpace(v))
	}
	return ids
}

// OnKeyResolved implements gatewayhook.KeyMarker (H5): for a web key it
// remembers the conversation the request serves. The two headers are
// removed from every request.
func (c *Component) OnKeyResolved(g *gin.Context, apiKey *service.APIKey) {
	if g == nil || g.Request == nil || apiKey == nil {
		return
	}
	conversation := strings.TrimSpace(g.Request.Header.Get(HeaderConversation))
	session := strings.TrimSpace(g.Request.Header.Get(HeaderWebSession))
	g.Request.Header.Del(HeaderConversation)
	g.Request.Header.Del(HeaderWebSession)
	dev, ok := gatewayhook.Device(g)
	if !ok && c.env.Peers.Devices != nil {
		dev, ok = c.env.Peers.Devices.LookupByAPIKey(g.Request.Context(), apiKey.ID)
	}
	if !ok || dev == nil || dev.Platform != platformWeb || dev.APIKeyID != apiKey.ID {
		return
	}
	if !ValidID(conversation) {
		conversation = ""
	}
	if session != "" && !ValidID(session) {
		session = ""
	}
	c.tracker.put(billingRequestIDs(g.Request.Context()), attribution{
		UserID: dev.UserID, APIKeyID: apiKey.ID, Conversation: conversation, WebSession: session, At: c.now(),
	})
}

// OnUsageApplied implements core.UsageObserver (H8): a billed request of a web
// key that named its conversation gets a claudex_web_usage_links row.
func (c *Component) OnUsageApplied(ctx context.Context, ev claudexhook.UsageEvent) {
	if ev.APIKeyID <= 0 || ev.RequestID == "" {
		return
	}
	a, ok := c.tracker.take(ev.RequestID, ev.APIKeyID, c.now())
	if !ok || (ev.UserID > 0 && ev.UserID != a.UserID) {
		return
	}
	st := c.store()
	if st == nil {
		return
	}
	model := ev.RequestedModel
	if model == "" {
		model = ev.BilledModel
	}
	at := ev.At
	if at.IsZero() {
		at = c.now()
	}
	lctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), linkTimeout)
	defer cancel()
	err := st.insertLink(lctx, usageLink{
		RequestID: ev.RequestID, APIKeyID: ev.APIKeyID, UserID: a.UserID,
		Conversation: a.Conversation, WebSession: a.WebSession, Model: model, CostUSD: ev.CostUSD, At: at,
	})
	if err != nil {
		slog.Warn("claudex web usage: could not link a billed request to its conversation",
			"user_id", a.UserID, "api_key_id", ev.APIKeyID, "error", err)
	}
}
