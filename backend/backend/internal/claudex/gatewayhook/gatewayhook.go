// Package gatewayhook is the registry behind the Claudex hooks in the upstream
// gateway chain (API-key authentication middlewares and the /v1 route group).
//
// Upstream files call it with one marked line each:
//
//   - H5  KeyResolved(c, apiKey): right after the key is loaded, before any
//     upstream rejection; KeyMarkers only annotate the request (B4 marks
//     Claudex device keys) and can never stop it;
//   - H5b KeyAuthorized(c, apiKey): before every c.Next() of both API-key
//     middlewares, i.e. after every upstream check passed; RequestGuards run in
//     Priority order and the first one that aborts ends the request;
//   - H6  EnrichRefusals() and BodyLimits() at the front of the /v1 group;
//     BodyLimits also runs the PreAuth step registered for a route (W-VOICE:
//     the web dictation ticket), before API-key authentication.
//
// Nothing is registered until claudex.ProvideModule runs, so upstream
// behavior and tests are unchanged. The package imports only gin, the service
// types, the request helpers in internal/pkg and the standard library (never
// internal/server/middleware, which imports it).
package gatewayhook

import (
	"log/slog"
	"net/http"
	"sort"
	"sync"
	"sync/atomic"

	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
)

// Guard priorities (lower runs first).
const (
	PriorityDevice     = 10 // B4: revoked Claudex devices
	PriorityVersion    = 20 // B1: minimum desktop version (426)
	PriorityUsageRules = 30 // B5: usage rules precheck (429)
	PriorityWebSearch  = 40 // R45: web search switched off by the client policy (403)
)

// KeyMarker annotates a request once its API key is loaded (H5). It must not
// write a response or abort, and must tolerate apiKey.User or apiKey.Group
// being nil.
type KeyMarker interface {
	OnKeyResolved(c *gin.Context, apiKey *service.APIKey)
}

// RequestGuard checks a request after every upstream API-key check passed
// (H5b). Returning true means the guard wrote a response (for example with
// middleware.AbortWithError) and the request must stop.
type RequestGuard interface {
	Priority() int
	OnRequest(c *gin.Context, apiKey *service.APIKey) (abort bool)
}

// RefusalDescriber turns a gateway rejection of a Claudex device-key request
// into structured details (B6). It returns nil when it has nothing to add.
type RefusalDescriber interface {
	Describe(c *gin.Context, r Refusal) *RefusalDetail
}

type registry struct {
	markers    []KeyMarker
	guards     []RequestGuard
	describers []RefusalDescriber
	bodyLimits map[string]bodyLimit
	preAuth    map[string]PreAuth
}

var (
	registryMu    sync.Mutex
	active        atomic.Pointer[registry]
	emptyRegistry = &registry{} // read-only; update copies it
)

func snapshot() *registry {
	if r := active.Load(); r != nil {
		return r
	}
	return emptyRegistry
}

// update copies the registry, applies fn and publishes the copy, so request
// paths read a consistent snapshot without locking.
func update(fn func(r *registry)) {
	registryMu.Lock()
	defer registryMu.Unlock()
	old := snapshot()
	next := &registry{
		markers:    append([]KeyMarker(nil), old.markers...),
		guards:     append([]RequestGuard(nil), old.guards...),
		describers: append([]RefusalDescriber(nil), old.describers...),
		bodyLimits: make(map[string]bodyLimit, len(old.bodyLimits)),
	}
	for k, v := range old.bodyLimits {
		next.bodyLimits[k] = v
	}
	next.preAuth = make(map[string]PreAuth, len(old.preAuth))
	for k, v := range old.preAuth {
		next.preAuth[k] = v
	}
	fn(next)
	active.Store(next)
}

// RegisterKeyMarker adds a marker; markers run in registration order.
func RegisterKeyMarker(m KeyMarker) {
	if m == nil {
		return
	}
	update(func(r *registry) { r.markers = append(r.markers, m) })
}

// RegisterRequestGuard adds a guard; guards run by ascending Priority, ties in
// registration order.
func RegisterRequestGuard(g RequestGuard) {
	if g == nil {
		return
	}
	update(func(r *registry) {
		r.guards = append(r.guards, g)
		sort.SliceStable(r.guards, func(i, j int) bool { return r.guards[i].Priority() < r.guards[j].Priority() })
	})
}

// RegisterDescriber adds a refusal describer; the first non-nil answer wins.
func RegisterDescriber(d RefusalDescriber) {
	if d == nil {
		return
	}
	update(func(r *registry) { r.describers = append(r.describers, d) })
}

// Reset drops every registration. claudex.ProvideModule calls it before
// building the components; tests call it to start clean.
func Reset() {
	registryMu.Lock()
	defer registryMu.Unlock()
	active.Store(nil)
}

const ctxKeyAuthorized = "claudex.gateway.key_authorized"

// KeyResolved runs every KeyMarker (H5). Panics are logged and swallowed: a
// marker can never break authentication.
func KeyResolved(c *gin.Context, apiKey *service.APIKey) {
	if c == nil || apiKey == nil {
		return
	}
	for _, m := range snapshot().markers {
		runMarker(c, m, apiKey)
	}
}

func runMarker(c *gin.Context, m KeyMarker, apiKey *service.APIKey) {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("claudex gatewayhook: key marker panicked", "panic", r, "path", c.FullPath())
		}
	}()
	m.OnKeyResolved(c, apiKey)
}

// KeyAuthorized runs the RequestGuards (H5b) and reports whether one of them
// ended the request; the caller then returns without calling c.Next(). It
// runs at most once per request. A panicking guard fails closed with 500, and
// a guard that aborted or wrote a response but returned false still ends the
// request (the upstream handler must never run after a refusal).
func KeyAuthorized(c *gin.Context, apiKey *service.APIKey) bool {
	if c == nil {
		return false
	}
	if _, done := c.Get(ctxKeyAuthorized); done {
		return c.IsAborted()
	}
	c.Set(ctxKeyAuthorized, true)
	for _, g := range snapshot().guards {
		if runGuard(c, g, apiKey) || c.IsAborted() || c.Writer.Written() {
			if !c.Writer.Written() {
				c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"code": "FORBIDDEN", "message": "Request refused"})
			}
			c.Abort()
			return true
		}
	}
	return false
}

func runGuard(c *gin.Context, g RequestGuard, apiKey *service.APIKey) (abort bool) {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("claudex gatewayhook: request guard panicked", "panic", r, "path", c.FullPath())
			if !c.Writer.Written() {
				c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"code": "INTERNAL_ERROR", "message": "Internal server error"})
			}
			abort = true
		}
	}()
	return g.OnRequest(c, apiKey)
}
