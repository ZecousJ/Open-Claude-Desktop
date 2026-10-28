// CLAUDEX: Request-scoped group failover with one shared generation budget.
package requestbudget

import (
	"context"
	"sync"
	"time"
)

type turnsKey struct{}

// Turns bounds active WebSocket generations, not idle connection lifetime.
// A failed account leaves the active deadline intact; only a completed turn
// disarms it. Cancellation interrupts selection and upstream I/O together.
type Turns struct {
	drain      context.Context
	stopDrain  context.CancelFunc
	mu         sync.Mutex
	parent     context.Context
	cancel     context.CancelCauseFunc
	deadline   time.Time
	timer      *time.Timer
	active     bool
	expired    bool
	generation uint64
}

func NewTurns(parent context.Context) (context.Context, *Turns) {
	ctx, cancel := context.WithCancelCause(parent)
	t := &Turns{parent: parent, cancel: cancel}
	return context.WithValue(ctx, turnsKey{}, t), t
}

// Begin is intentionally idempotent across failover and internal retries.
func (t *Turns) Begin(startedAt time.Time) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.active || t.expired || t.parent.Err() != nil {
		return
	}
	if startedAt.IsZero() {
		startedAt = time.Now()
	}
	t.deadline = startedAt.Add(Total)
	if d, ok := t.parent.Deadline(); ok && d.Before(t.deadline) {
		t.deadline = d
	}
	t.drain, t.stopDrain = context.WithDeadline(context.WithoutCancel(t.parent), t.deadline)
	t.active = true
	t.generation++
	generation := t.generation
	t.timer = time.AfterFunc(time.Until(t.deadline), func() {
		t.mu.Lock()
		defer t.mu.Unlock()
		if t.active && t.generation == generation {
			t.expired = true
			t.cancel(context.DeadlineExceeded)
		}
	})
}

func (t *Turns) Complete() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.active = false
	if t.stopDrain != nil {
		t.stopDrain()
	}
	t.generation++
	if t.timer != nil {
		t.timer.Stop()
	}
}

func (t *Turns) Stop() { t.Complete(); t.cancel(context.Canceled) }

func (t *Turns) currentDeadline() (time.Time, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.deadline, t.active
}

func (t *Turns) drainContext() context.Context {
	t.mu.Lock()
	defer t.mu.Unlock()
	if !t.active {
		return nil
	}
	return t.drain
}
