package webhost

import (
	"context"
	"encoding/json"
	"strconv"
	"sync"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"

	"github.com/coder/websocket"
)

// Event fan-out (web plan §1.2): Go numbers every event of a user (seq),
// sends it to all of that user's tabs and keeps the last events in a ring
// (at most webproto.EventRing events and maxRingBytes) so a tab that
// reconnects with lastSeq resumes; a tab whose lastSeq left the ring gets a
// non-resumed ready (and a snapshot when the runner can give one).
//
// A hub's first seq is the current Unix time in milliseconds (and above
// every seq this process issued), so a seq from before a server restart or
// before the hub was dropped never looks resumable.

const (
	maxRingBytes     = 8 << 20
	maxTabFrames     = 4096
	maxTabBytes      = 48 << 20
	maxTabsPerUser   = 32
	hubIdleLifetime  = 30 * time.Minute
	tabCloseSlow     = "too slow"
	tabCloseReplaced = "replaced"
)

type ringEntry struct {
	seq   int64
	frame []byte
}

type userHub struct {
	userID int64

	mu        sync.Mutex
	seq       int64
	first     int64 // oldest resumable seq (seq+1 when the ring is empty)
	ring      []ringEntry
	ringBytes int
	tabs      map[*tabConn]struct{}
	active    time.Time
	sentTabs  int
	sentFocus bool
	sentOnce  bool
}

type hubs struct {
	c     *Component
	mu    sync.Mutex
	m     map[int64]*userHub
	floor int64 // highest seq issued by any hub
}

func newHubs(c *Component) *hubs { return &hubs{c: c, m: map[int64]*userHub{}} }

// get returns the user's hub, creating it when create is set.
func (h *hubs) get(userID int64, create bool) *userHub {
	h.mu.Lock()
	defer h.mu.Unlock()
	u := h.m[userID]
	if u == nil && create {
		base := h.c.now().UnixMilli()
		if base <= h.floor {
			base = h.floor + 1
		}
		u = &userHub{userID: userID, seq: base, first: base + 1, tabs: map[*tabConn]struct{}{}, active: h.c.now()}
		h.m[userID] = u
	}
	return u
}

func (h *hubs) raiseFloor(seq int64) {
	h.mu.Lock()
	if seq > h.floor {
		h.floor = seq
	}
	h.mu.Unlock()
}

func eventFrame(seq int64, event json.RawMessage) []byte {
	out := make([]byte, 0, len(event)+40)
	out = append(out, `{"t":"event","seq":`...)
	out = strconv.AppendInt(out, seq, 10)
	out = append(out, `,"event":`...)
	out = append(out, event...)
	out = append(out, '}')
	return out
}

// publish numbers an event of the user and sends it to the user's tabs.
// lastSeq is the number of the user's last event. It opens the user's hub
// when there is none yet, so a tab that attaches next starts from the same
// number (an idle hub is swept as usual).
func (h *hubs) lastSeq(userID int64) int64 {
	u := h.get(userID, true)
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.seq
}

func (h *hubs) publish(userID int64, event json.RawMessage) {
	u := h.get(userID, true)
	u.mu.Lock()
	u.seq++
	seq := u.seq
	frame := eventFrame(seq, event)
	u.ring = append(u.ring, ringEntry{seq: seq, frame: frame})
	u.ringBytes += len(frame)
	for len(u.ring) > 0 && (len(u.ring) > webproto.EventRing || u.ringBytes > maxRingBytes) {
		u.ringBytes -= len(u.ring[0].frame)
		u.ring[0] = ringEntry{}
		u.ring = u.ring[1:]
	}
	if len(u.ring) > 0 {
		u.first = u.ring[0].seq
	} else {
		u.first = seq + 1
	}
	u.active = h.c.now()
	tabs := u.tabList()
	u.mu.Unlock()
	h.raiseFloor(seq)
	for _, t := range tabs {
		t.enqueue(frame)
	}
}

func (u *userHub) tabList() []*tabConn {
	out := make([]*tabConn, 0, len(u.tabs))
	for t := range u.tabs {
		out = append(out, t)
	}
	return out
}

// openURL sends a page to open to one tab (tabID) or to every tab.
func (h *hubs) openURL(userID int64, url, target, tabID string) {
	u := h.get(userID, false)
	if u == nil {
		return
	}
	frame, err := json.Marshal(webproto.ServerFrame{T: "open-url", URL: url, Target: target})
	if err != nil {
		return
	}
	u.mu.Lock()
	tabs := u.tabList()
	u.mu.Unlock()
	sent := false
	for _, t := range tabs {
		if tabID == "" || t.id == tabID {
			t.enqueue(frame)
			sent = true
		}
	}
	// The tab that asked went away: another tab of the user opens it.
	if !sent && tabID != "" && len(tabs) > 0 {
		tabs[0].enqueue(frame)
	}
}

// attach adds a tab and queues its ready frame and the events it missed.
// It reports whether the tab resumed. The same tab id connecting again
// replaces the older socket.
func (h *hubs) attach(t *tabConn, lastSeq *int64) (resumed bool, ok bool) {
	u := h.get(t.userID, true)
	u.mu.Lock()
	var replaced []*tabConn
	for other := range u.tabs {
		if other.id == t.id {
			replaced = append(replaced, other)
			delete(u.tabs, other)
		}
	}
	if len(u.tabs) >= maxTabsPerUser {
		u.mu.Unlock()
		for _, r := range replaced {
			r.kill(websocket.StatusNormalClosure, tabCloseReplaced)
		}
		return false, false
	}
	var replay [][]byte
	if lastSeq != nil {
		ls := *lastSeq
		switch {
		case ls == u.seq:
			resumed = true
		case ls < u.seq && ls >= u.first-1:
			resumed = true
			for _, e := range u.ring {
				if e.seq > ls {
					replay = append(replay, e.frame)
				}
			}
		}
	}
	ready, _ := json.Marshal(webproto.ReadyFrame(u.seq, resumed))
	t.enqueue(ready)
	for _, f := range replay {
		t.enqueue(f)
	}
	u.tabs[t] = struct{}{}
	u.active = h.c.now()
	u.mu.Unlock()
	for _, r := range replaced {
		r.kill(websocket.StatusNormalClosure, tabCloseReplaced)
	}
	h.c.presenceChanged(t.userID)
	return resumed, true
}

// detach removes a tab.
func (h *hubs) detach(t *tabConn) {
	u := h.get(t.userID, false)
	if u == nil {
		return
	}
	u.mu.Lock()
	_, had := u.tabs[t]
	delete(u.tabs, t)
	u.active = h.c.now()
	u.mu.Unlock()
	if had {
		h.c.presenceChanged(t.userID)
	}
}

// sendSnapshot queues a snapshot frame (the whole state) to one tab, with
// the seq current when it is queued.
func (h *hubs) sendSnapshot(t *tabConn, snapshot json.RawMessage) bool {
	u := h.get(t.userID, false)
	if u == nil {
		return false
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	if _, ok := u.tabs[t]; !ok {
		return false
	}
	f := webproto.SnapshotFrame(u.seq, snapshot)
	if f.Validate() != nil {
		return false
	}
	data, err := json.Marshal(f)
	if err != nil {
		return false
	}
	t.enqueue(data)
	return true
}

type presenceState struct {
	userID  int64
	tabs    int
	focused bool
}

// presence returns the user's tab count and whether one is focused, and
// whether that differs from what was last reported to the runner.
func (h *hubs) presence(userID int64, markSent bool) (presenceState, bool) {
	u := h.get(userID, false)
	if u == nil {
		return presenceState{userID: userID}, false
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	p := presenceState{userID: userID, tabs: len(u.tabs)}
	for t := range u.tabs {
		if v, f := t.state(); v && f {
			p.focused = true
		}
	}
	changed := !u.sentOnce || p.tabs != u.sentTabs || p.focused != u.sentFocus
	if markSent {
		u.sentOnce, u.sentTabs, u.sentFocus = true, p.tabs, p.focused
	}
	return p, changed
}

// presenceFor lists the presence of the users with tabs assigned to runnerID.
func (h *hubs) presenceFor(runnerID string) []presenceState {
	h.mu.Lock()
	ids := make([]int64, 0, len(h.m))
	for id := range h.m {
		ids = append(ids, id)
	}
	h.mu.Unlock()
	var out []presenceState
	for _, id := range ids {
		if h.c.reg.assignment(context.Background(), id) != runnerID {
			continue
		}
		if p, _ := h.presence(id, true); p.tabs > 0 {
			out = append(out, p)
		}
	}
	return out
}

// tabsOf returns the user's connected tabs.
func (h *hubs) tabsOf(userID int64) []*tabConn {
	u := h.get(userID, false)
	if u == nil {
		return nil
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.tabList()
}

// usersWithTabs lists the users that have tabs open.
func (h *hubs) usersWithTabs() []int64 {
	h.mu.Lock()
	hs := make([]*userHub, 0, len(h.m))
	for _, u := range h.m {
		hs = append(hs, u)
	}
	h.mu.Unlock()
	var out []int64
	for _, u := range hs {
		u.mu.Lock()
		if len(u.tabs) > 0 {
			out = append(out, u.userID)
		}
		u.mu.Unlock()
	}
	return out
}

// sweep drops hubs without tabs that saw nothing for hubIdleLifetime.
func (h *hubs) sweep(now time.Time) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for id, u := range h.m {
		u.mu.Lock()
		idle := len(u.tabs) == 0 && now.Sub(u.active) >= hubIdleLifetime
		u.mu.Unlock()
		if idle {
			delete(h.m, id)
		}
	}
}

// ---------------------------------------------------------------------------
// One tab's socket

type tabConn struct {
	id     string
	userID int64
	opened time.Time

	mu      sync.Mutex
	queue   [][]byte
	qbytes  int
	signal  chan struct{}
	closing bool
	// closeCode/closeReason: close after the queue is written (error frames).
	closeCode   websocket.StatusCode
	closeReason string
	visible     bool
	focused     bool
	killFn      func(code websocket.StatusCode, reason string)
}

func newTab(id string, userID int64, now time.Time) *tabConn {
	return &tabConn{id: id, userID: userID, opened: now, signal: make(chan struct{}, 1), visible: true, focused: true}
}

func (t *tabConn) state() (visible, focused bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.visible, t.focused
}

func (t *tabConn) setState(visible, focused bool) {
	t.mu.Lock()
	t.visible, t.focused = visible, focused
	t.mu.Unlock()
}

func (t *tabConn) wake() {
	select {
	case t.signal <- struct{}{}:
	default:
	}
}

// enqueue adds a frame; a tab too far behind is closed (it reconnects and
// resumes from the ring).
func (t *tabConn) enqueue(frame []byte) {
	t.mu.Lock()
	if t.closing {
		t.mu.Unlock()
		return
	}
	if len(t.queue) >= maxTabFrames || t.qbytes+len(frame) > maxTabBytes {
		t.mu.Unlock()
		t.kill(websocket.StatusGoingAway, tabCloseSlow)
		return
	}
	t.queue = append(t.queue, frame)
	t.qbytes += len(frame)
	t.mu.Unlock()
	t.wake()
}

// finish queues an error frame and closes the socket once it is written.
func (t *tabConn) finish(code websocket.StatusCode, errCode, message string) {
	data, _ := json.Marshal(webproto.ErrorFrame(errCode, message))
	t.mu.Lock()
	if t.closing {
		t.mu.Unlock()
		return
	}
	t.queue = append(t.queue, data)
	t.closing = true
	t.closeCode, t.closeReason = code, errCode
	t.mu.Unlock()
	t.wake()
}

// kill closes the socket now, dropping what is queued.
func (t *tabConn) kill(code websocket.StatusCode, reason string) {
	t.mu.Lock()
	t.closing = true
	t.queue, t.qbytes = nil, 0
	fn := t.killFn
	t.mu.Unlock()
	if fn != nil {
		fn(code, reason)
	}
	t.wake()
}

// next takes the queued frames; done reports a finished tab (with the close
// code to use when it is not 0).
func (t *tabConn) next() (frames [][]byte, done bool, code websocket.StatusCode, reason string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	frames, t.queue, t.qbytes = t.queue, nil, 0
	if t.closing && len(frames) == 0 {
		return nil, true, t.closeCode, t.closeReason
	}
	return frames, false, 0, ""
}
