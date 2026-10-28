//go:build unit

package usage

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	claudexhook "github.com/Wei-Shaw/sub2api/internal/claudex/hook"
	"github.com/Wei-Shaw/sub2api/internal/pkg/ctxkey"
	servermiddleware "github.com/Wei-Shaw/sub2api/internal/server/middleware"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

type fakeProducts struct{ rows []productDay }

func (f *fakeProducts) addProductUsage(_ context.Context, userID int64, day time.Time, product string, cost float64) error {
	f.rows = append(f.rows, productDay{Day: time.Date(day.Year(), day.Month(), day.Day(), 0, 0, 0, 0, time.UTC), Product: product, CostUSD: cost, Requests: 1})
	return nil
}

func (f *fakeProducts) productUsage(_ context.Context, userID int64, from, to time.Time) ([]productDay, error) {
	var out []productDay
	for _, r := range f.rows {
		if !r.Day.Before(from) && r.Day.Before(to) {
			out = append(out, r)
		}
	}
	return out, nil
}

func TestUsageIsCountedUnderTheRequestsProduct(t *testing.T) {
	c, _, r := opusSetup(t)
	store := &fakeProducts{}
	c.productsStore = store
	// The precheck notes the product under the request's billing id.
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	g, _ := gin.CreateTestContext(w)
	req := httptest.NewRequest(http.MethodPost, "/v1/responses", nil)
	req.Header.Set(ProductHeader, "cowork")
	g.Request = req.WithContext(context.WithValue(req.Context(), ctxkey.ClientRequestID, "abc"))
	c.noteProduct(g)
	c.OnUsageApplied(context.Background(), claudexhook.UsageEvent{RequestID: "client:abc", UserID: 11, CostUSD: 0.5, At: guardNow})
	// Unknown requests count as other; the note is used once.
	c.OnUsageApplied(context.Background(), claudexhook.UsageEvent{RequestID: "client:abc", UserID: 11, CostUSD: 0.25, At: guardNow})
	require.Len(t, store.rows, 2)
	require.Equal(t, "cowork", store.rows[0].Product)
	require.Equal(t, "other", store.rows[1].Product)
	_ = r

	router := gin.New()
	group := router.Group("/api/v1/claudex", func(ctx *gin.Context) {
		ctx.Set(string(servermiddleware.ContextKeyUser), servermiddleware.AuthSubject{UserID: 11})
	})
	group.GET("/usage-products", c.getUsageProducts)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/claudex/usage-products?days=7", nil))
	require.Equal(t, http.StatusOK, rec.Code)
	var body struct {
		Data productRangeDTO `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Equal(t, 0.5, body.Data.Totals["cowork"])
	require.Equal(t, 0.25, body.Data.Totals["other"])
	require.Len(t, body.Data.Days, 7)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/claudex/usage-products?days=99", nil))
	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestProductRanges(t *testing.T) {
	now := time.Date(2026, 10, 16, 12, 0, 0, 0, time.UTC)
	from, to, ok := productRange("month", now)
	require.True(t, ok)
	require.Equal(t, time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC), from)
	require.Equal(t, time.Date(2026, 10, 17, 0, 0, 0, 0, time.UTC), to)
	from, to, _ = productRange("yesterday", now)
	require.Equal(t, time.Date(2026, 10, 16, 0, 0, 0, 0, time.UTC), to)
	require.Equal(t, 30, int(to.Sub(from).Hours()/24))
}
