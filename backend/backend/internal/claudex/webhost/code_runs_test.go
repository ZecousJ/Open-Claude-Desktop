package webhost

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	webusage "github.com/Wei-Shaw/sub2api/internal/claudex/web/usage"

	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestCodeRunLinkCapacityAndReplacement(t *testing.T) {
	h := newHost(t)
	methods := append(append([]string{}, defaultMethods...), codeRunCapacityMethod)
	fr, err := h.dialRunner(localToken, methods, echoCalls)
	require.NoError(t, err)
	require.True(t, fr.welcome.CodeRunCapacity)
	h.rpc(userA, "listThings")
	id, conv := uuid.NewString(), uuid.NewString()
	body := map[string]any{"runId": id, "conversationId": conv}
	first := fr.request("a1", "run.acquire", userA, body)
	require.True(t, *first.OK, "%+v", first.Error)
	var grant struct {
		DeadlineMs int64 `json:"deadlineMs"`
	}
	require.NoError(t, json.Unmarshal(first.Value, &grant))
	require.Positive(t, grant.DeadlineMs)
	duplicate := fr.request("a2", "run.acquire", userA, body)
	require.True(t, *duplicate.OK)
	require.JSONEq(t, string(first.Value), string(duplicate.Value))
	require.Equal(t, 1, h.slots.activeOf(userA))
	denied := fr.request("a3", "run.acquire", userA, map[string]any{"runId": uuid.NewString(), "conversationId": conv})
	require.False(t, *denied.OK)
	require.Equal(t, webproto.ErrCodeCapacity, denied.Error.Code)
	finish := map[string]any{"runId": id, "exitReason": "interrupted"}
	require.True(t, *fr.request("f1", "run.finish", userA, finish).OK)
	require.Zero(t, h.slots.activeOf(userA))
	require.True(t, *fr.request("f2", "run.finish", userA, finish).OK)
	require.False(t, *fr.request("a4", "run.acquire", userA, body).OK)
	h.slots.mu.Lock()
	require.Equal(t, []string{"interrupted"}, h.slots.released)
	h.slots.mu.Unlock()
	id2 := uuid.NewString()
	require.True(t, *fr.request("a5", "run.acquire", userA, map[string]any{"runId": id2, "conversationId": conv}).OK)
	replacement, err := h.dialRunner(localToken, methods, echoCalls)
	require.NoError(t, err)
	require.True(t, replacement.welcome.CodeRunCapacity)
	waitFor(t, "old reservation released", func() bool { return h.slots.activeOf(userA) == 0 })
	h.slots.mu.Lock()
	require.Equal(t, []string{"interrupted", "runner-lost"}, h.slots.released)
	h.slots.mu.Unlock()
	require.True(t, *replacement.request("f3", "run.finish", userA, map[string]any{"runId": id2, "exitReason": "completed"}).OK)
}

func TestCodeRunNegotiationAndUserRouting(t *testing.T) {
	h := newHost(t)
	fr := h.runner()
	require.False(t, fr.welcome.CodeRunCapacity)
	h.rpc(userA, "listThings")
	body := map[string]any{"runId": uuid.NewString(), "conversationId": uuid.NewString()}
	res := fr.request("unnegotiated", "run.acquire", userA, body)
	require.False(t, *res.OK)
	require.Equal(t, webproto.ErrCodeMethodUnavailable, res.Error.Code)
	res = fr.request("unrouted", "run.acquire", userB, body)
	require.False(t, *res.OK)
	require.Equal(t, webproto.ErrCodeNotAllowed, res.Error.Code)
}

type shortCodeSlot struct {
	RunSlot
	deadline time.Time
}

func (s shortCodeSlot) Deadline() time.Time { return s.deadline }

func TestCodeRunDeadline(t *testing.T) {
	h := newHost(t)
	acquire := h.c.b.AcquireSlot
	h.c.b.AcquireSlot = func(ctx context.Context, req webusage.SlotRequest) (RunSlot, error) {
		slot, err := acquire(ctx, req)
		if err != nil {
			return nil, err
		}
		return shortCodeSlot{slot, time.Now().Add(100 * time.Millisecond)}, nil
	}
	methods := append(append([]string{}, defaultMethods...), codeRunCapacityMethod)
	fr, err := h.dialRunner(localToken, methods, echoCalls)
	require.NoError(t, err)
	h.rpc(userA, "listThings")
	id := uuid.NewString()
	res := fr.request("deadline", "run.acquire", userA, map[string]any{"runId": id, "conversationId": uuid.NewString()})
	require.True(t, *res.OK)
	waitFor(t, "expiry", func() bool { return len(fr.framesOf("code-run-expired")) == 1 })
	expired := fr.framesOf("code-run-expired")[0]
	require.Equal(t, id, expired.ID)
	require.EqualValues(t, userA, expired.UserID)
	require.Zero(t, h.slots.activeOf(userA))
	h.slots.mu.Lock()
	require.Equal(t, []string{"timeout"}, h.slots.released)
	h.slots.mu.Unlock()
}

func TestCodeRunAcquireFinishingAfterDisconnect(t *testing.T) {
	h := newHost(t)
	acquire := h.c.b.AcquireSlot
	entered, proceed := make(chan struct{}), make(chan struct{})
	h.c.b.AcquireSlot = func(ctx context.Context, req webusage.SlotRequest) (RunSlot, error) {
		close(entered)
		<-proceed
		return acquire(ctx, req)
	}
	methods := append(append([]string{}, defaultMethods...), codeRunCapacityMethod)
	fr, err := h.dialRunner(localToken, methods, echoCalls)
	require.NoError(t, err)
	h.rpc(userA, "listThings")
	rc := h.c.reg.get("local")
	require.NotNil(t, rc)
	fr.send(map[string]any{"t": "request", "id": "late", "op": "run.acquire", "userId": userA, "body": map[string]any{"runId": uuid.NewString(), "conversationId": uuid.NewString()}})
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("acquire did not start")
	}
	require.NoError(t, fr.conn.CloseNow())
	waitFor(t, "link closed", rc.closed)
	close(proceed)
	waitFor(t, "late slot released", func() bool {
		h.slots.mu.Lock()
		defer h.slots.mu.Unlock()
		return len(h.slots.released) == 1
	})
	require.Zero(t, h.slots.activeOf(userA))
	h.slots.mu.Lock()
	require.Equal(t, []string{"runner-lost"}, h.slots.released)
	h.slots.mu.Unlock()
}

func TestCodeRunFinishBeforeAcquireAndMovedUser(t *testing.T) {
	h := newHost(t)
	methods := append(append([]string{}, defaultMethods...), codeRunCapacityMethod)
	fr, err := h.dialRunner(localToken, methods, echoCalls)
	require.NoError(t, err)
	h.rpc(userA, "listThings")
	id := uuid.NewString()
	finish := map[string]any{"runId": id, "exitReason": "error"}
	require.True(t, *fr.request("before", "run.finish", userA, finish).OK)
	require.True(t, *fr.request("before-again", "run.finish", userA, finish).OK)
	require.False(t, *fr.request("too-late", "run.acquire", userA, map[string]any{"runId": id, "conversationId": uuid.NewString()}).OK)
	require.Zero(t, h.slots.activeOf(userA))
	require.False(t, *fr.request("other", "run.finish", userB, finish).OK)

	activeID := uuid.NewString()
	require.True(t, *fr.request("active", "run.acquire", userA, map[string]any{"runId": activeID, "conversationId": uuid.NewString()}).OK)
	h.c.reg.mu.Lock()
	h.c.reg.assign[userA] = "another-runner"
	h.c.reg.mu.Unlock()
	require.True(t, *fr.request("moved", "run.finish", userA, map[string]any{"runId": activeID, "exitReason": "completed"}).OK)
	require.Zero(t, h.slots.activeOf(userA))
	denied := fr.request("moved-unknown", "run.finish", userA, map[string]any{"runId": uuid.NewString(), "exitReason": "error"})
	require.False(t, *denied.OK)
	require.Equal(t, webproto.ErrCodeNotAllowed, denied.Error.Code)
}

func TestCodeRunTombstoneHorizon(t *testing.T) {
	now := time.Now()
	rc := &runnerConn{codeRuns: map[string]*codeRun{
		"old":    {finished: true, finishedAt: now.Add(-codeRunRetryHorizon)},
		"recent": {finished: true, finishedAt: now.Add(-codeRunRetryHorizon + time.Second)},
		"active": {},
	}}
	rc.pruneCodeRuns(now)
	require.NotContains(t, rc.codeRuns, "old")
	require.Contains(t, rc.codeRuns, "recent")
	require.Contains(t, rc.codeRuns, "active")
	require.GreaterOrEqual(t, codeRunRetryHorizon, 2*linkRequestBudget)
}

func TestCodeRunAcquireRechecksRouting(t *testing.T) {
	h := newHost(t)
	acquire := h.c.b.AcquireSlot
	entered, proceed := make(chan struct{}), make(chan struct{})
	h.c.b.AcquireSlot = func(ctx context.Context, req webusage.SlotRequest) (RunSlot, error) {
		close(entered)
		<-proceed
		return acquire(ctx, req)
	}
	methods := append(append([]string{}, defaultMethods...), codeRunCapacityMethod)
	fr, err := h.dialRunner(localToken, methods, echoCalls)
	require.NoError(t, err)
	h.rpc(userA, "listThings")
	fr.send(map[string]any{"t": "request", "id": "route-moved", "op": "run.acquire", "userId": userA, "body": map[string]any{"runId": uuid.NewString(), "conversationId": uuid.NewString()}})
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("acquire did not start")
	}
	h.c.reg.mu.Lock()
	h.c.reg.assign[userA] = "another-runner"
	h.c.reg.mu.Unlock()
	close(proceed)
	waitFor(t, "rejected moved acquisition", func() bool { return len(fr.framesOf("response")) > 0 })
	require.False(t, *fr.framesOf("response")[0].OK)
	require.Zero(t, h.slots.activeOf(userA))
}
