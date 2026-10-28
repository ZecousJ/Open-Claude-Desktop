// Package policy is the B2 component: the client policy (design 1.6.1, 2.3).
//
// The administrator stores one document under the setting
// claudex_client_policy: defaults plus overrides per plan group and per user,
// with a revision number for optimistic concurrency. Each desktop client gets
// the policy resolved for its user, plan group and platform through
// GET /api/v1/claudex/policy (ETag) and the bootstrap section "policy".
// Administrators read and replace the document with GET/PUT
// /api/v1/admin/claudex/policy (PUT behind step-up; a stale revision answers
// 409) and try unsaved drafts with POST /api/v1/admin/claudex/policy/preview.
//
// Bypass permissions is not part of the policy anywhere (owner decision 3): it
// is always the user's own choice, so no field can name it and a mode list
// containing it is rejected.
package policy

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
)

const (
	fallbackTTL      = 60 * time.Second
	fallbackErrorTTL = 5 * time.Second
	fallbackTimeout  = 5 * time.Second
)

// swapFunc stores next if the stored text still equals expectedRaw.
type swapFunc func(ctx context.Context, expectedRaw string, next Document) (Document, bool, error)

// Component is the B2 component.
type Component struct {
	env     *core.Env
	setting *core.JSONSetting[Document]
	swap    swapFunc

	fbMu      sync.Mutex
	fbValue   Fallbacks
	fbExpires time.Time
}

// New builds the component. It must not call its dependencies or env.Peers:
// ProvideModule binds the peers after every component is built, and tests
// pass empty Deps.
func New(env *core.Env) *Component {
	if env == nil {
		env = &core.Env{}
	}
	c := &Component{env: env}
	c.setting = core.NewJSONSetting(env.SettingRepo, SettingKey, defaultDocument,
		core.WithNormalize(normalizeDocument), core.WithValidate(validateDocument))
	c.swap = func(ctx context.Context, expectedRaw string, next Document) (Document, bool, error) {
		return c.setting.SwapIfUnchanged(ctx, c.env.DB, expectedRaw, next)
	}
	return c
}

// Name implements core.Feature.
func (c *Component) Name() string { return core.NamePolicy }

// SettingKeys implements core.SettingsOwner.
func (c *Component) SettingKeys() []string { return []string{c.setting.Key()} }

// RegisterUserRoutes implements core.UserRouter.
func (c *Component) RegisterUserRoutes(g *gin.RouterGroup) {
	g.GET("/policy", c.getPolicy)
}

// RegisterAdminRoutes implements core.AdminRouter. The routes sit inside the
// upstream admin group (admin auth, audit log, AdminComplianceGuard); PUT is
// a high-risk write and also needs step-up.
func (c *Component) RegisterAdminRoutes(g *gin.RouterGroup, stepUp gin.HandlerFunc) {
	g.GET("/policy", c.adminGet)
	if stepUp != nil {
		g.PUT("/policy", stepUp, c.adminPut)
	} else {
		g.PUT("/policy", c.adminPut)
	}
	g.POST("/policy/preview", c.adminPreview)
}

// Sections implements core.BootstrapContributor.
func (c *Component) Sections() []string { return []string{core.SectionPolicy} }

// BootstrapSections implements core.BootstrapContributor: the same policy as
// GET /api/v1/claudex/policy for the plan group B9 resolved.
func (c *Component) BootstrapSections(ctx context.Context, bc *core.BootstrapContext) (map[string]any, error) {
	if bc == nil {
		return nil, errors.New("policy: no bootstrap context")
	}
	var groupID *int64
	if bc.Plan != nil {
		id := bc.Plan.GroupID
		groupID = &id
	} else {
		// B9 passes no plan both when the user has none and when resolving
		// it failed. Only the first gets the no-group policy; after a
		// failure the section is left out (like GET answers the error), so
		// the client keeps its cached policy instead of another group's.
		var err error
		if groupID, err = c.planGroup(ctx, bc.UserID, nil); err != nil {
			return nil, err
		}
	}
	doc := c.setting.Cached(ctx)
	return map[string]any{core.SectionPolicy: doc.Resolve(groupID, bc.UserID, bc.Platform, c.fallbacks(ctx))}, nil
}

// resolveForUser is the policy of GET /api/v1/claudex/policy: requested (the
// optional group_id) goes through the plan resolver, which ignores a group the
// user may not use. Without a plan only defaults and the user override apply.
func (c *Component) resolveForUser(ctx context.Context, doc *Document, userID int64, requested *int64, platform string) (Resolved, error) {
	groupID, err := c.planGroup(ctx, userID, requested)
	if err != nil {
		return Resolved{}, err
	}
	return doc.Resolve(groupID, userID, platform, c.fallbacks(ctx)), nil
}

func (c *Component) planGroup(ctx context.Context, userID int64, requested *int64) (*int64, error) {
	plans := c.env.Peers.Plans
	if plans == nil {
		return nil, nil
	}
	plan, err := plans.ResolvePlan(ctx, userID, requested)
	switch {
	case err == nil && plan != nil:
		id := plan.GroupID
		return &id, nil
	case err == nil || errors.Is(err, core.ErrNoPlan):
		return nil, nil
	default:
		// A lookup failure must not hand out another group's (or no group's)
		// policy: the client keeps its cached copy and retries.
		return nil, err
	}
}

func (c *Component) now() time.Time {
	if c.env.Now != nil {
		return c.env.Now()
	}
	return time.Now()
}

// fallbacks reads doc_url and the purchase-subscription settings, cached per
// process for 60 s like the policy itself (5 s after a database error, which
// keeps the last known values).
func (c *Component) fallbacks(ctx context.Context) Fallbacks {
	c.fbMu.Lock()
	defer c.fbMu.Unlock()
	now := c.now()
	if now.Before(c.fbExpires) {
		return c.fbValue
	}
	if ctx == nil {
		ctx = context.Background()
	}
	dbCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), fallbackTimeout)
	defer cancel()
	v, err := c.loadFallbacks(dbCtx)
	if err != nil {
		slog.Warn("claudex: reading policy link fallbacks failed, serving last known values", "error", err)
		c.fbExpires = now.Add(fallbackErrorTTL)
		return c.fbValue
	}
	c.fbValue, c.fbExpires = v, now.Add(fallbackTTL)
	return v
}

func (c *Component) loadFallbacks(ctx context.Context) (Fallbacks, error) {
	var fb Fallbacks
	repo := c.env.SettingRepo
	if repo == nil {
		return fb, nil
	}
	values, err := repo.GetMultiple(ctx, []string{
		service.SettingKeyDocURL,
		service.SettingKeyPurchaseSubscriptionEnabled,
		service.SettingKeyPurchaseSubscriptionURL,
	})
	if err != nil {
		return fb, err
	}
	if u, err := core.HTTPSURL(values[service.SettingKeyDocURL], maxURLBytes); err == nil {
		fb.DocURL = &u
	}
	if values[service.SettingKeyPurchaseSubscriptionEnabled] == "true" {
		if u, err := core.HTTPSURL(values[service.SettingKeyPurchaseSubscriptionURL], maxURLBytes); err == nil {
			fb.PurchaseSubscriptionURL = &u
		}
	}
	return fb, nil
}

var (
	_ core.Feature              = (*Component)(nil)
	_ core.SettingsOwner        = (*Component)(nil)
	_ core.UserRouter           = (*Component)(nil)
	_ core.AdminRouter          = (*Component)(nil)
	_ core.BootstrapContributor = (*Component)(nil)
)
