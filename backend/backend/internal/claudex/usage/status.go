package usage

import (
	"context"
	"errors"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
)

// Status is the body of GET /api/v1/claudex/usage-status (design 2.6).
type Status struct {
	Plan      StatusPlan     `json:"plan"`
	Windows   []StatusWindow `json:"windows"`
	Balance   *StatusBalance `json:"balance"`
	Blocked   StatusBlocked  `json:"blocked"`
	UpdatedAt time.Time      `json:"updated_at"`
}

// StatusPlan identifies the plan group the windows belong to.
type StatusPlan struct {
	GroupID        int64  `json:"group_id"`
	GroupName      string `json:"group_name"`
	SubscriptionID *int64 `json:"subscription_id"`
	BillingMode    string `json:"billing_mode"` // subscription | balance
}

// StatusWindow is one usage window: a rule, a subscription window or a
// window of this device's key.
type StatusWindow struct {
	ID            string     `json:"id"`
	Source        string     `json:"source"` // rule | subscription | key
	Kind          string     `json:"kind"`   // session | all_models | models | daily | monthly | key
	Label         string     `json:"label"`
	Window        string     `json:"window"`
	WindowSeconds int        `json:"window_seconds"`
	UsedUSD       float64    `json:"used_usd"`
	LimitUSD      float64    `json:"limit_usd"`
	Percent       int        `json:"percent"`
	Active        bool       `json:"active"`
	WindowStart   *time.Time `json:"window_start"`
	ResetsAt      *time.Time `json:"resets_at"`
	Models        []string   `json:"models"`
	Exceeded      bool       `json:"exceeded"`

	reason string // blocked.reason when this window blocks
}

// StatusBalance is the user's balance.
type StatusBalance struct {
	BalanceUSD float64 `json:"balance_usd"`
}

// StatusBlocked names the exceeded window that resets last.
type StatusBlocked struct {
	Blocked  bool       `json:"blocked"`
	WindowID *string    `json:"window_id"`
	Reason   *string    `json:"reason"`
	ResetsAt *time.Time `json:"resets_at"`
}

// Subscription and key windows (design 2.6).
const (
	subscriptionDaySeconds   = 86400
	subscriptionWeekSeconds  = 7 * 86400
	subscriptionMonthSeconds = 30 * 86400
)

// statusSources are the upstream reads behind usage-status (replaceable in
// tests).
type statusSources struct {
	subscriptionProgress func(ctx context.Context, subscriptionID int64) (*service.SubscriptionProgress, error)
	group                func(ctx context.Context, groupID int64) (*service.Group, error)
	apiKey               func(ctx context.Context, id int64) (*service.APIKey, error)
	rateLimitData        func(ctx context.Context, id int64) (*service.APIKeyRateLimitData, error)
	user                 func(ctx context.Context, id int64) (*service.User, error)
}

var errUnavailable = errors.New("claudex usage: dependency unavailable")

func sourcesFrom(env *core.Env) statusSources {
	return statusSources{
		subscriptionProgress: func(ctx context.Context, id int64) (*service.SubscriptionProgress, error) {
			if env == nil || env.Subscriptions == nil {
				return nil, errUnavailable
			}
			return env.Subscriptions.GetSubscriptionProgress(ctx, id)
		},
		group: func(ctx context.Context, id int64) (*service.Group, error) {
			if env == nil || env.GroupRepo == nil {
				return nil, errUnavailable
			}
			return env.GroupRepo.GetByIDLite(ctx, id)
		},
		apiKey: func(ctx context.Context, id int64) (*service.APIKey, error) {
			if env == nil || env.APIKeys == nil {
				return nil, errUnavailable
			}
			return env.APIKeys.GetByID(ctx, id)
		},
		rateLimitData: func(ctx context.Context, id int64) (*service.APIKeyRateLimitData, error) {
			if env == nil || env.APIKeys == nil {
				return nil, errUnavailable
			}
			return env.APIKeys.GetRateLimitData(ctx, id)
		},
		user: func(ctx context.Context, id int64) (*service.User, error) {
			if env == nil || env.UserRepo == nil {
				return nil, errUnavailable
			}
			return env.UserRepo.GetByID(ctx, id)
		},
	}
}

// userStatus answers GET /api/v1/claudex/usage-status?group_id=.
func (c *Component) userStatus(g *gin.Context) {
	g.Header("Cache-Control", "no-store")
	userID, ok := core.Subject(g)
	if !ok {
		response.ErrorFrom(g, errNotSignedIn)
		return
	}
	_, _, _, deviceID := core.ClientInfo(g)
	st, err := c.status(g.Request.Context(), userID, queryGroupID(g), deviceID)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	response.Success(g, st)
}

// queryGroupID reads ?group_id=; a missing or malformed value means "the
// plan group" (the resolver ignores groups the user may not use).
func queryGroupID(g *gin.Context) *int64 {
	raw := strings.TrimSpace(g.Query("group_id"))
	if raw == "" {
		return nil
	}
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || id <= 0 {
		return nil
	}
	return &id
}

// status builds the usage status of a user for the plan group resolved from
// requested (design 2.6: session rules, subscription weekly, all-models
// rules, per-model rules by sort order, subscription daily and monthly, then
// the windows of this device's key).
func (c *Component) status(ctx context.Context, userID int64, requested *int64, deviceID string) (*Status, error) {
	if c.env == nil || c.env.Peers.Plans == nil {
		return nil, core.ErrNoPlan
	}
	plan, err := c.env.Peers.Plans.ResolvePlan(ctx, userID, requested)
	if err != nil {
		return nil, err
	}
	if plan == nil {
		return nil, core.ErrNoPlan
	}
	now := c.now().UTC()
	st := &Status{
		Plan: StatusPlan{
			GroupID:        plan.GroupID,
			GroupName:      plan.GroupName,
			SubscriptionID: plan.SubscriptionID,
			BillingMode:    "balance",
		},
		Windows:   []StatusWindow{},
		UpdatedAt: now,
	}
	if plan.SubscriptionType == service.SubscriptionTypeSubscription {
		st.Plan.BillingMode = "subscription"
	}

	sessionRows, allModelRows, modelRows, err := c.ruleWindows(ctx, userID, plan.GroupID, now)
	if err != nil {
		return nil, err
	}
	weekly, daily, monthly := c.subscriptionWindows(ctx, plan, now)
	st.Windows = append(st.Windows, sessionRows...)
	st.Windows = append(st.Windows, weekly...)
	st.Windows = append(st.Windows, allModelRows...)
	st.Windows = append(st.Windows, modelRows...)
	st.Windows = append(st.Windows, daily...)
	st.Windows = append(st.Windows, monthly...)
	st.Windows = append(st.Windows, c.keyWindows(ctx, userID, deviceID, now)...)

	if u, err := c.sources.user(ctx, userID); err == nil && u != nil {
		st.Balance = &StatusBalance{BalanceUSD: roundUSD(u.Balance)}
	}
	for i := range st.Windows {
		w := &st.Windows[i]
		if !w.Exceeded || w.ResetsAt == nil {
			continue
		}
		if st.Blocked.ResetsAt == nil || w.ResetsAt.After(*st.Blocked.ResetsAt) {
			id, reason, at := w.ID, w.reason, *w.ResetsAt
			st.Blocked = StatusBlocked{Blocked: true, WindowID: &id, Reason: &reason, ResetsAt: &at}
		}
	}
	return st, nil
}

// ruleWindows lists the visible rules of the plan group (show_in_client) with
// the user's counters, split by kind.
func (c *Component) ruleWindows(ctx context.Context, userID, groupID int64, now time.Time) (session, allModels, models []StatusWindow, err error) {
	set, err := c.rules.get(ctx)
	if err != nil {
		return nil, nil, nil, err
	}
	gid := groupID
	var visible []*activeRule
	for _, r := range set.forGroup(&gid) {
		if r.ShowInClient {
			visible = append(visible, r)
		}
	}
	if len(visible) == 0 {
		return nil, nil, nil, nil
	}
	ids := make([]int64, len(visible))
	for i, r := range visible {
		ids[i] = r.ID
	}
	counters, err := c.store.counters(ctx, userID, ids)
	if err != nil {
		return nil, nil, nil, err
	}
	for _, r := range visible {
		w := StatusWindow{
			ID:            "rule:" + strconv.FormatInt(r.ID, 10),
			Source:        "rule",
			Kind:          r.Kind,
			Label:         r.Label,
			Window:        windowLabel(r.WindowSeconds),
			WindowSeconds: r.WindowSeconds,
			LimitUSD:      roundUSD(r.LimitUSD),
			Models:        r.clientModels(),
			reason:        "RULE_LIMIT",
		}
		if row, ok := counters[r.ID]; ok && row.WindowEnd.After(now) {
			start, end := row.WindowStart.UTC(), row.WindowEnd.UTC()
			w.Active = true
			w.UsedUSD = roundUSD(row.UsedUSD)
			w.WindowStart, w.ResetsAt = &start, &end
			w.Exceeded = row.UsedUSD >= r.LimitUSD
		}
		w.Percent = percentOf(w.UsedUSD, w.LimitUSD)
		switch r.Kind {
		case KindSession:
			session = append(session, w)
		case KindAllModels:
			allModels = append(allModels, w)
		default:
			models = append(models, w)
		}
	}
	return session, allModels, models, nil
}

// subscriptionWindows returns the plan subscription's weekly, daily and
// monthly windows that have a limit (GetSubscriptionProgress); a window that
// has not started yet, or has ended and not been reset, is shown inactive.
func (c *Component) subscriptionWindows(ctx context.Context, plan *core.PlanRef, now time.Time) (weekly, daily, monthly []StatusWindow) {
	if plan.SubscriptionID == nil {
		return nil, nil, nil
	}
	progress, err := c.sources.subscriptionProgress(ctx, *plan.SubscriptionID)
	if err != nil {
		if !errors.Is(err, errUnavailable) {
			slog.Warn("claudex usage: subscription progress unavailable", "subscription_id", *plan.SubscriptionID, "error", err)
		}
		progress = nil
	}
	var group *service.Group
	if g, err := c.sources.group(ctx, plan.GroupID); err == nil {
		group = g
	}
	limitOf := func(p *service.UsageWindowProgress, groupLimit *float64) float64 {
		if p != nil && p.LimitUSD > 0 {
			return p.LimitUSD
		}
		if groupLimit != nil && *groupLimit > 0 {
			return *groupLimit
		}
		return 0
	}
	build := func(id, kind, label, window string, seconds int, reason string, p *service.UsageWindowProgress, groupLimit *float64) []StatusWindow {
		limit := limitOf(p, groupLimit)
		if limit <= 0 {
			return nil
		}
		w := StatusWindow{
			ID: id, Source: "subscription", Kind: kind, Label: label, Window: window, WindowSeconds: seconds,
			LimitUSD: roundUSD(limit), reason: reason,
		}
		if p != nil && !p.WindowStart.IsZero() && p.ResetsAt.After(now) {
			start, end := p.WindowStart.UTC(), p.ResetsAt.UTC()
			w.Active = true
			w.UsedUSD = roundUSD(p.UsedUSD)
			w.WindowStart, w.ResetsAt = &start, &end
			w.Exceeded = p.UsedUSD >= limit
		}
		w.Percent = percentOf(w.UsedUSD, w.LimitUSD)
		return []StatusWindow{w}
	}
	var pw, pd, pm *service.UsageWindowProgress
	if progress != nil {
		pw, pd, pm = progress.Weekly, progress.Daily, progress.Monthly
	}
	var gw, gd, gm *float64
	if group != nil {
		gw, gd, gm = group.WeeklyLimitUSD, group.DailyLimitUSD, group.MonthlyLimitUSD
	}
	if progress == nil && group == nil {
		return nil, nil, nil
	}
	weekly = build("subscription:weekly", KindAllModels, DefaultAllModelsLabel, "7d", subscriptionWeekSeconds, "SUBSCRIPTION_WEEKLY_LIMIT", pw, gw)
	daily = build("subscription:daily", "daily", "Daily", "1d", subscriptionDaySeconds, "SUBSCRIPTION_DAILY_LIMIT", pd, gd)
	monthly = build("subscription:monthly", "monthly", "Monthly", "30d", subscriptionMonthSeconds, "SUBSCRIPTION_MONTHLY_LIMIT", pm, gm)
	return weekly, daily, monthly
}

// keyWindows returns the 5h/1d/7d windows of the device key named by
// X-Claudex-Device-Id, when that key has limits.
func (c *Component) keyWindows(ctx context.Context, userID int64, deviceID string, now time.Time) []StatusWindow {
	if deviceID == "" || c.env == nil || c.env.Peers.Devices == nil {
		return nil
	}
	dev, ok := c.env.Peers.Devices.LookupByDeviceID(ctx, userID, deviceID)
	if !ok || dev == nil || dev.Revoked || dev.UserID != userID || dev.APIKeyID <= 0 {
		return nil
	}
	key, err := c.sources.apiKey(ctx, dev.APIKeyID)
	if err != nil || key == nil || key.UserID != userID || !key.HasRateLimits() {
		return nil
	}
	data, err := c.sources.rateLimitData(ctx, key.ID)
	if err != nil || data == nil {
		data = &service.APIKeyRateLimitData{
			Usage5h: key.Usage5h, Usage1d: key.Usage1d, Usage7d: key.Usage7d,
			Window5hStart: key.Window5hStart, Window1dStart: key.Window1dStart, Window7dStart: key.Window7dStart,
		}
	}
	type keyWindow struct {
		suffix, label, reason string
		limit, used           float64
		start                 *time.Time
		length                time.Duration
	}
	var out []StatusWindow
	for _, kw := range []keyWindow{
		{"5h", "This device · 5 hours", "KEY_5H_LIMIT", key.RateLimit5h, data.Usage5h, data.Window5hStart, service.RateLimitWindow5h},
		{"1d", "This device · 1 day", "KEY_1D_LIMIT", key.RateLimit1d, data.Usage1d, data.Window1dStart, service.RateLimitWindow1d},
		{"7d", "This device · 7 days", "KEY_7D_LIMIT", key.RateLimit7d, data.Usage7d, data.Window7dStart, service.RateLimitWindow7d},
	} {
		if kw.limit <= 0 {
			continue
		}
		w := StatusWindow{
			ID: "key:" + kw.suffix, Source: "key", Kind: "key", Label: kw.label, Window: kw.suffix,
			WindowSeconds: int(kw.length / time.Second), LimitUSD: roundUSD(kw.limit), reason: kw.reason,
		}
		if kw.start != nil && now.Before(kw.start.Add(kw.length)) {
			start, end := kw.start.UTC(), kw.start.Add(kw.length).UTC()
			w.Active = true
			w.UsedUSD = roundUSD(kw.used)
			w.WindowStart, w.ResetsAt = &start, &end
			w.Exceeded = kw.used >= kw.limit
		}
		w.Percent = percentOf(w.UsedUSD, w.LimitUSD)
		out = append(out, w)
	}
	return out
}

// bootstrapUsage is the bootstrap section "usage": whether any enabled rule
// applies to the plan group and whether one of them is a visible session
// rule (the client then shows a Current session row before first use).
func (c *Component) bootstrapUsage(ctx context.Context, plan *core.PlanRef) (map[string]any, error) {
	set, err := c.rules.get(ctx)
	if err != nil {
		return nil, err
	}
	var groupID *int64
	if plan != nil {
		gid := plan.GroupID
		groupID = &gid
	}
	rules := set.forGroup(groupID)
	session := false
	for _, r := range rules {
		if r.Kind == KindSession && r.ShowInClient {
			session = true
			break
		}
	}
	return map[string]any{"rules_enabled": len(rules) > 0, "has_session_window": session}, nil
}
