package webproto

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"unicode"
)

// ErrProtocol wraps every validation failure of this package.
var ErrProtocol = errors.New("webproto")

func fail(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrProtocol, fmt.Sprintf(format, args...))
}

// ---------------------------------------------------------------------------
// RPC: POST rpc/<method>

// RPCRequest is the body of an RPC call: the wire-encoded arguments
// (Uint8Array values are {"$bytes": base64}; Go relays them untouched).
type RPCRequest struct {
	Args []json.RawMessage `json:"args"`
}

// RPCError is a failed call: a plain English message shown as is, an
// optional CLAUDEX_* code and structured details.
type RPCError struct {
	Message string          `json:"message"`
	Code    string          `json:"code,omitempty"`
	Details json.RawMessage `json:"details,omitempty"`
}

// RPCResponse is the body of every RPC answer. HTTP 200 carries the handler's
// outcome; Go's own refusals use their HTTP status with OK false.
type RPCResponse struct {
	OK    bool            `json:"ok"`
	Value json.RawMessage `json:"value,omitempty"`
	Error *RPCError       `json:"error,omitempty"`
}

// DecodeRPCRequest reads an RPC body: an object with only an args array.
func DecodeRPCRequest(data []byte) (RPCRequest, error) {
	var req RPCRequest
	if len(data) > RPCBodyBytes {
		return req, fail("request body is too large")
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		return req, fail("request: %v", err)
	}
	if dec.More() {
		return req, fail("request has trailing data")
	}
	if req.Args == nil {
		return req, fail("args must be an array")
	}
	return req, nil
}

// OKResponse is a successful answer with value (nil for none).
func OKResponse(value any) (RPCResponse, error) {
	if value == nil {
		return RPCResponse{OK: true}, nil
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return RPCResponse{}, err
	}
	return RPCResponse{OK: true, Value: raw}, nil
}

// ErrorResponse is a failed answer.
func ErrorResponse(code, message string) RPCResponse {
	return RPCResponse{OK: false, Error: &RPCError{Code: code, Message: message}}
}

func (e *RPCError) validate(what string) error {
	if e == nil {
		return fail("%s must be an object", what)
	}
	if e.Message == "" {
		return fail("%s.message must be a non-empty string", what)
	}
	return nil
}

func validateOutcome(ok bool, value json.RawMessage, e *RPCError) error {
	if ok {
		if e != nil {
			return fail("an ok answer has no error")
		}
		return nil
	}
	return e.validate("error")
}

// Validate checks an answer's shape.
func (r RPCResponse) Validate() error { return validateOutcome(r.OK, r.Value, r.Error) }

// ---------------------------------------------------------------------------
// Events socket tickets

// TicketRequest is the body of POST auth/events-ticket.
type TicketRequest struct {
	TabID string `json:"tabId"`
}

// TicketResponse is its answer.
type TicketResponse struct {
	Ticket    string `json:"ticket"`
	ExpiresIn int    `json:"expires_in"`
}

// Validate checks the ticket's shape and lifetime.
func (t TicketResponse) Validate() error {
	if !ValidTicket(t.Ticket) {
		return fail("ticket has the wrong shape")
	}
	if t.ExpiresIn < 1 {
		return fail("expires_in must be ≥ 1")
	}
	return nil
}

// ---------------------------------------------------------------------------
// Frame helpers

type frameHead struct {
	T *string `json:"t"`
}

func decodeFrame(data []byte, max int, into any) (string, error) {
	if len(data) > max {
		return "", fail("frame is too large")
	}
	var head frameHead
	if err := json.Unmarshal(data, &head); err != nil {
		return "", fail("frame is not a JSON object")
	}
	if head.T == nil {
		return "", fail("frame has no t")
	}
	if err := json.Unmarshal(data, into); err != nil {
		return "", fail("frame %q: %v", *head.T, err)
	}
	return *head.T, nil
}

func requireObjectWithType(raw json.RawMessage, what string) error {
	var head struct {
		Type any `json:"type"`
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return fail("%s must be an object", what)
	}
	if err := json.Unmarshal(trimmed, &head); err != nil {
		return fail("%s must be an object", what)
	}
	if s, ok := head.Type.(string); !ok || s == "" {
		return fail("%s.type must be a non-empty string", what)
	}
	return nil
}

func requireArray(raw json.RawMessage, what string) error {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '[' {
		return fail("%s must be an array", what)
	}
	var items []json.RawMessage
	if err := json.Unmarshal(trimmed, &items); err != nil {
		return fail("%s must be an array", what)
	}
	return nil
}

// OpenableURL reports whether a frame may ask a tab to open url: https pages
// and same-origin paths only. A backslash, whitespace or control character
// is refused outright: browsers turn "/\\evil.example" and "/\t/evil.example"
// into "//evil.example".
func OpenableURL(u string) bool {
	for _, r := range u {
		if r == '\\' || r < 0x20 || (r >= 0x7f && r <= 0x9f) || r == 0xfeff || unicode.IsSpace(r) {
			return false
		}
	}
	if strings.HasPrefix(u, "/") {
		return !strings.HasPrefix(u, "//")
	}
	if !strings.HasPrefix(u, "https://") {
		return false
	}
	parsed, err := url.Parse(u)
	return err == nil && parsed.Scheme == "https" && parsed.Host != "" && parsed.Hostname() != ""
}

// IsUserOp reports whether a runner request op reads or writes one user's
// data (every op of v1). Such requests must carry userId, and Go serves
// them only for a user it currently routes to the requesting runner.
func IsUserOp(op string) bool {
	return strings.HasPrefix(op, "store.") || strings.HasPrefix(op, "key.") || strings.HasPrefix(op, "location.") || strings.HasPrefix(op, "github.") || strings.HasPrefix(op, "routine.") || strings.HasPrefix(op, "device.")
}

func validTarget(t string) bool { return t == "same-tab" || t == "new-tab" }

func ptr[T any](v T) *T { return &v }

// ---------------------------------------------------------------------------
// Events socket frames (browser ⇄ Go)

// BrowserFrame is a frame the browser sends: hello (first), ping, presence.
type BrowserFrame struct {
	T       string `json:"t"`
	V       int    `json:"v,omitempty"`
	TabID   string `json:"tabId,omitempty"`
	LastSeq *int64 `json:"lastSeq,omitempty"`
	Visible *bool  `json:"visible,omitempty"`
	Focused *bool  `json:"focused,omitempty"`
}

// DecodeBrowserFrame reads and validates a browser frame.
func DecodeBrowserFrame(data []byte) (BrowserFrame, error) {
	var f BrowserFrame
	t, err := decodeFrame(data, RPCBodyBytes, &f)
	if err != nil {
		return f, err
	}
	switch t {
	case "hello":
		if f.V < 1 {
			return f, fail("hello.v must be ≥ 1")
		}
		if !ValidTabID(f.TabID) {
			return f, fail("hello.tabId has the wrong shape")
		}
		if f.LastSeq != nil && *f.LastSeq < 0 {
			return f, fail("hello.lastSeq must be ≥ 0")
		}
	case "ping":
	case "presence":
		if f.Visible == nil || f.Focused == nil {
			return f, fail("presence needs visible and focused")
		}
	default:
		return f, fail("unknown browser frame %q", t)
	}
	return f, nil
}

// ServerFrame is a frame Go sends to a tab.
type ServerFrame struct {
	T        string          `json:"t"`
	V        int             `json:"v,omitempty"`
	Seq      *int64          `json:"seq,omitempty"`
	Resumed  *bool           `json:"resumed,omitempty"`
	Event    json.RawMessage `json:"event,omitempty"`
	Snapshot json.RawMessage `json:"snapshot,omitempty"`
	URL      string          `json:"url,omitempty"`
	Target   string          `json:"target,omitempty"`
	Code     string          `json:"code,omitempty"`
	Message  string          `json:"message,omitempty"`
}

// ReadyFrame answers hello: seq is the last event before this connection's
// first frame; resumed tells whether every event after lastSeq follows.
func ReadyFrame(seq int64, resumed bool) ServerFrame {
	return ServerFrame{T: "ready", V: Version, Seq: ptr(seq), Resumed: ptr(resumed)}
}

// EventFrame carries one AppEvent with its per-user seq.
func EventFrame(seq int64, event json.RawMessage) ServerFrame {
	return ServerFrame{T: "event", Seq: ptr(seq), Event: event}
}

// SnapshotFrame replaces the tab's state when lastSeq left the ring.
func SnapshotFrame(seq int64, snapshot json.RawMessage) ServerFrame {
	return ServerFrame{T: "snapshot", Seq: ptr(seq), Snapshot: snapshot}
}

// ErrorFrame precedes a close with one of the Close* codes.
func ErrorFrame(code, message string) ServerFrame {
	return ServerFrame{T: "error", Code: code, Message: message}
}

// Validate checks a server frame before it is sent.
func (f ServerFrame) Validate() error {
	switch f.T {
	case "ready":
		if f.V < 1 || f.Seq == nil || *f.Seq < 0 || f.Resumed == nil {
			return fail("ready needs v, seq and resumed")
		}
	case "event":
		if f.Seq == nil || *f.Seq < 1 {
			return fail("event.seq must be ≥ 1")
		}
		return requireObjectWithType(f.Event, "event")
	case "snapshot":
		if f.Seq == nil || *f.Seq < 0 {
			return fail("snapshot.seq must be ≥ 0")
		}
		var snap struct {
			Conversations []json.RawMessage `json:"conversations"`
		}
		if err := json.Unmarshal(f.Snapshot, &snap); err != nil || snap.Conversations == nil {
			return fail("snapshot.conversations must be an array")
		}
	case "open-url":
		if !OpenableURL(f.URL) {
			return fail("url must be https or same-origin")
		}
		if !validTarget(f.Target) {
			return fail("target must be same-tab or new-tab")
		}
	case "pong":
	case "error":
		if f.Code == "" || f.Message == "" {
			return fail("error needs code and message")
		}
	default:
		return fail("unknown server frame %q", f.T)
	}
	return nil
}

// DecodeServerFrame reads and validates a server frame (tests, tools).
func DecodeServerFrame(data []byte) (ServerFrame, error) {
	var f ServerFrame
	if _, err := decodeFrame(data, LinkFrameBytes, &f); err != nil {
		return f, err
	}
	return f, f.Validate()
}

// ---------------------------------------------------------------------------
// Runner link frames (claudex-runner ⇄ Go)

// Capacity is what a runner can hold.
type Capacity struct {
	Engines int `json:"engines"`
	Users   int `json:"users"`
}

// RunnerFrame is a frame claudex-runner sends to Go. Decoding only checks
// the shape: the relay must still drop event, open-url and request frames
// whose UserID is not a user it currently routes to this runner.
type RunnerFrame struct {
	T        string            `json:"t"`
	V        int               `json:"v,omitempty"`
	Version  string            `json:"version,omitempty"`
	Methods  []string          `json:"methods,omitempty"`
	Capacity *Capacity         `json:"capacity,omitempty"`
	Labels   map[string]string `json:"labels,omitempty"`
	ID       string            `json:"id,omitempty"`
	OK       *bool             `json:"ok,omitempty"`
	Value    json.RawMessage   `json:"value,omitempty"`
	Error    *RPCError         `json:"error,omitempty"`
	UserID   int64             `json:"userId,omitempty"`
	Event    json.RawMessage   `json:"event,omitempty"`
	URL      string            `json:"url,omitempty"`
	Target   string            `json:"target,omitempty"`
	TabID    string            `json:"tabId,omitempty"`
	Op       string            `json:"op,omitempty"`
	Body     json.RawMessage   `json:"body,omitempty"`
	Engines  *int              `json:"engines,omitempty"`
	Users    *int              `json:"users,omitempty"`
	RSSMb    *int              `json:"rssMb,omitempty"`
	// HubSeq (not on the wire): the user's last event number when Go took
	// this result off the link. Events and results arrive in one ordered
	// stream, so every event the runner sent before the result is at or
	// below it.
	HubSeq int64 `json:"-"`
}

// DecodeRunnerFrame reads and validates a runner frame.
func DecodeRunnerFrame(data []byte) (RunnerFrame, error) {
	var f RunnerFrame
	t, err := decodeFrame(data, LinkFrameBytes, &f)
	if err != nil {
		return f, err
	}
	switch t {
	case "hello":
		if f.V < 1 || f.Version == "" {
			return f, fail("hello needs v and version")
		}
		if err := validateMethods(f.Methods); err != nil {
			return f, err
		}
		if f.Capacity == nil || f.Capacity.Engines < 0 || f.Capacity.Users < 0 {
			return f, fail("hello needs capacity")
		}
	case "result":
		if !idPattern.MatchString(f.ID) || f.OK == nil {
			return f, fail("result needs id and ok")
		}
		if err := validateOutcome(*f.OK, f.Value, f.Error); err != nil {
			return f, err
		}
	case "event":
		if f.UserID < 1 {
			return f, fail("event.userId must be ≥ 1")
		}
		if err := requireObjectWithType(f.Event, "event"); err != nil {
			return f, err
		}
	case "open-url":
		if f.UserID < 1 || !OpenableURL(f.URL) || !validTarget(f.Target) {
			return f, fail("open-url needs userId, an https or same-origin url and a target")
		}
		if f.TabID != "" && !ValidTabID(f.TabID) {
			return f, fail("open-url.tabId has the wrong shape")
		}
	case "request":
		if !idPattern.MatchString(f.ID) || !ValidOp(f.Op) {
			return f, fail("request needs id and op")
		}
		if f.UserID < 0 {
			return f, fail("request.userId must be ≥ 1")
		}
		if f.UserID == 0 && IsUserOp(f.Op) {
			return f, fail("request %s needs userId", f.Op)
		}
	case "load":
		if f.Engines == nil || f.Users == nil || f.RSSMb == nil ||
			*f.Engines < 0 || *f.Users < 0 || *f.RSSMb < 0 {
			return f, fail("load needs engines, users and rssMb")
		}
	case "ping", "pong":
	default:
		return f, fail("unknown runner frame %q", t)
	}
	return f, nil
}

func validateMethods(methods []string) error {
	if methods == nil {
		return fail("hello.methods must be an array")
	}
	if len(methods) > RunnerMethods {
		return fail("too many methods")
	}
	seen := make(map[string]bool, len(methods))
	for _, m := range methods {
		if !ValidMethodName(m) {
			return fail("bad method name %q", m)
		}
		if seen[m] {
			return fail("method %s is listed twice", m)
		}
		seen[m] = true
	}
	return nil
}

// LinkUser is who a relayed call belongs to. AccessToken is the user's
// current access token for the runner's Sub2API user calls (memory only).
type LinkUser struct {
	ID          int64  `json:"id"`
	TabID       string `json:"tabId,omitempty"`
	AccessToken string `json:"accessToken"`
}

// GoFrame is a frame Go sends to claudex-runner.
type GoFrame struct {
	T           string          `json:"t"`
	V           int             `json:"v,omitempty"`
	RunnerID    string          `json:"runnerId,omitempty"`
	HeartbeatMs int64           `json:"heartbeatMs,omitempty"`
	ID          string          `json:"id,omitempty"`
	User        *LinkUser       `json:"user,omitempty"`
	Method      string          `json:"method,omitempty"`
	Args        json.RawMessage `json:"args,omitempty"`
	DeadlineMs  int64           `json:"deadlineMs,omitempty"`
	OK          *bool           `json:"ok,omitempty"`
	Value       json.RawMessage `json:"value,omitempty"`
	Error       *RPCError       `json:"error,omitempty"`
	UserID      int64           `json:"userId,omitempty"`
	Tabs        *int            `json:"tabs,omitempty"`
	Focused     *bool           `json:"focused,omitempty"`
	Reason      string          `json:"reason,omitempty"`
}

// Reasons of a user-signed-out frame.
const (
	SignedOutRevoked         = "revoked"
	SignedOutSessionExpired  = "session-expired"
	SignedOutPasswordChanged = "password-changed"
	SignedOutRemoved         = "removed"
)

// CallFrame relays one bridge method call to the runner.
func CallFrame(id string, user LinkUser, method string, args []json.RawMessage, deadlineMs int64) (GoFrame, error) {
	if args == nil {
		args = []json.RawMessage{}
	}
	raw, err := json.Marshal(args)
	if err != nil {
		return GoFrame{}, err
	}
	f := GoFrame{T: "call", ID: id, User: &user, Method: method, Args: raw, DeadlineMs: deadlineMs}
	return f, f.Validate()
}

// Validate checks a Go frame before it is sent.
func (f GoFrame) Validate() error {
	switch f.T {
	case "welcome":
		if f.V < 1 || f.RunnerID == "" || f.HeartbeatMs < 1000 {
			return fail("welcome needs v, runnerId and heartbeatMs ≥ 1000")
		}
	case "call":
		if !idPattern.MatchString(f.ID) || !ValidMethodName(f.Method) || f.DeadlineMs < 1 {
			return fail("call needs id, method and deadlineMs")
		}
		if f.User == nil || f.User.ID < 1 || f.User.AccessToken == "" {
			return fail("call needs user.id and user.accessToken")
		}
		if f.User.TabID != "" && !ValidTabID(f.User.TabID) {
			return fail("call.user.tabId has the wrong shape")
		}
		return requireArray(f.Args, "args")
	case "cancel":
		if !idPattern.MatchString(f.ID) {
			return fail("cancel needs id")
		}
	case "response":
		if !idPattern.MatchString(f.ID) || f.OK == nil {
			return fail("response needs id and ok")
		}
		return validateOutcome(*f.OK, f.Value, f.Error)
	case "presence":
		if f.UserID < 1 || f.Tabs == nil || *f.Tabs < 0 || f.Focused == nil {
			return fail("presence needs userId, tabs and focused")
		}
	case "user-signed-out":
		if f.UserID < 1 {
			return fail("user-signed-out needs userId")
		}
		switch f.Reason {
		case SignedOutRevoked, SignedOutSessionExpired, SignedOutPasswordChanged, SignedOutRemoved:
		default:
			return fail("user-signed-out has an unknown reason %q", f.Reason)
		}
	case "drain", "ping", "pong":
	default:
		return fail("unknown Go frame %q", f.T)
	}
	return nil
}

// DecodeGoFrame reads and validates a Go frame (tests, tools).
func DecodeGoFrame(data []byte) (GoFrame, error) {
	var f GoFrame
	if _, err := decodeFrame(data, LinkFrameBytes, &f); err != nil {
		return f, err
	}
	return f, f.Validate()
}
