package service

// CLAUDEX: file added by the Claudex fork (see backend/CLAUDEX_CHANGES.md).
//
// H8: applyUsageBilling reports every request whose usage it applied to the
// Claudex usage rules (B5) through claudexhook.UsageApplied. This file builds
// the event; B0 wrote the first version and B5 owns it afterwards.

import (
	"strings"
	"time"

	claudexhook "github.com/Wei-Shaw/sub2api/internal/claudex/hook"
)

// claudexUsageEventFrom describes one billed request: the model the client
// asked for, the model it was billed as and the model sent upstream (any of
// them may match a per-model rule), the request's group, the billing time and
// the billed cost after multipliers.
func claudexUsageEventFrom(requestID string, usageLog *UsageLog, p *postUsageBillingParams) claudexhook.UsageEvent {
	ev := claudexhook.UsageEvent{RequestID: requestID, At: time.Now().UTC()}
	if p != nil {
		if p.User != nil {
			ev.UserID = p.User.ID
		}
		if p.APIKey != nil {
			ev.APIKeyID = p.APIKey.ID
			ev.GroupID = p.APIKey.GroupID
		}
		if p.Cost != nil {
			ev.CostUSD = p.Cost.ActualCost
		}
	}
	if usageLog != nil {
		if usageLog.UserID > 0 {
			ev.UserID = usageLog.UserID
		}
		if usageLog.APIKeyID > 0 {
			ev.APIKeyID = usageLog.APIKeyID
		}
		if usageLog.GroupID != nil {
			ev.GroupID = usageLog.GroupID
		}
		ev.BilledModel = strings.TrimSpace(usageLog.Model)
		ev.RequestedModel = strings.TrimSpace(usageLog.RequestedModel)
		if ev.RequestedModel == "" {
			ev.RequestedModel = ev.BilledModel
		}
		if usageLog.UpstreamModel != nil {
			ev.UpstreamModel = strings.TrimSpace(*usageLog.UpstreamModel)
		}
		if !usageLog.CreatedAt.IsZero() {
			ev.At = usageLog.CreatedAt.UTC()
		}
	}
	return ev
}
