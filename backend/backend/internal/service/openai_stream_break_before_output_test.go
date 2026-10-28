//go:build unit

package service

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// CLAUDEX: an upstream that breaks before its first token leaves the client
// untouched, so the handler can move the request to another account.
func streamBreakTestRun(t *testing.T, upstreamBody string) (*httptest.ResponseRecorder, *gin.Context, *OpenAIForwardResult, error) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	resp := &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"text/event-stream"}, "x-request-id": []string{"rid_break"}},
		Body:       io.NopCloser(strings.NewReader(upstreamBody)),
	}
	svc := &OpenAIGatewayService{cfg: rawChatCompletionsTestConfig()}
	result, err := svc.handleChatStreamingResponse(resp, c, rawChatCompletionsTestAccount(),
		"grok-4.7", "grok-4.7", "grok-4.7", time.Now(), 0)
	return rec, c, result, err
}

func TestChatStream_RelayStreamReadErrorBeforeFirstTokenFailsOver(t *testing.T) {
	rec, c, _, err := streamBreakTestRun(t, strings.Join([]string{
		`data: {"type":"response.created","response":{"id":"resp_1","model":"grok-4.7"}}`,
		"",
		`data: {"type":"error","error":{"type":"stream_read_error","message":"stream_read_error"}}`,
		"",
	}, "\n"))
	var failover *UpstreamFailoverError
	require.True(t, errors.As(err, &failover), "want a failover error, got %v", err)
	require.False(t, c.Writer.Written())
	require.Empty(t, rec.Body.String())
}

func TestChatStream_EndBeforeFirstTokenFailsOver(t *testing.T) {
	rec, c, _, err := streamBreakTestRun(t, strings.Join([]string{
		`data: {"type":"response.created","response":{"id":"resp_2","model":"grok-4.7"}}`,
		"",
	}, "\n"))
	var failover *UpstreamFailoverError
	require.True(t, errors.As(err, &failover), "want a failover error, got %v", err)
	require.False(t, c.Writer.Written())
	require.Empty(t, rec.Body.String())
}

func TestChatStream_EndAfterFirstTokenDoesNotFailOver(t *testing.T) {
	rec, _, _, err := streamBreakTestRun(t, strings.Join([]string{
		`data: {"type":"response.created","response":{"id":"resp_3","model":"grok-4.7"}}`,
		"",
		`data: {"type":"response.output_text.delta","delta":"hel"}`,
		"",
	}, "\n"))
	require.Error(t, err)
	var failover *UpstreamFailoverError
	require.False(t, errors.As(err, &failover))
	require.Contains(t, rec.Body.String(), `"content":"hel"`)
}

func TestStreamErrorEvent_TransportErrorsFailOver(t *testing.T) {
	for _, payload := range []string{
		`{"type":"error","error":{"type":"stream_read_error","message":"stream_read_error"}}`,
		`{"type":"error","error":{"type":"upstream_disconnected","message":"upstream closed the connection"}}`,
		`{"type":"error","error":{"type":"api_error","message":"read tcp: connection reset by peer"}}`,
	} {
		require.True(t, openAIStreamErrorEventShouldFailover([]byte(payload), ""), payload)
	}
	require.False(t, openAIStreamErrorEventShouldFailover(
		[]byte(`{"type":"error","error":{"type":"invalid_request_error","message":"messages is required"}}`), ""))
}
