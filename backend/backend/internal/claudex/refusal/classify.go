package refusal

import (
	"strings"

	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/service"
)

// class is what an upstream rejection is about, decided from its code and
// message alone (no lookups). The describer then adds the data.
type class int

const (
	classUnknown class = iota
	classSubscriptionLimit
	classSubscriptionState
	classSubscriptionNotFound
	classKeyWindow
	classKeyQuota
	classKeyQuotaUnproven // insufficient_quota without the key's own message
	classKeyExpired
	classKeyDisabled
	classBalance
	classUserInactive
	classGroupUnavailable
	classUserRPM
	classGroupRPM
	classPlatformQuota
	// classWindowGuess: billing_error / rate_limit_exceeded with a message
	// this fork does not know; the describer recomputes the windows.
	classWindowGuess
)

// verdict is the result of classify.
type verdict struct {
	class class
	// window: the window named by the code or message ("" when unknown).
	window string
	// state: "expired" or "suspended" for classSubscriptionState when the
	// message says so ("" when the stored status decides).
	state string
	// keyFirst: for classWindowGuess, check the key windows before the
	// subscription windows (rate_limit_exceeded is what the gateway writes
	// for key windows, billing_error for subscription windows).
	keyFirst bool
}

// messageOf is the lower-case message of an upstream error value, so the
// matching follows the upstream wording.
func messageOf(err error) string {
	return strings.ToLower(infraerrors.Message(err))
}

// The messages the gateway handlers write for billing errors (they carry only
// "rate_limit_exceeded" or "billing_error" as code, see billingErrorDetails).
var (
	msgKeyRate5h          = messageOf(service.ErrAPIKeyRateLimit5hExceeded)
	msgKeyRate1d          = messageOf(service.ErrAPIKeyRateLimit1dExceeded)
	msgKeyRate7d          = messageOf(service.ErrAPIKeyRateLimit7dExceeded)
	msgKeyQuota           = messageOf(service.ErrAPIKeyQuotaExhausted)
	msgKeyExpiredUpstream = messageOf(service.ErrAPIKeyExpired)
	msgGroupRPM           = messageOf(service.ErrGroupRPMExceeded)
	msgUserRPM            = messageOf(service.ErrUserRPMExceeded)
	msgPlatformDaily      = messageOf(service.ErrUserPlatformDailyQuotaExhausted)
	msgPlatformWeekly     = messageOf(service.ErrUserPlatformWeeklyQuotaExhausted)
	msgPlatformMonthly    = messageOf(service.ErrUserPlatformMonthlyQuotaExhausted)
	msgBalance            = messageOf(service.ErrInsufficientBalance)
	msgSubInvalid         = messageOf(service.ErrSubscriptionInvalid)
	msgSubExpired         = messageOf(service.ErrSubscriptionExpired)
	msgSubSuspended       = messageOf(service.ErrSubscriptionSuspended)
	msgSubDaily           = messageOf(service.ErrDailyLimitExceeded)
	msgSubWeekly          = messageOf(service.ErrWeeklyLimitExceeded)
	msgSubMonthly         = messageOf(service.ErrMonthlyLimitExceeded)
)

// contains reports whether msg contains the non-empty needle.
func contains(msg, needle string) bool {
	return needle != "" && strings.Contains(msg, needle)
}

// subscriptionWindowIn finds "daily/weekly/monthly usage limit exceeded" in a
// message (the middleware writes the whole upstream error text).
func subscriptionWindowIn(msg string) string {
	switch {
	case contains(msg, msgSubDaily), contains(msg, "daily_limit_exceeded"):
		return window1d
	case contains(msg, msgSubWeekly), contains(msg, "weekly_limit_exceeded"):
		return window7d
	case contains(msg, msgSubMonthly), contains(msg, "monthly_limit_exceeded"):
		return window30d
	}
	return ""
}

// subscriptionStateIn finds "expired" or "suspended" in a subscription
// error; the handler's "subscription is invalid or expired" is ambiguous.
func subscriptionStateIn(msg string) string {
	switch {
	case contains(msg, "suspend"):
		return "suspended"
	case contains(msg, msgSubExpired), contains(msg, "subscription_expired"):
		return "expired"
	}
	return ""
}

// classify decides what a rejection is about from the parsed code and
// message (design 2.7 decision table).
func classify(code, message string) verdict {
	code = strings.ToLower(strings.TrimSpace(code))
	msg := strings.ToLower(strings.TrimSpace(message))

	switch code {
	case "usage_limit_exceeded":
		return verdict{class: classSubscriptionLimit, window: subscriptionWindowIn(msg)}
	case "daily_limit_exceeded":
		return verdict{class: classSubscriptionLimit, window: window1d}
	case "weekly_limit_exceeded":
		return verdict{class: classSubscriptionLimit, window: window7d}
	case "monthly_limit_exceeded":
		return verdict{class: classSubscriptionLimit, window: window30d}
	case "subscription_invalid":
		return verdict{class: classSubscriptionState, state: subscriptionStateIn(msg)}
	case "subscription_expired":
		return verdict{class: classSubscriptionState, state: "expired"}
	case "subscription_suspended":
		return verdict{class: classSubscriptionState, state: "suspended"}
	case "subscription_not_found":
		return verdict{class: classSubscriptionNotFound}
	case "api_key_rate_5h_exceeded":
		return verdict{class: classKeyWindow, window: window5h}
	case "api_key_rate_1d_exceeded":
		return verdict{class: classKeyWindow, window: window1d}
	case "api_key_rate_7d_exceeded":
		return verdict{class: classKeyWindow, window: window7d}
	case "api_key_quota_exhausted":
		return verdict{class: classKeyQuota}
	case "insufficient_quota":
		// The OpenAI-shaped form of API_KEY_QUOTA_EXHAUSTED (Responses routes).
		// The same code can come from an upstream account, so without the
		// key's own message the describer checks the key's quota first.
		if contains(msg, msgKeyQuota) {
			return verdict{class: classKeyQuota}
		}
		return verdict{class: classKeyQuotaUnproven}
	case "api_key_expired":
		return verdict{class: classKeyExpired}
	case "api_key_disabled", "api_key_inactive":
		return verdict{class: classKeyDisabled}
	case "insufficient_balance":
		return verdict{class: classBalance}
	case "user_inactive", "user_not_found":
		return verdict{class: classUserInactive}
	case "group_rpm_exceeded":
		return verdict{class: classGroupRPM, window: window1m}
	case "user_rpm_exceeded":
		return verdict{class: classUserRPM, window: window1m}
	case "user_platform_daily_quota_exhausted":
		return verdict{class: classPlatformQuota, window: window1d}
	case "user_platform_weekly_quota_exhausted":
		return verdict{class: classPlatformQuota, window: window7d}
	case "user_platform_monthly_quota_exhausted":
		return verdict{class: classPlatformQuota, window: window30d}
	case "rate_limit_exceeded", "billing_error":
		return classifyBillingMessage(msg, code == "rate_limit_exceeded")
	}
	if strings.HasPrefix(code, "group_") {
		// GROUP_DISABLED, GROUP_DELETED, GROUP_NOT_ALLOWED and the like.
		return verdict{class: classGroupUnavailable}
	}
	return verdict{class: classUnknown}
}

// classifyBillingMessage reads the message of the gateway's billing errors
// (billingErrorDetails maps every billing error to one of two codes).
func classifyBillingMessage(msg string, keyFirst bool) verdict {
	switch {
	case contains(msg, msgKeyRate5h):
		return verdict{class: classKeyWindow, window: window5h}
	case contains(msg, msgKeyRate1d):
		return verdict{class: classKeyWindow, window: window1d}
	case contains(msg, msgKeyRate7d):
		return verdict{class: classKeyWindow, window: window7d}
	case contains(msg, msgGroupRPM):
		return verdict{class: classGroupRPM, window: window1m}
	case contains(msg, msgUserRPM):
		return verdict{class: classUserRPM, window: window1m}
	case contains(msg, msgPlatformDaily):
		return verdict{class: classPlatformQuota, window: window1d}
	case contains(msg, msgPlatformWeekly):
		return verdict{class: classPlatformQuota, window: window7d}
	case contains(msg, msgPlatformMonthly):
		return verdict{class: classPlatformQuota, window: window30d}
	case contains(msg, msgBalance):
		return verdict{class: classBalance}
	case contains(msg, msgSubInvalid), contains(msg, msgSubExpired), contains(msg, msgSubSuspended):
		return verdict{class: classSubscriptionState, state: subscriptionStateIn(msg)}
	case contains(msg, msgKeyQuota):
		return verdict{class: classKeyQuota}
	case contains(msg, msgKeyExpiredUpstream):
		return verdict{class: classKeyExpired}
	}
	if w := subscriptionWindowIn(msg); w != "" {
		return verdict{class: classSubscriptionLimit, window: w}
	}
	return verdict{class: classWindowGuess, keyFirst: keyFirst}
}
