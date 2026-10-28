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
	"database/sql"
	"errors"
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/gatewayhook"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"

	"github.com/gin-gonic/gin"
)

// CodeSpendLimitExceeded is the refusal code once the month's spend reaches the limit.
const CodeSpendLimitExceeded = "CLAUDEX_SPEND_LIMIT_MONTHLY_EXCEEDED"

// The largest limit a person can set (USD).
const maxSpendLimit = 100000

// How long a person's limit and spend are trusted before reading them again.
const spendCacheTTL = 30 * time.Second

type spendStore interface {
	spendLimit(ctx context.Context, userID int64) (*float64, error)
	setSpendLimit(ctx context.Context, userID int64, limit *float64) error
	spentSince(ctx context.Context, userID int64, since time.Time) (float64, error)
}

func (s sqlStore) spendLimit(ctx context.Context, userID int64) (*float64, error) {
	db, err := s.conn()
	if err != nil {
		return nil, err
	}
	var limit float64
	err = db.QueryRowContext(ctx, `SELECT limit_usd::double precision FROM claudex_spend_limits WHERE user_id = $1::bigint`, userID).Scan(&limit)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &limit, nil
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

func (s sqlStore) spentSince(ctx context.Context, userID int64, since time.Time) (float64, error) {
	db, err := s.conn()
	if err != nil {
		return 0, err
	}
	var spent float64
	err = db.QueryRowContext(ctx, `
SELECT COALESCE(SUM(actual_cost), 0)::double precision
FROM usage_logs
WHERE user_id = $1::bigint AND created_at >= $2::timestamptz`, userID, since.UTC()).Scan(&spent)
	return spent, err
}

// monthStart and monthEnd bound the calendar month (UTC) of t.
func monthStart(t time.Time) time.Time {
	u := t.UTC()
	return time.Date(u.Year(), u.Month(), 1, 0, 0, 0, 0, time.UTC)
}

func monthEnd(t time.Time) time.Time { return monthStart(t).AddDate(0, 1, 0) }

type spendEntry struct {
	limit *float64
	spent float64
	month time.Time
	at    time.Time
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

// spendState is a person's limit and this month's spend (cached).
func (c *Component) spendState(ctx context.Context, userID int64, fresh bool) (spendEntry, error) {
	now := c.now()
	month := monthStart(now)
	c.spendMu.Lock()
	if c.spendEntries == nil {
		c.spendEntries = map[int64]spendEntry{}
	}
	cached, ok := c.spendEntries[userID]
	c.spendMu.Unlock()
	if ok && !fresh && cached.month.Equal(month) && now.Sub(cached.at) < spendCacheTTL {
		return cached, nil
	}
	store := c.spendStore()
	if store == nil {
		return spendEntry{}, errNoDB
	}
	limit, err := store.spendLimit(ctx, userID)
	if err != nil {
		return spendEntry{}, err
	}
	entry := spendEntry{limit: limit, month: month, at: now}
	if limit != nil {
		if entry.spent, err = store.spentSince(ctx, userID, month); err != nil {
			return spendEntry{}, err
		}
	}
	c.spendMu.Lock()
	c.spendEntries[userID] = entry
	c.spendMu.Unlock()
	return entry, nil
}

// spendRefusal is the refusal for a person past their limit, nil otherwise
// (or when the limit can't be read: the balance still bounds the spend).
func (c *Component) spendRefusal(ctx context.Context, userID int64) *gatewayhook.RefusalDetail {
	if userID <= 0 {
		return nil
	}
	entry, err := c.spendState(ctx, userID, false)
	if err != nil || entry.limit == nil || entry.spent < *entry.limit {
		return nil
	}
	resets := monthEnd(c.now())
	limit, used := roundUSD(*entry.limit), roundUSD(entry.spent)
	return &gatewayhook.RefusalDetail{
		V:                 1,
		Reason:            CodeSpendLimitExceeded,
		Kind:              "usage_limit",
		Window:            "30d",
		ResetsAt:          &resets,
		RetryAfterSeconds: retryAfter(c.now(), resets),
		LimitUSD:          &limit,
		UsedUSD:           &used,
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

func (c *Component) spendDTO(ctx context.Context, userID int64) (spendLimitDTO, error) {
	entry, err := c.spendState(ctx, userID, true)
	if err != nil {
		return spendLimitDTO{}, err
	}
	used := entry.spent
	if entry.limit == nil {
		// The month's spend shows even without a limit.
		if store := c.spendStore(); store != nil {
			if spent, err := store.spentSince(ctx, userID, monthStart(c.now())); err == nil {
				used = spent
			}
		}
	}
	return spendLimitDTO{LimitUSD: entry.limit, UsedUSD: roundUSD(used), ResetsAt: monthEnd(c.now()), Currency: "USD"}, nil
}

// GET /spend-limit
func (c *Component) getSpendLimit(g *gin.Context) {
	userID, ok := core.Subject(g)
	if !ok {
		response.ErrorFrom(g, infraerrors.Unauthorized("UNAUTHORIZED", "Sign in first."))
		return
	}
	dto, err := c.spendDTO(g.Request.Context(), userID)
	if err != nil {
		response.ErrorFrom(g, infraerrors.ServiceUnavailable("SPEND_LIMIT_UNAVAILABLE", "The spend limit couldn’t be read."))
		return
	}
	response.Success(g, dto)
}

// PUT /spend-limit {"limit_usd": number|null}
func (c *Component) putSpendLimit(g *gin.Context) {
	userID, ok := core.Subject(g)
	if !ok {
		response.ErrorFrom(g, infraerrors.Unauthorized("UNAUTHORIZED", "Sign in first."))
		return
	}
	var in struct {
		LimitUSD *float64 `json:"limit_usd"`
	}
	if err := g.ShouldBindJSON(&in); err != nil {
		response.ErrorFrom(g, infraerrors.BadRequest("BAD_REQUEST", "The request could not be read."))
		return
	}
	if in.LimitUSD != nil {
		v := math.Round(*in.LimitUSD*100) / 100
		if math.IsNaN(v) || v < 0 || v > maxSpendLimit {
			response.ErrorFrom(g, infraerrors.BadRequest("SPEND_LIMIT_INVALID", "Enter an amount like 20 or 20.50"))
			return
		}
		in.LimitUSD = &v
	}
	store := c.spendStore()
	if store == nil {
		response.ErrorFrom(g, infraerrors.ServiceUnavailable("SPEND_LIMIT_UNAVAILABLE", "The spend limit couldn’t be saved."))
		return
	}
	ctx := g.Request.Context()
	if err := store.setSpendLimit(ctx, userID, in.LimitUSD); err != nil {
		response.ErrorFrom(g, infraerrors.ServiceUnavailable("SPEND_LIMIT_UNAVAILABLE", "The spend limit couldn’t be saved."))
		return
	}
	dto, err := c.spendDTO(ctx, userID)
	if err != nil {
		response.ErrorFrom(g, infraerrors.ServiceUnavailable("SPEND_LIMIT_UNAVAILABLE", "The spend limit couldn’t be read."))
		return
	}
	response.Success(g, dto)
}
