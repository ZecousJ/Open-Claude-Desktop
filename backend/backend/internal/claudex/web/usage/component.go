// Package usage is the web app's usage component (W-KEY, design W-SRV 6).
//
// The web runner calls models with the user's web key (a claudex_devices row
// with platform 'web', issued by the devices component: devices.WebKeys), so
// the upstream gateway bills those calls like any other request and the
// usage rules (B5) apply. This component adds what is specific to the web:
//
//   - usage links: the runner sends X-Claudex-Conversation (and
//     X-Claudex-Web-Session) with each model call; the KeyMarker (H5)
//     remembers them for web keys and the UsageObserver (H8) writes one
//     claudex_web_usage_links row per billed request;
//   - runner resources: every run records wall and CPU seconds in
//     claudex_web_runner_usage (recorded, never charged);
//   - capacity: Acquire hands out run slots under the limits of the
//     claudex_web_usage setting and refuses with CLAUDEX_WEB_CAPACITY;
//   - routes: the user's usage of one conversation, and the admin setting,
//     running slots, conversation list and runner summary.
//
// The web relay (W-RELAY) finds the component with From(env).
package usage

import (
	"context"
	"database/sql"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/gatewayhook"

	"github.com/gin-gonic/gin"
)

// Name is the component name (Feature.Name).
const Name = "web-usage"

const pruneInterval = 10 * time.Minute

// Component is the web usage component.
type Component struct {
	env     *core.Env
	setting *core.JSONSetting[Settings]
	tracker *tracker
	slots   *slotTable

	// db overrides env.DB (tests).
	db *sql.DB
}

// New builds the component. It must not call its dependencies.
func New(env *core.Env) *Component {
	if env == nil {
		env = &core.Env{}
	}
	return &Component{
		env: env,
		setting: core.NewJSONSetting(env.SettingRepo, SettingKey, defaultSettings,
			core.WithNormalize(normalizeSettings), core.WithValidate(validateSettings)),
		tracker: newTracker(),
		slots:   newSlotTable(),
	}
}

// From returns the installed web usage component, nil when there is none.
func From(env *core.Env) *Component {
	if env == nil {
		return nil
	}
	for _, f := range env.Components {
		if c, ok := f.(*Component); ok {
			return c
		}
	}
	return nil
}

// Name implements core.Feature.
func (c *Component) Name() string { return Name }

// SettingKeys implements core.SettingsOwner.
func (c *Component) SettingKeys() []string { return []string{c.setting.Key()} }

func (c *Component) now() time.Time {
	if c.env.Now != nil {
		return c.env.Now()
	}
	return time.Now()
}

// settings returns the cached setting (60 s per node).
func (c *Component) settings(ctx context.Context) Settings {
	return c.setting.Cached(ctx)
}

func (c *Component) sqlDB() *sql.DB {
	if c.db != nil {
		return c.db
	}
	return c.env.DB
}

// store returns the SQL store, nil without a database (unit tests).
func (c *Component) store() *sqlStore {
	db := c.sqlDB()
	if db == nil {
		return nil
	}
	return &sqlStore{db: db}
}

// RegisterUserRoutes implements core.UserRouter.
func (c *Component) RegisterUserRoutes(g *gin.RouterGroup) {
	g.GET("/web/usage/conversations/:id", c.userConversation)
}

// RegisterAdminRoutes implements core.AdminRouter; PUT needs step-up.
func (c *Component) RegisterAdminRoutes(g *gin.RouterGroup, stepUp gin.HandlerFunc) {
	g.GET("/web/usage/settings", c.adminGetSettings)
	if stepUp != nil {
		g.PUT("/web/usage/settings", stepUp, c.adminPutSettings)
	} else {
		g.PUT("/web/usage/settings", c.adminPutSettings)
	}
	g.GET("/web/usage/active", c.adminActive)
	g.GET("/web/usage/conversations", c.adminConversations)
	g.GET("/web/usage/runners", c.adminRunners)
}

// Start implements core.Starter: drops stale attributions.
func (c *Component) Start(ctx context.Context) {
	go func() {
		t := time.NewTicker(pruneInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				c.tracker.prune(c.now())
			}
		}
	}()
}

var (
	_ core.Feature          = (*Component)(nil)
	_ core.SettingsOwner    = (*Component)(nil)
	_ core.UserRouter       = (*Component)(nil)
	_ core.AdminRouter      = (*Component)(nil)
	_ core.Starter          = (*Component)(nil)
	_ core.UsageObserver    = (*Component)(nil)
	_ gatewayhook.KeyMarker = (*Component)(nil)
)
