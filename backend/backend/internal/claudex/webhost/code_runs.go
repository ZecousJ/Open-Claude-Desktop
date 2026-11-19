package webhost

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"time"

	webusage "github.com/Wei-Shaw/sub2api/internal/claudex/web/usage"
	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/google/uuid"
)

const codeRunCapacityMethod = "claudexCodeRunCapacity"
const codeRunRetryHorizon = 2 * linkRequestBudget

type codeRun struct {
	userID         int64
	conversationID string
	slot           RunSlot
	deadline       time.Time
	timer          *time.Timer
	finished       bool
	finishedAt     time.Time
}

type codeRunInput struct {
	RunID          string `json:"runId"`
	ConversationID string `json:"conversationId,omitempty"`
	ExitReason     string `json:"exitReason,omitempty"`
}

func validCodeRunID(id string) bool {
	parsed, err := uuid.Parse(id)
	return err == nil && parsed.String() == id
}

func (rc *runnerConn) codeRunRequest(ctx context.Context, userID int64, op string, raw json.RawMessage) (any, error) {
	if !rc.codeRunCapacity {
		return nil, errMethodUnavailable
	}
	var in codeRunInput
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if dec.Decode(&in) != nil || dec.Decode(new(any)) != io.EOF || !validCodeRunID(in.RunID) {
		return nil, errBadRPC
	}
	if op == "run.acquire" {
		if !validCodeRunID(in.ConversationID) || in.ExitReason != "" {
			return nil, errBadRPC
		}
		return rc.acquireCodeRun(ctx, userID, in)
	}
	if in.ConversationID != "" {
		return nil, errBadRPC
	}
	switch in.ExitReason {
	case exitCompleted, exitFailed, exitInterrupted, exitError, exitTimeout, exitRunnerLost:
	default:
		return nil, errBadRPC
	}
	return nil, rc.finishCodeRun(ctx, userID, in.RunID, in.ExitReason)
}

func (rc *runnerConn) pruneCodeRuns(now time.Time) {
	for id, run := range rc.codeRuns {
		if run.finished && now.Sub(run.finishedAt) >= codeRunRetryHorizon {
			delete(rc.codeRuns, id)
		}
	}
}

func (rc *runnerConn) acquireCodeRun(ctx context.Context, userID int64, in codeRunInput) (any, error) {
	rc.codeRunsMu.Lock()
	defer rc.codeRunsMu.Unlock()
	if rc.closed() || rc.c.reg.get(rc.id) != rc {
		return nil, errRunnerUnavailable
	}
	rc.pruneCodeRuns(time.Now())
	if run := rc.codeRuns[in.RunID]; run != nil {
		if run.userID != userID || run.conversationID != in.ConversationID || run.finished {
			return nil, errBadRPC
		}
		return map[string]int64{"deadlineMs": run.deadline.UnixMilli()}, nil
	}
	slot, err := rc.c.backends().AcquireSlot(ctx, webusage.SlotRequest{UserID: userID, ConversationID: in.ConversationID, RunnerID: rc.id, Mode: webusage.ModeCode})
	if err != nil {
		return nil, err
	}
	if rc.closed() || rc.c.reg.get(rc.id) != rc || !rc.c.reg.routed(ctx, userID, rc.id) {
		if err := slot.Release(context.WithoutCancel(ctx), webusage.SlotEnd{RunnerID: rc.id, ExitReason: exitRunnerLost}); err != nil {
			slog.Warn("claudex webhost: releasing a late Code run failed", "runner_id", rc.id, "error", err)
		}
		return nil, errRunnerUnavailable
	}
	run := &codeRun{userID: userID, conversationID: in.ConversationID, slot: slot, deadline: slot.Deadline()}
	if rc.codeRuns == nil {
		rc.codeRuns = make(map[string]*codeRun)
	}
	rc.codeRuns[in.RunID] = run
	run.timer = time.AfterFunc(max(time.Until(run.deadline), 0), func() { rc.expireCodeRun(in.RunID, run) })
	return map[string]int64{"deadlineMs": run.deadline.UnixMilli()}, nil
}

func (rc *runnerConn) finishCodeRun(ctx context.Context, userID int64, id, reason string) error {
	rc.codeRunsMu.Lock()
	defer rc.codeRunsMu.Unlock()
	if rc.closed() || rc.c.reg.get(rc.id) != rc {
		return errRunnerUnavailable
	}
	rc.pruneCodeRuns(time.Now())
	run := rc.codeRuns[id]
	if run == nil {
		if !rc.c.reg.routed(ctx, userID, rc.id) {
			return infraerrors.Forbidden(webproto.ErrCodeNotAllowed, "This runner does not serve that user.")
		}
		if rc.closed() || rc.c.reg.get(rc.id) != rc {
			return errRunnerUnavailable
		}
		if rc.codeRuns == nil {
			rc.codeRuns = make(map[string]*codeRun)
		}
		rc.codeRuns[id] = &codeRun{userID: userID, finished: true, finishedAt: time.Now()}
		return nil
	}
	if run.userID != userID {
		return errBadRPC
	}
	if run.finished {
		return nil
	}
	run.finished = true
	run.finishedAt = time.Now()
	run.timer.Stop()
	return run.slot.Release(context.WithoutCancel(ctx), webusage.SlotEnd{RunnerID: rc.id, ExitReason: reason})
}

func (rc *runnerConn) expireCodeRun(id string, run *codeRun) {
	rc.codeRunsMu.Lock()
	if run.finished {
		rc.codeRunsMu.Unlock()
		return
	}
	run.finished = true
	run.finishedAt = time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	if err := run.slot.Release(ctx, webusage.SlotEnd{RunnerID: rc.id, ExitReason: exitTimeout}); err != nil {
		slog.Warn("claudex webhost: releasing an expired Code run failed", "runner_id", rc.id, "error", err)
	}
	cancel()
	rc.codeRunsMu.Unlock()
	rc.send(webproto.GoFrame{T: "code-run-expired", ID: id, UserID: run.userID})
}

func (rc *runnerConn) closeCodeRuns() {
	rc.codeRunsMu.Lock()
	defer rc.codeRunsMu.Unlock()
	for _, run := range rc.codeRuns {
		if run.finished {
			continue
		}
		run.finished = true
		run.timer.Stop()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		if err := run.slot.Release(ctx, webusage.SlotEnd{RunnerID: rc.id, ExitReason: exitRunnerLost}); err != nil {
			slog.Warn("claudex webhost: releasing a disconnected Code run failed", "runner_id", rc.id, "error", err)
		}
		cancel()
	}
}
