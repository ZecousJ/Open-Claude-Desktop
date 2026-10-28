// Package requestbudget carries the one deadline shared by all gateway attempts.
// CLAUDEX: Request-scoped group failover with one shared generation budget.
package requestbudget

import (
	"context"
	"sync"
	"time"
)

// Total bounds the time before a request's first output: choosing, queueing
// and switching accounts and waiting for the upstream's first token. Once
// output has started (Disarm) the request is not timed any more, so a long
// answer is never cut off. Three minutes (owner, 2026-10-03): a reasoning
// model that thinks without streaming (grok-4.7) took 44s to its first token
// and was cut off at a minute on the next request.
const Total = 3 * time.Minute

// ImagesTotal is the budget of an image request (CLAUDEX, 2026-10-03): its
// output is the picture, which arrives whole, often after more than a minute.
const ImagesTotal = 10 * time.Minute

type deadlineKey struct{}

// budget is one request's clock. The timer cancels the request with
// context.DeadlineExceeded as its cause; Disarm stops it for good.
type budget struct {
	mu       sync.Mutex
	deadline time.Time
	active   bool
	timer    *time.Timer
	drain    context.Context
	// cancelDrain ends the drain context with the request's clock.
	cancelDrain context.CancelCauseFunc
}

// Start is idempotent: dispatching to another protocol or account never resets
// the request budget. A caller's earlier deadline always wins.
func Start(parent context.Context) (context.Context, context.CancelFunc) {
	return StartWithin(parent, Total)
}

// StartWithin is Start with another budget than Total.
func StartWithin(parent context.Context, total time.Duration) (context.Context, context.CancelFunc) {
	if _, ok := parent.Value(deadlineKey{}).(*budget); ok {
		return parent, func() {}
	}
	if parent != nil && parent.Value(turnsKey{}) != nil {
		return parent, func() {}
	}
	return StartAt(parent, time.Now().Add(total))
}

// StartAt also supports a turn's original ingress time before account selection.
func StartAt(parent context.Context, deadline time.Time) (context.Context, context.CancelFunc) {
	if existing, ok := Deadline(parent); ok && existing.Before(deadline) {
		deadline = existing
	}
	if existing, ok := parent.Deadline(); ok && existing.Before(deadline) {
		deadline = existing
	}
	ctx, cancel := context.WithCancelCause(parent)
	drain, cancelDrain := context.WithCancelCause(context.WithoutCancel(parent))
	b := &budget{deadline: deadline, active: true, drain: drain, cancelDrain: cancelDrain}
	b.timer = time.AfterFunc(time.Until(deadline), func() {
		b.mu.Lock()
		expired := b.active
		b.mu.Unlock()
		if expired {
			cancel(context.DeadlineExceeded)
			cancelDrain(context.DeadlineExceeded)
		}
	})
	return context.WithValue(budgetContext{Context: ctx, b: b}, deadlineKey{}, b), func() {
		b.disarm()
		cancel(context.Canceled)
		cancelDrain(context.Canceled)
	}
}

// budgetContext reports an expired budget as a deadline, as the
// context.WithDeadline it replaces did: Err is DeadlineExceeded and Deadline
// is the budget's while it runs, so code that tells a timeout from a client
// that left keeps working.
type budgetContext struct {
	context.Context
	b *budget
}

func (c budgetContext) Err() error {
	err := c.Context.Err()
	if err != nil && context.Cause(c.Context) == context.DeadlineExceeded {
		return context.DeadlineExceeded
	}
	return err
}

func (c budgetContext) Deadline() (time.Time, bool) {
	c.b.mu.Lock()
	deadline, active := c.b.deadline, c.b.active
	c.b.mu.Unlock()
	if active {
		return deadline, true
	}
	return c.Context.Deadline()
}

func (b *budget) disarm() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.active = false
	if b.timer != nil {
		b.timer.Stop()
	}
}

// Disarm stops the request's clock once its output has started: from then
// on the answer takes as long as it takes. A request already past its
// deadline stays expired.
func Disarm(ctx context.Context) {
	if ctx == nil {
		return
	}
	if turns, ok := ctx.Value(turnsKey{}).(*Turns); ok {
		turns.Complete()
		return
	}
	if b, ok := ctx.Value(deadlineKey{}).(*budget); ok && context.Cause(ctx) != context.DeadlineExceeded {
		b.disarm()
	}
}

func Deadline(ctx context.Context) (time.Time, bool) {
	if ctx == nil {
		return time.Time{}, false
	}
	if turns, ok := ctx.Value(turnsKey{}).(*Turns); ok {
		return turns.currentDeadline()
	}
	b, ok := ctx.Value(deadlineKey{}).(*budget)
	if !ok {
		return time.Time{}, false
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.deadline, b.active
}

func Expired(ctx context.Context) bool {
	deadline, ok := Deadline(ctx)
	if ctx != nil && context.Cause(ctx) == context.DeadlineExceeded {
		return true
	}
	if ctx != nil && ctx.Err() == context.Canceled {
		return false
	}
	return ok && (ctx.Err() == context.DeadlineExceeded || !time.Now().Before(deadline))
}

// Detach lets an already-sent request drain usage after a client disconnect,
// without dropping the original request deadline or granting a fresh budget.
// Accounting itself uses its separate, existing cleanup context.
type detachedBudgetContext struct {
	context.Context
	lifecycle context.Context
	// b is the request's clock, when the budget is a request's (not a turn's).
	b *budget
}

func (c detachedBudgetContext) Deadline() (time.Time, bool) {
	if c.b != nil {
		c.b.mu.Lock()
		deadline, active := c.b.deadline, c.b.active
		c.b.mu.Unlock()
		if active {
			return deadline, true
		}
	}
	return c.lifecycle.Deadline()
}
func (c detachedBudgetContext) Done() <-chan struct{} { return c.lifecycle.Done() }
func (c detachedBudgetContext) Err() error {
	err := c.lifecycle.Err()
	if err != nil && context.Cause(c.lifecycle) == context.DeadlineExceeded {
		return context.DeadlineExceeded
	}
	return err
}

func Detach(ctx context.Context) (context.Context, context.CancelFunc) {
	base := context.WithoutCancel(ctx)
	var lifecycle context.Context
	var clock *budget
	if b, ok := ctx.Value(deadlineKey{}).(*budget); ok {
		lifecycle = b.drain
		clock = b
	}
	if turns, ok := ctx.Value(turnsKey{}).(*Turns); ok {
		lifecycle = turns.drainContext()
		clock = nil
	}
	if lifecycle != nil {
		// Existing forwarders call release immediately after request construction.
		// The request/turn owner alone owns the shared deadline timer's lifetime.
		return detachedBudgetContext{Context: base, lifecycle: lifecycle, b: clock}, func() {}
	}
	return base, func() {}
}
