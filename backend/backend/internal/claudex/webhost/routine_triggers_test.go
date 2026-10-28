package webhost

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
)

// memoryTriggers is the trigger store of the tests.
type memoryTriggers struct {
	mu   sync.Mutex
	rows map[string]routineTrigger
}

func newMemoryTriggers() *memoryTriggers { return &memoryTriggers{rows: map[string]routineTrigger{}} }

func (m *memoryTriggers) PutToken(_ context.Context, id string, uid int64, hash, hint string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if row, ok := m.rows[id]; ok && row.UserID != uid {
		return errRoutineTriggerTaken
	}
	m.rows[id] = routineTrigger{UserID: uid, TokenHash: hash, TokenHint: hint}
	return nil
}

func (m *memoryTriggers) DeleteToken(_ context.Context, id string, uid int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if row, ok := m.rows[id]; ok && row.UserID == uid {
		delete(m.rows, id)
	}
	return nil
}

func (m *memoryTriggers) Get(_ context.Context, id string) (routineTrigger, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	row, ok := m.rows[id]
	if !ok {
		return routineTrigger{}, errRoutineTriggerNotFound
	}
	return row, nil
}

func (m *memoryTriggers) Fired(context.Context, string, time.Time) error { return nil }

func fire(t *testing.T, h *host, id, token, body string) (int, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, h.srv.URL+"/api/v1/claudex/routines/"+id+"/fire", bytes.NewBufferString(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	var out map[string]any
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out
}

func TestRoutineAPITriggerTokenAndFire(t *testing.T) {
	h := newHost(t)
	var calls []webproto.GoFrame
	var mu sync.Mutex
	fr, err := h.dialRunner(localToken, defaultMethods, func(f webproto.GoFrame) (any, *webproto.RPCError, bool) {
		if f.Method != fireRoutineMethod {
			return echoCalls(f)
		}
		mu.Lock()
		calls = append(calls, f)
		mu.Unlock()
		return map[string]any{"scheduledTaskId": "task-1", "conversationId": "conv-1"}, nil, true
	})
	if err != nil {
		t.Fatal(err)
	}
	h.rpc(7, "listThings") // assigns 7 and 8 to the runner
	h.rpc(8, "listThings")
	const id = "trg_0123456789abcdefABCDEFgh"
	got := fr.request("r1", webproto.OpRoutineAPIToken, 7, map[string]any{"triggerId": id, "action": "generate"})
	if got.OK == nil || !*got.OK {
		t.Fatalf("generate failed: %+v", got.Error)
	}
	var grant struct{ Token, Hint string }
	if err := json.Unmarshal(got.Value, &grant); err != nil || len(grant.Token) < 40 || grant.Hint != grant.Token[len(grant.Token)-4:] {
		t.Fatalf("bad grant %s", got.Value)
	}
	// Another account cannot take the trigger over.
	other := fr.request("r2", webproto.OpRoutineAPIToken, 8, map[string]any{"triggerId": id, "action": "generate"})
	if other.OK == nil || *other.OK {
		t.Fatal("another user took the trigger")
	}
	if code, _ := fire(t, h, id, "cxr_wrong", `{}`); code != http.StatusUnauthorized {
		t.Fatalf("wrong token answered %d", code)
	}
	if code, _ := fire(t, h, "trg_000000000000000000000000", grant.Token, `{}`); code != http.StatusUnauthorized {
		t.Fatalf("unknown trigger answered %d", code)
	}
	code, out := fire(t, h, id, grant.Token, `{"text":"Look at issue 42."}`)
	if code != http.StatusOK || out["type"] != "routine_fire" || out["conversation_id"] != "conv-1" {
		t.Fatalf("fire answered %d %v", code, out)
	}
	mu.Lock()
	call := calls[0]
	mu.Unlock()
	var args []any
	_ = json.Unmarshal(mustJSON(call.Args), &args)
	if call.User.ID != 7 || call.User.AccessToken != tokenOf(7) || len(args) != 3 || args[0] != id || args[1] != "api" || args[2] != "Look at issue 42." {
		t.Fatalf("runner got %+v %v", call.User, args)
	}
	// Deleting the token turns the address off.
	if del := fr.request("r3", webproto.OpRoutineAPIToken, 7, map[string]any{"triggerId": id, "action": "delete"}); del.OK == nil || !*del.OK {
		t.Fatal("delete failed")
	}
	if code, _ := fire(t, h, id, grant.Token, `{}`); code != http.StatusUnauthorized {
		t.Fatalf("deleted token answered %d", code)
	}
}

func TestRoutineFireLimiter(t *testing.T) {
	var l fireLimiter
	now := time.Now()
	for i := 0; i < routineFireLimit; i++ {
		if !l.allow("x", now) {
			t.Fatal("refused under the limit")
		}
	}
	if l.allow("x", now) {
		t.Fatal("allowed over the limit")
	}
	if !l.allow("x", now.Add(routineFireWindow)) {
		t.Fatal("still refused after the window")
	}
}
