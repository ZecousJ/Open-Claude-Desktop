// Package refusal is the B6 component: the structured refusal details (a
// gatewayhook.RefusalDescriber, design 2.7).
//
// gatewayhook.EnrichRefusals (B0, at the front of the /v1 group) buffers the
// 401/402/403/426/429 JSON errors of Claudex device-key requests, strips any
// "claudex" key an upstream wrote and asks the describers for the details
// unless a component preset them with gatewayhook.SetDetail (B1 426, B4
// revoked device, B5 usage rule). This package answers: it maps the upstream
// rejection (USAGE_LIMIT_EXCEEDED, SUBSCRIPTION_*, API_KEY_*,
// insufficient_quota, rate_limit_exceeded, billing_error,
// INSUFFICIENT_BALANCE, GROUP_*, USER_*) to reason, kind, window, resets_at,
// action, reprovision and an English message, recomputing the subscription
// and key windows (cached 5 s per key and data kind) and checking
// claudex_devices directly on API_KEY_DISABLED.
package refusal

import (
	"context"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/gatewayhook"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
	"golang.org/x/sync/singleflight"
)

// Reasons (design 2.7). B1, B4 and B5 preset UPGRADE_REQUIRED,
// DEVICE_REVOKED (revoked device guard) and RULE_LIMIT themselves; only B5's
// RULE_LIMIT carries rule_kind (the kind of the usage rule, R13). The
// usage_limit details here come from subscription and platform windows, not
// usage rules, so they leave it out.
const (
	ReasonSubscriptionDailyLimit   = "SUBSCRIPTION_DAILY_LIMIT"
	ReasonSubscriptionWeeklyLimit  = "SUBSCRIPTION_WEEKLY_LIMIT"
	ReasonSubscriptionMonthlyLimit = "SUBSCRIPTION_MONTHLY_LIMIT"
	ReasonSubscriptionExpired      = "SUBSCRIPTION_EXPIRED"
	ReasonSubscriptionSuspended    = "SUBSCRIPTION_SUSPENDED"
	ReasonSubscriptionNotFound     = "SUBSCRIPTION_NOT_FOUND"
	ReasonKey5hLimit               = "KEY_5H_LIMIT"
	ReasonKey1dLimit               = "KEY_1D_LIMIT"
	ReasonKey7dLimit               = "KEY_7D_LIMIT"
	ReasonKeyQuotaExhausted        = "KEY_QUOTA_EXHAUSTED"
	ReasonKeyExpired               = "KEY_EXPIRED"
	ReasonDeviceRevoked            = "DEVICE_REVOKED"
	ReasonKeyDisabled              = "KEY_DISABLED"
	ReasonBalanceInsufficient      = "BALANCE_INSUFFICIENT"
	ReasonUserRPMLimit             = "USER_RPM_LIMIT"
	ReasonGroupRPMLimit            = "GROUP_RPM_LIMIT"
	ReasonPlatformDailyQuota       = "PLATFORM_DAILY_QUOTA"
	ReasonPlatformWeeklyQuota      = "PLATFORM_WEEKLY_QUOTA"
	ReasonPlatformMonthlyQuota     = "PLATFORM_MONTHLY_QUOTA"
	ReasonGroupUnavailable         = "GROUP_UNAVAILABLE"
	ReasonUserInactive             = "USER_INACTIVE"
	ReasonUnknown                  = "UNKNOWN"
)

// Kinds and actions of the "claudex" object.
const (
	kindUsageLimit   = "usage_limit"
	kindKeyLimit     = "key_limit"
	kindRateLimit    = "rate_limit"
	kindBalance      = "balance"
	kindSubscription = "subscription"
	kindKey          = "key"
	kindAccount      = "account"
	kindGroup        = "group"
	kindUnknown      = "unknown"

	actionNone         = "none"
	actionWait         = "wait"
	actionSignIn       = "sign_in"
	actionContactAdmin = "contact_admin"
	actionGetMoreUsage = "get_more_usage"
)

var (
	subscriptionLimitReasons = map[string]string{
		window1d: ReasonSubscriptionDailyLimit, window7d: ReasonSubscriptionWeeklyLimit, window30d: ReasonSubscriptionMonthlyLimit,
	}
	keyLimitReasons = map[string]string{
		window5h: ReasonKey5hLimit, window1d: ReasonKey1dLimit, window7d: ReasonKey7dLimit,
	}
	platformQuotaReasons = map[string]string{
		window1d: ReasonPlatformDailyQuota, window7d: ReasonPlatformWeeklyQuota, window30d: ReasonPlatformMonthlyQuota,
	}
)

// Component is the B6 component.
type Component struct {
	src     source
	now     func() time.Time
	facts   *factCache // per key and data kind, factTTL
	links   *factCache // purchase links, linksTTL
	devices singleflight.Group
}

// New builds the component. It must not call its dependencies or env.Peers:
// ProvideModule binds the peers after every component is built, and tests
// pass empty Deps.
func New(env *core.Env) *Component {
	now := func() time.Time {
		if env != nil && env.Now != nil {
			return env.Now()
		}
		return time.Now()
	}
	return newComponent(envSource{env: env}, now)
}

func newComponent(src source, now func() time.Time) *Component {
	return &Component{
		src:   src,
		now:   now,
		facts: newFactCache(factTTL, maxCachedFacts, now),
		links: newFactCache(linksTTL, 1, now),
	}
}

// Name implements core.Feature.
func (c *Component) Name() string { return core.NameRefusal }

var (
	_ core.Feature                 = (*Component)(nil)
	_ gatewayhook.RefusalDescriber = (*Component)(nil)
)

// request is one refusal being described.
type request struct {
	gatewayhook.Refusal
	now        time.Time
	retryAfter int // Retry-After of the response being rewritten, seconds (0 = none)
	device     *gatewayhook.DeviceRef
}

// Describe implements gatewayhook.RefusalDescriber. EnrichRefusals calls it
// only for device-key requests answered with 401/402/403/426/429 and no
// preset detail; it sets V and falls back to the upstream message when
// Message is empty. A panic here is recovered by EnrichRefusals, which then
// sends the original body (minus any upstream "claudex" key).
func (c *Component) Describe(g *gin.Context, r gatewayhook.Refusal) *gatewayhook.RefusalDetail {
	// Only Claudex device keys get details (and cost lookups); EnrichRefusals
	// already calls describers for nothing else.
	device, ok := gatewayhook.Device(g)
	if !ok {
		return nil
	}
	ctx := context.Background()
	if g.Request != nil {
		ctx = g.Request.Context()
	}
	ctx, cancel := context.WithTimeout(ctx, lookupTimeout)
	defer cancel()

	in := &request{Refusal: r, now: c.now().UTC(), retryAfter: retryAfterHeader(g), device: device}
	// The key the gateway loaded for this request names its group; the
	// device row's group can lag behind a plan change.
	if key := requestAPIKey(g); key != nil {
		if key.GroupID != nil {
			gid := *key.GroupID
			in.GroupID = &gid
		}
		if in.UserID <= 0 {
			in.UserID = key.UserID
		}
		if in.APIKeyID <= 0 {
			in.APIKeyID = key.ID
		}
	}
	return c.describe(ctx, in)
}

func requestAPIKey(g *gin.Context) *service.APIKey {
	if g == nil {
		return nil
	}
	if key, ok := middleware.GetAPIKeyFromContext(g); ok && key != nil {
		return key
	}
	if key, ok := middleware.GetOpsFallbackAPIKey(g); ok && key != nil {
		return key
	}
	return nil
}

// retryAfterHeader reads the Retry-After seconds the gateway set on the
// response (RPM and platform quota refusals).
func retryAfterHeader(g *gin.Context) int {
	if g == nil || g.Writer == nil {
		return 0
	}
	n, err := strconv.Atoi(strings.TrimSpace(g.Writer.Header().Get("Retry-After")))
	if err != nil || n <= 0 {
		return 0
	}
	return n
}

// describe applies the design 2.7 decision table.
func (c *Component) describe(ctx context.Context, in *request) *gatewayhook.RefusalDetail {
	v := classify(in.Code, in.Message)
	switch v.class {
	case classSubscriptionLimit:
		if d := c.subscriptionLimit(ctx, in, v.window); d != nil {
			return d
		}
	case classWindowGuess:
		if d := c.windowGuess(ctx, in, v.keyFirst); d != nil {
			return d
		}
	case classSubscriptionState:
		return c.subscriptionStateDetail(ctx, in, v.state)
	case classSubscriptionNotFound:
		return &gatewayhook.RefusalDetail{Reason: ReasonSubscriptionNotFound, Kind: kindSubscription,
			Reprovision: true, Action: actionContactAdmin, Message: msgSubscriptionNotFound}
	case classKeyWindow:
		if d := c.keyLimit(ctx, in, v.window); d != nil {
			return d
		}
	case classKeyQuota:
		return c.keyQuota(c.keyFacts(ctx, in.APIKeyID))
	case classKeyQuotaUnproven:
		if facts := c.keyFacts(ctx, in.APIKeyID); facts.quotaExhausted() {
			return c.keyQuota(facts)
		}
	case classKeyExpired:
		return &gatewayhook.RefusalDetail{Reason: ReasonKeyExpired, Kind: kindKey,
			Reprovision: true, Action: actionNone, Message: msgKeyExpired}
	case classKeyDisabled:
		return c.keyDisabled(ctx, in)
	case classBalance:
		return &gatewayhook.RefusalDetail{Reason: ReasonBalanceInsufficient, Kind: kindBalance,
			Action: actionGetMoreUsage, Message: msgBalanceInsufficient}
	case classUserInactive:
		return &gatewayhook.RefusalDetail{Reason: ReasonUserInactive, Kind: kindAccount,
			Action: actionContactAdmin, Message: msgUserInactive}
	case classGroupUnavailable:
		return &gatewayhook.RefusalDetail{Reason: ReasonGroupUnavailable, Kind: kindGroup,
			Reprovision: true, Action: actionNone, Message: msgGroupUnavailable}
	case classUserRPM, classGroupRPM:
		reason := ReasonUserRPMLimit
		if v.class == classGroupRPM {
			reason = ReasonGroupRPMLimit
		}
		d := &gatewayhook.RefusalDetail{Reason: reason, Kind: kindRateLimit, Window: window1m,
			Action: actionWait, Message: tooManyRequestsMessage(in.retryAfter)}
		setRetryAfter(d, in)
		return d
	case classPlatformQuota:
		d := &gatewayhook.RefusalDetail{Reason: platformQuotaReasons[v.window], Kind: kindUsageLimit, Window: v.window,
			Action: actionWait}
		setRetryAfter(d, in)
		d.Message = platformQuotaMessage(v.window, d.ResetsAt)
		return d
	}
	return unknown(in)
}

// unknown is the UNKNOWN row: no action, the upstream message is kept.
func unknown(in *request) *gatewayhook.RefusalDetail {
	d := &gatewayhook.RefusalDetail{Reason: ReasonUnknown, Kind: kindUnknown, Action: actionNone}
	if in.retryAfter > 0 {
		d.RetryAfterSeconds = in.retryAfter
	}
	return d
}

// setRetryAfter fills retry_after_seconds and resets_at from the response's
// Retry-After header.
func setRetryAfter(d *gatewayhook.RefusalDetail, in *request) {
	if in.retryAfter <= 0 {
		return
	}
	d.RetryAfterSeconds = in.retryAfter
	resets := in.now.Add(time.Duration(in.retryAfter) * time.Second)
	d.ResetsAt = &resets
}

// windowDetail fills window, resets_at, retry_after_seconds, limit and used.
func windowDetail(d *gatewayhook.RefusalDetail, w *windowFact, in *request) {
	if w == nil {
		return
	}
	d.Window = w.Window
	// Only a window that is still running has a usage and a reset time worth
	// reporting: one that rolled over (or never started) would tell the user
	// it "resets" at a time already past, or show a usage of zero.
	if w.ResetsAt != nil && w.ResetsAt.After(in.now) {
		if w.LimitUSD > 0 {
			d.LimitUSD = usd(w.LimitUSD)
			d.UsedUSD = usd(w.UsedUSD)
		}
		resets := w.ResetsAt.UTC()
		d.ResetsAt = &resets
		if secs := math.Ceil(resets.Sub(in.now).Seconds()); secs > 0 {
			d.RetryAfterSeconds = int(secs)
		}
	}
	if d.RetryAfterSeconds == 0 && in.retryAfter > 0 {
		d.RetryAfterSeconds = in.retryAfter
	}
}

// subscriptionLimit: SUBSCRIPTION_{DAILY,WEEKLY,MONTHLY}_LIMIT. The window
// that is full now wins (the latest reset when several are); when none is
// (the cached usage lags the billing cache) the window named by the
// upstream message decides. Returns nil when neither says which window.
func (c *Component) subscriptionLimit(ctx context.Context, in *request, hint string) *gatewayhook.RefusalDetail {
	var windows []windowFact
	if facts := c.subscriptionFacts(ctx, in); facts != nil {
		windows = facts.Windows
	}
	w := latestFull(windows, in.now)
	if w == nil && hint != "" {
		w = findWindow(windows, hint)
		if w == nil {
			w = &windowFact{Window: hint}
		}
	}
	if w == nil {
		return nil
	}
	return c.subscriptionLimitDetail(ctx, in, w)
}

func (c *Component) subscriptionLimitDetail(ctx context.Context, in *request, w *windowFact) *gatewayhook.RefusalDetail {
	d := &gatewayhook.RefusalDetail{Reason: subscriptionLimitReasons[w.Window], Kind: kindUsageLimit, Action: actionWait}
	windowDetail(d, w, in)
	if c.purchaseLinks(ctx).has(in.UserID, in.GroupID) {
		d.Action = actionGetMoreUsage
	}
	d.Message = subscriptionLimitMessage(w.Window, d.ResetsAt)
	return d
}

// keyLimit: KEY_{5H,1D,7D}_LIMIT from the key's rate-limit windows.
func (c *Component) keyLimit(ctx context.Context, in *request, hint string) *gatewayhook.RefusalDetail {
	windows := c.keyFacts(ctx, in.APIKeyID).windows(in.now)
	w := findWindow(windows, hint)
	if w == nil {
		w = &windowFact{Window: hint}
	}
	return keyLimitDetail(in, w)
}

func keyLimitDetail(in *request, w *windowFact) *gatewayhook.RefusalDetail {
	d := &gatewayhook.RefusalDetail{Reason: keyLimitReasons[w.Window], Kind: kindKeyLimit, Action: actionWait}
	windowDetail(d, w, in)
	d.Message = keyLimitMessage(w.Window, d.ResetsAt)
	return d
}

// windowGuess handles billing_error / rate_limit_exceeded with an unknown
// message: whichever key or subscription window is full now explains it.
func (c *Component) windowGuess(ctx context.Context, in *request, keyFirst bool) *gatewayhook.RefusalDetail {
	byKey := func() *gatewayhook.RefusalDetail {
		if w := latestFull(c.keyFacts(ctx, in.APIKeyID).windows(in.now), in.now); w != nil {
			return keyLimitDetail(in, w)
		}
		return nil
	}
	bySubscription := func() *gatewayhook.RefusalDetail {
		facts := c.subscriptionFacts(ctx, in)
		if facts == nil {
			return nil
		}
		if w := latestFull(facts.Windows, in.now); w != nil {
			return c.subscriptionLimitDetail(ctx, in, w)
		}
		return nil
	}
	order := []func() *gatewayhook.RefusalDetail{bySubscription, byKey}
	if keyFirst {
		order = []func() *gatewayhook.RefusalDetail{byKey, bySubscription}
	}
	for _, f := range order {
		if d := f(); d != nil {
			return d
		}
	}
	return nil
}

// subscriptionStateDetail: SUBSCRIPTION_EXPIRED / SUBSCRIPTION_SUSPENDED. The
// handler's "subscription is invalid or expired" names neither, so the stored
// status decides (expired unless it says suspended).
func (c *Component) subscriptionStateDetail(ctx context.Context, in *request, state string) *gatewayhook.RefusalDetail {
	if state == "" {
		state = "expired"
		if st := c.subscriptionState(ctx, in); st != nil && st.Found && st.Status == service.SubscriptionStatusSuspended {
			state = "suspended"
		}
	}
	if state == "suspended" {
		return &gatewayhook.RefusalDetail{Reason: ReasonSubscriptionSuspended, Kind: kindSubscription,
			Action: actionContactAdmin, Message: msgSubscriptionSuspend}
	}
	return &gatewayhook.RefusalDetail{Reason: ReasonSubscriptionExpired, Kind: kindSubscription,
		Action: actionContactAdmin, Message: msgSubscriptionExpired}
}

// keyQuota: KEY_QUOTA_EXHAUSTED with the key's quota and usage.
func (c *Component) keyQuota(facts *keyFacts) *gatewayhook.RefusalDetail {
	d := &gatewayhook.RefusalDetail{Reason: ReasonKeyQuotaExhausted, Kind: kindKeyLimit,
		Action: actionContactAdmin, Message: msgKeyQuotaExhausted}
	if facts != nil && facts.Quota > 0 {
		d.LimitUSD = usd(facts.Quota)
		d.UsedUSD = usd(facts.QuotaUsed)
	}
	return d
}

// keyDisabled: API_KEY_DISABLED is DEVICE_REVOKED when the device mark (B4)
// or claudex_devices says the device was revoked, and KEY_DISABLED otherwise,
// which the client answers by registering the device again. A revoked key
// never becomes usable again (B4 rotates to a new key), so a mark that says
// revoked needs no query; one that says active is checked in the table
// without cache (another node may have revoked the device a moment ago), so
// a device that keeps retrying a revoked key costs no query per request once
// B4's directory has seen the revocation. When the table cannot be read, the
// mark decides.
func (c *Component) keyDisabled(ctx context.Context, in *request) *gatewayhook.RefusalDetail {
	revoked := in.device != nil && in.device.Revoked
	if !revoked && in.APIKeyID > 0 {
		// A missing row (the device is gone) reads as not revoked: the key is
		// no longer a device key and the client registers the device again.
		if r, _, err := c.deviceRevoked(ctx, in.APIKeyID); err == nil {
			revoked = r
		} else {
			logLookupError("device", in.APIKeyID, err)
		}
	}
	if revoked {
		return &gatewayhook.RefusalDetail{Reason: ReasonDeviceRevoked, Kind: kindKey,
			Action: actionSignIn, Message: msgDeviceRevoked}
	}
	return &gatewayhook.RefusalDetail{Reason: ReasonKeyDisabled, Kind: kindKey,
		Reprovision: true, Action: actionNone, Message: msgKeyDisabled}
}
