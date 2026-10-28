package webhost

import (
	"context"
	"encoding/json"
	"log/slog"
	"strconv"
	"sync"
	"time"

	webusage "github.com/Wei-Shaw/sub2api/internal/claudex/web/usage"
	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
)

// Runs and capacity (W-KEY's web-usage slots): a call that starts a turn
// takes a slot (per-user and server limits, CLAUDEX_WEB_CAPACITY when full)
// that is held while a turn of that conversation is in progress. The relay
// sees the turn end in the conversation events the runner sends (every turn
// completed, failed or interrupted), and at the slot's deadline it
// interrupts the conversation. A runner that goes away ends its runs.

// engineStartingMethods are the calls that may start a turn (the runner's
// dispatcher uses the same list for its engine slot).
var engineStartingMethods = map[string]bool{
	"send":                true,
	"retryResponse":       true,
	"editPrompt":          true,
	"compactConversation": true,
}

// Exit reasons recorded with a run.
const (
	exitCompleted   = "completed"
	exitFailed      = "failed"
	exitInterrupted = "interrupted"
	exitTimeout     = "timeout"
	exitError       = "error"
	exitRunnerLost  = "runner-lost"
)

type run struct {
	userID   int64
	key      string // conv, or "~<n>" until the runner names a new conversation
	conv     string // "" until the runner names a new conversation
	runnerID string
	slot     RunSlot
	timer    *time.Timer
	ended    bool
}

type runs struct {
	c  *Component
	mu sync.Mutex
	// byUser holds each user's runs; a run without a conversation id yet
	// is keyed by "".
	byUser map[int64]map[string]*run
	next   uint64
}

func newRuns(c *Component) *runs { return &runs{c: c, byUser: map[int64]map[string]*run{}} }

// convInfo is what the relay reads from a Conversation.
type convInfo struct {
	ID    string `json:"id"`
	Mode  string `json:"mode"`
	Turns []struct {
		Status string `json:"status"`
	} `json:"turns"`
}

func (ci convInfo) inProgress() bool {
	for _, t := range ci.Turns {
		if t.Status == "inProgress" {
			return true
		}
	}
	return false
}

func (ci convInfo) exitReason() string {
	if n := len(ci.Turns); n > 0 {
		switch ci.Turns[n-1].Status {
		case "failed":
			return exitFailed
		case "interrupted":
			return exitInterrupted
		}
	}
	return exitCompleted
}

// runTarget reads the conversation and mode a turn-starting call names.
func runTarget(method string, args []json.RawMessage) (conv, mode string) {
	if len(args) == 0 {
		return "", ""
	}
	if method == "send" {
		var in struct {
			ConversationID string `json:"conversationId"`
			Mode           string `json:"mode"`
		}
		if json.Unmarshal(args[0], &in) == nil {
			conv, mode = in.ConversationID, in.Mode
		}
	} else {
		_ = json.Unmarshal(args[0], &conv)
	}
	if !webusage.ValidID(conv) {
		conv = ""
	}
	switch mode {
	case webusage.ModeChat, webusage.ModeCowork, webusage.ModeCode:
	default:
		mode = webusage.ModeChat
	}
	return conv, mode
}

// begin returns the run a turn-starting call belongs to: the conversation's
// running one, or a new one holding a slot. fresh tells whether it is new.
func (r *runs) begin(ctx context.Context, userID int64, conv, mode, runnerID string) (*run, bool, error) {
	if conv != "" {
		r.mu.Lock()
		if existing := r.byUser[userID][conv]; existing != nil {
			r.mu.Unlock()
			return existing, false, nil
		}
		r.mu.Unlock()
	}
	slot, err := r.c.backends().AcquireSlot(ctx, webusage.SlotRequest{UserID: userID, ConversationID: conv, Mode: mode, RunnerID: runnerID})
	if err != nil {
		return nil, false, err
	}
	ru := &run{userID: userID, conv: conv, runnerID: runnerID, slot: slot}
	r.mu.Lock()
	m := r.byUser[userID]
	if m == nil {
		m = map[string]*run{}
		r.byUser[userID] = m
	}
	if conv != "" {
		if existing := m[conv]; existing != nil {
			// A concurrent call started it first.
			r.mu.Unlock()
			_ = slot.Release(context.WithoutCancel(ctx), webusage.SlotEnd{RunnerID: runnerID, ExitReason: exitCompleted})
			return existing, false, nil
		}
		ru.key = conv
	} else {
		r.next++
		ru.key = "~" + strconv.FormatUint(r.next, 10)
	}
	m[ru.key] = ru
	r.arm(ru)
	r.mu.Unlock()
	return ru, true, nil
}

// arm starts the deadline timer (r.mu held).
func (r *runs) arm(ru *run) {
	d := time.Until(ru.slot.Deadline())
	if d < time.Second {
		d = time.Second
	}
	ru.timer = time.AfterFunc(d, func() { r.expire(ru) })
}

// after handles the answer of the call that started ru.
func (r *runs) after(ru *run, fresh bool, res webproto.RunnerFrame, callErr error) {
	if callErr != nil || res.OK == nil || !*res.OK {
		if fresh {
			r.end(ru, exitError)
		}
		return
	}
	var ci convInfo
	if err := json.Unmarshal(res.Value, &ci); err != nil || ci.ID == "" {
		// Not a conversation: nothing to follow.
		r.end(ru, exitCompleted)
		return
	}
	r.mu.Lock()
	if ru.conv == "" && !ru.ended {
		if !webusage.ValidID(ci.ID) {
			r.mu.Unlock()
			r.end(ru, exitCompleted)
			return
		}
		m := r.byUser[ru.userID]
		if other := m[ci.ID]; other != nil && other != ru {
			r.mu.Unlock()
			r.end(ru, exitCompleted)
			return
		}
		delete(m, ru.key)
		ru.conv, ru.key = ci.ID, ci.ID
		m[ci.ID] = ru
	}
	r.mu.Unlock()
	if !ci.inProgress() {
		r.end(ru, ci.exitReason())
	}
}

// observe follows the conversation events of users with runs.
func (r *runs) observe(userID int64, event json.RawMessage) {
	r.mu.Lock()
	n := len(r.byUser[userID])
	r.mu.Unlock()
	if n == 0 {
		return
	}
	var ev struct {
		Type         string    `json:"type"`
		Conversation *convInfo `json:"conversation"`
	}
	if err := json.Unmarshal(event, &ev); err != nil || ev.Type != "conversation" || ev.Conversation == nil {
		return
	}
	r.mu.Lock()
	ru := r.byUser[userID][ev.Conversation.ID]
	r.mu.Unlock()
	if ru != nil && ev.Conversation.ID != "" && !ev.Conversation.inProgress() {
		r.end(ru, ev.Conversation.exitReason())
	}
}

// end releases a run once.
func (r *runs) end(ru *run, reason string) {
	r.mu.Lock()
	if ru.ended {
		r.mu.Unlock()
		return
	}
	ru.ended = true
	if ru.timer != nil {
		ru.timer.Stop()
	}
	if m := r.byUser[ru.userID]; m != nil {
		if m[ru.key] == ru {
			delete(m, ru.key)
		}
		if len(m) == 0 {
			delete(r.byUser, ru.userID)
		}
	}
	r.mu.Unlock()
	// Releasing records the run (a database write): not on the caller's path.
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := ru.slot.Release(ctx, webusage.SlotEnd{RunnerID: ru.runnerID, ExitReason: reason}); err != nil {
			slog.Warn("claudex webhost: releasing a run failed", "user_id", ru.userID, "error", err)
		}
	}()
}

// expire interrupts a run that reached its deadline.
func (r *runs) expire(ru *run) {
	r.mu.Lock()
	ended, conv := ru.ended, ru.conv
	r.mu.Unlock()
	if ended {
		return
	}
	if conv != "" {
		if rc := r.c.reg.get(ru.runnerID); rc != nil {
			if tok, ok := r.c.tokens.get(ru.userID, r.c.now()); ok {
				arg, _ := json.Marshal(conv)
				ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
				_, _ = rc.call(ctx, webproto.LinkUser{ID: ru.userID, AccessToken: tok.raw}, "interrupt", []json.RawMessage{arg}, 30*time.Second)
				cancel()
			}
		}
	}
	r.end(ru, exitTimeout)
}

// endRunner ends every run on a runner whose link went away.
func (r *runs) endRunner(runnerID string) {
	r.mu.Lock()
	var list []*run
	for _, m := range r.byUser {
		for _, ru := range m {
			if ru.runnerID == runnerID {
				list = append(list, ru)
			}
		}
	}
	r.mu.Unlock()
	for _, ru := range list {
		r.end(ru, exitRunnerLost)
	}
}

// active counts the runs being followed (tests, admin).
func (r *runs) active() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, m := range r.byUser {
		n += len(m)
	}
	return n
}
