package webhost

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"sync"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/ip"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
)

// The RPC relay (web plan §1.2): POST /api/v1/claudex/web/rpc/<method> with
// {args}. It sits in the user group (JWT with the revocation check, Backend
// mode guard, panel rate limit, audit log without the body), then checks the
// web switch and allowlist, the method (only what the user's runner listed
// in its hello, which is the remote-runner part of the bridge method table
// the runner registered), capacity for a turn, and relays the call to the
// user's runner. HTTP 200 carries the handler's outcome; the relay's own
// refusals use their HTTP status with the same {ok:false,error} body.

// maxCallsPerUser caps one user's calls in flight.
const maxCallsPerUser = 32

var (
	errMethodUnavailable = infraerrors.NotFound(webproto.ErrCodeMethodUnavailable, "Not available on the web.")
	errBadRPC            = infraerrors.BadRequest(webproto.ErrCodeBadRequest, "The request was not valid.")
	errTooLarge          = infraerrors.New(http.StatusRequestEntityTooLarge, webproto.ErrCodeTooLarge, "This is too large to send.")
	errTooManyCalls      = infraerrors.TooManyRequests("CLAUDEX_WEB_TOO_MANY_CALLS", "Too many requests at once. Wait a moment and try again.")
	errNoToken           = infraerrors.Unauthorized("UNAUTHORIZED", "Sign in to continue.")
)

// rpcFail answers a refusal of the relay itself.
func rpcFail(g *gin.Context, err error) {
	status, body := infraerrors.ToHTTP(err)
	e := &webproto.RPCError{Code: body.Reason, Message: body.Message}
	if status >= 500 && body.Reason == "" {
		e = &webproto.RPCError{Code: webproto.ErrCodeHandlerFailed, Message: "The Claudex service couldn't answer. Try again."}
	}
	if len(body.Metadata) > 0 {
		if raw, err := json.Marshal(body.Metadata); err == nil {
			e.Details = raw
		}
	}
	g.Header("Cache-Control", "no-store")
	g.AbortWithStatusJSON(status, webproto.RPCResponse{OK: false, Error: e})
}

func rpcOK(g *gin.Context, value any) {
	resp, err := webproto.OKResponse(value)
	if err != nil {
		rpcFail(g, err)
		return
	}
	g.Header("Cache-Control", "no-store")
	g.JSON(http.StatusOK, resp)
}

// caller is the signed-in user of a user-group request.
type caller struct {
	userID int64
	email  string
	admin  bool
	token  userToken
	tabID  string
}

// authorize reads the caller and checks the web switch and allowlist.
func (c *Component) authorize(g *gin.Context) (caller, bool) {
	uid, ok := core.Subject(g)
	if !ok {
		rpcFail(g, errNoToken)
		return caller{}, false
	}
	role, _ := middleware.GetUserRoleFromContext(g)
	who := caller{userID: uid, email: g.GetString(middleware.ContextKeyAuthEmail), admin: role == service.RoleAdmin}
	b := c.backends()
	if err := b.CheckAccess(g.Request.Context(), uid, who.email, who.admin); err != nil {
		rpcFail(g, err)
		return caller{}, false
	}
	raw := bearerToken(g.Request)
	if raw == "" {
		rpcFail(g, errNoToken)
		return caller{}, false
	}
	claims, err := b.ParseToken(raw)
	if err != nil || claims.UserID != uid {
		rpcFail(g, errNoToken)
		return caller{}, false
	}
	who.token = userToken{raw: raw, claims: claims, ip: clip(ip.GetClientIP(g), 64)}
	if tab := g.GetHeader(webproto.HeaderTab); tab != "" && webproto.ValidTabID(tab) {
		who.tabID = tab
	}
	c.tokens.put(uid, who.token)
	return who, true
}

func clip(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

// callGate caps each user's calls in flight.
type callGate struct {
	mu sync.Mutex
	n  map[int64]int
}

func (g *callGate) enter(userID int64) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.n == nil {
		g.n = map[int64]int{}
	}
	if g.n[userID] >= maxCallsPerUser {
		return false
	}
	g.n[userID]++
	return true
}

func (g *callGate) leave(userID int64) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.n[userID] <= 1 {
		delete(g.n, userID)
		return
	}
	g.n[userID]--
}

// POST /web/rpc/:method
func (c *Component) rpc(g *gin.Context) {
	who, ok := c.authorize(g)
	if !ok {
		return
	}
	method := g.Param("method")
	if !webproto.ValidMethodName(method) || internalMethods[method] {
		rpcFail(g, errMethodUnavailable)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(g.Writer, g.Request.Body, webproto.RPCBodyBytes))
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			rpcFail(g, errTooLarge)
		} else {
			rpcFail(g, errBadRPC)
		}
		return
	}
	req, err := webproto.DecodeRPCRequest(body)
	if err != nil {
		rpcFail(g, errBadRPC)
		return
	}
	if !c.gate.enter(who.userID) {
		rpcFail(g, errTooManyCalls)
		return
	}
	defer c.gate.leave(who.userID)

	ctx := g.Request.Context()
	rc, err := c.reg.pick(ctx, who.userID)
	if err != nil {
		rpcFail(g, err)
		return
	}
	if !rc.methods[method] {
		rpcFail(g, errMethodUnavailable)
		return
	}
	var ru *run
	var fresh bool
	if engineStartingMethods[method] {
		conv, mode := runTarget(method, req.Args)
		ru, fresh, err = c.runs.begin(ctx, who.userID, conv, mode, rc.id)
		if err != nil {
			rpcFail(g, err)
			return
		}
	}
	user := webproto.LinkUser{ID: who.userID, TabID: who.tabID, AccessToken: who.token.raw}
	res, callErr := rc.call(ctx, user, method, req.Args, c.callTimeout)
	if ru != nil {
		c.runs.after(ru, fresh, res, callErr)
	}
	if callErr != nil {
		if errors.Is(callErr, context.Canceled) {
			// The browser went away; nobody reads the answer.
			g.Abort()
			return
		}
		rpcFail(g, callErr)
		return
	}
	if res.OK == nil {
		rpcFail(g, errRunnerUnavailable)
		return
	}
	out := webproto.RPCResponse{OK: *res.OK, Value: res.Value, Error: res.Error}
	if out.OK && method == createPreviewMethod {
		out.Value = c.signPreviewValue(who.userID, out.Value)
	}
	if out.Validate() != nil {
		slog.Warn("claudex webhost: runner answered an invalid result", "runner_id", rc.id, "method", method)
		rpcFail(g, errRunnerUnavailable)
		return
	}
	if method == "snapshot" {
		// The events the snapshot already holds: a tab whose stream comes
		// up at this number missed nothing and need not read it again.
		g.Header(webproto.EventSeqHeader, strconv.FormatInt(res.HubSeq, 10))
	}
	g.Header("Cache-Control", "no-store")
	g.JSON(http.StatusOK, out)
}
