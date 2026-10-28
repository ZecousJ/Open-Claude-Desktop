//go:build unit

package service

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// A relay waiting for an account of its own pool pings first and then fails
// with ticket_unavailable (captured from 黑化 pro 焚诀, 2026-10-10): nothing
// has reached the client yet, so the request goes to the next account.
func TestOpenAIStreamingPingThenTicketUnavailableReturnsFailover(t *testing.T) {
	gin.SetMode(gin.TestMode)
	stream := strings.Join([]string{
		"event: ping",
		`data: {"type":"ping"}`,
		"",
		": waiting for an available account",
		"",
		"",
		"event: response.failed",
		`data: {"type":"response.failed","sequence_number":1,"response":{"status":"failed","error":{"code":"ticket_unavailable","message":"Ticket gateway: ticket_unavailable","status_code":502,"type":"server_error"}}}`,
		"",
	}, "\n")
	for _, keepalive := range []int{0, 10} {
		svc := &OpenAIGatewayService{cfg: &config.Config{Gateway: config.GatewayConfig{
			StreamDataIntervalTimeout: 180,
			StreamKeepaliveInterval:   keepalive,
			MaxLineSize:               defaultMaxLineSize,
		}}}
		rec := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(rec)
		c.Request = httptest.NewRequest(http.MethodPost, "/", nil)
		resp := &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader(stream)),
			Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
		}
		_, err := svc.handleStreamingResponse(c.Request.Context(), resp, c, &Account{ID: 15, Platform: PlatformOpenAI, Name: "relay"}, time.Now(), "gpt-6-astra", "gpt-6-astra")
		var failoverErr *UpstreamFailoverError
		require.ErrorAs(t, err, &failoverErr, "keepalive=%d", keepalive)
		require.False(t, c.Writer.Written(), "keepalive=%d", keepalive)
		require.Empty(t, rec.Body.String())
	}
	require.True(t, openAIStreamEventIsMetadata("ping"))
	require.False(t, openAIStreamDataStartsClientOutput(`{"type":"ping"}`, "ping"))
}
