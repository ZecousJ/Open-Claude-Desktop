// Package catalog is the B3 component: the model display catalog (table
// claudex_model_meta, GET /api/v1/claudex/models, admin CRUD and candidates,
// bootstrap section "models"), design 2.4.
//
// The catalog only describes how the desktop client shows a model (name,
// description, badges, order, More models, default model, efforts, context
// window, auto-compact threshold, usage hint). Which models a device can use
// stays with the gateway /v1/models list: the client intersects the two.
//
// Fast mode was dropped (R6): the fast_tier column stays (migrations only move
// forward) and the admin API still accepts it, but the console no longer
// offers it and no client reads it.
//
// The same component owns reviewed plugin/connector directory submissions
// (claudex_0013); approved, non-withdrawn entries feed Customize directly.
package catalog

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
)

// cacheTTL is how long a resolved catalog is reused (design 2.4: per group,
// 60 s; writes on this node clear it at once).
const cacheTTL = 60 * time.Second

// groupReader is the part of service.GroupRepository the catalog reads
// (upstream groups are soft-deleted: a deleted group is ErrGroupNotFound).
type groupReader interface {
	GetByIDLite(ctx context.Context, id int64) (*service.Group, error)
	ListActive(ctx context.Context) ([]service.Group, error)
}

// channelReader is the part of *service.ChannelService the candidates read.
type channelReader interface {
	GetChannelForGroup(ctx context.Context, groupID int64) (*service.Channel, error)
}

// Component is the B3 component.
type Component struct {
	env      *core.Env
	store    metaStore
	groups   func() groupReader
	channels func() channelReader
	// lister answers the models a group's key gets (the gateway); nil in
	// tests, where a group lists its described models.
	lister func() modelLister
	cache  *catalogCache
}

// New builds the component. It must not call its dependencies or env.Peers:
// ProvideModule binds the peers after every component is built, and tests
// pass empty Deps.
func New(env *core.Env) *Component {
	if env == nil {
		env = &core.Env{}
	}
	c := newComponent(env,
		sqlStore{db: func() *sql.DB { return env.DB }},
		func() groupReader {
			if env.GroupRepo == nil {
				return nil
			}
			return env.GroupRepo
		},
		func() channelReader {
			if env.Channels == nil {
				return nil
			}
			return env.Channels
		})
	c.lister = func() modelLister {
		if env.Gateway == nil {
			return nil
		}
		return env.Gateway
	}
	return c
}

func newComponent(env *core.Env, store metaStore, groups func() groupReader, channels func() channelReader) *Component {
	clock := func() time.Time {
		if env.Now != nil { // read at call time: tests replace the clock after New
			return env.Now()
		}
		return time.Now()
	}
	return &Component{
		env:      env,
		store:    store,
		groups:   groups,
		channels: channels,
		cache:    newCatalogCache(clock, cacheTTL),
	}
}

// Name implements core.Feature.
func (c *Component) Name() string { return core.NameCatalog }

// RegisterUserRoutes implements core.UserRouter:
// GET /api/v1/claudex/models?group_id= (ETag).
func (c *Component) RegisterUserRoutes(g *gin.RouterGroup) {
	g.GET("/models", c.getModels)
	c.registerDirectoryRoutes(g)
}

// RegisterAdminRoutes implements core.AdminRouter (/api/v1/admin/claudex,
// behind the admin compliance gate). The writes go through step-up (R13): the
// catalog decides which model every desktop app offers by default.
func (c *Component) RegisterAdminRoutes(g *gin.RouterGroup, stepUp gin.HandlerFunc) {
	if stepUp == nil {
		stepUp = func(g *gin.Context) { g.Next() }
	}
	c.registerDirectoryAdminRoutes(g, stepUp)
	g.GET("/models", c.adminList)
	g.POST("/models", stepUp, c.adminCreate)
	g.GET("/models/candidates", c.adminCandidates)
	g.GET("/models/groups", c.adminGroups)
	g.PUT("/models/groups/:id/placements", stepUp, c.adminSetPlacements)
	g.PUT("/models/:id", stepUp, c.adminUpdate)
	g.DELETE("/models/:id", stepUp, c.adminDelete)
}

// Sections implements core.BootstrapContributor.
func (c *Component) Sections() []string { return []string{core.SectionModels} }

// BootstrapSections implements core.BootstrapContributor: the same catalog
// as GET /claudex/models for the plan B9 resolved (global rows only when the
// user has no plan).
func (c *Component) BootstrapSections(ctx context.Context, bc *core.BootstrapContext) (map[string]any, error) {
	if bc == nil || bc.Plan == nil {
		cat, err := c.catalogFor(ctx, 0)
		if err != nil {
			return nil, err
		}
		return map[string]any{core.SectionModels: cat}, nil
	}
	cat, err := c.deviceCatalog(ctx, bc.UserID, bc.Plan)
	if err != nil {
		return nil, err
	}
	return map[string]any{core.SectionModels: cat}, nil
}

// KeyGroupSource lists the groups whose device keys a user's devices hold,
// the plan group first (the devices component implements it, MG).
type KeyGroupSource interface {
	KeyGroupIDs(ctx context.Context, userID int64, plan *core.PlanRef) ([]int64, error)
}

func (c *Component) keyGroupSource() KeyGroupSource {
	if c.env == nil {
		return nil
	}
	for _, f := range c.env.Components {
		if s, ok := f.(KeyGroupSource); ok {
			return s
		}
	}
	return nil
}

// deviceCatalog is the catalog of every group a device of the user holds a
// key for, merged (Merge); only the plan group's without a key group source.
func (c *Component) deviceCatalog(ctx context.Context, userID int64, plan *core.PlanRef) (*Catalog, error) {
	ids := []int64{plan.GroupID}
	if src := c.keyGroupSource(); src != nil {
		more, err := src.KeyGroupIDs(ctx, userID, plan)
		if err != nil {
			return nil, err
		}
		if len(more) > 0 {
			ids = more
		}
	}
	if len(ids) == 1 {
		return c.catalogFor(ctx, ids[0])
	}
	cats := make([]*Catalog, 0, len(ids))
	for _, id := range ids {
		cat, err := c.catalogFor(ctx, id)
		if err != nil {
			return nil, err
		}
		if cat.GroupID == nil {
			continue // deleted meanwhile: only the global rows would remain
		}
		cats = append(cats, cat)
	}
	if len(cats) == 0 {
		return c.catalogFor(ctx, plan.GroupID)
	}
	merged := Merge(cats...)
	return &merged, nil
}

// catalogForUser resolves the plan group of a user (a requested group the
// user cannot use is ignored by the resolver) and returns its catalog. A user
// without a plan gets the global rows.
//
// Without a requested group the answer is the device catalog (MG): the models
// of every group the user's devices hold a key for, like bootstrap "models".
func (c *Component) catalogForUser(ctx context.Context, userID int64, requested *int64) (*Catalog, error) {
	var groupID int64
	if plans := c.env.Peers.Plans; plans != nil {
		plan, err := plans.ResolvePlan(ctx, userID, requested)
		switch {
		case err == nil && plan != nil:
			if requested == nil {
				return c.deviceCatalog(ctx, userID, plan)
			}
			groupID = plan.GroupID
		case err == nil, errors.Is(err, core.ErrNoPlan):
		default:
			return nil, err
		}
	}
	return c.catalogFor(ctx, groupID)
}

// catalogFor returns the resolved catalog of a group (0 = global rows only),
// cached for 60 s.
func (c *Component) catalogFor(ctx context.Context, groupID int64) (*Catalog, error) {
	if groupID < 0 {
		groupID = 0
	}
	if cat, ok := c.cache.get(groupID); ok {
		return cat, nil
	}
	gen := c.cache.generation()
	scope, maxEffort, platform := groupID, "", ""
	var group *service.Group
	if groupID > 0 {
		groups := c.groupReader()
		if groups == nil {
			return nil, errNoGroups
		}
		grp, err := groups.GetByIDLite(ctx, groupID)
		switch {
		case errors.Is(err, service.ErrGroupNotFound):
			scope = 0 // deleted meanwhile: its rows no longer count
		case err != nil:
			return nil, err
		case grp == nil:
			scope = 0
		default:
			maxEffort, platform, group = grp.MaxReasoningEffort, grp.Platform, grp
		}
	}
	rows, err := c.store.Scope(ctx, scope)
	if err != nil {
		return nil, err
	}
	var cat Catalog
	if group != nil {
		places, err := c.placementsOf(ctx, scope)
		if err != nil {
			return nil, err
		}
		cat = ResolveGroup(rows, places, c.listedModels(ctx, group), scope, maxEffort, platform)
	} else {
		cat = ResolveFor(rows, scope, maxEffort, platform)
	}
	c.cache.put(groupID, &cat, gen)
	return &cat, nil
}

// placementsOf reads a group's placements (none without a placement store).
func (c *Component) placementsOf(ctx context.Context, groupID int64) ([]Placement, error) {
	places, ok := c.store.(placementStore)
	if !ok {
		return nil, nil
	}
	return places.Placements(ctx, groupID)
}

// listedModels is what /v1/models lists for a key of the group; nil when the
// gateway is not wired (the described models stand in).
func (c *Component) listedModels(ctx context.Context, group *service.Group) []string {
	if c.lister == nil {
		return nil
	}
	lister := c.lister()
	if lister == nil {
		return nil
	}
	return lister.ListedModelIDs(ctx, group)
}

var errNoGroups = errors.New("claudex catalog: group repository is not configured")

func (c *Component) groupReader() groupReader {
	if c.groups == nil {
		return nil
	}
	return c.groups()
}

func (c *Component) channelReader() channelReader {
	if c.channels == nil {
		return nil
	}
	return c.channels()
}

var (
	_ core.Feature              = (*Component)(nil)
	_ core.UserRouter           = (*Component)(nil)
	_ core.AdminRouter          = (*Component)(nil)
	_ core.BootstrapContributor = (*Component)(nil)
	_ groupReader               = service.GroupRepository(nil)
	_ channelReader             = (*service.ChannelService)(nil)
)
