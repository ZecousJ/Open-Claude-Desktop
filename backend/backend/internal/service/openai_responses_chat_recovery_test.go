//go:build unit

package service

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
	"github.com/tidwall/gjson"
)

func forwardChatRecoveryStream(t *testing.T, upstreamBody string) (*OpenAIForwardResult, error, *httptest.ResponseRecorder) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	body := []byte(`{"model":"gpt-6.1-sol","input":"Reply with OK","stream":true}`)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/responses", bytes.NewReader(body))
	upstream := &httpUpstreamRecorder{resp: &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
		Body:       io.NopCloser(strings.NewReader(upstreamBody)),
	}}
	svc := &OpenAIGatewayService{cfg: rawChatCompletionsTestConfig(), httpUpstream: upstream}
	result, err := svc.Forward(context.Background(), c, forceChatResponsesFallbackAccount(), body)
	return result, err, recorder
}

func TestResponsesChatRecoveryEmptyStreamsFailOverWithoutCommitting(t *testing.T) {
	for name, stream := range map[string]string{
		"role then stop": "data: {\"id\":\"empty\",\"choices\":[{\"delta\":{\"role\":\"assistant\"},\"finish_reason\":null}]}\n\n" +
			"data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n",
		"explicit zero usage": "data: {\"choices\":[{\"delta\":{\"content\":\"\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":0,\"completion_tokens\":0}}\n\ndata: [DONE]\n\n",
		"done only":           "data: [DONE]\n\n",
		"EOF":                 "",
	} {
		t.Run(name, func(t *testing.T) {
			result, err, recorder := forwardChatRecoveryStream(t, stream)
			var failover *UpstreamFailoverError
			require.ErrorAs(t, err, &failover)
			require.Equal(t, http.StatusBadGateway, failover.StatusCode)
			require.Nil(t, result, "failed attempts must not be billed as successful 0/0 turns")
			require.Empty(t, recorder.Body.String(), "a second account must start with a clean response")
			require.False(t, recorder.Flushed)
		})
	}
}

func TestResponsesChatRecoveryEarlyErrorFailsOver(t *testing.T) {
	stream := "data: {\"id\":\"bad\",\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n" +
		"data: {\"error\":{\"code\":\"server_error\",\"message\":\"Upstream request failed\"}}\n\n"
	result, err, recorder := forwardChatRecoveryStream(t, stream)
	var failover *UpstreamFailoverError
	require.ErrorAs(t, err, &failover)
	require.Nil(t, result)
	require.Empty(t, recorder.Body.String())
}

func TestResponsesChatRecoveryPartialErrorsHaveOneValidFailureTerminal(t *testing.T) {
	for name, tail := range map[string]string{
		"stream error":  "data: {\"error\":{\"code\":\"server_error\",\"message\":\"Upstream request failed\"}}\n\n",
		"truncated EOF": "",
	} {
		t.Run(name, func(t *testing.T) {
			stream := "data: {\"id\":\"partial\",\"choices\":[{\"delta\":{\"content\":\"Starting\"},\"finish_reason\":null}]}\n\n" + tail
			result, err, recorder := forwardChatRecoveryStream(t, stream)
			require.Error(t, err)
			var failover *UpstreamFailoverError
			require.NotErrorAs(t, err, &failover, "partially delivered output must not be replayed")
			require.NotNil(t, result)
			require.Contains(t, recorder.Body.String(), "Starting")
			require.Equal(t, 1, strings.Count(recorder.Body.String(), "event: response.failed"))
			require.NotContains(t, recorder.Body.String(), "event: response.completed")
			require.NotContains(t, recorder.Body.String(), "data: [DONE]")
			lastSequence := int64(-1)
			for _, line := range strings.Split(recorder.Body.String(), "\n") {
				if !strings.HasPrefix(line, "data: {") {
					continue
				}
				payload := strings.TrimPrefix(line, "data: ")
				require.True(t, gjson.Get(payload, "sequence_number").Exists())
				require.Greater(t, gjson.Get(payload, "sequence_number").Int(), lastSequence)
				lastSequence = gjson.Get(payload, "sequence_number").Int()
				if gjson.Get(payload, "type").String() == "response.failed" {
					require.True(t, gjson.Get(payload, "response.created_at").Exists())
					require.Equal(t, "failed", gjson.Get(payload, "response.status").String())
					require.Equal(t, "server_error", gjson.Get(payload, "response.error.code").String())
				}
			}
		})
	}
}

func TestResponsesChatRecoveryPreservesOutputAndUsage(t *testing.T) {
	for name, chunk := range map[string]string{
		"text without usage":     `{"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}`,
		"reasoning without text": `{"choices":[{"delta":{"reasoning_content":"Thinking"},"finish_reason":"stop"}]}`,
		"tool call":              `{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_ok","type":"function","function":{"name":"list_mcp_resources","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}`,
		"accounted tokens":       `{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":0}}`,
	} {
		t.Run(name, func(t *testing.T) {
			result, err, recorder := forwardChatRecoveryStream(t, "data: "+chunk+"\n\ndata: [DONE]\n\n")
			require.NoError(t, err)
			require.NotNil(t, result)
			require.Contains(t, recorder.Body.String(), "event: response.completed")
			require.NotContains(t, recorder.Body.String(), "event: response.failed")
		})
	}
}

func TestResponsesChatRecoveryPolicyFailuresNeverFailOver(t *testing.T) {
	for name, payload := range map[string]string{
		"content filter": `{"choices":[{"delta":{},"finish_reason":"content_filter"}]}`,
		"refusal":        `{"choices":[{"delta":{"refusal":"I cannot help with that"}}]}`,
		"policy error":   `{"error":{"code":"content_policy_violation","message":"Content policy violation"}}`,
		"context limit":  `{"type":"response.failed","response":{"error":{"code":"context_length_exceeded","message":"Context length exceeded"}}}`,
	} {
		t.Run(name, func(t *testing.T) {
			_, err, rec := forwardChatRecoveryStream(t, "data: "+payload+"\n\ndata: [DONE]\n\n")
			require.Error(t, err)
			var failover *UpstreamFailoverError
			require.NotErrorAs(t, err, &failover)
			require.Equal(t, 1, strings.Count(rec.Body.String(), "event: response.failed"))
			require.NotContains(t, rec.Body.String(), "event: response.completed")
		})
	}
}

func TestResponsesChatRecoveryBufferedResponses(t *testing.T) {
	for name, tc := range map[string]struct {
		payload  string
		failover bool
		success  bool
	}{
		"empty choices": {payload: `{"choices":[]}`, failover: true},
		"empty message": {payload: `{"choices":[{"message":{"role":"assistant","content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":0,"completion_tokens":0}}`, failover: true},
		"server error":  {payload: `{"error":{"code":"server_error","message":"Upstream request failed"}}`, failover: true},
		"policy error":  {payload: `{"error":{"code":"content_policy_violation","message":"Content policy violation"}}`},
		"refusal":       {payload: `{"choices":[{"message":{"refusal":"I cannot help"},"finish_reason":"stop"}]}`},
		"filter":        {payload: `{"choices":[{"message":{},"finish_reason":"content_filter"}]}`},
		"normal output": {payload: `{"choices":[{"message":{"content":"OK"},"finish_reason":"stop"}]}`, success: true},
		"billed tokens": {payload: `{"choices":[{"message":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5}}`, success: true},
	} {
		t.Run(name, func(t *testing.T) {
			body := []byte(`{"model":"gpt-6.1-sol","input":"Hello","stream":false}`)
			rec := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(rec)
			c.Request = httptest.NewRequest(http.MethodPost, "/v1/responses", bytes.NewReader(body))
			svc := &OpenAIGatewayService{cfg: rawChatCompletionsTestConfig(), httpUpstream: &httpUpstreamRecorder{resp: &http.Response{
				StatusCode: http.StatusOK, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(tc.payload)),
			}}}
			result, err := svc.Forward(c.Request.Context(), c, forceChatResponsesFallbackAccount(), body)
			if tc.success {
				require.NoError(t, err)
				require.NotNil(t, result)
				require.Equal(t, "completed", gjson.GetBytes(rec.Body.Bytes(), "status").String())
				return
			}
			require.Error(t, err)
			require.Nil(t, result)
			var failover *UpstreamFailoverError
			if tc.failover {
				require.ErrorAs(t, err, &failover)
				require.Empty(t, rec.Body.String())
			} else {
				require.NotErrorAs(t, err, &failover)
				require.Equal(t, http.StatusBadRequest, rec.Code)
			}
		})
	}
}

type chatRecoveryHTTPUpstream struct {
	HTTPUpstream
	client *http.Client
}

func (u *chatRecoveryHTTPUpstream) Do(req *http.Request, _ string, _ int64, _ int) (*http.Response, error) {
	return u.client.Do(req)
}

func TestResponsesChatRecoveryFirstOutputDeadline(t *testing.T) {
	for _, phase := range []string{"headers", "role and heartbeat"} {
		t.Run(phase, func(t *testing.T) {
			canceled := make(chan struct{})
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.Copy(io.Discard, r.Body)
				if phase != "headers" {
					w.Header().Set("Content-Type", "text/event-stream")
					_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"\"}}]}\n\n: ping\n\n")
					w.(http.Flusher).Flush()
				}
				<-r.Context().Done()
				close(canceled)
			}))
			defer server.Close()
			body := []byte(`{"model":"gpt-6.1-sol","input":"Hello","stream":true}`)
			rec := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(rec)
			c.Request = httptest.NewRequest(http.MethodPost, "/v1/responses", bytes.NewReader(body))
			cfg := rawChatCompletionsTestConfig()
			cfg.Gateway.OpenAIFirstOutputTimeoutSeconds = 1
			svc := &OpenAIGatewayService{cfg: cfg, httpUpstream: &chatRecoveryHTTPUpstream{client: server.Client()}}
			account := forceChatResponsesFallbackAccount()
			account.Credentials["base_url"] = server.URL
			result, err := svc.Forward(c.Request.Context(), c, account, body)
			var failover *UpstreamFailoverError
			require.ErrorAs(t, err, &failover)
			require.Equal(t, http.StatusGatewayTimeout, failover.StatusCode)
			require.Nil(t, result)
			require.Empty(t, rec.Body.String())
			require.False(t, rec.Flushed)
			select {
			case <-canceled:
			case <-time.After(time.Second):
				t.Fatal("timeout must cancel the actual upstream HTTP request")
			}
		})
	}
}

func TestResponsesChatRecoveryStopsDeadlineAfterRealOutput(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Starting\"}}]}\n\n")
		w.(http.Flusher).Flush()
		select {
		case <-time.After(1200 * time.Millisecond):
			_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\" finished\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
		case <-r.Context().Done():
		}
	}))
	defer server.Close()
	body := []byte(`{"model":"gpt-6.1-sol","input":"Hello","stream":true}`)
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/responses", bytes.NewReader(body))
	cfg := rawChatCompletionsTestConfig()
	cfg.Gateway.OpenAIFirstOutputTimeoutSeconds = 1
	svc := &OpenAIGatewayService{cfg: cfg, httpUpstream: &chatRecoveryHTTPUpstream{client: server.Client()}}
	account := forceChatResponsesFallbackAccount()
	account.Credentials["base_url"] = server.URL
	result, err := svc.Forward(c.Request.Context(), c, account, body)
	require.NoError(t, err, "legitimate generation after the first token must not be cut off")
	require.NotNil(t, result)
	require.Contains(t, rec.Body.String(), " finished")
	require.Contains(t, rec.Body.String(), "event: response.completed")
}

func TestResponsesChatRecoveryIdleStreamClosesAndTerminates(t *testing.T) {
	for _, partialTool := range []bool{false, true} {
		name := "before output"
		if partialTool {
			name = "after incomplete tool arguments"
		}
		t.Run(name, func(t *testing.T) {
			canceled := make(chan struct{})
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.Copy(io.Discard, r.Body)
				w.Header().Set("Content-Type", "text/event-stream")
				payload := `{"choices":[{"delta":{"role":"assistant"}}]}`
				if partialTool {
					payload = `{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_partial","type":"function","function":{"name":"list_mcp_resources","arguments":"{"}}]}}]}`
				}
				_, _ = io.WriteString(w, "data: "+payload+"\n\n")
				w.(http.Flusher).Flush()
				<-r.Context().Done()
				close(canceled)
			}))
			defer server.Close()
			body := []byte(`{"model":"gpt-6.1-sol","input":"Hello","stream":true}`)
			rec := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(rec)
			c.Request = httptest.NewRequest(http.MethodPost, "/v1/responses", bytes.NewReader(body))
			cfg := rawChatCompletionsTestConfig()
			cfg.Gateway.StreamDataIntervalTimeout = 1
			cfg.Gateway.OpenAIFirstOutputTimeoutSeconds = 5
			svc := &OpenAIGatewayService{cfg: cfg, httpUpstream: &chatRecoveryHTTPUpstream{client: server.Client()}}
			account := forceChatResponsesFallbackAccount()
			account.Credentials["base_url"] = server.URL
			result, err := svc.Forward(c.Request.Context(), c, account, body)
			var failover *UpstreamFailoverError
			if partialTool {
				require.ErrorIs(t, err, errCCStreamIdleTimeout)
				require.NotErrorAs(t, err, &failover)
				require.NotNil(t, result)
				require.Equal(t, 1, strings.Count(rec.Body.String(), "event: response.failed"))
				require.NotContains(t, rec.Body.String(), "event: response.completed")
			} else {
				require.ErrorAs(t, err, &failover)
				require.Contains(t, string(failover.ResponseBody), errCCStreamIdleTimeout.Error())
				require.Nil(t, result)
				require.Empty(t, rec.Body.String())
			}
			select {
			case <-canceled:
			case <-time.After(time.Second):
				t.Fatal("idle stream must release its upstream connection")
			}
		})
	}
}
