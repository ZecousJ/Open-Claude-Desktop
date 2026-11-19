//go:build unit

package usage

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	servermiddleware "github.com/Wei-Shaw/sub2api/internal/server/middleware"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

type fakeSpend struct {
	limits   map[int64]float64
	spent    map[int64]float64
	since    time.Time
	spentErr error
}

func (f *fakeSpend) readSpend(_ context.Context, userID int64, month, _ time.Time, includeUncapped bool) (spendSnapshot, error) {
	var result spendSnapshot
	if limit, ok := f.limits[userID]; ok {
		result.limit = &limit
	}
	if includeUncapped || result.limit != nil {
		f.since = month
		result.spent = f.spent[userID]
		return result, f.spentErr
	}
	return result, nil
}

func (f *fakeSpend) setSpendLimit(_ context.Context, userID int64, limit *float64) error {
	if limit == nil {
		delete(f.limits, userID)
	} else {
		f.limits[userID] = *limit
	}
	return nil
}

func TestSpendLimitRefusesOnceTheMonthReachesIt(t *testing.T) {
	c, _, r := opusSetup(t)
	spend := &fakeSpend{limits: map[int64]float64{12: 50}, spent: map[int64]float64{12: 49.75}}
	c.spend = spend
	require.Equal(t, http.StatusOK, send(r, http.MethodPost, "/v1/chat/completions", "sk-other", `{"model":"gpt-5"}`).Code)
	spend.spent[12] = 50
	rec := send(r, http.MethodPost, "/v1/chat/completions", "sk-other", `{"model":"gpt-5"}`)
	require.Equal(t, http.StatusTooManyRequests, rec.Code)
	require.Contains(t, rec.Body.String(), `"code":"CLAUDEX_SPEND_LIMIT_MONTHLY_EXCEEDED"`)
	require.Contains(t, rec.Body.String(), `"kind":"usage_limit"`)
	require.Contains(t, rec.Body.String(), `"window":"30d"`)
	require.Contains(t, rec.Body.String(), `"resets_at":"2026-10-01T00:00:00Z"`)
	require.Equal(t, time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC), spend.since)
	require.Error(t, c.PrecheckTurn(context.Background(), 12, 0, nil, []string{"gpt-5"}))
	delete(spend.limits, 12)
	require.Equal(t, http.StatusOK, send(r, http.MethodPost, "/v1/chat/completions", "sk-other", `{"model":"gpt-5"}`).Code)
}

func TestSpendLimitRoutes(t *testing.T) {
	c, _, _ := opusSetup(t)
	spend := &fakeSpend{limits: map[int64]float64{}, spent: map[int64]float64{7: 12.345}}
	c.spend = spend
	gin.SetMode(gin.TestMode)
	r := gin.New()
	g := r.Group("/api/v1/claudex", func(ctx *gin.Context) {
		ctx.Set(string(servermiddleware.ContextKeyUser), servermiddleware.AuthSubject{UserID: 7})
	})
	g.GET("/spend-limit", c.getSpendLimit)
	g.PUT("/spend-limit", c.putSpendLimit)
	call := func(method, body string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(method, "/api/v1/claudex/spend-limit", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		r.ServeHTTP(w, req)
		return w
	}
	w := call(http.MethodGet, "")
	require.Equal(t, http.StatusOK, w.Code)
	require.Contains(t, w.Body.String(), `"limit_usd":null`)
	require.Contains(t, w.Body.String(), `"used_usd":12.345`)
	w = call(http.MethodPut, `{"limit_usd":1.005}`)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Equal(t, 1.01, spend.limits[7])
	w = call(http.MethodPut, `{"limit_usd":25.004}`)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), `"limit_usd":25`)
	require.Equal(t, 25.0, spend.limits[7])
	t.Run("invalid updates preserve the limit", func(t *testing.T) {
		for _, body := range []string{`{}`, `{"limit_usd":"25"}`, `{"limit_usd":-1}`, `{"limit_usd":-0.001}`, `{"limit_usd":200000}`} {
			require.Equal(t, http.StatusBadRequest, call(http.MethodPut, body).Code, body)
			require.Equal(t, 25.0, spend.limits[7])
		}
	})
	t.Run("failed spend read preserves the limit", func(t *testing.T) {
		spend.spentErr = errors.New("ledger unavailable")
		defer func() { spend.spentErr = nil }()
		require.Equal(t, http.StatusServiceUnavailable, call(http.MethodPut, `{"limit_usd":35}`).Code)
		require.Equal(t, 25.0, spend.limits[7])
	})
	w = call(http.MethodPut, `{"limit_usd":null}`)
	require.Equal(t, http.StatusOK, w.Code)
	_, set := spend.limits[7]
	require.False(t, set)
	t.Run("unlimited spend read returns the ledger error", func(t *testing.T) {
		spend.spentErr = errors.New("ledger unavailable")
		require.Equal(t, http.StatusServiceUnavailable, call(http.MethodGet, "").Code)
	})
}
