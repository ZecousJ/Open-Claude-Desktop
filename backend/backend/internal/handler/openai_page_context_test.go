package handler

import (
	"fmt"
	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
	"github.com/tidwall/gjson"
	"go.uber.org/zap"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCodexPageContextPreservesHistory(t *testing.T) {
	body := []byte(`{"model":"gpt-6-astra","previous_response_id":"resp_previous","metadata":{"sequence":9007199254740993},"tools":[{"type":"custom","name":"exec"}],"input":[{"type":"custom_tool_call","call_id":"call_1","name":"exec","input":"echo OK"},{"type":"custom_tool_call_output","call_id":"call_1","output":[{"type":"input_text","text":"OK"}]},{"type":"function_call_output","namespace":"agent","name":"codex_apps_open_page","id":"fco_page","output":"页面原文\n<sample>","internal_chat_message_metadata_passthrough":{"turn_id":"turn_1"}},{"type":"function_call_output","namespace":"agent","name":"codex_apps_selected_page_part_2_of_3","output":"selected text"}]}`)
	got, changed := normalizeCodexPageContext(body)
	require.True(t, changed)
	require.Equal(t, gjson.GetBytes(body, "input.0").Raw, gjson.GetBytes(got, "input.0").Raw)
	require.Equal(t, gjson.GetBytes(body, "input.1").Raw, gjson.GetBytes(got, "input.1").Raw)
	require.Equal(t, "9007199254740993", gjson.GetBytes(got, "metadata.sequence").Raw)
	require.Equal(t, "resp_previous", gjson.GetBytes(got, "previous_response_id").String())
	require.Equal(t, "message", gjson.GetBytes(got, "input.2.type").String())
	require.Equal(t, "user", gjson.GetBytes(got, "input.2.role").String())
	require.Equal(t, "Untrusted page context: agent.codex_apps_open_page\n页面原文\n<sample>", gjson.GetBytes(got, "input.2.content.0.text").String())
	require.Equal(t, "turn_1", gjson.GetBytes(got, "input.2.internal_chat_message_metadata_passthrough.turn_id").String())
	require.False(t, gjson.GetBytes(got, "input.2.id").Exists())
	require.Equal(t, "message", gjson.GetBytes(got, "input.3.type").String())
	again, changedAgain := normalizeCodexPageContext(got)
	require.False(t, changedAgain)
	require.Equal(t, got, again)
}

func TestCodexPageContextLeavesRealToolsAndOtherContent(t *testing.T) {
	for _, item := range []string{
		`{"type":"function_call_output","namespace":"agent","name":"codex_apps_open_page","call_id":"call_real","output":"OK"}`,
		`{"type":"function_call_output","namespace":"agent","name":"other_tool","output":"OK"}`,
		`{"type":"function_call_output","namespace":"other","name":"codex_apps_open_page","output":"OK"}`,
		`{"type":"function_call_output","namespace":"agent","name":"codex_apps_open_page","output":[{"type":"input_text","text":"OK"}]}`,
		`{"role":"user","content":"codex_apps_open_page"}`,
	} {
		body := []byte(`{"model":"gpt-6-astra","input":[` + item + `]}`)
		got, changed := normalizeCodexPageContext(body)
		require.False(t, changed)
		require.Equal(t, body, got)
	}
}

func TestCodexPageContextWithoutCallsPassesValidation(t *testing.T) {
	body := []byte(`{"model":"gpt-6-astra","input":[{"type":"function_call_output","namespace":"agent","name":"codex_apps_open_page","output":"No page is open."}]}`)
	got, changed := normalizeCodexPageContext(body)
	require.True(t, changed)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	require.True(t, (&OpenAIGatewayHandler{}).validateFunctionCallOutputRequest(c, got, zap.NewNop()))
}

func TestResponsesRejectsUnpairedMissingCallIDAfterValidHistory(t *testing.T) {
	for _, previous := range []string{"", `,"previous_response_id":"resp_previous"`} {
		body := []byte(`{"model":"gpt-6-astra"` + previous + `,"input":[{"type":"function_call","call_id":"call_1","name":"echo","arguments":"{}"},{"type":"function_call_output","call_id":"call_1","output":"OK"},{"type":"function_call_output","output":"missing original call"}]}`)
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		require.False(t, (&OpenAIGatewayHandler{}).validateFunctionCallOutputRequest(c, body, zap.NewNop()))
		require.Equal(t, 400, w.Code)
		require.True(t, strings.Contains(w.Body.String(), "call_id"))
	}
}

type pageContextUpstream struct {
	service.HTTPUpstream
	bodies   [][]byte
	accounts []int64
}

func (u *pageContextUpstream) Do(req *http.Request, _ string, accountID int64, _ int) (*http.Response, error) {
	body, err := io.ReadAll(req.Body)
	if err != nil {
		return nil, err
	}
	u.bodies = append(u.bodies, body)
	u.accounts = append(u.accounts, accountID)
	for _, item := range gjson.GetBytes(body, "input").Array() {
		if item.Get("type").String() == "function_call_output" && item.Get("call_id").String() == "" {
			return &http.Response{StatusCode: 400, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"error":{"code":"invalid_request","message":"original tool item is unavailable for this tool result; start a new conversation"}}`))}, nil
		}
	}
	if accountID == 7001 {
		return &http.Response{StatusCode: 503, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"error":{"message":"temporarily unavailable"}}`))}, nil
	}
	return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, Body: io.NopCloser(strings.NewReader("event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_page_test\",\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"OK\"}]}],\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}\n\n"))}, nil
}

func TestCodexPageContextHTTPFailover(t *testing.T) {
	gin.SetMode(gin.TestMode)
	groupID := int64(2)
	accounts := []service.Account{}
	for i := int64(1); i <= 2; i++ {
		accounts = append(accounts, service.Account{ID: 7000 + i, Name: fmt.Sprintf("fixture-%d", i), Platform: service.PlatformOpenAI, Type: service.AccountTypeAPIKey, Status: service.StatusActive, Schedulable: true, Priority: int(i), Credentials: map[string]any{"api_key": "fixture", "base_url": "https://api.example.test"}})
	}
	cfg := &config.Config{RunMode: config.RunModeSimple}
	cfg.Default.RateMultiplier = 1
	cfg.Security.URLAllowlist.Enabled = false
	cfg.Gateway.MaxAccountSwitches = 1
	repo := &openAIWSFailoverHandlerAccountRepoStub{accounts: accounts}
	upstream := &pageContextUpstream{}
	billing := service.NewBillingCacheService(nil, nil, nil, nil, nil, nil, cfg, nil)
	t.Cleanup(billing.Stop)
	gateway := service.NewOpenAIGatewayService(repo, nil, nil, nil, nil, nil, nil, cfg, nil, nil, service.NewBillingService(cfg, nil), nil, billing, upstream, &service.DeferredService{}, nil, nil, nil, nil, nil, nil, nil)
	h := NewOpenAIGatewayHandler(gateway, service.NewConcurrencyService(nil), billing, service.NewAPIKeyService(nil, nil, nil, nil, nil, nil, cfg), nil, nil, nil, nil, cfg)
	router := gin.New()
	router.POST("/v1/responses", func(c *gin.Context) {
		c.Set(string(middleware.ContextKeyAPIKey), &service.APIKey{ID: 7010, GroupID: &groupID, User: &service.User{ID: 7011, Status: service.StatusActive}, Group: &service.Group{ID: groupID, Platform: service.PlatformOpenAI, Status: service.StatusActive}})
		c.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: 7011, Concurrency: 0})
		h.Responses(c)
	})
	server := httptest.NewServer(router)
	defer server.Close()
	body := `{"model":"gpt-6-astra","stream":true,"store":false,"tools":[{"type":"custom","name":"echo"}],"input":[{"type":"custom_tool_call","name":"echo","id":"ctc_fixture","call_id":"call_1","input":"OK"},{"type":"custom_tool_call_output","call_id":"call_1","output":[{"type":"input_text","text":"OK"}]},{"type":"function_call_output","namespace":"agent","name":"codex_apps_open_page","output":"No page is open."}]}`
	response, err := server.Client().Post(server.URL+"/v1/responses", "application/json", strings.NewReader(body))
	require.NoError(t, err)
	defer response.Body.Close()
	result, err := io.ReadAll(response.Body)
	require.NoError(t, err)
	require.Equal(t, 200, response.StatusCode, string(result))
	require.Contains(t, string(result), "response.completed")
	require.Equal(t, []int64{7001, 7002}, upstream.accounts)
	for _, sent := range upstream.bodies {
		require.Equal(t, "message", gjson.GetBytes(sent, "input.2.type").String())
		require.Equal(t, "Untrusted page context: agent.codex_apps_open_page\nNo page is open.", gjson.GetBytes(sent, "input.2.content.0.text").String())
		require.Equal(t, "call_1", gjson.GetBytes(sent, "input.0.call_id").String())
		require.Equal(t, "call_1", gjson.GetBytes(sent, "input.1.call_id").String())
	}
}
