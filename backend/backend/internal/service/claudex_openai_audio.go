package service

// CLAUDEX: file added by the Claudex fork (see backend/CLAUDEX_CHANGES.md).
//
// B7 (design 2.8, owner decisions 6/18): billing of the realtime dictation
// relay GET /v1/audio/realtime/transcriptions. The relay does not go through
// an upstream account (the administrator stores one API key of the realtime
// transcription service in claudex_voice), so it cannot use RecordUsage,
// whose usage_logs row needs an account. It applies the same unified billing
// command (usage_billing_dedup idempotency, balance or subscription, API-key
// quota and rate-limit windows, user platform quota) and then reports the
// usage event (claudexhook.UsageApplied) so the Claudex usage rules count it.
// Sessions are billed by audio length: bytes forwarded upstream / 32000
// (16 kHz mono 16-bit PCM) seconds, at the group's audio_stt_price_per_hour
// (built-in default when unset) times the user/group rate multiplier.

import (
	"context"
	"errors"
	"strings"
	"time"

	claudexhook "github.com/Wei-Shaw/sub2api/internal/claudex/hook"
	"github.com/Wei-Shaw/sub2api/internal/config"
)

// ClaudexAudioRequestIDPrefix starts the billing request id of every
// dictation session (kept by H8b).
const ClaudexAudioRequestIDPrefix = "claudex_audio:"

// ClaudexRealtimeBytesPerSecond is the byte rate of the relayed audio.
const ClaudexRealtimeBytesPerSecond = 32000

// ClaudexRealtimeUsageInput is one finished dictation session.
type ClaudexRealtimeUsageInput struct {
	// RequestID is the billing idempotency key (ClaudexAudioRequestIDPrefix + a
	// server-generated id).
	RequestID     string
	APIKey        *APIKey
	User          *User
	Subscription  *UserSubscription
	Model         string
	AudioBytes    int64
	APIKeyService APIKeyQuotaUpdater
	QuotaPlatform string
	At            time.Time
}

// ClaudexRealtimeUsageResult is what was billed.
type ClaudexRealtimeUsageResult struct {
	Seconds float64
	CostUSD float64
	// Applied is false for a duplicate request id, a free session or a
	// server in simple mode without key rate limits.
	Applied bool
}

// ClaudexRealtimeAudioSeconds converts forwarded PCM bytes to seconds.
func ClaudexRealtimeAudioSeconds(audioBytes int64) float64 {
	if audioBytes <= 0 {
		return 0
	}
	return float64(audioBytes) / ClaudexRealtimeBytesPerSecond
}

// claudexRealtimeBillingAccount stands in for the upstream account the
// billing command expects: ID 0 and no type, so no account quota, account
// statistics or account notifications are touched.
var claudexRealtimeBillingAccount = &Account{}

// RecordClaudexRealtimeTranscription bills one dictation session.
func (s *OpenAIGatewayService) RecordClaudexRealtimeTranscription(ctx context.Context, in *ClaudexRealtimeUsageInput) (*ClaudexRealtimeUsageResult, error) {
	if in == nil || in.APIKey == nil || in.User == nil {
		return nil, errors.New("claudex realtime usage: missing api key or user")
	}
	requestID := strings.TrimSpace(in.RequestID)
	if !strings.HasPrefix(requestID, ClaudexAudioRequestIDPrefix) || len(requestID) > 255 {
		return nil, errors.New("claudex realtime usage: invalid request id")
	}
	seconds := ClaudexRealtimeAudioSeconds(in.AudioBytes)
	out := &ClaudexRealtimeUsageResult{Seconds: seconds}
	if seconds <= 0 {
		return out, nil
	}
	apiKey := in.APIKey

	multiplier := 1.0
	if s.cfg != nil {
		multiplier = s.cfg.Default.RateMultiplier
	}
	if apiKey.GroupID != nil && apiKey.Group != nil {
		multiplier = s.ResolveUserGroupRateMultiplier(ctx, in.User.ID, *apiKey.GroupID, apiKey.Group.RateMultiplier)
	}
	if s.billingService == nil {
		return nil, errors.New("claudex realtime usage: billing service unavailable")
	}
	cost := s.billingService.CalculateAudioCost("stt", seconds/3600, groupAudioPriceConfigFromAPIKey(apiKey), multiplier)
	out.CostUSD = cost.ActualCost

	simpleKeyWindows := simpleModeKeyRateLimitBillingEnabled(s.cfg, apiKey)
	if s.cfg != nil && s.cfg.RunMode == config.RunModeSimple && !simpleKeyWindows {
		return out, nil
	}
	if s.usageBillingRepo == nil {
		return nil, errors.New("claudex realtime usage: billing repository unavailable")
	}

	isSubscription := in.Subscription != nil && apiKey.Group != nil && apiKey.Group.IsSubscriptionType()
	billingType := BillingTypeBalance
	if isSubscription {
		billingType = BillingTypeSubscription
	}
	quotaPlatform := in.QuotaPlatform
	if quotaPlatform == "" {
		quotaPlatform = PlatformFromAPIKey(apiKey)
	}
	at := in.At
	if at.IsZero() {
		at = time.Now()
	}
	model := strings.TrimSpace(in.Model)
	usageLog := &UsageLog{
		UserID: in.User.ID, APIKeyID: apiKey.ID, GroupID: apiKey.GroupID,
		Model: model, RequestedModel: model, BillingType: billingType, CreatedAt: at.UTC(),
	}
	p := &postUsageBillingParams{
		Cost:                       cost,
		User:                       in.User,
		APIKey:                     apiKey,
		Account:                    claudexRealtimeBillingAccount,
		Subscription:               in.Subscription,
		RequestPayloadHash:         HashUsageRequestPayload([]byte(requestID)),
		IsSubscriptionBill:         isSubscription && !simpleKeyWindows,
		AccountRateMultiplier:      1,
		APIKeyService:              in.APIKeyService,
		Platform:                   quotaPlatform,
		SimpleModeKeyRateLimitOnly: simpleKeyWindows,
	}
	cmd := buildUsageBillingCommand(requestID, usageLog, p)
	if cmd == nil {
		return nil, errors.New("claudex realtime usage: could not build the billing command")
	}

	billingCtx, cancel := detachedBillingContext(ctx)
	defer cancel()
	result, err := s.usageBillingRepo.Apply(billingCtx, cmd)
	if err != nil {
		return nil, err
	}
	if result == nil || !result.Applied {
		return out, nil
	}
	out.Applied = true
	if result.APIKeyQuotaExhausted {
		if invalidator, ok := in.APIKeyService.(apiKeyAuthCacheInvalidator); ok && apiKey.Key != "" {
			invalidator.InvalidateAuthCacheByKey(billingCtx, apiKey.Key)
		}
	}
	// The shared post-billing steps (balance and subscription caches, key
	// windows, platform quota, low-balance mail). Their "last used" update
	// of the upstream account goes to a throwaway queue: there is no account.
	deps := s.billingDeps()
	deps.deferredService = &DeferredService{}
	finalizePostUsageBilling(billingCtx, p, deps, result)
	claudexhook.UsageApplied(billingCtx, claudexUsageEventFrom(requestID, usageLog, p))
	return out, nil
}
