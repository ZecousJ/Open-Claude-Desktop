package refusal

import (
	"fmt"
	"time"
)

// The English messages of the "claudex" refusal details (design 2.7). The
// desktop client shows them as they are; times are always written in UTC and
// the client may reformat resets_at in the local time zone.

const (
	msgDeviceRevoked        = "This device was signed out. Sign in again to keep working."
	msgKeyDisabled          = "This device's key is no longer active. Claudex will set it up again."
	msgKeyExpired           = "This device's key has expired. Claudex will set up a new one."
	msgKeyQuotaExhausted    = "This device has used its full quota. Contact your administrator."
	msgBalanceInsufficient  = "Your balance is too low for this request."
	msgSubscriptionExpired  = "Your subscription has expired. Contact your administrator."
	msgSubscriptionSuspend  = "Your subscription is suspended. Contact your administrator."
	msgSubscriptionNotFound = "You don't have an active subscription for this plan. Contact your administrator."
	msgGroupUnavailable     = "This device's plan is no longer available. Claudex will set it up again."
	msgUserInactive         = "Your account is disabled. Contact your administrator."
	msgTooManyRequestsLater = "Too many requests. Try again in a moment."
)

// resetTimeLayout formats a reset time: "Sep 29, 12:00 AM".
const resetTimeLayout = "Jan 2, 3:04 PM"

// formatResetTime writes t in UTC, e.g. "Sep 29, 12:00 AM UTC".
func formatResetTime(t time.Time) string {
	return t.UTC().Format(resetTimeLayout) + " UTC"
}

// withReset appends "It resets <time> UTC." to a sentence when the reset time
// is known.
func withReset(sentence string, resetsAt *time.Time) string {
	if resetsAt == nil {
		return sentence
	}
	return sentence + " It resets " + formatResetTime(*resetsAt) + "."
}

// windowNames are the words used for a window in messages.
var subscriptionWindowNames = map[string]string{
	window1d:  "daily",
	window7d:  "weekly",
	window30d: "monthly",
}

var keyWindowNames = map[string]string{
	window5h: "5-hour",
	window1d: "daily",
	window7d: "weekly",
}

// subscriptionLimitMessage: "You've reached your weekly usage limit. It resets Sep 29, 12:00 AM UTC."
func subscriptionLimitMessage(window string, resetsAt *time.Time) string {
	return withReset(fmt.Sprintf("You've reached your %s usage limit.", subscriptionWindowNames[window]), resetsAt)
}

// platformQuotaMessage: "You've reached your daily usage quota. It resets Sep 29, 12:00 AM UTC."
func platformQuotaMessage(window string, resetsAt *time.Time) string {
	return withReset(fmt.Sprintf("You've reached your %s usage quota.", subscriptionWindowNames[window]), resetsAt)
}

// keyLimitMessage: "This device has reached its 5-hour limit. It resets Sep 29, 12:00 AM UTC."
func keyLimitMessage(window string, resetsAt *time.Time) string {
	return withReset(fmt.Sprintf("This device has reached its %s limit.", keyWindowNames[window]), resetsAt)
}

// tooManyRequestsMessage: "Too many requests. Try again in 12 seconds."
func tooManyRequestsMessage(retryAfterSeconds int) string {
	switch {
	case retryAfterSeconds <= 0:
		return msgTooManyRequestsLater
	case retryAfterSeconds == 1:
		return "Too many requests. Try again in 1 second."
	default:
		return fmt.Sprintf("Too many requests. Try again in %d seconds.", retryAfterSeconds)
	}
}
