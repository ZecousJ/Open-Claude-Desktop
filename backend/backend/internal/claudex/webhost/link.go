package webhost

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/geoip"
	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
	"github.com/Wei-Shaw/sub2api/internal/claudex/webstore"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"

	"github.com/coder/websocket"
	"github.com/gin-gonic/gin"
)

// The runner link (web plan §1, §2 #2): claudex-runner dials
// /api/v1/claudex/web/runner/link with its token in Authorization: Bearer and
// the claudex.runner.v1 sub-protocol, says hello (version, methods, capacity)
// and gets welcome (runner id, heartbeat). Go then relays browser calls for
// the methods of that hello, numbers and fans out the runner's events, and
// answers the runner's store and key requests — for users assigned to that
// runner only.

const (
	linkHelloTimeout  = 10 * time.Second
	linkWriteTimeout  = 20 * time.Second
	linkQueue         = 1024
	linkRequestLimit  = 32
	linkRequestBudget = 60 * time.Second
	linkReadSlack     = 64 << 10
)

// Methods a browser may never call even when a runner lists them: runner
// internal calls Go makes itself.
var internalMethods = map[string]bool{previewMethod: true, fireRoutineMethod: true}

type linkLoad struct {
	Engines int       `json:"engines"`
	Users   int       `json:"users"`
	RSSMb   int       `json:"rss_mb"`
	At      time.Time `json:"at"`
}

// runnerConn is one connected runner.
type runnerConn struct {
	c           *Component
	id          string
	name        string
	record      int64 // claudex_web_runners.id; 0 for the local runner
	conn        *websocket.Conn
	version     string
	methods     map[string]bool
	capacity    webproto.Capacity
	labels      map[string]string
	connectedAt time.Time

	out       chan []byte
	done      chan struct{}
	closeOnce sync.Once
	lastHeard atomic.Int64
	nextID    atomic.Uint64
	requests  chan struct{}

	mu      sync.Mutex
	pending map[string]chan webproto.RunnerFrame
	// callers: whose call each pending id is (results carry no user).
	callers  map[string]int64
	draining bool
	load     linkLoad
}

func (rc *runnerConn) isDraining() bool {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	return rc.draining
}

// StandbyLabel marks a runner (CLAUDEX_RUNNER_LABELS=role=standby) that
// takes new users only while no other runner is linked.
const StandbyLabel = "standby"

func (rc *runnerConn) isStandby() bool {
	return rc.labels["role"] == StandbyLabel
}

func (rc *runnerConn) closed() bool {
	select {
	case <-rc.done:
		return true
	default:
		return false
	}
}

// send queues a frame; a runner that does not read its queue is dropped.
func (rc *runnerConn) send(frame any) bool {
	if f, ok := frame.(webproto.GoFrame); ok {
		if err := f.Validate(); err != nil {
			slog.Error("claudex webhost: refusing to send an invalid runner frame", "error", err)
			return false
		}
	}
	data, err := json.Marshal(frame)
	if err != nil {
		return false
	}
	if rc.closed() {
		return false
	}
	select {
	case rc.out <- data:
		return true
	case <-rc.done:
		return false
	default:
		slog.Warn("claudex webhost: runner link queue full; closing", "runner_id", rc.id)
		rc.close(websocket.StatusGoingAway, "queue full")
		return false
	}
}

func (rc *runnerConn) signOut(userID int64, reason string) {
	rc.send(webproto.GoFrame{T: "user-signed-out", UserID: userID, Reason: reason})
}

func (rc *runnerConn) presence(userID int64, tabs int, focused bool) {
	rc.send(webproto.GoFrame{T: "presence", UserID: userID, Tabs: &tabs, Focused: &focused})
}

// close ends the link once: the pending calls fail, the runs on it end and
// the registry forgets it.
func (rc *runnerConn) close(code websocket.StatusCode, reason string) {
	rc.closeOnce.Do(func() {
		close(rc.done)
		go func() { _ = rc.conn.Close(code, reason) }()
		if rc.c.reg.detach(rc) {
			rc.c.runs.endRunner(rc.id)
		}
		slog.Info("claudex webhost: runner link closed", "runner_id", rc.id, "reason", reason)
	})
}

var errCallTimeout = infraerrors.GatewayTimeout(webproto.ErrCodeTimeout, "Claudex took too long to answer. Try again.")

// call runs one method for a user on the runner and waits for its result.
func (rc *runnerConn) call(ctx context.Context, user webproto.LinkUser, method string, args []json.RawMessage, timeout time.Duration) (webproto.RunnerFrame, error) {
	id := "c" + strconv.FormatUint(rc.nextID.Add(1), 36)
	ch := make(chan webproto.RunnerFrame, 1)
	frame, err := webproto.CallFrame(id, user, method, args, timeout.Milliseconds())
	if err != nil {
		return webproto.RunnerFrame{}, infraerrors.BadRequest(webproto.ErrCodeBadRequest, "The request was not valid.")
	}
	rc.mu.Lock()
	if rc.pending == nil {
		rc.pending = map[string]chan webproto.RunnerFrame{}
	}
	if rc.callers == nil {
		rc.callers = map[string]int64{}
	}
	rc.pending[id] = ch
	rc.callers[id] = user.ID
	rc.mu.Unlock()
	drop := func() {
		rc.mu.Lock()
		delete(rc.pending, id)
		delete(rc.callers, id)
		rc.mu.Unlock()
	}
	if !rc.send(frame) {
		drop()
		return webproto.RunnerFrame{}, errRunnerUnavailable
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case res := <-ch:
		return res, nil
	case <-timer.C:
		drop()
		rc.send(webproto.GoFrame{T: "cancel", ID: id})
		return webproto.RunnerFrame{}, errCallTimeout
	case <-ctx.Done():
		drop()
		rc.send(webproto.GoFrame{T: "cancel", ID: id})
		return webproto.RunnerFrame{}, ctx.Err()
	case <-rc.done:
		return webproto.RunnerFrame{}, errRunnerUnavailable
	}
}

// ---------------------------------------------------------------------------
// Accepting a runner

func isWebSocketUpgrade(r *http.Request) bool {
	return strings.EqualFold(r.Header.Get("Upgrade"), "websocket") &&
		strings.Contains(strings.ToLower(r.Header.Get("Connection")), "upgrade")
}

func bearerToken(r *http.Request) string {
	parts := strings.SplitN(r.Header.Get("Authorization"), " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return ""
	}
	return strings.TrimSpace(parts[1])
}

// directLoopback reports whether the request comes straight from this host
// (no proxy in between): the local runner token is accepted only then.
func directLoopback(r *http.Request) bool {
	for _, h := range []string{"X-Forwarded-For", "X-Real-Ip", "Forwarded", "Cf-Connecting-Ip", "True-Client-Ip"} {
		if r.Header.Get(h) != "" {
			return false
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

type runnerIdentity struct {
	id     string
	name   string
	record int64
}

func (c *Component) authenticateRunner(ctx context.Context, r *http.Request) (runnerIdentity, bool) {
	token := bearerToken(r)
	if len(token) < 16 || len(token) > 512 {
		return runnerIdentity{}, false
	}
	b := c.backends()
	if local := b.LocalRunnerToken; local != "" && directLoopback(r) &&
		subtle.ConstantTimeCompare([]byte(token), []byte(local)) == 1 {
		return runnerIdentity{id: LocalRunnerID, name: "Local runner"}, true
	}
	rec, err := b.Runners.Authenticate(ctx, hashRunnerToken(token))
	if err != nil {
		if !errors.Is(err, ErrNoRunner) {
			slog.Warn("claudex webhost: runner token check failed", "error", err)
		}
		return runnerIdentity{}, false
	}
	return runnerIdentity{id: rec.LinkID(), name: rec.Name, record: rec.ID}, true
}

func jsonError(g *gin.Context, status int, code, message string) {
	g.AbortWithStatusJSON(status, webproto.ErrorResponse(code, message))
}

// GET /web/runner/link (public group; the runner token authenticates).
func (c *Component) runnerLink(g *gin.Context) {
	if !isWebSocketUpgrade(g.Request) {
		jsonError(g, http.StatusBadRequest, webproto.ErrCodeBadRequest, "This endpoint takes a WebSocket.")
		return
	}
	who, ok := c.authenticateRunner(g.Request.Context(), g.Request)
	if !ok {
		jsonError(g, http.StatusUnauthorized, webproto.ErrCodeBadRequest, "The runner token is not valid.")
		return
	}
	conn, err := websocket.Accept(g.Writer, g.Request, &websocket.AcceptOptions{
		Subprotocols: []string{webproto.RunnerLinkSubprotocol},
		// Not a browser: the token authenticates, there is no Origin to check.
		InsecureSkipVerify: true,
	})
	if err != nil {
		return
	}
	if conn.Subprotocol() != webproto.RunnerLinkSubprotocol {
		_ = conn.Close(webproto.CloseProtocolError, "sub-protocol "+webproto.RunnerLinkSubprotocol+" required")
		return
	}
	conn.SetReadLimit(webproto.LinkFrameBytes + linkReadSlack)
	c.serveRunner(g.Request.Context(), conn, who)
}

func (c *Component) serveRunner(ctx context.Context, conn *websocket.Conn, who runnerIdentity) {
	hctx, cancel := context.WithTimeout(ctx, linkHelloTimeout)
	typ, data, err := conn.Read(hctx)
	cancel()
	if err != nil {
		_ = conn.Close(webproto.CloseProtocolError, "no hello")
		return
	}
	hello, err := webproto.DecodeRunnerFrame(data)
	if typ != websocket.MessageText || err != nil || hello.T != "hello" {
		_ = conn.Close(webproto.CloseProtocolError, "hello expected")
		return
	}
	rc := &runnerConn{
		c: c, id: who.id, name: who.name, record: who.record, conn: conn,
		version: printable(hello.Version, 64), methods: map[string]bool{}, labels: cleanLabels(hello.Labels),
		connectedAt: c.now(), out: make(chan []byte, linkQueue), done: make(chan struct{}),
		requests: make(chan struct{}, linkRequestLimit), pending: map[string]chan webproto.RunnerFrame{},
	}
	if hello.Capacity != nil {
		rc.capacity = *hello.Capacity
	}
	for _, m := range hello.Methods {
		if !internalMethods[m] {
			rc.methods[m] = true
		}
	}
	rc.lastHeard.Store(c.now().UnixNano())
	if old := c.reg.attach(rc); old != nil {
		old.close(webproto.CloseReplaced, "replaced by a new link")
	}
	if who.record > 0 {
		sctx, scancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		if err := c.backends().Runners.Seen(sctx, who.record, rc.version, rc.labels); err != nil {
			slog.Warn("claudex webhost: recording the runner failed", "runner_id", rc.id, "error", err)
		}
		scancel()
	}
	slog.Info("claudex webhost: runner linked", "runner_id", rc.id, "version", rc.version, "methods", len(rc.methods))
	go rc.writer()
	rc.send(webproto.GoFrame{T: "welcome", V: webproto.Version, RunnerID: rc.id, HeartbeatMs: c.heartbeat.Milliseconds()})
	go rc.pinger()
	// The users this runner serves who have tabs open learn their presence.
	for _, p := range c.hubs.presenceFor(rc.id) {
		rc.presence(p.userID, p.tabs, p.focused)
	}
	rc.reader(ctx)
}

func (rc *runnerConn) writer() {
	for {
		select {
		case data := <-rc.out:
			ctx, cancel := context.WithTimeout(context.Background(), linkWriteTimeout)
			err := rc.conn.Write(ctx, websocket.MessageText, data)
			cancel()
			if err != nil {
				rc.close(websocket.StatusGoingAway, "write failed")
				return
			}
		case <-rc.done:
			return
		}
	}
}

func (rc *runnerConn) pinger() {
	hb := rc.c.heartbeat
	t := time.NewTicker(hb)
	defer t.Stop()
	for {
		select {
		case <-rc.done:
			return
		case <-t.C:
			silent := time.Duration(rc.c.now().UnixNano() - rc.lastHeard.Load())
			if silent > hb*5/2 {
				rc.close(websocket.StatusGoingAway, "silent")
				return
			}
			rc.send(webproto.GoFrame{T: "ping"})
		}
	}
}

func (rc *runnerConn) reader(ctx context.Context) {
	defer rc.close(websocket.StatusNormalClosure, "")
	for {
		typ, data, err := rc.conn.Read(ctx)
		if err != nil {
			return
		}
		rc.lastHeard.Store(rc.c.now().UnixNano())
		if typ != websocket.MessageText {
			rc.close(webproto.CloseProtocolError, "binary frame")
			return
		}
		f, err := webproto.DecodeRunnerFrame(data)
		if err != nil {
			slog.Warn("claudex webhost: bad runner frame", "runner_id", rc.id, "error", err)
			rc.close(webproto.CloseProtocolError, "protocol error")
			return
		}
		rc.handle(ctx, f)
	}
}

func (rc *runnerConn) handle(ctx context.Context, f webproto.RunnerFrame) {
	c := rc.c
	switch f.T {
	case "result":
		rc.mu.Lock()
		ch := rc.pending[f.ID]
		caller := rc.callers[f.ID]
		delete(rc.pending, f.ID)
		delete(rc.callers, f.ID)
		rc.mu.Unlock()
		if ch != nil {
			if caller != 0 {
				f.HubSeq = c.hubs.lastSeq(caller)
			}
			ch <- f
		}
	case "event":
		if !c.reg.routed(ctx, f.UserID, rc.id) {
			c.dropped.Add(1)
			return
		}
		c.hubs.publish(f.UserID, f.Event)
		c.runs.observe(f.UserID, f.Event)
	case "open-url":
		if !c.reg.routed(ctx, f.UserID, rc.id) {
			c.dropped.Add(1)
			return
		}
		c.hubs.openURL(f.UserID, f.URL, f.Target, f.TabID)
	case "request":
		select {
		case rc.requests <- struct{}{}:
		case <-rc.done:
			return
		}
		go func() {
			defer func() { <-rc.requests }()
			rc.serveRequest(ctx, f)
		}()
	case "load":
		rc.mu.Lock()
		rc.load = linkLoad{Engines: *f.Engines, Users: *f.Users, RSSMb: *f.RSSMb, At: c.now()}
		rc.mu.Unlock()
	case "ping":
		rc.send(webproto.GoFrame{T: "pong"})
	case "pong":
	case "hello":
		rc.close(webproto.CloseProtocolError, "hello twice")
	}
}

// serveRequest answers a runner's store or key request.
func (rc *runnerConn) serveRequest(ctx context.Context, f webproto.RunnerFrame) {
	c := rc.c
	defer func() {
		if r := recover(); r != nil {
			slog.Error("claudex webhost: runner request panicked", "op", f.Op, "panic", r)
			rc.respondError(f.ID, &webproto.RPCError{Code: webproto.ErrCodeHandlerFailed, Message: "The Claudex service couldn't answer. Try again."})
		}
	}()
	rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), linkRequestBudget)
	defer cancel()
	if webproto.IsUserOp(f.Op) && !c.reg.routed(rctx, f.UserID, rc.id) {
		c.dropped.Add(1)
		rc.respondError(f.ID, &webproto.RPCError{Code: webproto.ErrCodeNotAllowed, Message: "This runner does not serve that user."})
		return
	}
	b := c.backends()
	var value any
	var err error
	switch {
	case f.Op == "device.list" || f.Op == "device.call":
		value, err = c.chatDeviceRequest(rctx, f.UserID, f.Op, f.Body)
	case strings.HasPrefix(f.Op, "store."):
		if b.Store == nil {
			err = errRunnerUnavailable
			break
		}
		value, err = b.Store.ServeRunnerOp(rctx, f.UserID, f.Op, f.Body)
	case strings.HasPrefix(f.Op, "github."):
		if b.GitHub == nil {
			err = errRunnerUnavailable
			break
		}
		value, err = b.GitHub.ServeGitHubOp(rctx, f.UserID, f.Op, f.Body)
	case f.Op == "key.get":
		tok, ok := c.tokens.get(f.UserID, c.now())
		if !ok {
			err = infraerrors.Unauthorized("CLAUDEX_SESSION_REVOKED", "Your session has expired. Sign in again.")
			break
		}
		value, err = b.WebKey(rctx, KeyRequest{UserID: f.UserID, Claims: tok.claims, IP: tok.ip})
	case f.Op == "location.get":
		tok, ok := c.tokens.get(f.UserID, c.now())
		if !ok {
			err = infraerrors.Unauthorized("CLAUDEX_SESSION_REVOKED", "Your session has expired. Sign in again.")
			break
		}
		value = geoip.Lookup(tok.ip)
	case f.Op == webproto.OpRoutineToken:
		value, err = c.routineToken(rctx, f.UserID)
	case f.Op == webproto.OpRoutineAPIToken:
		value, err = c.routineAPIToken(rctx, f.UserID, f.Body)
	default:
		rc.respondError(f.ID, &webproto.RPCError{Code: webproto.ErrCodeMethodUnavailable, Message: "Unknown request."})
		return
	}
	if err != nil {
		rc.respondError(f.ID, requestError(err))
		return
	}
	raw, err := json.Marshal(value)
	if err != nil {
		rc.respondError(f.ID, &webproto.RPCError{Code: webproto.ErrCodeHandlerFailed, Message: "The Claudex service couldn't answer. Try again."})
		return
	}
	ok := true
	resp := webproto.GoFrame{T: "response", ID: f.ID, OK: &ok}
	if string(raw) != "null" {
		resp.Value = raw
	}
	rc.send(resp)
}

func (rc *runnerConn) respondError(id string, e *webproto.RPCError) {
	ok := false
	rc.send(webproto.GoFrame{T: "response", ID: id, OK: &ok, Error: e})
}

// requestError turns a webstore, devices or relay error into the frame's
// error (internal errors never carry their cause).
func requestError(err error) *webproto.RPCError {
	var op *webstore.OpError
	if errors.As(err, &op) {
		return op.RPCError()
	}
	app := infraerrors.FromError(err)
	if app.Reason == "" {
		slog.Warn("claudex webhost: runner request failed", "error", err)
		return &webproto.RPCError{Code: webproto.ErrCodeHandlerFailed, Message: "The Claudex service couldn't answer. Try again."}
	}
	e := &webproto.RPCError{Code: app.Reason, Message: app.Message}
	if len(app.Metadata) > 0 {
		if raw, err := json.Marshal(app.Metadata); err == nil {
			e.Details = raw
		}
	}
	return e
}
