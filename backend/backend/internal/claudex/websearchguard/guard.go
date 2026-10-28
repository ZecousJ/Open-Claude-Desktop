// Package websearchguard is the R45 gateway guard that enforces the client
// policy's web search switch on the server (round 2, design R45 2.3): for a
// Claudex device key, a request that asks for web_search, x_search or
// web_search_preview while the user's resolved policy turns web search off is
// refused with 403 CLAUDEX_WEB_SEARCH_DISABLED. The user's own API keys are
// never affected.
//
// The guard is a gatewayhook.RequestGuard (H5b, priority
// gatewayhook.PriorityWebSearch), so the module registers it after the
// device (10), version (20) and usage rules (30) guards. It checks every
// JSON POST of a device key, not only /v1/responses: the root aliases
// (/responses), /backend-api/codex/responses, Responses subpaths and Chat
// Completions all reach the same upstream search tools, and a guard that only
// watched one path could be bypassed by calling another.
//
// What counts as a search request:
//
//   - a tools[] entry (top level, or inside a Responses Lite
//     input[].additional_tools carrier) whose type is web_search,
//     web_search_preview or a dated variant of either (web_search_2025_08_26,
//     web_search_preview_2025_03_11, Anthropic's web_search_20250305) or
//     x_search;
//   - the Chat Completions switches web_search_options (any object) and
//     xAI's search_parameters (unless mode is "off").
//
// Web search off refuses every one of them. With web search on, x_search is
// refused when the policy's research.x_search is off (the administrator's
// switch for grok's X search, design R45 Q5).
//
// The policy is the one the desktop client gets: the client-policy
// component's bootstrap section for the key's group and the device's
// platform, which reads the cached policy document (no query per request).
// When the policy cannot be resolved the request passes (like the usage
// rules precheck): the client enforces the same policy and the upstream
// search is billed as usual.
//
// Responses WebSocket turns carry their tools inside the socket, after the
// handshake; the desktop client does not use Responses WebSockets
// (supports_websockets: false), so the guard only sees HTTP bodies.
package websearchguard

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strings"
	"sync/atomic"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/gatewayhook"
	"github.com/Wei-Shaw/sub2api/internal/pkg/httputil"
	"github.com/Wei-Shaw/sub2api/internal/pkg/requestmodel"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/tidwall/gjson"
)

// Refusal code and reasons (design R45 5).
const (
	// CodeWebSearchDisabled is the error code of every refusal.
	CodeWebSearchDisabled = "CLAUDEX_WEB_SEARCH_DISABLED"
	// ReasonWebSearchDisabled is the "claudex" reason when web search is off.
	ReasonWebSearchDisabled = "WEB_SEARCH_DISABLED"
	// ReasonXSearchDisabled is the "claudex" reason when only X search is off.
	ReasonXSearchDisabled = "X_SEARCH_DISABLED"

	// MessageWebSearchDisabled and MessageXSearchDisabled are the English
	// texts the desktop app shows.
	MessageWebSearchDisabled = "Web search is turned off by your administrator. Turn off web search and try again."
	MessageXSearchDisabled   = "X search is turned off by your administrator. Turn off web search and try again."

	kindPolicy = "policy"
	actionNone = "none"
)

// Guard is the R45 component.
type Guard struct {
	env *core.Env

	// resolveErrors counts requests let through because the policy could
	// not be resolved (logged with each warning).
	resolveErrors atomic.Int64
}

// New builds the guard. Like every component it must not call its
// dependencies or env.Peers here (tests pass empty Deps).
func New(env *core.Env) *Guard {
	return &Guard{env: env}
}

// Name implements core.Feature.
func (g *Guard) Name() string { return core.NameWebSearchGuard }

// Priority is the guard's place in the H5b chain, after the device,
// version and usage rules guards.
func (g *Guard) Priority() int { return gatewayhook.PriorityWebSearch }

// OnRequest implements gatewayhook.RequestGuard (H5b).
func (g *Guard) OnRequest(c *gin.Context, apiKey *service.APIKey) bool {
	if c == nil || c.Request == nil || apiKey == nil {
		return false
	}
	dev, ok := gatewayhook.Device(c)
	if !ok || dev.Revoked {
		// Only device keys; a revoked device is refused by B4's guard.
		return false
	}
	asked := requestedSearch(c)
	if !asked.any() {
		return false
	}
	userID := apiKey.UserID
	if apiKey.User != nil && apiKey.User.ID > 0 {
		userID = apiKey.User.ID
	}
	if userID <= 0 {
		userID = dev.UserID
	}
	groupID := keyGroupID(apiKey)
	if groupID == nil {
		groupID = dev.GroupID
	}
	pol, ok := g.policy(c.Request.Context(), userID, groupID, dev.Platform)
	if !ok {
		return false
	}
	switch {
	case !pol.webSearch:
		refuse(c, ReasonWebSearchDisabled, MessageWebSearchDisabled)
		return true
	case asked.x && !pol.xSearch:
		refuse(c, ReasonXSearchDisabled, MessageXSearchDisabled)
		return true
	}
	return false
}

// refuse writes the 403 in the OpenAI error shape (what Codex and the Chat
// bridge read) with the structured detail preset for EnrichRefusals.
func refuse(c *gin.Context, reason, message string) {
	gatewayhook.SetDetail(c, &gatewayhook.RefusalDetail{
		V:           1,
		Reason:      reason,
		Kind:        kindPolicy,
		Reprovision: false,
		Action:      actionNone,
		Message:     message,
	})
	c.AbortWithStatusJSON(http.StatusForbidden, gin.H{
		"error": gin.H{
			"type":    "permission_error",
			"code":    CodeWebSearchDisabled,
			"message": message,
			"param":   nil,
		},
	})
}

// searchPolicy is the part of the resolved client policy the guard reads.
type searchPolicy struct {
	webSearch bool
	xSearch   bool
}

// policyFeature is the client-policy component as the guard sees it.
type policyFeature interface {
	core.Feature
	core.BootstrapContributor
}

// resolvedSearch mirrors the fields of the resolved policy (policy.Resolved)
// the guard needs. Missing fields make the policy unusable (fail open).
type resolvedSearch struct {
	WebSearch *bool `json:"web_search"`
	Research  *struct {
		XSearch *bool `json:"x_search"`
	} `json:"research"`
}

// policy resolves the client policy for the user, the key's group and the
// device platform through the client-policy component.
func (g *Guard) policy(ctx context.Context, userID int64, groupID *int64, platform string) (searchPolicy, bool) {
	pf := g.policyComponent()
	if pf == nil {
		return searchPolicy{}, false
	}
	bc := &core.BootstrapContext{UserID: userID, Platform: platform}
	if groupID != nil {
		bc.Plan = &core.PlanRef{GroupID: *groupID}
	}
	sections, err := safeSections(ctx, pf, bc)
	if err != nil {
		g.resolveFailed(err)
		return searchPolicy{}, false
	}
	section, ok := sections[core.SectionPolicy]
	if !ok {
		g.resolveFailed(errNoSection)
		return searchPolicy{}, false
	}
	raw, err := json.Marshal(section)
	if err != nil {
		g.resolveFailed(err)
		return searchPolicy{}, false
	}
	var r resolvedSearch
	if err := json.Unmarshal(raw, &r); err != nil || r.WebSearch == nil {
		if err == nil {
			err = errNoSection
		}
		g.resolveFailed(err)
		return searchPolicy{}, false
	}
	out := searchPolicy{webSearch: *r.WebSearch}
	// Research.XSearch resolves to off whenever web_search is off; an older
	// policy without the field leaves X search with web search.
	out.xSearch = out.webSearch
	if r.Research != nil && r.Research.XSearch != nil {
		out.xSearch = out.webSearch && *r.Research.XSearch
	}
	return out, true
}

func (g *Guard) policyComponent() policyFeature {
	if g.env == nil {
		return nil
	}
	for _, f := range g.env.Components {
		if f == nil || f.Name() != core.NamePolicy {
			continue
		}
		pf, _ := f.(policyFeature)
		return pf
	}
	return nil
}

type guardError string

func (e guardError) Error() string { return string(e) }

const (
	errNoSection guardError = "policy section missing"
	errPanicked  guardError = "policy component panicked"
)

// safeSections calls the policy component; a panic there must not turn a
// search request into a 500.
func safeSections(ctx context.Context, pf policyFeature, bc *core.BootstrapContext) (sections map[string]any, err error) {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("claudex websearchguard: policy component panicked", "panic", r)
			sections, err = nil, errPanicked
		}
	}()
	return pf.BootstrapSections(ctx, bc)
}

func (g *Guard) resolveFailed(err error) {
	n := g.resolveErrors.Add(1)
	slog.Warn("claudex websearchguard: could not resolve the client policy, request allowed",
		"error", err, "claudex_web_search_guard_errors_total", n)
}

func keyGroupID(apiKey *service.APIKey) *int64 {
	if apiKey.GroupID != nil {
		return apiKey.GroupID
	}
	if apiKey.Group != nil && apiKey.Group.ID > 0 {
		id := apiKey.Group.ID
		return &id
	}
	return nil
}

// asked is what a request body asks for.
type asked struct {
	web bool // web_search, web_search_preview, web_search_options, search_parameters
	x   bool // x_search
}

func (a asked) any() bool { return a.web || a.x }

// requestedSearch reads a JSON POST body (within the gateway body limit,
// decompressed) and puts it back for the handlers, like
// gatewayhook.RequestModels. A body that cannot be read or parsed asks for
// nothing: the handler reports the error as it would have.
func requestedSearch(c *gin.Context) asked {
	req := c.Request
	if req.Method != http.MethodPost || req.Body == nil || req.Body == http.NoBody {
		return asked{}
	}
	if isForm(req.Header.Get("Content-Type")) && !startsLikeJSON(req) {
		// A real form upload (audio, files) is not read into memory. The
		// upstream JSON handlers ignore the declared type, so a JSON body
		// labelled as a form is still inspected below.
		return asked{}
	}
	body, err := httputil.ReadRequestBodyWithPrealloc(req)
	if err != nil {
		req.Body = errorBody{err: err}
		return asked{}
	}
	requestmodel.ResetRequestBody(req, body)
	return searchInBody(body)
}

// isForm reports form uploads (multipart, urlencoded).
func isForm(contentType string) bool {
	mt, _, err := mime.ParseMediaType(contentType)
	if err != nil {
		return false
	}
	return strings.HasPrefix(mt, "multipart/") || mt == "application/x-www-form-urlencoded"
}

// peekLimit bounds the prefix startsLikeJSON reads.
const peekLimit = 512

// startsLikeJSON peeks at the start of a body declared as a form and puts
// the bytes back: true when it may be JSON (first non-space byte is '{'),
// or when it is compressed and cannot be judged from its prefix.
func startsLikeJSON(req *http.Request) bool {
	enc := strings.ToLower(strings.TrimSpace(req.Header.Get("Content-Encoding")))
	if enc != "" && enc != "identity" {
		return true
	}
	if _, ok := req.Body.(*httputil.PrereadBody); ok {
		return true
	}
	buf := make([]byte, peekLimit)
	n, err := io.ReadFull(req.Body, buf)
	buf = buf[:n]
	req.Body = &replayBody{Reader: io.MultiReader(bytes.NewReader(buf), errReader(err, req.Body)), closer: req.Body}
	trimmed := bytes.TrimLeft(buf, " \t\r\n\ufeff")
	if len(trimmed) == 0 {
		// All whitespace so far (or empty): let the full read decide.
		return n == peekLimit
	}
	return trimmed[0] == '{'
}

// errReader continues a peeked body: the rest of body when the peek
// stopped at the limit, otherwise the peek's own read error (nil and EOF
// both end the body).
func errReader(err error, body io.Reader) io.Reader {
	switch err {
	case nil:
		return body
	case io.EOF, io.ErrUnexpectedEOF:
		return bytes.NewReader(nil)
	default:
		return errorBody{err: err}
	}
}

// replayBody is a peeked body: the prefix, then the rest, closing the original.
type replayBody struct {
	io.Reader
	closer io.Closer
}

func (b *replayBody) Close() error { return b.closer.Close() }

// searchInBody finds the search tools and switches of a JSON body.
//
// The upstream handlers decode bodies with encoding/json (keys match
// case-insensitively, the last duplicate wins, \u escapes are decoded) and
// with gjson (the first duplicate wins). So that no spelling reaches the
// upstream search unseen, every key is compared case-insensitively after
// unescaping and every duplicate is checked.
func searchInBody(body []byte) asked {
	var a asked
	// Every form below contains "search" in some letter case, unless it is
	// spelled with \u escapes; bodies with neither are skipped here.
	if !containsFoldSearch(body) && bytes.IndexByte(body, '\\') < 0 {
		return a
	}
	if !gjson.ValidBytes(body) {
		// gjson and encoding/json disagree on a few edge cases (a UTF-8
		// BOM, invalid UTF-8); fall back to what encoding/json accepts.
		var v any
		if err := json.Unmarshal(body, &v); err != nil {
			return a
		}
		raw, err := json.Marshal(v)
		if err != nil || !gjson.ValidBytes(raw) {
			return a
		}
		body = raw
	}
	root := gjson.ParseBytes(body)
	if !root.IsObject() {
		return a
	}
	root.ForEach(func(key, value gjson.Result) bool {
		switch strings.ToLower(key.String()) {
		case "tools":
			a.addTools(value)
		case "input":
			if value.IsArray() {
				for _, item := range value.Array() {
					if anyFieldIs(item, "type", "additional_tools") {
						forEachField(item, "tools", a.addTools)
					}
				}
			}
		case "web_search_options":
			if value.Type != gjson.Null {
				a.web = true
			}
		case "search_parameters":
			if value.Type != gjson.Null && !fieldIs(value, "mode", "off") {
				a.web = true
			}
		}
		return true
	})
	return a
}

// forEachField calls fn with every value of obj whose key matches name
// case-insensitively (duplicates included).
func forEachField(obj gjson.Result, name string, fn func(gjson.Result)) {
	if !obj.IsObject() {
		return
	}
	obj.ForEach(func(key, value gjson.Result) bool {
		if strings.EqualFold(key.String(), name) {
			fn(value)
		}
		return true
	})
}

// fieldIs reports whether every value of obj's field name (matched
// case-insensitively) equals want ignoring case and spaces, and there is at
// least one; a duplicate with another value makes it false.
func fieldIs(obj gjson.Result, name, want string) bool {
	found, all := false, true
	forEachField(obj, name, func(v gjson.Result) {
		found = true
		if !strings.EqualFold(strings.TrimSpace(v.String()), want) {
			all = false
		}
	})
	return found && all
}

// anyFieldIs reports whether some value of obj's field name (matched
// case-insensitively) equals want ignoring case and spaces.
func anyFieldIs(obj gjson.Result, name, want string) bool {
	found := false
	forEachField(obj, name, func(v gjson.Result) {
		if strings.EqualFold(strings.TrimSpace(v.String()), want) {
			found = true
		}
	})
	return found
}

func (a *asked) addTools(tools gjson.Result) {
	if !tools.IsArray() {
		return
	}
	for _, tool := range tools.Array() {
		forEachField(tool, "type", func(t gjson.Result) {
			switch searchToolKind(t.String()) {
			case "web":
				a.web = true
			case "x":
				a.x = true
			}
		})
	}
}

// containsFoldSearch reports whether body contains "search" in any ASCII
// letter case, without copying the body.
func containsFoldSearch(body []byte) bool {
	const word = "search"
	for i := 0; i+len(word) <= len(body); i++ {
		c := body[i] | 0x20
		if c != 's' {
			continue
		}
		match := true
		for j := 1; j < len(word); j++ {
			if body[i+j]|0x20 != word[j] {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}

// searchToolKind classifies a tool type: "web", "x" or "".
func searchToolKind(toolType string) string {
	t := strings.ToLower(strings.TrimSpace(toolType))
	switch {
	case t == "x_search" || strings.HasPrefix(t, "x_search_"):
		return "x"
	case t == "web_search" || strings.HasPrefix(t, "web_search_"):
		// web_search_preview, web_search_preview_2025_03_11,
		// web_search_2025_08_26, web_search_20250305 ...
		return "web"
	}
	return ""
}

// errorBody replays a body read error to the next reader.
type errorBody struct{ err error }

func (b errorBody) Read([]byte) (int, error) { return 0, b.err }
func (b errorBody) Close() error             { return nil }

var (
	_ core.Feature             = (*Guard)(nil)
	_ gatewayhook.RequestGuard = (*Guard)(nil)
)
