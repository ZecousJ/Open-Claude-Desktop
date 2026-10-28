// Package bootstrap is the B9 component: GET /api/v1/claudex/bootstrap, one
// read that gives the desktop client everything it needs after sign-in
// (design 2.10).
//
// The handler resolves the user's plan (core.Peers.Plans), then calls every
// core.BootstrapContributor in parallel, each with its own 2 s budget, and
// merges the sections they return. A contributor that fails, panics or runs
// out of time loses its sections, which are listed in "errors" instead; the
// other sections are unaffected. B9 adds its own keys: schema_version,
// generated_at, server, features and errors. The response carries an ETag
// that ignores generated_at, so an unchanged bootstrap answers 304.
package bootstrap

import (
	"context"
	"strconv"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"

	"github.com/gin-gonic/gin"
)

// SchemaVersion is the bootstrap document version (data.schema_version).
// Bump it only for a change a released desktop client cannot read.
const SchemaVersion = 1

// SectionTimeout is the budget of the plan resolution and of each
// contributor (design 2.10).
const SectionTimeout = 2 * time.Second

// Keys B9 writes itself (design 1.5); contributors can never return them.
const (
	KeySchemaVersion = "schema_version"
	KeyGeneratedAt   = "generated_at"
	KeyServer        = "server"
	KeyFeatures      = "features"
	KeyErrors        = "errors"
)

// Component is the B9 bootstrap component.
type Component struct {
	env *core.Env
	// provisioning is a read-only view of the B4 setting claudex_provisioning
	// (features.device_keys follows its "enabled" switch). B4 owns and writes
	// the key; B9 never stores it.
	provisioning *core.JSONSetting[provisioningView]
	timeout      time.Duration
}

// New builds the component. It must not call its dependencies or env.Peers:
// ProvideModule binds the peers after every component is built, and tests
// pass empty Deps.
func New(env *core.Env) *Component {
	if env == nil {
		env = &core.Env{Now: time.Now}
	}
	return &Component{
		env:          env,
		provisioning: core.NewJSONSetting(env.SettingRepo, provisioningKey, defaultProvisioningView),
		timeout:      SectionTimeout,
	}
}

// Name implements core.Feature.
func (c *Component) Name() string { return core.NameBootstrap }

// RegisterUserRoutes implements core.UserRouter: GET /api/v1/claudex/bootstrap
// behind the user chain (JWT with the H9b revocation check, backend-mode
// guard, panel rate limit, X-Claudex-* validation, audit) plus the upstream
// "heavy" per-user limiter.
func (c *Component) RegisterUserRoutes(g *gin.RouterGroup) {
	g.GET("/bootstrap", c.env.Heavy(), c.get)
}

// GET /api/v1/claudex/bootstrap?group_id=
func (c *Component) get(g *gin.Context) {
	userID, ok := core.Subject(g)
	if !ok {
		response.Unauthorized(g, "User not authenticated")
		return
	}
	platform, arch, version, deviceID := core.ClientInfo(g)
	bc := &core.BootstrapContext{
		UserID:     userID,
		Platform:   platform,
		Arch:       arch,
		AppVersion: version,
		Client:     core.ClientKind(g),
		DeviceID:   deviceID,
		SessionID:  core.SessionID(g),
	}
	data := c.build(g.Request.Context(), bc, requestedGroup(g.Query("group_id")))
	core.WriteJSONWithETag(g, data, KeyGeneratedAt)
}

// requestedGroup parses the optional ?group_id=. Like a group the user may
// not use, a malformed value is only a hint the plan resolver ignores, so it
// is treated as absent rather than refused.
func requestedGroup(raw string) *int64 {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || id <= 0 {
		return nil
	}
	return &id
}

// build assembles the bootstrap document for bc (UserID and the client
// fields set; Plan is resolved here). It never fails: every problem ends up
// in the errors list.
func (c *Component) build(ctx context.Context, bc *core.BootstrapContext, requestedGroupID *int64) map[string]any {
	now := time.Now
	if c.env.Now != nil {
		now = c.env.Now
	}
	generatedAt := now().UTC().Format(time.RFC3339)

	// The server info and the feature switches read upstream settings; do it
	// while the plan resolves and the contributors run (readLocal returns
	// within the section budget).
	local := make(chan localInfo, 1)
	go func() { local <- c.readLocal(ctx) }()

	plan, planErr := c.resolvePlan(ctx, bc.UserID, requestedGroupID)
	bc.Plan = plan
	bc.NoPlan = planErr != nil && sectionCode(planErr) == core.ErrNoPlan.Reason

	sections, failures := c.collect(ctx, bc)
	if planErr != nil {
		if _, present := sections[core.SectionPlan]; !present {
			// The resolver's reason (e.g. CLAUDEX_NO_PLAN) says more than a
			// contributor failure that followed from it.
			failures[core.SectionPlan] = sectionCode(planErr)
		}
	}

	info := <-local
	data := map[string]any{
		KeySchemaVersion: SchemaVersion,
		KeyGeneratedAt:   generatedAt,
		KeyServer:        info.server,
		KeyFeatures:      c.features(info, sections),
		KeyErrors:        sortedFailures(failures),
	}
	for name, raw := range sections {
		data[name] = raw
	}
	return data
}

var (
	_ core.Feature    = (*Component)(nil)
	_ core.UserRouter = (*Component)(nil)
)
