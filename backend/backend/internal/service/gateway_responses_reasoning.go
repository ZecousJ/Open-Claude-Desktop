package service

import (
	"bytes"
	"context"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/pkg/apicompat"
	"github.com/Wei-Shaw/sub2api/internal/pkg/logger"
	"github.com/gin-gonic/gin"
	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
	"go.uber.org/zap"
)

const responsesReasoningCacheTTL = 7 * 24 * time.Hour

func isClaudexCodeResponsesRequest(c *gin.Context) bool {
	return c.Request != nil && strings.EqualFold(strings.TrimSpace(c.GetHeader("X-Claudex-Product")), "code")
}

type responsesReasoningCache struct {
	store     GatewayCache
	keyPrefix string
}

func (cache responsesReasoningCache) get(itemID string) string {
	if cache.store == nil {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	content, err := cache.store.GetReasoningContent(ctx, cache.keyPrefix+itemID)
	if err != nil {
		return ""
	}
	return content
}

func (cache responsesReasoningCache) set(itemID, content string) {
	if cache.store == nil {
		return
	}
	// A client disconnect does not cancel the upstream drain or its replay state.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := cache.store.SetReasoningContent(ctx, cache.keyPrefix+itemID, content, responsesReasoningCacheTTL); err != nil {
		logger.L().Warn("responses fallback: cache reasoning content failed", zap.Error(err), zap.String("item_id", itemID))
	}
}

type codeAnthropicThinkingCache struct {
	get func(string) string
	set apicompat.CachePrivateReasoning
}

func privateAnthropicThinkingCache(c *gin.Context, store GatewayCache) codeAnthropicThinkingCache {
	if !isClaudexCodeResponsesRequest(c) {
		return codeAnthropicThinkingCache{}
	}
	// Chat Completions replays raw text; Anthropic replays a signed block.
	cache := responsesReasoningCache{store: store, keyPrefix: "anthropic:"}
	return codeAnthropicThinkingCache{get: cache.get, set: cache.set}
}

func dropPrivateReasoningReplay(body []byte) ([]byte, error) {
	if !bytes.Contains(body, []byte(apicompat.PrivateReasoningReplayPrefix)) {
		return body, nil
	}
	input := gjson.GetBytes(body, "input")
	if !input.IsArray() {
		return body, nil
	}
	var kept []string
	dropped := false
	input.ForEach(func(_, item gjson.Result) bool {
		if item.Get("type").String() == "reasoning" && strings.HasPrefix(item.Get("encrypted_content").String(), apicompat.PrivateReasoningReplayPrefix) {
			dropped = true
		} else {
			kept = append(kept, item.Raw)
		}
		return true
	})
	if !dropped {
		return body, nil
	}
	return sjson.SetRawBytes(body, "input", []byte("["+strings.Join(kept, ",")+"]"))
}
