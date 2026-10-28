package handler

// CLAUDEX: file added by the Claudex fork (see backend/CLAUDEX_CHANGES.md).
//
// H12 / B7 (design 2.8, owner decisions 18/19): dictation through
// GET /v1/audio/realtime/transcriptions, a WebSocket relay to the realtime
// transcription service an administrator configured in claudex_voice. The
// route sits in the /v1 gateway group behind the API-key middleware, so the
// Claudex guards (device revocation, minimum version, usage rules with
// structured refusals) run before this handler. The handler reuses this
// package's unexported gateway helpers (design 1.3, exception 1); settings,
// the upstream key and the relay come from internal/claudex/voice, billing
// from service.RecordClaudexRealtimeTranscription. Text to speech is not
// offered (owner decision 19).
//
// Order of checks: WebSocket upgrade (426) -> dictation enabled with a key
// (404 CLAUDEX_AUDIO_DISABLED, 503 CLAUDEX_AUDIO_UNAVAILABLE) -> Claudex
// device key (403 CLAUDEX_AUDIO_DEVICE_KEY_REQUIRED) -> usage rules for the
// billed model (429) -> billing eligibility -> user concurrency slot ->
// upstream handshake (502 CLAUDEX_AUDIO_UPSTREAM_UNAVAILABLE) -> accept ->
// relay -> bill the forwarded audio seconds.

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/gatewayhook"
	claudexhook "github.com/Wei-Shaw/sub2api/internal/claudex/hook"
	claudexusage "github.com/Wei-Shaw/sub2api/internal/claudex/usage"
	"github.com/Wei-Shaw/sub2api/internal/claudex/voice"
	"github.com/Wei-Shaw/sub2api/internal/pkg/logger"
	"github.com/Wei-Shaw/sub2api/internal/pkg/wscompat"
	middleware2 "github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"

	coderws "github.com/coder/websocket"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"go.uber.org/zap"
)

// claudexDialUpstream opens the upstream connection (tests replace it).
var claudexDialUpstream = func(ctx context.Context, up voice.Upstream) (voice.Conn, error) {
	return voice.DialUpstream(ctx, up)
}

// ClaudexAudioRealtimeTranscriptions handles GET /v1/audio/realtime/transcriptions (B7).
func (h *OpenAIGatewayHandler) ClaudexAudioRealtimeTranscriptions(c *gin.Context) {
	if c == nil || c.Request == nil || !isOpenAIWSUpgradeRequest(c.Request) {
		h.errorResponse(c, http.StatusUpgradeRequired, "invalid_request_error", "WebSocket upgrade required (Upgrade: websocket)")
		return
	}
	apiKey, ok := middleware2.GetAPIKeyFromContext(c)
	if !ok || apiKey == nil {
		h.errorResponse(c, http.StatusUnauthorized, "authentication_error", "Invalid API key")
		return
	}
	up, err := voice.ResolveUpstream()
	switch {
	case errors.Is(err, voice.ErrUnavailable):
		claudexAudioError(c, http.StatusServiceUnavailable, "api_error", voice.ReasonUnavailable,
			"Dictation is temporarily unavailable on this server")
		return
	case err != nil:
		service.MarkOpsClientBusinessLimited(c, service.OpsClientBusinessLimitedReasonLocalFeatureGate)
		claudexAudioError(c, http.StatusNotFound, "not_found_error", voice.ReasonDisabled, "Dictation is not enabled on this server")
		return
	}
	if _, isDevice := gatewayhook.Device(c); !isDevice {
		service.MarkOpsClientBusinessLimited(c, service.OpsClientBusinessLimitedReasonLocalFeatureGate)
		claudexAudioError(c, http.StatusForbidden, "permission_error", voice.ReasonDeviceKeyRequired,
			"Dictation is only available in the Claudex desktop app")
		return
	}
	subject, ok := middleware2.GetAuthSubjectFromContext(c)
	if !ok {
		h.errorResponse(c, http.StatusInternalServerError, "api_error", "User context not found")
		return
	}
	reqLog := requestLogger(c, "handler.openai_gateway.claudex_audio_realtime",
		zap.Int64("user_id", subject.UserID),
		zap.Int64("api_key_id", apiKey.ID),
		zap.Any("group_id", apiKey.GroupID),
	)
	if !h.ensureResponsesDependencies(c, reqLog) {
		return
	}
	setOpsRequestContext(c, voice.BilledModel, true)

	// The usage-rule guard (H5b) checked every rule because the upgrade
	// names no model; check the rules of the billed model as well.
	if err := claudexhook.PrecheckTurn(c.Request.Context(), subject.UserID, apiKey.ID, apiKey.GroupID, []string{voice.BilledModel}); err != nil {
		reqLog.Info("claudex_audio.usage_rule_refused", zap.Error(err))
		message := err.Error()
		var limitErr *claudexusage.LimitError
		if errors.As(err, &limitErr) && limitErr.Detail != nil {
			gatewayhook.SetDetail(c, limitErr.Detail)
			if limitErr.Detail.RetryAfterSeconds > 0 {
				c.Header("Retry-After", strconv.Itoa(limitErr.Detail.RetryAfterSeconds))
			}
			if limitErr.Detail.Message != "" {
				message = limitErr.Detail.Message
			}
		}
		claudexAudioError(c, http.StatusTooManyRequests, "rate_limit_error", claudexusage.CodeLimitExceeded, message)
		return
	}

	subscription, _ := middleware2.GetSubscriptionFromContext(c)
	if err := h.billingCacheService.CheckBillingEligibility(c.Request.Context(), apiKey.User, apiKey, apiKey.Group, subscription, service.QuotaPlatform(c.Request.Context(), apiKey)); err != nil {
		reqLog.Info("claudex_audio.billing_check_failed", zap.Error(err))
		status, code, message, retryAfter := billingErrorDetails(err)
		if retryAfter > 0 {
			c.Header("Retry-After", strconv.Itoa(retryAfter))
		}
		h.errorResponse(c, status, code, message)
		return
	}

	streamStarted := false
	userRelease, acquired := h.acquireResponsesUserSlot(c, subject.UserID, subject.Concurrency, false, &streamStarted, reqLog)
	if !acquired {
		return
	}
	if userRelease != nil {
		defer userRelease()
	}

	upstream, err := claudexDialUpstream(c.Request.Context(), up)
	if err != nil {
		status := 0
		var dialErr *voice.DialError
		if errors.As(err, &dialErr) {
			status = dialErr.StatusCode
		}
		reqLog.Warn("claudex_audio.upstream_handshake_failed", zap.Int("upstream_status", status))
		claudexAudioError(c, http.StatusBadGateway, "upstream_error", voice.ReasonUpstreamUnavailable,
			"The transcription service is unavailable; try again later")
		return
	}

	client, err := coderws.Accept(c.Writer, c.Request, wscompat.AcceptOptions())
	if err != nil {
		_ = upstream.Close(coderws.StatusNormalClosure, "")
		return
	}
	client.SetReadLimit(voice.ClientReadLimit)
	defer func() { _ = client.CloseNow() }()

	result := voice.Relay(c.Request.Context(), client, upstream, up.Limits)
	reqLog.Info("claudex_audio.session_ended",
		zap.String("end_reason", result.EndReason),
		zap.Int64("audio_bytes", result.AudioBytes),
		zap.Bool("upstream_rejected", result.UpstreamRejected),
		zap.String("upstream_error_code", result.UpstreamErrorCode),
		zap.Duration("duration", result.Duration),
	)
	if !result.Billable() {
		return
	}
	h.recordClaudexRealtimeUsage(c, apiKey, subscription, result)
}

// recordClaudexRealtimeUsage bills a session and logs it for administrators.
func (h *OpenAIGatewayHandler) recordClaudexRealtimeUsage(c *gin.Context, apiKey *service.APIKey, subscription *service.UserSubscription, result voice.RelayResult) {
	requestID := service.ClaudexAudioRequestIDPrefix + uuid.NewString()
	quotaPlatform := service.QuotaPlatform(c.Request.Context(), apiKey)
	at := time.Now()
	h.submitMandatoryUsageRecordTask(c.Request.Context(), func(ctx context.Context) {
		log := logger.L().With(
			zap.String("component", "handler.openai_gateway.claudex_audio_realtime"),
			zap.String("request_id", requestID),
			zap.Int64("user_id", apiKey.User.ID),
			zap.Int64("api_key_id", apiKey.ID),
		)
		session := voice.Session{
			RequestID: requestID, UserID: apiKey.User.ID, APIKeyID: apiKey.ID, GroupID: apiKey.GroupID,
			AudioBytes: result.AudioBytes, BilledSeconds: result.Seconds(),
			DurationMs: result.Duration.Milliseconds(), EndReason: result.EndReason,
		}
		billed, err := h.gatewayService.RecordClaudexRealtimeTranscription(ctx, &service.ClaudexRealtimeUsageInput{
			RequestID: requestID, APIKey: apiKey, User: apiKey.User, Subscription: subscription,
			Model: voice.BilledModel, AudioBytes: result.AudioBytes, APIKeyService: h.apiKeyService,
			QuotaPlatform: quotaPlatform, At: at,
		})
		if err != nil {
			log.Error("claudex_audio.record_usage_failed", zap.Error(err))
		} else {
			session.CostUSD, session.Billed = billed.CostUSD, billed.Applied
		}
		if err := voice.RecordSession(ctx, session); err != nil {
			log.Warn("claudex_audio.session_log_failed", zap.Error(err))
		}
	})
}

func claudexAudioError(c *gin.Context, status int, errType, code, message string) {
	c.JSON(status, gin.H{"error": gin.H{
		"type":    errType,
		"code":    code,
		"message": message,
	}})
}
