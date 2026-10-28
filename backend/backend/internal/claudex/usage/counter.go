package usage

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	claudexhook "github.com/Wei-Shaw/sub2api/internal/claudex/hook"
)

// Counting (H8). claudexhook.UsageApplied runs inside the upstream
// asynchronous billing task, already detached from the request with a 2 s
// timeout, once per billed request (applyUsageBilling applies a request at
// most once). OnUsageApplied adds the request to every matching rule with a
// single UPSERT. A failed UPSERT goes to an in-memory retry queue (capacity
// 10000, exponential backoff up to 5 minutes); when the queue is full the
// event is logged in full at error level and counted in
// claudex_usage_counter_dropped_total, never dropped silently.

const (
	retryQueueCapacity = 10000
	retryBaseDelay     = time.Second
	retryMaxDelay      = 5 * time.Minute
	retryTick          = time.Second
	retryWriteTimeout  = 2 * time.Second
	retryBatchPerTick  = 500
)

// Metrics are this node's counters of the usage-rule bookkeeping (upstream
// style: process-local totals, also written to the log with each event).
type Metrics struct {
	RetryQueue          int    `json:"retry_queue"`
	RetryQueueCapacity  int    `json:"retry_queue_capacity"`
	RetriedTotal        uint64 `json:"retried_total"`
	DroppedTotal        uint64 `json:"dropped_total"`         // claudex_usage_counter_dropped_total
	ExpiredTotal        uint64 `json:"expired_total"`         // windows that ended before a retry succeeded
	PrecheckErrorsTotal uint64 `json:"precheck_errors_total"` // prechecks that could not read rules or counters
}

// pendingUsage is a billed request whose counter update waits for a retry.
type pendingUsage struct {
	ev  claudexhook.UsageEvent // logged in full when the update is given up
	add usageAddition
	// resolved is false when the rules could not be loaded: the retry
	// matches the rules first.
	resolved bool
	// windowEnd is the latest end of any window this addition could belong
	// to (billing time + longest matching window): after it the addition can
	// no longer change any check, so it is not written into a later window.
	windowEnd time.Time
	attempts  int
	next      time.Time
}

// logAttrs describes the whole billed request for the error log.
func (p *pendingUsage) logAttrs(extra ...any) []any {
	var group any
	if p.ev.GroupID != nil {
		group = *p.ev.GroupID
	}
	attrs := []any{
		"request_id", p.ev.RequestID, "user_id", p.ev.UserID, "api_key_id", p.ev.APIKeyID, "group_id", group,
		"requested_model", p.ev.RequestedModel, "billed_model", p.ev.BilledModel, "upstream_model", p.ev.UpstreamModel,
		"cost_usd", p.add.CostUSD, "billed_at", p.add.At.Format(time.RFC3339Nano), "rule_ids", p.add.RuleIDs,
		"attempts", p.attempts,
	}
	return append(attrs, extra...)
}

type retryQueue struct {
	mu       sync.Mutex
	items    []*pendingUsage
	capacity int
	closed   bool // the worker stopped: nothing will retry a pushed item
	wake     chan struct{}

	retried atomic.Uint64
	dropped atomic.Uint64
	expired atomic.Uint64
}

var errRulesUnavailable = errors.New("usage rules could not be loaded")

func newRetryQueue(capacity int) *retryQueue {
	return &retryQueue{capacity: capacity, wake: make(chan struct{}, 1)}
}

// push queues an addition for a retry; it reports false when the queue is
// full or closed.
func (q *retryQueue) push(p *pendingUsage) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed || len(q.items) >= q.capacity {
		return false
	}
	q.items = append(q.items, p)
	return true
}

// close stops accepting items and returns the ones still queued.
func (q *retryQueue) close() []*pendingUsage {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.closed = true
	items := q.items
	q.items = nil
	return items
}

func (q *retryQueue) isClosed() bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.closed
}

func (q *retryQueue) len() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.items)
}

// takeDue removes and returns up to max items due at now.
func (q *retryQueue) takeDue(now time.Time, max int) []*pendingUsage {
	q.mu.Lock()
	defer q.mu.Unlock()
	var due []*pendingUsage
	kept := q.items[:0]
	for _, p := range q.items {
		if len(due) < max && !p.next.After(now) {
			due = append(due, p)
			continue
		}
		kept = append(kept, p)
	}
	for i := len(kept); i < len(q.items); i++ {
		q.items[i] = nil
	}
	q.items = kept
	return due
}

func backoff(attempts int) time.Duration {
	d := retryBaseDelay
	for i := 1; i < attempts && d < retryMaxDelay; i++ {
		d *= 2
	}
	if d > retryMaxDelay {
		d = retryMaxDelay
	}
	return d
}

// OnUsageApplied implements core.UsageObserver (H8): it counts one billed
// request against every enabled rule of the request's group whose patterns
// match the requested, billed or upstream model (each rule once).
func (c *Component) OnUsageApplied(ctx context.Context, ev claudexhook.UsageEvent) {
	if ev.UserID <= 0 {
		return
	}
	if ev.At.IsZero() {
		ev.At = c.now()
	}
	ev.At = ev.At.UTC()
	c.recordProduct(ctx, ev)
	set, err := c.rules.get(ctx)
	if err != nil {
		// The rules cannot be read: keep the event for a retry that matches
		// the rules first.
		c.retryLater(&pendingUsage{
			ev:        ev,
			add:       usageAddition{UserID: ev.UserID, At: ev.At, CostUSD: nonNegative(ev.CostUSD)},
			windowEnd: ev.At.Add(MaxWindowSeconds * time.Second),
			attempts:  1,
		}, errRulesUnavailable)
		return
	}
	add, windowEnd := additionFor(set, ev)
	if len(add.RuleIDs) == 0 {
		return
	}
	if err := c.store.accumulate(ctx, add); err != nil {
		c.retryLater(&pendingUsage{ev: ev, add: add, resolved: true, windowEnd: windowEnd, attempts: 1}, err)
	}
}

// additionFor picks the matching rules of an event (ev.At set).
func additionFor(set *ruleSet, ev claudexhook.UsageEvent) (usageAddition, time.Time) {
	add := usageAddition{UserID: ev.UserID, At: ev.At, CostUSD: nonNegative(ev.CostUSD)}
	windowEnd := add.At
	names := modelNameForms(ev.RequestedModel, ev.BilledModel, ev.UpstreamModel)
	for _, r := range set.forGroup(ev.GroupID) {
		if !r.matchesAny(names...) {
			continue
		}
		add.RuleIDs = append(add.RuleIDs, r.ID)
		if end := add.At.Add(time.Duration(r.WindowSeconds) * time.Second); end.After(windowEnd) {
			windowEnd = end
		}
	}
	return add, windowEnd
}

func nonNegative(v float64) float64 {
	if v < 0 {
		return 0
	}
	return v
}

// retryLater schedules a retry after the backoff of p.attempts; with the
// queue full, the whole event goes to the error log and the dropped counter.
func (c *Component) retryLater(p *pendingUsage, cause error) {
	p.next = c.now().Add(backoff(p.attempts))
	if c.queue.push(p) {
		if p.attempts == 1 {
			slog.Warn("claudex usage: counter update failed, will retry", p.logAttrs("error", cause)...)
		} else {
			slog.Debug("claudex usage: counter update failed again", p.logAttrs("error", cause)...)
		}
		c.signalRetry()
		return
	}
	dropped := c.queue.dropped.Add(1)
	msg := "claudex usage: counter update dropped, retry queue full"
	if c.queue.isClosed() {
		msg = "claudex usage: counter update dropped, shutting down"
	}
	slog.Error(msg, p.logAttrs("error", cause, "claudex_usage_counter_dropped_total", dropped)...)
}

func (c *Component) signalRetry() {
	select {
	case c.queue.wake <- struct{}{}:
	default:
	}
}

// retryLoop runs until ctx ends, retrying due additions every second.
func (c *Component) retryLoop(ctx context.Context) {
	ticker := time.NewTicker(retryTick)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			c.flushOnShutdown()
			return
		case <-ticker.C:
		case <-c.queue.wake:
		}
		c.retryDue(ctx)
	}
}

// retryDue retries the additions whose backoff elapsed. After the first
// failure that is not permanent the database is presumably down: the rest of
// the batch goes back to the queue untried (one probe per tick).
func (c *Component) retryDue(ctx context.Context) {
	now := c.now()
	due := c.queue.takeDue(now, retryBatchPerTick)
	for i, p := range due {
		if ctx.Err() != nil {
			c.requeue(due[i:])
			return
		}
		if !now.Before(p.windowEnd) {
			// Every window this request could count toward has ended; writing it
			// now would only add it to a later window.
			expired := c.queue.expired.Add(1)
			slog.Error("claudex usage: counter update expired before it could be written",
				p.logAttrs("claudex_usage_counter_expired_total", expired)...)
			continue
		}
		if !p.resolved {
			set, err := c.rules.get(ctx)
			if err != nil {
				p.attempts++
				c.retryLater(p, err)
				c.requeue(due[i+1:])
				return
			}
			p.add, p.windowEnd = additionFor(set, p.ev)
			p.resolved = true
			if len(p.add.RuleIDs) == 0 {
				continue
			}
		}
		wctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), retryWriteTimeout)
		err := c.store.accumulate(wctx, p.add)
		cancel()
		c.queue.retried.Add(1)
		switch {
		case err == nil:
		case isPermanent(err):
			slog.Error("claudex usage: counter update rejected by the database, not retried", p.logAttrs("error", err)...)
		default:
			p.attempts++
			c.retryLater(p, err)
			c.requeue(due[i+1:])
			return
		}
	}
}

// flushOnShutdown closes the queue (later failures are logged in full at
// once, nothing would retry them), makes one last attempt to write what is
// queued while the database is still reachable, and logs every addition it
// could not write in full, like an overflow: nothing is lost silently.
func (c *Component) flushOnShutdown() {
	items := c.queue.close()
	if len(items) == 0 {
		return
	}
	now := c.now()
	written, down := 0, false
	for _, p := range items {
		var err error
		switch {
		case down:
			err = errShuttingDown
		case !now.Before(p.windowEnd):
			err = errWindowEnded
		default:
			if !p.resolved {
				set, rerr := c.rules.get(context.Background())
				if rerr != nil {
					err, down = rerr, true
					break
				}
				p.add, p.windowEnd = additionFor(set, p.ev)
				p.resolved = true
				if len(p.add.RuleIDs) == 0 {
					continue
				}
			}
			wctx, cancel := context.WithTimeout(context.Background(), retryWriteTimeout)
			err = c.store.accumulate(wctx, p.add)
			cancel()
			if err == nil {
				written++
				continue
			}
			down = !isPermanent(err)
		}
		dropped := c.queue.dropped.Add(1)
		slog.Error("claudex usage: counter update not written at shutdown",
			p.logAttrs("error", err, "claudex_usage_counter_dropped_total", dropped)...)
	}
	if written > 0 {
		slog.Info("claudex usage: wrote queued counter updates at shutdown", "written", written)
	}
}

var (
	errShuttingDown = errors.New("shutting down after the database failed")
	errWindowEnded  = errors.New("every window of the request ended")
)

// requeue puts untried items back as they were.
func (c *Component) requeue(items []*pendingUsage) {
	for _, p := range items {
		if !c.queue.push(p) {
			dropped := c.queue.dropped.Add(1)
			slog.Error("claudex usage: counter update dropped, retry queue full",
				p.logAttrs("claudex_usage_counter_dropped_total", dropped)...)
		}
	}
}

// Metrics returns this node's bookkeeping counters.
func (c *Component) Metrics() Metrics {
	return Metrics{
		RetryQueue:          c.queue.len(),
		RetryQueueCapacity:  c.queue.capacity,
		RetriedTotal:        c.queue.retried.Load(),
		DroppedTotal:        c.queue.dropped.Load(),
		ExpiredTotal:        c.queue.expired.Load(),
		PrecheckErrorsTotal: c.precheckErrors.Load(),
	}
}
