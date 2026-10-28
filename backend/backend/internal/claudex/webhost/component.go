// Package webhost is the web relay (W-RELAY, web plan §1.2 and §2): it
// connects browsers to the claudex-runner that serves them.
//
//   - POST /api/v1/claudex/web/rpc/:method: a bridge call, relayed to the
//     user's runner (rpc.go);
//   - GET  /api/v1/claudex/web/events: the tab's event stream, seq numbers,
//     resume from a ring of the last events (events.go, hub.go);
//   - /api/v1/claudex/web/uploads: chunked uploads into webstore (uploads.go);
//   - GET  /api/v1/claudex/web/preview/:id: artifact previews behind a
//     short-lived signature, with the preview's own sandbox CSP (preview.go);
//   - GET  /api/v1/claudex/web/runner/link: the WebSocket runners dial
//     (link.go), with the user → runner assignment (registry.go) and run
//     capacity (runs.go);
//   - the console's Runners page API (admin.go);
//   - GET /api/v1/claudex/web/device/link, /web/devices and
//     /web/devices/:device/rpc/:method: signed-in desktops the account's
//     phones control (devices.go).
//
// Tenant isolation: a call carries the signed-in user of the JWT only; a
// runner's events, pages to open and store/key requests are accepted only
// for users assigned to that runner; a user's events go to that user's tabs
// only; a preview id names its user and the signature binds the id.
package webhost

import (
	"context"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"

	"github.com/gin-gonic/gin"
)

// Route paths (relative to /api/v1/claudex).
const (
	RouteRPC          = "/web/rpc/:method"
	RouteEvents       = "/web/events"
	RouteUploads      = "/web/uploads"
	RouteUploadChunk  = "/web/uploads/:id/chunks/:index"
	RouteUploadFinish = "/web/uploads/:id/complete"
	RoutePreview      = "/web/preview/:id"
	RouteRunnerLink   = "/web/runner/link"
	RouteRunners      = "/web/runners"
)

const sweepInterval = time.Minute

// Component is the web-host component.
type Component struct {
	env  *core.Env
	over Backends

	once sync.Once
	b    Backends

	reg     *registry
	hubs    *hubs
	devices deviceSet
	runs    *runs
	tokens  *tokenCache
	signer  *signer
	sums    uploadSums
	gate    callGate
	fires   fireLimiter
	dropped atomic.Int64

	heartbeat   time.Duration
	callTimeout time.Duration
	nowFn       func() time.Time
	startOnce   sync.Once
}

// New builds the component. Like every component it must not call its
// dependencies here: the backends are resolved on first use.
func New(env *core.Env) *Component { return NewWithBackends(env, Backends{}) }

// NewWithBackends builds the component with some backends replaced (tests,
// tools); nil fields come from the environment.
func NewWithBackends(env *core.Env, over Backends) *Component {
	if env == nil {
		env = &core.Env{}
	}
	c := &Component{
		env: env, over: over, tokens: newTokenCache(), signer: newSigner(),
		heartbeat: webproto.Heartbeat, callTimeout: webproto.CallTimeout,
	}
	c.hubs = newHubs(c)
	c.runs = newRuns(c)
	return c
}

// Name implements core.Feature.
func (c *Component) Name() string { return core.NameWebHost }

func (c *Component) now() time.Time {
	if c.nowFn != nil {
		return c.nowFn()
	}
	if c.env.Now != nil {
		return c.env.Now()
	}
	return time.Now()
}

// backends resolves the backends once (after the module bound the
// components).
func (c *Component) backends() Backends {
	c.once.Do(func() {
		c.b = fill(c.env, c.over)
		c.reg = newRegistry(c.b.Runners)
	})
	return c.b
}

// RegisterPublicRoutes implements core.PublicRouter: the routes that carry
// their own credential (events ticket, runner token, preview signature).
func (c *Component) RegisterPublicRoutes(g *gin.RouterGroup) {
	c.backends()
	g.GET(RouteEvents, c.events)
	g.GET(RouteRunnerLink, c.runnerLink)
	g.GET(RouteDeviceLink, c.deviceLink)
	g.GET(RoutePreview, c.preview)
	// A scheduled task's API trigger: the Bearer token is its credential.
	g.POST(RouteRoutineFire, c.fireRoutine)
}

// RegisterUserRoutes implements core.UserRouter.
func (c *Component) RegisterUserRoutes(g *gin.RouterGroup) {
	c.backends()
	g.POST(RouteRPC, c.rpc)
	g.GET(RouteDevices, c.listDevices)
	g.POST(RouteDeviceRPC, c.deviceRPC)
	g.POST(RouteUploads, c.beginUpload)
	g.PUT(RouteUploadChunk, c.uploadChunk)
	g.POST(RouteUploadFinish, c.completeUpload)
}

// RegisterAdminRoutes implements core.AdminRouter.
func (c *Component) RegisterAdminRoutes(g *gin.RouterGroup, stepUp gin.HandlerFunc) {
	c.backends()
	if stepUp == nil {
		stepUp = func(g *gin.Context) { g.Next() }
	}
	g.GET(RouteRunners, c.adminList)
	g.POST(RouteRunners, stepUp, c.adminCreate)
	g.PATCH(RouteRunners+"/:id", stepUp, c.adminUpdate)
	g.DELETE(RouteRunners+"/:id", stepUp, c.adminRevoke)
	g.POST(RouteRunners+"/:id/drain", stepUp, c.adminDrain)
}

// Start implements core.Starter: every minute it drops idle event rings and
// expired tokens and re-checks the users with open tabs (a user the
// administrator disabled or removed from the allowlist is disconnected).
func (c *Component) Start(ctx context.Context) {
	c.backends()
	c.startOnce.Do(func() {
		core.OnShutdown(c.goAway)
		go func() {
			t := time.NewTicker(sweepInterval)
			defer t.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-t.C:
					c.sweep(ctx)
				}
			}
		}()
	})
}

// goAway closes every runner link and tab when the server is told to stop
// (blue-green deploys): they dial again at once and reach the instance nginx
// sends them to now; the runners' turns go on (web plan Q7).
func (c *Component) goAway() {
	if c.reg != nil {
		for _, rc := range c.reg.all() {
			rc.close(webproto.CloseGoingAway, "server restarting")
		}
	}
	for _, uid := range c.hubs.usersWithTabs() {
		for _, t := range c.hubs.tabsOf(uid) {
			t.kill(webproto.CloseGoingAway, "server restarting")
		}
	}
	for _, d := range c.devices.all() {
		d.close(webproto.CloseGoingAway, "server restarting")
	}
}

func (c *Component) sweep(ctx context.Context) {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("claudex webhost: sweep panicked", "panic", r)
		}
	}()
	now := c.now()
	c.hubs.sweep(now)
	c.tokens.sweep(now)
	users := c.hubs.usersWithTabs()
	for _, uid := range c.devices.users() {
		if len(c.hubs.tabsOf(uid)) == 0 {
			users = append(users, uid)
		}
	}
	for _, uid := range users {
		cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		code, errCode, msg, ok := c.admit(cctx, uid)
		cancel()
		if ok {
			continue
		}
		reason := webproto.SignedOutRemoved
		if code == webproto.CloseSignedOut {
			reason = webproto.SignedOutRevoked
		}
		c.endUser(uid, code, errCode, msg, reason)
	}
}

// OnSessionsRevoked implements core.SessionRevoker ("log out of all
// devices"): the user's tabs close with 4008 and the runner drops the
// user's credentials; running turns go on (web plan Q7).
func (c *Component) OnSessionsRevoked(_ context.Context, userID int64, _ string) error {
	if userID <= 0 {
		return nil
	}
	c.backends()
	c.tokens.forget(userID)
	c.endUser(userID, webproto.CloseSignedOut, signedOutRevoked, "This session was signed out. Sign in again.", webproto.SignedOutRevoked)
	return nil
}

var (
	_ core.Feature        = (*Component)(nil)
	_ core.PublicRouter   = (*Component)(nil)
	_ core.UserRouter     = (*Component)(nil)
	_ core.AdminRouter    = (*Component)(nil)
	_ core.Starter        = (*Component)(nil)
	_ core.SessionRevoker = (*Component)(nil)
)
