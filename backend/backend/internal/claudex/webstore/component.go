// Package webstore keeps the web app's account data (W-STORE, web plan §0.3
// and §2 #1): settings, projects, conversations (one row each), turns (one
// JSONB row each, live transcript and saved branches), artifacts with their
// last versions, and files (bytes on disk) under a per-user quota.
//
// The runner that serves a user is the only writer: its CloudStore sends
// store.* requests over the runner link, and the relay (W-RELAY,
// internal/claudex/webhost) hands them to ServeRunnerOp after checking the
// user is routed to that runner. Browser uploads come in through the relay's
// chunked uploads route (BeginUpload, WriteUpload). The browser itself only
// reads: a file download and the account export (RegisterUserRoutes).
//
// Tenant isolation: every query is scoped by the user id (see store.go);
// another user's rows are indistinguishable from missing ones.
package webstore

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"

	"github.com/gin-gonic/gin"
)

// Component is the web-store component.
type Component struct {
	env   *core.Env
	store *store
	blobs blobs
	quota *core.JSONSetting[quotaView]
	// limits replaces the setting in tests.
	limits func(context.Context) Limits

	cleanupOnce sync.Once
}

// New builds the component. Like every component it must not call its
// dependencies here (tests pass empty Deps).
func New(env *core.Env) *Component {
	var db *sql.DB
	if env != nil {
		db = env.DB
	}
	return &Component{
		env:   env,
		store: &store{db: db},
		blobs: blobs{root: defaultDir()},
		quota: newQuotaSetting(env),
	}
}

// Name implements core.Feature.
func (c *Component) Name() string { return core.NameWebStore }

var (
	_ core.Feature    = (*Component)(nil)
	_ core.UserRouter = (*Component)(nil)
	_ core.Starter    = (*Component)(nil)
)

// Download routes (under /api/v1/claudex, JWT): read only, the signed-in
// user's own data.
const (
	RouteFileDownload = "/web/downloads/files/:id"
	RouteExport       = "/web/downloads/export"
)

// RegisterUserRoutes implements core.UserRouter.
func (c *Component) RegisterUserRoutes(g *gin.RouterGroup) {
	g.GET(RouteFileDownload, c.downloadFile)
	g.GET(RouteExport, c.heavy(), c.export)
}

func (c *Component) heavy() gin.HandlerFunc {
	if c.env == nil {
		return func(g *gin.Context) { g.Next() }
	}
	return c.env.Heavy()
}

// Start implements core.Starter: the hourly cleanup (abandoned uploads,
// data of deleted accounts, unreferenced blobs).
func (c *Component) Start(ctx context.Context) {
	if c.env == nil || c.env.DB == nil {
		return
	}
	c.cleanupOnce.Do(func() { go c.cleanupLoop(ctx) })
}

func (c *Component) now() time.Time {
	if c.env != nil && c.env.Now != nil {
		return c.env.Now().UTC()
	}
	return time.Now().UTC()
}

func (c *Component) logf(format string, args ...any) {
	slog.Warn(fmt.Sprintf(format, args...))
}
