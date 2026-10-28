package sharing

// Report artifact: the artifact viewer's title menu sends the report form
// to the service (live claude.ai bundle, 2026-10-12: POST
// /api/frame/report/<slug> with category, notes, reporter_name and
// reporter_email; the viewer's form hides the training opt-out, so it is
// always off). An artifact in a conversation lives on the user's computer
// or runner, not on the service, so the report carries a copy of it
// (title, language and up to maxArtifactReportContentBytes of its text) for
// the administrator to review next to the shared-link reports.

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
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

// Limits of an artifact report.
const (
	// maxArtifactReportBodyBytes bounds the request (the copy is JSON
	// escaped, so it may take more room than it keeps).
	maxArtifactReportBodyBytes = 4 << 20
	// maxArtifactReportContentBytes is the longest copy kept, in bytes.
	maxArtifactReportContentBytes = 512 << 10
	maxArtifactReportTitleRunes   = 400
	maxArtifactReportLanguage     = 32
	maxArtifactIdentityBytes      = 3_000_000
	artifactReportsPerUserPerHour = 10
	auditResolveArtifactReport    = "admin.claudex.sharing.artifact_report.resolve"
)

// ErrReportsOff: the administrator turned reports off (Allow reports).
var ErrReportsOff = infraerrors.NotFound("CLAUDEX_REPORTS_OFF",
	"Reports are turned off on this server.")

// ArtifactReport is one Report artifact in the administrator's queue.
type ArtifactReport struct {
	ID int64 `json:"id"`
	// UserID is the account that sent it (whose conversation holds the
	// artifact); UserEmail is filled in for the console.
	UserID           int64  `json:"user_id"`
	UserEmail        string `json:"user_email"`
	Title            string `json:"title"`
	Language         string `json:"language"`
	ContentBytes     int64  `json:"content_bytes"`
	ContentTruncated bool   `json:"content_truncated"`
	// Reason is the service reason the category is filed under (as for
	// shared-link reports); Category the live report form's category.
	Reason           string     `json:"reason"`
	Category         string     `json:"category"`
	Notes            string     `json:"notes"`
	ReporterName     string     `json:"reporter_name"`
	ReporterEmail    string     `json:"reporter_email"`
	OptOutOfTraining bool       `json:"opt_out_of_training"`
	Status           string     `json:"status"`
	CreatedAt        time.Time  `json:"created_at"`
	ResolvedAt       *time.Time `json:"resolved_at"`
	ResolvedBy       *int64     `json:"resolved_by"`
}

// ArtifactReportContent is a report with the artifact copy (admin review).
type ArtifactReportContent struct {
	ArtifactReport
	Content string `json:"content"`
}

// artifactReportInput is one artifact report to store.
type artifactReportInput struct {
	UserID           int64
	IdentityHash     string
	Title            string
	Language         string
	Content          string
	ContentBytes     int64
	ContentTruncated bool
	Reason           string
	Category         string
	Notes            string
	ReporterName     string
	ReporterEmail    string
	OptOutOfTraining bool
}

// artifactReportStore keeps artifact reports (SQL in production, in memory
// in unit tests).
type artifactReportStore interface {
	// insertArtifactReport stores a report; false when the same account
	// already reported the same artifact in the last day.
	insertArtifactReport(ctx context.Context, in artifactReportInput, now time.Time) (bool, error)
	listArtifactReports(ctx context.Context, f reportFilter) ([]ArtifactReport, int64, error)
	// artifactReport returns one report with its copy; nil when there is none.
	artifactReport(ctx context.Context, id int64) (*ArtifactReportContent, error)
	// resolveArtifactReport sets a report's status; nil when there is none.
	resolveArtifactReport(ctx context.Context, id int64, status string, by int64, now time.Time) (*ArtifactReport, error)
}

// hasArtifactReportDB reports whether artifact reports can be stored.
func (c *Component) hasArtifactReportDB() bool {
	if s, ok := c.artifactReports.(*sqlStore); ok {
		return s != nil && s.db != nil
	}
	return c.artifactReports != nil
}

// artifactReportsOpen is what the status tells the app: reports are on and
// the server can keep them (sharing itself may be off).
func (c *Component) artifactReportsOpen(s Settings) bool {
	return s.AllowReports && c.hasArtifactReportDB()
}

// artifactReportRequest is the body of the app's Report artifact dialog.
type artifactReportRequest struct {
	Category      string `json:"category"`
	Notes         string `json:"notes"`
	ReporterName  string `json:"reporter_name"`
	ReporterEmail string `json:"reporter_email"`
	// The artifact: its identity in the app (hashed, never stored), title,
	// language and text; ContentBytes is the full size when the app sent
	// only the start of a longer artifact.
	Identity     string `json:"identity"`
	Title        string `json:"title"`
	Language     string `json:"language"`
	Content      string `json:"content"`
	ContentBytes int64  `json:"content_bytes"`
}

// cutUTF8 cuts s to at most limit bytes on a character boundary.
func cutUTF8(s string, limit int) (string, bool) {
	if len(s) <= limit {
		return s, false
	}
	cut := limit
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut], true
}

// artifactIdentityHash is the SHA-256 hex digest of an artifact identity.
func artifactIdentityHash(identity string) string {
	sum := sha256.Sum256([]byte("artifact-report:" + identity))
	return hex.EncodeToString(sum[:])
}

// POST /api/v1/claudex/sharing/artifact-reports: the app's Report artifact.
// 200 {reported: true} when accepted (a second report of the same artifact
// by the same account on the same day too, not stored again), 400 for an
// unknown category or a malformed artifact, 404 CLAUDEX_REPORTS_OFF while
// reports are off, 429 over 10 reports an hour, 503 without a database.
func (c *Component) postArtifactReport(g *gin.Context) {
	userID, ok := core.Subject(g)
	if !ok {
		response.ErrorFrom(g, infraerrors.Unauthorized("UNAUTHORIZED", "Sign in first."))
		return
	}
	ctx := g.Request.Context()
	if !c.hasArtifactReportDB() {
		response.ErrorFrom(g, ErrUnavailable)
		return
	}
	if !c.setting.Cached(ctx).AllowReports {
		response.ErrorFrom(g, ErrReportsOff)
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(g.Writer, requestBody(g), maxArtifactReportBodyBytes))
	if err != nil {
		response.ErrorFrom(g, invalidReport("body"))
		return
	}
	var body artifactReportRequest
	if err := json.Unmarshal(raw, &body); err != nil {
		response.ErrorFrom(g, invalidReport("body"))
		return
	}
	category := strings.ToLower(strings.TrimSpace(body.Category))
	reason, ok := reportCategories[category]
	if !ok {
		response.ErrorFrom(g, invalidReport("category"))
		return
	}
	identity := strings.TrimSpace(body.Identity)
	if identity == "" || len(identity) > maxArtifactIdentityBytes {
		response.ErrorFrom(g, invalidReport("identity"))
		return
	}
	language := strings.ToLower(strings.TrimSpace(body.Language))
	if len(language) > maxArtifactReportLanguage || !utf8.ValidString(body.Content) {
		response.ErrorFrom(g, invalidReport("artifact"))
		return
	}
	in := artifactReportInput{
		UserID: userID, IdentityHash: artifactIdentityHash(identity), Language: language,
		Reason: reason, Category: category,
	}
	if in.Title, ok = reportText(cleanLabel(body.Title), maxArtifactReportTitleRunes); !ok {
		response.ErrorFrom(g, invalidReport("title"))
		return
	}
	if in.Notes, ok = reportText(body.Notes, maxReportDetailRunes); !ok {
		response.ErrorFrom(g, invalidReport("notes"))
		return
	}
	if in.ReporterName, ok = reportText(body.ReporterName, maxReporterRunes); !ok {
		response.ErrorFrom(g, invalidReport("reporter_name"))
		return
	}
	if in.ReporterEmail, ok = reportText(body.ReporterEmail, maxReporterRunes); !ok {
		response.ErrorFrom(g, invalidReport("reporter_email"))
		return
	}
	content := dropNUL(body.Content)
	in.ContentBytes = int64(len(content))
	if body.ContentBytes > in.ContentBytes {
		// The app sent the start of a longer artifact.
		in.ContentBytes, in.ContentTruncated = body.ContentBytes, true
	}
	var cut bool
	in.Content, cut = cutUTF8(content, maxArtifactReportContentBytes)
	in.ContentTruncated = in.ContentTruncated || cut
	if c.env != nil {
		if allowed, _ := c.env.Allow(ctx, "sharing.artifact-report:user:"+itoa64(userID),
			artifactReportsPerUserPerHour, time.Hour); !allowed {
			response.ErrorFrom(g, infraerrors.TooManyRequests("CLAUDEX_RATE_LIMITED", "Too many reports. Try again later."))
			return
		}
	}
	if _, err := c.artifactReports.insertArtifactReport(ctx, in, c.now()); err != nil {
		slog.Warn("claudex sharing: storing an artifact report failed", "error", err)
		response.ErrorFrom(g, errStoreFailed)
		return
	}
	response.Success(g, gin.H{"reported": true})
}

// withReporterEmails fills in each report's account address.
func (c *Component) withReporterEmails(ctx context.Context, reports []ArtifactReport) {
	ids := make([]int64, 0, len(reports))
	for _, r := range reports {
		ids = append(ids, r.UserID)
	}
	emails := c.userEmails(ctx, ids)
	for i := range reports {
		reports[i].UserEmail = emails[reports[i].UserID]
	}
}

// GET /api/v1/admin/claudex/sharing/artifact-reports?status=&page=&page_size=
// (newest first, without the artifact copies).
func (c *Component) adminListArtifactReports(g *gin.Context) {
	f := reportFilter{Status: strings.TrimSpace(g.Query("status"))}
	switch f.Status {
	case "", reportOpen, reportResolved, reportDismissed:
	default:
		response.ErrorFrom(g, invalidFilter("status"))
		return
	}
	f.Page, f.Size = pageParams(g, maxAdminPageSize)
	if !c.hasArtifactReportDB() {
		response.Paginated(g, []ArtifactReport{}, 0, f.Page, f.Size)
		return
	}
	ctx := g.Request.Context()
	items, total, err := c.artifactReports.listArtifactReports(ctx, f)
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	c.withReporterEmails(ctx, items)
	response.Paginated(g, items, total, f.Page, f.Size)
}

// GET /api/v1/admin/claudex/sharing/artifact-reports/:id: one report with
// the artifact copy (shown as text by the console, never rendered).
func (c *Component) adminGetArtifactReport(g *gin.Context) {
	id, ok := idParam(g, "id")
	if !ok || !c.hasArtifactReportDB() {
		response.ErrorFrom(g, ErrReportNotFound)
		return
	}
	ctx := g.Request.Context()
	rep, err := c.artifactReports.artifactReport(ctx, id)
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	if rep == nil {
		response.ErrorFrom(g, ErrReportNotFound)
		return
	}
	one := []ArtifactReport{rep.ArtifactReport}
	c.withReporterEmails(ctx, one)
	rep.ArtifactReport = one[0]
	g.Header("Cache-Control", "no-store")
	response.Success(g, rep)
}

// POST /api/v1/admin/claudex/sharing/artifact-reports/:id/resolve
// {action: "dismiss"|"resolve"} (step-up). The artifact is not on the
// service, so there is nothing to take down: "resolve" records that the
// administrator acted on it (for example by blocking the account).
func (c *Component) adminResolveArtifactReport(g *gin.Context) {
	middleware.SetAuditAction(g, auditResolveArtifactReport)
	id, ok := idParam(g, "id")
	if !ok || !c.hasArtifactReportDB() {
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
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		response.ErrorFrom(g, invalidReport("body"))
		return
	}
	var status string
	switch body.Action {
	case "dismiss":
		status = reportDismissed
	case "resolve":
		status = reportResolved
	default:
		response.ErrorFrom(g, invalidReport("action"))
		return
	}
	adminID, _ := core.Subject(g)
	ctx := g.Request.Context()
	rep, err := c.artifactReports.resolveArtifactReport(ctx, id, status, adminID, c.now())
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
	one := []ArtifactReport{*rep}
	c.withReporterEmails(ctx, one)
	response.Success(g, one[0])
}

// ---- SQL ----

const artifactReportColumns = `id, user_id, title, language, content_bytes, content_truncated, reason, category,
  notes, reporter_name, reporter_email, opt_out_of_training, status, created_at, resolved_at, resolved_by`

func scanArtifactReport(sc rowScanner, extra ...any) (*ArtifactReport, error) {
	var r ArtifactReport
	var resolvedAt sql.NullTime
	var resolvedBy sql.NullInt64
	dest := []any{&r.ID, &r.UserID, &r.Title, &r.Language, &r.ContentBytes, &r.ContentTruncated, &r.Reason, &r.Category,
		&r.Notes, &r.ReporterName, &r.ReporterEmail, &r.OptOutOfTraining, &r.Status, &r.CreatedAt, &resolvedAt, &resolvedBy}
	if err := sc.Scan(append(dest, extra...)...); err != nil {
		return nil, err
	}
	r.ResolvedAt = timePtr(resolvedAt)
	if resolvedBy.Valid {
		v := resolvedBy.Int64
		r.ResolvedBy = &v
	}
	return &r, nil
}

func (s *sqlStore) insertArtifactReport(ctx context.Context, in artifactReportInput, now time.Time) (bool, error) {
	if err := s.ok(); err != nil {
		return false, err
	}
	// One report per account and artifact a day; a duplicate is accepted
	// silently.
	res, err := s.db.ExecContext(ctx, `INSERT INTO claudex_artifact_reports (user_id, identity_hash, title, language,
  content, content_bytes, content_truncated, reason, category, notes, reporter_name, reporter_email,
  opt_out_of_training, created_at)
SELECT $1::bigint, $2::varchar, $3::varchar, $4::varchar, $5::text, $6::bigint, $7::boolean, $8::varchar, $9::varchar,
  $10::varchar, $11::varchar, $12::varchar, $13::boolean, $14::timestamptz
WHERE $2::varchar = '' OR NOT EXISTS (SELECT 1 FROM claudex_artifact_reports
  WHERE user_id = $1::bigint AND identity_hash = $2::varchar AND created_at > $14::timestamptz - INTERVAL '1 day')`,
		in.UserID, in.IdentityHash, in.Title, in.Language, in.Content, in.ContentBytes, in.ContentTruncated, in.Reason,
		in.Category, in.Notes, in.ReporterName, in.ReporterEmail, in.OptOutOfTraining, now)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

func (s *sqlStore) listArtifactReports(ctx context.Context, f reportFilter) ([]ArtifactReport, int64, error) {
	if err := s.ok(); err != nil {
		return nil, 0, err
	}
	where := `TRUE`
	var args []any
	if f.Status != "" {
		args = append(args, f.Status)
		where += ` AND status = $` + strconv.Itoa(len(args))
	}
	from := ` FROM claudex_artifact_reports WHERE ` + where
	var total int64
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*)`+from, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	n := len(args)
	rows, err := s.db.QueryContext(ctx, `SELECT `+artifactReportColumns+from+
		` ORDER BY created_at DESC, id DESC LIMIT $`+strconv.Itoa(n+1)+` OFFSET $`+strconv.Itoa(n+2),
		append(args, f.Size, (f.Page-1)*f.Size)...)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = rows.Close() }()
	out := []ArtifactReport{}
	for rows.Next() {
		r, err := scanArtifactReport(rows)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, *r)
	}
	return out, total, rows.Err()
}

func (s *sqlStore) artifactReport(ctx context.Context, id int64) (*ArtifactReportContent, error) {
	if err := s.ok(); err != nil {
		return nil, err
	}
	var content string
	r, err := scanArtifactReport(s.db.QueryRowContext(ctx, `SELECT `+artifactReportColumns+`, content
FROM claudex_artifact_reports WHERE id = $1`, id), &content)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &ArtifactReportContent{ArtifactReport: *r, Content: content}, nil
}

func (s *sqlStore) resolveArtifactReport(ctx context.Context, id int64, status string, by int64, now time.Time) (*ArtifactReport, error) {
	if err := s.ok(); err != nil {
		return nil, err
	}
	r, err := scanArtifactReport(s.db.QueryRowContext(ctx, `UPDATE claudex_artifact_reports
SET status = $2, resolved_at = $3, resolved_by = $4 WHERE id = $1 RETURNING `+artifactReportColumns, id, status, now, by))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return r, err
}
