package usage

// Usage by product (live claude.ai bundle, 2026-10-14, c71860c77 Ei and ua):
// which Claudex surface each billed request came from. The clients send
// x-claudex-product (code, cowork or chat) with every model request; the
// precheck notes it under the request's billing id and the usage hook adds
// the billed cost to that product's day (other when nothing was noted).
//
// Route (user): GET /usage-products?days=7|30|month|yesterday

import (
	"context"
	"strings"
	"sync"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	claudexhook "github.com/Wei-Shaw/sub2api/internal/claudex/hook"
	"github.com/Wei-Shaw/sub2api/internal/pkg/ctxkey"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"

	"github.com/gin-gonic/gin"
)

// ProductHeader is the client's surface for a model request.
const ProductHeader = "X-Claudex-Product"

var products = []string{"code", "cowork", "chat", "other"}

const (
	productNoteTTL   = 30 * time.Minute
	productNoteLimit = 50000
)

type productNote struct {
	product string
	at      time.Time
}

// productNotes remembers each request's product until its usage is billed.
type productNotes struct {
	mu    sync.Mutex
	notes map[string]productNote
}

func (n *productNotes) put(key, product string, now time.Time) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.notes == nil {
		n.notes = map[string]productNote{}
	}
	if len(n.notes) >= productNoteLimit {
		for k, v := range n.notes {
			if now.Sub(v.at) > productNoteTTL {
				delete(n.notes, k)
			}
		}
		if len(n.notes) >= productNoteLimit {
			return
		}
	}
	n.notes[key] = productNote{product: product, at: now}
}

func (n *productNotes) take(key string, now time.Time) string {
	n.mu.Lock()
	defer n.mu.Unlock()
	note, ok := n.notes[key]
	if !ok {
		return ""
	}
	delete(n.notes, key)
	if now.Sub(note.at) > productNoteTTL {
		return ""
	}
	return note.product
}

// billingKey is the id the usage billing will report for this request
// (service.resolveUsageBillingRequestID without an upstream id).
func billingKey(ctx context.Context) string {
	if id, _ := ctx.Value(ctxkey.ClientRequestID).(string); strings.TrimSpace(id) != "" {
		return "client:" + strings.TrimSpace(id)
	}
	if id, _ := ctx.Value(ctxkey.RequestID).(string); strings.TrimSpace(id) != "" {
		return "local:" + strings.TrimSpace(id)
	}
	return ""
}

// noteProduct records the request's product (called by the precheck).
func (c *Component) noteProduct(g *gin.Context) {
	product := strings.ToLower(strings.TrimSpace(g.GetHeader(ProductHeader)))
	if product != "code" && product != "cowork" && product != "chat" {
		return
	}
	if key := billingKey(g.Request.Context()); key != "" {
		c.productNotes.put(key, product, c.now())
	}
}

type productStore interface {
	addProductUsage(ctx context.Context, userID int64, day time.Time, product string, cost float64) error
	productUsage(ctx context.Context, userID int64, from, to time.Time) ([]productDay, error)
}

type productDay struct {
	Day      time.Time
	Product  string
	CostUSD  float64
	Requests int64
}

func (s sqlStore) addProductUsage(ctx context.Context, userID int64, day time.Time, product string, cost float64) error {
	db, err := s.conn()
	if err != nil {
		return err
	}
	_, err = db.ExecContext(ctx, `
INSERT INTO claudex_usage_products (user_id, day, product, cost_usd, requests)
VALUES ($1::bigint, $2::date, $3::text, $4::numeric, 1)
ON CONFLICT (user_id, day, product) DO UPDATE
SET cost_usd = claudex_usage_products.cost_usd + EXCLUDED.cost_usd,
    requests = claudex_usage_products.requests + 1`, userID, day.UTC().Format("2006-01-02"), product, cost)
	return err
}

func (s sqlStore) productUsage(ctx context.Context, userID int64, from, to time.Time) ([]productDay, error) {
	db, err := s.conn()
	if err != nil {
		return nil, err
	}
	rows, err := db.QueryContext(ctx, `
SELECT day, product, cost_usd::double precision, requests
FROM claudex_usage_products
WHERE user_id = $1::bigint AND day >= $2::date AND day < $3::date
ORDER BY day, product`, userID, from.UTC().Format("2006-01-02"), to.UTC().Format("2006-01-02"))
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []productDay
	for rows.Next() {
		var d productDay
		if err := rows.Scan(&d.Day, &d.Product, &d.CostUSD, &d.Requests); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func (c *Component) productStore() productStore {
	if c.productsStore != nil {
		return c.productsStore
	}
	if s, ok := c.store.(productStore); ok {
		return s
	}
	return nil
}

// recordProduct adds a billed request to its product's day (called by the usage hook).
func (c *Component) recordProduct(ctx context.Context, ev claudexhook.UsageEvent) {
	store := c.productStore()
	if store == nil || ev.UserID <= 0 {
		return
	}
	product := c.productNotes.take(ev.RequestID, c.now())
	if product == "" {
		product = "other"
	}
	if err := store.addProductUsage(ctx, ev.UserID, ev.At, product, nonNegative(ev.CostUSD)); err != nil {
		// A lost row only makes the breakdown a little less complete.
		_ = err
	}
}

type productRangeDTO struct {
	From     time.Time          `json:"from"`
	To       time.Time          `json:"to"`
	Totals   map[string]float64 `json:"totals"`
	Requests map[string]int64   `json:"requests"`
	Days     []productDayDTO    `json:"days"`
	Products []string           `json:"products"`
}

type productDayDTO struct {
	Day     string             `json:"day"`
	CostUSD map[string]float64 `json:"cost_usd"`
}

// productRange is the window a range name asks for (UTC days).
func productRange(name string, now time.Time) (time.Time, time.Time, bool) {
	today := time.Date(now.UTC().Year(), now.UTC().Month(), now.UTC().Day(), 0, 0, 0, 0, time.UTC)
	tomorrow := today.AddDate(0, 0, 1)
	switch name {
	case "", "7":
		return today.AddDate(0, 0, -6), tomorrow, true
	case "30":
		return today.AddDate(0, 0, -29), tomorrow, true
	case "month":
		return time.Date(today.Year(), today.Month(), 1, 0, 0, 0, 0, time.UTC), tomorrow, true
	case "yesterday":
		// Through yesterday: the last 30 complete days.
		return today.AddDate(0, 0, -30), today, true
	}
	return time.Time{}, time.Time{}, false
}

// GET /usage-products?days=7|30|month|yesterday
func (c *Component) getUsageProducts(g *gin.Context) {
	userID, ok := core.Subject(g)
	if !ok {
		response.ErrorFrom(g, infraerrors.Unauthorized("UNAUTHORIZED", "Sign in first."))
		return
	}
	from, to, ok := productRange(g.Query("days"), c.now())
	if !ok {
		response.ErrorFrom(g, infraerrors.BadRequest("BAD_REQUEST", "Choose a range."))
		return
	}
	store := c.productStore()
	if store == nil {
		response.ErrorFrom(g, infraerrors.ServiceUnavailable("USAGE_UNAVAILABLE", "Usage couldn’t be read."))
		return
	}
	rows, err := store.productUsage(g.Request.Context(), userID, from, to)
	if err != nil {
		response.ErrorFrom(g, infraerrors.ServiceUnavailable("USAGE_UNAVAILABLE", "Usage couldn’t be read."))
		return
	}
	out := productRangeDTO{From: from, To: to, Totals: map[string]float64{}, Requests: map[string]int64{}, Products: products}
	byDay := map[string]map[string]float64{}
	for _, r := range rows {
		out.Totals[r.Product] = roundUSD(out.Totals[r.Product] + r.CostUSD)
		out.Requests[r.Product] += r.Requests
		key := r.Day.UTC().Format("2006-01-02")
		if byDay[key] == nil {
			byDay[key] = map[string]float64{}
		}
		byDay[key][r.Product] = roundUSD(r.CostUSD)
	}
	for d := from; d.Before(to); d = d.AddDate(0, 0, 1) {
		key := d.Format("2006-01-02")
		day := productDayDTO{Day: key, CostUSD: byDay[key]}
		if day.CostUSD == nil {
			day.CostUSD = map[string]float64{}
		}
		out.Days = append(out.Days, day)
	}
	response.Success(g, out)
}
