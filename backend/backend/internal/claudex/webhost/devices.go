package webhost

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/wscompat"

	"github.com/coder/websocket"
	"github.com/gin-gonic/gin"
)

// Desktop devices (owner, 2026-10-06): a signed-in desktop app dials
// /api/v1/claudex/web/device/link, so the account's phones can list the
// computers that are online, open the Code conversations on one, send to
// them, stop them and answer their approvals. The conversations stay on the
// computer; Go only relays.
//
//   - The link authenticates like a tab: a one-time events ticket (POST
//     /mobile/events-ticket, which checks the session, revocation and web
//     access) in Sec-WebSocket-Protocol ("claudex.v1", "ticket.<t>"), bound
//     to the device's link id, which its hello carries. A link lives at most
//     an hour and then dials again with a new ticket (fresh checks).
//   - hello {v, deviceId, name, platform, version, methods}; Go answers
//     welcome {v, heartbeatMs}. A second link with the same id replaces the
//     first.
//   - GET /web/devices lists the caller's online devices;
//     POST /web/devices/:device/rpc/:method relays a call ({args}) to one of
//     them, for the methods its hello listed. The answer has the RPC shape.
//   - The device's events reach the account's tabs on their usual stream as
//     {"type":"device-event","deviceId","event"}; a link coming or going is
//     {"type":"devices-changed"}.
//
// Tenant isolation: a device belongs to the user its ticket was issued to;
// calls come from that user's JWT only, and its events go to that user's
// tabs only.

// Route paths (relative to /api/v1/claudex).
const (
	RouteDeviceLink = "/web/device/link"
	RouteDevices    = "/web/devices"
	RouteDeviceRPC  = "/web/devices/:device/rpc/:method"
)

const (
	deviceProtocolVersion = 1
	maxDevicesPerUser     = 8
	maxDeviceMethods      = 64
	deviceNameLength      = 80
	deviceLinkLifetime    = time.Hour
	deviceCallTimeout     = 60 * time.Second
	deviceQueue           = 256
	deviceRequestLimit    = 16
	// The largest answer or event a device may send (owner, 2026-10-31: 4 MB
	// was too small, a big Code session's answer must get through). A larger
	// message is read to its end and dropped; the link stays up and the call
	// it answered gets a "too large" error.
	deviceFrameBytes = 64 << 20
	// Events go on to the account's tabs through the hub's ring (8 MB); a
	// larger one is dropped, never the link.
	deviceEventBytes = maxRingBytes
	// Beyond this a message is not even drained: the link is closed.
	deviceDrainBytes = 1 << 30
	// A device answer slower or larger than this is logged.
	deviceSlowCall  = 5 * time.Second
	deviceLargeCall = 1 << 20
	// Calls that timed out are remembered this long, so an answer that still
	// arrives is logged with its method and how late it was.
	deviceExpiredKeep = 10 * time.Minute
	deviceExpiredMax  = 64
)

var errDeviceAnswerTooLarge = func(size int64) *webproto.RPCError {
	return &webproto.RPCError{
		Code:    "CLAUDEX_DEVICE_ANSWER_TOO_LARGE",
		Message: fmt.Sprintf("The computer's answer is too large to relay (%.1f MB).", float64(size)/(1<<20)),
	}
}

var (
	errDeviceOffline = infraerrors.NotFound("CLAUDEX_DEVICE_OFFLINE", "This computer is not online.")
	errDeviceTimeout = infraerrors.New(http.StatusGatewayTimeout, webproto.ErrCodeTimeout, "The computer didn't answer in time. Try again.")
	errDeviceBusy    = infraerrors.TooManyRequests("CLAUDEX_DEVICE_BUSY", "The computer is busy. Wait a moment and try again.")
)

// DeviceFrame is a frame a device sends (and, with Go's fields, what Go
// sends back).
type DeviceFrame struct {
	T                   string             `json:"t"`
	V                   int                `json:"v,omitempty"`
	DeviceID            string             `json:"deviceId,omitempty"`
	Name                string             `json:"name,omitempty"`
	Platform            string             `json:"platform,omitempty"`
	Version             string             `json:"version,omitempty"`
	Methods             []string           `json:"methods,omitempty"`
	ComputerAccess      bool               `json:"computerAccess"`
	ChatBindingVersion  int                `json:"chatBindingVersion,omitempty"`
	ChatPermissionModes []string           `json:"chatPermissionModes,omitempty"`
	ChatModes           []string           `json:"chatModes,omitempty"`
	ID                  string             `json:"id,omitempty"`
	OK                  *bool              `json:"ok,omitempty"`
	Value               json.RawMessage    `json:"value,omitempty"`
	Error               *webproto.RPCError `json:"error,omitempty"`
	Event               json.RawMessage    `json:"event,omitempty"`
	Method              string             `json:"method,omitempty"`
	Args                json.RawMessage    `json:"args,omitempty"`
	DeadlineMs          int64              `json:"deadlineMs,omitempty"`
	HeartbeatMs         int64              `json:"heartbeatMs,omitempty"`
}

// DeviceInfo is one online device, as GET /web/devices lists it.
type DeviceInfo struct {
	ID                  string     `json:"id"`
	Name                string     `json:"name"`
	Platform            string     `json:"platform"`
	Version             string     `json:"version"`
	ConnectedAt         time.Time  `json:"connectedAt"`
	Online              bool       `json:"online"`
	ComputerAccess      bool       `json:"computerAccess"`
	ChatBindingVersion  int        `json:"chatBindingVersion,omitempty"`
	ChatPermissionModes []string   `json:"chatPermissionModes,omitempty"`
	ChatModes           []string   `json:"chatModes,omitempty"`
	LastSeenAt          *time.Time `json:"lastSeenAt,omitempty"`
	AddedAt             *time.Time `json:"addedAt,omitempty"`
}

type deviceConn struct {
	c       *Component
	userID  int64
	info    DeviceInfo
	methods map[string]bool

	out       chan []byte
	done      chan struct{}
	closeOnce sync.Once
	killFn    func(code websocket.StatusCode, reason string)
	nextID    atomic.Uint64
	requests  chan struct{}

	mu      sync.Mutex
	pending map[string]*devicePending
	expired map[string]devicePending
	// Why the link ended, for the log line when it does.
	reason string
}

// devicePending is a relayed call waiting for its result.
type devicePending struct {
	ch     chan DeviceFrame
	method string
	at     time.Time
}

func (d *deviceConn) send(frame any) bool {
	data, err := json.Marshal(frame)
	if err != nil {
		return false
	}
	select {
	case <-d.done:
		return false
	case d.out <- data:
		return true
	default:
		// A device that cannot keep up is dropped; it dials again.
		d.close(websocket.StatusPolicyViolation, tabCloseSlow)
		return false
	}
}

func (d *deviceConn) close(code websocket.StatusCode, reason string) {
	d.closeOnce.Do(func() {
		d.mu.Lock()
		if d.reason == "" {
			d.reason = fmt.Sprintf("closed by the server: %d %s", code, reason)
		}
		d.mu.Unlock()
		close(d.done)
		if d.killFn != nil {
			d.killFn(code, reason)
		}
		d.mu.Lock()
		for id, p := range d.pending {
			close(p.ch)
			delete(d.pending, id)
		}
		d.mu.Unlock()
	})
}

func (d *deviceConn) closed() bool {
	select {
	case <-d.done:
		return true
	default:
		return false
	}
}

// call relays one call and waits for the device's result.
func (d *deviceConn) call(ctx context.Context, method string, args []json.RawMessage, timeout time.Duration) (DeviceFrame, error) {
	select {
	case d.requests <- struct{}{}:
		defer func() { <-d.requests }()
	default:
		return DeviceFrame{}, errDeviceBusy
	}
	if args == nil {
		args = []json.RawMessage{}
	}
	raw, err := json.Marshal(args)
	if err != nil {
		return DeviceFrame{}, err
	}
	id := "d" + strconv.FormatUint(d.nextID.Add(1), 10)
	ch := make(chan DeviceFrame, 1)
	d.mu.Lock()
	if d.closed() {
		d.mu.Unlock()
		return DeviceFrame{}, errDeviceOffline
	}
	started := time.Now()
	d.pending[id] = &devicePending{ch: ch, method: method, at: started}
	d.mu.Unlock()
	timedOut := false
	defer func() {
		d.mu.Lock()
		delete(d.pending, id)
		if timedOut {
			d.rememberExpired(id, devicePending{method: method, at: started})
		}
		d.mu.Unlock()
	}()
	if !d.send(DeviceFrame{T: "call", ID: id, Method: method, Args: raw, DeadlineMs: timeout.Milliseconds()}) {
		return DeviceFrame{}, errDeviceOffline
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case res, ok := <-ch:
		if !ok {
			return DeviceFrame{}, errDeviceOffline
		}
		return res, nil
	case <-timer.C:
		timedOut = true
		_ = d.send(DeviceFrame{T: "cancel", ID: id})
		return DeviceFrame{}, errDeviceTimeout
	case <-ctx.Done():
		_ = d.send(DeviceFrame{T: "cancel", ID: id})
		return DeviceFrame{}, ctx.Err()
	}
}

func (d *deviceConn) resolve(f DeviceFrame, size int) {
	d.mu.Lock()
	p := d.pending[f.ID]
	delete(d.pending, f.ID)
	late, wasLate := d.expired[f.ID]
	delete(d.expired, f.ID)
	d.mu.Unlock()
	if p != nil {
		p.ch <- f
		return
	}
	// Diagnostics: an answer after Go gave up on it (the caller saw 504).
	if wasLate {
		slog.Warn("claudex webhost: device answered after the call timed out",
			"user_id", d.userID, "device", d.info.ID, "version", d.info.Version,
			"method", late.method, "after_ms", time.Since(late.at).Milliseconds(), "bytes", size)
	} else {
		slog.Info("claudex webhost: device answered an unknown call",
			"user_id", d.userID, "device", d.info.ID, "id", clipRunes(f.ID, 40), "bytes", size)
	}
}

// rememberExpired keeps a timed-out call for a while (d.mu held).
func (d *deviceConn) rememberExpired(id string, p devicePending) {
	if d.expired == nil {
		d.expired = map[string]devicePending{}
	}
	for key, old := range d.expired {
		if time.Since(old.at) > deviceExpiredKeep || len(d.expired) >= deviceExpiredMax {
			delete(d.expired, key)
		}
	}
	d.expired[id] = p
}

var (
	frameTypeHead = regexp.MustCompile(`^\s*\{\s*"t"\s*:\s*"([a-z]{1,16})"`)
	frameIDHead   = regexp.MustCompile(`"id"\s*:\s*"([A-Za-z0-9_-]{1,64})"`)
)

// tooLarge answers the call a dropped oversized result was for (its id is
// near the start of the frame: the desktop writes t, id, ok, then value).
func (d *deviceConn) tooLarge(head []byte, size int64) {
	kind, id := "", ""
	if m := frameTypeHead.FindSubmatch(head); m != nil {
		kind = string(m[1])
	}
	if m := frameIDHead.FindSubmatch(head); m != nil {
		id = string(m[1])
	}
	d.mu.Lock()
	method := ""
	if p := d.pending[id]; p != nil && kind != "event" {
		method = p.method
	}
	d.mu.Unlock()
	slog.Warn("claudex webhost: device sent a message too large to relay",
		"user_id", d.userID, "device", d.info.ID, "version", d.info.Version,
		"frame", kind, "method", method, "bytes", size, "limit", deviceFrameBytes)
	// An event can carry ids of its own; anything else naming a waiting call
	// is that call's answer, whatever order its fields came in.
	if method != "" {
		ok := false
		d.resolve(DeviceFrame{T: "result", ID: id, OK: &ok, Error: errDeviceAnswerTooLarge(size)}, int(size))
	}
}

// progressReader pushes the link's silence deadline back while bytes arrive.
type progressReader struct {
	r      io.Reader
	idle   *time.Timer
	silent time.Duration
}

func (p *progressReader) Read(b []byte) (int, error) {
	n, err := p.r.Read(b)
	if n > 0 {
		p.idle.Reset(p.silent)
	}
	return n, err
}

// readDeviceFrame reads one message from a device. The link is silent only
// while no bytes arrive, so a large answer on a slow uplink keeps it alive
// as long as it moves. A message over deviceFrameBytes is read to its end
// and dropped: big is true and data holds its first bytes.
func readDeviceFrame(ctx context.Context, conn *websocket.Conn, silent time.Duration) (typ websocket.MessageType, data []byte, size int64, big bool, err error) {
	rctx, cancel := context.WithCancel(ctx)
	defer cancel()
	idle := time.AfterFunc(silent, cancel)
	defer idle.Stop()
	typ, r, err := conn.Reader(rctx)
	if err != nil {
		return 0, nil, 0, false, err
	}
	pr := &progressReader{r: r, idle: idle, silent: silent}
	var buf bytes.Buffer
	n, err := io.Copy(&buf, io.LimitReader(pr, deviceFrameBytes+1))
	if err != nil {
		return typ, nil, n, false, err
	}
	if n <= deviceFrameBytes {
		return typ, buf.Bytes(), n, false, nil
	}
	head := append([]byte(nil), buf.Bytes()[:4096]...)
	buf = bytes.Buffer{}
	rest, err := io.Copy(io.Discard, pr)
	return typ, head, n + rest, true, err
}

// deviceSet holds the online devices of every user.
type deviceSet struct {
	mu    sync.Mutex
	m     map[int64]map[string]*deviceConn
	known map[int64]map[string]DeviceInfo
}

// add registers a link, replacing one with the same id; false when the user
// already has too many.
func (s *deviceSet) add(d *deviceConn) (replaced *deviceConn, ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.m == nil {
		s.m = map[int64]map[string]*deviceConn{}
	}
	mine := s.m[d.userID]
	if mine == nil {
		mine = map[string]*deviceConn{}
		s.m[d.userID] = mine
	}
	replaced = mine[d.info.ID]
	if replaced == nil && len(mine) >= maxDevicesPerUser {
		return nil, false
	}
	mine[d.info.ID] = d
	if s.known == nil {
		s.known = map[int64]map[string]DeviceInfo{}
	}
	if s.known[d.userID] == nil {
		s.known[d.userID] = map[string]DeviceInfo{}
	}
	if old, exists := s.known[d.userID][d.info.ID]; exists && old.AddedAt != nil {
		d.info.AddedAt = old.AddedAt
	}
	s.known[d.userID][d.info.ID] = d.info
	return replaced, true
}

func (s *deviceSet) remove(d *deviceConn) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	mine := s.m[d.userID]
	if mine[d.info.ID] != d {
		return false
	}
	delete(mine, d.info.ID)
	if info, exists := s.known[d.userID][d.info.ID]; exists {
		now := time.Now().UTC()
		if d.c != nil {
			now = d.c.now().UTC()
		}
		info.LastSeenAt = &now
		s.known[d.userID][d.info.ID] = info
	}
	if len(mine) == 0 {
		delete(s.m, d.userID)
	}
	return true
}

func (s *deviceSet) get(userID int64, id string) *deviceConn {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.m[userID][id]
}

func (s *deviceSet) list(userID int64, includeOffline bool) []DeviceInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]DeviceInfo, 0, len(s.known[userID]))
	for id, info := range s.known[userID] {
		d := s.m[userID][id]
		info.Online = d != nil && !d.closed()
		if info.Online || includeOffline {
			out = append(out, info)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ConnectedAt.Before(out[j].ConnectedAt) })
	return out
}

func (s *deviceSet) of(userID int64) []*deviceConn {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]*deviceConn, 0, len(s.m[userID]))
	for _, d := range s.m[userID] {
		out = append(out, d)
	}
	return out
}

func (s *deviceSet) users() []int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]int64, 0, len(s.m))
	for uid := range s.m {
		out = append(out, uid)
	}
	return out
}

func (s *deviceSet) all() []*deviceConn {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []*deviceConn
	for _, mine := range s.m {
		for _, d := range mine {
			out = append(out, d)
		}
	}
	return out
}

func validDeviceHello(f DeviceFrame) bool {
	if f.T != "hello" || f.V < 1 || !webproto.ValidTabID(f.DeviceID) || f.Version == "" ||
		len(f.Version) > 64 || len(f.Platform) > 32 || len(f.Methods) > maxDeviceMethods {
		return false
	}
	for _, m := range f.Methods {
		if !webproto.ValidMethodName(m) {
			return false
		}
	}
	return true
}

func clipRunes(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

// GET /web/device/link (public group; the ticket authenticates).
func (c *Component) deviceLink(g *gin.Context) {
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
	// The hello is small; the limit grows once the link is admitted.
	conn.SetReadLimit(64<<10 + linkReadSlack)
	c.serveDevice(g.Request.Context(), conn, ticket)
}

func (c *Component) serveDevice(ctx context.Context, conn *websocket.Conn, ticket string) {
	hctx, cancel := context.WithTimeout(ctx, eventsHelloTimeout)
	typ, data, err := conn.Read(hctx)
	cancel()
	if err != nil {
		_ = conn.Close(webproto.CloseProtocolError, "no hello")
		return
	}
	var hello DeviceFrame
	if typ != websocket.MessageText || json.Unmarshal(data, &hello) != nil || !validDeviceHello(hello) {
		refuse(conn, webproto.CloseProtocolError, webproto.ErrCodeBadRequest, "The first frame must be hello.")
		return
	}
	b := c.backends()
	userID, err := b.RedeemTicket(ctx, ticket, hello.DeviceID)
	if err != nil || userID <= 0 {
		refuse(conn, webproto.CloseBadTicket, webproto.ErrCodeBadTicket, "The events ticket is not valid. Request a new one.")
		return
	}
	if code, errCode, msg, ok := c.admit(ctx, userID); !ok {
		refuse(conn, code, errCode, msg)
		return
	}
	name := clipRunes(hello.Name, deviceNameLength)
	if name == "" {
		name = "Computer"
	}
	info := DeviceInfo{
		ID:             hello.DeviceID,
		Name:           name,
		Platform:       hello.Platform,
		Version:        hello.Version,
		ConnectedAt:    c.now().UTC(),
		Online:         true,
		ComputerAccess: hello.ComputerAccess,
	}
	now := c.now().UTC()
	info.LastSeenAt, info.AddedAt = &now, &now
	if hello.ChatBindingVersion == 1 && validChatDeviceModes(hello.ChatModes, hello.ChatPermissionModes) {
		info.ChatBindingVersion = 1
		info.ChatModes = hello.ChatModes
		info.ChatPermissionModes = hello.ChatPermissionModes
	}
	d := &deviceConn{
		c:        c,
		userID:   userID,
		info:     info,
		methods:  make(map[string]bool, len(hello.Methods)),
		out:      make(chan []byte, deviceQueue),
		done:     make(chan struct{}),
		requests: make(chan struct{}, deviceRequestLimit),
		pending:  map[string]*devicePending{},
	}
	for _, m := range hello.Methods {
		d.methods[m] = true
	}
	d.killFn = func(code websocket.StatusCode, reason string) {
		go func() { _ = conn.Close(code, reason) }()
	}
	c.loadKnownDevices(ctx, userID)
	replaced, ok := c.devices.add(d)
	if !ok {
		refuse(conn, webproto.CloseUnavailable, webproto.ErrCodeCapacity, "Too many computers are connected to this account.")
		return
	}
	if replaced != nil {
		replaced.close(webproto.CloseReplaced, tabCloseReplaced)
	}
	c.rememberDevice(userID, d.info)
	conn.SetReadLimit(deviceDrainBytes)
	linked := c.now()
	defer func() {
		d.mu.Lock()
		reason := d.reason
		d.mu.Unlock()
		if reason == "" {
			reason = "ended"
		}
		slog.Info("claudex webhost: device link closed",
			"user_id", userID, "device", d.info.ID, "version", d.info.Version,
			"after_s", int(c.now().Sub(linked).Seconds()), "reason", reason)
		d.close(websocket.StatusNormalClosure, "")
		if c.devices.remove(d) {
			c.devices.mu.Lock()
			last := c.devices.known[userID][d.info.ID]
			c.devices.mu.Unlock()
			c.rememberDevice(userID, last)
			c.devicesChanged(userID)
		}
	}()
	welcome, _ := json.Marshal(DeviceFrame{T: "welcome", V: deviceProtocolVersion, HeartbeatMs: c.heartbeat.Milliseconds()})
	wctx, wcancel := context.WithTimeout(ctx, eventsWriteTimeout)
	err = conn.Write(wctx, websocket.MessageText, welcome)
	wcancel()
	if err != nil {
		return
	}
	c.devicesChanged(userID)

	go c.deviceWriter(conn, d)
	lifetime := time.AfterFunc(deviceLinkLifetime, func() { d.close(websocket.StatusNormalClosure, "renew") })
	defer lifetime.Stop()

	silent := c.heartbeat * eventsSilentMult / 2
	for {
		typ, data, size, big, err := readDeviceFrame(ctx, conn, silent)
		if err != nil {
			d.mu.Lock()
			if d.reason == "" {
				d.reason = fmt.Sprintf("read failed after %d bytes: %v", size, err)
			}
			d.mu.Unlock()
			return
		}
		if big {
			d.tooLarge(data, size)
			continue
		}
		if typ != websocket.MessageText {
			d.close(webproto.CloseProtocolError, "binary frame")
			return
		}
		var f DeviceFrame
		if json.Unmarshal(data, &f) != nil {
			d.close(webproto.CloseProtocolError, "bad frame")
			return
		}
		c.devices.mu.Lock()
		seen := c.devices.known[userID][d.info.ID]
		at := c.now().UTC()
		seen.LastSeenAt = &at
		c.devices.known[userID][d.info.ID] = seen
		c.devices.mu.Unlock()
		switch f.T {
		case "status":
			c.devices.mu.Lock()
			info := c.devices.known[userID][d.info.ID]
			info.ComputerAccess = f.ComputerAccess
			c.devices.known[userID][d.info.ID] = info
			c.devices.mu.Unlock()
			c.rememberDevice(userID, info)
			c.devicesChanged(userID)
		case "ping":
			d.send(DeviceFrame{T: "pong"})
		case "pong":
		case "result":
			if f.ID == "" || f.OK == nil {
				continue
			}
			d.resolve(f, int(size))
		case "event":
			if len(f.Event) > deviceEventBytes {
				slog.Warn("claudex webhost: device event too large to relay",
					"user_id", userID, "device", d.info.ID, "bytes", len(f.Event), "limit", deviceEventBytes)
				continue
			}
			if len(f.Event) == 0 || requireEventType(f.Event) != nil {
				continue
			}
			c.hubs.publish(userID, deviceEvent(d.info.ID, f.Event))
		default:
			d.close(webproto.CloseProtocolError, "unknown frame")
			return
		}
	}
}

func (c *Component) deviceWriter(conn *websocket.Conn, d *deviceConn) {
	for {
		select {
		case <-d.done:
			return
		case data := <-d.out:
			ctx, cancel := context.WithTimeout(context.Background(), linkWriteTimeout)
			err := conn.Write(ctx, websocket.MessageText, data)
			cancel()
			if err != nil {
				d.close(websocket.StatusGoingAway, "write failed")
				return
			}
		}
	}
}

func requireEventType(raw json.RawMessage) error {
	var head struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(raw, &head); err != nil || head.Type == "" {
		return errors.New("event needs a type")
	}
	return nil
}

func deviceEvent(deviceID string, event json.RawMessage) json.RawMessage {
	id, _ := json.Marshal(deviceID)
	out := make([]byte, 0, len(event)+len(id)+48)
	out = append(out, `{"type":"device-event","deviceId":`...)
	out = append(out, id...)
	out = append(out, `,"event":`...)
	out = append(out, event...)
	out = append(out, '}')
	return out
}

// devicesChanged tells the user's tabs to read the device list again.
func (c *Component) devicesChanged(userID int64) {
	c.hubs.publish(userID, json.RawMessage(`{"type":"devices-changed"}`))
}

// endDevices closes a user's device links (signed out, access withdrawn).
func (c *Component) endDevices(userID int64, code websocket.StatusCode, reason string) {
	for _, d := range c.devices.of(userID) {
		d.close(code, reason)
	}
}

// GET /web/devices
func (c *Component) listDevices(g *gin.Context) {
	who, ok := c.authorize(g)
	if !ok {
		return
	}
	if g.Query("includeOffline") == "1" {
		c.loadKnownDevices(g.Request.Context(), who.userID)
	}
	rpcOK(g, c.devices.list(who.userID, g.Query("includeOffline") == "1"))
}

func (c *Component) loadKnownDevices(ctx context.Context, userID int64) {
	if c.env.Redis != nil {
		ctx, cancel := context.WithTimeout(ctx, time.Second)
		saved, _ := c.env.Redis.HGetAll(ctx, deviceRegistryKey(userID)).Result()
		cancel()
		c.devices.mu.Lock()
		if c.devices.known == nil {
			c.devices.known = map[int64]map[string]DeviceInfo{}
		}
		if c.devices.known[userID] == nil {
			c.devices.known[userID] = map[string]DeviceInfo{}
		}
		for id, raw := range saved {
			var info DeviceInfo
			if json.Unmarshal([]byte(raw), &info) == nil && info.ID == id {
				if _, exists := c.devices.known[userID][id]; !exists {
					c.devices.known[userID][id] = info
				}
			}
		}
		c.devices.mu.Unlock()
	}
}

func deviceRegistryKey(userID int64) string {
	return "claudex:device-presence:" + strconv.FormatInt(userID, 10)
}

func (c *Component) rememberDevice(userID int64, info DeviceInfo) {
	if c.env.Redis == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	data, err := json.Marshal(info)
	if err == nil {
		if err := c.env.Redis.HSet(ctx, deviceRegistryKey(userID), info.ID, data).Err(); err != nil {
			slog.Warn("remember desktop presence", "error", err)
		}
	}
}

// POST /web/devices/:device/rpc/:method
func (c *Component) deviceRPC(g *gin.Context) {
	who, ok := c.authorize(g)
	if !ok {
		return
	}
	method := g.Param("method")
	if !webproto.ValidMethodName(method) {
		rpcFail(g, errMethodUnavailable)
		return
	}
	d := c.devices.get(who.userID, g.Param("device"))
	if d == nil || d.closed() {
		rpcFail(g, errDeviceOffline)
		return
	}
	if !d.methods[method] {
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
	started := time.Now()
	res, err := d.call(g.Request.Context(), method, req.Args, deviceCallTimeout)
	took := time.Since(started).Milliseconds()
	if err != nil {
		if errors.Is(err, context.Canceled) {
			slog.Info("claudex webhost: device call abandoned by the caller",
				"user_id", who.userID, "device", d.info.ID, "method", method, "latency_ms", took)
			g.Abort()
			return
		}
		slog.Warn("claudex webhost: device call failed",
			"user_id", who.userID, "device", d.info.ID, "version", d.info.Version,
			"method", method, "error", err.Error(), "latency_ms", took)
		rpcFail(g, err)
		return
	}
	switch {
	case res.OK != nil && !*res.OK:
		message, code := "", ""
		if res.Error != nil {
			message, code = clipRunes(res.Error.Message, 200), res.Error.Code
		}
		slog.Info("claudex webhost: device refused a call",
			"user_id", who.userID, "device", d.info.ID, "version", d.info.Version,
			"method", method, "code", code, "message", message, "latency_ms", took)
	case took >= deviceSlowCall.Milliseconds() || len(res.Value) >= deviceLargeCall:
		slog.Info("claudex webhost: device call slow or large",
			"user_id", who.userID, "device", d.info.ID, "version", d.info.Version,
			"method", method, "bytes", len(res.Value), "latency_ms", took)
	}
	out := webproto.RPCResponse{OK: *res.OK, Value: res.Value, Error: res.Error}
	if out.Validate() != nil {
		slog.Warn("claudex webhost: device answered an invalid result", "user_id", who.userID, "method", method)
		rpcFail(g, errDeviceOffline)
		return
	}
	g.Header("Cache-Control", "no-store")
	g.JSON(http.StatusOK, out)
}
