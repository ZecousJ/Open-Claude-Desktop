package usage

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"

	"github.com/gin-gonic/gin"
)

const (
	maxSettingsBody     = 64 << 10
	defaultDays         = 30
	maxDays             = 365
	defaultListLimit    = 100
	maxListLimit        = 500
	errReasonBadRequest = "CLAUDEX_WEB_USAGE_BAD_REQUEST"
)

var (
	errUnavailable = infraerrors.ServiceUnavailable("CLAUDEX_WEB_USAGE_UNAVAILABLE",
		"Web usage is temporarily unavailable. Try again later.")
	errUnauthorized = infraerrors.Unauthorized("UNAUTHORIZED", "Sign in to continue.")
)

func badParam(name, msg string) error {
	return infraerrors.BadRequest(errReasonBadRequest, msg).WithMetadata(map[string]string{"field": name})
}

// GET /api/v1/claudex/web/usage/conversations/:id: the caller's usage of one
// web conversation (billed requests by model, runner time). A conversation
// without usage answers zeros.
func (c *Component) userConversation(g *gin.Context) {
	userID, ok := core.Subject(g)
	if !ok {
		response.ErrorFrom(g, errUnauthorized)
		return
	}
	id := g.Param("id")
	if !ValidID(id) {
		response.ErrorFrom(g, badParam("id", "Invalid conversation id."))
		return
	}
	st := c.store()
	if st == nil {
		response.ErrorFrom(g, errUnavailable)
		return
	}
	out, err := st.conversation(g.Request.Context(), userID, id)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	response.Success(g, out)
}

// SettingsUpdate is the admin PUT body: the full setting plus the revision
// it was read at.
type SettingsUpdate struct {
	MaxConcurrentPerUser int     `json:"max_concurrent_sessions_per_user"`
	MaxConcurrent        int     `json:"max_concurrent_sessions"`
	MaxSessionMinutes    int     `json:"max_session_minutes"`
	RunnerMinutePriceUSD float64 `json:"runner_minute_price_usd"`
	Revision             *int64  `json:"revision"`
}

func revisionConflict(current int64) error {
	return infraerrors.Conflict(ReasonSettingsConflict, "The web usage settings changed since you loaded them. Reload and try again.").
		WithMetadata(map[string]string{"current_revision": strconv.FormatInt(current, 10)})
}

// GET /api/v1/admin/claudex/web/usage/settings
func (c *Component) adminGetSettings(g *gin.Context) {
	s, _, err := c.setting.GetRaw(g.Request.Context())
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	response.Success(g, s)
}

// PUT /api/v1/admin/claudex/web/usage/settings (step-up)
func (c *Component) adminPutSettings(g *gin.Context) {
	ctx := g.Request.Context()
	body, err := io.ReadAll(http.MaxBytesReader(g.Writer, g.Request.Body, maxSettingsBody))
	if err != nil {
		response.ErrorFrom(g, invalidSetting("", "too_large", "The request body is too large."))
		return
	}
	var upd SettingsUpdate
	if err := json.Unmarshal(body, &upd); err != nil {
		response.ErrorFrom(g, invalidSetting("", "json", "The request body must be a JSON object."))
		return
	}
	if upd.Revision == nil {
		response.ErrorFrom(g, invalidSetting("revision", "required", "revision is required."))
		return
	}
	cur, raw, err := c.setting.GetRaw(ctx)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	if *upd.Revision != cur.Revision {
		response.ErrorFrom(g, revisionConflict(cur.Revision))
		return
	}
	next := Settings{
		MaxConcurrentPerUser: upd.MaxConcurrentPerUser,
		MaxConcurrent:        upd.MaxConcurrent,
		MaxSessionMinutes:    upd.MaxSessionMinutes,
		RunnerMinutePriceUSD: upd.RunnerMinutePriceUSD,
		Revision:             cur.Revision + 1,
	}
	now := c.now().UTC()
	next.UpdatedAt = &now
	if adminID, ok := core.Subject(g); ok {
		next.UpdatedBy = &adminID
	}
	// No normalize here: a zero is a mistake the admin should see.
	if err := validateSettings(&next); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	saved, ok, err := c.swap(ctx, raw, next)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	if !ok {
		current := cur.Revision + 1
		if latest, _, err := c.setting.GetRaw(ctx); err == nil {
			current = latest.Revision
		}
		response.ErrorFrom(g, revisionConflict(current))
		return
	}
	middleware.SetAuditExtra(g, map[string]any{"config_version": saved.Revision})
	response.Success(g, saved)
}

// swap writes next only if the stored value is still raw. Without a database
// handle (unit tests) it falls back to a plain write.
func (c *Component) swap(ctx context.Context, raw string, next Settings) (Settings, bool, error) {
	if db := c.sqlDB(); db != nil {
		return c.setting.SwapIfUnchanged(ctx, db, raw, next)
	}
	saved, err := c.setting.Set(ctx, next)
	return saved, err == nil, err
}

// ActiveResponse is the answer of GET /web/usage/active.
type ActiveResponse struct {
	Slots    []SlotInfo `json:"slots"`
	Settings Settings   `json:"settings"`
}

// GET /api/v1/admin/claudex/web/usage/active?user_id=
func (c *Component) adminActive(g *gin.Context) {
	userID, err := optionalUserID(g)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	response.Success(g, ActiveResponse{Slots: c.ActiveSlots(userID), Settings: c.settings(g.Request.Context())})
}

// GET /api/v1/admin/claudex/web/usage/conversations?user_id=&conversation_id=&days=&limit=
// With conversation_id (and user_id) it answers that conversation's usage.
func (c *Component) adminConversations(g *gin.Context) {
	userID, err := optionalUserID(g)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	st := c.store()
	if st == nil {
		response.ErrorFrom(g, errUnavailable)
		return
	}
	ctx := g.Request.Context()
	if conv := g.Query("conversation_id"); conv != "" {
		if !ValidID(conv) {
			response.ErrorFrom(g, badParam("conversation_id", "Invalid conversation id."))
			return
		}
		if userID == 0 {
			response.ErrorFrom(g, badParam("user_id", "user_id is required with conversation_id."))
			return
		}
		out, err := st.conversation(ctx, userID, conv)
		if err != nil {
			response.ErrorFrom(g, err)
			return
		}
		response.Success(g, out)
		return
	}
	days, err := intParam(g, "days", defaultDays, 1, maxDays)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	limit, err := intParam(g, "limit", defaultListLimit, 1, maxListLimit)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	rows, err := st.conversations(ctx, userID, c.now().Add(-time.Duration(days)*24*time.Hour), limit)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	response.Success(g, gin.H{"items": rows})
}

// RunnersResponse is the answer of GET /web/usage/runners.
type RunnersResponse struct {
	Items                []RunnerSummaryRow `json:"items"`
	Days                 int                `json:"days"`
	RunnerMinutePriceUSD float64            `json:"runner_minute_price_usd"`
}

// GET /api/v1/admin/claudex/web/usage/runners?user_id=&days=
func (c *Component) adminRunners(g *gin.Context) {
	userID, err := optionalUserID(g)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	days, err := intParam(g, "days", defaultDays, 1, maxDays)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	st := c.store()
	if st == nil {
		response.ErrorFrom(g, errUnavailable)
		return
	}
	ctx := g.Request.Context()
	rows, err := st.runnerSummary(ctx, userID, c.now().Add(-time.Duration(days)*24*time.Hour))
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	response.Success(g, RunnersResponse{Items: rows, Days: days, RunnerMinutePriceUSD: c.settings(ctx).RunnerMinutePriceUSD})
}

func optionalUserID(g *gin.Context) (int64, error) {
	v := g.Query("user_id")
	if v == "" {
		return 0, nil
	}
	id, err := strconv.ParseInt(v, 10, 64)
	if err != nil || id <= 0 {
		return 0, badParam("user_id", "Invalid user_id.")
	}
	return id, nil
}

func intParam(g *gin.Context, name string, def, lo, hi int) (int, error) {
	v := g.Query(name)
	if v == "" {
		return def, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < lo || n > hi {
		return 0, badParam(name, name+" must be between "+strconv.Itoa(lo)+" and "+strconv.Itoa(hi)+".")
	}
	return n, nil
}
