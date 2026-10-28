// Package onboarding keeps the first-run onboarding of the Claudex apps: the
// questions a new account answers once after sign-up (live claude.ai bundle,
// 2026-10-12, the onboarding route c10bf8b47: "What kind of work do you do?",
// "Set up and start coding", "Connect your work tools", "How did you get
// here?", the first task).
//
// The sign-up hook writes a pending row for every self-registered account;
// the apps show the onboarding while it is pending, save each answer as it is
// given and finish it at the end, after which it is never shown again, on any
// device. Accounts made before this component have no row and are never asked.
// The work type is also the Settings work type: the apps write it here when it
// changes there, so the console shows the current one.
//
// Routes:
//   - user:  GET /api/v1/claudex/onboarding, PUT /api/v1/claudex/onboarding
//   - admin: GET /api/v1/admin/claudex/onboarding/users/:id
package onboarding

import (
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"

	"github.com/gin-gonic/gin"
)

// Name is the component's name (core.Feature).
const Name = "onboarding"

// Component is the first-run onboarding component.
type Component struct {
	env   *core.Env
	store store
}

// New builds the component. It must not call its dependencies here (tests
// pass empty Deps).
func New(env *core.Env) *Component {
	var db *sql.DB
	if env != nil {
		db = env.DB
	}
	return &Component{env: env, store: &sqlStore{db: db}}
}

// Name implements core.Feature.
func (c *Component) Name() string { return Name }

func (c *Component) now() time.Time {
	if c.env != nil && c.env.Now != nil {
		return c.env.Now()
	}
	return time.Now()
}

func (c *Component) hasDB() bool {
	s, ok := c.store.(*sqlStore)
	return !ok || s.db != nil
}

// OnSignup implements core.SignupHooker: a new account is asked once.
func (c *Component) OnSignup(ctx context.Context, userID int64) error {
	if !c.hasDB() || userID <= 0 {
		return nil
	}
	return c.store.start(ctx, userID, c.now())
}

// RegisterUserRoutes implements core.UserRouter.
func (c *Component) RegisterUserRoutes(g *gin.RouterGroup) {
	g.GET("/onboarding", c.getMine)
	g.PUT("/onboarding", c.putMine)
}

// RegisterAdminRoutes implements core.AdminRouter (read only).
func (c *Component) RegisterAdminRoutes(g *gin.RouterGroup, _ gin.HandlerFunc) {
	g.GET("/onboarding/users/:id", c.adminGet)
}

func unauthorized(g *gin.Context) {
	response.ErrorFrom(g, infraerrors.Unauthorized("UNAUTHORIZED", "Sign in first."))
}

// GET /api/v1/claudex/onboarding
func (c *Component) getMine(g *gin.Context) {
	userID, ok := core.Subject(g)
	if !ok {
		unauthorized(g)
		return
	}
	g.Header("Cache-Control", "no-store")
	if !c.hasDB() {
		// Nothing to show: the apps skip the onboarding.
		response.Success(g, (*row)(nil).user())
		return
	}
	r, err := c.store.get(g.Request.Context(), userID)
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	response.Success(g, r.user())
}

// PUT /api/v1/claudex/onboarding {work_function?, hear_about?, …, finished?}
func (c *Component) putMine(g *gin.Context) {
	userID, ok := core.Subject(g)
	if !ok {
		unauthorized(g)
		return
	}
	if !c.hasDB() {
		response.ErrorFrom(g, errUnavailable)
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(g.Writer, g.Request.Body, requestBodyMax))
	if err != nil {
		response.ErrorFrom(g, invalid("body", "The request is too large."))
		return
	}
	var p patch
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &p); err != nil {
			response.ErrorFrom(g, invalid("body", "The request must be a JSON object."))
			return
		}
	}
	ctx := g.Request.Context()
	current, err := c.store.get(ctx, userID)
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	answers := Answers{}
	if current != nil {
		answers = current.Answers
	}
	if err := p.apply(&answers); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	saved, err := c.store.save(ctx, userID, answers, p.Finished, c.now())
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	g.Header("Cache-Control", "no-store")
	response.Success(g, saved.user())
}

// GET /api/v1/admin/claudex/onboarding/users/:id
func (c *Component) adminGet(g *gin.Context) {
	id, err := strconv.ParseInt(g.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		response.ErrorFrom(g, invalid("id", "That isn't a user id."))
		return
	}
	if !c.hasDB() {
		response.ErrorFrom(g, errUnavailable)
		return
	}
	r, err := c.store.get(g.Request.Context(), id)
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	response.Success(g, r.admin())
}
