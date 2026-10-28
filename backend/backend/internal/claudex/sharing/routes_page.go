package sharing

import (
	"context"
	"errors"
	"log/slog"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Wei-Shaw/sub2api/internal/server/middleware"

	"github.com/gin-gonic/gin"
)

// Public page limits.
const (
	maxReportDetailRunes = 1000
	maxReporterRunes     = 255
	maxReportBodyBytes   = 8 << 10
	reportsPerIPPerHour  = 10
	viewDedupeWindow     = time.Hour
	assetPrefix          = PathPrefix + "/_assets/"
)

// setPageHeaders sets what every /s/* answer shares: never indexed, never
// cached (a revoked link dies at once, also behind a CDN), no referrer.
func setPageHeaders(w http.ResponseWriter) {
	h := w.Header()
	h.Set("X-Robots-Tag", "noindex, nofollow, noarchive")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
}

// resolved is a share a visitor may see.
type resolved struct {
	row      *shareRow
	snapshot *Snapshot
	settings Settings
	base     string // public base URL ("" = same host)
}

// errRemoved marks a share the administrator took down (410).
var errRemoved = errors.New("removed by the administrator")

// resolveToken finds a visible share: sharing and the kind on, the token
// well-formed, the share active, not expired and its author not deleted.
// Everything else is errNotVisible (404, whatever the reason, so a visitor
// cannot tell a revoked link from one that never existed) or errRemoved.
func (c *Component) resolveToken(ctx context.Context, token string, withContent bool) (*resolved, error) {
	s := c.setting.Cached(ctx)
	if !s.Enabled || !ValidToken(token) || !c.hasDB() {
		return nil, errNotVisible
	}
	row, err := c.store.byToken(ctx, token)
	if err != nil {
		return nil, err
	}
	if row == nil || row.Status == StatusRevoked || row.expired(c.now()) || row.AuthorGone {
		return nil, errNotVisible
	}
	if (row.Kind == KindConversation && !s.Conversations) || (row.Kind == KindArtifact && !s.Artifacts) {
		return nil, errNotVisible
	}
	if row.Status == StatusDisabled {
		return nil, errRemoved
	}
	// A share limited to invited people has no public page.
	if row.InvitedOnly {
		return nil, errNotVisible
	}
	out := &resolved{row: row, settings: s}
	out.base, _ = c.publicBase(ctx, s)
	if withContent || row.Kind == KindConversation {
		snap, err := c.store.content(ctx, row.ID)
		if err != nil {
			return nil, err
		}
		if snap == nil {
			return nil, errNotVisible
		}
		out.snapshot = snap
		allowed, err := c.canReadCode(ctx, row.UserID, 0, snap)
		if err != nil {
			return nil, err
		}
		if !allowed {
			return out, errCodeRepositoryAccess
		}
	}
	return out, nil
}

var errNotVisible = errors.New("share not visible")
var errCodeRepositoryAccess = errors.New("repository access required")

// onContentHost reports whether the request came to the separate content
// host (only artifact documents and assets are served there).
func onContentHost(s Settings, host string) bool {
	ch := hostOf(s.ContentBaseURL)
	return ch != "" && requestHost(host) == ch
}

func (c *Component) notice(g *gin.Context, status int, kind NoticeKind, back string) {
	setPageHeaders(g.Writer)
	v := &NoticeView{Kind: kind, SiteName: c.siteName(g.Request.Context()), BackURL: back}
	if err := currentRenderer().Notice(g.Writer, status, v); err != nil {
		slog.Warn("claudex sharing: rendering a notice failed", "error", err)
	}
}

// pageError answers a failed lookup: 404 or 410 notice, 503 when the
// database failed (no details leak to the visitor).
func (c *Component) pageError(g *gin.Context, err error) {
	switch {
	case errors.Is(err, errRemoved):
		c.notice(g, http.StatusGone, NoticeRemoved, "")
	case errors.Is(err, errNotVisible), errors.Is(err, errCodeRepositoryAccess):
		c.notice(g, http.StatusNotFound, NoticeNotFound, "")
	default:
		slog.Warn("claudex sharing: page lookup failed", "error", err)
		c.notice(g, http.StatusServiceUnavailable, NoticeNotFound, "")
	}
}

// GET /s/:token
func (c *Component) getPage(g *gin.Context) {
	ctx := g.Request.Context()
	if onContentHost(c.setting.Cached(ctx), g.Request.Host) {
		c.notice(g, http.StatusNotFound, NoticeNotFound, "")
		return
	}
	res, err := c.resolveToken(ctx, g.Param("token"), true)
	if errors.Is(err, errCodeRepositoryAccess) {
		setPageHeaders(g.Writer)
		g.Redirect(http.StatusFound, c.appBase(ctx, g)+"/shared/"+res.row.Token)
		return
	}
	if err != nil {
		c.pageError(g, err)
		return
	}
	token := res.row.Token
	v := &PageView{
		Token: token, Kind: res.row.Kind, Title: res.row.Title, SiteName: c.siteName(ctx),
		CreatedAt: res.row.CreatedAt, SnapshotAt: res.row.SnapshotAt, ExpiresAt: res.row.ExpiresAt,
		Snapshot: res.snapshot, FrameSource: "'self'", UsagePolicyURL: res.settings.UsagePolicyURL,
	}
	contentBase := res.settings.ContentBaseURL
	if res.snapshot.Mode == "code" {
		v.DisplayName, err = c.codeDisplayName(ctx, res.row.UserID, res.snapshot)
		if err != nil {
			c.pageError(g, err)
			return
		}
	}
	if res.snapshot.Screenshot != "" {
		v.ScreenshotURL = joinBase(res.base, sharePath(token)+"/screenshot")
	}
	if contentBase != "" {
		v.FrameSource = originOf(contentBase)
	}
	for i := range res.snapshot.Artifacts {
		v.ArtifactURLs = append(v.ArtifactURLs, joinBase(contentBase, artifactPath(token, i)))
		v.RawURLs = append(v.RawURLs, rawPath(token, i))
	}
	if res.settings.AllowReports {
		v.ReportURL = sharePath(token) + "/report"
		v.ReportReasons = append([]string(nil), ReportReasonOrder...)
		v.ReportCategories = append([]ReportCategory(nil), ReportCategoryOrder...)
	}
	c.countView(ctx, res.row.ID, middleware.SecurityClientIP(g))
	setPageHeaders(g.Writer)
	if err := currentRenderer().Page(g.Writer, v); err != nil {
		slog.Warn("claudex sharing: rendering a page failed", "error", err)
	}
}

// countView counts at most one view per visitor, share and hour (Redis);
// without Redis nothing is counted. Failures never affect the page.
func (c *Component) countView(ctx context.Context, id int64, clientIP string) {
	if c.env == nil || c.env.Redis == nil {
		return
	}
	now := c.now()
	key := "claudex:share:view:" + strconv.FormatInt(id, 10) + ":" + c.visitorHash(clientIP, now)
	first, err := c.env.Redis.SetNX(ctx, key, 1, viewDedupeWindow).Result()
	if err != nil || !first {
		return
	}
	if err := c.store.countView(ctx, id, now); err != nil {
		slog.Warn("claudex sharing: counting a view failed", "error", err)
	}
}

// artifactIndex reads :n of a share with count artifacts.
func artifactIndex(g *gin.Context, count int) (int, bool) {
	n, err := strconv.Atoi(g.Param("n"))
	return n, err == nil && n >= 0 && n < count && strconv.Itoa(n) == g.Param("n")
}

// GET /s/:token/a/:n: the artifact document shown in the page's sandboxed
// iframe. With a separate content host it is served only there.
func (c *Component) getArtifact(g *gin.Context) {
	ctx := g.Request.Context()
	s := c.setting.Cached(ctx)
	if s.ContentBaseURL != "" && !onContentHost(s, g.Request.Host) {
		c.notice(g, http.StatusNotFound, NoticeNotFound, "")
		return
	}
	res, err := c.resolveToken(ctx, g.Param("token"), true)
	if err != nil {
		c.pageError(g, err)
		return
	}
	n, ok := artifactIndex(g, len(res.snapshot.Artifacts))
	if !ok {
		c.notice(g, http.StatusNotFound, NoticeNotFound, "")
		return
	}
	v := &ArtifactView{
		Token: res.row.Token, Index: n, Artifact: res.snapshot.Artifacts[n],
		FrameAncestors: "'self'", AssetBase: assetPrefix,
	}
	if s.ContentBaseURL != "" {
		if origin := originOf(res.base); origin != "" {
			v.FrameAncestors = origin
		}
	}
	setPageHeaders(g.Writer)
	if err := currentRenderer().Artifact(g.Writer, v); err != nil {
		slog.Warn("claudex sharing: rendering an artifact failed", "error", err)
	}
}

// GET /s/:token/raw/:n: the artifact source as a plain-text download.
func (c *Component) getRaw(g *gin.Context) {
	ctx := g.Request.Context()
	if onContentHost(c.setting.Cached(ctx), g.Request.Host) {
		c.notice(g, http.StatusNotFound, NoticeNotFound, "")
		return
	}
	res, err := c.resolveToken(ctx, g.Param("token"), true)
	if err != nil {
		c.pageError(g, err)
		return
	}
	n, ok := artifactIndex(g, len(res.snapshot.Artifacts))
	if !ok {
		c.notice(g, http.StatusNotFound, NoticeNotFound, "")
		return
	}
	a := res.snapshot.Artifacts[n]
	setPageHeaders(g.Writer)
	h := g.Writer.Header()
	h.Set("Content-Type", "text/plain; charset=utf-8")
	h.Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": rawFileName(a, n)}))
	h.Set("Content-Security-Policy", "sandbox; default-src 'none'")
	h.Set("X-Frame-Options", "DENY")
	g.Writer.WriteHeader(http.StatusOK)
	_, _ = g.Writer.Write([]byte(a.Content))
}

// GET /s/_assets/*path: static files of the viewer (e.g. the mermaid
// runtime), on both hosts.
func (c *Component) getAsset(g *gin.Context) {
	path := strings.TrimPrefix(g.Param("path"), "/")
	if path == "" || strings.Contains(path, "..") || strings.ContainsRune(path, '\\') {
		c.notice(g, http.StatusNotFound, NoticeNotFound, "")
		return
	}
	setPageHeaders(g.Writer)
	if !currentRenderer().Asset(g.Writer, g.Request, path) {
		c.notice(g, http.StatusNotFound, NoticeNotFound, "")
	}
}

// reportOutcome is the result of a report attempt.
type reportOutcome int

const (
	reportAccepted reportOutcome = iota
	reportUnknownShare
	reportBadInput
	reportLimited
	reportFailed
)

// report files an abuse report for a visible share (a taken-down or
// hidden share answers reportUnknownShare).
func (c *Component) report(ctx context.Context, token string, in reportInput, clientIP string) reportOutcome {
	s := c.setting.Cached(ctx)
	if !s.AllowReports {
		return reportUnknownShare
	}
	res, err := c.resolveToken(ctx, token, false)
	if err != nil {
		if errors.Is(err, errNotVisible) || errors.Is(err, errRemoved) {
			return reportUnknownShare
		}
		slog.Warn("claudex sharing: report lookup failed", "error", err)
		return reportFailed
	}
	return c.fileReport(ctx, res.row.ID, in, clientIP)
}

// reportText trims a report field, drops NUL characters and cuts it to limit
// runes; false when it is not valid UTF-8.
func reportText(s string, limit int) (string, bool) {
	s = strings.TrimSpace(dropNUL(s))
	if !utf8.ValidString(s) {
		return "", false
	}
	if utf8.RuneCountInString(s) > limit {
		s = strings.TrimSpace(string([]rune(s)[:limit]))
	}
	return s, true
}

// fileReport checks a report's fields and stores it for the share. The
// visitor (an address, or "user:<id>" for a signed-in account) files at most
// reportsPerIPPerHour reports an hour and one per share a day; a duplicate
// is accepted silently.
func (c *Component) fileReport(ctx context.Context, shareID int64, in reportInput, visitor string) reportOutcome {
	in.Reason = strings.TrimSpace(in.Reason)
	if !reportReasons[in.Reason] {
		return reportBadInput
	}
	var ok bool
	if in.Detail, ok = reportText(in.Detail, maxReportDetailRunes); !ok {
		return reportBadInput
	}
	if in.ReporterName, ok = reportText(in.ReporterName, maxReporterRunes); !ok {
		return reportBadInput
	}
	if in.ReporterEmail, ok = reportText(in.ReporterEmail, maxReporterRunes); !ok {
		return reportBadInput
	}
	now := c.now()
	hash := c.visitorHash(visitor, now)
	if c.env != nil {
		if allowed, _ := c.env.Allow(ctx, "sharing.report:ip:"+hash, reportsPerIPPerHour, time.Hour); !allowed {
			return reportLimited
		}
	}
	if _, err := c.store.insertReport(ctx, shareID, in, hash, now); err != nil {
		slog.Warn("claudex sharing: storing a report failed", "error", err)
		return reportFailed
	}
	return reportAccepted
}

// POST /s/:token/report: the page's Report form, without script (live
// claude.ai report form, 2026-10-12): category (one the form takes),
// reporter_name, reporter_email and notes, all but the category optional,
// and "Opt out of training on this report", a checkbox shown as a switch,
// off unless the visitor turns it on, so it is sent only when on. A form
// from before the categories (reason, detail) is still taken. Duplicates
// from the same visitor are accepted silently.
func (c *Component) postReportForm(g *gin.Context) {
	ctx := g.Request.Context()
	if onContentHost(c.setting.Cached(ctx), g.Request.Host) {
		c.notice(g, http.StatusNotFound, NoticeNotFound, "")
		return
	}
	if g.Request.Body == nil {
		g.Request.Body = http.NoBody
	}
	g.Request.Body = http.MaxBytesReader(g.Writer, g.Request.Body, maxReportBodyBytes)
	token := g.Param("token")
	back := ""
	if ValidToken(token) {
		back = sharePath(token)
	}
	if err := g.Request.ParseForm(); err != nil {
		c.notice(g, http.StatusBadRequest, NoticeReportInvalid, back)
		return
	}
	form := g.Request.PostForm
	in, ok := reportFormInput(form.Get("category"), form.Get("reason"))
	if !ok {
		c.notice(g, http.StatusBadRequest, NoticeReportInvalid, back)
		return
	}
	in.Detail = form.Get("notes")
	if in.Category == "" {
		in.Detail = form.Get("detail")
	}
	in.ReporterName, in.ReporterEmail = form.Get("reporter_name"), form.Get("reporter_email")
	in.OptOutOfTraining = formSwitchOn(form.Get("opt_out_of_training"))
	switch c.report(ctx, token, in, middleware.SecurityClientIP(g)) {
	case reportAccepted:
		c.notice(g, http.StatusOK, NoticeReportReceived, back)
	case reportBadInput:
		c.notice(g, http.StatusBadRequest, NoticeReportInvalid, back)
	case reportLimited:
		c.notice(g, http.StatusTooManyRequests, NoticeRateLimited, back)
	case reportFailed:
		c.notice(g, http.StatusServiceUnavailable, NoticeNotFound, "")
	default:
		c.notice(g, http.StatusNotFound, NoticeNotFound, "")
	}
}

// reportFormInput reads the form's choice: a category the form takes (filed
// under its service reason), or, from a page drawn before the categories,
// a service reason. false for anything else, the categories the form sends
// elsewhere included.
func reportFormInput(category, reason string) (reportInput, bool) {
	if category = strings.ToLower(strings.TrimSpace(category)); category != "" {
		r, ok := reportCategories[category]
		return reportInput{Reason: r, Category: category}, ok
	}
	reason = strings.TrimSpace(reason)
	return reportInput{Reason: reason}, reportReasons[reason]
}

// formSwitchOn reads a checkbox: a browser sends its value ("on" without
// one) only when it is checked.
func formSwitchOn(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "on", "1", "true", "yes":
		return true
	}
	return false
}
