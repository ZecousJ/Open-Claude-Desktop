// Package status is the service status component: the apps' Service status
// page and the incidents an administrator handles.
//
// The page lists Sub2API's channels (the channel monitors, by their names)
// with the models they check, each with its uptime and a bar a day, and the incidents that are open or were resolved
// in the window. Sub2API keeps its check history for 30 days; this
// component counts each channel's checks per day into claudex_status_days
// every few minutes and keeps them for longer.
//
// An incident is opened by an administrator in the console, or as a draft on
// its own when a channel fails twice in a row; people see an
// incident only once it is published. Its handling status (investigating,
// identified, monitoring, resolved) and a message are changed in the
// console; every change is kept as an update. An incident opened on its own
// is resolved on its own once the channels work again, unless an
// administrator has posted an update to it.
//
// It also runs the IQ check every hour (iq.go): a model's SVG page of a
// pelican riding a bicycle, shown as cards.
//
// Routes:
//   - user:  GET /api/v1/claudex/status
//   - admin: GET /api/v1/admin/claudex/status, POST /status/incidents,
//     PATCH /status/incidents/:id, DELETE /status/incidents/:id
package status

import (
	"context"
	"database/sql"
	"log/slog"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"

	"github.com/gin-gonic/gin"
)

const (
	firstRun       = 20 * time.Second
	refreshEvery   = 5 * time.Minute
	refreshTimeout = 2 * time.Minute
	// backfillDays: on start, days Sub2API still has are counted once.
	backfillDays = 35
)

// Component is the service status component.
type Component struct {
	env   *core.Env
	store store
	loc   *time.Location
	// clock replaces the time in tests.
	clock func() time.Time
}

// New builds the component. It must not call its dependencies here.
func New(env *core.Env) *Component {
	var db *sql.DB
	if env != nil {
		db = env.DB
	}
	loc, err := time.LoadLocation(Timezone)
	if err != nil {
		loc = time.UTC
	}
	return &Component{env: env, store: &sqlStore{db: db}, loc: loc}
}

// Name implements core.Feature.
func (c *Component) Name() string { return core.NameServiceStatus }

func (c *Component) now() time.Time {
	if c.clock != nil {
		return c.clock()
	}
	if c.env != nil && c.env.Now != nil {
		return c.env.Now()
	}
	return time.Now()
}

func (c *Component) hasDB() bool {
	s, ok := c.store.(*sqlStore)
	return !ok || s.db != nil
}

// RegisterUserRoutes implements core.UserRouter.
func (c *Component) RegisterUserRoutes(g *gin.RouterGroup) {
	g.GET("/status", c.getStatus)
}

// RegisterAdminRoutes implements core.AdminRouter.
func (c *Component) RegisterAdminRoutes(g *gin.RouterGroup, _ gin.HandlerFunc) {
	g.GET("/status", c.adminStatus)
	g.POST("/status/incidents", c.adminCreate)
	g.PATCH("/status/incidents/:id", c.adminUpdate)
	g.DELETE("/status/incidents/:id", c.adminDelete)
}

// Start implements core.Starter: counts the days and opens or resolves
// incidents every few minutes.
func (c *Component) Start(ctx context.Context) {
	if c.env == nil || c.env.DB == nil {
		return
	}
	go c.loop(ctx)
	go c.iqLoop(ctx)
}

func (c *Component) loop(ctx context.Context) {
	timer := time.NewTimer(firstRun)
	defer timer.Stop()
	first := true
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		run, cancel := context.WithTimeout(ctx, refreshTimeout)
		if err := c.Refresh(run, first); err != nil {
			slog.Warn("claudex status: refresh failed", "error", err)
		} else {
			first = false
		}
		if err := c.SyncIncidents(run); err != nil {
			slog.Warn("claudex status: incidents failed", "error", err)
		}
		cancel()
		timer.Reset(refreshEvery)
	}
}

// Refresh recounts yesterday and today; the first time it also fills the
// older days Sub2API still has, and drops days past keeping.
func (c *Component) Refresh(ctx context.Context, backfill bool) error {
	now := c.now().In(c.loc)
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, c.loc)
	if backfill {
		if err := c.store.refresh(ctx, today.AddDate(0, 0, -backfillDays), Timezone, true); err != nil {
			return err
		}
		if err := c.store.prune(ctx, today.AddDate(0, 0, -keepDays)); err != nil {
			return err
		}
	}
	return c.store.refresh(ctx, today.AddDate(0, 0, -1), Timezone, false)
}

// action is what SyncIncidents does for one provider.
type action struct {
	platform string
	open     bool // open an incident with impact
	impact   string
	resolve  int64 // resolve this incident
}

// decide opens an incident for a channel whose model failed twice in a row
// when none is open for it, and resolves the ones it opened itself once
// every model of the channel passed its last two checks, unless an
// administrator has changed them.
func decide(channels []Channel, latest map[key][]string, open []Incident) []action {
	type state struct{ total, down, healthy int }
	byPlatform := map[string]*state{}
	var order []string
	for _, ch := range channels {
		s := byPlatform[ch.Name]
		if s == nil {
			s = &state{}
			byPlatform[ch.Name] = s
			order = append(order, ch.Name)
		}
		s.total++
		checks := latest[key{ch.ID, ch.Model}]
		switch {
		case currentLevel(checks) == LevelOutage:
			s.down++
		case len(checks) >= 2 && !failing(checks[0]) && !failing(checks[1]):
			s.healthy++
		}
	}
	var out []action
	for _, p := range order {
		s := byPlatform[p]
		var mine *Incident
		covered := false
		for i := range open {
			if open[i].Platform == p || open[i].Platform == "" {
				covered = true
				if open[i].Auto && open[i].Platform == p && mine == nil {
					mine = &open[i]
				}
			}
		}
		switch {
		case s.down > 0 && !covered:
			impact := ImpactDegraded
			if s.down == s.total {
				impact = ImpactOutage
			}
			out = append(out, action{platform: p, open: true, impact: impact})
		case s.healthy == s.total && mine != nil && !mine.touched:
			out = append(out, action{platform: p, resolve: mine.ID})
		}
	}
	return out
}

func failing(s string) bool { return s == checkFailed || s == checkError }

// SyncIncidents opens and resolves the incidents the channels call for.
func (c *Component) SyncIncidents(ctx context.Context) error {
	now := c.now()
	channels, err := c.store.channels(ctx, now.AddDate(0, 0, -1))
	if err != nil {
		return err
	}
	latest, err := c.store.latest(ctx, now.Add(-24*time.Hour))
	if err != nil {
		return err
	}
	all, err := c.store.incidents(ctx, now, 200, false)
	if err != nil {
		return err
	}
	var open []Incident
	for _, in := range all {
		if in.ResolvedAt == nil {
			open = append(open, in)
		}
	}
	draft := false
	for _, a := range decide(channels, latest, open) {
		name := a.platform
		if a.open {
			_, err = c.store.create(ctx, IncidentInput{
				Title:    "Elevated errors on " + name,
				Platform: a.platform,
				Impact:   a.impact,
				Status:   StatusInvestigating,
				Message:  "We’re seeing errors on " + name + " and are looking into it.",
				// A draft: people see it once an administrator publishes it.
				Published: &draft,
			}, true, 0, now)
		} else {
			_, err = c.store.update(ctx, a.resolve, IncidentInput{
				Platform: "-",
				Status:   StatusResolved,
				Message:  "The channels are working normally again.",
			}, 0, now)
		}
		if err != nil {
			return err
		}
		slog.Info("claudex status: incident", "platform", a.platform, "opened", a.open, "resolved", a.resolve)
	}
	return nil
}

var (
	_ core.Feature     = (*Component)(nil)
	_ core.UserRouter  = (*Component)(nil)
	_ core.AdminRouter = (*Component)(nil)
	_ core.Starter     = (*Component)(nil)
)
