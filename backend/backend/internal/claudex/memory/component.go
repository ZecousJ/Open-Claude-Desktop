// Package memory is the R3 component: per-user memory for the desktop app's
// Chat and Cowork modes (round 2, owner decision R3). Memory text is sealed
// with core.SecretBox; administrators see metadata and can clear it, never
// read it.
//
// Conversations never reach the server: the desktop app searches past chats
// locally and builds the memory document itself (through the gateway with its
// device key), then stores it here so every device of the user shares it.
// Nothing is stored in plain text: without a fixed server key
// (TOTP_ENCRYPTION_KEY) writes answer CLAUDEX_MEMORY_ENCRYPTION_KEY_MISSING.
//
// The administrator's client policy ("memory": enabled, search_chats,
// generate, default_on, model) decides what users may turn on; when it turns
// memory off, stored memory is kept (users can still read and delete it,
// administrators can clear it) but nothing new is written.
//
// Routes (design R3 3.2-3.3):
//   - user: GET/DELETE /memory, PUT /memory/prefs, PUT/DELETE /memory/docs/:scope,
//     POST /memory/edits, DELETE /memory/edits/:id (memory text stays out of
//     the audit log, see routes.go; writes are limited to 120 per user and
//     hour);
//   - admin: GET /memory/stats, GET/DELETE /memory/users/:id (DELETE behind
//     step-up; no admin route returns memory text);
//   - bootstrap section "memory".
package memory

import (
	"context"
	"database/sql"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"

	"github.com/gin-gonic/gin"
)

// Component is the R3 component.
type Component struct {
	env    *core.Env
	store  store
	box    *core.SecretBox
	policy policyFunc
}

// New builds the component. Like every component it must not call its
// dependencies or env.Peers here (tests pass empty Deps).
func New(env *core.Env) *Component {
	c := &Component{env: env}
	var db *sql.DB
	if env != nil {
		db = env.DB
		c.box = core.NewSecretBox(env.Config)
	} else {
		c.box = core.NewSecretBox(nil)
	}
	c.store = &sqlStore{db: db}
	c.policy = c.policyFromComponents
	return c
}

// Name implements core.Feature.
func (c *Component) Name() string { return core.NameMemory }

// RegisterUserRoutes implements core.UserRouter.
func (c *Component) RegisterUserRoutes(g *gin.RouterGroup) {
	write := c.env.RateLimitPerUser("memory.write", writeLimit, time.Hour)
	g.GET("/memory", c.getMemory)
	g.DELETE("/memory", write, c.deleteAll)
	g.PUT("/memory/prefs", write, c.putPrefs)
	g.PUT("/memory/docs/:scope", write, c.putDoc)
	g.DELETE("/memory/docs/:scope", write, c.deleteDoc)
	g.POST("/memory/edits", write, c.postEdit)
	g.DELETE("/memory/edits/:id", write, c.deleteEdit)
}

// RegisterAdminRoutes implements core.AdminRouter. The routes sit behind the
// admin compliance gate; clearing a user's memory cannot be undone, so it
// needs step-up.
func (c *Component) RegisterAdminRoutes(g *gin.RouterGroup, stepUp gin.HandlerFunc) {
	g.GET("/memory/stats", c.adminStats)
	g.GET("/memory/users/:id", c.adminUser)
	if stepUp != nil {
		g.DELETE("/memory/users/:id", stepUp, c.adminClear)
	} else {
		g.DELETE("/memory/users/:id", c.adminClear)
	}
}

// Sections implements core.BootstrapContributor.
func (c *Component) Sections() []string { return []string{core.SectionMemory} }

// BootstrapSections implements core.BootstrapContributor:
//
//	"memory": {"available":true,"reason":null,
//	           "allowed":{"search_chats":true,"generate":true},
//	           "prefs":{"search_chats":false,"generate":false},"prefs_set":false,
//	           "effective":{"search_chats":false,"generate":false},
//	           "model":null,"revision_by_scope":{"global":3}}
//
// The desktop app learns the switches without another request and fetches
// the text with GET /memory only when a revision changed.
func (c *Component) BootstrapSections(ctx context.Context, bc *core.BootstrapContext) (map[string]any, error) {
	if bc == nil {
		return nil, errUnauthorized
	}
	st, err := c.status(ctx, bc.UserID, bc.Plan, bc.Platform)
	if err != nil {
		return nil, err
	}
	revisions, err := c.store.revisions(ctx, bc.UserID)
	if err != nil {
		return nil, err
	}
	return map[string]any{core.SectionMemory: BootstrapSection{Status: st, RevisionByScope: revisions}}, nil
}

// BootstrapSection is the bootstrap section "memory".
type BootstrapSection struct {
	Status
	RevisionByScope map[string]int64 `json:"revision_by_scope"`
}

var (
	_ core.Feature              = (*Component)(nil)
	_ core.UserRouter           = (*Component)(nil)
	_ core.AdminRouter          = (*Component)(nil)
	_ core.BootstrapContributor = (*Component)(nil)
)
