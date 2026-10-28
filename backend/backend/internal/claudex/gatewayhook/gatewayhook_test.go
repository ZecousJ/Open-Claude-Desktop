package gatewayhook

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/service"

	coderws "github.com/coder/websocket"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func init() { gin.SetMode(gin.TestMode) }

type guardFunc struct {
	prio int
	fn   func(c *gin.Context, k *service.APIKey) bool
}

func (g guardFunc) Priority() int                                    { return g.prio }
func (g guardFunc) OnRequest(c *gin.Context, k *service.APIKey) bool { return g.fn(c, k) }

type markerFunc func(c *gin.Context, k *service.APIKey)

func (m markerFunc) OnKeyResolved(c *gin.Context, k *service.APIKey) { m(c, k) }

type describerFunc func(c *gin.Context, r Refusal) *RefusalDetail

func (d describerFunc) Describe(c *gin.Context, r Refusal) *RefusalDetail { return d(c, r) }

func newContext(method, target string, body io.Reader) (*gin.Context, *httptest.ResponseRecorder) {
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	c.Request = httptest.NewRequest(method, target, body)
	return c, rec
}

func TestGuardsRunByPriorityAndStopAtTheFirstAbort(t *testing.T) {
	Reset()
	t.Cleanup(Reset)
	var order []string
	RegisterRequestGuard(guardFunc{prio: PriorityUsageRules, fn: func(*gin.Context, *service.APIKey) bool {
		order = append(order, "usage")
		return false
	}})
	RegisterRequestGuard(guardFunc{prio: PriorityDevice, fn: func(*gin.Context, *service.APIKey) bool {
		order = append(order, "device")
		return false
	}})
	RegisterRequestGuard(guardFunc{prio: PriorityVersion, fn: func(c *gin.Context, _ *service.APIKey) bool {
		order = append(order, "version")
		c.AbortWithStatusJSON(http.StatusUpgradeRequired, gin.H{"code": "CLAUDEX_UPGRADE_REQUIRED"})
		return true
	}})

	c, rec := newContext(http.MethodPost, "/v1/responses", nil)
	require.True(t, KeyAuthorized(c, &service.APIKey{ID: 1}))
	require.Equal(t, []string{"device", "version"}, order)
	require.Equal(t, http.StatusUpgradeRequired, rec.Code)
	require.True(t, c.IsAborted())

	// A second call on the same request does not run the guards again.
	require.True(t, KeyAuthorized(c, &service.APIKey{ID: 1}))
	require.Equal(t, []string{"device", "version"}, order)

	// Without guards nothing happens.
	Reset()
	c, rec = newContext(http.MethodPost, "/v1/responses", nil)
	require.False(t, KeyAuthorized(c, &service.APIKey{ID: 1}))
	require.False(t, c.IsAborted())
	require.Equal(t, http.StatusOK, rec.Code)
}

func TestGuardPanicAndSilentAbortFailClosed(t *testing.T) {
	Reset()
	t.Cleanup(Reset)
	RegisterRequestGuard(guardFunc{prio: 1, fn: func(*gin.Context, *service.APIKey) bool { panic("boom") }})
	c, rec := newContext(http.MethodPost, "/v1/messages", nil)
	require.True(t, KeyAuthorized(c, &service.APIKey{}))
	require.Equal(t, http.StatusInternalServerError, rec.Code)

	Reset()
	RegisterRequestGuard(guardFunc{prio: 1, fn: func(*gin.Context, *service.APIKey) bool { return true }})
	c, rec = newContext(http.MethodPost, "/v1/messages", nil)
	require.True(t, KeyAuthorized(c, &service.APIKey{}))
	require.Equal(t, http.StatusForbidden, rec.Code, "a guard that aborts without writing still refuses")

	// A guard that refused but returned false by mistake still ends the
	// request, and the guards after it do not run.
	for _, refuse := range []func(c *gin.Context){
		func(c *gin.Context) {
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"code": "CLAUDEX_USAGE_LIMIT_EXCEEDED"})
		},
		func(c *gin.Context) {
			c.JSON(http.StatusTooManyRequests, gin.H{"code": "CLAUDEX_USAGE_LIMIT_EXCEEDED"})
		},
	} {
		Reset()
		later := 0
		RegisterRequestGuard(guardFunc{prio: 1, fn: func(c *gin.Context, _ *service.APIKey) bool { refuse(c); return false }})
		RegisterRequestGuard(guardFunc{prio: 2, fn: func(*gin.Context, *service.APIKey) bool { later++; return false }})
		c, rec = newContext(http.MethodPost, "/v1/messages", nil)
		require.True(t, KeyAuthorized(c, &service.APIKey{}))
		require.True(t, c.IsAborted())
		require.Equal(t, http.StatusTooManyRequests, rec.Code)
		require.Zero(t, later)
	}
}

func TestKeyResolvedRunsMarkersAndSwallowsPanics(t *testing.T) {
	Reset()
	t.Cleanup(Reset)
	RegisterKeyMarker(markerFunc(func(*gin.Context, *service.APIKey) { panic("boom") }))
	RegisterKeyMarker(markerFunc(func(c *gin.Context, k *service.APIKey) {
		MarkDevice(c, &DeviceRef{ID: 9, APIKeyID: k.ID})
	}))
	c, rec := newContext(http.MethodPost, "/v1/messages", nil)
	require.NotPanics(t, func() { KeyResolved(c, &service.APIKey{ID: 5}) })
	d, ok := Device(c)
	require.True(t, ok)
	require.Equal(t, int64(5), d.APIKeyID)
	require.False(t, c.IsAborted())
	require.False(t, c.Writer.Written())
	require.Equal(t, http.StatusOK, rec.Code)
	require.NotPanics(t, func() { KeyResolved(c, nil) })
}

func TestRequestModelsReturnsEveryCandidateAndRestoresTheBody(t *testing.T) {
	body := `{"model":"gpt-5.5-mini","Model":"claude-opus-4","model":"claude-opus-4","messages":[]}`
	r := gin.New()
	var got []string
	var seenBody string
	var bodyErr error
	var cached []string
	r.POST("/v1/messages", func(c *gin.Context) {
		got = RequestModels(c)
		raw, err := io.ReadAll(c.Request.Body)
		bodyErr = err
		seenBody = string(raw)
		// Cached: a second call returns the same slice without reading.
		cached = RequestModels(c)
	})
	// gin needs every route registered before the first request.
	record := func(c *gin.Context) { got = RequestModels(c) }
	r.POST("/v1beta/models/*modelAction", record)
	r.POST("/v1/audio/transcriptions", record)
	r.GET("/v1/responses", record)
	r.GET("/v1/realtime", record)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(rec, req)
	require.NoError(t, bodyErr)
	require.Equal(t, []string{"gpt-5.5-mini", "claude-opus-4"}, got)
	require.Equal(t, got, cached)
	require.Equal(t, body, seenBody, "the handler still reads the original body")

	// Gemini native path parameters.
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1beta/models/gemini-2.5-pro:generateContent", strings.NewReader(`{}`)))
	require.Equal(t, []string{"gemini-2.5-pro"}, got)

	// Multipart "model" fields (audio transcription).
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	require.NoError(t, mw.WriteField("model", "gpt-4o-transcribe"))
	require.NoError(t, mw.WriteField("model", "whisper-1"))
	fw, err := mw.CreateFormFile("file", "a.wav")
	require.NoError(t, err)
	_, _ = fw.Write([]byte("RIFF"))
	require.NoError(t, mw.Close())
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/v1/audio/transcriptions", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	r.ServeHTTP(rec, req)
	require.Equal(t, []string{"gpt-4o-transcribe", "whisper-1"}, got)

	// WebSocket upgrade: no body, no models; realtime keeps the query model.
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/responses", nil))
	require.Empty(t, got)
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/realtime?model=grok-voice", nil))
	require.Equal(t, []string{"grok-voice"}, got)
}

func TestRequestModelsKeepsABodyReadErrorForTheHandler(t *testing.T) {
	r := gin.New()
	var readErr error
	r.POST("/v1/messages", func(c *gin.Context) {
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 8)
		require.Empty(t, RequestModels(c))
		_, readErr = io.ReadAll(c.Request.Body)
	})
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(`{"model":"a-long-model-name"}`)))
	var maxErr *http.MaxBytesError
	require.ErrorAs(t, readErr, &maxErr)
}

func TestIsBillableRequest(t *testing.T) {
	r := gin.New()
	var billable bool
	h := func(c *gin.Context) { billable = IsBillableRequest(c) }
	for _, route := range []struct{ method, path string }{
		{http.MethodPost, "/v1/messages"}, {http.MethodPost, "/v1/messages/count_tokens"},
		{http.MethodPost, "/v1/responses/*subpath"}, {http.MethodGet, "/v1/responses"},
		{http.MethodGet, "/v1/models"}, {http.MethodPost, "/v1beta/models/*modelAction"},
		{http.MethodGet, "/v1/videos/:request_id"}, {http.MethodGet, "/v1/realtime"},
		{http.MethodPost, "/v1/audio/transcriptions"}, {http.MethodDelete, "/v1/images/batches/:id"},
	} {
		r.Handle(route.method, route.path, h)
	}
	for _, tc := range []struct {
		method, path string
		want         bool
	}{
		{http.MethodPost, "/v1/messages", true},
		{http.MethodPost, "/v1/messages/count_tokens", false},
		{http.MethodPost, "/v1/responses/compact", true},
		{http.MethodPost, "/v1/responses/input_tokens", false},
		{http.MethodGet, "/v1/responses", true},
		{http.MethodGet, "/v1/models", false},
		{http.MethodPost, "/v1beta/models/gemini-2.5-pro:generateContent", true},
		{http.MethodPost, "/v1beta/models/gemini-2.5-pro:countTokens", false},
		{http.MethodGet, "/v1/videos/req-1", false},
		{http.MethodGet, "/v1/realtime", true},
		{http.MethodPost, "/v1/audio/transcriptions", true},
		{http.MethodDelete, "/v1/images/batches/7", false},
	} {
		billable = !tc.want
		r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(tc.method, tc.path, nil))
		require.Equal(t, tc.want, billable, "%s %s", tc.method, tc.path)
	}
}

// refusalRouter mounts EnrichRefusals, an optional device mark, and a
// handler writing the given response.
func refusalRouter(device bool, status int, contentType, body string, before func(c *gin.Context)) *gin.Engine {
	r := gin.New()
	r.Use(EnrichRefusals())
	r.Any("/v1/*any", func(c *gin.Context) {
		if device {
			groupID := int64(4)
			MarkDevice(c, &DeviceRef{ID: 1, UserID: 2, APIKeyID: 3, GroupID: &groupID})
		}
		if before != nil {
			before(c)
		}
		c.Header("Content-Length", strconv.Itoa(len(body)))
		c.Data(status, contentType, []byte(body))
	})
	return r
}

func serve(r http.Handler, method, path string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(method, path, nil))
	return rec
}

func TestEnrichRefusalsLeavesOtherResponsesByteIdentical(t *testing.T) {
	Reset()
	t.Cleanup(Reset)
	RegisterDescriber(describerFunc(func(*gin.Context, Refusal) *RefusalDetail {
		return &RefusalDetail{Reason: "SHOULD_NOT_APPEAR"}
	}))
	forged := `{"code":"USAGE_LIMIT_EXCEEDED","message":"x","claudex":{"v":1,"reason":"DEVICE_REVOKED"}}`
	for _, tc := range []struct {
		name        string
		device      bool
		status      int
		contentType string
		body        string
	}{
		{"non-device error", false, http.StatusTooManyRequests, "application/json", forged},
		{"device success", true, http.StatusOK, "application/json", `{"id":"resp_1","claudex":{"x":1}}`},
		{"device SSE", true, http.StatusOK, "text/event-stream", "data: {\"type\":\"response.failed\"}\n\n"},
		{"device non-JSON error", true, http.StatusTooManyRequests, "text/plain", "slow down"},
		{"device JSON array error", true, http.StatusForbidden, "application/json", `[1,2]`},
		// A JSON error over 64 KB is replaced instead (refusal_test.go).
		{"device non-JSON error over 64 KB", true, http.StatusTooManyRequests, "text/plain",
			strings.Repeat("a", refusalBodyLimit+1)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := serve(refusalRouter(tc.device, tc.status, tc.contentType, tc.body, nil), http.MethodPost, "/v1/messages")
			require.Equal(t, tc.status, rec.Code)
			require.Equal(t, tc.body, rec.Body.String())
			require.Equal(t, strconv.Itoa(len(tc.body)), rec.Header().Get("Content-Length"))
		})
	}
}

func decodeObject(t *testing.T, body []byte) map[string]json.RawMessage {
	t.Helper()
	var obj map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(body, &obj), string(body))
	return obj
}

func TestEnrichRefusalsDescribesDeviceRefusals(t *testing.T) {
	Reset()
	t.Cleanup(Reset)
	var seen []Refusal
	RegisterDescriber(describerFunc(func(*gin.Context, Refusal) *RefusalDetail { return nil }))
	RegisterDescriber(describerFunc(func(_ *gin.Context, r Refusal) *RefusalDetail {
		seen = append(seen, r)
		resets := time.Date(2026, 9, 29, 0, 0, 0, 0, time.UTC)
		return &RefusalDetail{V: 7, Reason: "SUBSCRIPTION_WEEKLY_LIMIT", Kind: "usage_limit", Window: "7d", ResetsAt: &resets, Action: "wait"}
	}))

	for _, tc := range []struct {
		name, body, code, message string
	}{
		{"middleware shape", `{"code":"USAGE_LIMIT_EXCEEDED","message":"weekly usage limit exceeded","claudex":{"reason":"DEVICE_REVOKED"}}`,
			"USAGE_LIMIT_EXCEEDED", "weekly usage limit exceeded"},
		{"openai shape", `{"error":{"message":"API key 额度已用完","type":"insufficient_quota","code":"insufficient_quota"}}`,
			"insufficient_quota", "API key 额度已用完"},
		{"anthropic shape", `{"type":"error","error":{"type":"rate_limit_error","message":"slow"}}`,
			"rate_limit_error", "slow"},
		{"google shape", `{"error":{"code":429,"message":"quota","status":"RESOURCE_EXHAUSTED"}}`,
			"RESOURCE_EXHAUSTED", "quota"},
		{"envelope shape", `{"code":429,"message":"busy","reason":"RATE_LIMITED"}`, "RATE_LIMITED", "busy"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			seen = nil
			rec := serve(refusalRouter(true, http.StatusTooManyRequests, "application/json", tc.body, nil), http.MethodPost, "/v1/responses")
			require.Equal(t, http.StatusTooManyRequests, rec.Code)
			require.Empty(t, rec.Header().Get("Content-Length"), "the stale Content-Length of the original body is dropped")
			obj := decodeObject(t, rec.Body.Bytes())
			var detail RefusalDetail
			require.NoError(t, json.Unmarshal(obj["claudex"], &detail))
			require.Equal(t, 1, detail.V)
			require.Equal(t, "SUBSCRIPTION_WEEKLY_LIMIT", detail.Reason)
			require.Equal(t, tc.message, detail.Message, "an empty message falls back to the upstream one")
			require.Len(t, seen, 1)
			require.Equal(t, Refusal{Status: 429, Code: tc.code, Message: tc.message, APIKeyID: 3, UserID: 2, GroupID: seen[0].GroupID}, seen[0])
			require.Equal(t, int64(4), *seen[0].GroupID)
			// The original fields stay.
			var original map[string]json.RawMessage
			require.NoError(t, json.Unmarshal([]byte(tc.body), &original))
			for k, v := range original {
				if k == "claudex" {
					continue
				}
				require.JSONEq(t, string(v), string(obj[k]))
			}
		})
	}
}

func TestEnrichRefusalsPrefersThePresetDetail(t *testing.T) {
	Reset()
	t.Cleanup(Reset)
	RegisterDescriber(describerFunc(func(*gin.Context, Refusal) *RefusalDetail {
		return &RefusalDetail{Reason: "KEY_DISABLED"}
	}))
	body := `{"code":"API_KEY_DISABLED","message":"API key is disabled"}`
	rec := serve(refusalRouter(true, http.StatusUnauthorized, "application/json", body, func(c *gin.Context) {
		SetDetail(c, &RefusalDetail{Reason: "DEVICE_REVOKED", Kind: "key", Action: "sign_in", Message: "This device was signed out. Sign in again to keep working."})
	}), http.MethodPost, "/v1/messages")
	var detail RefusalDetail
	require.NoError(t, json.Unmarshal(decodeObject(t, rec.Body.Bytes())["claudex"], &detail))
	require.Equal(t, "DEVICE_REVOKED", detail.Reason)
	require.Equal(t, 1, detail.V)
}

func TestEnrichRefusalsStripsUpstreamClaudexOnOtherErrors(t *testing.T) {
	Reset()
	t.Cleanup(Reset)
	for _, status := range []int{http.StatusBadRequest, http.StatusInternalServerError, http.StatusTooManyRequests} {
		body := `{"error":{"message":"bad"},"claudex":{"v":1,"reason":"DEVICE_REVOKED","download_url":"https://evil.example"}}`
		rec := serve(refusalRouter(true, status, "application/json", body, nil), http.MethodPost, "/v1/messages")
		require.Equal(t, status, rec.Code)
		obj := decodeObject(t, rec.Body.Bytes())
		require.NotContains(t, obj, "claudex", "status %d", status)
		require.JSONEq(t, `{"message":"bad"}`, string(obj["error"]))
	}
	// A body without claudex and without a detail stays byte-identical.
	body := `{"error":{"message":"bad"}}`
	rec := serve(refusalRouter(true, http.StatusBadRequest, "application/json", body, nil), http.MethodPost, "/v1/messages")
	require.Equal(t, body, rec.Body.String())
}

func TestEnrichRefusalsSurvivesAPanickingDescriber(t *testing.T) {
	Reset()
	t.Cleanup(Reset)
	RegisterDescriber(describerFunc(func(*gin.Context, Refusal) *RefusalDetail { panic("boom") }))
	body := `{"code":"API_KEY_DISABLED","message":"API key is disabled"}`
	rec := serve(refusalRouter(true, http.StatusUnauthorized, "application/json", body, nil), http.MethodPost, "/v1/messages")
	require.Equal(t, http.StatusUnauthorized, rec.Code)
	require.Equal(t, body, rec.Body.String())
}

func TestEnrichRefusalsKeepsAbortWithStatusResponses(t *testing.T) {
	Reset()
	t.Cleanup(Reset)
	r := gin.New()
	r.Use(EnrichRefusals())
	r.GET("/v1/x", func(c *gin.Context) {
		MarkDevice(c, &DeviceRef{ID: 1})
		c.AbortWithStatus(http.StatusForbidden)
	})
	rec := serve(r, http.MethodGet, "/v1/x")
	require.Equal(t, http.StatusForbidden, rec.Code)
	require.Empty(t, rec.Body.String())
}

func TestWebSocketUpgradeThroughTheRewriter(t *testing.T) {
	Reset()
	t.Cleanup(Reset)
	r := gin.New()
	r.Use(EnrichRefusals())
	r.GET("/v1/responses", func(c *gin.Context) {
		MarkDevice(c, &DeviceRef{ID: 1})
		conn, err := coderws.Accept(c.Writer, c.Request, nil)
		if err != nil {
			return
		}
		defer func() { _ = conn.CloseNow() }()
		typ, msg, err := conn.Read(c.Request.Context())
		if err != nil {
			return
		}
		_ = conn.Write(c.Request.Context(), typ, append([]byte("echo:"), msg...))
		_ = conn.Close(coderws.StatusNormalClosure, "")
	})
	srv := httptest.NewServer(r)
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := coderws.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/v1/responses", nil)
	require.NoError(t, err)
	defer func() { _ = conn.CloseNow() }()
	require.NoError(t, conn.Write(ctx, coderws.MessageText, []byte(`{"type":"response.create"}`)))
	_, msg, err := conn.Read(ctx)
	require.NoError(t, err)
	require.Equal(t, `echo:{"type":"response.create"}`, string(msg))
}

func TestBodyLimits(t *testing.T) {
	Reset()
	t.Cleanup(Reset)
	limit := int64(16)
	RegisterBodyLimitCode("/v1/audio/transcriptions", "CLAUDEX_AUDIO_TOO_LARGE", func() int64 { return limit })
	r := gin.New()
	r.Use(BodyLimits())
	var handlerRan bool
	var readErr error
	handler := func(c *gin.Context) {
		handlerRan = true
		_, readErr = io.ReadAll(c.Request.Body)
		c.Status(http.StatusOK)
	}
	r.POST("/v1/audio/transcriptions", handler)
	r.POST("/v1/audio/speech", handler)

	// Declared length over the limit: refused before the handler.
	handlerRan = false
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/audio/transcriptions", strings.NewReader(strings.Repeat("a", 17))))
	require.Equal(t, http.StatusRequestEntityTooLarge, rec.Code)
	require.False(t, handlerRan)
	require.Contains(t, rec.Body.String(), `"code":"CLAUDEX_AUDIO_TOO_LARGE"`)

	// Unknown length (chunked): the reader stops at the limit.
	handlerRan = false
	req := httptest.NewRequest(http.MethodPost, "/v1/audio/transcriptions", io.NopCloser(strings.NewReader(strings.Repeat("a", 64))))
	req.ContentLength = -1
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	require.True(t, handlerRan)
	var maxErr *http.MaxBytesError
	require.ErrorAs(t, readErr, &maxErr)

	// Within the limit, and routes without a limit, pass.
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/audio/transcriptions", strings.NewReader("small")))
	require.Equal(t, http.StatusOK, rec.Code)
	require.NoError(t, readErr)
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/audio/speech", strings.NewReader(strings.Repeat("a", 64))))
	require.Equal(t, http.StatusOK, rec.Code)
	require.NoError(t, readErr)

	// A limit of 0 turns the check off.
	limit = 0
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/audio/transcriptions", strings.NewReader(strings.Repeat("a", 64))))
	require.Equal(t, http.StatusOK, rec.Code)
}
