package refusal

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/gatewayhook"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// Subscription windows at testNow (2026-09-26 02:30 UTC).
var (
	dailyResets   = time.Date(2026, 9, 27, 0, 0, 0, 0, time.UTC)  // 77400 s away
	weeklyResets  = time.Date(2026, 9, 29, 0, 0, 0, 0, time.UTC)  // 250200 s away
	monthlyResets = time.Date(2026, 10, 10, 8, 0, 0, 0, time.UTC) // 1229400 s away
)

func progressWith(daily, weekly, monthly *service.UsageWindowProgress) *service.SubscriptionProgress {
	return &service.SubscriptionProgress{ID: 77, GroupName: "claudex-pro", Daily: daily, Weekly: weekly, Monthly: monthly}
}

func win(limit, used float64, resets time.Time) *service.UsageWindowProgress {
	return &service.UsageWindowProgress{LimitUSD: limit, UsedUSD: used, ResetsAt: resets}
}

func subscribed(s *stubSource, p *service.SubscriptionProgress) {
	s.sub = &service.UserSubscription{ID: 77, UserID: testUserID, GroupID: testGroupID, Status: service.SubscriptionStatusActive}
	s.progress = p
}

// keyWith gives the stub key rate limits and quota; the windows started at
// the given times (nil = no window).
func keyWith(s *stubSource, k service.APIKey, rate service.APIKeyRateLimitData) {
	k.ID, k.UserID, k.GroupID = testAPIKeyID, testUserID, int64p(testGroupID)
	s.key = &k
	s.rate = &rate
}

// TestDecisionTable has one case per row of the design 2.7 table (and the
// variants a row covers). Each expectation is the "claudex" object the
// describer returns, as JSON; EnrichRefusals then sets v:1 and, for an empty
// message, the upstream message.
func TestDecisionTable(t *testing.T) {
	type tc struct {
		name    string
		setup   func(s *stubSource)
		headers map[string]string
		refusal gatewayhook.Refusal
		markRev bool // the device mark says revoked (B4's 5 s cache)
		want    string
	}
	cases := []tc{
		// SUBSCRIPTION_{DAILY,WEEKLY,MONTHLY}_LIMIT
		{
			name: "SUBSCRIPTION_WEEKLY_LIMIT from USAGE_LIMIT_EXCEEDED",
			setup: func(s *stubSource) {
				subscribed(s, progressWith(win(20, 4, dailyResets), win(100, 100.4, weeklyResets), nil))
			},
			refusal: testRefusal(http.StatusTooManyRequests, "USAGE_LIMIT_EXCEEDED",
				`error: code=429 reason="WEEKLY_LIMIT_EXCEEDED" message="weekly usage limit exceeded" metadata=map[]`),
			want: `{"v":0,"reason":"SUBSCRIPTION_WEEKLY_LIMIT","kind":"usage_limit","window":"7d","resets_at":"2026-09-29T00:00:00Z",
				"retry_after_seconds":250200,"limit_usd":100,"used_usd":100.4,"reprovision":false,"action":"wait",
				"message":"You've reached your weekly usage limit. It resets Sep 29, 12:00 AM UTC."}`,
		},
		{
			name: "SUBSCRIPTION_DAILY_LIMIT from billing_error with a purchase link",
			setup: func(s *stubSource) {
				subscribed(s, progressWith(win(20, 20, dailyResets), win(100, 30, weeklyResets), nil))
				s.settings = map[string]string{service.SettingPaymentEnabled: "true"}
			},
			refusal: testRefusal(http.StatusForbidden, "billing_error", "daily usage limit exceeded"),
			want: `{"v":0,"reason":"SUBSCRIPTION_DAILY_LIMIT","kind":"usage_limit","window":"1d","resets_at":"2026-09-27T00:00:00Z",
				"retry_after_seconds":77400,"limit_usd":20,"used_usd":20,"reprovision":false,"action":"get_more_usage",
				"message":"You've reached your daily usage limit. It resets Sep 27, 12:00 AM UTC."}`,
		},
		{
			name: "SUBSCRIPTION_MONTHLY_LIMIT from rate_limit_exceeded when the monthly window is full",
			setup: func(s *stubSource) {
				keyWith(s, service.APIKey{}, service.APIKeyRateLimitData{})
				subscribed(s, progressWith(nil, win(100, 10, weeklyResets), win(300, 301, monthlyResets)))
			},
			refusal: testRefusal(http.StatusTooManyRequests, "rate_limit_exceeded", "quota window reached"),
			want: `{"v":0,"reason":"SUBSCRIPTION_MONTHLY_LIMIT","kind":"usage_limit","window":"30d","resets_at":"2026-10-10T08:00:00Z",
				"retry_after_seconds":1229400,"limit_usd":300,"used_usd":301,"reprovision":false,"action":"wait",
				"message":"You've reached your monthly usage limit. It resets Oct 10, 8:00 AM UTC."}`,
		},
		{
			name: "several full windows: the one that resets last",
			setup: func(s *stubSource) {
				subscribed(s, progressWith(win(20, 25, dailyResets), win(100, 100, weeklyResets), nil))
			},
			refusal: testRefusal(http.StatusTooManyRequests, "USAGE_LIMIT_EXCEEDED", "daily usage limit exceeded"),
			want: `{"v":0,"reason":"SUBSCRIPTION_WEEKLY_LIMIT","kind":"usage_limit","window":"7d","resets_at":"2026-09-29T00:00:00Z",
				"retry_after_seconds":250200,"limit_usd":100,"used_usd":100,"reprovision":false,"action":"wait",
				"message":"You've reached your weekly usage limit. It resets Sep 29, 12:00 AM UTC."}`,
		},
		{
			name: "no window full yet (usage lags): the window in the message",
			setup: func(s *stubSource) {
				subscribed(s, progressWith(win(20, 19.5, dailyResets), win(100, 30, weeklyResets), nil))
			},
			refusal: testRefusal(http.StatusTooManyRequests, "USAGE_LIMIT_EXCEEDED", "daily usage limit exceeded"),
			want: `{"v":0,"reason":"SUBSCRIPTION_DAILY_LIMIT","kind":"usage_limit","window":"1d","resets_at":"2026-09-27T00:00:00Z",
				"retry_after_seconds":77400,"limit_usd":20,"used_usd":19.5,"reprovision":false,"action":"wait",
				"message":"You've reached your daily usage limit. It resets Sep 27, 12:00 AM UTC."}`,
		},
		{
			name: "the window in the message already rolled over: no reset time in the past",
			setup: func(s *stubSource) {
				subscribed(s, progressWith(win(20, 25, testNow.Add(-time.Minute)), win(100, 30, weeklyResets), nil))
			},
			refusal: testRefusal(http.StatusTooManyRequests, "USAGE_LIMIT_EXCEEDED", "daily usage limit exceeded"),
			want: `{"v":0,"reason":"SUBSCRIPTION_DAILY_LIMIT","kind":"usage_limit","window":"1d","reprovision":false,"action":"wait",
				"message":"You've reached your daily usage limit."}`,
		},
		{
			name: "the key window in the message is not running: no usage of zero",
			setup: func(s *stubSource) {
				keyWith(s, service.APIKey{RateLimit5h: 2}, service.APIKeyRateLimitData{Usage5h: 3, Window5hStart: timep(testNow.Add(-6 * time.Hour))})
			},
			refusal: testRefusal(http.StatusTooManyRequests, "API_KEY_RATE_5H_EXCEEDED", "api key 5小时限额已用完"),
			want: `{"v":0,"reason":"KEY_5H_LIMIT","kind":"key_limit","window":"5h","reprovision":false,"action":"wait",
				"message":"This device has reached its 5-hour limit."}`,
		},
		{
			name:    "subscription data unavailable: the window in the message, without data",
			setup:   func(s *stubSource) { s.subErr = errStubDB },
			refusal: testRefusal(http.StatusTooManyRequests, "USAGE_LIMIT_EXCEEDED", "monthly usage limit exceeded"),
			want: `{"v":0,"reason":"SUBSCRIPTION_MONTHLY_LIMIT","kind":"usage_limit","window":"30d","reprovision":false,"action":"wait",
				"message":"You've reached your monthly usage limit."}`,
		},
		{
			name: "a window that already rolled over is not full",
			setup: func(s *stubSource) {
				subscribed(s, progressWith(win(20, 25, testNow.Add(-time.Minute)), win(100, 100, weeklyResets), nil))
			},
			refusal: testRefusal(http.StatusForbidden, "billing_error", "Billing error"),
			want: `{"v":0,"reason":"SUBSCRIPTION_WEEKLY_LIMIT","kind":"usage_limit","window":"7d","resets_at":"2026-09-29T00:00:00Z",
				"retry_after_seconds":250200,"limit_usd":100,"used_usd":100,"reprovision":false,"action":"wait",
				"message":"You've reached your weekly usage limit. It resets Sep 29, 12:00 AM UTC."}`,
		},

		// SUBSCRIPTION_EXPIRED / SUBSCRIPTION_SUSPENDED / SUBSCRIPTION_NOT_FOUND
		{
			name: "SUBSCRIPTION_EXPIRED from SUBSCRIPTION_INVALID",
			refusal: testRefusal(http.StatusForbidden, "SUBSCRIPTION_INVALID",
				`error: code=403 reason="SUBSCRIPTION_EXPIRED" message="subscription has expired" metadata=map[]`),
			want: `{"v":0,"reason":"SUBSCRIPTION_EXPIRED","kind":"subscription","reprovision":false,"action":"contact_admin",
				"message":"Your subscription has expired. Contact your administrator."}`,
		},
		{
			name: "SUBSCRIPTION_SUSPENDED from SUBSCRIPTION_INVALID",
			refusal: testRefusal(http.StatusForbidden, "SUBSCRIPTION_INVALID",
				`error: code=403 reason="SUBSCRIPTION_SUSPENDED" message="subscription is suspended" metadata=map[]`),
			want: `{"v":0,"reason":"SUBSCRIPTION_SUSPENDED","kind":"subscription","reprovision":false,"action":"contact_admin",
				"message":"Your subscription is suspended. Contact your administrator."}`,
		},
		{
			name:    "SUBSCRIPTION_SUSPENDED from billing_error: the stored status decides",
			setup:   func(s *stubSource) { s.subStatus, s.subFound = service.SubscriptionStatusSuspended, true },
			refusal: testRefusal(http.StatusForbidden, "billing_error", "subscription is invalid or expired"),
			want: `{"v":0,"reason":"SUBSCRIPTION_SUSPENDED","kind":"subscription","reprovision":false,"action":"contact_admin",
				"message":"Your subscription is suspended. Contact your administrator."}`,
		},
		{
			name:    "SUBSCRIPTION_EXPIRED from billing_error when the status is not suspended",
			setup:   func(s *stubSource) { s.subStatus, s.subFound = "expired", true },
			refusal: testRefusal(http.StatusForbidden, "billing_error", "subscription is invalid or expired"),
			want: `{"v":0,"reason":"SUBSCRIPTION_EXPIRED","kind":"subscription","reprovision":false,"action":"contact_admin",
				"message":"Your subscription has expired. Contact your administrator."}`,
		},
		{
			name:    "SUBSCRIPTION_NOT_FOUND",
			refusal: testRefusal(http.StatusForbidden, "SUBSCRIPTION_NOT_FOUND", "No active subscription found for this group"),
			want: `{"v":0,"reason":"SUBSCRIPTION_NOT_FOUND","kind":"subscription","reprovision":true,"action":"contact_admin",
				"message":"You don't have an active subscription for this plan. Contact your administrator."}`,
		},

		// KEY_{5H,1D,7D}_LIMIT
		{
			name: "KEY_5H_LIMIT from rate_limit_exceeded",
			setup: func(s *stubSource) {
				keyWith(s, service.APIKey{RateLimit5h: 2}, service.APIKeyRateLimitData{Usage5h: 2.1, Window5hStart: timep(testNow.Add(-time.Hour))})
			},
			refusal: testRefusal(http.StatusTooManyRequests, "rate_limit_exceeded", "api key 5小时限额已用完"),
			want: `{"v":0,"reason":"KEY_5H_LIMIT","kind":"key_limit","window":"5h","resets_at":"2026-09-26T06:30:00Z",
				"retry_after_seconds":14400,"limit_usd":2,"used_usd":2.1,"reprovision":false,"action":"wait",
				"message":"This device has reached its 5-hour limit. It resets Sep 26, 6:30 AM UTC."}`,
		},
		{
			name: "KEY_1D_LIMIT from API_KEY_RATE_1D_EXCEEDED",
			setup: func(s *stubSource) {
				keyWith(s, service.APIKey{RateLimit1d: 5}, service.APIKeyRateLimitData{Usage1d: 5, Window1dStart: timep(time.Date(2026, 9, 25, 20, 0, 0, 0, time.UTC))})
			},
			refusal: testRefusal(http.StatusTooManyRequests, "API_KEY_RATE_1D_EXCEEDED", "api key 日限额已用完"),
			want: `{"v":0,"reason":"KEY_1D_LIMIT","kind":"key_limit","window":"1d","resets_at":"2026-09-26T20:00:00Z",
				"retry_after_seconds":63000,"limit_usd":5,"used_usd":5,"reprovision":false,"action":"wait",
				"message":"This device has reached its daily limit. It resets Sep 26, 8:00 PM UTC."}`,
		},
		{
			name: "KEY_7D_LIMIT from rate_limit_exceeded with an unknown message: the full key window",
			setup: func(s *stubSource) {
				keyWith(s, service.APIKey{RateLimit5h: 2, RateLimit7d: 20},
					service.APIKeyRateLimitData{Usage5h: 0.5, Window5hStart: timep(testNow.Add(-time.Hour)),
						Usage7d: 20.5, Window7dStart: timep(time.Date(2026, 9, 20, 12, 0, 0, 0, time.UTC))})
			},
			refusal: testRefusal(http.StatusTooManyRequests, "rate_limit_exceeded", "limit reached"),
			want: `{"v":0,"reason":"KEY_7D_LIMIT","kind":"key_limit","window":"7d","resets_at":"2026-09-27T12:00:00Z",
				"retry_after_seconds":120600,"limit_usd":20,"used_usd":20.5,"reprovision":false,"action":"wait",
				"message":"This device has reached its weekly limit. It resets Sep 27, 12:00 PM UTC."}`,
		},

		// KEY_QUOTA_EXHAUSTED
		{
			name: "KEY_QUOTA_EXHAUSTED from API_KEY_QUOTA_EXHAUSTED",
			setup: func(s *stubSource) {
				keyWith(s, service.APIKey{Quota: 50, QuotaUsed: 50}, service.APIKeyRateLimitData{})
			},
			refusal: testRefusal(http.StatusTooManyRequests, "API_KEY_QUOTA_EXHAUSTED", "API key 额度已用完"),
			want: `{"v":0,"reason":"KEY_QUOTA_EXHAUSTED","kind":"key_limit","limit_usd":50,"used_usd":50,"reprovision":false,
				"action":"contact_admin","message":"This device has used its full quota. Contact your administrator."}`,
		},
		{
			name: "KEY_QUOTA_EXHAUSTED from insufficient_quota (Responses routes)",
			setup: func(s *stubSource) {
				keyWith(s, service.APIKey{Quota: 50, QuotaUsed: 50.25}, service.APIKeyRateLimitData{})
			},
			refusal: testRefusal(http.StatusTooManyRequests, "insufficient_quota", "API key 额度已用完"),
			want: `{"v":0,"reason":"KEY_QUOTA_EXHAUSTED","kind":"key_limit","limit_usd":50,"used_usd":50.25,"reprovision":false,
				"action":"contact_admin","message":"This device has used its full quota. Contact your administrator."}`,
		},
		{
			name: "insufficient_quota from an upstream account while the key has quota left is UNKNOWN",
			setup: func(s *stubSource) {
				keyWith(s, service.APIKey{Quota: 50, QuotaUsed: 3}, service.APIKeyRateLimitData{})
			},
			refusal: testRefusal(http.StatusTooManyRequests, "insufficient_quota", "You exceeded your current quota"),
			want:    `{"v":0,"reason":"UNKNOWN","kind":"unknown","reprovision":false,"action":"none","message":""}`,
		},

		// KEY_EXPIRED / DEVICE_REVOKED / KEY_DISABLED
		{
			name:    "KEY_EXPIRED",
			refusal: testRefusal(http.StatusForbidden, "API_KEY_EXPIRED", "API key 已过期"),
			want: `{"v":0,"reason":"KEY_EXPIRED","kind":"key","reprovision":true,"action":"none",
				"message":"This device's key has expired. Claudex will set up a new one."}`,
		},
		{
			name:    "DEVICE_REVOKED: claudex_devices says revoked although the device mark is stale",
			setup:   func(s *stubSource) { s.revoked, s.deviceFound = true, true },
			refusal: testRefusal(http.StatusUnauthorized, "API_KEY_DISABLED", "API key is disabled"),
			want: `{"v":0,"reason":"DEVICE_REVOKED","kind":"key","reprovision":false,"action":"sign_in",
				"message":"This device was signed out. Sign in again to keep working."}`,
		},
		{
			name:    "KEY_DISABLED: the device is not revoked",
			setup:   func(s *stubSource) { s.revoked, s.deviceFound = false, true },
			refusal: testRefusal(http.StatusUnauthorized, "API_KEY_DISABLED", "API key is disabled"),
			want: `{"v":0,"reason":"KEY_DISABLED","kind":"key","reprovision":true,"action":"none",
				"message":"This device's key is no longer active. Claudex will set it up again."}`,
		},
		{
			name:    "KEY_DISABLED: the device row is gone",
			refusal: testRefusal(http.StatusUnauthorized, "API_KEY_DISABLED", "API key is disabled"),
			markRev: false,
			want: `{"v":0,"reason":"KEY_DISABLED","kind":"key","reprovision":true,"action":"none",
				"message":"This device's key is no longer active. Claudex will set it up again."}`,
		},
		{
			name:    "DEVICE_REVOKED: the table cannot be read, the device mark decides",
			setup:   func(s *stubSource) { s.deviceErr = errStubDB },
			markRev: true,
			refusal: testRefusal(http.StatusUnauthorized, "API_KEY_DISABLED", "API key is disabled"),
			want: `{"v":0,"reason":"DEVICE_REVOKED","kind":"key","reprovision":false,"action":"sign_in",
				"message":"This device was signed out. Sign in again to keep working."}`,
		},

		// BALANCE_INSUFFICIENT
		{
			name:    "BALANCE_INSUFFICIENT from INSUFFICIENT_BALANCE",
			refusal: testRefusal(http.StatusForbidden, "INSUFFICIENT_BALANCE", "Insufficient account balance"),
			want: `{"v":0,"reason":"BALANCE_INSUFFICIENT","kind":"balance","reprovision":false,"action":"get_more_usage",
				"message":"Your balance is too low for this request."}`,
		},
		{
			name:    "BALANCE_INSUFFICIENT from billing_error",
			refusal: testRefusal(http.StatusForbidden, "billing_error", "insufficient balance"),
			want: `{"v":0,"reason":"BALANCE_INSUFFICIENT","kind":"balance","reprovision":false,"action":"get_more_usage",
				"message":"Your balance is too low for this request."}`,
		},

		// USER_RPM_LIMIT / GROUP_RPM_LIMIT
		{
			name:    "USER_RPM_LIMIT",
			headers: map[string]string{"Retry-After": "12"},
			refusal: testRefusal(http.StatusTooManyRequests, "rate_limit_exceeded", "user requests-per-minute limit exceeded"),
			want: `{"v":0,"reason":"USER_RPM_LIMIT","kind":"rate_limit","window":"1m","resets_at":"2026-09-26T02:30:12Z",
				"retry_after_seconds":12,"reprovision":false,"action":"wait","message":"Too many requests. Try again in 12 seconds."}`,
		},
		{
			name:    "GROUP_RPM_LIMIT",
			headers: map[string]string{"Retry-After": "1"},
			refusal: testRefusal(http.StatusTooManyRequests, "rate_limit_exceeded", "group requests-per-minute limit exceeded"),
			want: `{"v":0,"reason":"GROUP_RPM_LIMIT","kind":"rate_limit","window":"1m","resets_at":"2026-09-26T02:30:01Z",
				"retry_after_seconds":1,"reprovision":false,"action":"wait","message":"Too many requests. Try again in 1 second."}`,
		},

		// PLATFORM_{DAILY,WEEKLY,MONTHLY}_QUOTA
		{
			name:    "PLATFORM_DAILY_QUOTA",
			headers: map[string]string{"Retry-After": "3600"},
			refusal: testRefusal(http.StatusTooManyRequests, "rate_limit_exceeded", "Daily usage quota exhausted for this platform."),
			want: `{"v":0,"reason":"PLATFORM_DAILY_QUOTA","kind":"usage_limit","window":"1d","resets_at":"2026-09-26T03:30:00Z",
				"retry_after_seconds":3600,"reprovision":false,"action":"wait",
				"message":"You've reached your daily usage quota. It resets Sep 26, 3:30 AM UTC."}`,
		},
		{
			name:    "PLATFORM_WEEKLY_QUOTA",
			headers: map[string]string{"Retry-After": "86400"},
			refusal: testRefusal(http.StatusTooManyRequests, "rate_limit_exceeded", "Weekly usage quota exhausted for this platform."),
			want: `{"v":0,"reason":"PLATFORM_WEEKLY_QUOTA","kind":"usage_limit","window":"7d","resets_at":"2026-09-27T02:30:00Z",
				"retry_after_seconds":86400,"reprovision":false,"action":"wait",
				"message":"You've reached your weekly usage quota. It resets Sep 27, 2:30 AM UTC."}`,
		},
		{
			name:    "PLATFORM_MONTHLY_QUOTA without Retry-After",
			refusal: testRefusal(http.StatusTooManyRequests, "rate_limit_exceeded", "Monthly usage quota exhausted for this platform."),
			want: `{"v":0,"reason":"PLATFORM_MONTHLY_QUOTA","kind":"usage_limit","window":"30d","reprovision":false,"action":"wait",
				"message":"You've reached your monthly usage quota."}`,
		},

		// GROUP_UNAVAILABLE
		{
			name:    "GROUP_UNAVAILABLE from GROUP_DISABLED",
			refusal: testRefusal(http.StatusForbidden, "GROUP_DISABLED", "API Key 所属分组已停用"),
			want: `{"v":0,"reason":"GROUP_UNAVAILABLE","kind":"group","reprovision":true,"action":"none",
				"message":"This device's plan is no longer available. Claudex will set it up again."}`,
		},
		{
			name:    "GROUP_UNAVAILABLE from GROUP_DELETED",
			refusal: testRefusal(http.StatusForbidden, "GROUP_DELETED", "API Key 所属分组已删除"),
			want: `{"v":0,"reason":"GROUP_UNAVAILABLE","kind":"group","reprovision":true,"action":"none",
				"message":"This device's plan is no longer available. Claudex will set it up again."}`,
		},
		{
			name:    "GROUP_UNAVAILABLE from GROUP_NOT_ALLOWED",
			refusal: testRefusal(http.StatusForbidden, "GROUP_NOT_ALLOWED", "API Key 所属专属分组不再允许当前用户使用"),
			want: `{"v":0,"reason":"GROUP_UNAVAILABLE","kind":"group","reprovision":true,"action":"none",
				"message":"This device's plan is no longer available. Claudex will set it up again."}`,
		},

		// USER_INACTIVE
		{
			name:    "USER_INACTIVE",
			refusal: testRefusal(http.StatusUnauthorized, "USER_INACTIVE", "User account is not active"),
			want: `{"v":0,"reason":"USER_INACTIVE","kind":"account","reprovision":false,"action":"contact_admin",
				"message":"Your account is disabled. Contact your administrator."}`,
		},
		{
			name:    "USER_INACTIVE from USER_NOT_FOUND",
			refusal: testRefusal(http.StatusUnauthorized, "USER_NOT_FOUND", "User associated with API key not found"),
			want: `{"v":0,"reason":"USER_INACTIVE","kind":"account","reprovision":false,"action":"contact_admin",
				"message":"Your account is disabled. Contact your administrator."}`,
		},

		// UNKNOWN
		{
			name:    "UNKNOWN: another 4xx keeps the upstream message",
			refusal: testRefusal(http.StatusForbidden, "ACCESS_DENIED", "Access denied. Your IP is 203.0.113.9"),
			want:    `{"v":0,"reason":"UNKNOWN","kind":"unknown","reprovision":false,"action":"none","message":""}`,
		},
		{
			name:    "UNKNOWN: an upstream 429 keeps its Retry-After",
			headers: map[string]string{"Retry-After": "30"},
			refusal: testRefusal(http.StatusTooManyRequests, "rate_limit_error", "Too many pending requests"),
			want: `{"v":0,"reason":"UNKNOWN","kind":"unknown","retry_after_seconds":30,"reprovision":false,"action":"none",
				"message":""}`,
		},
		{
			name:    "UNKNOWN: rate_limit_exceeded that no window explains",
			setup:   func(s *stubSource) { keyWith(s, service.APIKey{}, service.APIKeyRateLimitData{}) },
			refusal: testRefusal(http.StatusTooManyRequests, "rate_limit_exceeded", "slow down"),
			want:    `{"v":0,"reason":"UNKNOWN","kind":"unknown","reprovision":false,"action":"none","message":""}`,
		},
		{
			name:    "UNKNOWN: USAGE_LIMIT_EXCEEDED without a window",
			refusal: testRefusal(http.StatusTooManyRequests, "USAGE_LIMIT_EXCEEDED", "limit"),
			want:    `{"v":0,"reason":"UNKNOWN","kind":"unknown","reprovision":false,"action":"none","message":""}`,
		},
	}

	produced := map[string]bool{}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			src := &stubSource{}
			if tc.setup != nil {
				tc.setup(src)
			}
			c := newComponent(src, func() time.Time { return testNow })
			g := describeCtx(tc.headers)
			if tc.markRev {
				d, _ := gatewayhook.Device(g)
				d.Revoked = true
			}
			detail := c.Describe(g, tc.refusal)
			require.NotNil(t, detail)
			raw, err := json.Marshal(detail)
			require.NoError(t, err)
			require.JSONEq(t, tc.want, string(raw))
			produced[detail.Reason] = true
		})
	}
	// Every reason of the table has at least one case.
	for _, reason := range allReasons {
		require.True(t, produced[reason], "no case produces %s", reason)
	}
}

var allReasons = []string{
	ReasonSubscriptionDailyLimit, ReasonSubscriptionWeeklyLimit, ReasonSubscriptionMonthlyLimit,
	ReasonSubscriptionExpired, ReasonSubscriptionSuspended, ReasonSubscriptionNotFound,
	ReasonKey5hLimit, ReasonKey1dLimit, ReasonKey7dLimit, ReasonKeyQuotaExhausted, ReasonKeyExpired,
	ReasonDeviceRevoked, ReasonKeyDisabled, ReasonBalanceInsufficient, ReasonUserRPMLimit, ReasonGroupRPMLimit,
	ReasonPlatformDailyQuota, ReasonPlatformWeeklyQuota, ReasonPlatformMonthlyQuota,
	ReasonGroupUnavailable, ReasonUserInactive, ReasonUnknown,
}

func TestOnlyDeviceKeysAreDescribed(t *testing.T) {
	src := &stubSource{}
	keyWith(src, service.APIKey{Quota: 1, QuotaUsed: 1}, service.APIKeyRateLimitData{})
	c := newComponent(src, func() time.Time { return testNow })
	rec := httptest.NewRecorder()
	g, _ := gin.CreateTestContext(rec)
	g.Request = httptest.NewRequest(http.MethodPost, "/v1/responses", nil)
	require.Nil(t, c.Describe(g, testRefusal(http.StatusTooManyRequests, "API_KEY_QUOTA_EXHAUSTED", "")))
	require.Nil(t, c.Describe(nil, testRefusal(http.StatusTooManyRequests, "API_KEY_QUOTA_EXHAUSTED", "")))
	require.Zero(t, src.count("APIKey"), "no lookups for other keys")
}

func TestDescribeUsesTheKeyGroupOfTheRequest(t *testing.T) {
	src := &stubSource{}
	subscribed(src, progressWith(nil, win(100, 100, weeklyResets), nil))
	c := newComponent(src, func() time.Time { return testNow })
	g := describeCtx(nil)
	r := testRefusal(http.StatusTooManyRequests, "USAGE_LIMIT_EXCEEDED", "weekly usage limit exceeded")
	r.GroupID = int64p(99) // the device row still names the old plan group
	detail := c.Describe(g, r)
	require.Equal(t, ReasonSubscriptionWeeklyLimit, detail.Reason)
	require.NotNil(t, detail.ResetsAt)
	// The lookup went to the key's group (4): the cache key says so.
	_, ok := c.facts.lookup("sub:812:7:4")
	require.True(t, ok)
}
