package status

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"

	"github.com/gin-gonic/gin"
)

func readJSON(g *gin.Context, into any) error {
	raw, err := io.ReadAll(http.MaxBytesReader(g.Writer, g.Request.Body, requestBodySize))
	if err != nil {
		return invalid("body", "The request is too large.")
	}
	if len(raw) == 0 {
		raw = []byte("{}")
	}
	if err := json.Unmarshal(raw, into); err != nil {
		return invalid("body", "The request must be a JSON object.")
	}
	return nil
}

func idParam(g *gin.Context) (int64, bool) {
	id, err := strconv.ParseInt(g.Param("id"), 10, 64)
	return id, err == nil && id > 0
}

func (c *Component) ready(g *gin.Context) bool {
	if !c.hasDB() {
		response.ErrorFrom(g, ErrUnavailable)
		return false
	}
	return true
}

// window reads ?hours= (1..720, ending with ?end=YYYY-MM-DDTHH:MM or the
// current slot), a bar ?step= minutes long (10, 15, 20, 30 or 60, default
// 60), or ?days= (1..366, default 90: a day a bar, ending with
// ?end=YYYY-MM-DD or today).
func (c *Component) window(g *gin.Context) Window {
	now := c.now().In(c.loc)
	if hours, err := strconv.Atoi(g.Query("hours")); err == nil && hours >= 1 && hours <= MaxHours {
		minutes := DefaultStepMinutes
		if n, err := strconv.Atoi(g.Query("step")); err == nil && stepMinutes[n] {
			minutes = n
		}
		step := time.Duration(minutes) * time.Minute
		end := time.Date(now.Year(), now.Month(), now.Day(), now.Hour(), now.Minute()/minutes*minutes, 0, 0, c.loc)
		if raw := g.Query("end"); raw != "" {
			layout := "2006-01-02T15:04"
			if len(raw) == 13 {
				layout = "2006-01-02T15"
			}
			if t, err := time.ParseInLocation(layout, raw, c.loc); err == nil && t.Before(end) {
				end = time.Date(t.Year(), t.Month(), t.Day(), t.Hour(), t.Minute()/minutes*minutes, 0, 0, c.loc)
			}
		}
		count := hours * 60 / minutes
		return Window{Start: end.Add(-time.Duration(count-1) * step), Step: step, Count: count, Hourly: true}
	}
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, c.loc)
	end := today
	if raw := g.Query("end"); raw != "" {
		if d, err := time.ParseInLocation("2006-01-02", raw, c.loc); err == nil && d.Before(today) {
			end = d
		}
	}
	days := DefaultDays
	if n, err := strconv.Atoi(g.Query("days")); err == nil && n >= 1 && n <= MaxDays {
		days = n
	}
	return dayWindow(end.AddDate(0, 0, -(days-1)), end)
}

func (c *Component) overview(g *gin.Context, incidentLimit int, publishedOnly bool) (*Overview, error) {
	ctx := g.Request.Context()
	w := c.window(g)
	now := c.now()
	channels, err := c.store.channels(ctx, w.Start)
	if err != nil {
		return nil, err
	}
	var counts []DayCounts
	if w.Hourly {
		counts, err = c.store.slots(ctx, w.Start, w.slot(w.Count), Timezone, int(w.Step/time.Minute))
	} else {
		counts, err = c.store.counts(ctx, w.Start, w.slot(w.Count-1))
	}
	if err != nil {
		return nil, err
	}
	latest, err := c.store.latest(ctx, now.Add(-24*time.Hour))
	if err != nil {
		return nil, err
	}
	incidents, err := c.store.incidents(ctx, w.Start, incidentLimit, publishedOnly)
	if err != nil {
		return nil, err
	}
	out := BuildOverview(channels, counts, latest, incidents, w, c.loc, now)
	return &out, nil
}

// GET /api/v1/claudex/status?hours=&step=|days=&end=
func (c *Component) getStatus(g *gin.Context) {
	if _, ok := core.Subject(g); !ok {
		response.ErrorFrom(g, infraerrors.Unauthorized("UNAUTHORIZED", "Sign in first."))
		return
	}
	if !c.ready(g) {
		return
	}
	out, err := c.overview(g, 100, true)
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	out.IQExamples = IQExamples()
	if groups, err := c.iqGroupRuns(g.Request.Context()); err == nil {
		// iq stays codex's runs for apps that show one group.
		for _, group := range groups {
			if group.Key == iqGroups[0].Key {
				out.IQ = group.Runs
			}
		}
		out.IQGroups = groups
	} else {
		slog.Warn("claudex status: iq runs failed", "error", err)
	}
	g.Header("Cache-Control", "no-store")
	response.Success(g, out)
}

// GET /api/v1/admin/claudex/status?hours=&step=|days=&end=
func (c *Component) adminStatus(g *gin.Context) {
	if !c.ready(g) {
		return
	}
	out, err := c.overview(g, 200, false)
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	response.Success(g, out)
}

// POST /api/v1/admin/claudex/status/incidents {title, platform, impact, status, message}
func (c *Component) adminCreate(g *gin.Context) {
	if !c.ready(g) {
		return
	}
	var req IncidentInput
	if err := readJSON(g, &req); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	in, err := req.normalize(true)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	by, _ := core.Subject(g)
	inc, err := c.store.create(g.Request.Context(), in, false, by, c.now())
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	response.Success(g, inc)
}

// PATCH /api/v1/admin/claudex/status/incidents/:id {title?, platform?, impact?, status?, message?}
// A status or a message is a new update people see; the rest edits the incident.
func (c *Component) adminUpdate(g *gin.Context) {
	id, ok := idParam(g)
	if !ok {
		response.ErrorFrom(g, ErrNotFound)
		return
	}
	if !c.ready(g) {
		return
	}
	var req struct {
		IncidentInput
		Platform *string `json:"platform"`
	}
	if err := readJSON(g, &req); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	in, err := req.normalize(false)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	in.Platform = "-"
	if req.Platform != nil {
		p, err := IncidentInput{Platform: *req.Platform}.normalize(false)
		if err != nil {
			response.ErrorFrom(g, err)
			return
		}
		in.Platform = p.Platform
	}
	by, _ := core.Subject(g)
	if by == 0 {
		// Updates by 0 are the component's own; an administrator's must differ.
		by = -1
	}
	inc, err := c.store.update(g.Request.Context(), id, in, by, c.now())
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	if inc == nil {
		response.ErrorFrom(g, ErrNotFound)
		return
	}
	response.Success(g, inc)
}

// DELETE /api/v1/admin/claudex/status/incidents/:id
func (c *Component) adminDelete(g *gin.Context) {
	id, ok := idParam(g)
	if !ok {
		response.ErrorFrom(g, ErrNotFound)
		return
	}
	if !c.ready(g) {
		return
	}
	removed, err := c.store.remove(g.Request.Context(), id)
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	if !removed {
		response.ErrorFrom(g, ErrNotFound)
		return
	}
	response.Success(g, gin.H{"deleted": true})
}
