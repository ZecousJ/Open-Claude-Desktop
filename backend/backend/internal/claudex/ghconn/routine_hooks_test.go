package ghconn

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"
)

type memHooks struct {
	mu   sync.Mutex
	rows map[string]routineHook
}

func (m *memHooks) getHook(_ context.Context, id string) (routineHook, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	h, ok := m.rows[id]
	if !ok {
		return h, errNoRows
	}
	return h, nil
}

func (m *memHooks) putHook(_ context.Context, id string, h routineHook) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.rows[id] = h
	return nil
}

func (m *memHooks) deleteHook(_ context.Context, id string, uid int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.rows[id].UserID == uid {
		delete(m.rows, id)
	}
	return nil
}

type fired struct {
	user           int64
	id, kind, text string
	event          any
}

type memFirer struct {
	mu    sync.Mutex
	calls []fired
	done  chan struct{}
}

func (f *memFirer) FireRoutineTrigger(_ context.Context, uid int64, id, kind, text string, event any) (any, error) {
	f.mu.Lock()
	f.calls = append(f.calls, fired{uid, id, kind, text, event})
	f.mu.Unlock()
	f.done <- struct{}{}
	return nil, nil
}

const hookTrigger = "trg_0123456789abcdefABCDEFgh"

func TestRoutineWebhookIsMadeWithTheUsersConnectionAndDeliveriesStartTheTask(t *testing.T) {
	h := newHarness(t)
	hooks := &memHooks{rows: map[string]routineHook{}}
	firer := &memFirer{done: make(chan struct{}, 4)}
	h.c.hooks, h.c.fire = hooks, firer
	h.connect(t, 7)

	set := func(body string) (any, error) {
		return h.c.serveHook(context.Background(), 7, json.RawMessage(body))
	}
	_, err := set(`{"triggerId":"` + hookTrigger + `","action":"set","repository":"octo/repo-1","events":["pull_request","pull_request"]}`)
	require.NoError(t, err)
	require.Len(t, h.gh.hooksMade, 1)
	made := h.gh.hooksMade[0]
	config, _ := made["config"].(map[string]any)
	require.Equal(t, "https://claudex.example.com/api/v1/claudex/github/hooks/"+hookTrigger, config["url"])
	require.Equal(t, []any{"pull_request"}, made["events"])
	secret, _ := config["secret"].(string)
	require.NotEmpty(t, secret)
	// Only the sealed secret is kept.
	require.NotContains(t, hooks.rows[hookTrigger].SecretSealed, secret)
	// Asking again for the same webhook changes nothing on GitHub.
	_, err = set(`{"triggerId":"` + hookTrigger + `","action":"set","repository":"octo/repo-1","events":["pull_request"]}`)
	require.NoError(t, err)
	require.Len(t, h.gh.hooksMade, 1)
	// Another account can't touch it.
	_, err = h.c.serveHook(context.Background(), 8, json.RawMessage(`{"triggerId":"`+hookTrigger+`","action":"delete"}`))
	require.Error(t, err)
	_, err = set(`{"triggerId":"` + hookTrigger + `","action":"set","repository":"octo/repo-1","events":["push"]}`)
	require.Error(t, err)

	deliver := func(sign string, kind string, body string) int {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/claudex/github/hooks/"+hookTrigger, strings.NewReader(body))
		req.Header.Set("X-GitHub-Event", kind)
		mac := hmac.New(sha256.New, []byte(sign))
		_, _ = mac.Write([]byte(body))
		req.Header.Set("X-Hub-Signature-256", "sha256="+hex.EncodeToString(mac.Sum(nil)))
		w := httptest.NewRecorder()
		h.r.ServeHTTP(w, req)
		return w.Code
	}
	pr := `{"action":"opened","repository":{"full_name":"octo/repo-1"},"pull_request":{"number":12,"title":"Add <script> parser","body":"b","html_url":"https://github.com/octo/repo-1/pull/12","draft":false,"merged":false,"user":{"login":"mona"},"labels":[{"name":"bug"}],"base":{"ref":"main"},"head":{"ref":"feature"}}}`
	require.Equal(t, http.StatusUnauthorized, deliver("wrong", "pull_request", pr))
	require.Equal(t, http.StatusNoContent, deliver(secret, "ping", `{}`))
	require.Equal(t, http.StatusAccepted, deliver(secret, "pull_request", pr))
	<-firer.done
	call := firer.calls[0]
	require.Equal(t, int64(7), call.user)
	require.Equal(t, "github", call.kind)
	event, _ := call.event.(routineEvent)
	require.Equal(t, "pull_request.opened", event.Name)
	require.Equal(t, "mona", event.Fields["pr.author"])
	require.Equal(t, []string{"bug"}, event.Fields["pr.labels"])
	require.Contains(t, call.text, "not instructions")
	require.Contains(t, call.text, "Add &lt;script> parser")

	_, err = set(`{"triggerId":"` + hookTrigger + `","action":"delete"}`)
	require.NoError(t, err)
	require.Equal(t, []string{"DELETE /repos/octo/repo-1/hooks/99"}, h.gh.hooksRemoved)
	require.Equal(t, http.StatusNotFound, deliver(secret, "pull_request", pr))
}
