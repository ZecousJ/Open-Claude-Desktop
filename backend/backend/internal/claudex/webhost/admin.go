package webhost

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"

	"github.com/gin-gonic/gin"
)

// Admin routes (the console's Runners page, W-ADMIN1), under
// /api/v1/admin/claudex (admin auth, compliance guard, audit log):
//
//	GET    /web/runners              stored runners, the local runner, link state
//	POST   /web/runners {name}       new runner token (shown once)       step-up
//	PATCH  /web/runners/:id {name?, disabled?}  rename, switch off or on   step-up
//	DELETE /web/runners/:id          revoke a token, close its link      step-up
//	POST   /web/runners/:id/drain    finish current work, take no users  step-up

// RunnerStatus is one row of the Runners page.
type RunnerStatus struct {
	ID          string            `json:"id"`
	RecordID    int64             `json:"record_id,omitempty"`
	Name        string            `json:"name"`
	Local       bool              `json:"local"`
	Connected   bool              `json:"connected"`
	Draining    bool              `json:"draining"`
	Disabled    bool              `json:"disabled"`
	Version     string            `json:"version"`
	Methods     int               `json:"methods"`
	Capacity    webproto.Capacity `json:"capacity"`
	Load        *linkLoad         `json:"load"`
	Users       int               `json:"assigned_users"`
	ConnectedAt *time.Time        `json:"connected_at"`
	CreatedAt   *time.Time        `json:"created_at"`
	RevokedAt   *time.Time        `json:"revoked_at"`
	DisabledAt  *time.Time        `json:"disabled_at"`
	LastSeenAt  *time.Time        `json:"last_seen_at"`
	Labels      map[string]string `json:"labels"`
}

// RunnersView answers GET /web/runners.
type RunnersView struct {
	Items             []RunnerStatus `json:"items"`
	LocalTokenSet     bool           `json:"local_token_configured"`
	ActiveRuns        int            `json:"active_runs"`
	DroppedFrames     int64          `json:"dropped_frames"`
	UsersWithOpenTabs int            `json:"users_with_open_tabs"`
}

// CreatedRunner answers POST /web/runners: the token appears only here.
type CreatedRunner struct {
	Runner RunnerRecord `json:"runner"`
	Token  string       `json:"token"`
}

var (
	errRunnerName     = infraerrors.BadRequest("CLAUDEX_WEB_RUNNER_INVALID", "Give the runner a name of 1 to 100 characters.")
	errRunnerUpdate   = infraerrors.BadRequest("CLAUDEX_WEB_RUNNER_INVALID", "Send a name, disabled, or both.")
	errRunnerNotFound = infraerrors.NotFound("CLAUDEX_WEB_RUNNER_NOT_FOUND", "Runner not found.")
	errRunnerStore    = infraerrors.ServiceUnavailable("CLAUDEX_WEB_RUNNERS_UNAVAILABLE", "Service temporarily unavailable. Try again.")
)

func (c *Component) statusOf(rc *runnerConn, users map[string]int) RunnerStatus {
	rc.mu.Lock()
	load := rc.load
	draining := rc.draining
	rc.mu.Unlock()
	at := rc.connectedAt
	s := RunnerStatus{
		ID: rc.id, RecordID: rc.record, Name: rc.name, Local: rc.id == LocalRunnerID, Connected: !rc.closed(),
		Draining: draining, Version: rc.version, Methods: len(rc.methods), Capacity: rc.capacity,
		Users: users[rc.id], ConnectedAt: &at, Labels: rc.labels,
	}
	if !load.At.IsZero() {
		s.Load = &load
	}
	return s
}

// GET /web/runners
func (c *Component) adminList(g *gin.Context) {
	b := c.backends()
	recs, err := b.Runners.List(g.Request.Context())
	if err != nil {
		response.ErrorFrom(g, errRunnerStore)
		return
	}
	users := c.reg.usersOf()
	connected := map[string]*runnerConn{}
	for _, rc := range c.reg.all() {
		connected[rc.id] = rc
	}
	out := RunnersView{Items: []RunnerStatus{}, LocalTokenSet: b.LocalRunnerToken != "", ActiveRuns: c.runs.active(),
		DroppedFrames: c.dropped.Load(), UsersWithOpenTabs: len(c.hubs.usersWithTabs())}
	if rc := connected[LocalRunnerID]; rc != nil {
		out.Items = append(out.Items, c.statusOf(rc, users))
	} else if b.LocalRunnerToken != "" {
		out.Items = append(out.Items, RunnerStatus{ID: LocalRunnerID, Name: "Local runner", Local: true, Labels: map[string]string{}})
	}
	for _, rec := range recs {
		var s RunnerStatus
		if rc := connected[rec.LinkID()]; rc != nil {
			s = c.statusOf(rc, users)
		} else {
			s = RunnerStatus{ID: rec.LinkID(), RecordID: rec.ID, Labels: rec.Labels, Version: rec.LastVersion, Users: users[rec.LinkID()]}
		}
		created := rec.CreatedAt
		s.Name, s.CreatedAt, s.RevokedAt, s.LastSeenAt = rec.Name, &created, rec.RevokedAt, rec.LastSeenAt
		s.DisabledAt, s.Disabled = rec.DisabledAt, rec.DisabledAt != nil
		out.Items = append(out.Items, s)
	}
	g.Header("Cache-Control", "no-store")
	response.Success(g, out)
}

// POST /web/runners {name}
func (c *Component) adminCreate(g *gin.Context) {
	var in struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(g.Writer, g.Request.Body, 4<<10)).Decode(&in); err != nil {
		response.ErrorFrom(g, errRunnerName)
		return
	}
	name := printable(in.Name, 100)
	if name == "" {
		response.ErrorFrom(g, errRunnerName)
		return
	}
	token, err := newRunnerToken()
	if err != nil {
		response.ErrorFrom(g, errRunnerStore)
		return
	}
	by, _ := core.Subject(g)
	rec, err := c.backends().Runners.Create(g.Request.Context(), name, by, hashRunnerToken(token))
	if err != nil {
		response.ErrorFrom(g, errRunnerStore)
		return
	}
	g.Header("Cache-Control", "no-store")
	response.Success(g, CreatedRunner{Runner: rec, Token: token})
}

func runnerParam(g *gin.Context) (int64, bool) {
	raw := strings.TrimPrefix(g.Param("id"), "r")
	id, err := strconv.ParseInt(raw, 10, 64)
	return id, err == nil && id > 0
}

// PATCH /web/runners/:id {name?, disabled?}
func (c *Component) adminUpdate(g *gin.Context) {
	id, ok := runnerParam(g)
	if !ok {
		response.ErrorFrom(g, errRunnerNotFound)
		return
	}
	var in struct {
		Name     *string `json:"name"`
		Disabled *bool   `json:"disabled"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(g.Writer, g.Request.Body, 4<<10)).Decode(&in); err != nil ||
		(in.Name == nil && in.Disabled == nil) {
		response.ErrorFrom(g, errRunnerUpdate)
		return
	}
	if in.Name != nil {
		name := printable(*in.Name, 100)
		if name == "" {
			response.ErrorFrom(g, errRunnerName)
			return
		}
		in.Name = &name
	}
	rec, err := c.backends().Runners.Update(g.Request.Context(), id, in.Name, in.Disabled)
	if errors.Is(err, ErrNoRunner) {
		response.ErrorFrom(g, errRunnerNotFound)
		return
	}
	if err != nil {
		response.ErrorFrom(g, errRunnerStore)
		return
	}
	if rec.DisabledAt != nil {
		if rc := c.reg.get(rec.LinkID()); rc != nil {
			rc.close(webproto.CloseRunnerRejected, "disabled")
		}
	}
	response.Success(g, gin.H{"id": rec.ID, "name": rec.Name, "disabled": rec.DisabledAt != nil})
}

// DELETE /web/runners/:id
func (c *Component) adminRevoke(g *gin.Context) {
	id, ok := runnerParam(g)
	if !ok {
		response.ErrorFrom(g, errRunnerNotFound)
		return
	}
	rec, err := c.backends().Runners.Revoke(g.Request.Context(), id)
	if errors.Is(err, ErrNoRunner) {
		response.ErrorFrom(g, errRunnerNotFound)
		return
	}
	if err != nil {
		response.ErrorFrom(g, errRunnerStore)
		return
	}
	if rc := c.reg.get(rec.LinkID()); rc != nil {
		rc.close(webproto.CloseRunnerRejected, "revoked")
	}
	response.Success(g, gin.H{"id": rec.ID, "revoked": true})
}

// POST /web/runners/:id/drain ("local" drains the local runner)
func (c *Component) adminDrain(g *gin.Context) {
	linkID := LocalRunnerID
	if g.Param("id") != LocalRunnerID {
		id, ok := runnerParam(g)
		if !ok {
			response.ErrorFrom(g, errRunnerNotFound)
			return
		}
		linkID = RunnerRecord{ID: id}.LinkID()
	}
	rc := c.reg.get(linkID)
	if rc == nil {
		response.ErrorFrom(g, errRunnerNotFound)
		return
	}
	rc.mu.Lock()
	rc.draining = true
	rc.mu.Unlock()
	rc.send(webproto.GoFrame{T: "drain"})
	response.Success(g, gin.H{"id": linkID, "draining": true})
}
