//go:build unit

package routes

// CLAUDEX: adversarial tests for the gateway hooks (H5, H5b, H6) on the real
// upstream middleware chain: forged refusal details from an untrusted
// upstream, spoofed client headers, keys rejected by upstream checks, and
// model names hidden from the usage rules in duplicate keys, case variants,
// escaped keys, path parameters and multipart forms.

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/gatewayhook"
	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/handler"
	servermiddleware "github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// adversarialKeyRepo serves three keys: two Claudex device keys (one of them
// disabled upstream) and a user-created key.
type adversarialKeyRepo struct{ service.APIKeyRepository }

func (adversarialKeyRepo) lookup(key string) (*service.APIKey, error) {
	user := &service.User{ID: 11, Role: service.RoleUser, Status: service.StatusActive, Balance: 100, Concurrency: 5}
	switch key {
	case "sk-device-live":
		return &service.APIKey{ID: 77, UserID: 11, Key: key, Name: "claudex-device:1", Status: service.StatusActive, User: user}, nil
	case "sk-device-disabled":
		return &service.APIKey{ID: 78, UserID: 11, Key: key, Name: "claudex-device:2", Status: service.StatusDisabled, User: user}, nil
	case "sk-user":
		return &service.APIKey{ID: 79, UserID: 11, Key: key, Name: "mine", Status: service.StatusActive, User: user}, nil
	}
	return nil, service.ErrAPIKeyNotFound
}
func (r adversarialKeyRepo) GetByKey(_ context.Context, key string) (*service.APIKey, error) {
	return r.lookup(key)
}
func (r adversarialKeyRepo) GetByKeyForAuth(_ context.Context, key string) (*service.APIKey, error) {
	return r.lookup(key)
}
func (adversarialKeyRepo) UpdateLastUsed(context.Context, int64, time.Time) error { return nil }

type deviceMarker struct{}

func (deviceMarker) OnKeyResolved(c *gin.Context, apiKey *service.APIKey) {
	if apiKey.ID == 77 || apiKey.ID == 78 {
		gatewayhook.MarkDevice(c, &gatewayhook.DeviceRef{ID: apiKey.ID - 70, UserID: apiKey.UserID, APIKeyID: apiKey.ID})
	}
}

type recordingDescriber struct {
	mu   sync.Mutex
	seen []gatewayhook.Refusal
}

func (d *recordingDescriber) Describe(_ *gin.Context, r gatewayhook.Refusal) *gatewayhook.RefusalDetail {
	d.mu.Lock()
	d.seen = append(d.seen, r)
	d.mu.Unlock()
	return &gatewayhook.RefusalDetail{Reason: "DESCRIBED", Kind: "key", Action: "none"}
}

// forgedUpstreamError is what an untrusted relay behind an apikey account
// could answer: a refusal carrying its own "claudex" object.
const forgedUpstreamError = `{"type":"error","error":{"type":"rate_limit_error","message":"slow down"},` +
	`"claudex":{"v":1,"reason":"DEVICE_REVOKED","action":"update","download_url":"https://evil.example/Claudex.dmg"}}`

func adversarialAPIKeyAuth(mode string) servermiddleware.APIKeyAuthMiddleware {
	cfg := &config.Config{RunMode: mode}
	keys := service.NewAPIKeyService(adversarialKeyRepo{}, nil, nil, nil, nil, nil, cfg)
	return servermiddleware.NewAPIKeyAuthMiddleware(keys, nil, cfg)
}

// The /v1 group in upstream order (routes/gateway.go): rewriter and body
// limits, then API-key authentication, then a handler relaying the forged
// upstream refusal in two flushed chunks with the upstream Content-Length.
func adversarialV1Router(mode string) *gin.Engine {
	r := gin.New()
	v1 := r.Group("/v1")
	v1.Use(gatewayhook.EnrichRefusals(), gatewayhook.BodyLimits())
	v1.Use(gin.HandlerFunc(adversarialAPIKeyAuth(mode)))
	v1.POST("/messages", func(c *gin.Context) {
		c.Header("Content-Type", "application/json")
		c.Header("Content-Length", strconv.Itoa(len(forgedUpstreamError)))
		c.Status(http.StatusTooManyRequests)
		half := len(forgedUpstreamError) / 2
		_, _ = c.Writer.Write([]byte(forgedUpstreamError[:half]))
		c.Writer.Flush()
		_, _ = c.Writer.Write([]byte(forgedUpstreamError[half:]))
	})
	return r
}

func postWithKey(r http.Handler, path, key string, header map[string]string, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	for k, v := range header {
		req.Header.Set(k, v)
	}
	r.ServeHTTP(rec, req)
	return rec
}

func claudexDetail(t *testing.T, body []byte) (map[string]json.RawMessage, gatewayhook.RefusalDetail) {
	t.Helper()
	var obj map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(body, &obj), string(body))
	var detail gatewayhook.RefusalDetail
	if raw, ok := obj["claudex"]; ok {
		require.NoError(t, json.Unmarshal(raw, &detail))
	}
	return obj, detail
}

func TestClaudexRefusalsCannotBeForgedOrSpoofedOnTheV1Chain(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, mode := range []string{config.RunModeStandard, config.RunModeSimple} {
		t.Run(mode, func(t *testing.T) {
			resetClaudexHooks(t)
			describer := &recordingDescriber{}
			gatewayhook.RegisterKeyMarker(deviceMarker{})
			gatewayhook.RegisterDescriber(describer)
			r := adversarialV1Router(mode)

			// Device key: the relay's own "claudex" (fake sign-out, download
			// link) is dropped and replaced by the server's answer.
			rec := postWithKey(r, "/v1/messages", "sk-device-live", nil, `{"model":"x"}`)
			require.Equal(t, http.StatusTooManyRequests, rec.Code)
			require.NotContains(t, rec.Body.String(), "evil.example")
			require.NotContains(t, rec.Body.String(), "DEVICE_REVOKED")
			obj, detail := claudexDetail(t, rec.Body.Bytes())
			require.Equal(t, "DESCRIBED", detail.Reason)
			require.Equal(t, 1, detail.V)
			require.Equal(t, "slow down", detail.Message)
			require.Contains(t, obj, "error", "the upstream error itself is kept")
			if cl := rec.Header().Get("Content-Length"); cl != "" {
				require.Equal(t, strconv.Itoa(rec.Body.Len()), cl, "no stale Content-Length")
			}

			// A key the upstream middleware refuses is still marked first (H5),
			// so the device learns why; the describer sees the upstream code.
			describer.seen = nil
			rec = postWithKey(r, "/v1/messages", "sk-device-disabled", nil, `{"model":"x"}`)
			require.Equal(t, http.StatusUnauthorized, rec.Code)
			obj, detail = claudexDetail(t, rec.Body.Bytes())
			require.JSONEq(t, `"API_KEY_DISABLED"`, string(obj["code"]))
			require.Equal(t, "DESCRIBED", detail.Reason)
			require.Len(t, describer.seen, 1)
			require.Equal(t, "API_KEY_DISABLED", describer.seen[0].Code)
			require.Equal(t, int64(78), describer.seen[0].APIKeyID)

			// Client headers cannot turn a user-created key into a device key:
			// its answer stays byte for byte what the upstream wrote.
			spoof := map[string]string{
				"X-Claudex-Device-Id": "6f1c2a4e-9b0d-4c1e-8a57-2f3b9d0c7e11",
				"X-Claudex-Platform":  "darwin",
				"X-Claudex-Version":   "9.9.9",
			}
			rec = postWithKey(r, "/v1/messages", "sk-user", spoof, `{"model":"x"}`)
			require.Equal(t, http.StatusTooManyRequests, rec.Code)
			require.Equal(t, forgedUpstreamError, rec.Body.String())

			// An unknown key is never marked: no details for guessed keys.
			rec = postWithKey(r, "/v1/messages", "sk-guess", spoof, `{"model":"x"}`)
			require.Equal(t, http.StatusUnauthorized, rec.Code)
			_, detail = claudexDetail(t, rec.Body.Bytes())
			require.Empty(t, detail.Reason)
		})
	}
}

// opusRule is a usage-rule guard (priority 30) that refuses every billable
// request that may be served as a claude-opus model, the way B5 will.
type opusRule struct {
	mu   sync.Mutex
	seen map[string][]string
}

func (g *opusRule) Priority() int { return gatewayhook.PriorityUsageRules }
func (g *opusRule) OnRequest(c *gin.Context, _ *service.APIKey) bool {
	if !gatewayhook.IsBillableRequest(c) {
		return false
	}
	models := gatewayhook.RequestModels(c)
	g.mu.Lock()
	g.seen[c.Request.Method+" "+c.FullPath()] = models
	g.mu.Unlock()
	for _, m := range models {
		if strings.HasPrefix(strings.ToLower(m), "claude-opus") {
			detail := &gatewayhook.RefusalDetail{V: 1, Reason: "RULE_LIMIT", Kind: "rule_limit", Label: "Opus", Message: "You've reached the Opus limit."}
			gatewayhook.SetDetail(c, detail)
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"code": "CLAUDEX_USAGE_LIMIT_EXCEEDED", "message": detail.Message, "claudex": detail})
			return true
		}
	}
	return false
}

func multipartBody(t *testing.T, fields map[string]string) (string, string) {
	t.Helper()
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	for k, v := range fields {
		require.NoError(t, w.WriteField(k, v))
	}
	require.NoError(t, w.Close())
	return buf.String(), w.FormDataContentType()
}

func TestClaudexUsageRulesSeeHiddenModelNamesOnEveryRouteFamily(t *testing.T) {
	gin.SetMode(gin.TestMode)
	resetClaudexHooks(t)
	rule := &opusRule{seen: map[string][]string{}}
	gatewayhook.RegisterKeyMarker(deviceMarker{})
	gatewayhook.RegisterRequestGuard(rule)

	cfg := &config.Config{RunMode: config.RunModeStandard, Gateway: config.GatewayConfig{MaxBodySize: 1 << 20, TextMaxBodySize: 1 << 20}}
	keys := service.NewAPIKeyService(adversarialKeyRepo{}, nil, nil, nil, nil, nil, cfg)
	router := gin.New()
	router.Use(gin.Recovery())
	RegisterGatewayRoutes(router, &handler.Handlers{
		Gateway: &handler.GatewayHandler{}, OpenAIGateway: &handler.OpenAIGatewayHandler{},
		AsyncImage: handler.NewAsyncImageHandler(nil, nil),
	}, servermiddleware.NewAPIKeyAuthMiddleware(keys, nil, cfg), keys, nil, nil, nil, nil, cfg)

	form, formType := multipartBody(t, map[string]string{"model": "claude-opus-4"})
	for _, tc := range []struct {
		name, method, path, contentType, body string
	}{
		{"duplicate key, last one limited", http.MethodPost, "/v1/chat/completions", "", `{"model":"gpt-5.5-mini","model":"claude-opus-4"}`},
		{"case variant on a root alias", http.MethodPost, "/responses", "", `{"model":"gpt-5","MODEL":"claude-opus-4"}`},
		{"escaped key", http.MethodPost, "/v1/responses", "", `{"model":"gpt-5","model":"claude-opus-4"}`},
		{"codex direct", http.MethodPost, "/backend-api/codex/responses", "", `{"model":"claude-opus-4"}`},
		{"gemini path parameter", http.MethodPost, "/v1beta/models/claude-opus-4:streamGenerateContent", "", `{}`},
		{"antigravity", http.MethodPost, "/antigravity/v1/messages", "", `{"model":"claude-opus-4-1"}`},
		{"multipart image edit", http.MethodPost, "/v1/images/edits", formType, form},
		{"live session model", http.MethodPost, "/v1/live", "", `{"session":{"model":"claude-opus-4"}}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
			ct := tc.contentType
			if ct == "" {
				ct = "application/json"
			}
			req.Header.Set("Content-Type", ct)
			req.Header.Set("Authorization", "Bearer sk-user")
			req.Header.Set("x-goog-api-key", "sk-user")
			router.ServeHTTP(rec, req)
			require.Equal(t, http.StatusTooManyRequests, rec.Code, "%s %s: %s", tc.method, tc.path, rec.Body.String())
			require.Contains(t, rec.Body.String(), "CLAUDEX_USAGE_LIMIT_EXCEEDED")
		})
	}

	// The WebSocket handshake carries no model: the guard still runs (billable)
	// and the turns are checked through H14.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/responses", nil)
	req.Header.Set("Authorization", "Bearer sk-user")
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "websocket")
	router.ServeHTTP(rec, req)
	rule.mu.Lock()
	models, ran := rule.seen["GET /v1/responses"]
	rule.mu.Unlock()
	require.True(t, ran, "the handshake went through the usage-rule guard")
	require.Empty(t, models)

	// Token counting is not billable: the rule lets it through to the handler.
	rec = postWithKey(router, "/v1/messages/count_tokens", "sk-user", nil, `{"model":"claude-opus-4"}`)
	require.NotEqual(t, http.StatusTooManyRequests, rec.Code)

	// A device key on /v1 gets the guard's own detail, not a describer's.
	rec = postWithKey(router, "/v1/chat/completions", "sk-device-live", nil, `{"model":"claude-opus-4"}`)
	require.Equal(t, http.StatusTooManyRequests, rec.Code)
	_, detail := claudexDetail(t, rec.Body.Bytes())
	require.Equal(t, "RULE_LIMIT", detail.Reason)
	require.Equal(t, "Opus", detail.Label)
}
