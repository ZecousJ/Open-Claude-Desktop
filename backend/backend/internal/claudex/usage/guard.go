package usage

import (
	"context"
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Wei-Shaw/sub2api/internal/claudex/gatewayhook"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
)

// Precheck (H5b RequestGuard, priority 30; H14 for WebSocket turns).
//
// The guard runs after every upstream API-key check of both API-key
// middlewares, i.e. on every gateway route family (/v1, the root aliases,
// /backend-api/codex, /v1beta, /antigravity) and every method except the
// non-billable whitelist (gatewayhook.IsBillableRequest), for every key of
// the group: device keys and user-created keys alike (owner decision 8).

// CodeLimitExceeded is the refusal code of a usage rule (design 1.8).
const CodeLimitExceeded = "CLAUDEX_USAGE_LIMIT_EXCEEDED"

// wsReasonLimit is the longest WebSocket close reason the handler sends.
const wsReasonLimit = 120

type checkMode int

const (
	// modeRequest: a request without any model name is checked against every
	// rule of the group (conservative: a limited model may hide in a place
	// the model extraction does not see).
	modeRequest checkMode = iota
	// modeHandshake: a Responses WebSocket upgrade has no model yet; only the
	// rules covering every model apply, each turn is checked through H14.
	modeHandshake
)

// breach is an exceeded rule.
type breach struct {
	rule    *activeRule
	counter counterRow
}

// Priority implements gatewayhook.RequestGuard.
func (c *Component) Priority() int { return gatewayhook.PriorityUsageRules }

// OnRequest implements gatewayhook.RequestGuard (H5b).
func (c *Component) OnRequest(g *gin.Context, apiKey *service.APIKey) bool {
	if g == nil || apiKey == nil || !gatewayhook.IsBillableRequest(g) {
		return false
	}
	userID := apiKey.UserID
	if apiKey.User != nil && apiKey.User.ID > 0 {
		userID = apiKey.User.ID
	}
	// The client's surface, counted when the request is billed (products.go).
	c.noteProduct(g)
	groupID := keyGroupID(apiKey)
	mode := modeRequest
	if isResponsesUpgrade(g) {
		mode = modeHandshake
	}
	ctx := g.Request.Context()
	b := c.check(ctx, userID, groupID, mode, func() []string {
		return c.candidates(ctx, apiKey.Group, groupID, requestModels(g))
	})
	if b == nil {
		// The person's own monthly spend limit (spend.go).
		if detail := c.spendRefusal(ctx, userID); detail != nil {
			c.refuseSpend(g, detail)
			return true
		}
		return false
	}
	detail := c.detail(b)
	gatewayhook.SetDetail(g, detail)
	g.Header("Retry-After", strconv.Itoa(detail.RetryAfterSeconds))
	g.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{
		"code":    CodeLimitExceeded,
		"message": detail.Message,
		"claudex": detail,
	})
	return true
}

// PrecheckTurn implements core.TurnPrechecker (H14): the same check for one
// Responses WebSocket turn. The error text is the close reason.
func (c *Component) PrecheckTurn(ctx context.Context, userID, _ int64, groupID *int64, models []string) error {
	b := c.check(ctx, userID, groupID, modeRequest, func() []string {
		return c.candidates(ctx, nil, groupID, models)
	})
	if b == nil {
		if detail := c.spendRefusal(ctx, userID); detail != nil {
			return &LimitError{Detail: detail}
		}
		return nil
	}
	return &LimitError{Detail: c.detail(b)}
}

// LimitError is the H14 refusal of a WebSocket turn.
type LimitError struct {
	Detail *gatewayhook.RefusalDetail
}

func (e *LimitError) Error() string {
	reason := CodeLimitExceeded + ": " + e.Detail.Message
	if len(reason) <= wsReasonLimit {
		return reason
	}
	cut := wsReasonLimit
	for cut > 0 && !utf8.RuneStart(reason[cut]) {
		cut--
	}
	return reason[:cut]
}

// RealtimeTranscriptionModel is the model name dictation sessions are billed
// and counted as (voice.BilledModel; the I1 contract test keeps the two
// equal). The realtime transcription WebSocket handshake has no body, so
// without this name every per-model rule (an exceeded Opus rule, say) would
// refuse dictation as a request "without a model".
const RealtimeTranscriptionModel = "realtime-transcription"

// requestModels is gatewayhook.RequestModels, with the dictation route's
// fixed model.
func requestModels(g *gin.Context) []string {
	if g.Request != nil && g.Request.Method == http.MethodGet &&
		strings.HasSuffix(g.FullPath(), "/audio/realtime/transcriptions") {
		return []string{RealtimeTranscriptionModel}
	}
	return gatewayhook.RequestModels(g)
}

func keyGroupID(apiKey *service.APIKey) *int64 {
	if apiKey.GroupID != nil {
		return apiKey.GroupID
	}
	if apiKey.Group != nil && apiKey.Group.ID > 0 {
		id := apiKey.Group.ID
		return &id
	}
	return nil
}

// isResponsesUpgrade reports a Responses WebSocket handshake (GET /v1/responses,
// /responses, /backend-api/codex/responses).
func isResponsesUpgrade(g *gin.Context) bool {
	if g.Request == nil || g.Request.Method != http.MethodGet {
		return false
	}
	return strings.HasSuffix(g.FullPath(), "/responses")
}

// check returns the exceeded rule that resets last, or nil. It issues no
// query when the group has no enabled rule (the rule list is cached) and one
// primary-key query for the counters otherwise. A database failure lets the
// request through (like the upstream API-key rate limits); counting continues
// through the retry queue, so the rules apply again once the database is back.
func (c *Component) check(ctx context.Context, userID int64, groupID *int64, mode checkMode, models func() []string) *breach {
	if userID <= 0 {
		return nil
	}
	set, err := c.rules.get(ctx)
	if err != nil {
		c.precheckFailed("rules", err)
		return nil
	}
	rules := set.forGroup(groupID)
	if len(rules) == 0 {
		return nil
	}
	var candidates []string
	needModels := false
	for _, r := range rules {
		if !r.allModels {
			needModels = true
			break
		}
	}
	if needModels {
		candidates = modelNameForms(models()...)
	}
	applicable := make([]*activeRule, 0, len(rules))
	ids := make([]int64, 0, len(rules))
	for _, r := range rules {
		switch {
		case r.allModels:
		case len(candidates) == 0 && mode == modeHandshake:
			continue
		case len(candidates) == 0:
			// No model name found: every per-model rule applies.
		case !r.matchesAny(candidates...):
			continue
		}
		applicable = append(applicable, r)
		ids = append(ids, r.ID)
	}
	if len(applicable) == 0 {
		return nil
	}
	counters, err := c.store.counters(ctx, userID, ids)
	if err != nil {
		c.precheckFailed("counters", err)
		return nil
	}
	now := c.now()
	var worst *breach
	for _, r := range applicable {
		row, ok := counters[r.ID]
		if !ok || !row.WindowEnd.After(now) || row.UsedUSD < r.LimitUSD {
			continue
		}
		if worst == nil || row.WindowEnd.After(worst.counter.WindowEnd) {
			worst = &breach{rule: r, counter: row}
		}
	}
	return worst
}

func (c *Component) precheckFailed(what string, err error) {
	n := c.precheckErrors.Add(1)
	slog.Warn("claudex usage: precheck could not read "+what+", request allowed",
		"error", err, "claudex_usage_precheck_errors_total", n)
}

// candidates adds, to the request's model names, the names they are served
// as: the channel mapping of the group (ChannelService.ResolveChannelMapping)
// and, for groups that dispatch Claude-style requests to other models, the
// group's dispatch mapping (Group.ResolveMessagesDispatchModel, the
// group-level default mapping upstream applies; the legacy
// Group.DefaultMappedModel field is no longer read by any forwarding path).
// Any of them hitting a per-model rule makes the rule apply. Without any name
// the caller checks every per-model rule.
func (c *Component) candidates(ctx context.Context, group *service.Group, groupID *int64, models []string) []string {
	out := make([]string, 0, len(models)*2+1)
	seen := map[string]bool{}
	add := func(m string) {
		m = strings.TrimSpace(m)
		if m != "" && !seen[m] {
			seen[m] = true
			out = append(out, m)
		}
	}
	for _, m := range models {
		add(m)
	}
	requested := append([]string(nil), out...)
	if group != nil && dispatchesMessages(group) {
		for _, m := range requested {
			add(group.ResolveMessagesDispatchModel(m))
		}
	}
	if groupID != nil && c.mapChannel != nil {
		for _, m := range append([]string(nil), out...) {
			if mapped, ok := c.mapChannel(ctx, *groupID, m); ok {
				add(mapped)
			}
		}
	}
	return out
}

// dispatchesMessages reports groups whose /v1/messages requests may be served
// by a mapped model (OpenAI and composite groups with dispatch enabled, Grok).
func dispatchesMessages(g *service.Group) bool {
	switch g.Platform {
	case service.PlatformOpenAI, service.PlatformComposite:
		return g.AllowMessagesDispatch
	case service.PlatformGrok:
		return true
	}
	return false
}

// detail builds the structured refusal of a breach (design 2.6). rule_kind
// names the kind of the rule (session, all_models, models) so the desktop app
// no longer has to guess it from the window (R13).
func (c *Component) detail(b *breach) *gatewayhook.RefusalDetail {
	resetsAt := b.counter.WindowEnd.UTC()
	retry := retryAfter(c.now(), resetsAt)
	limit := roundUSD(b.rule.LimitUSD)
	used := roundUSD(b.counter.UsedUSD)
	ruleID := b.rule.ID
	msg := limitMessage(b.rule.Kind, b.rule.Label, resetsAt)
	return &gatewayhook.RefusalDetail{
		V:                 1,
		Reason:            "RULE_LIMIT",
		Kind:              "rule_limit",
		Window:            windowLabel(b.rule.WindowSeconds),
		ResetsAt:          &resetsAt,
		RetryAfterSeconds: retry,
		LimitUSD:          &limit,
		UsedUSD:           &used,
		RuleID:            &ruleID,
		RuleKind:          b.rule.Kind,
		Label:             b.rule.Label,
		Models:            b.rule.clientModels(),
		Reprovision:       false,
		Action:            "wait",
		Message:           msg,
	}
}

// channelMapper resolves the channel mapping of a model in a group.
type channelMapper func(ctx context.Context, groupID int64, model string) (string, bool)

func channelMapperFrom(env func() *service.ChannelService) channelMapper {
	return func(ctx context.Context, groupID int64, model string) (string, bool) {
		ch := env()
		if ch == nil {
			return "", false
		}
		res := ch.ResolveChannelMapping(ctx, groupID, model)
		if !res.Mapped || strings.TrimSpace(res.MappedModel) == "" {
			return "", false
		}
		return res.MappedModel, true
	}
}

// retryAfter is the whole seconds until t (at least 1).
func retryAfter(now, t time.Time) int {
	s := int(math.Ceil(t.Sub(now).Seconds()))
	if s < 1 {
		return 1
	}
	return s
}
