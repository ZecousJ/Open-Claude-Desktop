package feedback

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// Intake limits (design 2.9).
const (
	maxBodyBytes       = 64 << 10
	maxReportsPerBatch = 50
	maxMessageChars    = 300
	maxCodeChars       = 64
	maxRequestIDChars  = 128
	maxModelChars      = 200
	maxOSVersionChars  = 64
	maxContextChars    = 200
	maxCommentChars    = 4000
	maxExcerptChars    = 20000
	maxCategories      = 10
	// A report may be stamped a little ahead of the server clock; further
	// ahead is clamped to the receive time.
	maxClockSkew = 5 * time.Minute
)

// Diagnostic kinds the desktop app sends.
var diagnosticKinds = map[string]bool{
	"turn_error":       true,
	"gateway_refusal":  true,
	"crash":            true,
	"update_failed":    true,
	"mcp_start_failed": true,
	"provision_failed": true,
}

// contextKeys is the whitelist of diagnostic context keys; any other key is
// dropped.
var contextKeys = map[string]bool{
	"surface":     true,
	"reason":      true,
	"http_status": true,
	"retry_count": true,
	"feature":     true,
}

var categoryPattern = regexp.MustCompile(`^[a-z0-9_-]{1,32}$`)

// Errors of the intake endpoints (design 1.8; the last three are B8
// additions for malformed requests).
var (
	ErrFeedbackDisabled = infraerrors.NotFound("CLAUDEX_FEEDBACK_DISABLED",
		"This server doesn't collect diagnostics or feedback.")
	ErrConsentRequired = infraerrors.BadRequest("CLAUDEX_CONSENT_REQUIRED",
		"Reports are only accepted after the user agrees to help improve Claudex.")
	ErrReportQuotaExceeded = infraerrors.TooManyRequests("CLAUDEX_REPORT_QUOTA_EXCEEDED",
		"Too many reports today. Try again later.")
	ErrRequestTooLarge = infraerrors.New(http.StatusRequestEntityTooLarge, "CLAUDEX_REQUEST_TOO_LARGE",
		"The request body is too large.")
	errStoreFailed = infraerrors.InternalServer("CLAUDEX_FEEDBACK_STORE_FAILED",
		"Couldn't save the report. Try again later.")
	errUnauthorized = infraerrors.Unauthorized("UNAUTHORIZED", "Sign in first.")
)

// invalidReport is the 400 for a malformed report (metadata field, rule).
func invalidReport(field, rule, message string) error {
	return infraerrors.BadRequest("CLAUDEX_REPORT_INVALID", message).
		WithMetadata(map[string]string{"field": field, "rule": rule})
}

// DiagnosticsResult is the answer of POST /api/v1/claudex/diagnostics.
// Dropped counts new reports over the user's daily cap (a B8 addition; the
// client removes the whole batch from its queue on 200).
type DiagnosticsResult struct {
	Accepted   int `json:"accepted"`
	Duplicates int `json:"duplicates"`
	Dropped    int `json:"dropped"`
}

// FeedbackResult is the answer of POST /api/v1/claudex/feedback.
type FeedbackResult struct {
	Accepted       bool `json:"accepted"`
	Duplicate      bool `json:"duplicate"`
	ExcerptDropped bool `json:"excerpt_dropped"`
}

// readBody reads at most maxBodyBytes of the request body.
func readBody(c *gin.Context) ([]byte, error) {
	if c.Request.ContentLength > maxBodyBytes {
		return nil, ErrRequestTooLarge
	}
	if c.Request.Body == nil {
		return nil, invalidReport("body", "json", "The request body must be a JSON object.")
	}
	raw, err := io.ReadAll(http.MaxBytesReader(c.Writer, c.Request.Body, maxBodyBytes))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return nil, ErrRequestTooLarge
		}
		return nil, invalidReport("body", "read", "Couldn't read the request body.")
	}
	return raw, nil
}

// consented reports whether the body carries "consent": true exactly.
func consented(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("true"))
}

// intakeStart runs the steps both intake endpoints share after SkipAudit: no
// caching, signed-in user, collection turned on, body within the size limit.
func (c *Component) intakeStart(g *gin.Context, enabled bool) (int64, []byte, bool) {
	g.Header("Cache-Control", "no-store")
	userID, ok := core.Subject(g)
	if !ok {
		response.ErrorFrom(g, errUnauthorized)
		return 0, nil, false
	}
	if !enabled {
		response.ErrorFrom(g, ErrFeedbackDisabled)
		return 0, nil, false
	}
	raw, err := readBody(g)
	if err != nil {
		response.ErrorFrom(g, err)
		return 0, nil, false
	}
	return userID, raw, true
}

type diagnosticsRequest struct {
	Consent json.RawMessage   `json:"consent"`
	Reports []json.RawMessage `json:"reports"`
}

type diagnosticReport struct {
	ID           string                     `json:"id"`
	OccurredAt   string                     `json:"occurred_at"`
	Kind         string                     `json:"kind"`
	Code         string                     `json:"code"`
	Message      string                     `json:"message"`
	RequestID    string                     `json:"request_id"`
	Model        string                     `json:"model"`
	AppVersion   string                     `json:"app_version"`
	CodexVersion string                     `json:"codex_version"`
	Platform     string                     `json:"platform"`
	Arch         string                     `json:"arch"`
	OSVersion    string                     `json:"os_version"`
	Context      map[string]json.RawMessage `json:"context"`
}

// POST /api/v1/claudex/diagnostics
func (c *Component) postDiagnostics(g *gin.Context) {
	// First line: no audit entry, so the report text never reaches
	// audit_logs (design 1.5), whatever the outcome.
	middleware.SkipAudit(g)
	cfg := c.setting.Cached(g.Request.Context()).Diagnostics
	userID, raw, ok := c.intakeStart(g, cfg.Enabled)
	if !ok {
		return
	}
	var req diagnosticsRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		response.ErrorFrom(g, invalidReport("body", "json", "The request body must be a JSON object."))
		return
	}
	if !consented(req.Consent) {
		response.ErrorFrom(g, ErrConsentRequired)
		return
	}
	if len(req.Reports) == 0 || len(req.Reports) > maxReportsPerBatch {
		response.ErrorFrom(g, invalidReport("reports", "count", "Send between 1 and "+strconv.Itoa(maxReportsPerBatch)+" reports."))
		return
	}
	platform, arch, version, _ := core.ClientInfo(g)
	now := c.now()
	deviceID := c.deviceRowID(g, userID)
	rows := make([]diagnosticRow, 0, len(req.Reports))
	for i, item := range req.Reports {
		row, err := sanitizeDiagnostic(i, item, now, platform, arch, version)
		if err != nil {
			response.ErrorFrom(g, err)
			return
		}
		row.DeviceID = deviceID
		rows = append(rows, row)
	}
	res, err := c.store.insertDiagnostics(g.Request.Context(), userID, rows, cfg.MaxPerUserPerDay)
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	if res.Accepted == 0 && res.Dropped > 0 {
		quotaExceeded(g, res, cfg.MaxPerUserPerDay)
		return
	}
	response.Success(g, DiagnosticsResult{Accepted: res.Accepted, Duplicates: res.Duplicates, Dropped: res.Dropped})
}

func quotaExceeded(g *gin.Context, res insertResult, limit int) {
	seconds := int64(math.Ceil(res.RetryAfter.Seconds()))
	if seconds < 1 {
		seconds = 1
	}
	s := strconv.FormatInt(seconds, 10)
	g.Header("Retry-After", s)
	response.ErrorFrom(g, ErrReportQuotaExceeded.WithMetadata(map[string]string{
		"limit":               strconv.Itoa(limit),
		"retry_after_seconds": s,
	}))
}

// sanitizeDiagnostic validates one report (id, kind) and cleans every other
// field: free text is redacted and cut, unknown context keys are dropped,
// and a gateway_refusal never keeps a message (only the error code and the
// server's claudex.reason in context).
func sanitizeDiagnostic(i int, item json.RawMessage, now time.Time, hdrPlatform, hdrArch, hdrVersion string) (diagnosticRow, error) {
	field := "reports[" + strconv.Itoa(i) + "]"
	var r diagnosticReport
	if err := json.Unmarshal(item, &r); err != nil {
		return diagnosticRow{}, invalidReport(field, "json", "Each report must be a JSON object with string fields.")
	}
	id, err := uuid.Parse(strings.TrimSpace(r.ID))
	if err != nil {
		return diagnosticRow{}, invalidReport(field+".id", "uuid", "Each report needs a UUID id.")
	}
	kind := strings.TrimSpace(r.Kind)
	if !diagnosticKinds[kind] {
		return diagnosticRow{}, invalidReport(field+".kind", "enum", "Unknown report kind.")
	}
	row := diagnosticRow{
		ReportUUID:   id.String(),
		Kind:         kind,
		Code:         cleanText(r.Code, maxCodeChars, false),
		RequestID:    cleanText(r.RequestID, maxRequestIDChars, false),
		Model:        cleanText(r.Model, maxModelChars, false),
		AppVersion:   versionOr(r.AppVersion, hdrVersion),
		CodexVersion: versionOr(r.CodexVersion, ""),
		Platform:     platformOr(r.Platform, hdrPlatform),
		Arch:         archOr(r.Arch, hdrArch),
		OSVersion:    cleanText(r.OSVersion, maxOSVersionChars, false),
		Context:      sanitizeContext(r.Context),
		OccurredAt:   occurredAt(r.OccurredAt, now),
	}
	if kind != "gateway_refusal" {
		row.Message = cleanText(r.Message, maxMessageChars, false)
	}
	return row, nil
}

// sanitizeContext keeps the whitelisted keys whose values are strings (cleaned,
// at most 200 characters), finite numbers or booleans.
func sanitizeContext(in map[string]json.RawMessage) map[string]any {
	out := map[string]any{}
	for key, raw := range in {
		if !contextKeys[key] {
			continue
		}
		dec := json.NewDecoder(bytes.NewReader(raw))
		dec.UseNumber()
		var v any
		if err := dec.Decode(&v); err != nil {
			continue
		}
		switch val := v.(type) {
		case string:
			if s := cleanText(val, maxContextChars, false); s != "" {
				out[key] = s
			}
		case bool:
			out[key] = val
		case json.Number:
			f, err := val.Float64()
			if err == nil && !math.IsInf(f, 0) && !math.IsNaN(f) && len(val) <= 32 {
				out[key] = val
			}
		}
	}
	return out
}

func occurredAt(s string, now time.Time) time.Time {
	t, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(s))
	if err != nil || t.IsZero() || t.After(now.Add(maxClockSkew)) {
		return now.UTC()
	}
	return t.UTC()
}

func versionOr(v, fallback string) string {
	if v = strings.TrimSpace(v); core.ValidVersion(v) {
		return v
	}
	return fallback
}

func platformOr(v, fallback string) string {
	if v = strings.TrimSpace(v); core.ValidPlatform(v) {
		return v
	}
	return fallback
}

func archOr(v, fallback string) string {
	if v = strings.TrimSpace(v); core.ValidArch(v) {
		return v
	}
	return fallback
}

// deviceRowID resolves X-Claudex-Device-Id to the claudex_devices row of the
// user (B4's directory); nil when there is none. The raw device id itself
// is never stored.
func (c *Component) deviceRowID(g *gin.Context, userID int64) *int64 {
	_, _, _, raw := core.ClientInfo(g)
	if raw == "" || c.env == nil || c.env.Peers.Devices == nil {
		return nil
	}
	dev, ok := c.env.Peers.Devices.LookupByDeviceID(g.Request.Context(), userID, raw)
	if !ok || dev == nil || dev.ID <= 0 || dev.UserID != userID {
		return nil
	}
	id := dev.ID
	return &id
}

type feedbackRequest struct {
	Consent             json.RawMessage `json:"consent"`
	ID                  string          `json:"id"`
	Rating              string          `json:"rating"`
	Categories          []string        `json:"categories"`
	Comment             string          `json:"comment"`
	Model               string          `json:"model"`
	RequestID           string          `json:"request_id"`
	ConversationExcerpt *string         `json:"conversation_excerpt"`
	AppVersion          string          `json:"app_version"`
	Platform            string          `json:"platform"`
}

// POST /api/v1/claudex/feedback
func (c *Component) postFeedback(g *gin.Context) {
	middleware.SkipAudit(g) // first line, as for diagnostics
	cfg := c.setting.Cached(g.Request.Context()).Feedback
	userID, raw, ok := c.intakeStart(g, cfg.Enabled)
	if !ok {
		return
	}
	var req feedbackRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		response.ErrorFrom(g, invalidReport("body", "json", "The request body must be a JSON object."))
		return
	}
	if !consented(req.Consent) {
		response.ErrorFrom(g, ErrConsentRequired)
		return
	}
	id, err := uuid.Parse(strings.TrimSpace(req.ID))
	if err != nil {
		response.ErrorFrom(g, invalidReport("id", "uuid", "Feedback needs a UUID id."))
		return
	}
	rating := strings.TrimSpace(req.Rating)
	if rating != "up" && rating != "down" {
		response.ErrorFrom(g, invalidReport("rating", "enum", "Rating must be up or down."))
		return
	}
	platform, _, version, _ := core.ClientInfo(g)
	row := feedbackRow{
		FeedbackUUID: id.String(),
		Rating:       rating,
		Categories:   sanitizeCategories(req.Categories),
		Comment:      cleanText(req.Comment, maxCommentChars, true),
		Model:        cleanText(req.Model, maxModelChars, false),
		RequestID:    cleanText(req.RequestID, maxRequestIDChars, false),
		AppVersion:   versionOr(req.AppVersion, version),
		Platform:     platformOr(req.Platform, platform),
	}
	excerptDropped := false
	if req.ConversationExcerpt != nil && strings.TrimSpace(*req.ConversationExcerpt) != "" {
		// Kept only when the administrator allows excerpts; the user opted in
		// by attaching it.
		if cfg.AllowConversationExcerpt {
			if excerpt := cleanText(*req.ConversationExcerpt, maxExcerptChars, true); excerpt != "" {
				row.ConversationExcerpt = &excerpt
			}
		} else {
			excerptDropped = true
		}
	}
	res, err := c.store.insertFeedback(g.Request.Context(), userID, row, cfg.MaxPerUserPerDay)
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	if res.Accepted == 0 && res.Dropped > 0 {
		quotaExceeded(g, res, cfg.MaxPerUserPerDay)
		return
	}
	response.Success(g, FeedbackResult{Accepted: true, Duplicate: res.Duplicates > 0, ExcerptDropped: excerptDropped})
}

// sanitizeCategories keeps up to ten distinct lowercase tokens
// ([a-z0-9_-], at most 32 characters); anything else is dropped.
func sanitizeCategories(in []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, raw := range in {
		v := strings.ToLower(strings.TrimSpace(raw))
		if !categoryPattern.MatchString(v) || seen[v] {
			continue
		}
		seen[v] = true
		out = append(out, v)
		if len(out) == maxCategories {
			break
		}
	}
	return out
}
