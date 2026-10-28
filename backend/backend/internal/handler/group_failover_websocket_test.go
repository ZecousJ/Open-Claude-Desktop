//go:build unit

// CLAUDEX: Request-scoped group failover with one shared generation budget.
package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/coder/websocket"
	"github.com/stretchr/testify/require"
)

func groupBudgetWSDial(t *testing.T, handler http.Handler) (*websocket.Conn, func()) {
	t.Helper()
	server := httptest.NewServer(handler)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/openai/v1/responses", nil)
	require.NoError(t, err)
	return conn, func() { _ = conn.CloseNow(); server.Close() }
}

func groupBudgetWSTurn(t *testing.T, conn *websocket.Conn) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	require.NoError(t, conn.Write(ctx, websocket.MessageText, []byte(`{"type":"response.create","model":"grok","input":"hello","stream":false}`)))
	_, body, err := conn.Read(ctx)
	require.NoError(t, err)
	return string(body)
}

func TestGroupFailoverWSIdleConnectionGetsFreshTurnBudget(t *testing.T) {
	if testing.Short() {
		t.Skip("checks an actual idle websocket beyond the 60 second generation budget")
	}
	h, repo, upstream, router, cleanup := newGrokCredentialFailoverHandler(t, "revoked")
	defer cleanup()
	h.cfg.Gateway.OpenAIWS.IngressInterTurnIdleTimeoutSeconds = 180
	conn, closeConn := groupBudgetWSDial(t, router)
	defer closeConn()
	require.Contains(t, groupBudgetWSTurn(t, conn), "resp_healthy")
	require.Equal(t, 2, repo.selectorCalls(), "first generation should switch past the revoked account")
	time.Sleep(61 * time.Second)
	require.Contains(t, groupBudgetWSTurn(t, conn), "resp_healthy")
	require.Equal(t, []int64{802, 802}, upstream.accountHits())
}

type groupBudgetWSTransport struct {
	service.HTTPUpstream
	inner     service.HTTPUpstream
	mu        sync.Mutex
	accounts  []int64
	deadlines []time.Time
}

func (u *groupBudgetWSTransport) Do(req *http.Request, proxy string, accountID int64, concurrency int) (*http.Response, error) {
	d, _ := req.Context().Deadline()
	u.mu.Lock()
	u.accounts = append(u.accounts, accountID)
	u.deadlines = append(u.deadlines, d)
	attempt := len(u.accounts)
	u.mu.Unlock()
	delay := 80 * time.Millisecond
	if attempt > 1 {
		delay = time.Second
	}
	select {
	case <-time.After(delay):
	case <-req.Context().Done():
		return nil, req.Context().Err()
	}
	return u.inner.Do(req, proxy, accountID, concurrency)
}

func TestGroupFailoverWSAttemptsShareEarlierCallerDeadline(t *testing.T) {
	transport := &groupBudgetWSTransport{}
	_, _, upstream, router, cleanup := newGrokCredentialFailoverHandler(t, "first_429", transport)
	defer cleanup()
	transport.inner = upstream
	serverHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 250*time.Millisecond)
		defer cancel()
		router.ServeHTTP(w, r.WithContext(ctx))
	})
	conn, closeConn := groupBudgetWSDial(t, serverHandler)
	defer closeConn()
	started := time.Now()
	require.Contains(t, groupBudgetWSTurn(t, conn), "request_timeout")
	require.Less(t, time.Since(started), 800*time.Millisecond)
	transport.mu.Lock()
	defer transport.mu.Unlock()
	require.Equal(t, []int64{801, 802}, transport.accounts)
	require.Len(t, transport.deadlines, 2)
	require.False(t, transport.deadlines[0].IsZero())
	require.Equal(t, transport.deadlines[0], transport.deadlines[1], "switching accounts must not refresh the turn deadline")
}
