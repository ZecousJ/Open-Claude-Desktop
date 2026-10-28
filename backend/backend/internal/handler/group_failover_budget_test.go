//go:build unit

// CLAUDEX: Request-scoped group failover with one shared generation budget.
package handler

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/pkg/requestbudget"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/synctest"
	"time"
)

func newGroupBudgetTestHandler(t *testing.T, upstream service.HTTPUpstream, count int) *OpenAIGatewayHandler {
	t.Helper()
	accounts := make([]service.Account, count)
	for i := range accounts {
		accounts[i] = service.Account{ID: int64(i + 1), Name: fmt.Sprintf("account-%d", i+1),
			Platform: service.PlatformOpenAI, Type: service.AccountTypeOAuth, Status: service.StatusActive,
			Schedulable: true, Priority: i, Credentials: map[string]any{"access_token": "synthetic-test-token"}}
	}
	accountRepo := openAIImagesFailoverAccountRepo{accounts: accounts}
	cfg := &config.Config{RunMode: config.RunModeSimple}
	gatewayService := service.NewOpenAIGatewayService(
		accountRepo,
		nil,
		nil,
		nil,
		nil,
		nil,
		nil,
		cfg,
		nil,
		nil,
		nil,
		nil,
		nil,
		upstream,
		nil,
		nil,
		nil,
		nil,
		nil,
		nil,
		nil,
		nil,
	)
	billingService := service.NewBillingCacheService(nil, nil, nil, nil, nil, nil, cfg, nil)
	t.Cleanup(billingService.Stop)
	concurrencyService := service.NewConcurrencyService(nil)
	handler := NewOpenAIGatewayHandler(
		gatewayService,
		concurrencyService,
		billingService,
		service.NewAPIKeyService(nil, nil, nil, nil, nil, nil, cfg),
		nil,
		nil,
		nil,
		nil,
		cfg,
	)
	handler.maxAccountSwitches = 10
	return handler
}

type groupBudgetUpstream struct {
	service.HTTPUpstream
	calls     []int64
	status    int
	succeedAt int
	delay     time.Duration
}

func (u *groupBudgetUpstream) Do(req *http.Request, _ string, accountID int64, _ int) (*http.Response, error) {
	u.calls = append(u.calls, accountID)
	if u.delay > 0 {
		select {
		case <-time.After(u.delay):
		case <-req.Context().Done():
			return nil, req.Context().Err()
		}
	}
	status := u.status
	body := `{"error":{"type":"server_error","message":"temporary upstream failure"}}`
	if u.succeedAt > 0 && len(u.calls) == u.succeedAt {
		status = http.StatusOK
		body = `{"id":"resp_success","object":"response","status":"completed","model":"gpt-5.1","output":[],"usage":{"input_tokens":1,"output_tokens":1}}`
	}
	return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(body))}, nil
}
func TestGroupFailoverHTTPExhaustsMoreThanTenAccounts(t *testing.T) {
	gin.SetMode(gin.TestMode)
	u := &groupBudgetUpstream{status: 520}
	h := newGroupBudgetTestHandler(t, u, 17)
	c, w := newOpenAIResponsesFailoverTestContext(t, context.Background())
	h.Responses(c)
	require.Len(t, u.calls, 17)
	seen := map[int64]bool{}
	for _, id := range u.calls {
		require.False(t, seen[id])
		seen[id] = true
	}
	require.Equal(t, http.StatusBadGateway, w.Code)
}
func TestGroupFailoverHTTPSucceedsBeyondOldSwitchLimit(t *testing.T) {
	gin.SetMode(gin.TestMode)
	u := &groupBudgetUpstream{status: 520, succeedAt: 15}
	h := newGroupBudgetTestHandler(t, u, 20)
	c, w := newOpenAIResponsesFailoverTestContext(t, context.Background())
	h.Responses(c)
	require.Len(t, u.calls, 15)
	require.Equal(t, http.StatusOK, w.Code)
	require.Contains(t, w.Body.String(), "resp_success")
}
func TestGroupFailoverHTTPSharedTotalDeadline(t *testing.T) {
	gin.SetMode(gin.TestMode)
	u := &groupBudgetUpstream{status: 520, delay: 7 * time.Second}
	h := newGroupBudgetTestHandler(t, u, 30)
	synctest.Test(t, func(t *testing.T) {
		c, w := newOpenAIResponsesFailoverTestContext(t, context.Background())
		started := time.Now()
		h.Responses(c)
		require.Equal(t, requestbudget.Total, time.Since(started))
		require.Len(t, u.calls, int((requestbudget.Total+7*time.Second-1)/(7*time.Second)))
		require.Equal(t, http.StatusGatewayTimeout, w.Code)
		require.Contains(t, w.Body.String(), "request_timeout")
	})
}
func TestGroupFailoverHTTPInvalidInputIsNotRetried(t *testing.T) {
	gin.SetMode(gin.TestMode)
	u := &groupBudgetUpstream{status: http.StatusBadRequest}
	h := newGroupBudgetTestHandler(t, u, 20)
	c, w := newOpenAIResponsesFailoverTestContext(t, context.Background())
	h.Responses(c)
	require.Len(t, u.calls, 1)
	require.Equal(t, http.StatusBadRequest, w.Code)
}
func TestGroupBudgetWriterConvertsServiceErrorAndKeepaliveTimeout(t *testing.T) {
	for _, path := range []string{"/v1/responses", "/v1/chat/completions", "/v1/messages", "/v1beta/models/gemini:streamGenerateContent"} {
		for _, stream := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/stream=%v", path, stream), func(t *testing.T) {
				synctest.Test(t, func(t *testing.T) {
					w := httptest.NewRecorder()
					c, _ := gin.CreateTestContext(w)
					c.Request = httptest.NewRequest("POST", path, bytes.NewReader(nil))
					finish := beginGroupFailoverRequest(c)
					if stream {
						c.Header("Content-Type", "text/event-stream")
						_, _ = c.Writer.WriteString(": ping\n\n")
						c.Writer.Flush()
					}
					time.Sleep(requestbudget.Total)
					if !stream {
						c.JSON(http.StatusBadGateway, gin.H{"error": "original provider failure"})
					}
					finish()
					require.Contains(t, w.Body.String(), "Request timed out")
					require.NotContains(t, w.Body.String(), "original provider failure")
					if !stream {
						require.Equal(t, 504, w.Code)
					}
					if stream && path == "/v1/responses" {
						require.Contains(t, w.Body.String(), "event: response.failed")
					}
				})
			})
		}
	}
}

// Once output has started the answer is no longer timed: a long answer runs
// past the budget and finishes normally.
func TestGroupBudgetStartedOutputIsNotCutOff(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Request = httptest.NewRequest("POST", "/v1/responses", nil)
		finish := beginGroupFailoverRequest(c)
		c.Header("Content-Type", "text/event-stream")
		_, err := c.Writer.WriteString("event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\n")
		require.NoError(t, err)
		time.Sleep(3 * requestbudget.Total)
		require.NoError(t, c.Request.Context().Err(), "the answer's upstream keeps running")
		_, err = c.Writer.WriteString("event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n")
		require.NoError(t, err)
		finish()
		require.Contains(t, w.Body.String(), "response.completed")
		require.NotContains(t, w.Body.String(), "Request timed out")
	})
}
func TestGroupBudgetCompletedSSEDoesNotAddTimeout(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Request = httptest.NewRequest("POST", "/v1/responses", nil)
		finish := beginGroupFailoverRequest(c)
		c.Header("Content-Type", "text/event-stream")
		_, _ = c.Writer.WriteString("event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n")
		time.Sleep(requestbudget.Total)
		finish()
		require.NotContains(t, w.Body.String(), "Request timed out")
	})
}
func TestGroupFailoverStateNeverRevisitsFailures(t *testing.T) {
	ctx, cancel := requestbudget.Start(context.Background())
	defer cancel()
	state := NewGroupFailoverState(false)
	for i := int64(1); i <= 25; i++ {
		action := state.HandleFailoverError(ctx, nil, i, service.PlatformAnthropic, 0, &service.UpstreamFailoverError{StatusCode: 503, RetryableOnSameAccount: true})
		require.Equal(t, FailoverContinue, action)
	}
	require.Len(t, state.FailedAccountIDs, 25)
	require.Empty(t, state.SameAccountRetryCount)
	require.Equal(t, FailoverExhausted, state.HandleSelectionExhausted(ctx))
	require.Len(t, state.FailedAccountIDs, 25)
	require.Equal(t, FailoverExhausted, state.HandleFailoverError(ctx, nil, 1, service.PlatformAnthropic, 0, &service.UpstreamFailoverError{StatusCode: 503}))
}

// A passing error first gets the account's own retries (pool_mode_retry_count),
// within the request budget; only then is the account left for the next one.
func TestGroupFailoverStateRetriesSameAccountFirst(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := requestbudget.Start(context.Background())
		defer cancel()
		state := NewGroupFailoverState(false)
		retryable := &service.UpstreamFailoverError{StatusCode: 503, RetryableOnSameAccount: true}
		require.Equal(t, FailoverContinue, state.HandleFailoverError(ctx, &mockTempUnscheduler{}, 7, service.PlatformOpenAI, 1, retryable))
		require.Equal(t, 1, state.SameAccountRetryCount[7])
		require.Empty(t, state.FailedAccountIDs, "retried, not left")
		require.Equal(t, FailoverContinue, state.HandleFailoverError(ctx, &mockTempUnscheduler{}, 7, service.PlatformOpenAI, 1, retryable))
		require.Contains(t, state.FailedAccountIDs, int64(7), "its retries used up: the next account")
	})
}

func TestGroupBudgetSlowUploadIsInterrupted(t *testing.T) {
	router := gin.New()
	router.POST("/v1/responses", func(c *gin.Context) {
		ctx, cancel := context.WithTimeout(c.Request.Context(), 50*time.Millisecond)
		defer cancel()
		c.Request = c.Request.WithContext(ctx)
		finish := beginGroupFailoverRequest(c)
		defer finish()
		_, err := io.ReadAll(c.Request.Body)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "body read failed"})
			return
		}
		t.Error("incomplete request body unexpectedly finished")
	})
	server := httptest.NewServer(router)
	defer server.Close()
	conn, err := net.DialTimeout("tcp", strings.TrimPrefix(server.URL, "http://"), time.Second)
	require.NoError(t, err)
	defer conn.Close()
	require.NoError(t, conn.SetDeadline(time.Now().Add(time.Second)))
	_, err = fmt.Fprint(conn, "POST /v1/responses HTTP/1.1\r\nHost: example.test\r\nContent-Length: 100\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{")
	require.NoError(t, err)
	response, err := http.ReadResponse(bufio.NewReader(conn), nil)
	require.NoError(t, err)
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	require.NoError(t, err)
	require.Equal(t, http.StatusGatewayTimeout, response.StatusCode)
	require.Contains(t, string(body), "request_timeout")
}

// Output that has started is never turned into a timeout, whatever frames it
// has sent so far.
func TestGroupBudgetPartialFramesAreNotTimedOut(t *testing.T) {
	cases := []struct {
		name, path string
		frames     []string
	}{
		{"null error and split CRLF", "/v1/responses", []string{"data: {\"type\":\"response.output_text.delta\",\"error\":null,\"delta\":\"hi\"}\r", "\n\r", "\n"}},
		{"one Gemini candidate finished", "/v1beta/models/gemini:streamGenerateContent", []string{"data: {\"candidates\":[{\"index\":0,\"finishReason\":\"STOP\"}]}\n\n"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				w := httptest.NewRecorder()
				c, _ := gin.CreateTestContext(w)
				c.Request = httptest.NewRequest("POST", tc.path, nil)
				finish := beginGroupFailoverRequest(c)
				c.Header("Content-Type", "text/event-stream")
				for _, frame := range tc.frames {
					_, err := c.Writer.WriteString(frame)
					require.NoError(t, err)
				}
				time.Sleep(requestbudget.Total)
				finish()
				require.NotContains(t, w.Body.String(), "Request timed out")
			})
		})
	}
}

func TestGroupBudgetBinaryPayloadIsNotAnSSEComment(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Request = httptest.NewRequest("POST", "/v1/tts", nil)
		finish := beginGroupFailoverRequest(c)
		c.Header("Content-Type", "audio/mpeg")
		_, err := c.Writer.WriteString(":binary audio bytes")
		require.NoError(t, err)
		time.Sleep(requestbudget.Total)
		finish()
		require.Equal(t, ":binary audio bytes", w.Body.String())
	})
}
