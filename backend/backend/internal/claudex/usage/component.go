// Package usage is the B5 component, the usage rules engine (design 2.6):
// administrator-defined limits in USD of billed cost over first-use windows,
// a 5-hour "Current session" and weekly limits for all models or per model,
// applied to every API key of a group (device keys and user-created keys,
// owner decision 8) on every gateway route family.
//
//   - tables claudex_usage_rules and claudex_usage_counters
//     (migrations/claudex_0030_usage_rules.sql);
//   - counting: core.UsageObserver (H8), one UPSERT per billed request with a
//     retry queue (counter.go);
//   - precheck: gatewayhook.RequestGuard priority 30 (H5b) and
//     core.TurnPrechecker for Responses WebSocket turns (H14), answering 429
//     CLAUDEX_USAGE_LIMIT_EXCEEDED with a "claudex" detail and Retry-After
//     (guard.go);
//   - GET /api/v1/claudex/usage-status and the bootstrap section "usage"
//     (status.go);
//   - GET /api/v1/claudex/session-usage, one session's usage by model from
//     usage_logs.session_id (session.go);
//   - administrator CRUD, counters, reset and per-user status (admin.go).
package usage

import (
	"context"
	"database/sql"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/gatewayhook"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
)

// Component is the B5 component.
type Component struct {
	env     *core.Env
	store   store
	rules   *ruleCache
	queue   *retryQueue
	sources statusSources
	// mapChannel resolves channel model mappings (ChannelService); nil
	// without channels.
	mapChannel channelMapper
	// readSessionUsage reads the rows of GET /session-usage (session.go);
	// tests replace it.
	readSessionUsage sessionUsageReader

	precheckErrors atomic.Uint64
	started        atomic.Bool

	// spend keeps the monthly spend limits (spend.go); nil uses store.
	spend        spendStore
	spendMu      sync.Mutex
	spendEntries map[int64]spendEntry

	// productNotes and productsStore keep usage by product (products.go).
	productNotes  productNotes
	productsStore productStore
}

// New builds the component. It must not call its dependencies or env.Peers:
// ProvideModule binds the peers after every component is built, and tests
// pass empty Deps.
func New(env *core.Env) *Component {
	c := &Component{env: env, queue: newRetryQueue(retryQueueCapacity), sources: sourcesFrom(env)}
	db := sqlStore{db: func() *sql.DB {
		if env == nil {
			return nil
		}
		return env.DB
	}}
	c.store = db
	c.readSessionUsage = db.sessionUsage
	c.rules = &ruleCache{load: func(ctx context.Context) ([]activeRule, error) { return c.store.enabledRules(ctx) }, now: c.now}
	c.mapChannel = channelMapperFrom(func() *service.ChannelService {
		if env == nil {
			return nil
		}
		return env.Channels
	})
	return c
}

// Name implements core.Feature.
func (c *Component) Name() string { return core.NameUsage }

func (c *Component) now() time.Time {
	if c.env != nil && c.env.Now != nil {
		return c.env.Now()
	}
	return time.Now()
}

// RegisterUserRoutes implements core.UserRouter: GET /api/v1/claudex/usage-status
// and GET /api/v1/claudex/session-usage (session.go).
func (c *Component) RegisterUserRoutes(g *gin.RouterGroup) {
	g.GET("/usage-status", c.env.Heavy(), c.userStatus)
	g.GET("/session-usage", c.env.Heavy(), c.userSessionUsage)
	g.GET("/spend-limit", c.getSpendLimit)
	g.GET("/usage-products", c.env.Heavy(), c.getUsageProducts)
	g.PUT("/spend-limit", c.putSpendLimit)
}

// RegisterAdminRoutes implements core.AdminRouter (writes behind step-up).
func (c *Component) RegisterAdminRoutes(g *gin.RouterGroup, stepUp gin.HandlerFunc) {
	g.GET("/usage-rules", c.adminList)
	g.POST("/usage-rules", stepUp, c.adminCreate)
	g.PUT("/usage-rules/:id", stepUp, c.adminUpdate)
	g.DELETE("/usage-rules/:id", stepUp, c.adminDelete)
	g.GET("/usage-rules/:id/counters", c.adminCounters)
	g.POST("/usage-rules/:id/reset", stepUp, c.adminReset)
	g.GET("/users/:user_id/usage-status", c.adminUserStatus)
}

// Sections implements core.BootstrapContributor.
func (c *Component) Sections() []string { return []string{core.SectionUsage} }

// BootstrapSections implements core.BootstrapContributor: section "usage".
func (c *Component) BootstrapSections(ctx context.Context, bc *core.BootstrapContext) (map[string]any, error) {
	var plan *core.PlanRef
	if bc != nil {
		plan = bc.Plan
	}
	section, err := c.bootstrapUsage(ctx, plan)
	if err != nil {
		return nil, err
	}
	return map[string]any{core.SectionUsage: section}, nil
}

// Start implements core.Starter: the retry worker of the counter queue.
func (c *Component) Start(ctx context.Context) {
	if !c.started.CompareAndSwap(false, true) {
		return
	}
	go c.retryLoop(ctx)
}

var (
	_ core.Feature              = (*Component)(nil)
	_ core.UserRouter           = (*Component)(nil)
	_ core.AdminRouter          = (*Component)(nil)
	_ core.BootstrapContributor = (*Component)(nil)
	_ core.Starter              = (*Component)(nil)
	_ core.UsageObserver        = (*Component)(nil)
	_ core.TurnPrechecker       = (*Component)(nil)
	_ gatewayhook.RequestGuard  = (*Component)(nil)
)
