package gatewayhook

import (
	"bufio"
	"bytes"
	"encoding/json"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// Refusal is a gateway rejection as seen by the describers.
type Refusal struct {
	Status   int
	Code     string // upstream code: "API_KEY_DISABLED", "insufficient_quota", ...
	Message  string
	APIKeyID int64
	UserID   int64
	GroupID  *int64
}

// RefusalDetail is the "claudex" object appended to gateway errors of Claudex
// device-key requests (design 2.7). The desktop client accepts it only when V
// is 1 and the status is 401, 402, 403, 426 or 429.
type RefusalDetail struct {
	V                 int        `json:"v"`
	Reason            string     `json:"reason"`
	Kind              string     `json:"kind"`
	Window            string     `json:"window,omitempty"`
	ResetsAt          *time.Time `json:"resets_at,omitempty"`
	RetryAfterSeconds int        `json:"retry_after_seconds,omitempty"`
	LimitUSD          *float64   `json:"limit_usd,omitempty"`
	UsedUSD           *float64   `json:"used_usd,omitempty"`
	RuleID            *int64     `json:"rule_id,omitempty"`
	RuleKind          string     `json:"rule_kind,omitempty"` // B5 rule kind of RULE_LIMIT: session, all_models, models
	Label             string     `json:"label,omitempty"`
	Models            []string   `json:"models,omitempty"`
	Reprovision       bool       `json:"reprovision"`
	Action            string     `json:"action,omitempty"`
	MinimumVersion    string     `json:"minimum_version,omitempty"`
	LatestVersion     string     `json:"latest_version,omitempty"`
	DownloadURL       string     `json:"download_url,omitempty"`
	Message           string     `json:"message"`
}

// refusalBodyLimit is the largest error body EnrichRefusals rewrites. A bigger
// JSON object body is dropped and replaced by oversizedErrorBody (passed
// through, it could carry a forged top-level "claudex" key to the client,
// R13); any other bigger body passes through unchanged.
const refusalBodyLimit = 64 << 10

// oversizedErrorBody replaces a device-key JSON error body over the limit.
// Refusal statuses still get their "claudex" object appended.
var oversizedErrorBody = []byte(`{"error":{"type":"upstream_error","message":"The upstream error response was too large and was dropped."}}`)

// RefusalStatuses are the status codes that get a "claudex" object.
var RefusalStatuses = map[int]bool{
	http.StatusUnauthorized:    true,
	http.StatusPaymentRequired: true,
	http.StatusForbidden:       true,
	http.StatusUpgradeRequired: true,
	http.StatusTooManyRequests: true,
}

// EnrichRefusals is the H6 response rewriter at the front of the /v1 group.
//
// It only touches responses of requests marked with MarkDevice whose status
// is 400 or more and whose body is a JSON object; everything else (other
// keys, successes, SSE streams, WebSocket upgrades, non-JSON bodies of any
// size) passes through byte for byte. For those error responses it removes
// any top-level "claudex" key the upstream wrote (an apikey account's base_url
// may point at an untrusted relay) and, for 401/402/403/426/429, appends the
// detail preset with SetDetail or produced by the first registered describer.
// A JSON object body over 64 KB is not parsed: it is dropped and replaced by
// a short upstream_error body (the status is kept).
func EnrichRefusals() gin.HandlerFunc {
	return func(c *gin.Context) {
		w := &refusalWriter{ResponseWriter: c.Writer, c: c}
		c.Writer = w
		defer func() {
			c.Writer = w.ResponseWriter
		}()
		c.Next()
		w.finish()
	}
}

type refusalWriter struct {
	gin.ResponseWriter
	c         *gin.Context
	decided   bool
	buffering bool
	dropping  bool // a JSON body went over the limit: discard the rest
	buf       bytes.Buffer
}

// decide picks passthrough or buffering on the first body write, when the
// status and the device mark are final.
func (w *refusalWriter) decide() {
	if w.decided {
		return
	}
	w.decided = true
	if w.ResponseWriter.Written() || w.Status() < http.StatusBadRequest {
		return
	}
	if _, ok := Device(w.c); ok {
		w.buffering = true
	}
}

func (w *refusalWriter) Write(data []byte) (int, error) {
	w.decide()
	if w.dropping {
		return len(data), nil
	}
	if !w.buffering {
		return w.ResponseWriter.Write(data)
	}
	if w.buf.Len()+len(data) > refusalBodyLimit {
		if w.overflow(data) {
			return len(data), nil
		}
		return w.ResponseWriter.Write(data)
	}
	return w.buf.Write(data)
}

func (w *refusalWriter) WriteString(s string) (int, error) {
	w.decide()
	if w.dropping {
		return len(s), nil
	}
	if !w.buffering {
		return w.ResponseWriter.WriteString(s)
	}
	if w.buf.Len()+len(s) > refusalBodyLimit {
		if w.overflow([]byte(s)) {
			return len(s), nil
		}
		return w.ResponseWriter.WriteString(s)
	}
	return w.buf.WriteString(s)
}

// overflow handles a body that grows past the limit with next: a JSON object
// body is dropped (true; finish writes the replacement), anything else stops
// buffering and passes through (false; the caller writes next).
func (w *refusalWriter) overflow(next []byte) bool {
	if startsJSONObject(w.buf.Bytes(), next) {
		w.buffering = false
		w.dropping = true
		w.buf.Reset()
		return true
	}
	w.stopBuffering()
	return false
}

// startsJSONObject reports whether the body made of head then next begins
// with '{' after leading whitespace.
func startsJSONObject(head, next []byte) bool {
	for _, part := range [][]byte{head, next} {
		if trimmed := bytes.TrimLeft(part, " \t\r\n"); len(trimmed) > 0 {
			return trimmed[0] == '{'
		}
	}
	return false
}

// stopBuffering gives up on rewriting: the buffered prefix goes out as is.
func (w *refusalWriter) stopBuffering() {
	w.buffering = false
	if w.buf.Len() > 0 {
		_, _ = w.ResponseWriter.Write(w.buf.Bytes())
		w.buf.Reset()
	}
}

func (w *refusalWriter) WriteHeaderNow() {
	w.decide()
	if !w.buffering && !w.dropping {
		w.ResponseWriter.WriteHeaderNow()
	}
}

func (w *refusalWriter) Written() bool {
	return w.decided || w.ResponseWriter.Written()
}

func (w *refusalWriter) Size() int {
	if w.buffering || w.dropping {
		return w.buf.Len()
	}
	return w.ResponseWriter.Size()
}

func (w *refusalWriter) Flush() {
	w.decide()
	if !w.buffering && !w.dropping {
		w.ResponseWriter.Flush()
	}
}

func (w *refusalWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	w.decided = true
	w.buffering = false
	w.dropping = false
	return w.ResponseWriter.Hijack()
}

// Unwrap lets http.ResponseController reach the underlying writer.
func (w *refusalWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

func (w *refusalWriter) finish() {
	if !w.buffering && !w.dropping {
		return
	}
	body, dropped := w.buf.Bytes(), w.dropping
	if dropped {
		body = oversizedErrorBody
	}
	w.buffering, w.dropping = false, false
	out := rewriteRefusalBody(w.c, w.Status(), body)
	if dropped || !bytes.Equal(out, body) {
		w.ResponseWriter.Header().Del("Content-Length")
	}
	if len(out) == 0 {
		w.ResponseWriter.WriteHeaderNow()
		return
	}
	_, _ = w.ResponseWriter.Write(out)
}

// rewriteRefusalBody returns the body to send for a device-key error.
func rewriteRefusalBody(c *gin.Context, status int, body []byte) []byte {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return body
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &obj); err != nil {
		return body
	}
	_, hadClaudex := obj["claudex"]
	delete(obj, "claudex")

	var detail *RefusalDetail
	if RefusalStatuses[status] {
		refusal := parseRefusal(status, obj)
		if d, ok := Device(c); ok {
			refusal.APIKeyID, refusal.UserID, refusal.GroupID = d.APIKeyID, d.UserID, d.GroupID
		}
		detail = PresetDetail(c)
		if detail == nil {
			detail = describe(c, refusal)
		}
		if detail != nil {
			copied := *detail
			copied.V = 1
			if copied.Message == "" {
				copied.Message = refusal.Message
			}
			detail = &copied
		}
	}
	if detail == nil && !hadClaudex {
		return body
	}
	if detail != nil {
		raw, err := json.Marshal(detail)
		if err != nil {
			return body
		}
		obj["claudex"] = raw
	}
	out, err := json.Marshal(obj)
	if err != nil {
		return body
	}
	return out
}

func describe(c *gin.Context, r Refusal) *RefusalDetail {
	for _, d := range snapshot().describers {
		if detail := runDescriber(c, d, r); detail != nil {
			return detail
		}
	}
	return nil
}

func runDescriber(c *gin.Context, d RefusalDescriber, r Refusal) (detail *RefusalDetail) {
	defer func() {
		if rec := recover(); rec != nil {
			slog.Error("claudex gatewayhook: refusal describer panicked", "panic", rec)
			detail = nil
		}
	}()
	return d.Describe(c, r)
}

// parseRefusal reads the error shapes the gateway writes:
//
//	middleware  {"code":"API_KEY_DISABLED","message":"..."}
//	envelope    {"code":429,"message":"...","reason":"..."}
//	OpenAI      {"error":{"type":"...","code":"...","message":"..."}}
//	Anthropic   {"type":"error","error":{"type":"...","message":"..."}}
//	Google      {"error":{"code":401,"message":"...","status":"UNAUTHENTICATED"}}
func parseRefusal(status int, obj map[string]json.RawMessage) Refusal {
	r := Refusal{Status: status}
	if code := jsonString(obj["code"]); code != "" {
		r.Code = code
	} else if reason := jsonString(obj["reason"]); reason != "" {
		r.Code = reason
	}
	r.Message = jsonString(obj["message"])
	if raw, ok := obj["error"]; ok {
		var inner map[string]json.RawMessage
		if json.Unmarshal(raw, &inner) == nil {
			if r.Code == "" {
				for _, key := range []string{"code", "type", "status"} {
					if v := jsonString(inner[key]); v != "" {
						r.Code = v
						break
					}
				}
			}
			if r.Message == "" {
				r.Message = jsonString(inner["message"])
			}
		} else if r.Message == "" {
			r.Message = jsonString(raw)
		}
	}
	r.Code = strings.TrimSpace(r.Code)
	r.Message = strings.TrimSpace(r.Message)
	return r
}

func jsonString(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) != nil {
		return ""
	}
	return s
}
