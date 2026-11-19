// CLAUDEX: Request-scoped group failover with one shared generation budget.
package handler

import (
	"context"
	"errors"
	"maps"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/gatewayhook"
	claudexhook "github.com/Wei-Shaw/sub2api/internal/claudex/hook"
	claudexusage "github.com/Wei-Shaw/sub2api/internal/claudex/usage"
	pkghttputil "github.com/Wei-Shaw/sub2api/internal/pkg/httputil"
	"github.com/Wei-Shaw/sub2api/internal/pkg/ip"
	"github.com/Wei-Shaw/sub2api/internal/pkg/logger"
	"github.com/Wei-Shaw/sub2api/internal/pkg/requestbudget"
	middleware2 "github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

type imageModelAttempt struct {
	publicModel string
	request     *service.OpenAIImagesRequest
	ctx         context.Context
	mapping     service.ChannelMappingResult
}

type imageAccountSelection struct {
	attempt  imageModelAttempt
	slot     *service.AccountSelectionResult
	decision service.OpenAIAccountScheduleDecision
}

type imageFailedAccounts struct {
	all     map[int64]struct{}
	byModel map[string]map[int64]struct{}
}

func (f imageFailedAccounts) forModel(model string) map[int64]struct{} {
	if scoped := f.byModel[model]; len(scoped) > 0 {
		excluded := maps.Clone(f.all)
		maps.Copy(excluded, scoped)
		return excluded
	}
	return f.all
}

func (f imageFailedAccounts) excludeModel(model string, accountID int64) {
	if f.byModel[model] == nil {
		f.byModel[model] = make(map[int64]struct{})
	}
	f.byModel[model][accountID] = struct{}{}
}

func (h *GatewayHandler) ClaudexImageModelIDs(ctx context.Context, group *service.Group) []string {
	var models, prefixes []string
	for _, listed := range h.gatewayService.ListedModelIDs(ctx, group) {
		listed = strings.TrimSpace(listed)
		if prefix, wildcard := strings.CutSuffix(listed, "*"); wildcard {
			prefixes = append(prefixes, prefix)
		} else if group.Platform == service.PlatformComposite || service.IsGPTImageGenerationModel(listed) {
			models = append(models, listed)
		}
	}
	if group.Platform == service.PlatformComposite && group.ModelAllowlistEnabled() {
		var names []string
		for _, entry := range group.ModelAllowlist.Models {
			if name := strings.TrimSpace(entry); name != "" && !strings.HasSuffix(name, "*") {
				names = append(names, name)
			}
		}
		models = service.MergeModelIDs(models, names)
	}
	if len(prefixes) == 0 {
		return models
	}
	var defaults []string
	for _, model := range service.DefaultListingModelIDs(service.PlatformOpenAI) {
		if !service.IsGPTImageGenerationModel(model) {
			continue
		}
		for _, prefix := range prefixes {
			if strings.HasPrefix(model, prefix) {
				defaults = append(defaults, model)
				break
			}
		}
	}
	return service.MergeModelIDs(models, defaults)
}

func (h *OpenAIGatewayHandler) ClaudexImages(listedModels func(context.Context, *service.Group) []string, resolver *service.CompositeRouteResolver) gin.HandlerFunc {
	return func(c *gin.Context) {
		h.images(c, listedModels, resolver)
	}
}

// Images handles OpenAI Images API requests.
// POST /v1/images/generations
// POST /v1/images/edits
func (h *OpenAIGatewayHandler) Images(c *gin.Context) {
	h.images(c, nil, nil)
}

func (h *OpenAIGatewayHandler) images(c *gin.Context, listedModels func(context.Context, *service.Group) []string, resolver *service.CompositeRouteResolver) {
	// CLAUDEX: a picture arrives whole, often after more than a minute.
	finishRequest := beginGroupFailoverRequestWithin(c, requestbudget.ImagesTotal)
	defer finishRequest()

	streamStarted := false
	defer h.recoverResponsesPanic(c, &streamStarted)

	requestStart := time.Now()

	apiKey, ok := middleware2.GetAPIKeyFromContext(c)
	if !ok {
		h.errorResponse(c, http.StatusUnauthorized, "authentication_error", "Invalid API key")
		return
	}

	subject, ok := middleware2.GetAuthSubjectFromContext(c)
	if !ok {
		h.errorResponse(c, http.StatusInternalServerError, "api_error", "User context not found")
		return
	}
	reqLog := requestLogger(
		c,
		"handler.openai_gateway.images",
		zap.Int64("user_id", subject.UserID),
		zap.Int64("api_key_id", apiKey.ID),
		zap.Any("group_id", apiKey.GroupID),
	)
	if !h.ensureResponsesDependencies(c, reqLog) {
		return
	}
	automatic := listedModels != nil
	if automatic {
		if apiKey.Group == nil || apiKey.GroupID == nil {
			service.MarkOpsClientBusinessLimited(c, service.OpsClientBusinessLimitedReasonAPIKeyGroupUnassigned)
			h.errorResponse(c, http.StatusForbidden, "permission_error", "An assigned API key group is required")
			return
		}
		switch apiKey.Group.Platform {
		case service.PlatformComposite:
			c.Request = c.Request.WithContext(service.WithResolvedTargetPlatform(c.Request.Context(), service.PlatformOpenAI))
		case service.PlatformOpenAI:
		default:
			service.MarkOpsClientBusinessLimited(c, service.OpsClientBusinessLimitedReasonLocalFeatureGate)
			h.errorResponse(c, http.StatusNotFound, "not_found_error", "Images API is not supported for this platform")
			return
		}
	}

	body, err := pkghttputil.ReadRequestBodyWithPrealloc(c.Request)
	if err != nil {
		if maxErr, ok := extractMaxBytesError(err); ok {
			h.errorResponse(c, http.StatusRequestEntityTooLarge, "invalid_request_error", buildBodyTooLargeMessage(maxErr.Limit))
			return
		}
		h.errorResponse(c, http.StatusBadRequest, "invalid_request_error", "Failed to read request body")
		return
	}
	if len(body) == 0 {
		h.errorResponse(c, http.StatusBadRequest, "invalid_request_error", "Request body is empty")
		return
	}

	setOpsRequestContext(c, "", false)
	var parsed *service.OpenAIImagesRequest
	if automatic {
		parsed, err = h.gatewayService.ParseClaudexImagesRequest(c, body)
	} else {
		parsed, err = h.gatewayService.ParseOpenAIImagesRequest(c, body)
	}
	if err != nil {
		h.errorResponse(c, http.StatusBadRequest, "invalid_request_error", err.Error())
		return
	}
	publicModel := clientRequestedModel(c, parsed.Model)
	if !automatic && !compositeTargetPlatformAllowed(c, apiKey, parsed.Model, service.PlatformOpenAI) {
		h.errorResponse(c, http.StatusBadRequest, "invalid_request_error", "Model is not supported by this OpenAI-compatible endpoint for composite groups")
		return
	}

	reqLog = reqLog.With(
		zap.Bool("stream", parsed.Stream),
		zap.Bool("multipart", parsed.Multipart),
		zap.String("img_quality", parsed.Quality),
		zap.String("img_size", parsed.Size),
	)

	if !service.GroupAllowsImageGeneration(apiKey.Group) {
		h.errorResponse(c, http.StatusForbidden, "permission_error", service.ImageGenerationPermissionMessage())
		return
	}
	moderationBody := parsed.ModerationBody()
	if !automatic {
		reqLog = imageModelLogger(reqLog, publicModel, parsed)
		if decision := h.checkSecurityAudit(c, reqLog, apiKey, subject, service.ContentModerationProtocolOpenAIImages, parsed.Model, moderationBody); decision != nil && !decision.AllowNextStage {
			h.openAISecurityAuditError(c, decision)
			return
		}
	}
	imageReleaseFunc, acquired := h.acquireImageGenerationSlot(c, streamStarted)
	if !acquired {
		return
	}
	if imageReleaseFunc != nil {
		defer imageReleaseFunc()
	}

	setOpsRequestContext(c, publicModel, parsed.Stream)
	setOpsEndpointContext(c, "", int16(service.RequestTypeFromLegacy(parsed.Stream, false)))

	if h.errorPassthroughService != nil {
		service.BindErrorPassthroughService(c, h.errorPassthroughService)
	}

	subscription, _ := middleware2.GetSubscriptionFromContext(c)

	service.SetOpsLatencyMs(c, service.OpsAuthLatencyMsKey, time.Since(requestStart).Milliseconds())
	routingStart := time.Now()

	userReleaseFunc, acquired := h.acquireResponsesUserSlot(c, subject.UserID, subject.Concurrency, parsed.Stream, &streamStarted, reqLog)
	if !acquired {
		return
	}
	if userReleaseFunc != nil {
		defer userReleaseFunc()
	}

	if err := h.billingCacheService.CheckBillingEligibility(c.Request.Context(), apiKey.User, apiKey, apiKey.Group, subscription, service.QuotaPlatform(c.Request.Context(), apiKey)); err != nil {
		reqLog.Info("openai.images.billing_eligibility_check_failed", zap.Error(err))
		status, code, message, retryAfter := billingErrorDetails(err)
		if retryAfter > 0 {
			c.Header("Retry-After", strconv.Itoa(retryAfter))
		}
		h.handleStreamingAwareError(c, status, code, message, streamStarted)
		return
	}

	sessionHash := h.gatewayService.GenerateExplicitSessionHash(c, body)
	requestCtx := service.WithOpenAIImagesEndpoint(service.WithOpenAIImageGenerationIntent(c.Request.Context()))
	var attempts []imageModelAttempt
	if automatic {
		attempts, err = h.claudexImageAttempts(requestCtx, apiKey, parsed, listedModels(requestCtx, apiKey.Group), resolver)
		if err != nil {
			reqLog.Warn("openai.images.model_route_resolution_failed", zap.Error(err))
			h.handleStreamingAwareError(c, http.StatusInternalServerError, "server_error", "Failed to resolve composite model route", streamStarted)
			return
		}
	} else {
		mapping, _ := h.gatewayService.ResolveChannelMappingAndRestrict(requestCtx, apiKey.GroupID, parsed.Model)
		attempts = []imageModelAttempt{{publicModel: publicModel, request: parsed, ctx: requestCtx, mapping: mapping}}
	}

	switchCount := 0
	profitVetoCount := 0
	failedAccounts := imageFailedAccounts{all: make(map[int64]struct{}), byModel: make(map[string]map[int64]struct{})}
	sameAccountRetryCount := make(map[int64]int)
	var lastFailoverErr *service.UpstreamFailoverError
	var lastUsageLimit *gatewayhook.RefusalDetail
	auditedModel := ""
	stopJSONKeepalive := func() {}
	jsonKeepaliveStarted := false
	defer func() { stopJSONKeepalive() }()

	for {
		reqLog.Debug("openai.images.account_selecting", zap.Int("switch_count", switchCount))
		selected, err := h.selectImagesAccount(apiKey.GroupID, sessionHash, attempts, failedAccounts)
		selection, scheduleDecision := selected.slot, selected.decision
		if err != nil || selection == nil || selection.Account == nil {
			if failoverClientGone(c) {
				reqLog.Info("openai.images.account_select_aborted_client_disconnected", zap.Error(err))
				return
			}
			reqLog.Warn("openai.images.account_select_failed", zap.Error(err), zap.Int("switch_count", switchCount))
			if err != nil && lastFailoverErr != nil {
				h.handleFailoverExhausted(c, lastFailoverErr, streamStarted)
				return
			}
			if err != nil && profitVetoCount > 0 {
				h.handleFailoverExhaustedSimple(c, http.StatusBadGateway, streamStarted)
				return
			}
			if lastUsageLimit != nil && (err == nil || isOpsNoAvailableAccountError(err)) {
				h.refuseClaudexImageUsage(c, lastUsageLimit, streamStarted)
				return
			}
			cls := noAccountErrorClassification{Status: http.StatusServiceUnavailable, ErrType: "api_error", Message: "No available image models"}
			if !automatic {
				cls = classifyNoAccountErrorFromGin(c, h.gatewayService, apiKey, publicModel, parsed.Model, service.PlatformOpenAI)
				if !cls.ModelNotFound {
					cls.Message = "No available compatible accounts"
				}
			}
			if !cls.ModelNotFound && (err == nil || isOpsNoAvailableAccountError(err)) {
				markOpsRoutingCapacityLimited(c)
			} else if automatic {
				cls.Message = "Service temporarily unavailable"
			}
			h.handleStreamingAwareError(c, cls.Status, cls.ErrType, cls.Message, streamStarted)
			return
		}
		attempt := selected.attempt
		parsed := attempt.request
		requestModel := parsed.Model
		clientRequestModel := attempt.publicModel
		channelMapping := attempt.mapping
		requestCtx := attempt.ctx
		c.Request = c.Request.WithContext(requestCtx)
		setOpsRequestContext(c, clientRequestModel, parsed.Stream)
		reqLog := reqLog
		if automatic {
			reqLog = imageModelLogger(reqLog, clientRequestModel, parsed)
		}

		reqLog.Debug("openai.images.account_schedule_decision",
			zap.String("layer", scheduleDecision.Layer),
			zap.Bool("sticky_session_hit", scheduleDecision.StickySessionHit),
			zap.Int("candidate_count", scheduleDecision.CandidateCount),
			zap.Int("top_k", scheduleDecision.TopK),
			zap.Int64("latency_ms", scheduleDecision.LatencyMs),
			zap.Float64("load_skew", scheduleDecision.LoadSkew),
		)

		account := selection.Account
		_, accountFailed := failedAccounts.all[account.ID]
		_, modelFailed := failedAccounts.byModel[requestModel][account.ID]
		if accountFailed || modelFailed {
			if selection.ReleaseFunc != nil {
				selection.ReleaseFunc()
			}
			if lastFailoverErr != nil {
				h.handleFailoverExhausted(c, lastFailoverErr, streamStarted)
			} else {
				h.handleFailoverExhaustedSimple(c, http.StatusServiceUnavailable, streamStarted)
			}
			return
		}
		reqLog.Debug("openai.images.account_selected", zap.Int64("account_id", account.ID), zap.String("account_name", account.Name))
		setOpsSelectedAccount(c, account.ID, account.Platform)
		service.ClearOpsUpstreamModel(c)
		if automatic {
			mappedModel := channelMapping.MappedModel
			if mappedModel == "" {
				mappedModel = requestModel
			}
			models := []string{clientRequestModel, requestModel, mappedModel}
			if account.Type != service.AccountTypeAPIKey || !account.CodexDraws() {
				models = append(models, account.GetMappedModel(mappedModel))
			}
			if err := claudexhook.PrecheckTurn(c.Request.Context(), subject.UserID, apiKey.ID, apiKey.GroupID, models); err != nil {
				if selection.ReleaseFunc != nil {
					selection.ReleaseFunc()
				}
				var limit *claudexusage.LimitError
				if !errors.As(err, &limit) || limit.Detail == nil {
					h.handleStreamingAwareError(c, http.StatusServiceUnavailable, "server_error", "Usage limits could not be checked", streamStarted)
					return
				}
				if limit.Detail.RuleKind != claudexusage.KindModels {
					h.refuseClaudexImageUsage(c, limit.Detail, streamStarted)
					return
				}
				lastUsageLimit = limit.Detail
				failedAccounts.excludeModel(requestModel, account.ID)
				continue
			}
		}
		sessionHash = ensureOpenAIPoolModeSessionHash(sessionHash, account)
		if automatic && auditedModel != clientRequestModel {
			c.Set(securityAuditCompletedContextKey, false)
			if decision := h.checkSecurityAudit(c, reqLog, apiKey, subject, service.ContentModerationProtocolOpenAIImages, requestModel, moderationBody); decision != nil && !decision.AllowNextStage {
				if selection.ReleaseFunc != nil {
					selection.ReleaseFunc()
				}
				h.openAISecurityAuditError(c, decision)
				return
			}
			auditedModel = clientRequestModel
		}

		accountReleaseFunc, slotResult := h.acquireResponsesAccountSlot(c, apiKey.GroupID, sessionHash, selection, parsed.Stream, &streamStarted, reqLog)
		if slotResult == openAISlotAcquireProfitVetoed {
			// Images 调度不装利润门，此分支实际不可达；防御性排除重选并受同一否决上限约束。
			if !recordOpenAIProfitVeto(failedAccounts.all, account.ID, &profitVetoCount, true) {
				h.handleOpenAIProfitVetoExhausted(c, streamStarted, reqLog, profitVetoCount)
				return
			}
			continue
		}
		if slotResult != openAISlotAcquireOK {
			return
		}

		service.SetOpsLatencyMs(c, service.OpsRoutingLatencyMsKey, time.Since(routingStart).Milliseconds())
		if !parsed.Stream && !jsonKeepaliveStarted {
			stopJSONKeepalive = service.StartOpenAIImagesJSONKeepalive(c, h.openAIImagesJSONKeepaliveInterval())
			jsonKeepaliveStarted = true
		}
		forwardStart := time.Now()
		writerSizeBeforeForward := service.OpenAIImagesJSONKeepaliveAdjustedWrittenSize(c)
		result, err := func() (*service.OpenAIForwardResult, error) {
			defer func() {
				if accountReleaseFunc != nil {
					accountReleaseFunc()
				}
			}()
			return h.gatewayService.ForwardImages(requestCtx, c, account, parsed.Body, parsed, channelMapping.MappedModel)
		}()
		forwardDurationMs := time.Since(forwardStart).Milliseconds()
		upstreamLatencyMs, _ := getContextInt64(c, service.OpsUpstreamLatencyMsKey)
		responseLatencyMs := forwardDurationMs
		if upstreamLatencyMs > 0 && forwardDurationMs > upstreamLatencyMs {
			responseLatencyMs = forwardDurationMs - upstreamLatencyMs
		}
		service.SetOpsLatencyMs(c, service.OpsResponseLatencyMsKey, responseLatencyMs)
		if result != nil && result.FirstTokenMs != nil {
			service.SetOpsLatencyMs(c, service.OpsTimeToFirstTokenMsKey, int64(*result.FirstTokenMs))
		}
		if err != nil {
			if result != nil && result.ImageCount > 0 {
				reqLog.Warn("openai.images.forward_partial_error_with_image_result",
					zap.Int64("account_id", account.ID),
					zap.Int("image_count", result.ImageCount),
					zap.Error(err),
				)
			} else {
				var imageUpstreamErr *service.OpenAIImagesUpstreamError
				if errors.As(err, &imageUpstreamErr) {
					retryableServerError := service.IsOpenAIImagesRetryableUpstreamError(imageUpstreamErr)
					if retryableServerError {
						if c.Request.Context().Err() == nil {
							h.gatewayService.ReportOpenAIAccountScheduleResult(account, openAIAccountScheduleModel(c, account, requestModel, false, result), false, nil, err)
						}
					} else {
						h.gatewayService.ReportOpenAIAccountScheduleResult(account, openAIAccountScheduleModel(c, account, requestModel, false, result), true, nil)
					}
					logEvent := "openai.images.upstream_user_error"
					if retryableServerError {
						logEvent = "openai.images.upstream_server_error_after_flush"
					}
					reqLog.Warn(logEvent,
						zap.Int64("account_id", account.ID),
						zap.Int("status_code", imageUpstreamErr.StatusCode),
						zap.String("error_type", imageUpstreamErr.ErrorType),
						zap.String("error_code", imageUpstreamErr.Code),
						zap.Error(err),
					)
					return
				}
				var failoverErr *service.UpstreamFailoverError
				if errors.As(err, &failoverErr) {
					if failoverClientGone(c) {
						return
					}
					if !failoverErr.ShouldRetryNextAccount() {
						h.handleFailoverExhausted(c, failoverErr, streamStarted)
						return
					}
					if c.Request.Context().Err() == nil {
						h.gatewayService.ReportOpenAIAccountScheduleResult(account, openAIAccountScheduleModel(c, account, requestModel, false, result), false, nil, err)
					}
					if service.OpenAIImagesJSONKeepaliveAdjustedWrittenSize(c) != writerSizeBeforeForward {
						reqLog.Warn("openai.images.upstream_failover_skipped_after_flush",
							zap.Int64("account_id", account.ID),
							zap.Int("upstream_status", failoverErr.StatusCode),
						)
						h.handleFailoverExhausted(c, failoverErr, true)
						return
					}
					if failoverClientGone(c) {
						reqLog.Info("openai.images.failover_aborted_client_disconnected",
							zap.Int64("account_id", account.ID),
							zap.Int("upstream_status", failoverErr.StatusCode),
						)
						return
					}
					modelUnavailable := automatic && service.IsOpenAIImagesModelUnavailable(failoverErr, account)
					if failoverErr.RetryableOnSameAccount && !modelUnavailable {
						retryLimit := effectiveSameAccountRetryLimit(failoverErr, account)
						if sameAccountRetryAllowed(failoverErr, sameAccountRetryCount[account.ID], retryLimit) {
							sameAccountRetryCount[account.ID]++
							retryDelay := sameAccountRetryDelayFor(failoverErr, sameAccountRetryCount[account.ID])
							reqLog.Warn("openai.images.pool_mode_same_account_retry",
								zap.Int64("account_id", account.ID),
								zap.Int("upstream_status", failoverErr.StatusCode),
								zap.Int("retry_limit", retryLimit),
								zap.Int("retry_count", sameAccountRetryCount[account.ID]),
								zap.Duration("retry_delay", retryDelay),
							)
							select {
							case <-requestCtx.Done():
								return
							case <-time.After(retryDelay):
							}
							continue
						}
					}
					h.gatewayService.RecordOpenAIAccountSwitch()
					if modelUnavailable {
						failedAccounts.excludeModel(requestModel, account.ID)
					} else {
						failedAccounts.all[account.ID] = struct{}{}
					}
					lastFailoverErr = failoverErr

					switchCount++

					reqLog.Warn("openai.images.upstream_failover_switching",
						zap.Int64("account_id", account.ID),
						zap.Int("upstream_status", failoverErr.StatusCode),
						zap.Int("switch_count", switchCount),
						zap.Bool("model_unavailable", modelUnavailable),
					)
					continue
				}
				if c.Request.Context().Err() == nil {
					h.gatewayService.ReportOpenAIAccountScheduleResult(account, openAIAccountScheduleModel(c, account, requestModel, false, result), false, nil, err)
				}
				upstreamErrorAlreadyCommunicated := openAIForwardErrorAlreadyCommunicated(c, writerSizeBeforeForward, err)
				wroteFallback := false
				if !upstreamErrorAlreadyCommunicated {
					wroteFallback = h.ensureForwardErrorResponse(c, streamStarted)
				}
				fields := []zap.Field{
					zap.Int64("account_id", account.ID),
					zap.Bool("fallback_error_response_written", wroteFallback),
					zap.Bool("upstream_error_response_already_written", upstreamErrorAlreadyCommunicated),
					zap.Error(err),
				}
				if shouldLogOpenAIForwardFailureAsWarn(c, wroteFallback) {
					reqLog.Warn("openai.images.forward_failed", fields...)
					return
				}
				reqLog.Error("openai.images.forward_failed", fields...)
				return
			}
		}
		if result != nil {
			// 排除 spark 影子:其 codex_* 仅由 QueryUsage(/wham/usage bengalfox)更新(外审第7轮 P1)。
			if account.Type == service.AccountTypeOAuth && !account.IsShadow() {
				h.gatewayService.UpdateCodexUsageSnapshotFromHeaders(c.Request.Context(), account.ID, result.ResponseHeaders)
			}
			h.gatewayService.ReportOpenAIAccountScheduleResult(account, openAIAccountScheduleModel(c, account, requestModel, false, result), true, result.FirstTokenMs)
		} else {
			h.gatewayService.ReportOpenAIAccountScheduleResult(account, openAIAccountScheduleModel(c, account, requestModel, false, result), true, nil)
		}

		userAgent := c.GetHeader("User-Agent")
		clientIP := ip.GetClientIP(c)
		requestPayloadHash := service.HashUsageRequestPayload(body)
		if parsed.Multipart {
			requestPayloadHash = service.HashUsageRequestPayload([]byte(parsed.StickySessionSeed()))
		}
		inboundEndpoint := GetInboundEndpoint(c)
		upstreamEndpoint := GetUpstreamEndpoint(c, account.Platform)
		quotaPlatform := service.QuotaPlatform(c.Request.Context(), apiKey)

		upstreamModel := ""
		if result != nil {
			upstreamModel = result.UpstreamModel
		}
		sessionID := service.ExtractClientSessionID(c)
		channelUsageFields := channelMapping.ToUsageFields(clientRequestModel, upstreamModel)
		h.submitMandatoryUsageRecordTask(c.Request.Context(), func(ctx context.Context) {
			if err := h.gatewayService.RecordUsage(ctx, &service.OpenAIRecordUsageInput{
				Result:             result,
				APIKey:             apiKey,
				User:               apiKey.User,
				Account:            account,
				Subscription:       subscription,
				InboundEndpoint:    inboundEndpoint,
				UpstreamEndpoint:   upstreamEndpoint,
				UserAgent:          userAgent,
				IPAddress:          clientIP,
				RequestPayloadHash: requestPayloadHash,
				APIKeyService:      h.apiKeyService,
				QuotaPlatform:      quotaPlatform,
				SessionID:          sessionID,
				ChannelUsageFields: channelUsageFields,
			}); err != nil {
				logger.L().With(
					zap.String("component", "handler.openai_gateway.images"),
					zap.Int64("user_id", subject.UserID),
					zap.Int64("api_key_id", apiKey.ID),
					zap.Any("group_id", apiKey.GroupID),
					zap.String("model", clientRequestModel),
					zap.Int64("account_id", account.ID),
				).Error("openai.images.record_usage_failed", zap.Error(err))
			}
		})

		reqLog.Debug("openai.images.request_completed",
			zap.Int64("account_id", account.ID),
			zap.Int("switch_count", switchCount),
		)
		return
	}
}

func (h *OpenAIGatewayHandler) claudexImageAttempts(ctx context.Context, apiKey *service.APIKey, parsed *service.OpenAIImagesRequest, models []string, resolver *service.CompositeRouteResolver) ([]imageModelAttempt, error) {
	var attempts []imageModelAttempt
	for _, publicModel := range models {
		if !apiKey.Group.ModelAllowlist.Allows(publicModel) {
			continue
		}
		routingModel, attemptCtx := publicModel, ctx
		if apiKey.Group.Platform == service.PlatformComposite {
			decision, err := resolver.Resolve(ctx, apiKey.Group.ID, publicModel, service.CompositeRouteEndpointImages)
			if err != nil {
				return nil, err
			}
			if !decision.Matched || decision.TargetPlatform != service.PlatformOpenAI {
				continue
			}
			routingModel = decision.UpstreamModel
			attemptCtx = service.WithCompositeRouteDecision(ctx, decision)
		} else if !service.IsGPTImageGenerationModel(publicModel) {
			continue
		}
		request, err := parsed.WithSelectedModel(routingModel)
		if err != nil {
			continue
		}
		mapping, _ := h.gatewayService.ResolveChannelMappingAndRestrict(attemptCtx, apiKey.GroupID, routingModel)
		attempts = append(attempts, imageModelAttempt{publicModel: publicModel, request: request, ctx: attemptCtx, mapping: mapping})
	}
	return attempts, nil
}

func (h *OpenAIGatewayHandler) selectImagesAccount(groupID *int64, sessionHash string, attempts []imageModelAttempt, failedAccounts imageFailedAccounts) (imageAccountSelection, error) {
	var waiting imageAccountSelection
	var noAccountErr error = service.ErrNoAvailableAccounts
	for _, attempt := range attempts {
		if err := attempt.ctx.Err(); err != nil {
			return imageAccountSelection{}, err
		}
		slot, decision, err := h.gatewayService.SelectAccountWithSchedulerForImages(
			attempt.ctx, groupID, sessionHash, attempt.request.Model, failedAccounts.forModel(attempt.request.Model),
			attempt.request.RequiredCapabilityForModel(attempt.mapping.MappedModel),
		)
		if err != nil {
			if !errors.Is(err, service.ErrNoAvailableAccounts) {
				return imageAccountSelection{}, err
			}
			noAccountErr = err
			continue
		}
		selected := imageAccountSelection{attempt: attempt, slot: slot, decision: decision}
		if len(attempts) == 1 {
			return selected, nil
		}
		if slot == nil || slot.Account == nil {
			continue
		}
		if slot.Acquired {
			return selected, nil
		}
		if slot.WaitPlan != nil && waiting.slot == nil {
			waiting = selected
		}
	}
	if waiting.slot != nil {
		return waiting, nil
	}
	return imageAccountSelection{}, noAccountErr
}

func (h *OpenAIGatewayHandler) refuseClaudexImageUsage(c *gin.Context, detail *gatewayhook.RefusalDetail, streamStarted bool) {
	code := claudexusage.CodeLimitExceeded
	if detail.Reason == claudexusage.CodeSpendLimitExceeded {
		code = detail.Reason
	}
	gatewayhook.SetDetail(c, detail)
	c.Header("Retry-After", strconv.Itoa(detail.RetryAfterSeconds))
	if streamStarted {
		h.handleStreamingAwareErrorWithCode(c, http.StatusTooManyRequests, "rate_limit_error", code, detail.Message, true, false)
		return
	}
	c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"code": code, "message": detail.Message, "claudex": detail})
}

func imageModelLogger(log *zap.Logger, publicModel string, parsed *service.OpenAIImagesRequest) *zap.Logger {
	return log.With(
		zap.String("model", publicModel),
		zap.String("routing_model", parsed.Model),
		zap.String("capability", string(parsed.RequiredCapability)),
	)
}

func (h *OpenAIGatewayHandler) openAIImagesJSONKeepaliveInterval() time.Duration {
	if h.cfg == nil || h.cfg.Gateway.ImageNonstreamKeepaliveInterval <= 0 {
		return 0
	}
	return time.Duration(h.cfg.Gateway.ImageNonstreamKeepaliveInterval) * time.Second
}

func isMultipartImagesContentType(contentType string) bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(contentType)), "multipart/form-data")
}
