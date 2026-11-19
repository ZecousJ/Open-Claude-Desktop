//go:build unit

package service

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// TestOpenAIResponsesEmptyCompletedFailsOver verifies that a Responses stream
// ending with an empty response.completed (no output, no usage, no error) is
// turned into a failover error instead of a successful empty reply (issue
// #5009).
func TestOpenAIResponsesEmptyCompletedFailsOver(t *testing.T) {
	gin.SetMode(gin.TestMode)

	upstream := &httpUpstreamRecorder{resp: &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
		Body: io.NopCloser(strings.NewReader(
			"data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_empty\",\"object\":\"response\",\"status\":\"in_progress\"}}\n\n" +
				"data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_empty\",\"object\":\"response\",\"status\":\"completed\"}}\n\n",
		)),
	}}
	svc := newOpenAIImageGenerationControlTestService(upstream)
	c, recorder := newOpenAIImageGenerationControlTestContext(true, "codex_cli_rs/0.144.1")
	account := newOpenAIImageGenerationControlTestAccount()
	account.Extra = map[string]any{"openai_passthrough": true}

	body := []byte(`{
		"model":"gpt-5.6-sol",
		"stream":true,
		"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"continue"}]}]
	}`)

	_, err := svc.Forward(context.Background(), c, account, body)
	require.Error(t, err)
	var failoverErr *UpstreamFailoverError
	require.True(t, errors.As(err, &failoverErr), "empty completed must produce UpstreamFailoverError, got: %v", err)
	require.Equal(t, http.StatusBadGateway, failoverErr.StatusCode)
	require.Empty(t, recorder.Body.String(), "no empty success stream may reach the client")
}

// TestOpenAIResponsesEmptyCompletedWithOutputSucceeds ensures streams with real
// semantic output are untouched.
func TestOpenAIResponsesEmptyCompletedWithOutputSucceeds(t *testing.T) {
	gin.SetMode(gin.TestMode)

	upstream := &httpUpstreamRecorder{resp: &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
		Body: io.NopCloser(strings.NewReader(
			"data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_ok\",\"object\":\"response\",\"status\":\"in_progress\"}}\n\n" +
				"data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\n" +
				"data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_ok\",\"object\":\"response\",\"status\":\"completed\",\"usage\":{\"input_tokens\":10,\"output_tokens\":5,\"total_tokens\":15}}}\n\n",
		)),
	}}
	svc := newOpenAIImageGenerationControlTestService(upstream)
	c, recorder := newOpenAIImageGenerationControlTestContext(true, "codex_cli_rs/0.144.1")
	account := newOpenAIImageGenerationControlTestAccount()
	account.Extra = map[string]any{"openai_passthrough": true}

	body := []byte(`{
		"model":"gpt-5.6-sol",
		"stream":true,
		"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"continue"}]}]
	}`)

	result, err := svc.Forward(context.Background(), c, account, body)
	require.NoError(t, err)
	require.NotNil(t, result)
	require.Contains(t, recorder.Body.String(), "hello")
	require.NotNil(t, result.Usage)
	require.Equal(t, 10, result.Usage.InputTokens)
	require.Equal(t, 5, result.Usage.OutputTokens)
}

// TestOpenAIResponsesEmptyCompletedWithUsageSucceeds ensures a completed event
// carrying usage is not mistaken for a silent refusal even without output.
func TestOpenAIResponsesEmptyCompletedWithUsageSucceeds(t *testing.T) {
	gin.SetMode(gin.TestMode)

	upstream := &httpUpstreamRecorder{resp: &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
		Body: io.NopCloser(strings.NewReader(
			"data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_usage\",\"object\":\"response\",\"status\":\"in_progress\"}}\n\n" +
				"data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_usage\",\"object\":\"response\",\"status\":\"completed\",\"usage\":{\"input_tokens\":3,\"output_tokens\":0,\"total_tokens\":3}}}\n\n",
		)),
	}}
	svc := newOpenAIImageGenerationControlTestService(upstream)
	c, _ := newOpenAIImageGenerationControlTestContext(true, "codex_cli_rs/0.144.1")
	account := newOpenAIImageGenerationControlTestAccount()
	account.Extra = map[string]any{"openai_passthrough": true}

	body := []byte(`{
		"model":"gpt-5.6-sol",
		"stream":true,
		"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"continue"}]}]
	}`)

	result, err := svc.Forward(context.Background(), c, account, body)
	require.NoError(t, err)
	require.NotNil(t, result)
	require.NotNil(t, result.Usage)
	require.Equal(t, 3, result.Usage.InputTokens)
}

func TestOpenAIResponsesCompletedWithZeroOrMissingUsage(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, mode := range []struct {
		name        string
		passthrough bool
		stream      bool
		upstreamSSE bool
	}{
		{name: "transformed stream", stream: true, upstreamSSE: true},
		{name: "passthrough stream", passthrough: true, stream: true, upstreamSSE: true},
		{name: "transformed buffered SSE", upstreamSSE: true},
		{name: "passthrough buffered SSE", passthrough: true, upstreamSSE: true},
		{name: "transformed buffered JSON"},
		{name: "passthrough buffered JSON", passthrough: true},
	} {
		t.Run(mode.name, func(t *testing.T) {
			for _, tc := range []struct {
				name        string
				fields      string
				earlyEvent  string
				wantOutput  string
				inputTokens int
			}{
				{name: "zero usage", fields: `"output":[],"usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0}`},
				{name: "null error", fields: `"output":[],"error":null`},
				{name: "positive usage", fields: `"output":[],"usage":{"input_tokens":3,"output_tokens":0,"total_tokens":3}`, inputTokens: 3},
				{name: "tool call without usage", fields: `"output":[{"type":"function_call","id":"fc_1","call_id":"call_1","name":"list_files","arguments":"{}"}]`, wantOutput: "list_files"},
				{name: "text without usage", fields: `"output":[{"type":"message","id":"msg_1","role":"assistant","content":[{"type":"output_text","text":"answer"}]}]`, wantOutput: "answer"},
				{
					name:       "text emitted before empty terminal",
					fields:     `"output":[],"usage":{"input_tokens":0,"output_tokens":0}`,
					earlyEvent: `{"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"answer"}`,
					wantOutput: "answer",
				},
				{
					name:        "usage emitted before zero terminal",
					fields:      `"output":[],"usage":{"input_tokens":0,"output_tokens":0}`,
					earlyEvent:  `{"type":"response.in_progress","response":{"usage":{"input_tokens":3}}}`,
					inputTokens: 3,
				},
			} {
				if tc.earlyEvent != "" && !mode.upstreamSSE {
					continue
				}
				t.Run(tc.name, func(t *testing.T) {
					body := `{"model":"gpt-5.6-sol","input":"hello","stream":false}`
					if mode.stream {
						body = `{"model":"gpt-5.6-sol","input":"hello","stream":true}`
					}
					contentType := "application/json"
					payload := `{"id":"resp_test","object":"response","status":"completed",` + tc.fields + `}`
					if mode.upstreamSSE {
						contentType = "text/event-stream"
						preamble := "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_test\",\"status\":\"in_progress\"}}\n\n"
						if tc.earlyEvent != "" {
							preamble += "data: " + tc.earlyEvent + "\n\n"
						}
						payload = preamble + `data: {"type":"response.completed","response":` + payload + "}\n\n"
					}
					upstream := &httpUpstreamRecorder{resp: &http.Response{
						StatusCode: http.StatusOK,
						Header:     http.Header{"Content-Type": []string{contentType}},
						Body:       io.NopCloser(strings.NewReader(payload)),
					}}
					svc := newOpenAIImageGenerationControlTestService(upstream)
					c, recorder := newOpenAIImageGenerationControlTestContext(true, "codex_cli_rs/0.144.1")
					account := newOpenAIImageGenerationControlTestAccount()
					account.Extra = map[string]any{"openai_passthrough": mode.passthrough}

					result, err := svc.Forward(context.Background(), c, account, []byte(body))
					if tc.wantOutput == "" && tc.inputTokens == 0 {
						var failover *UpstreamFailoverError
						require.ErrorAs(t, err, &failover)
						require.Equal(t, http.StatusBadGateway, failover.StatusCode)
						require.Nil(t, result)
						require.Empty(t, recorder.Body.String())
						require.False(t, c.Writer.Written())
						return
					}
					require.NoError(t, err)
					require.NotNil(t, result)
					require.Equal(t, tc.inputTokens, result.Usage.InputTokens)
					require.Contains(t, recorder.Body.String(), `"status":"completed"`)
					if tc.wantOutput != "" {
						require.Contains(t, recorder.Body.String(), tc.wantOutput)
					}
				})
			}
		})
	}
}

func TestOpenAIResponsesCompletedEventIsEmpty(t *testing.T) {
	cases := []struct {
		name  string
		data  string
		usage *OpenAIUsage
		want  bool
	}{
		{
			name: "bare completed",
			data: `{"type":"response.completed"}`,
			want: true,
		},
		{
			name: "completed with empty output array",
			data: `{"type":"response.completed","response":{"id":"r1","status":"completed","output":[]}}`,
			want: true,
		},
		{
			name: "completed with usage",
			data: `{"type":"response.completed","response":{"id":"r1","status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}`,
			want: false,
		},
		{
			name: "completed with error",
			data: `{"type":"response.completed","response":{"id":"r1","status":"completed","error":{"code":"x"}}}`,
			want: false,
		},
		{
			name: "completed with output item",
			data: `{"type":"response.completed","response":{"id":"r1","status":"completed","output":[{"type":"message","id":"msg_1"}]}}`,
			want: false,
		},
		{
			name: "accumulated usage",
			data: `{"type":"response.completed"}`,
			usage: &OpenAIUsage{
				InputTokens:  7,
				OutputTokens: 2,
			},
			want: false,
		},
		{
			name: "invalid json",
			data: `{"type":`,
			want: false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			usage := tc.usage
			if usage == nil {
				usage = &OpenAIUsage{}
			}
			(&OpenAIGatewayService{}).parseSSEUsageBytes([]byte(tc.data), usage)
			require.Equal(t, tc.want, openAIResponsesCompletionIsEmpty([]byte(tc.data), usage))
		})
	}
}
