package service

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	coderws "github.com/coder/websocket"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
	"github.com/tidwall/gjson"
)

const (
	wsEmptyCompletionFixture = `{"type":"response.completed","response":{"id":"resp_empty","status":"completed","output":[],"usage":{"input_tokens":0,"output_tokens":0}}}`
	wsCreatedFixture         = `{"type":"response.created","response":{"id":"resp_empty","status":"in_progress"}}`
	wsEarlierUsageFixture    = `{"type":"response.in_progress","response":{"id":"resp_empty","usage":{"input_tokens":3}}}`
	wsOutputDeltaFixture     = `{"type":"response.output_text.delta","response_id":"resp_empty","delta":"hello"}`
	wsBlankDeltaFixture      = `{"type":"response.output_text.delta","response_id":"resp_empty","delta":""}`
)

func TestOpenAIWSEmptyCompletionIngress(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, mode := range []string{OpenAIWSIngressModeCtxPool, OpenAIWSIngressModePassthrough, OpenAIWSIngressModeHTTPBridge} {
		for _, tc := range []struct {
			name       string
			preamble   []string
			prewarm    bool
			anchored   bool
			wantTokens int
			wantError  bool
		}{
			{name: "terminal_only", wantError: true},
			{name: "anchored", anchored: true, wantError: true},
			{name: "created", preamble: []string{wsCreatedFixture}, wantError: true},
			{name: "earlier_usage", preamble: []string{wsCreatedFixture, wsEarlierUsageFixture}, wantTokens: 3},
			{name: "earlier_text", preamble: []string{wsCreatedFixture, wsOutputDeltaFixture}},
			{name: "prewarm", preamble: []string{wsCreatedFixture}, prewarm: true},
		} {
			t.Run(mode+"/"+tc.name, func(t *testing.T) {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				cfg := passthroughLifecycleConfig()
				frames := append(append([]string(nil), tc.preamble...), wsEmptyCompletionFixture)
				upstream := newStagedPassthroughConn()
				svc := newPassthroughLifecycleService(cfg, upstream)
				account := passthroughLifecycleAccount()
				account.Extra["openai_apikey_responses_websockets_v2_mode"] = mode
				switch mode {
				case OpenAIWSIngressModeCtxPool:
					capture := &openAIWSCaptureConn{}
					for _, frame := range frames {
						capture.events = append(capture.events, []byte(frame))
					}
					pool := newOpenAIWSConnPool(cfg)
					pool.setClientDialerForTest(&openAIWSCaptureDialer{conn: capture})
					svc.openaiWSPool = pool
				case OpenAIWSIngressModePassthrough:
					for _, frame := range frames {
						upstream.Send(frame)
					}
				case OpenAIWSIngressModeHTTPBridge:
					body := "data: " + strings.Join(frames, "\n\ndata: ") + "\n\n"
					svc.httpUpstream = &httpUpstreamRecorder{resp: &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}}
				}
				type turnOutcome struct {
					result *OpenAIForwardResult
					err    error
				}
				outcomes := make(chan turnOutcome, 2)
				server, serverErr := startPassthroughLifecycleServerWithHooks(t, ctx, svc, account, func(*gin.Context) *OpenAIWSIngressHooks {
					return &OpenAIWSIngressHooks{AfterTurn: func(_ int, result *OpenAIForwardResult, err error) {
						outcomes <- turnOutcome{result, err}
					}}
				})
				defer server.Close()
				payload := `{"type":"response.create","model":"gpt-5.1","input":"hello"}`
				if tc.prewarm {
					payload = `{"type":"response.create","model":"gpt-5.1","input":[],"generate":false}`
				}
				if tc.anchored {
					payload = `{"type":"response.create","model":"gpt-5.1","input":"hello","previous_response_id":"resp_previous"}`
				}
				client := dialPassthroughLifecycleClientWithPayload(t, server, payload)
				defer func() { _ = client.CloseNow() }()

				if tc.wantError {
					switch {
					case !tc.anchored && (len(tc.preamble) == 0 || mode == OpenAIWSIngressModeHTTPBridge):
						select {
						case err := <-serverErr:
							var failover *UpstreamFailoverError
							require.ErrorAs(t, err, &failover)
							require.Equal(t, http.StatusBadGateway, failover.StatusCode)
						case <-ctx.Done():
							t.Fatal("empty turn did not fail over")
						}
					default:
						if len(tc.preamble) > 0 {
							_, created, err := client.Read(ctx)
							require.NoError(t, err)
							require.Equal(t, "response.created", gjson.GetBytes(created, "type").String())
						}
						_, _, err := client.Read(ctx)
						require.Error(t, err, "the empty terminal must never reach the client")
						select {
						case err = <-serverErr:
							var closeErr *OpenAIWSClientCloseError
							require.ErrorAs(t, err, &closeErr)
							require.Equal(t, coderws.StatusTryAgainLater, closeErr.StatusCode())
						case <-ctx.Done():
							t.Fatal("empty turn did not end the session")
						}
					}
				} else {
					for range tc.preamble {
						_, _, err := client.Read(ctx)
						require.NoError(t, err)
					}
					_, completed, err := client.Read(ctx)
					require.NoError(t, err)
					require.Equal(t, "response.completed", gjson.GetBytes(completed, "type").String())
					require.Equal(t, "resp_empty", gjson.GetBytes(completed, "response.id").String())
				}
				select {
				case outcome := <-outcomes:
					if tc.wantError {
						require.Error(t, outcome.err)
						require.Nil(t, outcome.result, "an empty turn cannot produce a successful usage result")
					} else {
						require.NoError(t, outcome.err)
						require.Equal(t, "resp_empty", outcome.result.RequestID)
						require.Equal(t, tc.wantTokens, outcome.result.Usage.InputTokens)
					}
				case <-ctx.Done():
					t.Fatal("turn outcome was not reported")
				}
			})
		}
	}
}

func TestOpenAIWSEmptyCompletionHTTPForwardAfterCommit(t *testing.T) {
	gin.SetMode(gin.TestMode)
	cfg := passthroughLifecycleConfig()
	account := passthroughLifecycleAccount()
	account.Extra["openai_apikey_responses_websockets_v2_mode"] = OpenAIWSIngressModeCtxPool
	conn := &openAIWSCaptureConn{events: [][]byte{[]byte(wsCreatedFixture), []byte(wsBlankDeltaFixture), []byte(wsEmptyCompletionFixture)}}
	pool := newOpenAIWSConnPool(cfg)
	pool.setClientDialerForTest(&openAIWSCaptureDialer{conn: conn})
	svc := newPassthroughLifecycleService(cfg, nil)
	svc.openaiWSPool = pool
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/responses", nil)
	payload := []byte(`{"model":"gpt-5.1","input":"hello","stream":true}`)

	result, err := svc.Forward(c.Request.Context(), c, account, payload)
	require.Error(t, err)
	var failover *UpstreamFailoverError
	require.NotErrorAs(t, err, &failover)
	require.Nil(t, result)
	require.Contains(t, recorder.Body.String(), `"type":"response.created"`)
	require.Contains(t, recorder.Body.String(), `"type":"response.failed"`)
	require.NotContains(t, recorder.Body.String(), `"type":"response.completed"`)
}

func TestOpenAIWSEmptyCompletionHTTPForward(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, stream := range []string{"true", "false"} {
		for _, tc := range []struct {
			name       string
			early      string
			wantText   bool
			wantTokens int
			wantError  bool
		}{
			{name: "empty", wantError: true},
			{name: "usage", early: wsEarlierUsageFixture, wantTokens: 3},
			{name: "text", early: wsOutputDeltaFixture, wantText: true},
		} {
			t.Run(stream+"/"+tc.name, func(t *testing.T) {
				cfg := passthroughLifecycleConfig()
				account := passthroughLifecycleAccount()
				account.Extra["openai_apikey_responses_websockets_v2_mode"] = OpenAIWSIngressModeCtxPool
				conn := &openAIWSCaptureConn{events: [][]byte{[]byte(wsCreatedFixture)}}
				if tc.early != "" {
					conn.events = append(conn.events, []byte(tc.early))
				}
				conn.events = append(conn.events, []byte(wsEmptyCompletionFixture))
				pool := newOpenAIWSConnPool(cfg)
				pool.setClientDialerForTest(&openAIWSCaptureDialer{conn: conn})
				svc := newPassthroughLifecycleService(cfg, nil)
				svc.openaiWSPool = pool
				recorder := httptest.NewRecorder()
				c, _ := gin.CreateTestContext(recorder)
				c.Request = httptest.NewRequest(http.MethodPost, "/v1/responses", nil)
				payload := []byte(`{"model":"gpt-5.1","input":"hello","stream":` + stream + `}`)

				result, err := svc.Forward(c.Request.Context(), c, account, payload)
				if tc.wantError {
					var failover *UpstreamFailoverError
					require.ErrorAs(t, err, &failover)
					require.Equal(t, http.StatusBadGateway, failover.StatusCode)
					require.Nil(t, result)
					require.False(t, c.Writer.Written())
					require.Empty(t, recorder.Body.String())
					return
				}
				require.NoError(t, err)
				require.True(t, result.OpenAIWSMode)
				require.Equal(t, "resp_empty", result.RequestID)
				require.Equal(t, tc.wantTokens, result.Usage.InputTokens)
				require.Contains(t, recorder.Body.String(), `"status":"completed"`)
				if tc.wantText {
					require.Contains(t, recorder.Body.String(), "hello")
				}
			})
		}
	}
}

func TestOpenAIWSEmptyCompletionPassthroughAfterPrewarm(t *testing.T) {
	gin.SetMode(gin.TestMode)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	upstream := newStagedPassthroughConn()
	svc := newPassthroughLifecycleService(passthroughLifecycleConfig(), upstream)
	successfulTurns := make(chan string, 2)
	failedTurns := make(chan int, 2)
	server, serverErr := startPassthroughLifecycleServerWithHooks(t, ctx, svc, passthroughLifecycleAccount(), func(*gin.Context) *OpenAIWSIngressHooks {
		return &OpenAIWSIngressHooks{AfterTurn: func(turn int, result *OpenAIForwardResult, err error) {
			if err == nil {
				successfulTurns <- result.RequestID
				return
			}
			failedTurns <- turn
		}}
	})
	defer server.Close()
	client := dialPassthroughLifecycleClientWithPayload(t, server, `{"type":"response.create","model":"gpt-5.1","input":[],"generate":false}`)
	defer func() { _ = client.CloseNow() }()
	require.Equal(t, gjson.False, gjson.GetBytes(requirePassthroughUpstreamWrite(t, upstream, time.Second), "generate").Type)
	upstream.Send(wsEmptyCompletionFixture)
	_, prewarm, err := client.Read(ctx)
	require.NoError(t, err)
	require.Equal(t, "resp_empty", gjson.GetBytes(prewarm, "response.id").String())

	followup := []byte(`{"type":"response.create","model":"gpt-5.1","input":"hello","previous_response_id":"resp_empty"}`)
	require.NoError(t, client.Write(ctx, coderws.MessageText, followup))
	sent := requirePassthroughUpstreamWrite(t, upstream, time.Second)
	require.Equal(t, "resp_empty", gjson.GetBytes(sent, "previous_response_id").String())
	upstream.Send(strings.ReplaceAll(wsEmptyCompletionFixture, "resp_empty", "resp_second"))
	_, _, err = client.Read(ctx)
	var clientClose coderws.CloseError
	require.ErrorAs(t, err, &clientClose)
	require.Equal(t, coderws.StatusTryAgainLater, clientClose.Code)
	select {
	case err = <-serverErr:
		var closeErr *OpenAIWSClientCloseError
		require.ErrorAs(t, err, &closeErr)
	case <-ctx.Done():
		t.Fatal("second turn did not end the session")
	}
	require.Len(t, successfulTurns, 1)
	require.Equal(t, "resp_empty", <-successfulTurns)
	require.Len(t, failedTurns, 1)
	require.Equal(t, 2, <-failedTurns)
}
