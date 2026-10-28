package webhost

import (
	"context"
	"log/slog"
	"sort"
	"sync"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
)

var errRunnerUnavailable = infraerrors.ServiceUnavailable(webproto.ErrCodeRunnerUnavailable,
	"Claudex on the web can't run conversations right now. Try again in a minute.")

// registry holds the connected runners and the user → runner assignments
// (affinity). A user is served by one runner at a time; the relay accepts a
// runner's events, pages to open and store requests only for users assigned
// to it (tenant isolation between runners, W-PROTO review).
type registry struct {
	dir RunnerDirectory

	mu      sync.Mutex
	runners map[string]*runnerConn
	// assign caches the directory ("" = known to have none).
	assign map[int64]string
}

func newRegistry(dir RunnerDirectory) *registry {
	return &registry{dir: dir, runners: map[string]*runnerConn{}, assign: map[int64]string{}}
}

// attach makes rc the connection of its runner id and returns the one it
// replaces, if any.
func (r *registry) attach(rc *runnerConn) *runnerConn {
	r.mu.Lock()
	defer r.mu.Unlock()
	old := r.runners[rc.id]
	r.runners[rc.id] = rc
	return old
}

// detach removes rc when it is still the runner's connection.
func (r *registry) detach(rc *runnerConn) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.runners[rc.id] != rc {
		return false
	}
	delete(r.runners, rc.id)
	return true
}

func (r *registry) get(id string) *runnerConn {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.runners[id]
}

func (r *registry) all() []*runnerConn {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]*runnerConn, 0, len(r.runners))
	for _, rc := range r.runners {
		out = append(out, rc)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].id < out[j].id })
	return out
}

// assignment returns the runner id serving the user ("" for none), reading
// the directory once per user.
func (r *registry) assignment(ctx context.Context, userID int64) string {
	r.mu.Lock()
	id, ok := r.assign[userID]
	r.mu.Unlock()
	if ok {
		return id
	}
	lctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	id, err := r.dir.Assignment(lctx, userID)
	if err != nil {
		slog.Warn("claudex webhost: reading a runner assignment failed", "user_id", userID, "error", err)
		return ""
	}
	r.mu.Lock()
	if cur, ok := r.assign[userID]; ok {
		id = cur
	} else {
		r.assign[userID] = id
	}
	r.mu.Unlock()
	return id
}

// routed reports whether the user is assigned to the runner.
func (r *registry) routed(ctx context.Context, userID int64, runnerID string) bool {
	return userID > 0 && runnerID != "" && r.assignment(ctx, userID) == runnerID
}

// current returns the connected runner assigned to the user, nil when none
// (no new assignment is made).
func (r *registry) current(ctx context.Context, userID int64) *runnerConn {
	id := r.assignment(ctx, userID)
	if id == "" {
		return nil
	}
	return r.get(id)
}

// pick returns the runner for a user's call: the assigned one while it is
// connected and not draining, otherwise the connected runner serving the
// fewest users (single mode: the only one), which becomes the assignment.
// Runners labelled role=standby come last.
func (r *registry) pick(ctx context.Context, userID int64) (*runnerConn, error) {
	id := r.assignment(ctx, userID)
	r.mu.Lock()
	if rc := r.runners[id]; rc != nil && !rc.isDraining() {
		r.mu.Unlock()
		return rc, nil
	}
	// The assigned runner is only out of reach (restarting, its link
	// dropped): the user's files, workspace and settings live on it, so the
	// user waits for it instead of being moved to another runner, which would
	// strand them. Only a runner that is gone for good (disabled, revoked,
	// unknown) or draining lets the user move.
	if id != "" && r.runners[id] == nil && r.unreachableTemporarily(ctx, id) {
		r.mu.Unlock()
		return nil, errRunnerUnavailable
	}
	counts := map[string]int{}
	for _, a := range r.assign {
		if a != "" {
			counts[a]++
		}
	}
	// A standby runner takes new users only while no other runner is linked.
	var best *runnerConn
	for _, rc := range r.runners {
		if rc.isDraining() {
			continue
		}
		if best == nil {
			best = rc
			continue
		}
		if rc.isStandby() != best.isStandby() {
			if best.isStandby() {
				best = rc
			}
			continue
		}
		if counts[rc.id] < counts[best.id] || (counts[rc.id] == counts[best.id] && rc.id < best.id) {
			best = rc
		}
	}
	if best == nil {
		r.mu.Unlock()
		return nil, errRunnerUnavailable
	}
	previous := r.runners[id]
	r.assign[userID] = best.id
	r.mu.Unlock()

	lctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if err := r.dir.Assign(lctx, userID, best.id); err != nil {
		slog.Warn("claudex webhost: saving a runner assignment failed", "user_id", userID, "error", err)
	}
	// The user moved away from a draining runner: it forgets the user.
	if previous != nil && previous != best {
		previous.signOut(userID, webproto.SignedOutRemoved)
	}
	return best, nil
}

// usersOf counts the users assigned to each runner id.
func (r *registry) usersOf() map[string]int {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := map[string]int{}
	for _, a := range r.assign {
		if a != "" {
			out[a]++
		}
	}
	return out
}

// unreachableTemporarily reports whether the runner id is a runner that is
// still in service (the local one, or a stored runner neither disabled nor
// revoked) even though it is not connected now. Called with r.mu held; it
// asks the directory outside the lock's protection of the maps only.
func (r *registry) unreachableTemporarily(ctx context.Context, id string) bool {
	if id == LocalRunnerID {
		return true
	}
	r.mu.Unlock()
	defer r.mu.Lock()
	lctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	records, err := r.dir.List(lctx)
	if err != nil {
		// Cannot tell: keep the user where their files are.
		return true
	}
	for _, rec := range records {
		if rec.LinkID() == id {
			return rec.RevokedAt == nil && rec.DisabledAt == nil
		}
	}
	return false
}
