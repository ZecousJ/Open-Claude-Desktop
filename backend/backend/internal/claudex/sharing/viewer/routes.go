package viewer

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
)

// ErrNotFound is what Source.Lookup and Reporter.Report return for a token
// that is unknown, revoked or expired, or whose kind (or sharing as a whole)
// is switched off. The viewer answers all of them with the same 404 page.
var ErrNotFound = errors.New("viewer: share not found")

// ErrReportsOff is what Reporter.Report returns while reports are switched
// off (404).
var ErrReportsOff = errors.New("viewer: reports are off")

// ErrTooManyReports is what Reporter.Report returns when the visitor's
// report limit is used up (429).
var ErrTooManyReports = errors.New("viewer: too many reports")

// Share is a share as the viewer needs it.
type Share struct {
	// Removed marks a share an administrator took down (410).
	Removed bool
	// SharedAt is when the snapshot was taken (footer and meta line).
	SharedAt time.Time
	// Snapshot is the decoded body (DecodeSnapshot); it is not read for a
	// removed share.
	Snapshot Snapshot
}

// Source is what the sharing component gives the viewer.
type Source interface {
	// Options returns the current page options.
	Options(ctx context.Context) Options
	// Lookup returns the share with a well-formed token, or ErrNotFound.
	Lookup(ctx context.Context, token string) (*Share, error)
}

// ViewCounter is implemented by a Source that counts page views. It is
// called after a share page (not an artifact document) was served; it
// should deduplicate per visitor itself and must not block for long.
type ViewCounter interface {
	CountView(ctx context.Context, token, clientIP string)
}

// Report is one report from the public page.
type Report struct {
	Reason string // one of ReportReasons()
	Detail string // at most MaxReportDetail characters
	// Category is the live report form's category (empty from a form drawn
	// before the categories); Reason is then the reason it is filed under.
	Category string
	// ReporterName and ReporterEmail are optional, at most MaxReporter
	// characters each.
	ReporterName  string
	ReporterEmail string
	// OptOutOfTraining is the form's "Opt out of training on this report"
	// switch (live claude.ai report form, 2026-10-12), off unless the
	// visitor turned it on.
	OptOutOfTraining bool
}

// Reporter is implemented by a Source that takes reports. It applies its own
// rate limit (ErrTooManyReports) and stores only a salted hash of the IP.
type Reporter interface {
	Report(ctx context.Context, token string, r Report, clientIP string) error
}

// maxReportBody bounds the report form body.
const maxReportBody = 8 << 10

// Register adds the public pages to g, the core.PageRouter group mounted at
// PathPrefix (per-IP rate limit only, no login, no audit):
//
//	GET  /_assets/*path     embedded Mermaid runtime
//	GET  /:token            share page
//	GET  /:token/a/:n       sandboxed artifact document n
//	GET  /:token/raw/:n     artifact n's source as a download
//	POST /:token/report     no-script report form
func Register(g gin.IRoutes, src Source) {
	h := &handlers{src: src}
	g.GET("/_assets/*path", h.asset)
	g.GET("/:token", h.page)
	g.GET("/:token/a/:n", h.content)
	g.GET("/:token/raw/:n", h.raw)
	g.POST("/:token/report", h.report)
}

type handlers struct{ src Source }

func (h *handlers) options(c *gin.Context) resolved {
	return resolve(h.src.Options(c.Request.Context()))
}

// lookup validates the token and loads the share; on failure it has written
// the response and returns nil.
func (h *handlers) lookup(c *gin.Context, r resolved, plain bool) *Share {
	token := c.Param("token")
	if !ValidToken(token) {
		h.notFound(c, r, plain)
		return nil
	}
	share, err := h.src.Lookup(c.Request.Context(), token)
	switch {
	case errors.Is(err, ErrNotFound) || (err == nil && share == nil):
		h.notFound(c, r, plain)
		return nil
	case err != nil:
		if plain {
			writePlain(c, http.StatusInternalServerError, "Something went wrong.")
		} else {
			writeStatus(c.Writer, http.StatusInternalServerError, r, "Something went wrong", "Try again in a moment.", "")
		}
		return nil
	case share.Removed:
		if plain {
			writePlain(c, http.StatusGone, removedHeading+".")
		} else {
			writeStatus(c.Writer, http.StatusGone, r, removedHeading, "The administrator of "+r.siteName+" took this shared content down.", "")
		}
		return nil
	}
	if err := share.Snapshot.Check(); err != nil {
		h.notFound(c, r, plain)
		return nil
	}
	return share
}

func (h *handlers) notFound(c *gin.Context, r resolved, plain bool) {
	if plain {
		writePlain(c, http.StatusNotFound, notFoundHeading+".")
		return
	}
	writeStatus(c.Writer, http.StatusNotFound, r, notFoundHeading, notFoundDetail, "")
}

func writePlain(c *gin.Context, status int, msg string) {
	h := c.Writer.Header()
	setCommonHeaders(h)
	h.Set("Content-Security-Policy", rawCSP)
	h.Set("Content-Type", "text/plain; charset=utf-8")
	c.Writer.WriteHeader(status)
	_, _ = c.Writer.WriteString(msg + "\n")
}

func (h *handlers) canReport(r resolved) bool {
	_, ok := h.src.(Reporter)
	return ok && r.reports
}

func (h *handlers) page(c *gin.Context) {
	r := h.options(c)
	if r.isContentHost(c.Request.Host) {
		h.notFound(c, r, true)
		return
	}
	share := h.lookup(c, r, false)
	if share == nil {
		return
	}
	token := c.Param("token")
	if err := writePage(c.Writer, http.StatusOK, share, token, r, h.canReport(r)); err != nil {
		_ = c.Error(err)
		return
	}
	if vc, ok := h.src.(ViewCounter); ok {
		vc.CountView(c.Request.Context(), token, c.ClientIP())
	}
}

// artifactIndex reads :n; ok is false (and a 404 written) when it is not an
// artifact of the share.
func (h *handlers) artifactIndex(c *gin.Context, r resolved, share *Share) (int, bool) {
	n, err := strconv.Atoi(c.Param("n"))
	if err != nil || n < 0 || n >= len(share.Snapshot.Artifacts) || strconv.Itoa(n) != c.Param("n") {
		h.notFound(c, r, true)
		return 0, false
	}
	return n, true
}

// contentHostOnly answers 404 for artifact documents, sources and assets
// requested on the page host while a separate content origin is set.
func contentHostOnly(c *gin.Context, r resolved) bool {
	return !r.hasContent || r.isContentHost(c.Request.Host)
}

func (h *handlers) content(c *gin.Context) {
	r := h.options(c)
	if !contentHostOnly(c, r) {
		h.notFound(c, r, true)
		return
	}
	share := h.lookup(c, r, true)
	if share == nil {
		return
	}
	n, ok := h.artifactIndex(c, r, share)
	if !ok {
		return
	}
	if err := writeArtifact(c.Writer, share.Snapshot.Artifacts[n], r); err != nil {
		_ = c.Error(err)
	}
}

func (h *handlers) raw(c *gin.Context) {
	r := h.options(c)
	if !contentHostOnly(c, r) {
		h.notFound(c, r, true)
		return
	}
	share := h.lookup(c, r, true)
	if share == nil {
		return
	}
	n, ok := h.artifactIndex(c, r, share)
	if !ok {
		return
	}
	if err := RenderRaw(c.Writer, share.Snapshot.Artifacts[n]); err != nil {
		_ = c.Error(err)
	}
}

func (h *handlers) asset(c *gin.Context) {
	r := h.options(c)
	if !contentHostOnly(c, r) {
		h.notFound(c, r, true)
		return
	}
	ServeAsset(c.Writer, c.Request, c.Param("path"))
}

func (h *handlers) report(c *gin.Context) {
	r := h.options(c)
	reporter, ok := h.src.(Reporter)
	if !ok || !r.reports || r.isContentHost(c.Request.Host) {
		h.notFound(c, r, false)
		return
	}
	share := h.lookup(c, r, false)
	if share == nil {
		return
	}
	token := c.Param("token")
	back := "../" + token
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxReportBody)
	if err := c.Request.ParseForm(); err != nil {
		writeStatus(c.Writer, http.StatusBadRequest, r, "Your report wasn't sent", "The form could not be read. Go back and try again.", back)
		return
	}
	form := c.Request.PostForm
	report := Report{Reason: form.Get("reason"), Detail: form.Get("detail")}
	if cat := strings.ToLower(strings.TrimSpace(form.Get("category"))); cat != "" {
		reason, ok := categoryReason(cat)
		if !ok {
			writeStatus(c.Writer, http.StatusBadRequest, r, "Your report wasn't sent", "Choose a report reason this form takes.", back)
			return
		}
		report = Report{Reason: reason, Category: cat, Detail: form.Get("notes")}
	} else if !validReason(report.Reason) {
		writeStatus(c.Writer, http.StatusBadRequest, r, "Your report wasn't sent", "Choose a reason for your report.", back)
		return
	}
	report.Detail = formText(report.Detail, MaxReportDetail)
	report.ReporterName = formText(form.Get("reporter_name"), MaxReporter)
	report.ReporterEmail = formText(form.Get("reporter_email"), MaxReporter)
	optOut := switchOn(c.Request.PostForm.Get("opt_out_of_training"))
	report.OptOutOfTraining = optOut
	err := reporter.Report(c.Request.Context(), token, report, c.ClientIP())
	switch {
	case err == nil:
		writeStatus(c.Writer, http.StatusOK, r, "Thanks for your report", "The administrator will review this.", back)
	case errors.Is(err, ErrNotFound) || errors.Is(err, ErrReportsOff):
		h.notFound(c, r, false)
	case errors.Is(err, ErrTooManyReports):
		writeStatus(c.Writer, http.StatusTooManyRequests, r, "Too many reports", "Too many reports were sent from your network. Try again later.", back)
	default:
		writeStatus(c.Writer, http.StatusInternalServerError, r, "Your report wasn't sent", "Something went wrong. Try again in a moment.", back)
	}
}

// formText trims a form field, replaces invalid UTF-8 and cuts it to limit
// characters.
func formText(v string, limit int) string {
	v = strings.TrimSpace(strings.ToValidUTF8(v, "\uFFFD"))
	if utf8.RuneCountInString(v) > limit {
		v = string([]rune(v)[:limit])
	}
	return v
}

// switchOn reads a checkbox: a browser sends its value ("on" without one)
// only when it is checked.
func switchOn(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "on", "1", "true", "yes":
		return true
	}
	return false
}
