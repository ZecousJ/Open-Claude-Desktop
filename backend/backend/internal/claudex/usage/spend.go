package usage

// The person's own monthly spend limit (live claude.ai bundle, 2026-10-14,
// c71860c77 Xr and c1f35d5b3: "Monthly spend limit", "Set monthly spend
// limit"). The month is the calendar month in UTC; the spend is the sum of
// the person's billed usage (usage_logs.actual_cost) since it began. Once it
// reaches the limit the gateway refuses with a monthly usage limit until the
// next month, or until the person raises or removes the limit.
//
// Routes (user): GET /spend-limit, PUT /spend-limit {"limit_usd": number|null}

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/gatewayhook"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"

	"github.com/gin-gonic/gin"
	"github.com/shopspring/decimal"
)

// CodeSpendLimitExceeded is the refusal code once the month's spend reaches the limit.
const CodeSpendLimitExceeded = "CLAUDEX_SPEND_LIMIT_MONTHLY_EXCEEDED"

// The largest limit a person can set (USD).
const maxSpendLimit = 100000

type spendStore interface {
	readSpend(ctx context.Context, userID int64, month, resetsAt time.Time, includeUncapped bool) (spendSnapshot, error)
	setSpendLimit(ctx context.Context, userID int64, limit *float64) error
}

type spendSnapshot struct {
	limit *float64
	spent float64
}

func (s sqlStore) readSpend(ctx context.Context, userID int64, month, resetsAt time.Time, includeUncapped bool) (spendSnapshot, error) {
	db, err := s.conn()
	if err != nil {
		return spendSnapshot{}, err
	}
	var result spendSnapshot
	err = db.QueryRowContext(ctx, `
SELECT cap.limit_usd::double precision,
       CASE WHEN $4::boolean OR cap.limit_usd IS NOT NULL THEN (
           SELECT COALESCE(SUM(actual_cost), 0)::double precision
           FROM usage_logs
           WHERE user_id = $1::bigint AND created_at >= $2::timestamptz AND created_at < $3::timestamptz
       ) ELSE 0 END
FROM (VALUES ($1::bigint)) AS account(user_id)
LEFT JOIN claudex_spend_limits AS cap ON cap.user_id = account.user_id`,
		userID, month, resetsAt, includeUncapped).Scan(&result.limit, &result.spent)
	return result, err
}

func (s sqlStore) setSpendLimit(ctx context.Context, userID int64, limit *float64) error {
	db, err := s.conn()
	if err != nil {
		return err
	}
	if limit == nil {
		_, err = db.ExecContext(ctx, `DELETE FROM claudex_spend_limits WHERE user_id = $1::bigint`, userID)
		return err
	}
	_, err = db.ExecContext(ctx, `
INSERT INTO claudex_spend_limits (user_id, limit_usd, updated_at)
VALUES ($1::bigint, $2::numeric, NOW())
ON CONFLICT (user_id) DO UPDATE SET limit_usd = EXCLUDED.limit_usd, updated_at = NOW()`, userID, *limit)
	return err
}

func spendMonth(t time.Time) (time.Time, time.Time) {
	u := t.UTC()
	start := time.Date(u.Year(), u.Month(), 1, 0, 0, 0, 0, time.UTC)
	return start, start.AddDate(0, 1, 0)
}

func (c *Component) spendStore() spendStore {
	if c.spend != nil {
		return c.spend
	}
	if s, ok := c.store.(spendStore); ok {
		return s
	}
	return nil
}

// spendRefusal is the refusal for a person past their limit, nil otherwise
// (or when the limit can't be read: the balance still bounds the spend).
func (c *Component) spendRefusal(ctx context.Context, userID int64) *gatewayhook.RefusalDetail {
	if userID <= 0 {
		return nil
	}
	store := c.spendStore()
	if store == nil {
		return nil
	}
	now := c.now()
	start, resets := spendMonth(now)
	snapshot, err := store.readSpend(ctx, userID, start, resets, false)
	if err != nil || snapshot.limit == nil || snapshot.spent < *snapshot.limit {
		return nil
	}
	return &gatewayhook.RefusalDetail{
		V:                 1,
		Reason:            CodeSpendLimitExceeded,
		Kind:              "usage_limit",
		Window:            "30d",
		ResetsAt:          &resets,
		RetryAfterSeconds: retryAfter(now, resets),
		LimitUSD:          snapshot.limit,
		UsedUSD:           &snapshot.spent,
		Action:            "wait",
		Message:           "You’ve reached your monthly spend limit. Requests resume next month, or raise the limit in Settings → Billing.",
	}
}

func (c *Component) refuseSpend(g *gin.Context, detail *gatewayhook.RefusalDetail) {
	gatewayhook.SetDetail(g, detail)
	g.Header("Retry-After", strconv.Itoa(detail.RetryAfterSeconds))
	g.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{
		"code":    CodeSpendLimitExceeded,
		"message": detail.Message,
		"claudex": detail,
	})
}

type spendLimitDTO struct {
	LimitUSD *float64  `json:"limit_usd"`
	UsedUSD  float64   `json:"used_usd"`
	ResetsAt time.Time `json:"resets_at"`
	Currency string    `json:"currency"`
}

func (s spendSnapshot) dto(resets time.Time) spendLimitDTO {
	return spendLimitDTO{LimitUSD: s.limit, UsedUSD: s.spent, ResetsAt: resets, Currency: "USD"}
}

// GET /spend-limit
func (c *Component) getSpendLimit(g *gin.Context) {
	userID, ok := core.Subject(g)
	if !ok {
		response.ErrorFrom(g, infraerrors.Unauthorized("UNAUTHORIZED", "Sign in first."))
		return
	}
	store := c.spendStore()
	if store == nil {
		response.ErrorFrom(g, infraerrors.ServiceUnavailable("SPEND_LIMIT_UNAVAILABLE", "The spend limit couldn’t be read."))
		return
	}
	start, resets := spendMonth(c.now())
	snapshot, err := store.readSpend(g.Request.Context(), userID, start, resets, true)
	if err != nil {
		response.ErrorFrom(g, infraerrors.ServiceUnavailable("SPEND_LIMIT_UNAVAILABLE", "The spend limit couldn’t be read."))
		return
	}
	response.Success(g, snapshot.dto(resets))
}

// PUT /spend-limit {"limit_usd": number|null}
func (c *Component) putSpendLimit(g *gin.Context) {
	userID, ok := core.Subject(g)
	if !ok {
		response.ErrorFrom(g, infraerrors.Unauthorized("UNAUTHORIZED", "Sign in first."))
		return
	}
	var in struct {
		LimitUSD json.RawMessage `json:"limit_usd"`
	}
	if err := g.ShouldBindJSON(&in); err != nil {
		response.ErrorFrom(g, infraerrors.BadRequest("BAD_REQUEST", "The request could not be read."))
		return
	}
	var limit *float64
	if len(in.LimitUSD) == 0 || json.Unmarshal(in.LimitUSD, &limit) != nil {
		response.ErrorFrom(g, infraerrors.BadRequest("BAD_REQUEST", "Provide limit_usd as a number or null."))
		return
	}
	if limit != nil && (*limit < 0 || *limit > maxSpendLimit) {
		response.ErrorFrom(g, infraerrors.BadRequest("SPEND_LIMIT_INVALID", "Enter an amount like 20 or 20.50"))
		return
	}
	if limit != nil {
		*limit, _ = decimal.NewFromFloat(*limit).Round(2).Float64()
	}
	store := c.spendStore()
	if store == nil {
		response.ErrorFrom(g, infraerrors.ServiceUnavailable("SPEND_LIMIT_UNAVAILABLE", "The spend limit couldn’t be saved."))
		return
	}
	ctx := g.Request.Context()
	start, resets := spendMonth(c.now())
	snapshot, err := store.readSpend(ctx, userID, start, resets, true)
	if err != nil {
		response.ErrorFrom(g, infraerrors.ServiceUnavailable("SPEND_LIMIT_UNAVAILABLE", "The spend limit couldn’t be read."))
		return
	}
	if err := store.setSpendLimit(ctx, userID, limit); err != nil {
		response.ErrorFrom(g, infraerrors.ServiceUnavailable("SPEND_LIMIT_UNAVAILABLE", "The spend limit couldn’t be saved."))
		return
	}
	snapshot.limit = limit
	response.Success(g, snapshot.dto(resets))
}
