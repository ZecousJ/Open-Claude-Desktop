package refusal

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/gatewayhook"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestMessages(t *testing.T) {
	require.Equal(t, "Sep 29, 12:00 AM UTC", formatResetTime(time.Date(2026, 9, 29, 0, 0, 0, 0, time.UTC)))
	require.Equal(t, "Oct 2, 12:05 PM UTC", formatResetTime(time.Date(2026, 10, 2, 12, 5, 0, 0, time.UTC)))
	shanghai := time.FixedZone("CST", 8*3600)
	require.Equal(t, "Sep 29, 12:00 AM UTC", formatResetTime(time.Date(2026, 9, 29, 8, 0, 0, 0, shanghai)), "always UTC")

	resets := time.Date(2026, 9, 29, 0, 0, 0, 0, time.UTC)
	require.Equal(t, "You've reached your weekly usage limit. It resets Sep 29, 12:00 AM UTC.",
		subscriptionLimitMessage(window7d, &resets))
	require.Equal(t, "You've reached your daily usage limit.", subscriptionLimitMessage(window1d, nil))
	require.Equal(t, "You've reached your monthly usage quota. It resets Sep 29, 12:00 AM UTC.",
		platformQuotaMessage(window30d, &resets))
	require.Equal(t, "This device has reached its 5-hour limit. It resets Sep 29, 12:00 AM UTC.",
		keyLimitMessage(window5h, &resets))
	require.Equal(t, "This device has reached its weekly limit.", keyLimitMessage(window7d, nil))
	require.Equal(t, "Too many requests. Try again in a moment.", tooManyRequestsMessage(0))
	require.Equal(t, "Too many requests. Try again in 1 second.", tooManyRequestsMessage(1))
	require.Equal(t, "Too many requests. Try again in 42 seconds.", tooManyRequestsMessage(42))

	// Every window a reason can carry has a word for the message.
	for w := range subscriptionLimitReasons {
		require.NotEmpty(t, subscriptionWindowNames[w], w)
	}
	for w := range platformQuotaReasons {
		require.NotEmpty(t, subscriptionWindowNames[w], w)
	}
	for w := range keyLimitReasons {
		require.NotEmpty(t, keyWindowNames[w], w)
	}
	for _, m := range []string{msgDeviceRevoked, msgKeyDisabled, msgKeyExpired, msgKeyQuotaExhausted, msgBalanceInsufficient,
		msgSubscriptionExpired, msgSubscriptionSuspend, msgSubscriptionNotFound, msgGroupUnavailable, msgUserInactive} {
		require.Regexp(t, `^[A-Z][ -~]+\.$`, m, "plain English sentence")
	}
}

// The upstream messages the classification relies on still exist upstream.
func TestUpstreamMessagesAreKnown(t *testing.T) {
	for name, msg := range map[string]string{
		"5h": msgKeyRate5h, "1d": msgKeyRate1d, "7d": msgKeyRate7d, "quota": msgKeyQuota, "expired": msgKeyExpiredUpstream,
		"group rpm": msgGroupRPM, "user rpm": msgUserRPM, "platform daily": msgPlatformDaily,
		"platform weekly": msgPlatformWeekly, "platform monthly": msgPlatformMonthly, "balance": msgBalance,
		"sub invalid": msgSubInvalid, "sub expired": msgSubExpired, "sub suspended": msgSubSuspended,
		"sub daily": msgSubDaily, "sub weekly": msgSubWeekly, "sub monthly": msgSubMonthly,
	} {
		require.NotEmpty(t, msg, name)
		require.NotEqual(t, "unknown error", msg, name)
	}
	// No message contains another one (the switch order must not matter).
	all := []string{msgKeyRate5h, msgKeyRate1d, msgKeyRate7d, msgGroupRPM, msgUserRPM, msgPlatformDaily,
		msgPlatformWeekly, msgPlatformMonthly, msgBalance, msgSubInvalid, msgSubDaily, msgSubWeekly, msgSubMonthly}
	for i, a := range all {
		for j, b := range all {
			if i != j {
				require.NotContains(t, a, b)
			}
		}
	}
}

func TestClassify(t *testing.T) {
	for _, tc := range []struct {
		code, message string
		want          verdict
	}{
		{"USAGE_LIMIT_EXCEEDED", "weekly usage limit exceeded", verdict{class: classSubscriptionLimit, window: window7d}},
		{"USAGE_LIMIT_EXCEEDED", `error: code=429 reason="MONTHLY_LIMIT_EXCEEDED" message="x"`, verdict{class: classSubscriptionLimit, window: window30d}},
		{"WEEKLY_LIMIT_EXCEEDED", "", verdict{class: classSubscriptionLimit, window: window7d}},
		{"SUBSCRIPTION_INVALID", "subscription is invalid or expired", verdict{class: classSubscriptionState}},
		{"SUBSCRIPTION_EXPIRED", "", verdict{class: classSubscriptionState, state: "expired"}},
		{"subscription_suspended", "", verdict{class: classSubscriptionState, state: "suspended"}},
		{"API_KEY_RATE_7D_EXCEEDED", "", verdict{class: classKeyWindow, window: window7d}},
		{"insufficient_quota", "API key 额度已用完", verdict{class: classKeyQuota}},
		{"insufficient_quota", "You exceeded your current quota", verdict{class: classKeyQuotaUnproven}},
		{"API_KEY_INACTIVE", "", verdict{class: classKeyDisabled}},
		{"GROUP_RPM_EXCEEDED", "", verdict{class: classGroupRPM, window: window1m}},
		{"USER_PLATFORM_WEEKLY_QUOTA_EXHAUSTED", "", verdict{class: classPlatformQuota, window: window7d}},
		{"rate_limit_exceeded", "api key 7天限额已用完", verdict{class: classKeyWindow, window: window7d}},
		{"billing_error", "weekly usage limit exceeded", verdict{class: classSubscriptionLimit, window: window7d}},
		{"billing_error", "api key 已过期", verdict{class: classKeyExpired}},
		{"billing_error", "Billing error", verdict{class: classWindowGuess}},
		{"rate_limit_exceeded", "", verdict{class: classWindowGuess, keyFirst: true}},
		{"GROUP_SOMETHING_NEW", "", verdict{class: classGroupUnavailable}},
		{"", "", verdict{class: classUnknown}},
		{"permission_error", "model not allowed", verdict{class: classUnknown}},
		{"CLAUDEX_UPGRADE_REQUIRED", "", verdict{class: classUnknown}},
	} {
		require.Equal(t, tc.want, classify(tc.code, tc.message), "%s / %s", tc.code, tc.message)
	}
}

func TestPurchaseLinks(t *testing.T) {
	// Stored the way B2 writes it: an absent key inherits, null clears what the
	// layers below set (B2 resolve.go setLink), a value replaces it.
	policy := `{"version":1,"revision":3,
		"defaults":{"links":{"get_more_usage":"https://claudex.example.com/plans"}},
		"group_overrides":{"4":{"links":{"get_more_usage":null}},"5":{"plan_label":"Pro"},"6":{"links":{"help":"https://h.example.com"}},"x":{}},
		"user_overrides":{"123":{"links":{"get_more_usage":"https://claudex.example.com/u"}},"124":{"links":{}},
			"125":{"links":{"get_more_usage":null}}}}`
	links := parsePurchaseLinks(map[string]string{"claudex_client_policy": policy})
	require.True(t, links.has(1, int64p(5)), "defaults")
	require.True(t, links.has(1, int64p(6)), "another link of the group does not touch get_more_usage")
	require.True(t, links.has(1, nil), "defaults without a plan")
	require.False(t, links.has(1, int64p(4)), "the group's null clears the defaults' link")
	require.True(t, links.has(123, int64p(4)), "the user override wins")
	require.False(t, links.has(124, int64p(4)), "an absent key inherits the group's null")
	require.False(t, links.has(125, int64p(5)), "the user's null clears the defaults' link")

	withPurchase := parsePurchaseLinks(map[string]string{"claudex_client_policy": policy,
		service.SettingKeyPurchaseSubscriptionEnabled: "true", service.SettingKeyPurchaseSubscriptionURL: " https://shop.example.com "})
	require.True(t, withPurchase.has(1, int64p(4)), "a cleared link falls back to the purchase page")
	require.True(t, withPurchase.has(125, int64p(5)))
	require.True(t, withPurchase.has(1, int64p(5)))

	disabledPurchase := parsePurchaseLinks(map[string]string{
		service.SettingKeyPurchaseSubscriptionEnabled: "false", service.SettingKeyPurchaseSubscriptionURL: "https://shop.example.com"})
	require.False(t, disabledPurchase.has(1, nil))
	insecurePurchase := parsePurchaseLinks(map[string]string{
		service.SettingKeyPurchaseSubscriptionEnabled: "true", service.SettingKeyPurchaseSubscriptionURL: "http://shop.example.com"})
	require.False(t, insecurePurchase.has(1, nil), "B2 only falls back to an https purchase page")
	unusable := parsePurchaseLinks(map[string]string{"claudex_client_policy": `{"defaults":{"links":{"get_more_usage":"ftp://files.example.com"}}}`,
		service.SettingKeyPurchaseSubscriptionEnabled: "true", service.SettingKeyPurchaseSubscriptionURL: "https://shop.example.com"})
	require.False(t, unusable.has(1, nil), "a set link replaces the fallback; the client cannot open a non-https one")

	require.True(t, parsePurchaseLinks(map[string]string{service.SettingPaymentEnabled: "true"}).has(1, nil), "in-app payment")
	require.False(t, parsePurchaseLinks(nil).has(1, nil))

	broken := parsePurchaseLinks(map[string]string{"claudex_client_policy": "{not json",
		service.SettingKeyPurchaseSubscriptionEnabled: "true", service.SettingKeyPurchaseSubscriptionURL: "https://shop.example.com"})
	require.True(t, broken.policyParseError)
	require.True(t, broken.has(1, nil), "a broken policy is ignored, the purchase page still counts")
	var nilLinks *purchaseLinks
	require.False(t, nilLinks.has(1, nil))
}

func TestPurchaseLinksAreCachedForAMinute(t *testing.T) {
	clk := newClock()
	src := &stubSource{settings: map[string]string{service.SettingPaymentEnabled: "true"}}
	subscribed(src, progressWith(win(20, 20, dailyResets), nil, nil))
	c := newComponent(src, clk.now)
	for i := 0; i < 3; i++ {
		clk.advance(6 * time.Second) // past the 5 s fact cache, within the link cache
		d := c.Describe(describeCtx(nil), testRefusal(http.StatusTooManyRequests, "USAGE_LIMIT_EXCEEDED", "daily usage limit exceeded"))
		require.Equal(t, actionGetMoreUsage, d.Action)
	}
	require.Equal(t, 1, src.count("Settings"))
	require.Equal(t, 3, src.count("ActiveSubscription"))
	clk.advance(time.Minute)
	c.Describe(describeCtx(nil), testRefusal(http.StatusTooManyRequests, "USAGE_LIMIT_EXCEEDED", "daily usage limit exceeded"))
	require.Equal(t, 2, src.count("Settings"))
}

func TestFactsAreCachedFiveSecondsPerKeyAndKind(t *testing.T) {
	clk := newClock()
	src := &stubSource{}
	keyWith(src, service.APIKey{RateLimit5h: 2}, service.APIKeyRateLimitData{Usage5h: 2, Window5hStart: timep(testNow)})
	c := newComponent(src, clk.now)
	refusal := testRefusal(http.StatusTooManyRequests, "API_KEY_RATE_5H_EXCEEDED", "")

	first := c.Describe(describeCtx(nil), refusal)
	require.Equal(t, 5*3600, first.RetryAfterSeconds)
	clk.advance(4 * time.Second)
	second := c.Describe(describeCtx(nil), refusal)
	require.Equal(t, 1, src.count("APIKey"), "cached for 5 s")
	require.Equal(t, 1, src.count("RateLimitData"))
	require.Equal(t, 5*3600-4, second.RetryAfterSeconds, "retry_after is computed from the current time, not cached")

	// Another key is another entry.
	other := refusal
	other.APIKeyID = 813
	g := describeCtx(nil)
	d, _ := gatewayhook.Device(g)
	d.APIKeyID = 813
	gctxKey(g, 813)
	c.Describe(g, other)
	require.Equal(t, 2, src.count("APIKey"))

	// The same key but another data kind is another entry.
	subscribed(src, progressWith(nil, win(100, 100, weeklyResets), nil))
	c.Describe(describeCtx(nil), testRefusal(http.StatusTooManyRequests, "USAGE_LIMIT_EXCEEDED", "weekly usage limit exceeded"))
	require.Equal(t, 1, src.count("ActiveSubscription"))

	clk.advance(2 * time.Second) // 6 s after the first lookup
	c.Describe(describeCtx(nil), refusal)
	require.Equal(t, 3, src.count("APIKey"), "expired after 5 s")
}

// gctxKey replaces the key the gateway loaded for the request.
func gctxKey(g *gin.Context, id int64) {
	middleware.SetOpsFallbackAPIKey(g, &service.APIKey{ID: id, UserID: testUserID, GroupID: int64p(testGroupID)})
}

func TestFailedLookupsAreCachedToo(t *testing.T) {
	clk := newClock()
	src := &stubSource{keyErr: errStubDB}
	c := newComponent(src, clk.now)
	refusal := testRefusal(http.StatusTooManyRequests, "API_KEY_QUOTA_EXHAUSTED", "API key 额度已用完")
	for i := 0; i < 5; i++ {
		d := c.Describe(describeCtx(nil), refusal)
		require.Equal(t, ReasonKeyQuotaExhausted, d.Reason, "the reason does not need the data")
		require.Nil(t, d.LimitUSD)
	}
	require.Equal(t, 1, src.count("APIKey"), "a database outage costs one lookup per key every 5 s")
}

func TestDeviceCheckBypassesTheCache(t *testing.T) {
	src := &stubSource{}
	src.setRevoked(false)
	c := newComponent(src, func() time.Time { return testNow })
	refusal := testRefusal(http.StatusUnauthorized, "API_KEY_DISABLED", "API key is disabled")
	require.Equal(t, ReasonKeyDisabled, c.Describe(describeCtx(nil), refusal).Reason)
	src.setRevoked(true) // revoked on another node a moment ago
	require.Equal(t, ReasonDeviceRevoked, c.Describe(describeCtx(nil), refusal).Reason)
	require.Equal(t, 2, src.count("DeviceRevoked"))
}

// A device mark that already says revoked answers without a query: a revoked
// device retrying its key must not cost a database read per request.
func TestRevokedMarkNeedsNoQuery(t *testing.T) {
	src := &stubSource{}
	c := newComponent(src, func() time.Time { return testNow })
	refusal := testRefusal(http.StatusUnauthorized, "API_KEY_DISABLED", "API key is disabled")
	for i := 0; i < 5; i++ {
		g := describeCtx(nil)
		d, _ := gatewayhook.Device(g)
		d.Revoked = true
		require.Equal(t, ReasonDeviceRevoked, c.Describe(g, refusal).Reason)
	}
	require.Zero(t, src.count("DeviceRevoked"))
}

func TestConcurrentRefusalsShareOneLookup(t *testing.T) {
	src := &stubSource{delay: 30 * time.Millisecond}
	keyWith(src, service.APIKey{RateLimit5h: 2}, service.APIKeyRateLimitData{Usage5h: 2, Window5hStart: timep(testNow)})
	subscribed(src, progressWith(nil, win(100, 100, weeklyResets), nil))
	src.revoked, src.deviceFound = true, true
	c := newComponent(src, func() time.Time { return testNow })

	const n = 64
	var wg sync.WaitGroup
	results := make([][]byte, n)
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			var r gatewayhook.Refusal
			switch i % 3 {
			case 0:
				r = testRefusal(http.StatusTooManyRequests, "API_KEY_RATE_5H_EXCEEDED", "")
			case 1:
				r = testRefusal(http.StatusTooManyRequests, "USAGE_LIMIT_EXCEEDED", "weekly usage limit exceeded")
			default:
				r = testRefusal(http.StatusUnauthorized, "API_KEY_DISABLED", "API key is disabled")
			}
			raw, err := json.Marshal(c.Describe(describeCtx(nil), r))
			if err == nil {
				results[i] = raw
			}
		}(i)
	}
	close(start)
	wg.Wait()
	for i := 3; i < n; i++ {
		require.Equal(t, string(results[i%3]), string(results[i]), "result %d", i)
	}
	require.Equal(t, 1, src.count("APIKey"))
	require.Equal(t, 1, src.count("RateLimitData"))
	require.Equal(t, 1, src.count("ActiveSubscription"))
	require.Equal(t, 1, src.count("SubscriptionProgress"))
	require.Less(t, src.count("DeviceRevoked"), n/3, "concurrent device checks share a query")
}

func TestFactCacheStaysBounded(t *testing.T) {
	clk := newClock()
	fc := newFactCache(time.Second, 8, clk.now)
	ctx := context.Background()
	for i := 0; i < 100; i++ {
		v := cached(ctx, fc, "k"+strconv.Itoa(i), func(context.Context) int { return i })
		require.Equal(t, i, v)
		require.LessOrEqual(t, fc.size(), 8)
	}
	fc = newFactCache(time.Second, 8, clk.now)
	for i := 0; i < 8; i++ {
		cached(ctx, fc, "k"+strconv.Itoa(i), func(context.Context) int { return i })
	}
	require.Equal(t, 8, fc.size())
	clk.advance(2 * time.Second)
	cached(ctx, fc, "fresh", func(context.Context) int { return 1 })
	require.Equal(t, 1, fc.size(), "expired entries are swept when the cache is full")
	require.Equal(t, 1, cached(ctx, fc, "fresh", func(context.Context) int { return 2 }), "still cached")
}

func TestLookupsIgnoreTheCallersCancellation(t *testing.T) {
	src := &stubSource{}
	keyWith(src, service.APIKey{Quota: 10, QuotaUsed: 10}, service.APIKeyRateLimitData{})
	c := newComponent(src, func() time.Time { return testNow })
	g := describeCtx(nil)
	ctx, cancel := context.WithCancel(g.Request.Context())
	cancel() // the client went away while the refusal was being written
	g.Request = g.Request.WithContext(ctx)
	d := c.Describe(g, testRefusal(http.StatusTooManyRequests, "API_KEY_QUOTA_EXHAUSTED", ""))
	require.Equal(t, f64p(10), d.LimitUSD, "the shared lookup is not cut short by one request")
}

func TestNewReadsTheModuleClock(t *testing.T) {
	c := New(nil)
	require.Equal(t, "refusals", c.Name())
	require.WithinDuration(t, time.Now(), c.now(), time.Minute)
	// Without dependencies every lookup is unavailable and the reason still comes out.
	d := c.Describe(describeCtx(nil), testRefusal(http.StatusTooManyRequests, "USAGE_LIMIT_EXCEEDED", "weekly usage limit exceeded"))
	require.Equal(t, ReasonSubscriptionWeeklyLimit, d.Reason)
	require.Nil(t, d.ResetsAt)
	d = c.Describe(describeCtx(nil), testRefusal(http.StatusUnauthorized, "API_KEY_DISABLED", ""))
	require.Equal(t, ReasonKeyDisabled, d.Reason)
}
