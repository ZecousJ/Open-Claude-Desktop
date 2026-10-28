package sharing

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"

	"github.com/gin-gonic/gin"
)

const (
	maxAdminPageSize      = 100
	maxAdminBodyBytes     = 16 << 10
	maxDisableReasonRunes = 500
	maxAdminQueryRunes    = 200
)

// ErrUserNotFound: the user of a block does not exist (admin).
var ErrUserNotFound = infraerrors.NotFound("CLAUDEX_USER_NOT_FOUND", "That user doesn't exist.")

// Audit action names of the admin writes.
const (
	auditSettings   = "admin.claudex.sharing.settings.update"
	auditDisable    = "admin.claudex.sharing.share.disable"
	auditEnable     = "admin.claudex.sharing.share.enable"
	auditDelete     = "admin.claudex.sharing.share.delete"
	auditResolve    = "admin.claudex.sharing.report.resolve"
	auditBlock      = "admin.claudex.sharing.block.put"
	auditUnblock    = "admin.claudex.sharing.block.delete"
	auditDisableAll = "admin.claudex.sharing.user.disable_all"
)

// EffectiveSettings shows what the current settings resolve to.
type EffectiveSettings struct {
	PublicBaseURL       string `json:"public_base_url"`        // "" = links are paths
	PublicBaseURLSource string `json:"public_base_url_source"` // setting | frontend_url | none
	UsagePolicyURL      string `json:"usage_policy_url"`
	UsagePolicyPath     string `json:"usage_policy_path"`
	// StorageAvailable is false when the server has no database for shares.
	StorageAvailable bool `json:"storage_available"`
}

// AdminSettingsDTO answers GET/PUT /api/v1/admin/claudex/sharing/settings.
type AdminSettingsDTO struct {
	Settings  Settings          `json:"settings"`
	Effective EffectiveSettings `json:"effective"`
}

func (c *Component) adminSettingsDTO(ctx context.Context, s Settings) AdminSettingsDTO {
	base, source := c.publicBase(ctx, s)
	policyURL, policyPath := c.usagePolicy(ctx, s, base)
	return AdminSettingsDTO{Settings: s, Effective: EffectiveSettings{
		PublicBaseURL: base, PublicBaseURLSource: source, UsagePolicyURL: policyURL, UsagePolicyPath: policyPath,
		StorageAvailable: c.hasDB(),
	}}
}

// GET /api/v1/admin/claudex/sharing/settings
func (c *Component) adminGetSettings(g *gin.Context) {
	s, err := c.setting.Get(g.Request.Context())
	if err != nil {
		response.ErrorFrom(g, errSettingsFailed.WithCause(err))
		return
	}
	response.Success(g, c.adminSettingsDTO(g.Request.Context(), s))
}

// PUT /api/v1/admin/claudex/sharing/settings (step-up). Fields left out keep
// their values; unknown fields and invalid values answer 400
// CLAUDEX_SETTING_INVALID (metadata field, rule).
func (c *Component) adminPutSettings(g *gin.Context) {
	middleware.SetAuditAction(g, auditSettings)
	ctx := g.Request.Context()
	next, err := c.setting.Get(ctx)
	if err != nil {
		response.ErrorFrom(g, errSettingsFailed.WithCause(err))
		return
	}
	raw, err := io.ReadAll(io.LimitReader(requestBody(g), maxAdminBodyBytes+1))
	if err != nil || len(raw) > maxAdminBodyBytes {
		response.ErrorFrom(g, core.InvalidSetting("", "body", "json", "The settings must be a small JSON object."))
		return
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&next); err != nil {
		response.ErrorFrom(g, core.InvalidSetting("", "body", "json", "The settings must be a JSON object with the documented fields."))
		return
	}
	next.PublicBaseURL = trimBase(next.PublicBaseURL)
	next.ContentBaseURL = trimBase(next.ContentBaseURL)
	next.UsagePolicyURL = strings.TrimSpace(next.UsagePolicyURL)
	if err := validateSettings(&next); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	saved, err := c.setting.Set(ctx, next)
	if err != nil {
		if infraerrors.Code(err) == http.StatusBadRequest {
			response.ErrorFrom(g, err)
			return
		}
		response.ErrorFrom(g, errSettingsFailed.WithCause(err))
		return
	}
	middleware.SetAuditExtra(g, map[string]any{"enabled": saved.Enabled})
	response.Success(g, c.adminSettingsDTO(ctx, saved))
}

// AdminShareDTO is a share in the console.
type AdminShareDTO struct {
	ShareDTO
	UserID       int64      `json:"user_id"`
	UserEmail    string     `json:"user_email"`
	OpenReports  int64      `json:"open_reports"`
	DisabledBy   *int64     `json:"disabled_by"`
	DisabledAt   *time.Time `json:"disabled_at"`
	LastViewedAt *time.Time `json:"last_viewed_at"`
	Expired      bool       `json:"expired"`
}

func (c *Component) adminShareDTO(r *shareRow, base, email string) AdminShareDTO {
	return AdminShareDTO{
		ShareDTO: shareDTO(r, base), UserID: r.UserID, UserEmail: email, OpenReports: r.OpenReports,
		DisabledBy: r.DisabledBy, DisabledAt: r.DisabledAt, LastViewedAt: r.LastViewedAt, Expired: r.expired(c.now()),
	}
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

func positiveQuery(g *gin.Context, name string) (int64, error) {
	v := strings.TrimSpace(g.Query(name))
	if v == "" {
		return 0, nil
	}
	id, err := strconv.ParseInt(v, 10, 64)
	if err != nil || id <= 0 {
		return 0, invalidFilter(name)
	}
	return id, nil
}

// GET /api/v1/admin/claudex/sharing/shares?status=&kind=&user_id=&q=&page=&page_size=
// (status "" = active and disabled; "revoked" lists deleted links).
func (c *Component) adminListShares(g *gin.Context) {
	f := adminFilter{Status: Status(strings.TrimSpace(g.Query("status"))), Kind: Kind(strings.TrimSpace(g.Query("kind")))}
	switch f.Status {
	case "", StatusActive, StatusDisabled, StatusRevoked:
	default:
		response.ErrorFrom(g, invalidFilter("status"))
		return
	}
	if f.Kind != "" && f.Kind != KindConversation && f.Kind != KindArtifact {
		response.ErrorFrom(g, invalidFilter("kind"))
		return
	}
	var err error
	if f.UserID, err = positiveQuery(g, "user_id"); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	f.Query = strings.TrimSpace(g.Query("q"))
	if utf8.RuneCountInString(f.Query) > maxAdminQueryRunes {
		response.ErrorFrom(g, invalidFilter("q"))
		return
	}
	f.Page, f.Size = pageParams(g, maxAdminPageSize)
	ctx := g.Request.Context()
	if !c.hasDB() {
		response.Paginated(g, []AdminShareDTO{}, 0, f.Page, f.Size)
		return
	}
	rows, total, err := c.store.adminList(ctx, f)
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	ids := make([]int64, 0, len(rows))
	for _, r := range rows {
		ids = append(ids, r.UserID)
	}
	emails := c.userEmails(ctx, ids)
	base, _ := c.publicBase(ctx, c.setting.Cached(ctx))
	items := make([]AdminShareDTO, 0, len(rows))
	for i := range rows {
		items = append(items, c.adminShareDTO(&rows[i], base, emails[rows[i].UserID]))
	}
	response.Paginated(g, items, total, f.Page, f.Size)
}

// adminShare loads a live share for the admin handlers (nil: answered 404).
func (c *Component) adminShare(g *gin.Context) *shareRow {
	id, ok := idParam(g, "id")
	if !ok || !c.hasDB() {
		response.ErrorFrom(g, ErrShareNotFound)
		return nil
	}
	row, err := c.store.getLive(g.Request.Context(), 0, id)
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return nil
	}
	if row == nil {
		response.ErrorFrom(g, ErrShareNotFound)
		return nil
	}
	return row
}

// GET /api/v1/admin/claudex/sharing/shares/:id
func (c *Component) adminGetShare(g *gin.Context) {
	row := c.adminShare(g)
	if row == nil {
		return
	}
	ctx := g.Request.Context()
	base, _ := c.publicBase(ctx, c.setting.Cached(ctx))
	response.Success(g, c.adminShareDTO(row, base, c.userEmails(ctx, []int64{row.UserID})[row.UserID]))
}

// GET /api/v1/admin/claudex/sharing/shares/:id/content: the stored snapshot,
// so an administrator can review a reported or taken-down share (it was
// published to anyone with the link).
func (c *Component) adminGetContent(g *gin.Context) {
	row := c.adminShare(g)
	if row == nil {
		return
	}
	snap, err := c.store.content(g.Request.Context(), row.ID)
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	if snap == nil {
		response.ErrorFrom(g, ErrShareNotFound)
		return
	}
	g.Header("Cache-Control", "no-store")
	response.Success(g, gin.H{"id": row.ID, "schema": SnapshotSchema, "snapshot": snap})
}

// GET /api/v1/admin/claudex/sharing/shares/:id/preview: the public page
// address (url is "" when the server has no public base; open path on the
// console's own host).
func (c *Component) adminPreview(g *gin.Context) {
	row := c.adminShare(g)
	if row == nil {
		return
	}
	ctx := g.Request.Context()
	base, _ := c.publicBase(ctx, c.setting.Cached(ctx))
	dto := shareDTO(row, base)
	response.Success(g, gin.H{"url": dto.URL, "path": dto.Path, "status": row.Status})
}

// reasonBody reads {reason} (optional, at most 500 characters).
func reasonBody(g *gin.Context) (string, error) {
	raw, err := io.ReadAll(io.LimitReader(requestBody(g), maxAdminBodyBytes+1))
	if err != nil || len(raw) > maxAdminBodyBytes {
		return "", invalidShare("body", "The request must be a small JSON object.")
	}
	var body struct {
		Reason string `json:"reason"`
	}
	if len(bytes.TrimSpace(raw)) > 0 {
		if err := json.Unmarshal(raw, &body); err != nil {
			return "", invalidShare("body", "The request must be a JSON object with an optional reason.")
		}
	}
	reason := cleanLabel(body.Reason)
	if utf8.RuneCountInString(reason) > maxDisableReasonRunes {
		return "", invalidShare("reason", "The reason is too long.")
	}
	return reason, nil
}

func (c *Component) setShareDisabled(g *gin.Context, disabled bool) {
	id, ok := idParam(g, "id")
	if !ok || !c.hasDB() {
		response.ErrorFrom(g, ErrShareNotFound)
		return
	}
	reason := ""
	if disabled {
		var err error
		if reason, err = reasonBody(g); err != nil {
			response.ErrorFrom(g, err)
			return
		}
	}
	adminID, _ := core.Subject(g)
	ctx := g.Request.Context()
	row, err := c.store.setDisabled(ctx, id, disabled, reason, adminID, c.now())
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	if row == nil {
		middleware.SetAuditExtra(g, map[string]any{"result": "not_found"})
		response.ErrorFrom(g, ErrShareNotFound)
		return
	}
	middleware.SetAuditExtra(g, map[string]any{"result": string(row.Status)})
	base, _ := c.publicBase(ctx, c.setting.Cached(ctx))
	response.Success(g, c.adminShareDTO(row, base, c.userEmails(ctx, []int64{row.UserID})[row.UserID]))
}

// POST /api/v1/admin/claudex/sharing/shares/:id/disable {reason} (step-up):
// take the share down; its page answers 410 and the author sees the reason.
func (c *Component) adminDisable(g *gin.Context) {
	middleware.SetAuditAction(g, auditDisable)
	c.setShareDisabled(g, true)
}

// POST /api/v1/admin/claudex/sharing/shares/:id/enable (step-up)
func (c *Component) adminEnable(g *gin.Context) {
	middleware.SetAuditAction(g, auditEnable)
	c.setShareDisabled(g, false)
}

// DELETE /api/v1/admin/claudex/sharing/shares/:id (step-up): delete the
// content for good (the link then answers 404 like any revoked one).
func (c *Component) adminDelete(g *gin.Context) {
	middleware.SetAuditAction(g, auditDelete)
	id, ok := idParam(g, "id")
	if !ok || !c.hasDB() {
		response.ErrorFrom(g, ErrShareNotFound)
		return
	}
	done, err := c.store.revoke(g.Request.Context(), 0, id, c.now())
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	if !done {
		middleware.SetAuditExtra(g, map[string]any{"result": "not_found"})
		response.ErrorFrom(g, ErrShareNotFound)
		return
	}
	middleware.SetAuditExtra(g, map[string]any{"result": "deleted"})
	response.Success(g, gin.H{"deleted": true})
}

func (c *Component) withShareLinks(ctx context.Context, reports []Report) {
	base, _ := c.publicBase(ctx, c.setting.Cached(ctx))
	for i := range reports {
		if reports[i].shareToken == "" {
			continue
		}
		reports[i].SharePath = sharePath(reports[i].shareToken)
		if base != "" {
			reports[i].ShareURL = joinBase(base, reports[i].SharePath)
		}
	}
}

// GET /api/v1/admin/claudex/sharing/reports?status=&share_id=&page=&page_size=
func (c *Component) adminListReports(g *gin.Context) {
	f := reportFilter{Status: strings.TrimSpace(g.Query("status"))}
	switch f.Status {
	case "", reportOpen, reportResolved, reportDismissed:
	default:
		response.ErrorFrom(g, invalidFilter("status"))
		return
	}
	var err error
	if f.ShareID, err = positiveQuery(g, "share_id"); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	f.Page, f.Size = pageParams(g, maxAdminPageSize)
	ctx := g.Request.Context()
	if !c.hasDB() {
		response.Paginated(g, []Report{}, 0, f.Page, f.Size)
		return
	}
	items, total, err := c.store.listReports(ctx, f)
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	c.withShareLinks(ctx, items)
	response.Paginated(g, items, total, f.Page, f.Size)
}

// POST /api/v1/admin/claudex/sharing/reports/:id/resolve
// {action: "dismiss"|"disable", reason} (step-up). "disable" takes the share
// down and closes every open report of it.
func (c *Component) adminResolveReport(g *gin.Context) {
	middleware.SetAuditAction(g, auditResolve)
	id, ok := idParam(g, "id")
	if !ok || !c.hasDB() {
		response.ErrorFrom(g, ErrReportNotFound)
		return
	}
	raw, err := io.ReadAll(io.LimitReader(requestBody(g), maxAdminBodyBytes+1))
	if err != nil || len(raw) > maxAdminBodyBytes {
		response.ErrorFrom(g, invalidReport("body"))
		return
	}
	var body struct {
		Action string `json:"action"`
		Reason string `json:"reason"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		response.ErrorFrom(g, invalidReport("body"))
		return
	}
	reason := cleanLabel(body.Reason)
	if utf8.RuneCountInString(reason) > maxDisableReasonRunes {
		response.ErrorFrom(g, invalidReport("reason"))
		return
	}
	adminID, _ := core.Subject(g)
	ctx := g.Request.Context()
	now := c.now()
	var rep *Report
	switch body.Action {
	case "dismiss":
		rep, err = c.store.resolveReport(ctx, id, reportDismissed, false, adminID, now)
	case "disable":
		rep, err = c.store.resolveReport(ctx, id, reportResolved, true, adminID, now)
		if err == nil && rep != nil {
			var row *shareRow
			if row, err = c.store.setDisabled(ctx, rep.ShareID, true, reason, adminID, now); err == nil && row != nil {
				rep.ShareStatus = row.Status
			}
		}
	default:
		response.ErrorFrom(g, invalidReport("action"))
		return
	}
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	if rep == nil {
		middleware.SetAuditExtra(g, map[string]any{"result": "not_found"})
		response.ErrorFrom(g, ErrReportNotFound)
		return
	}
	middleware.SetAuditExtra(g, map[string]any{"result": body.Action})
	reports := []Report{*rep}
	c.withShareLinks(ctx, reports)
	response.Success(g, reports[0])
}

// GET /api/v1/admin/claudex/sharing/blocks?page=&page_size=
func (c *Component) adminListBlocks(g *gin.Context) {
	page, size := pageParams(g, maxAdminPageSize)
	ctx := g.Request.Context()
	if !c.hasDB() {
		response.Paginated(g, []Block{}, 0, page, size)
		return
	}
	items, total, err := c.store.listBlocks(ctx, page, size)
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	ids := make([]int64, 0, len(items))
	for _, b := range items {
		ids = append(ids, b.UserID)
	}
	emails := c.userEmails(ctx, ids)
	for i := range items {
		items[i].UserEmail = emails[items[i].UserID]
	}
	response.Paginated(g, items, total, page, size)
}

// PUT /api/v1/admin/claudex/sharing/blocks/:user_id {reason} (step-up): the
// user can no longer create or update shares; existing shares stay online
// (see disable-all).
func (c *Component) adminPutBlock(g *gin.Context) {
	middleware.SetAuditAction(g, auditBlock)
	userID, ok := idParam(g, "user_id")
	if !ok {
		response.ErrorFrom(g, ErrUserNotFound)
		return
	}
	if !c.hasDB() {
		response.ErrorFrom(g, ErrUnavailable)
		return
	}
	reason, err := reasonBody(g)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	adminID, _ := core.Subject(g)
	ctx := g.Request.Context()
	b, found, err := c.store.putBlock(ctx, userID, reason, adminID, c.now())
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	if !found {
		middleware.SetAuditExtra(g, map[string]any{"result": "not_found"})
		response.ErrorFrom(g, ErrUserNotFound)
		return
	}
	b.UserEmail = c.userEmails(ctx, []int64{userID})[userID]
	middleware.SetAuditExtra(g, map[string]any{"result": "blocked"})
	response.Success(g, b)
}

// DELETE /api/v1/admin/claudex/sharing/blocks/:user_id (step-up)
func (c *Component) adminDeleteBlock(g *gin.Context) {
	middleware.SetAuditAction(g, auditUnblock)
	userID, ok := idParam(g, "user_id")
	if !ok || !c.hasDB() {
		response.Success(g, gin.H{"deleted": false})
		return
	}
	done, err := c.store.deleteBlock(g.Request.Context(), userID)
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	middleware.SetAuditExtra(g, map[string]any{"result": map[bool]string{true: "deleted", false: "not_found"}[done]})
	response.Success(g, gin.H{"deleted": done})
}

// POST /api/v1/admin/claudex/sharing/users/:user_id/disable-all {reason}
// (step-up): take down every active share of the user.
func (c *Component) adminDisableAll(g *gin.Context) {
	middleware.SetAuditAction(g, auditDisableAll)
	userID, ok := idParam(g, "user_id")
	if !ok {
		response.ErrorFrom(g, ErrUserNotFound)
		return
	}
	if !c.hasDB() {
		response.ErrorFrom(g, ErrUnavailable)
		return
	}
	reason, err := reasonBody(g)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	adminID, _ := core.Subject(g)
	n, err := c.store.disableAllOf(g.Request.Context(), userID, reason, adminID, c.now())
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	middleware.SetAuditExtra(g, map[string]any{"matched_count": n})
	response.Success(g, gin.H{"disabled": n})
}
