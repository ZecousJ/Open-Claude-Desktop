package usage

import (
	"context"
	"errors"
	"log/slog"
	"math"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
)

// Run modes.
const (
	ModeChat   = "chat"
	ModeCowork = "cowork"
	ModeCode   = "code"
)

// Capacity scopes (metadata "scope" of CLAUDEX_WEB_CAPACITY).
const (
	ScopeUser   = "user"
	ScopeGlobal = "global"
)

// Messages of CLAUDEX_WEB_CAPACITY. The global one is the webproto fixture
// text (rpc.response.capacity.json).
const (
	CapacityGlobalMessage = "The web version is busy. Try again in a minute."
	CapacityUserMessage   = "You already have as many runs going as your account allows. Wait for one to finish, then try again."
)

const recordTimeout = 5 * time.Second

// errCapacity is the structured refusal of a run over a limit (design W-SRV
// 6; phase A refuses, W-CLOUD adds queueing later). 503 like the webproto
// fixture; metadata: scope, limit, active.
func errCapacity(scope string, limit, active int) error {
	msg := CapacityGlobalMessage
	if scope == ScopeUser {
		msg = CapacityUserMessage
	}
	return infraerrors.ServiceUnavailable(webproto.ErrCodeCapacity, msg).WithMetadata(map[string]string{
		"scope": scope, "limit": strconv.Itoa(limit), "active": strconv.Itoa(active),
	})
}

// IsCapacity reports whether err is CLAUDEX_WEB_CAPACITY.
func IsCapacity(err error) bool {
	return infraerrors.Reason(err) == webproto.ErrCodeCapacity
}

var errBadSlot = infraerrors.BadRequest(webproto.ErrCodeBadRequest, "Invalid run request.")

// SlotRequest asks for a run slot.
type SlotRequest struct {
	UserID         int64
	ConversationID string // optional
	Mode           string // chat (default) | cowork | code
	RunnerID       string // optional; Slot.Release may name it later
}

// SlotInfo describes a running slot (admin list).
type SlotInfo struct {
	ID             uint64    `json:"id"`
	UserID         int64     `json:"user_id"`
	ConversationID string    `json:"conversation_id"`
	Mode           string    `json:"mode"`
	RunnerID       string    `json:"runner_id"`
	StartedAt      time.Time `json:"started_at"`
	Deadline       time.Time `json:"deadline"`
}

// SlotEnd is what the caller knows when a run ends.
type SlotEnd struct {
	RunnerID   string  // overrides SlotRequest.RunnerID when set
	CPUSeconds float64 // as reported by the runner; 0 when unknown
	ExitReason string  // completed | interrupted | timeout | error | ...
}

// Slot is one run holding capacity. Release it exactly once when the run
// ends (further calls do nothing).
type Slot struct {
	c        *Component
	info     SlotInfo
	released atomic.Bool
}

// Info returns the slot's description.
func (s *Slot) Info() SlotInfo { return s.info }

// Deadline is when the run must stop (max_session_minutes after the start).
func (s *Slot) Deadline() time.Time { return s.info.Deadline }

// Release frees the slot and records the run's resources.
func (s *Slot) Release(ctx context.Context, end SlotEnd) error {
	if s == nil || !s.released.CompareAndSwap(false, true) {
		return nil
	}
	s.c.slots.remove(s.info.ID)
	now := s.c.now()
	runner := s.info.RunnerID
	if end.RunnerID != "" && ValidID(end.RunnerID) {
		runner = end.RunnerID
	}
	return s.c.RecordRunnerUsage(ctx, RunnerUsage{
		UserID: s.info.UserID, ConversationID: s.info.ConversationID, RunnerID: runner, Mode: s.info.Mode,
		WallSeconds: now.Sub(s.info.StartedAt).Seconds(), CPUSeconds: end.CPUSeconds,
		StartedAt: s.info.StartedAt, EndedAt: now, ExitReason: end.ExitReason,
	})
}

// slotTable holds the running slots of this server.
type slotTable struct {
	mu    sync.Mutex
	next  uint64
	slots map[uint64]*Slot
}

func newSlotTable() *slotTable { return &slotTable{slots: map[uint64]*Slot{}} }

func (t *slotTable) remove(id uint64) {
	t.mu.Lock()
	delete(t.slots, id)
	t.mu.Unlock()
}

func (t *slotTable) list(userID int64) []SlotInfo {
	t.mu.Lock()
	out := make([]SlotInfo, 0, len(t.slots))
	for _, s := range t.slots {
		if userID == 0 || s.info.UserID == userID {
			out = append(out, s.info)
		}
	}
	t.mu.Unlock()
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

func validMode(m string) bool { return m == ModeChat || m == ModeCowork || m == ModeCode }

// Acquire takes a run slot or refuses with CLAUDEX_WEB_CAPACITY: first the
// user's limit, then the server's. Slots live in this process (one server;
// a restart frees them, the runner's link loss ends its runs anyway).
func (c *Component) Acquire(ctx context.Context, req SlotRequest) (*Slot, error) {
	req.Mode = strings.TrimSpace(req.Mode)
	if req.Mode == "" {
		req.Mode = ModeChat
	}
	if req.UserID <= 0 || !validMode(req.Mode) ||
		(req.ConversationID != "" && !ValidID(req.ConversationID)) || (req.RunnerID != "" && !ValidID(req.RunnerID)) {
		return nil, errBadSlot
	}
	s := c.settings(ctx)
	now := c.now()
	t := c.slots
	t.mu.Lock()
	defer t.mu.Unlock()
	mine := 0
	for _, slot := range t.slots {
		if slot.info.UserID == req.UserID {
			mine++
		}
	}
	if mine >= s.MaxConcurrentPerUser {
		return nil, errCapacity(ScopeUser, s.MaxConcurrentPerUser, mine)
	}
	if len(t.slots) >= s.MaxConcurrent {
		return nil, errCapacity(ScopeGlobal, s.MaxConcurrent, len(t.slots))
	}
	t.next++
	slot := &Slot{c: c, info: SlotInfo{
		ID: t.next, UserID: req.UserID, ConversationID: req.ConversationID, Mode: req.Mode, RunnerID: req.RunnerID,
		StartedAt: now, Deadline: now.Add(time.Duration(s.MaxSessionMinutes) * time.Minute),
	}}
	t.slots[slot.info.ID] = slot
	return slot, nil
}

// ActiveSlots lists the running slots (userID 0: every user).
func (c *Component) ActiveSlots(userID int64) []SlotInfo { return c.slots.list(userID) }

// RecordRunnerUsage writes one run's resources (claudex_web_runner_usage).
// It is recorded only, never charged (web PLAN Q12).
func (c *Component) RecordRunnerUsage(ctx context.Context, r RunnerUsage) error {
	if r.UserID <= 0 {
		return errBadSlot
	}
	if r.Mode == "" {
		r.Mode = ModeChat
	}
	if !validMode(r.Mode) {
		return errBadSlot
	}
	if r.ConversationID != "" && !ValidID(r.ConversationID) {
		r.ConversationID = ""
	}
	if r.RunnerID != "" && !ValidID(r.RunnerID) {
		r.RunnerID = ""
	}
	r.ExitReason = cleanReason(r.ExitReason)
	if r.EndedAt.IsZero() {
		r.EndedAt = c.now()
	}
	if r.StartedAt.IsZero() || r.StartedAt.After(r.EndedAt) {
		r.StartedAt = r.EndedAt
	}
	if r.WallSeconds <= 0 || math.IsNaN(r.WallSeconds) || math.IsInf(r.WallSeconds, 0) {
		r.WallSeconds = r.EndedAt.Sub(r.StartedAt).Seconds()
	}
	if r.CPUSeconds < 0 || math.IsNaN(r.CPUSeconds) || math.IsInf(r.CPUSeconds, 0) {
		r.CPUSeconds = 0
	}
	st := c.store()
	if st == nil {
		return nil
	}
	rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), recordTimeout)
	defer cancel()
	if err := st.insertRunnerUsage(rctx, r); err != nil {
		slog.Warn("claudex web usage: could not record runner usage", "user_id", r.UserID, "error", err)
		return errors.New("claudex web usage: record runner usage failed")
	}
	return nil
}

// cleanReason keeps [a-z0-9_-], at most 32 bytes.
func cleanReason(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	b := make([]byte, 0, 32)
	for i := 0; i < len(s) && len(b) < 32; i++ {
		if r := s[i]; (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' || r == '-' {
			b = append(b, r)
		}
	}
	return string(b)
}
