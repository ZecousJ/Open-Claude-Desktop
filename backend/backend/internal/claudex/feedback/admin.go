package feedback

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"strconv"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"

	"github.com/gin-gonic/gin"
)

const (
	maxAdminPageSize     = 100
	maxSettingsBodyBytes = 16 << 10
)

// Audit action names of the admin views and deletes. The GET detail views are
// listed in the upstream audit middleware's sensitive reads (CLAUDEX: B8), so
// opening a report writes an audit entry without any report text.
const (
	auditDiagnosticRead   = "admin.claudex.diagnostics.read"
	auditDiagnosticDelete = "admin.claudex.diagnostics.delete"
	auditFeedbackRead     = "admin.claudex.feedback.read"
	auditFeedbackDelete   = "admin.claudex.feedback.delete"
)

var (
	// ErrReportNotFound: no diagnostic report or feedback with that id.
	ErrReportNotFound = infraerrors.NotFound("CLAUDEX_REPORT_NOT_FOUND", "That report doesn't exist or was already deleted.")
	errSettingsFailed = infraerrors.InternalServer("CLAUDEX_FEEDBACK_SETTINGS_FAILED", "Couldn't read or save the settings.")
	errListFailed     = infraerrors.InternalServer("CLAUDEX_FEEDBACK_STORE_FAILED", "Couldn't read the reports. Try again later.")
)

func invalidFilter(field string) error {
	return infraerrors.BadRequest("CLAUDEX_REPORT_FILTER_INVALID", "Invalid filter: "+field+".").
		WithMetadata(map[string]string{"field": field})
}

// GET /api/v1/admin/claudex/feedback-settings
func (c *Component) getSettings(g *gin.Context) {
	s, err := c.setting.Get(g.Request.Context())
	if err != nil {
		response.ErrorFrom(g, errSettingsFailed.WithCause(err))
		return
	}
	response.Success(g, s)
}

// PUT /api/v1/admin/claudex/feedback-settings (step-up). Fields left out of
// the body keep their current values; unknown fields and out-of-range values
// answer 400 CLAUDEX_SETTING_INVALID.
func (c *Component) putSettings(g *gin.Context) {
	ctx := g.Request.Context()
	next, err := c.setting.Get(ctx)
	if err != nil {
		response.ErrorFrom(g, errSettingsFailed.WithCause(err))
		return
	}
	raw, err := io.ReadAll(io.LimitReader(g.Request.Body, maxSettingsBodyBytes+1))
	if err != nil || len(raw) > maxSettingsBodyBytes {
		response.ErrorFrom(g, core.InvalidSetting("", "body", "json", "The settings must be a small JSON object."))
		return
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&next); err != nil {
		response.ErrorFrom(g, core.InvalidSetting("", "body", "json", "The settings must be a JSON object with the documented fields."))
		return
	}
	if err := validateSettings(&next); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	saved, err := c.setting.Set(ctx, next)
	if err != nil {
		if infraerrors.Code(err) == 400 {
			response.ErrorFrom(g, err)
			return
		}
		response.ErrorFrom(g, errSettingsFailed.WithCause(err))
		return
	}
	middleware.SetAuditExtra(g, map[string]any{"enabled": saved.Diagnostics.Enabled || saved.Feedback.Enabled})
	response.Success(g, saved)
}

// pageParams reads page and page_size (at most 100).
func pageParams(g *gin.Context) (page, size int) {
	page, size = response.ParsePagination(g)
	if size > maxAdminPageSize {
		size = maxAdminPageSize
	}
	return page, size
}

func userIDParam(g *gin.Context) (int64, error) {
	v := strings.TrimSpace(g.Query("user_id"))
	if v == "" {
		return 0, nil
	}
	id, err := strconv.ParseInt(v, 10, 64)
	if err != nil || id <= 0 {
		return 0, invalidFilter("user_id")
	}
	return id, nil
}

// timeParam reads an RFC 3339 time or a date (YYYY-MM-DD, UTC). A date in
// "to" means the end of that day (the bound is exclusive).
func timeParam(g *gin.Context, name string, endOfDay bool) (*time.Time, error) {
	v := strings.TrimSpace(g.Query(name))
	if v == "" {
		return nil, nil
	}
	if t, err := time.Parse(time.RFC3339Nano, v); err == nil {
		return &t, nil
	}
	t, err := time.Parse("2006-01-02", v)
	if err != nil {
		return nil, invalidFilter(name)
	}
	if endOfDay {
		t = t.Add(24 * time.Hour)
	}
	return &t, nil
}

func timeRange(g *gin.Context) (from, to *time.Time, err error) {
	if from, err = timeParam(g, "from", false); err != nil {
		return nil, nil, err
	}
	if to, err = timeParam(g, "to", true); err != nil {
		return nil, nil, err
	}
	return from, to, nil
}

func idParam(g *gin.Context) (int64, bool) {
	id, err := strconv.ParseInt(g.Param("id"), 10, 64)
	return id, err == nil && id > 0
}

// userEmails looks up the e-mail of each distinct user (deleted users
// included); failures leave the address empty.
func (c *Component) userEmails(ctx context.Context, ids []int64) map[int64]string {
	out := map[int64]string{}
	if c.env == nil || c.env.UserRepo == nil {
		return out
	}
	for _, id := range ids {
		if _, done := out[id]; done {
			continue
		}
		out[id] = ""
		if u, err := c.env.UserRepo.GetByIDIncludeDeleted(ctx, id); err == nil && u != nil {
			out[id] = u.Email
		}
	}
	return out
}

// GET /api/v1/admin/claudex/diagnostics?user_id=&code=&kind=&app_version=&from=&to=&page=&page_size=
func (c *Component) listDiagnostics(g *gin.Context) {
	userID, err := userIDParam(g)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	from, to, err := timeRange(g)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	kind := strings.TrimSpace(g.Query("kind"))
	if kind != "" && !diagnosticKinds[kind] {
		response.ErrorFrom(g, invalidFilter("kind"))
		return
	}
	code := strings.TrimSpace(g.Query("code"))
	appVersion := strings.TrimSpace(g.Query("app_version"))
	if len(code) > maxCodeChars {
		response.ErrorFrom(g, invalidFilter("code"))
		return
	}
	if len(appVersion) > 32 {
		response.ErrorFrom(g, invalidFilter("app_version"))
		return
	}
	page, size := pageParams(g)
	items, total, err := c.store.listDiagnostics(g.Request.Context(), diagnosticsFilter{
		UserID: userID, Code: code, Kind: kind, AppVersion: appVersion, From: from, To: to, Page: page, Size: size,
	})
	if err != nil {
		response.ErrorFrom(g, errListFailed.WithCause(err))
		return
	}
	ids := make([]int64, 0, len(items))
	for _, it := range items {
		ids = append(ids, it.UserID)
	}
	emails := c.userEmails(g.Request.Context(), ids)
	for i := range items {
		items[i].UserEmail = emails[items[i].UserID]
	}
	response.Paginated(g, items, total, page, size)
}

// GET /api/v1/admin/claudex/diagnostics/:id
func (c *Component) getDiagnostic(g *gin.Context) {
	middleware.SetAuditAction(g, auditDiagnosticRead)
	id, ok := idParam(g)
	if !ok {
		response.ErrorFrom(g, ErrReportNotFound)
		return
	}
	d, err := c.store.getDiagnostic(g.Request.Context(), id)
	if err != nil {
		response.ErrorFrom(g, errListFailed.WithCause(err))
		return
	}
	if d == nil {
		response.ErrorFrom(g, ErrReportNotFound)
		return
	}
	d.UserEmail = c.userEmails(g.Request.Context(), []int64{d.UserID})[d.UserID]
	response.Success(g, d)
}

// DELETE /api/v1/admin/claudex/diagnostics/:id
func (c *Component) deleteDiagnostic(g *gin.Context) {
	middleware.SetAuditAction(g, auditDiagnosticDelete)
	c.deleteReport(g, c.store.deleteDiagnostic)
}

// GET /api/v1/admin/claudex/feedback?rating=&user_id=&from=&to=&page=&page_size=
func (c *Component) listFeedback(g *gin.Context) {
	userID, err := userIDParam(g)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	from, to, err := timeRange(g)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	rating := strings.TrimSpace(g.Query("rating"))
	if rating != "" && rating != "up" && rating != "down" {
		response.ErrorFrom(g, invalidFilter("rating"))
		return
	}
	page, size := pageParams(g)
	items, total, err := c.store.listFeedback(g.Request.Context(), feedbackFilter{
		UserID: userID, Rating: rating, From: from, To: to, Page: page, Size: size,
	})
	if err != nil {
		response.ErrorFrom(g, errListFailed.WithCause(err))
		return
	}
	ids := make([]int64, 0, len(items))
	for _, it := range items {
		ids = append(ids, it.UserID)
	}
	emails := c.userEmails(g.Request.Context(), ids)
	for i := range items {
		items[i].UserEmail = emails[items[i].UserID]
		items[i].ConversationExcerpt = nil
	}
	response.Paginated(g, items, total, page, size)
}

// feedbackDetail is the detail view: the excerpt is always present (null
// when there is none).
type feedbackDetail struct {
	Feedback
	ConversationExcerpt *string `json:"conversation_excerpt"`
}

// GET /api/v1/admin/claudex/feedback/:id (with the conversation excerpt)
func (c *Component) getFeedback(g *gin.Context) {
	middleware.SetAuditAction(g, auditFeedbackRead)
	id, ok := idParam(g)
	if !ok {
		response.ErrorFrom(g, ErrReportNotFound)
		return
	}
	f, err := c.store.getFeedback(g.Request.Context(), id)
	if err != nil {
		response.ErrorFrom(g, errListFailed.WithCause(err))
		return
	}
	if f == nil {
		response.ErrorFrom(g, ErrReportNotFound)
		return
	}
	f.UserEmail = c.userEmails(g.Request.Context(), []int64{f.UserID})[f.UserID]
	excerpt := f.ConversationExcerpt
	f.ConversationExcerpt = nil
	response.Success(g, feedbackDetail{Feedback: *f, ConversationExcerpt: excerpt})
}

// DELETE /api/v1/admin/claudex/feedback/:id
func (c *Component) deleteFeedback(g *gin.Context) {
	middleware.SetAuditAction(g, auditFeedbackDelete)
	c.deleteReport(g, c.store.deleteFeedback)
}

func (c *Component) deleteReport(g *gin.Context, del func(context.Context, int64) (bool, error)) {
	id, ok := idParam(g)
	if !ok {
		response.ErrorFrom(g, ErrReportNotFound)
		return
	}
	deleted, err := del(g.Request.Context(), id)
	if err != nil {
		response.ErrorFrom(g, errListFailed.WithCause(err))
		return
	}
	if !deleted {
		middleware.SetAuditExtra(g, map[string]any{"result": "not_found"})
		response.ErrorFrom(g, ErrReportNotFound)
		return
	}
	middleware.SetAuditExtra(g, map[string]any{"result": "deleted"})
	response.Success(g, gin.H{"deleted": true})
}
