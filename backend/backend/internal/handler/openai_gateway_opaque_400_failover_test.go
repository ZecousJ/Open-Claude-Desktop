package handler

import (
	"encoding/json"
	"fmt"
	"io"
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

func TestOpenAIResponses_OpaqueInvalidRequestFailover(t *testing.T) {
	const opaque400 = `{"error":{"code":"invalid_request","message":"请求参数不符合要求，请检查错误字段和输入内容。","type":"invalid_request_error"},"request_id":"req_first"}`
	const field400 = `{"error":{"code":"invalid_request","message":"请求参数不符合要求，请检查错误字段和输入内容。","type":"invalid_request_error","param":"input"},"request_id":"req_first"}`
	const completed = `data: {"type":"response.output_text.delta","item_id":"msg_healthy","output_index":0,"content_index":0,"delta":"fallback answer"}

data: {"type":"response.completed","response":{"id":"resp_healthy","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"fallback answer"}]}],"usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}

`
	for _, tt := range []struct {
		name        string
		passthrough bool
		firstBody   string
		secondFails bool
		wantStatus  int
		wantHits    [2]int32
	}{
		{name: "switches accounts", firstBody: opaque400, wantStatus: http.StatusOK, wantHits: [2]int32{1, 1}},
		{name: "passthrough switches accounts", passthrough: true, firstBody: opaque400, wantStatus: http.StatusOK, wantHits: [2]int32{1, 1}},
		{name: "eligible accounts exhausted", firstBody: opaque400, secondFails: true, wantStatus: http.StatusBadGateway, wantHits: [2]int32{1, 1}},
		{name: "named parameter rejected", firstBody: field400, wantStatus: http.StatusBadRequest, wantHits: [2]int32{1, 0}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			gin.SetMode(gin.TestMode)
			var hits [2]atomic.Int32
			accountRepo := &openAIWSFailoverHandlerAccountRepoStub{}
			for i := range hits {
				upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					hits[i].Add(1)
					assert.Equal(t, "/v1/responses", r.URL.Path)
					body, err := io.ReadAll(r.Body)
					assert.NoError(t, err)
					assert.Equal(t, "gpt-6.1-sol", gjson.GetBytes(body, "model").String())
					assert.Equal(t, "hello", gjson.GetBytes(body, "input").String())
					if i == 0 || (i == 1 && tt.secondFails) {
						w.Header().Set("Content-Type", "application/json")
						w.WriteHeader(http.StatusBadRequest)
						_, _ = fmt.Fprint(w, tt.firstBody)
						return
					}
					w.Header().Set("Content-Type", "text/event-stream")
					_, _ = fmt.Fprint(w, completed)
				}))
				t.Cleanup(upstream.Close)
				accountRepo.accounts = append(accountRepo.accounts, service.Account{
					ID: int64(i + 1), Platform: service.PlatformOpenAI, Type: service.AccountTypeAPIKey,
					Status: service.StatusActive, Schedulable: true, Priority: i + 1,
					Credentials: map[string]any{"api_key": "sk-test", "base_url": upstream.URL},
					Extra:       map[string]any{"openai_passthrough": tt.passthrough},
				})
			}

			cfg := &config.Config{RunMode: config.RunModeSimple}
			cfg.Default.RateMultiplier = 1
			cfg.Security.URLAllowlist.AllowInsecureHTTP = true
			usageRepo := &openAIWSUsageHandlerUsageLogRepoStub{created: make(chan *service.UsageLog, 3)}
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
			c.Request = httptest.NewRequest(http.MethodPost, "/openai/v1/responses", strings.NewReader(`{"model":"gpt-6.1-sol","input":"hello","stream":true}`))
			c.Request.Header.Set("Content-Type", "application/json")
			c.Set(string(middleware.ContextKeyAPIKey), &service.APIKey{
				ID: 1805, GroupID: &groupID,
				User:  &service.User{ID: 1705, Status: service.StatusActive},
				Group: &service.Group{ID: groupID, Platform: service.PlatformOpenAI, Status: service.StatusActive},
			})
			c.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: 1705})

			h.Responses(c)

			body := rec.Body.String()
			require.Equal(t, tt.wantStatus, rec.Code, body)
			require.Equal(t, tt.wantHits, [2]int32{hits[0].Load(), hits[1].Load()})
			switch tt.wantStatus {
			case http.StatusOK:
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
					case "error", "response.failed":
						t.Fatalf("unexpected downstream error: %s", payload)
					}
				}
				require.Equal(t, []string{"fallback answer"}, deltas)
				require.Equal(t, []string{"resp_healthy"}, completions)
				require.NotContains(t, body, "req_first")
				require.NotContains(t, body, "请求参数不符合要求")
			case http.StatusBadGateway:
				require.True(t, json.Valid(rec.Body.Bytes()), body)
				require.Equal(t, "upstream_error", gjson.Get(body, "error.type").String())
				require.NotContains(t, body, "req_first")
			case http.StatusBadRequest:
				require.True(t, json.Valid(rec.Body.Bytes()), body)
				require.Equal(t, "input", gjson.Get(body, "error.param").String())
			}
		})
	}
}
