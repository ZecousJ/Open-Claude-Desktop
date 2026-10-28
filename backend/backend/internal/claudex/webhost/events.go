package webhost

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/wscompat"

	"github.com/coder/websocket"
	"github.com/gin-gonic/gin"
)

// The events socket (web plan §2 #3): one WebSocket per tab at
// /api/v1/claudex/web/events. The one-time ticket rides in
// Sec-WebSocket-Protocol ("claudex.v1", "ticket.<t>"); the server selects
// claudex.v1 only. The ticket is bound to the tab id, which the first frame
// (hello) carries, so the socket is accepted first and the ticket redeemed
// with that hello; every refusal is an error frame and a close code the
// browser understands (4001 ticket, 4003 not allowed, 4008 signed out).

const (
	eventsHelloTimeout = 10 * time.Second
	eventsReadLimit    = 64 << 10
	eventsWriteTimeout = 20 * time.Second
	// tabLifetime bounds a socket: it then reconnects with a new ticket
	// (fresh access checks) and resumes from the ring.
	tabLifetime      = time.Hour
	snapshotTimeout  = 10 * time.Second
	eventsSilentMult = 5 // 2.5 heartbeats, in half heartbeats
)

// GET /web/events (public group; the ticket authenticates).
func (c *Component) events(g *gin.Context) {
	if !isWebSocketUpgrade(g.Request) {
		jsonError(g, http.StatusBadRequest, webproto.ErrCodeBadRequest, "This endpoint takes a WebSocket.")
		return
	}
	ticket, hasTicket := webproto.TicketFromSubprotocols(g.Request.Header.Values("Sec-WebSocket-Protocol"))
	conn, err := websocket.Accept(g.Writer, g.Request, wscompat.AcceptOptions(webproto.EventsSubprotocol))
	if err != nil {
		return
	}
	if conn.Subprotocol() != webproto.EventsSubprotocol {
		refuse(conn, webproto.CloseProtocolError, webproto.ErrCodeBadRequest, "The claudex.v1 sub-protocol is required.")
		return
	}
	if !hasTicket {
		refuse(conn, webproto.CloseBadTicket, webproto.ErrCodeBadTicket, "The events ticket is not valid. Request a new one.")
		return
	}
	conn.SetReadLimit(eventsReadLimit)
	c.serveTab(g.Request.Context(), conn, ticket)
}

// refuse sends an error frame and closes.
func refuse(conn *websocket.Conn, code websocket.StatusCode, errCode, message string) {
	data, _ := json.Marshal(webproto.ErrorFrame(errCode, message))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	_ = conn.Write(ctx, websocket.MessageText, data)
	cancel()
	_ = conn.Close(code, errCode)
}

// signedOutCodes are the error codes of a 4008 close the browser maps to a
// signed-out reason.
const (
	signedOutRevoked = "revoked"
)

// admit checks a user for the web app outside the JWT routes: active,
// allowed (switch and allowlist) and not locked out by Backend mode.
// It returns the close code and error to refuse with.
func (c *Component) admit(ctx context.Context, userID int64) (websocket.StatusCode, string, string, bool) {
	b := c.backends()
	u, err := b.LookupUser(ctx, userID)
	if err != nil || !u.Active {
		if err != nil && !errors.Is(err, context.Canceled) {
			slog.Debug("claudex webhost: user lookup failed", "user_id", userID, "error", err)
		}
		return webproto.CloseSignedOut, signedOutRevoked, "This session was signed out. Sign in again.", false
	}
	if err := b.CheckAccess(ctx, userID, u.Email, u.Admin); err != nil {
		app := infraerrors.FromError(err)
		code := app.Reason
		if code == "" {
			code = webproto.ErrCodeNotAllowed
		}
		return webproto.CloseForbidden, code, app.Message, false
	}
	if !u.Admin && b.BackendMode(ctx) {
		return webproto.CloseForbidden, webproto.ErrCodeNotAllowed, "Backend mode is active. Only administrators can sign in.", false
	}
	return 0, "", "", true
}

func (c *Component) serveTab(ctx context.Context, conn *websocket.Conn, ticket string) {
	hctx, cancel := context.WithTimeout(ctx, eventsHelloTimeout)
	typ, data, err := conn.Read(hctx)
	cancel()
	if err != nil {
		_ = conn.Close(webproto.CloseProtocolError, "no hello")
		return
	}
	hello, err := webproto.DecodeBrowserFrame(data)
	if typ != websocket.MessageText || err != nil || hello.T != "hello" {
		refuse(conn, webproto.CloseProtocolError, webproto.ErrCodeBadRequest, "The first frame must be hello.")
		return
	}
	b := c.backends()
	userID, err := b.RedeemTicket(ctx, ticket, hello.TabID)
	if err != nil || userID <= 0 {
		refuse(conn, webproto.CloseBadTicket, webproto.ErrCodeBadTicket, "The events ticket is not valid. Request a new one.")
		return
	}
	if code, errCode, msg, ok := c.admit(ctx, userID); !ok {
		refuse(conn, code, errCode, msg)
		return
	}

	t := newTab(hello.TabID, userID, c.now())
	t.killFn = func(code websocket.StatusCode, reason string) {
		go func() { _ = conn.Close(code, reason) }()
	}
	resumed, ok := c.hubs.attach(t, hello.LastSeq)
	if !ok {
		refuse(conn, webproto.CloseUnavailable, webproto.ErrCodeCapacity, "Too many Claudex tabs are open. Close some and try again.")
		return
	}
	defer c.hubs.detach(t)
	// The tab lost events: send the whole state when the runner can give it
	// (the tab resyncs by itself otherwise).
	if !resumed && hello.LastSeq != nil {
		go c.pushSnapshot(t)
	}

	done := make(chan struct{})
	defer close(done)
	go c.tabWriter(conn, t, done)
	lifetime := time.AfterFunc(tabLifetime, func() { t.kill(websocket.StatusNormalClosure, "renew") })
	defer lifetime.Stop()

	silent := c.heartbeat * eventsSilentMult / 2
	for {
		rctx, rcancel := context.WithTimeout(ctx, silent)
		typ, data, err := conn.Read(rctx)
		rcancel()
		if err != nil {
			t.kill(websocket.StatusGoingAway, "")
			return
		}
		if typ != websocket.MessageText {
			t.kill(webproto.CloseProtocolError, "binary frame")
			return
		}
		f, err := webproto.DecodeBrowserFrame(data)
		if err != nil || f.T == "hello" {
			t.finish(webproto.CloseProtocolError, webproto.ErrCodeBadRequest, "The frame was not valid.")
			continue
		}
		switch f.T {
		case "ping":
			pong, _ := json.Marshal(webproto.ServerFrame{T: "pong"})
			t.enqueue(pong)
		case "presence":
			t.setState(*f.Visible, *f.Focused)
			c.presenceChanged(userID)
		}
	}
}

func (c *Component) tabWriter(conn *websocket.Conn, t *tabConn, done <-chan struct{}) {
	for {
		frames, finished, code, reason := t.next()
		for _, f := range frames {
			ctx, cancel := context.WithTimeout(context.Background(), eventsWriteTimeout)
			err := conn.Write(ctx, websocket.MessageText, f)
			cancel()
			if err != nil {
				t.kill(websocket.StatusGoingAway, "write failed")
				return
			}
		}
		if finished {
			if code != 0 {
				_ = conn.Close(code, reason)
			}
			return
		}
		if len(frames) > 0 {
			continue
		}
		select {
		case <-t.signal:
		case <-done:
			return
		}
	}
}

// pushSnapshot asks the user's runner for the whole state and sends it to
// the tab as a snapshot frame.
func (c *Component) pushSnapshot(t *tabConn) {
	ctx, cancel := context.WithTimeout(context.Background(), snapshotTimeout)
	defer cancel()
	rc := c.reg.current(ctx, t.userID)
	if rc == nil || !rc.methods["snapshot"] {
		return
	}
	tok, ok := c.tokens.get(t.userID, c.now())
	if !ok {
		return
	}
	res, err := rc.call(ctx, webproto.LinkUser{ID: t.userID, TabID: t.id, AccessToken: tok.raw}, "snapshot", nil, snapshotTimeout)
	if err != nil || res.OK == nil || !*res.OK || len(res.Value) == 0 {
		return
	}
	c.hubs.sendSnapshot(t, res.Value)
}

// presenceChanged reports a user's tabs to the runner that serves the user.
func (c *Component) presenceChanged(userID int64) {
	rc := c.reg.current(context.Background(), userID)
	if rc == nil {
		return
	}
	p, changed := c.hubs.presence(userID, true)
	if changed {
		rc.presence(userID, p.tabs, p.focused)
	}
}

// endUser closes a user's tabs (error frame, then close code) and tells the
// user's runner to drop the user's credentials.
func (c *Component) endUser(userID int64, code websocket.StatusCode, errCode, message, runnerReason string) {
	for _, t := range c.hubs.tabsOf(userID) {
		t.finish(code, errCode, message)
	}
	c.endDevices(userID, code, errCode)
	if rc := c.reg.current(context.Background(), userID); rc != nil && runnerReason != "" {
		rc.signOut(userID, runnerReason)
	}
}
