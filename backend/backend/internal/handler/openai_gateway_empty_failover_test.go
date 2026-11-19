package handler

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/repository"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/tidwall/gjson"
)

func TestOpenAIResponses_EmptyCompletedStreamFailsOver(t *testing.T) {
	const emptyCompleted = `data: {"type":"response.completed","response":{"id":"%s","status":"completed","output":[],"usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0}}}

`
	const healthyCompleted = `data: {"type":"response.output_text.delta","item_id":"msg_healthy","output_index":0,"content_index":0,"delta":"fallback answer"}

data: {"type":"response.completed","response":{"id":"%s","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"fallback answer"}]}],"usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}

`
	for _, tt := range []struct {
		name             string
		secondCompletion string
		wantStatus       int
	}{
		{name: "fallback returns output", secondCompletion: healthyCompleted, wantStatus: http.StatusOK},
		{name: "both accounts return empty", secondCompletion: emptyCompleted, wantStatus: http.StatusBadGateway},
	} {
		t.Run(tt.name, func(t *testing.T) {
			gin.SetMode(gin.TestMode)
			newUpstream := func(responseID, completion string, hits *atomic.Int32) *httptest.Server {
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					hits.Add(1)
					assert.Equal(t, http.MethodPost, r.Method)
					assert.Equal(t, "/v1/responses", r.URL.Path)
					w.Header().Set("Content-Type", "text/event-stream")
					_, _ = fmt.Fprintf(w, "data: {\"type\":\"response.created\",\"response\":{\"id\":%q,\"status\":\"in_progress\",\"output\":[]}}\n\n", responseID)
					_, _ = fmt.Fprintf(w, completion, responseID)
				}))
				t.Cleanup(server.Close)
				return server
			}

			var firstHits, secondHits atomic.Int32
			first := newUpstream("resp_empty_first", emptyCompleted, &firstHits)
			second := newUpstream("resp_second", tt.secondCompletion, &secondHits)
			accountRepo := &openAIWSFailoverHandlerAccountRepoStub{accounts: []service.Account{
				{
					ID: 9914, Platform: service.PlatformOpenAI, Type: service.AccountTypeAPIKey,
					Status: service.StatusActive, Schedulable: true, Priority: 1,
					Credentials: map[string]any{"api_key": "sk-first", "base_url": first.URL},
					Extra:       map[string]any{"openai_passthrough": true},
				},
				{
					ID: 9915, Platform: service.PlatformOpenAI, Type: service.AccountTypeAPIKey,
					Status: service.StatusActive, Schedulable: true, Priority: 2,
					Credentials: map[string]any{"api_key": "sk-second", "base_url": second.URL},
					Extra:       map[string]any{"openai_passthrough": true},
				},
			}}
			cfg := &config.Config{RunMode: config.RunModeSimple}
			cfg.Default.RateMultiplier = 1
			cfg.Security.URLAllowlist.AllowInsecureHTTP = true
			cfg.Gateway.MaxAccountSwitches = 1
			usageRepo := &openAIWSUsageHandlerUsageLogRepoStub{created: make(chan *service.UsageLog, 4)}
			billingCache := service.NewBillingCacheService(nil, nil, nil, nil, nil, nil, cfg, nil)
			t.Cleanup(billingCache.Stop)
			gateway := service.NewOpenAIGatewayService(
				accountRepo, usageRepo, nil, nil, nil, nil, nil, cfg, nil, nil,
				service.NewBillingService(cfg, nil), nil, billingCache, repository.NewHTTPUpstream(cfg),
				&service.DeferredService{}, nil, nil, nil, nil, nil, nil, nil,
			)
			h := NewOpenAIGatewayHandler(
				gateway, service.NewConcurrencyService(nil), billingCache,
				service.NewAPIKeyService(nil, nil, nil, nil, nil, nil, cfg),
				nil, nil, nil, nil, cfg,
			)

			groupID := int64(4205)
			rec := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(rec)
			c.Request = httptest.NewRequest(http.MethodPost, "/openai/v1/responses", strings.NewReader(`{"model":"gpt-5.2","input":"hello","stream":true}`))
			c.Request.Header.Set("Content-Type", "application/json")
			c.Set(string(middleware.ContextKeyAPIKey), &service.APIKey{
				ID: 1805, GroupID: &groupID,
				User:  &service.User{ID: 1705, Status: service.StatusActive},
				Group: &service.Group{ID: groupID, Platform: service.PlatformOpenAI, Status: service.StatusActive},
			})
			c.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: 1705})

			h.Responses(c)

			require.Equal(t, tt.wantStatus, rec.Code, rec.Body.String())
			require.EqualValues(t, 1, firstHits.Load())
			require.EqualValues(t, 1, secondHits.Load())
			body := rec.Body.String()
			require.NotContains(t, body, "resp_empty_first")
			if tt.wantStatus == http.StatusBadGateway {
				require.Contains(t, rec.Result().Header.Get("Content-Type"), "application/json")
				require.Equal(t, "upstream_error", gjson.Get(body, "error.type").String())
				require.Contains(t, gjson.Get(body, "error.message").String(), "empty completion")
				require.NotContains(t, body, "resp_second")
				require.NotContains(t, body, "response.completed")
				require.Empty(t, usageRepo.created)
				return
			}
			require.Contains(t, rec.Result().Header.Get("Content-Type"), "text/event-stream")
			var deltas, completions []string
			for line := range strings.SplitSeq(body, "\n") {
				payload, ok := strings.CutPrefix(line, "data: ")
				if !ok {
					continue
				}
				event := gjson.Parse(payload)
				switch event.Get("type").String() {
				case "response.output_text.delta":
					deltas = append(deltas, event.Get("delta").String())
				case "response.completed":
					completions = append(completions, event.Get("response.id").String())
				}
			}
			require.Equal(t, []string{"fallback answer"}, deltas)
			require.Equal(t, []string{"resp_second"}, completions)
			require.Len(t, usageRepo.created, 1)
			usage := <-usageRepo.created
			require.Equal(t, int64(9915), usage.AccountID)
			require.Equal(t, 2, usage.InputTokens)
			require.Equal(t, 3, usage.OutputTokens)
		})
	}
}
