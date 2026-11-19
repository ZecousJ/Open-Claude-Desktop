//go:build unit

package handler

import (
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/pkg/openai_compat"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func chatRecoveryResponse(payload string) *http.Response {
	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
		Body:       io.NopCloser(strings.NewReader(payload)),
	}
}

func chatRecoveryAccounts() []service.Account {
	accounts := make([]service.Account, 2)
	for i := range accounts {
		accounts[i] = service.Account{
			ID: int64(i + 1), Name: "chat-fallback", Platform: service.PlatformOpenAI,
			Type: service.AccountTypeAPIKey, Status: service.StatusActive, Schedulable: true,
			Priority:    i,
			Credentials: map[string]any{"api_key": "test-token", "base_url": "https://upstream.example"},
			Extra:       map[string]any{openai_compat.ExtraKeyResponsesMode: string(openai_compat.ResponsesSupportModeForceChatCompletions)},
		}
	}
	return accounts
}

const chatRecoveryRequest = `{"model":"gpt-6.1-sol","stream":true,"input":"hello"}`
const chatRecoveryEmpty = "data: {\"id\":\"failed_attempt\",\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n" +
	"data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"
const chatRecoverySuccess = "data: {\"id\":\"winning_attempt\",\"choices\":[{\"delta\":{\"content\":\"Recovered answer\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":3}}\n\ndata: [DONE]\n\n"

func TestOpenAIGatewayHandlerResponses_ChatRecoverySwitchesBeforeOutput(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for name, first := range map[string]string{
		"empty completion": chatRecoveryEmpty,
		"stream error":     "data: {\"error\":{\"code\":\"server_error\",\"message\":\"Upstream request failed\"}}\n\n",
	} {
		t.Run(name, func(t *testing.T) {
			upstream := newAstraProCapturedUpstream(chatRecoveryResponse(first), chatRecoveryResponse(chatRecoverySuccess))
			h := newOpenAIResponsesFailoverTestHandler(t, upstream, chatRecoveryAccounts())
			c, rec := newAstraProFailoverContext(t, chatRecoveryRequest)
			h.Responses(c)
			urls, accountIDs, _ := upstream.snapshot()
			require.Equal(t, []int64{1, 2}, accountIDs)
			for _, url := range urls {
				require.Equal(t, "https://upstream.example/v1/chat/completions", url)
			}
			require.Equal(t, http.StatusOK, rec.Code)
			require.Contains(t, rec.Body.String(), "Recovered answer")
			require.NotContains(t, rec.Body.String(), "failed_attempt")
			require.Equal(t, 1, strings.Count(rec.Body.String(), "event: response.created"))
			require.Equal(t, 1, strings.Count(rec.Body.String(), "event: response.completed"))
			require.NotContains(t, rec.Body.String(), "event: response.failed")
		})
	}
}

func TestOpenAIGatewayHandlerResponses_ChatRecoveryExhaustionIsExplicit(t *testing.T) {
	gin.SetMode(gin.TestMode)
	upstream := newAstraProCapturedUpstream(chatRecoveryResponse(chatRecoveryEmpty), chatRecoveryResponse(chatRecoveryEmpty))
	h := newOpenAIResponsesFailoverTestHandler(t, upstream, chatRecoveryAccounts())
	c, rec := newAstraProFailoverContext(t, chatRecoveryRequest)
	h.Responses(c)
	_, accountIDs, _ := upstream.snapshot()
	require.Equal(t, []int64{1, 2}, accountIDs)
	require.Contains(t, rec.Body.String(), "upstream_error")
	require.NotContains(t, rec.Body.String(), "event: response.completed")
	require.NotContains(t, rec.Body.String(), "failed_attempt")
}

func TestOpenAIGatewayHandlerResponses_ChatRecoveryDoesNotReplayPartialOutput(t *testing.T) {
	gin.SetMode(gin.TestMode)
	partial := "data: {\"choices\":[{\"delta\":{\"content\":\"Partial answer\"}}]}\n\n" +
		"data: {\"error\":{\"code\":\"server_error\",\"message\":\"Upstream request failed\"}}\n\n"
	upstream := newAstraProCapturedUpstream(chatRecoveryResponse(partial), chatRecoveryResponse(chatRecoverySuccess))
	h := newOpenAIResponsesFailoverTestHandler(t, upstream, chatRecoveryAccounts())
	c, rec := newAstraProFailoverContext(t, chatRecoveryRequest)
	h.Responses(c)
	_, accountIDs, _ := upstream.snapshot()
	require.Equal(t, []int64{1}, accountIDs)
	require.Contains(t, rec.Body.String(), "Partial answer")
	require.Equal(t, 1, strings.Count(rec.Body.String(), "event: response.failed"))
	require.NotContains(t, rec.Body.String(), "event: response.completed")
	require.NotContains(t, rec.Body.String(), "Recovered answer")
}
