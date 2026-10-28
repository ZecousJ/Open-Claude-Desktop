package refusal

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/service"
)

// Window names used in the "claudex" object.
const (
	window1m  = "1m"
	window5h  = "5h"
	window1d  = "1d"
	window7d  = "7d"
	window30d = "30d"
)

const (
	// factTTL is how long the data behind a refusal is reused per key (design 2.7).
	factTTL = 5 * time.Second
	// linksTTL matches the 60 s settings cache used elsewhere in Claudex.
	linksTTL = 60 * time.Second
	// lookupTimeout bounds each lookup; a slow database never holds a refused
	// response for long (the refusal then goes out with fewer details).
	lookupTimeout = 2 * time.Second
	// maxCachedFacts bounds the per-key cache.
	maxCachedFacts = 4096
)

// windowFact is one usage window with the data the "claudex" object reports.
type windowFact struct {
	Window   string
	LimitUSD float64
	UsedUSD  float64
	ResetsAt *time.Time
}

// full reports whether the window blocks requests at now: a limit is set, the
// usage reached it and the window has not rolled over yet.
func (w windowFact) full(now time.Time) bool {
	if w.LimitUSD <= 0 || w.UsedUSD < w.LimitUSD {
		return false
	}
	return w.ResetsAt == nil || w.ResetsAt.After(now)
}

// latestFull returns the full window that resets last (the one the user has
// to wait for), or nil.
func latestFull(windows []windowFact, now time.Time) *windowFact {
	var pick *windowFact
	for i := range windows {
		w := &windows[i]
		if !w.full(now) {
			continue
		}
		if pick == nil || laterReset(w.ResetsAt, pick.ResetsAt) {
			pick = w
		}
	}
	return pick
}

func laterReset(a, b *time.Time) bool {
	switch {
	case a == nil:
		return false
	case b == nil:
		return true
	default:
		return a.After(*b)
	}
}

func findWindow(windows []windowFact, window string) *windowFact {
	for i := range windows {
		if windows[i].Window == window {
			return &windows[i]
		}
	}
	return nil
}

// keyFacts is the raw data of an API key; windows are computed at use time so
// a cached entry never reports a window that rolled over in the meantime.
type keyFacts struct {
	Quota, QuotaUsed                      float64
	RateLimit5h, RateLimit1d, RateLimit7d float64
	Usage5h, Usage1d, Usage7d             float64
	Window5hStart, Window1dStart          *time.Time
	Window7dStart                         *time.Time
}

// windows returns the configured key windows (limit > 0).
func (k *keyFacts) windows(now time.Time) []windowFact {
	if k == nil {
		return nil
	}
	var out []windowFact
	add := func(window string, length time.Duration, limit, usage float64, start *time.Time) {
		if limit <= 0 {
			return
		}
		w := windowFact{Window: window, LimitUSD: limit}
		if start != nil && now.Sub(*start) < length {
			w.UsedUSD = usage
			resets := start.Add(length).UTC()
			w.ResetsAt = &resets
		}
		out = append(out, w)
	}
	add(window5h, service.RateLimitWindow5h, k.RateLimit5h, k.Usage5h, k.Window5hStart)
	add(window1d, service.RateLimitWindow1d, k.RateLimit1d, k.Usage1d, k.Window1dStart)
	add(window7d, service.RateLimitWindow7d, k.RateLimit7d, k.Usage7d, k.Window7dStart)
	return out
}

// quotaExhausted reports whether the key's total quota is used up.
func (k *keyFacts) quotaExhausted() bool {
	return k != nil && k.Quota > 0 && k.QuotaUsed >= k.Quota
}

func (c *Component) keyFacts(ctx context.Context, apiKeyID int64) *keyFacts {
	if apiKeyID <= 0 {
		return nil
	}
	return cached(ctx, c.facts, "key:"+strconv.FormatInt(apiKeyID, 10), func(ctx context.Context) *keyFacts {
		key, err := c.src.APIKey(ctx, apiKeyID)
		if err != nil || key == nil {
			logLookupError("api key", apiKeyID, err)
			return nil
		}
		k := &keyFacts{
			Quota: key.Quota, QuotaUsed: key.QuotaUsed,
			RateLimit5h: key.RateLimit5h, RateLimit1d: key.RateLimit1d, RateLimit7d: key.RateLimit7d,
			Usage5h: key.Usage5h, Usage1d: key.Usage1d, Usage7d: key.Usage7d,
			Window5hStart: key.Window5hStart, Window1dStart: key.Window1dStart, Window7dStart: key.Window7dStart,
		}
		if key.HasRateLimits() {
			// The windows the upstream rate-limit check maintains.
			if data, err := c.src.RateLimitData(ctx, apiKeyID); err == nil && data != nil {
				k.Usage5h, k.Usage1d, k.Usage7d = data.Usage5h, data.Usage1d, data.Usage7d
				k.Window5hStart, k.Window1dStart, k.Window7dStart = data.Window5hStart, data.Window1dStart, data.Window7dStart
			} else {
				logLookupError("api key rate limits", apiKeyID, err)
			}
		}
		return k
	})
}

// subscriptionFacts are the usage windows of the user's subscription to the
// key's group (only windows with a limit).
type subscriptionFacts struct {
	Windows []windowFact
}

func (c *Component) subscriptionFacts(ctx context.Context, in *request) *subscriptionFacts {
	if in.UserID <= 0 || in.GroupID == nil {
		return nil
	}
	userID, groupID := in.UserID, *in.GroupID
	key := "sub:" + strconv.FormatInt(in.APIKeyID, 10) + ":" + strconv.FormatInt(userID, 10) + ":" + strconv.FormatInt(groupID, 10)
	return cached(ctx, c.facts, key, func(ctx context.Context) *subscriptionFacts {
		sub, err := c.src.ActiveSubscription(ctx, userID, groupID)
		if err != nil || sub == nil {
			logLookupError("subscription", in.APIKeyID, err)
			return nil
		}
		progress, err := c.src.SubscriptionProgress(ctx, sub.ID)
		if err != nil || progress == nil {
			logLookupError("subscription progress", in.APIKeyID, err)
			return nil
		}
		facts := &subscriptionFacts{}
		for _, p := range []struct {
			window   string
			progress *service.UsageWindowProgress
		}{{window1d, progress.Daily}, {window7d, progress.Weekly}, {window30d, progress.Monthly}} {
			if p.progress == nil || p.progress.LimitUSD <= 0 {
				continue
			}
			resets := p.progress.ResetsAt.UTC()
			facts.Windows = append(facts.Windows, windowFact{
				Window: p.window, LimitUSD: p.progress.LimitUSD, UsedUSD: p.progress.UsedUSD, ResetsAt: &resets,
			})
		}
		return facts
	})
}

// subscriptionState is the stored status of the user's subscription to the
// key's group ("" when unknown or missing).
type subscriptionState struct {
	Status string
	Found  bool
}

func (c *Component) subscriptionState(ctx context.Context, in *request) *subscriptionState {
	if in.UserID <= 0 || in.GroupID == nil {
		return nil
	}
	userID, groupID := in.UserID, *in.GroupID
	key := "substatus:" + strconv.FormatInt(in.APIKeyID, 10) + ":" + strconv.FormatInt(userID, 10) + ":" + strconv.FormatInt(groupID, 10)
	return cached(ctx, c.facts, key, func(ctx context.Context) *subscriptionState {
		status, found, err := c.src.SubscriptionStatus(ctx, userID, groupID)
		if err != nil {
			logLookupError("subscription status", in.APIKeyID, err)
			return nil
		}
		return &subscriptionState{Status: status, Found: found}
	})
}

// deviceRevoked reads the device row without any cache; concurrent refusals
// of the same key share one query.
func (c *Component) deviceRevoked(ctx context.Context, apiKeyID int64) (revoked, found bool, err error) {
	type result struct{ revoked, found bool }
	v, err, _ := c.devices.Do(strconv.FormatInt(apiKeyID, 10), func() (any, error) {
		qctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), lookupTimeout)
		defer cancel()
		revoked, found, err := c.src.DeviceRevoked(qctx, apiKeyID)
		return result{revoked, found}, err
	})
	if err != nil {
		return false, false, err
	}
	r, _ := v.(result)
	return r.revoked, r.found, nil
}

// Settings read to decide whether a "Get more usage" link exists.
const (
	settingClientPolicy = "claudex_client_policy" // B2's stored policy (design 2.3)
)

// maxLinkBytes is the longest link B2 accepts (policy validate.go maxURLBytes).
const maxLinkBytes = 2000

// purchaseLinks is a snapshot of the settings that give the desktop client a
// way to get more usage: the client policy's links.get_more_usage (defaults,
// group and user overrides, design 2.3), the upstream purchase-subscription
// page it falls back to (design 1.6.1), and the upstream in-app payment the
// client's Billing page uses (design 4.5).
type purchaseLinks struct {
	PaymentEnabled   bool
	PurchaseURL      string // https purchase_subscription_url when purchase_subscription_enabled
	DefaultLink      policyLink
	GroupLinks       map[int64]policyLink
	UserLinks        map[int64]policyLink
	policyParseError bool
}

// policyLink is one policy layer's links.get_more_usage: absent (Set false,
// the layer inherits), an explicit null (Set, Value nil: clears the layers
// below) or a value.
type policyLink struct {
	Set   bool
	Value *string
}

// has reports whether the user of this plan group gets a link to get more
// usage. It mirrors B2's resolver: the most specific layer that names
// get_more_usage decides (null clears what the layers below set), and only
// when no layer leaves a value does the purchase page (https only) stand in.
func (p *purchaseLinks) has(userID int64, groupID *int64) bool {
	if p == nil {
		return false
	}
	if p.PaymentEnabled {
		return true
	}
	var link *string
	apply := func(l policyLink) {
		if l.Set {
			link = l.Value
		}
	}
	apply(p.DefaultLink)
	if groupID != nil {
		apply(p.GroupLinks[*groupID])
	}
	apply(p.UserLinks[userID])
	if link == nil {
		return p.PurchaseURL != ""
	}
	_, err := core.HTTPSURL(*link, maxLinkBytes)
	return err == nil
}

// storedPolicyLayer is the part of a stored policy layer B6 reads.
type storedPolicyLayer struct {
	Links map[string]json.RawMessage `json:"links"`
}

func (l storedPolicyLayer) getMoreUsage() policyLink {
	raw, ok := l.Links["get_more_usage"]
	if !ok {
		return policyLink{}
	}
	var v *string
	if err := json.Unmarshal(raw, &v); err != nil {
		return policyLink{} // not a string: B2 never stores that, ignore it
	}
	return policyLink{Set: true, Value: v}
}

func parsePurchaseLinks(settings map[string]string) *purchaseLinks {
	p := &purchaseLinks{GroupLinks: map[int64]policyLink{}, UserLinks: map[int64]policyLink{}}
	p.PaymentEnabled = strings.TrimSpace(settings[service.SettingPaymentEnabled]) == "true"
	if strings.TrimSpace(settings[service.SettingKeyPurchaseSubscriptionEnabled]) == "true" {
		if u, err := core.HTTPSURL(settings[service.SettingKeyPurchaseSubscriptionURL], maxLinkBytes); err == nil {
			p.PurchaseURL = u
		}
	}
	raw := strings.TrimSpace(settings[settingClientPolicy])
	if raw == "" {
		return p
	}
	var stored struct {
		Defaults       storedPolicyLayer            `json:"defaults"`
		GroupOverrides map[string]storedPolicyLayer `json:"group_overrides"`
		UserOverrides  map[string]storedPolicyLayer `json:"user_overrides"`
	}
	if err := json.Unmarshal([]byte(raw), &stored); err != nil {
		p.policyParseError = true
		return p
	}
	p.DefaultLink = stored.Defaults.getMoreUsage()
	for k, v := range stored.GroupOverrides {
		if id, err := strconv.ParseInt(k, 10, 64); err == nil {
			p.GroupLinks[id] = v.getMoreUsage()
		}
	}
	for k, v := range stored.UserOverrides {
		if id, err := strconv.ParseInt(k, 10, 64); err == nil {
			p.UserLinks[id] = v.getMoreUsage()
		}
	}
	return p
}

func (c *Component) purchaseLinks(ctx context.Context) *purchaseLinks {
	return cached(ctx, c.links, "links", func(ctx context.Context) *purchaseLinks {
		settings, err := c.src.Settings(ctx, []string{
			service.SettingPaymentEnabled,
			service.SettingKeyPurchaseSubscriptionEnabled,
			service.SettingKeyPurchaseSubscriptionURL,
			settingClientPolicy,
		})
		if err != nil {
			logLookupError("purchase links", 0, err)
			return nil
		}
		links := parsePurchaseLinks(settings)
		if links.policyParseError {
			slog.Warn("claudex refusal: the stored client policy is not valid JSON; ignoring its links", "key", settingClientPolicy)
		}
		return links
	})
}

func logLookupError(what string, apiKeyID int64, err error) {
	if err == nil || errors.Is(err, errUnavailable) ||
		errors.Is(err, service.ErrSubscriptionNotFound) || errors.Is(err, service.ErrAPIKeyNotFound) {
		return
	}
	slog.Warn("claudex refusal: lookup failed", "what", what, "api_key_id", apiKeyID, "error", err)
}

// usd rounds an amount for the "claudex" object (micro-dollar precision).
func usd(v float64) *float64 {
	r := math.Round(v*1e6) / 1e6
	return &r
}
