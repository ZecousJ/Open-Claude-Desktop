package webhost

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	webusage "github.com/Wei-Shaw/sub2api/internal/claudex/web/usage"
	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
	"github.com/Wei-Shaw/sub2api/internal/claudex/webstore"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/coder/websocket"
	"github.com/gin-gonic/gin"
)

const localToken = "local-runner-token-0123456789"

// fakeStore records store ops and answers with the user they ran for.
type fakeStore struct {
	mu  sync.Mutex
	ops []string
}

func (s *fakeStore) ServeRunnerOp(_ context.Context, userID int64, op string, body json.RawMessage) (any, error) {
	s.mu.Lock()
	s.ops = append(s.ops, fmt.Sprintf("%d:%s", userID, op))
	s.mu.Unlock()
	return map[string]any{"user": userID, "op": op, "body": body}, nil
}

func (s *fakeStore) list() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.ops...)
}

// fakeUploads keeps files per user.
type fakeUploads struct {
	mu    sync.Mutex
	files map[string]*fakeFile
	n     int
}

type fakeFile struct {
	info webstore.FileInfo
	data []byte
}

func (u *fakeUploads) key(userID int64, id string) string {
	return strconv.FormatInt(userID, 10) + "/" + id
}

func (u *fakeUploads) BeginUpload(_ context.Context, userID int64, name, mime string, size int64) (webstore.FileInfo, error) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.files == nil {
		u.files = map[string]*fakeFile{}
	}
	u.n++
	id := fmt.Sprintf("file%018d", u.n)
	f := &fakeFile{info: webstore.FileInfo{ID: id, Name: name, Mime: mime, Size: size}}
	u.files[u.key(userID, id)] = f
	return f.info, nil
}

func (u *fakeUploads) WriteUpload(_ context.Context, userID int64, id string, offset int64, data []byte) (webstore.FileInfo, error) {
	u.mu.Lock()
	defer u.mu.Unlock()
	f := u.files[u.key(userID, id)]
	if f == nil {
		return webstore.FileInfo{}, &webstore.OpError{Code: webstore.ErrCodeNotFound, Message: "This file doesn't exist."}
	}
	if offset != int64(len(f.data)) {
		return webstore.FileInfo{}, &webstore.OpError{Code: webproto.ErrCodeBadRequest, Message: "bad offset"}
	}
	f.data = append(f.data, data...)
	f.info.Received = int64(len(f.data))
	if f.info.Received == f.info.Size {
		f.info.Complete = true
		f.info.SHA256 = sha256Hex(f.data)
	}
	return f.info, nil
}

func (u *fakeUploads) File(_ context.Context, userID int64, id string) (webstore.FileInfo, error) {
	u.mu.Lock()
	defer u.mu.Unlock()
	f := u.files[u.key(userID, id)]
	if f == nil {
		return webstore.FileInfo{}, &webstore.OpError{Code: webstore.ErrCodeNotFound, Message: "This file doesn't exist."}
	}
	return f.info, nil
}

func (u *fakeUploads) DeleteFile(_ context.Context, userID int64, id string) error {
	u.mu.Lock()
	defer u.mu.Unlock()
	delete(u.files, u.key(userID, id))
	return nil
}

// fakeSlots is a capacity table with a per-user limit.
type fakeSlots struct {
	mu       sync.Mutex
	limit    int
	active   map[int64]int
	released []string
}

type fakeSlot struct {
	s        *fakeSlots
	userID   int64
	deadline time.Time
	once     sync.Once
}

func (s *fakeSlot) Deadline() time.Time { return s.deadline }
func (s *fakeSlot) Release(_ context.Context, end webusage.SlotEnd) error {
	s.once.Do(func() {
		s.s.mu.Lock()
		s.s.active[s.userID]--
		s.s.released = append(s.s.released, end.ExitReason)
		s.s.mu.Unlock()
	})
	return nil
}

func (s *fakeSlots) acquire(_ context.Context, req webusage.SlotRequest) (RunSlot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.limit > 0 && s.active[req.UserID] >= s.limit {
		return nil, infraerrors.ServiceUnavailable(webproto.ErrCodeCapacity, "busy").WithMetadata(map[string]string{"scope": "user"})
	}
	s.active[req.UserID]++
	return &fakeSlot{s: s, userID: req.UserID, deadline: time.Now().Add(time.Hour)}, nil
}

func (s *fakeSlots) activeOf(uid int64) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.active[uid]
}

// host is a relay on a test server with fake backends.
type host struct {
	t       *testing.T
	c       *Component
	srv     *httptest.Server
	store   *fakeStore
	uploads *fakeUploads
	slots   *fakeSlots
	dir     *memoryDirectory

	mu      sync.Mutex
	denied  map[int64]bool
	blocked map[int64]bool // inactive users
	tickets map[string]string
	keys    []KeyRequest
}

func tokenOf(uid int64) string { return "tok-" + strconv.FormatInt(uid, 10) + "-abcdefgh" }

func newHost(t *testing.T) *host {
	t.Helper()
	gin.SetMode(gin.TestMode)
	h := &host{t: t, store: &fakeStore{}, uploads: &fakeUploads{}, slots: &fakeSlots{limit: 1, active: map[int64]int{}},
		dir: newMemoryDirectory(), denied: map[int64]bool{}, blocked: map[int64]bool{}, tickets: map[string]string{}}
	b := Backends{
		ParseToken: func(token string) (Claims, error) {
			var uid int64
			if _, err := fmt.Sscanf(token, "tok-%d-abcdefgh", &uid); err != nil || uid <= 0 {
				return Claims{}, errors.New("bad token")
			}
			now := time.Now()
			return Claims{UserID: uid, SessionID: "sid-" + strconv.FormatInt(uid, 10), IssuedAt: now, ExpiresAt: now.Add(time.Hour)}, nil
		},
		CheckAccess: func(_ context.Context, uid int64, _ string, _ bool) error {
			h.mu.Lock()
			defer h.mu.Unlock()
			if h.denied[uid] {
				return infraerrors.Forbidden(webproto.ErrCodeNotAllowed, "Your account cannot use the web app.")
			}
			return nil
		},
		RedeemTicket: func(_ context.Context, ticket, tab string) (int64, error) {
			h.mu.Lock()
			defer h.mu.Unlock()
			v, ok := h.tickets[ticket]
			delete(h.tickets, ticket)
			uidText, wantTab, _ := strings.Cut(v, ":")
			if !ok || wantTab != tab {
				return 0, errors.New("bad ticket")
			}
			return strconv.ParseInt(uidText, 10, 64)
		},
		LookupUser: func(_ context.Context, uid int64) (UserInfo, error) {
			h.mu.Lock()
			defer h.mu.Unlock()
			return UserInfo{Email: fmt.Sprintf("u%d@example.com", uid), Active: !h.blocked[uid]}, nil
		},
		BackendMode: func(context.Context) bool { return false },
		Store:       h.store,
		Uploads:     h.uploads,
		GitHub:      fakeGitHub{},
		WebKey: func(_ context.Context, req KeyRequest) (any, error) {
			h.mu.Lock()
			h.keys = append(h.keys, req)
			h.mu.Unlock()
			return map[string]any{"deviceId": "web-" + strconv.FormatInt(req.UserID, 10)}, nil
		},
		WakeToken: func(_ context.Context, uid int64) (string, error) {
			return fmt.Sprintf("tok-%d-abcdefgh", uid), nil
		},
		AcquireSlot:      h.slots.acquire,
		Triggers:         newMemoryTriggers(),
		Runners:          h.dir,
		LocalRunnerToken: localToken,
	}
	h.c = NewWithBackends(&core.Env{}, b)
	h.c.heartbeat = time.Second
	r := gin.New()
	public := r.Group("/api/v1/claudex")
	h.c.RegisterPublicRoutes(public)
	user := r.Group("/api/v1/claudex", func(g *gin.Context) {
		tok := bearerToken(g.Request)
		claims, err := b.ParseToken(tok)
		if err != nil {
			g.AbortWithStatus(http.StatusUnauthorized)
			return
		}
		g.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: claims.UserID})
		g.Set(string(middleware.ContextKeyUserRole), service.RoleUser)
		g.Set(middleware.ContextKeyAuthEmail, fmt.Sprintf("u%d@example.com", claims.UserID))
		g.Next()
	})
	h.c.RegisterUserRoutes(user)
	admin := r.Group("/api/v1/admin/claudex")
	h.c.RegisterAdminRoutes(admin, nil)
	h.srv = httptest.NewServer(r)
	t.Cleanup(h.srv.Close)
	return h
}

func (h *host) wsURL(path string) string {
	return "ws" + strings.TrimPrefix(h.srv.URL, "http") + path
}

// rpc calls a method as the user; it returns the status and decoded body.
func (h *host) rpc(uid int64, method string, args ...any) (int, webproto.RPCResponse) {
	h.t.Helper()
	if args == nil {
		args = []any{}
	}
	body, _ := json.Marshal(map[string]any{"args": args})
	return h.post(uid, webproto.PathRPC+method, "application/json", body)
}

func (h *host) post(uid int64, path, ctype string, body []byte) (int, webproto.RPCResponse) {
	return h.do(uid, http.MethodPost, path, ctype, body)
}

func (h *host) do(uid int64, method, path, ctype string, body []byte) (int, webproto.RPCResponse) {
	h.t.Helper()
	req, _ := http.NewRequest(method, h.srv.URL+path, bytes.NewReader(body))
	req.Header.Set("Content-Type", ctype)
	req.Header.Set("Authorization", "Bearer "+tokenOf(uid))
	req.Header.Set(webproto.HeaderTab, "tab-"+strconv.FormatInt(uid, 10)+"-000001")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer func() { _ = res.Body.Close() }()
	raw, _ := io.ReadAll(res.Body)
	var out webproto.RPCResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		h.t.Fatalf("%s %s: %d %s", method, path, res.StatusCode, raw)
	}
	return res.StatusCode, out
}

func (h *host) ticket(uid int64, tab string) string {
	t, _ := webproto.NewTicket()
	h.mu.Lock()
	h.tickets[t] = strconv.FormatInt(uid, 10) + ":" + tab
	h.mu.Unlock()
	return t
}

// ---------------------------------------------------------------------------
// Fake runner

type callHandler func(f webproto.GoFrame) (value any, err *webproto.RPCError, reply bool)

type fakeRunner struct {
	t       *testing.T
	conn    *websocket.Conn
	mu      sync.Mutex
	frames  []webproto.GoFrame
	handle  callHandler
	closed  chan struct{}
	code    websocket.StatusCode
	welcome webproto.GoFrame
}

var defaultMethods = []string{"snapshot", "listThings", "send", "interrupt", createPreviewMethod, previewMethod, "slow"}

func (h *host) dialRunner(token string, methods []string, handle callHandler) (*fakeRunner, error) {
	return h.dialRunnerLabeled(token, nil, methods, handle)
}

// dialRunnerLabeled links a fake runner whose hello carries these labels.
func (h *host) dialRunnerLabeled(token string, labels map[string]string, methods []string, handle callHandler) (*fakeRunner, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, res, err := websocket.Dial(ctx, h.wsURL(webproto.PathRunnerLink), &websocket.DialOptions{
		HTTPHeader:   http.Header{"Authorization": []string{"Bearer " + token}},
		Subprotocols: []string{webproto.RunnerLinkSubprotocol},
	})
	if err != nil {
		if res != nil {
			return nil, fmt.Errorf("dial: %d", res.StatusCode)
		}
		return nil, err
	}
	conn.SetReadLimit(webproto.LinkFrameBytes)
	fr := &fakeRunner{t: h.t, conn: conn, handle: handle, closed: make(chan struct{})}
	fr.send(map[string]any{"t": "hello", "v": 1, "version": "test", "methods": methods, "capacity": map[string]int{"engines": 1, "users": 10}, "labels": labels})
	welcomed := make(chan struct{})
	go fr.loop(welcomed)
	select {
	case <-welcomed:
	case <-time.After(5 * time.Second):
		return nil, errors.New("no welcome")
	}
	h.t.Cleanup(func() { _ = conn.CloseNow() })
	return fr, nil
}

func (h *host) runner() *fakeRunner {
	h.t.Helper()
	fr, err := h.dialRunner(localToken, defaultMethods, echoCalls)
	if err != nil {
		h.t.Fatal(err)
	}
	return fr
}

func echoCalls(f webproto.GoFrame) (any, *webproto.RPCError, bool) {
	if f.Method == "snapshot" {
		return map[string]any{"conversations": []any{}, "settings": map[string]any{}}, nil, true
	}
	return map[string]any{"user": f.User.ID, "token": f.User.AccessToken, "method": f.Method, "args": f.Args, "tab": f.User.TabID}, nil, true
}

func (fr *fakeRunner) send(frame any) {
	data, _ := json.Marshal(frame)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = fr.conn.Write(ctx, websocket.MessageText, data)
}

func (fr *fakeRunner) loop(welcomed chan struct{}) {
	defer close(fr.closed)
	once := sync.Once{}
	for {
		_, data, err := fr.conn.Read(context.Background())
		if err != nil {
			fr.mu.Lock()
			fr.code = websocket.CloseStatus(err)
			fr.mu.Unlock()
			return
		}
		f, err := webproto.DecodeGoFrame(data)
		if err != nil {
			fr.t.Errorf("bad Go frame %s: %v", data, err)
			return
		}
		fr.mu.Lock()
		fr.frames = append(fr.frames, f)
		fr.mu.Unlock()
		switch f.T {
		case "welcome":
			fr.welcome = f
			once.Do(func() { close(welcomed) })
		case "ping":
			fr.send(map[string]any{"t": "pong"})
		case "call":
			go func() {
				value, rpcErr, reply := fr.handle(f)
				if !reply {
					return
				}
				out := map[string]any{"t": "result", "id": f.ID, "ok": rpcErr == nil}
				if rpcErr != nil {
					out["error"] = rpcErr
				} else if value != nil {
					out["value"] = value
				}
				fr.send(out)
			}()
		}
	}
}

func (fr *fakeRunner) framesOf(t string) []webproto.GoFrame {
	fr.mu.Lock()
	defer fr.mu.Unlock()
	var out []webproto.GoFrame
	for _, f := range fr.frames {
		if f.T == t {
			out = append(out, f)
		}
	}
	return out
}

// request sends a store/key request and waits for its response.
func (fr *fakeRunner) request(id, op string, uid int64, body any) webproto.GoFrame {
	fr.t.Helper()
	frame := map[string]any{"t": "request", "id": id, "op": op, "userId": uid}
	if body != nil {
		frame["body"] = body
	}
	fr.send(frame)
	var got webproto.GoFrame
	waitFor(fr.t, "response "+id, func() bool {
		for _, f := range fr.framesOf("response") {
			if f.ID == id {
				got = f
				return true
			}
		}
		return false
	})
	return got
}

func (fr *fakeRunner) event(uid int64, event any) {
	fr.send(map[string]any{"t": "event", "userId": uid, "event": event})
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// ---------------------------------------------------------------------------
// Fake tab

type fakeTab struct {
	t      *testing.T
	conn   *websocket.Conn
	mu     sync.Mutex
	frames []webproto.ServerFrame
	closed chan struct{}
	code   websocket.StatusCode
}

func (h *host) openTab(uid int64, tab string, lastSeq *int64) *fakeTab {
	h.t.Helper()
	return h.openTabWithTicket(h.ticket(uid, tab), tab, lastSeq)
}

func (h *host) openTabWithTicket(ticket, tab string, lastSeq *int64) *fakeTab {
	h.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, h.wsURL(webproto.PathEvents), &websocket.DialOptions{
		Subprotocols: []string{webproto.EventsSubprotocol, webproto.TicketSubprotocolPrefix + ticket},
	})
	if err != nil {
		h.t.Fatal(err)
	}
	if conn.Subprotocol() != webproto.EventsSubprotocol {
		h.t.Fatalf("sub-protocol %q", conn.Subprotocol())
	}
	conn.SetReadLimit(webproto.LinkFrameBytes)
	ft := &fakeTab{t: h.t, conn: conn, closed: make(chan struct{})}
	hello := map[string]any{"t": "hello", "v": 1, "tabId": tab}
	if lastSeq != nil {
		hello["lastSeq"] = *lastSeq
	}
	data, _ := json.Marshal(hello)
	_ = conn.Write(ctx, websocket.MessageText, data)
	go ft.loop()
	go func() {
		ping, _ := json.Marshal(map[string]any{"t": "ping"})
		tick := time.NewTicker(400 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-ft.closed:
				return
			case <-tick.C:
				wctx, wcancel := context.WithTimeout(context.Background(), time.Second)
				_ = conn.Write(wctx, websocket.MessageText, ping)
				wcancel()
			}
		}
	}()
	h.t.Cleanup(func() { _ = conn.CloseNow() })
	return ft
}

func (ft *fakeTab) loop() {
	defer close(ft.closed)
	for {
		_, data, err := ft.conn.Read(context.Background())
		if err != nil {
			ft.mu.Lock()
			ft.code = websocket.CloseStatus(err)
			ft.mu.Unlock()
			return
		}
		f, err := webproto.DecodeServerFrame(data)
		if err != nil {
			ft.t.Errorf("bad server frame %s: %v", data, err)
			return
		}
		ft.mu.Lock()
		ft.frames = append(ft.frames, f)
		ft.mu.Unlock()
	}
}

func (ft *fakeTab) all() []webproto.ServerFrame {
	ft.mu.Lock()
	defer ft.mu.Unlock()
	return append([]webproto.ServerFrame(nil), ft.frames...)
}

func (ft *fakeTab) of(t string) []webproto.ServerFrame {
	var out []webproto.ServerFrame
	for _, f := range ft.all() {
		if f.T == t {
			out = append(out, f)
		}
	}
	return out
}

func (ft *fakeTab) ready() webproto.ServerFrame {
	ft.t.Helper()
	waitFor(ft.t, "ready", func() bool { return len(ft.of("ready")) > 0 })
	return ft.of("ready")[0]
}

func (ft *fakeTab) closeCode() websocket.StatusCode {
	ft.t.Helper()
	select {
	case <-ft.closed:
	case <-time.After(5 * time.Second):
		ft.t.Fatal("the tab stayed open")
	}
	ft.mu.Lock()
	defer ft.mu.Unlock()
	return ft.code
}
