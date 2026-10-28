package webhost

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"

	"github.com/coder/websocket"
	"github.com/stretchr/testify/require"
)

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

const userA, userB int64 = 101, 202

type echo struct {
	User   int64           `json:"user"`
	Token  string          `json:"token"`
	Method string          `json:"method"`
	Args   json.RawMessage `json:"args"`
	Tab    string          `json:"tab"`
}

func decodeEcho(t *testing.T, res webproto.RPCResponse) echo {
	t.Helper()
	require.True(t, res.OK, "%+v", res.Error)
	var e echo
	require.NoError(t, json.Unmarshal(res.Value, &e))
	return e
}

func TestComponentWithoutDependencies(t *testing.T) {
	c := New(&core.Env{})
	require.Equal(t, core.NameWebHost, c.Name())
	c.Start(context.Background())
	require.NoError(t, c.OnSessionsRevoked(context.Background(), 1, "revoke_all"))
}

func TestRPCRelaysTheCallerToTheRunner(t *testing.T) {
	h := newHost(t)
	h.runner()
	status, res := h.rpc(userA, "listThings", "x", 2)
	require.Equal(t, http.StatusOK, status)
	e := decodeEcho(t, res)
	require.Equal(t, userA, e.User)
	require.Equal(t, tokenOf(userA), e.Token)
	require.Equal(t, "listThings", e.Method)
	require.JSONEq(t, `["x",2]`, string(e.Args))
	require.Equal(t, "tab-101-000001", e.Tab)

	status, res = h.rpc(userB, "listThings")
	require.Equal(t, http.StatusOK, status)
	require.Equal(t, userB, decodeEcho(t, res).User)
}

func TestRPCRefusals(t *testing.T) {
	h := newHost(t)
	// No runner linked.
	status, res := h.rpc(userA, "listThings")
	require.Equal(t, http.StatusServiceUnavailable, status)
	require.Equal(t, webproto.ErrCodeRunnerUnavailable, res.Error.Code)

	h.runner()
	// A method the runner did not list, and the runner-internal one.
	for _, m := range []string{"openFolder", previewMethod, "Bad-Name"} {
		status, res = h.rpc(userA, m)
		require.Equal(t, http.StatusNotFound, status, m)
		require.Equal(t, webproto.ErrCodeMethodUnavailable, res.Error.Code, m)
		require.Equal(t, "Not available on the web.", res.Error.Message)
	}
	// Not on the allowlist.
	h.mu.Lock()
	h.denied[userB] = true
	h.mu.Unlock()
	status, res = h.rpc(userB, "listThings")
	require.Equal(t, http.StatusForbidden, status)
	require.Equal(t, webproto.ErrCodeNotAllowed, res.Error.Code)
	// Malformed bodies.
	status, res = h.post(userA, webproto.PathRPC+"listThings", "application/json", []byte(`{"args":{}}`))
	require.Equal(t, http.StatusBadRequest, status)
	require.Equal(t, webproto.ErrCodeBadRequest, res.Error.Code)
	big := `{"args":["` + strings.Repeat("a", webproto.RPCBodyBytes) + `"]}`
	status, res = h.post(userA, webproto.PathRPC+"listThings", "application/json", []byte(big))
	require.Equal(t, http.StatusRequestEntityTooLarge, status)
	require.Equal(t, webproto.ErrCodeTooLarge, res.Error.Code)
}

func TestRPCPassesHandlerErrorsAndTimesOut(t *testing.T) {
	h := newHost(t)
	h.c.callTimeout = 300 * time.Millisecond
	fr, err := h.dialRunner(localToken, defaultMethods, func(f webproto.GoFrame) (any, *webproto.RPCError, bool) {
		if f.Method == "slow" {
			return nil, nil, false
		}
		return nil, &webproto.RPCError{Message: "Nope.", Code: "CLAUDEX_X"}, true
	})
	require.NoError(t, err)
	status, res := h.rpc(userA, "listThings")
	require.Equal(t, http.StatusOK, status)
	require.False(t, res.OK)
	require.Equal(t, "Nope.", res.Error.Message)
	require.Equal(t, "CLAUDEX_X", res.Error.Code)

	status, res = h.rpc(userA, "slow")
	require.Equal(t, http.StatusGatewayTimeout, status)
	require.Equal(t, webproto.ErrCodeTimeout, res.Error.Code)
	waitFor(t, "cancel", func() bool { return len(fr.framesOf("cancel")) == 1 })
}

// Tenant isolation: one user's events reach that user's tabs only, and a
// runner is heard only for the users assigned to it.
func TestEventsReachOnlyTheirUser(t *testing.T) {
	h := newHost(t)
	fr := h.runner()
	h.rpc(userA, "listThings") // assigns A to the runner
	tabA := h.openTab(userA, "tab-a-000001", nil)
	tabA2 := h.openTab(userA, "tab-a-000002", nil)
	tabB := h.openTab(userB, "tab-b-000001", nil)
	readyA := tabA.ready()
	require.False(t, *readyA.Resumed)
	tabB.ready()
	tabA2.ready()

	fr.event(userA, map[string]any{"type": "conversation", "conversation": map[string]any{"id": "c1", "title": "secret of A"}})
	// B is not assigned to this runner yet: dropped.
	fr.event(userB, map[string]any{"type": "conversation", "conversation": map[string]any{"id": "c2", "title": "early B"}})
	waitFor(t, "A's event", func() bool { return len(tabA.of("event")) == 1 && len(tabA2.of("event")) == 1 })
	ev := tabA.of("event")[0]
	require.Equal(t, *readyA.Seq+1, *ev.Seq)
	require.Contains(t, string(ev.Event), "secret of A")

	h.rpc(userB, "listThings")
	fr.event(userB, map[string]any{"type": "conversation", "conversation": map[string]any{"id": "c3", "title": "secret of B"}})
	waitFor(t, "B's event", func() bool { return len(tabB.of("event")) == 1 })
	require.Contains(t, string(tabB.of("event")[0].Event), "secret of B")
	time.Sleep(50 * time.Millisecond)
	for _, f := range tabA.all() {
		require.NotContains(t, string(f.Event), "B")
	}
	for _, f := range tabB.all() {
		require.NotContains(t, string(f.Event), "secret of A")
		require.NotContains(t, string(f.Event), "early B")
	}
	require.GreaterOrEqual(t, h.c.dropped.Load(), int64(1))
}

func TestRunnerRequestsOnlyForAssignedUsers(t *testing.T) {
	h := newHost(t)
	fr := h.runner()
	h.rpc(userA, "listThings")

	res := fr.request("q1", "store.turns.list", userB, map[string]any{"conversationId": "c"})
	require.False(t, *res.OK)
	require.Equal(t, webproto.ErrCodeNotAllowed, res.Error.Code)
	require.Empty(t, h.store.list())

	res = fr.request("q2", "store.turns.list", userA, map[string]any{"conversationId": "c"})
	require.True(t, *res.OK, "%+v", res.Error)
	require.Equal(t, []string{"101:store.turns.list"}, h.store.list())
	var v map[string]any
	require.NoError(t, json.Unmarshal(res.Value, &v))
	require.EqualValues(t, userA, v["user"])

	// key.get runs for the assigned user with that user's session.
	res = fr.request("q3", "key.get", userA, map[string]any{})
	require.True(t, *res.OK)
	h.mu.Lock()
	require.Len(t, h.keys, 1)
	require.Equal(t, userA, h.keys[0].UserID)
	require.Equal(t, "sid-101", h.keys[0].Claims.SessionID)
	h.mu.Unlock()
	res = fr.request("q4", "key.get", userB, map[string]any{})
	require.False(t, *res.OK)

	res = fr.request("q5", "billing.charge", 0, nil)
	require.False(t, *res.OK)
	require.Equal(t, webproto.ErrCodeMethodUnavailable, res.Error.Code)
}

func TestTwoRunnersAreIsolated(t *testing.T) {
	h := newHost(t)
	local := h.runner()
	token, err := newRunnerToken()
	require.NoError(t, err)
	rec, err := h.dir.Create(context.Background(), "second", 0, hashRunnerToken(token))
	require.NoError(t, err)
	// A goes to the local runner (the only one), then the second one links.
	h.rpc(userA, "listThings")
	second, err := h.dialRunner(token, defaultMethods, echoCalls)
	require.NoError(t, err)
	require.Equal(t, rec.LinkID(), second.welcome.RunnerID)
	// B is assigned to the runner with fewer users: the second one.
	h.rpc(userB, "listThings")
	require.Len(t, second.framesOf("call"), 1)
	require.Equal(t, userB, second.framesOf("call")[0].User.ID)
	require.Len(t, local.framesOf("call"), 1)

	tabA := h.openTab(userA, "tab-a-000001", nil)
	tabA.ready()
	// The second runner cannot speak for A, nor read A's data.
	second.event(userA, map[string]any{"type": "conversation", "conversation": map[string]any{"id": "x", "title": "forged"}})
	res := second.request("s1", "store.settings.get", userA, nil)
	require.False(t, *res.OK)
	second.send(map[string]any{"t": "open-url", "userId": userA, "url": "https://evil.example/", "target": "same-tab"})
	local.event(userA, map[string]any{"type": "conversation", "conversation": map[string]any{"id": "y", "title": "real"}})
	waitFor(t, "the real event", func() bool { return len(tabA.of("event")) == 1 })
	time.Sleep(50 * time.Millisecond)
	require.Contains(t, string(tabA.of("event")[0].Event), "real")
	require.Empty(t, tabA.of("open-url"))
}

func TestResumeFromTheRing(t *testing.T) {
	h := newHost(t)
	fr := h.runner()
	h.rpc(userA, "listThings")
	tab := h.openTab(userA, "tab-a-000001", nil)
	ready := tab.ready()
	for i := 0; i < 3; i++ {
		fr.event(userA, map[string]any{"type": "conversation", "conversation": map[string]any{"id": fmt.Sprint(i)}})
	}
	waitFor(t, "3 events", func() bool { return len(tab.of("event")) == 3 })
	last := *tab.of("event")[2].Seq
	require.Equal(t, *ready.Seq+3, last)

	// Missed the last two: they are replayed.
	lastSeq := *ready.Seq + 1
	again := h.openTab(userA, "tab-a-000001", &lastSeq)
	r := again.ready()
	require.True(t, *r.Resumed)
	waitFor(t, "replay", func() bool { return len(again.of("event")) == 2 })
	require.Equal(t, lastSeq+1, *again.of("event")[0].Seq)
	// The same tab id replaced the first socket.
	require.Equal(t, websocket.StatusNormalClosure, tab.closeCode())

	// Up to date: resumed, nothing replayed.
	up := h.openTab(userA, "tab-a-000003", &last)
	require.True(t, *up.ready().Resumed)
	time.Sleep(30 * time.Millisecond)
	require.Empty(t, up.of("event"))

	// Too old (or from another server run): not resumed, and the runner's
	// snapshot follows.
	old := int64(5)
	stale := h.openTab(userA, "tab-a-000004", &old)
	require.False(t, *stale.ready().Resumed)
	waitFor(t, "snapshot", func() bool { return len(stale.of("snapshot")) == 1 })
}

func TestRingOverflowForcesASnapshot(t *testing.T) {
	h := newHost(t)
	fr, err := h.dialRunner(localToken, defaultMethods, func(f webproto.GoFrame) (any, *webproto.RPCError, bool) {
		if f.Method == "snapshot" {
			return map[string]any{"conversations": []any{}, "settings": map[string]any{}}, nil, true
		}
		return echoCalls(f)
	})
	require.NoError(t, err)
	h.rpc(userA, "listThings")
	tab := h.openTab(userA, "tab-a-000001", nil)
	first := *tab.ready().Seq
	for i := 0; i < webproto.EventRing+5; i++ {
		fr.event(userA, map[string]any{"type": "engine", "n": i})
	}
	waitFor(t, "all events", func() bool { return len(tab.of("event")) == webproto.EventRing+5 })
	stale := h.openTab(userA, "tab-a-000002", &first)
	require.False(t, *stale.ready().Resumed)
	waitFor(t, "snapshot", func() bool { return len(stale.of("snapshot")) == 1 })
	require.Empty(t, stale.of("event"))
	inRing := first + 10
	fresh := h.openTab(userA, "tab-a-000003", &inRing)
	require.True(t, *fresh.ready().Resumed)
	waitFor(t, "replay", func() bool { return len(fresh.of("event")) == webproto.EventRing-5 })
}

func TestEventsSocketRefusals(t *testing.T) {
	h := newHost(t)
	// Unknown ticket.
	tab := h.openTabWithTicket(strings.Repeat("A", 43), "tab-x-000001", nil)
	require.Equal(t, websocket.StatusCode(webproto.CloseBadTicket), tab.closeCode())
	// A ticket used for another tab.
	tk := h.ticket(userA, "tab-a-000001")
	tab = h.openTabWithTicket(tk, "tab-a-000009", nil)
	require.Equal(t, websocket.StatusCode(webproto.CloseBadTicket), tab.closeCode())
	// Not allowed.
	h.mu.Lock()
	h.denied[userB] = true
	h.mu.Unlock()
	tab = h.openTab(userB, "tab-b-000001", nil)
	require.Equal(t, websocket.StatusCode(webproto.CloseForbidden), tab.closeCode())
	require.Equal(t, webproto.ErrCodeNotAllowed, tab.of("error")[0].Code)
	// No ticket offered at all.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, h.wsURL(webproto.PathEvents), &websocket.DialOptions{Subprotocols: []string{webproto.EventsSubprotocol}})
	require.NoError(t, err)
	_, _, _ = conn.Read(ctx) // the error frame
	_, _, err = conn.Read(ctx)
	require.Equal(t, websocket.StatusCode(webproto.CloseBadTicket), websocket.CloseStatus(err))
	// Plain HTTP.
	res, err := http.Get(h.srv.URL + webproto.PathEvents)
	require.NoError(t, err)
	_ = res.Body.Close()
	require.Equal(t, http.StatusBadRequest, res.StatusCode)
}

func TestRevokeClosesTabsAndSignsTheRunnerOut(t *testing.T) {
	h := newHost(t)
	fr := h.runner()
	h.rpc(userA, "listThings")
	h.rpc(userB, "listThings")
	tabA := h.openTab(userA, "tab-a-000001", nil)
	tabB := h.openTab(userB, "tab-b-000001", nil)
	tabA.ready()
	tabB.ready()
	require.NoError(t, h.c.OnSessionsRevoked(context.Background(), userA, "revoke_all"))
	require.Equal(t, websocket.StatusCode(webproto.CloseSignedOut), tabA.closeCode())
	require.Equal(t, "revoked", tabA.of("error")[0].Code)
	waitFor(t, "user-signed-out", func() bool { return len(fr.framesOf("user-signed-out")) == 1 })
	out := fr.framesOf("user-signed-out")[0]
	require.Equal(t, userA, out.UserID)
	require.Equal(t, webproto.SignedOutRevoked, out.Reason)
	// B is untouched.
	fr.event(userB, map[string]any{"type": "engine"})
	waitFor(t, "B still connected", func() bool { return len(tabB.of("event")) == 1 })
	// The runner can no longer get A's key (no token).
	res := fr.request("k", "key.get", userA, nil)
	require.False(t, *res.OK)
}

func TestSweepDisconnectsUsersWhoLostAccess(t *testing.T) {
	h := newHost(t)
	fr := h.runner()
	h.rpc(userA, "listThings")
	tab := h.openTab(userA, "tab-a-000001", nil)
	tab.ready()
	h.mu.Lock()
	h.denied[userA] = true
	h.mu.Unlock()
	h.c.sweep(context.Background())
	require.Equal(t, websocket.StatusCode(webproto.CloseForbidden), tab.closeCode())
	waitFor(t, "removed", func() bool { return len(fr.framesOf("user-signed-out")) == 1 })
	require.Equal(t, webproto.SignedOutRemoved, fr.framesOf("user-signed-out")[0].Reason)
}

func TestPresenceReachesTheRunner(t *testing.T) {
	h := newHost(t)
	fr := h.runner()
	h.rpc(userA, "listThings")
	tab := h.openTab(userA, "tab-a-000001", nil)
	tab.ready()
	waitFor(t, "presence", func() bool {
		p := fr.framesOf("presence")
		return len(p) > 0 && *p[len(p)-1].Tabs == 1 && *p[len(p)-1].Focused
	})
	data, _ := json.Marshal(map[string]any{"t": "presence", "visible": true, "focused": false})
	require.NoError(t, tab.conn.Write(context.Background(), websocket.MessageText, data))
	waitFor(t, "unfocused", func() bool {
		p := fr.framesOf("presence")
		return !*p[len(p)-1].Focused
	})
	_ = tab.conn.Close(websocket.StatusNormalClosure, "")
	waitFor(t, "no tabs", func() bool {
		p := fr.framesOf("presence")
		return *p[len(p)-1].Tabs == 0
	})
	for _, p := range fr.framesOf("presence") {
		require.Equal(t, userA, p.UserID)
	}
}

func TestRunnerLinkAuthentication(t *testing.T) {
	h := newHost(t)
	_, err := h.dialRunner("wrong-token-0123456789", defaultMethods, echoCalls)
	require.ErrorContains(t, err, "401")
	token, _ := newRunnerToken()
	rec, _ := h.dir.Create(context.Background(), "r", 0, hashRunnerToken(token))
	first, err := h.dialRunner(token, defaultMethods, echoCalls)
	require.NoError(t, err)
	// The same runner linking again replaces the first link.
	_, err = h.dialRunner(token, defaultMethods, echoCalls)
	require.NoError(t, err)
	<-first.closed
	require.Equal(t, websocket.StatusCode(webproto.CloseReplaced), first.code)
	// A revoked token cannot link.
	_, err = h.dir.Revoke(context.Background(), rec.ID)
	require.NoError(t, err)
	_, err = h.dialRunner(token, defaultMethods, echoCalls)
	require.ErrorContains(t, err, "401")
	// The local token only on a direct loopback connection.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, res, err := websocket.Dial(ctx, h.wsURL(webproto.PathRunnerLink), &websocket.DialOptions{
		HTTPHeader:   http.Header{"Authorization": []string{"Bearer " + localToken}, "X-Forwarded-For": []string{"203.0.113.9"}},
		Subprotocols: []string{webproto.RunnerLinkSubprotocol},
	})
	require.Error(t, err)
	require.Equal(t, http.StatusUnauthorized, res.StatusCode)
}

func TestCapacityFollowsTheTurn(t *testing.T) {
	h := newHost(t)
	fr, err := h.dialRunner(localToken, defaultMethods, func(f webproto.GoFrame) (any, *webproto.RPCError, bool) {
		if f.Method == "send" {
			var in []map[string]any
			_ = json.Unmarshal(f.Args, &in)
			id, _ := in[0]["conversationId"].(string)
			if id == "" {
				id = "conv-new"
			}
			return map[string]any{"id": id, "turns": []any{map[string]any{"status": "inProgress"}}}, nil, true
		}
		return echoCalls(f)
	})
	require.NoError(t, err)
	status, res := h.rpc(userA, "send", map[string]any{"text": "hi", "mode": "chat"})
	require.Equal(t, http.StatusOK, status, "%+v", res.Error)
	waitFor(t, "run bound", func() bool { return h.c.runs.active() == 1 })
	require.Equal(t, 1, h.slots.activeOf(userA))
	// Another conversation while the first turn runs: over the user's limit.
	status, res = h.rpc(userA, "send", map[string]any{"conversationId": "other", "text": "hi", "mode": "chat"})
	require.Equal(t, http.StatusServiceUnavailable, status)
	require.Equal(t, webproto.ErrCodeCapacity, res.Error.Code)
	require.JSONEq(t, `{"scope":"user"}`, string(res.Error.Details))
	// The same conversation (a follow-up while it runs) is not a new run.
	status, _ = h.rpc(userA, "send", map[string]any{"conversationId": "conv-new", "text": "more", "mode": "chat"})
	require.Equal(t, http.StatusOK, status)
	// B has its own limit.
	status, _ = h.rpc(userB, "send", map[string]any{"text": "hi", "mode": "chat"})
	require.Equal(t, http.StatusOK, status)
	// A's turn completes (seen in the events): the slot is free again.
	fr.event(userA, map[string]any{"type": "conversation", "conversation": map[string]any{"id": "conv-new", "turns": []any{map[string]any{"status": "completed"}}}})
	waitFor(t, "slot released", func() bool { return h.slots.activeOf(userA) == 0 })
	require.Equal(t, 1, h.slots.activeOf(userB))
	// A runner that goes away ends its runs.
	_ = fr.conn.Close(websocket.StatusNormalClosure, "")
	waitFor(t, "runner lost", func() bool { return h.slots.activeOf(userB) == 0 })
	h.slots.mu.Lock()
	require.Contains(t, h.slots.released, exitRunnerLost)
	require.Contains(t, h.slots.released, exitCompleted)
	h.slots.mu.Unlock()
}

func TestPreviewSignedAndSandboxed(t *testing.T) {
	h := newHost(t)
	idA := "101.0f8e2b7a-3c4d-4e5f-8a9b-0c1d2e3f4a5b"
	idB := "202.0f8e2b7a-3c4d-4e5f-8a9b-0c1d2e3f4a5b"
	_, err := h.dialRunner(localToken, defaultMethods, func(f webproto.GoFrame) (any, *webproto.RPCError, bool) {
		switch f.Method {
		case createPreviewMethod:
			return webproto.PathPreview + fmt.Sprint(f.User.ID) + ".0f8e2b7a-3c4d-4e5f-8a9b-0c1d2e3f4a5b", nil, true
		case previewMethod:
			var args []string
			_ = json.Unmarshal(f.Args, &args)
			if !strings.HasPrefix(args[0], fmt.Sprint(f.User.ID)+".") {
				return nil, &webproto.RPCError{Message: "Preview unavailable"}, true
			}
			return map[string]any{"content": "<p>doc of " + args[0] + "</p>", "csp": "default-src 'none'; sandbox allow-scripts allow-same-origin"}, nil, true
		}
		return echoCalls(f)
	})
	require.NoError(t, err)
	_, res := h.rpc(userA, createPreviewMethod, "<p>x</p>")
	var path string
	require.NoError(t, json.Unmarshal(res.Value, &path))
	require.True(t, strings.HasPrefix(path, webproto.PathPreview+idA+"?k="), path)

	get := func(p string) *http.Response {
		r, err := http.Get(h.srv.URL + p)
		require.NoError(t, err)
		t.Cleanup(func() { _ = r.Body.Close() })
		return r
	}
	r := get(path)
	require.Equal(t, http.StatusOK, r.StatusCode)
	csp := r.Header.Get("Content-Security-Policy")
	require.Equal(t, defaultPreviewCSP+"; frame-ancestors 'self'", csp, "allow-same-origin is never kept")
	require.Equal(t, "SAMEORIGIN", r.Header.Get("X-Frame-Options"))
	require.Equal(t, "no-store", r.Header.Get("Cache-Control"))
	require.Equal(t, "nosniff", r.Header.Get("X-Content-Type-Options"))

	// No, a wrong or another id's signature: not found.
	k := path[strings.Index(path, "?k=")+3:]
	for _, p := range []string{
		webproto.PathPreview + idA,
		webproto.PathPreview + idA + "?k=" + k + "x",
		webproto.PathPreview + idB + "?k=" + k,
	} {
		require.Equal(t, http.StatusNotFound, get(p).StatusCode, p)
	}
	// An expired signature.
	expired := h.c.signer.sign(idA, time.Now().Add(-2*webproto.PreviewSignatureTTL))
	require.Equal(t, http.StatusNotFound, get(webproto.PathPreview+idA+"?k="+expired).StatusCode)
	// A signature for B's id made by the server, but B never linked.
	require.Equal(t, http.StatusNotFound, get(webproto.PathPreview+idB+"?k="+h.c.signer.sign(idB, time.Now())).StatusCode)
}

func TestSafeCSP(t *testing.T) {
	require.Equal(t, defaultPreviewCSP, safeCSP(""))
	require.Equal(t, defaultPreviewCSP, safeCSP("default-src 'none'"))
	require.Equal(t, defaultPreviewCSP, safeCSP("sandbox allow-scripts\r\nX: y"))
	require.Equal(t, defaultPreviewCSP, safeCSP("sandbox; frame-ancestors *"))
	require.Equal(t, "default-src 'none'; sandbox allow-scripts", safeCSP("default-src 'none'; sandbox allow-scripts"))
}

func TestUploads(t *testing.T) {
	h := newHost(t)
	data := []byte(strings.Repeat("x", webproto.UploadChunkBytes+10))
	begin := func(uid int64, sha string, size int) string {
		body, _ := json.Marshal(map[string]any{"name": "a.bin", "size": size, "type": "application/octet-stream", "sha256": sha})
		status, res := h.post(uid, webproto.PathUploads, "application/json", body)
		require.Equal(t, http.StatusOK, status, "%+v", res.Error)
		var v struct{ ID string }
		require.NoError(t, json.Unmarshal(res.Value, &v))
		return v.ID
	}
	id := begin(userA, sha256Hex(data), len(data))
	status, _ := h.do(userA, http.MethodPut, webproto.PathUploads+"/"+id+"/chunks/0", "application/octet-stream", data[:webproto.UploadChunkBytes])
	require.Equal(t, http.StatusOK, status)
	// B cannot write or complete A's upload.
	status, res := h.do(userB, http.MethodPut, webproto.PathUploads+"/"+id+"/chunks/1", "application/octet-stream", data[webproto.UploadChunkBytes:])
	require.Equal(t, http.StatusNotFound, status)
	require.Equal(t, "CLAUDEX_WEB_NOT_FOUND", res.Error.Code)
	status, _ = h.post(userA, webproto.PathUploads+"/"+id+"/complete", "application/json", []byte(`{}`))
	require.Equal(t, http.StatusBadRequest, status, "not complete yet")
	status, _ = h.do(userA, http.MethodPut, webproto.PathUploads+"/"+id+"/chunks/1", "application/octet-stream", data[webproto.UploadChunkBytes:])
	require.Equal(t, http.StatusOK, status)
	status, _ = h.post(userB, webproto.PathUploads+"/"+id+"/complete", "application/json", []byte(`{}`))
	require.Equal(t, http.StatusNotFound, status)
	status, res = h.post(userA, webproto.PathUploads+"/"+id+"/complete", "application/json", []byte(`{}`))
	require.Equal(t, http.StatusOK, status, "%+v", res.Error)

	// A chunk over 1 MiB.
	id2 := begin(userA, "", 3<<20)
	status, res = h.do(userA, http.MethodPut, webproto.PathUploads+"/"+id2+"/chunks/0", "application/octet-stream", make([]byte, webproto.UploadChunkBytes+1))
	require.Equal(t, http.StatusRequestEntityTooLarge, status)
	require.Equal(t, webproto.ErrCodeTooLarge, res.Error.Code)

	// A damaged upload is deleted.
	id3 := begin(userA, strings.Repeat("0", 64), 3)
	h.do(userA, http.MethodPut, webproto.PathUploads+"/"+id3+"/chunks/0", "application/octet-stream", []byte("abc"))
	status, _ = h.post(userA, webproto.PathUploads+"/"+id3+"/complete", "application/json", []byte(`{}`))
	require.Equal(t, http.StatusBadRequest, status)
	_, err := h.uploads.File(context.Background(), userA, id3)
	require.Error(t, err)
}

func TestAdminRunners(t *testing.T) {
	h := newHost(t)
	h.runner()
	body := strings.NewReader(`{"name":"home box"}`)
	res, err := http.Post(h.srv.URL+"/api/v1/admin/claudex"+RouteRunners, "application/json", body)
	require.NoError(t, err)
	var created struct {
		Data CreatedRunner `json:"data"`
	}
	require.NoError(t, json.NewDecoder(res.Body).Decode(&created))
	_ = res.Body.Close()
	require.True(t, strings.HasPrefix(created.Data.Token, runnerTokenPrefix))
	_, err = h.dialRunner(created.Data.Token, defaultMethods, echoCalls)
	require.NoError(t, err)

	res, err = http.Get(h.srv.URL + "/api/v1/admin/claudex" + RouteRunners)
	require.NoError(t, err)
	var list struct {
		Data RunnersView `json:"data"`
	}
	require.NoError(t, json.NewDecoder(res.Body).Decode(&list))
	_ = res.Body.Close()
	require.Len(t, list.Data.Items, 2)
	require.True(t, list.Data.Items[0].Local && list.Data.Items[0].Connected)
	require.Equal(t, "home box", list.Data.Items[1].Name)
	require.True(t, list.Data.Items[1].Connected)
	require.NotContains(t, fmt.Sprint(list.Data), created.Data.Token)

	req, _ := http.NewRequest(http.MethodDelete, h.srv.URL+"/api/v1/admin/claudex"+RouteRunners+"/"+fmt.Sprint(created.Data.Runner.ID), nil)
	res, err = http.DefaultClient.Do(req)
	require.NoError(t, err)
	_ = res.Body.Close()
	require.Equal(t, http.StatusOK, res.StatusCode)
	waitFor(t, "revoked runner gone", func() bool { return h.c.reg.get(created.Data.Runner.LinkID()) == nil })
}

func TestAdminRunnerRenameAndDisable(t *testing.T) {
	h := newHost(t)
	h.runner()
	res, err := http.Post(h.srv.URL+"/api/v1/admin/claudex"+RouteRunners, "application/json", strings.NewReader(`{"name":"box"}`))
	require.NoError(t, err)
	var created struct {
		Data CreatedRunner `json:"data"`
	}
	require.NoError(t, json.NewDecoder(res.Body).Decode(&created))
	_ = res.Body.Close()
	_, err = h.dialRunner(created.Data.Token, defaultMethods, echoCalls)
	require.NoError(t, err)
	url := h.srv.URL + "/api/v1/admin/claudex" + RouteRunners + "/" + fmt.Sprint(created.Data.Runner.ID)
	patch := func(u, body string) (int, string) {
		req, _ := http.NewRequest(http.MethodPatch, u, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		res, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer func() { _ = res.Body.Close() }()
		var out bytes.Buffer
		_, _ = out.ReadFrom(res.Body)
		return res.StatusCode, out.String()
	}

	// Bad input: empty body, blank name, unknown or malformed id.
	code, _ := patch(url, `{}`)
	require.Equal(t, http.StatusBadRequest, code)
	code, _ = patch(url, `{"name":"  "}`)
	require.Equal(t, http.StatusBadRequest, code)
	code, _ = patch(url, `not json`)
	require.Equal(t, http.StatusBadRequest, code)
	code, _ = patch(h.srv.URL+"/api/v1/admin/claudex"+RouteRunners+"/9999", `{"name":"x"}`)
	require.Equal(t, http.StatusNotFound, code)
	code, _ = patch(h.srv.URL+"/api/v1/admin/claudex"+RouteRunners+"/local", `{"name":"x"}`)
	require.Equal(t, http.StatusNotFound, code)

	code, body := patch(url, `{"name":"  renamed\u0001 "}`)
	require.Equal(t, http.StatusOK, code, body)
	require.NotContains(t, body, created.Data.Token)
	recs, _ := h.dir.List(context.Background())
	require.Equal(t, "renamed", recs[0].Name)

	// Disabling closes the live link and refuses the next one.
	code, _ = patch(url, `{"disabled":true}`)
	require.Equal(t, http.StatusOK, code)
	waitFor(t, "disabled runner gone", func() bool { return h.c.reg.get(created.Data.Runner.LinkID()) == nil })
	_, err = h.dialRunner(created.Data.Token, defaultMethods, echoCalls)
	require.Error(t, err)
	res, err = http.Get(h.srv.URL + "/api/v1/admin/claudex" + RouteRunners)
	require.NoError(t, err)
	var list struct {
		Data RunnersView `json:"data"`
	}
	require.NoError(t, json.NewDecoder(res.Body).Decode(&list))
	_ = res.Body.Close()
	last := list.Data.Items[len(list.Data.Items)-1]
	require.True(t, last.Disabled)
	require.False(t, last.Connected)

	code, _ = patch(url, `{"disabled":false}`)
	require.Equal(t, http.StatusOK, code)
	_, err = h.dialRunner(created.Data.Token, defaultMethods, echoCalls)
	require.NoError(t, err)
}

func TestDrainMovesNewUsersAway(t *testing.T) {
	h := newHost(t)
	local := h.runner()
	h.rpc(userA, "listThings")
	token, _ := newRunnerToken()
	rec, _ := h.dir.Create(context.Background(), "r", 0, hashRunnerToken(token))
	second, err := h.dialRunner(token, defaultMethods, echoCalls)
	require.NoError(t, err)
	res, err := http.Post(h.srv.URL+"/api/v1/admin/claudex"+RouteRunners+"/local/drain", "application/json", nil)
	require.NoError(t, err)
	_ = res.Body.Close()
	waitFor(t, "drain", func() bool { return len(local.framesOf("drain")) == 1 })
	// A moves to the second runner; the draining one forgets A.
	h.rpc(userA, "listThings")
	require.Len(t, second.framesOf("call"), 1)
	waitFor(t, "removed", func() bool { return len(local.framesOf("user-signed-out")) == 1 })
	a, _ := h.dir.Assignment(context.Background(), userA)
	require.Equal(t, rec.LinkID(), a)
}

func TestAssignmentSurvivesARestart(t *testing.T) {
	h := newHost(t)
	fr := h.runner()
	h.rpc(userA, "listThings")
	// A new relay on the same directory (a server restart) accepts the
	// runner's writes for A before A calls again.
	h2 := newHost(t)
	h2.dir = h.dir
	h2.c.over.Runners = h.dir
	h2.c.b.Runners = h.dir
	h2.c.reg = newRegistry(h.dir)
	fr2, err := h2.dialRunner(localToken, defaultMethods, echoCalls)
	require.NoError(t, err)
	res := fr2.request("w", "store.turns.put", userA, map[string]any{"turns": []any{}})
	require.True(t, *res.OK, "%+v", res.Error)
	res = fr2.request("w2", "store.turns.put", userB, map[string]any{"turns": []any{}})
	require.False(t, *res.OK)
	_ = fr
}

// A runner that is only out of reach (restarting, its link dropped) keeps its
// users: their files live on it, so they wait for it instead of moving to
// another runner. A runner that is gone for good (disabled) lets them move.
func TestUsersWaitForARunnerThatIsOnlyDisconnected(t *testing.T) {
	h := newHost(t)
	local := h.runner()
	code, _ := h.rpc(userA, "listThings")
	require.Equal(t, http.StatusOK, code)
	token, _ := newRunnerToken()
	rec, _ := h.dir.Create(context.Background(), "r", 0, hashRunnerToken(token))
	second, err := h.dialRunner(token, defaultMethods, echoCalls)
	require.NoError(t, err)

	_ = local.conn.CloseNow()
	waitFor(t, "local gone", func() bool { return h.c.reg.get(LocalRunnerID) == nil })
	code, res := h.rpc(userA, "listThings")
	require.NotEqual(t, http.StatusOK, code)
	require.Equal(t, webproto.ErrCodeRunnerUnavailable, res.Error.Code)
	a, _ := h.dir.Assignment(context.Background(), userA)
	require.Equal(t, LocalRunnerID, a, "the user stays assigned to the runner that has their files")
	require.Empty(t, second.framesOf("call"))

	// The local runner comes back: the same user is served by it again.
	_, err = h.dialRunner(localToken, defaultMethods, echoCalls)
	require.NoError(t, err)
	code, _ = h.rpc(userA, "listThings")
	require.Equal(t, http.StatusOK, code)

	// A stored runner that was disabled is gone for good: its user moves.
	code, _ = h.rpc(userB, "listThings")
	require.Equal(t, http.StatusOK, code)
	require.NoError(t, h.dir.Assign(context.Background(), userB, rec.LinkID()))
	h.c.reg.mu.Lock()
	h.c.reg.assign[userB] = rec.LinkID()
	h.c.reg.mu.Unlock()
	disabled := true
	_, err = h.dir.Update(context.Background(), rec.ID, nil, &disabled)
	require.NoError(t, err)
	_ = second.conn.CloseNow()
	waitFor(t, "second gone", func() bool { return h.c.reg.get(rec.LinkID()) == nil })
	code, _ = h.rpc(userB, "listThings")
	require.Equal(t, http.StatusOK, code)
	b, _ := h.dir.Assignment(context.Background(), userB)
	require.Equal(t, LocalRunnerID, b)
}

// A runner labelled role=standby takes new users only while no other runner
// is linked; users already on it stay (their files live there).
func TestStandbyRunnerTakesNewUsersOnlyWhenAlone(t *testing.T) {
	h := newHost(t)
	standby, err := h.dialRunnerLabeled(localToken, map[string]string{"role": StandbyLabel}, defaultMethods, echoCalls)
	require.NoError(t, err)
	token, _ := newRunnerToken()
	rec, _ := h.dir.Create(context.Background(), "primary", 0, hashRunnerToken(token))
	primary, err := h.dialRunner(token, defaultMethods, echoCalls)
	require.NoError(t, err)

	// Both linked: every new user goes to the primary, however many it has.
	for _, uid := range []int64{userA, userB} {
		code, _ := h.rpc(uid, "listThings")
		require.Equal(t, http.StatusOK, code)
	}
	require.Len(t, primary.framesOf("call"), 2)
	require.Empty(t, standby.framesOf("call"))

	// The primary drops: a new user is served by the standby, while the
	// primary's users wait for it.
	_ = primary.conn.CloseNow()
	waitFor(t, "primary gone", func() bool { return h.c.reg.get(rec.LinkID()) == nil })
	const userC, userD int64 = 303, 404
	code, _ := h.rpc(userC, "listThings")
	require.Equal(t, http.StatusOK, code)
	require.Len(t, standby.framesOf("call"), 1)
	code, _ = h.rpc(userA, "listThings")
	require.NotEqual(t, http.StatusOK, code)

	// The primary is back: new users go to it again; C stays on the standby.
	again, err := h.dialRunner(token, defaultMethods, echoCalls)
	require.NoError(t, err)
	h.rpc(userD, "listThings")
	h.rpc(userC, "listThings")
	require.Len(t, again.framesOf("call"), 1)
	require.Len(t, standby.framesOf("call"), 2)
	c, _ := h.dir.Assignment(context.Background(), userC)
	require.Equal(t, LocalRunnerID, c)
}

// The snapshot's answer says the last event it holds: events the runner
// sent before its result are at or below that number.
func TestSnapshotSaysTheLastEventItHolds(t *testing.T) {
	h := newHost(t)
	fr := h.runner()
	// A call routes the user to the runner; its events count from then.
	status, _ := h.rpc(userA, "listThings")
	require.Equal(t, http.StatusOK, status)
	fr.event(userA, map[string]any{"type": "one"})
	fr.event(userA, map[string]any{"type": "two"})

	req, _ := http.NewRequest(http.MethodPost, h.srv.URL+webproto.PathRPC+"snapshot", bytes.NewReader([]byte(`{"args":[]}`)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+tokenOf(userA))
	req.Header.Set(webproto.HeaderTab, "tab-101-000001")
	res, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	_ = res.Body.Close()
	require.Equal(t, http.StatusOK, res.StatusCode)

	seq := h.c.hubs.lastSeq(userA)
	require.Equal(t, strconv.FormatInt(seq, 10), res.Header.Get(webproto.EventSeqHeader))
	u := h.c.hubs.get(userA, false)
	require.NotNil(t, u)
	require.Len(t, u.ring, 2, "both events came in before the result")

}
