package release

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/gatewayhook"
	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// gatewayKeys serves the API keys of the gateway tests to the real upstream
// API-key middleware.
type gatewayKeys struct {
	service.APIKeyRepository
	keys map[string]*service.APIKey
}

func (r gatewayKeys) GetByKey(_ context.Context, key string) (*service.APIKey, error) {
	k, ok := r.keys[key]
	if !ok {
		return nil, service.ErrAPIKeyNotFound
	}
	copied := *k
	return &copied, nil
}

func (r gatewayKeys) GetByKeyForAuth(ctx context.Context, key string) (*service.APIKey, error) {
	return r.GetByKey(ctx, key)
}

func (gatewayKeys) UpdateLastUsed(context.Context, int64, time.Time) error { return nil }

// deviceMarker stands in for B4: it marks the Claudex device keys (H5).
type deviceMarker struct{ deviceKeys map[int64]bool }

func (m deviceMarker) OnKeyResolved(c *gin.Context, apiKey *service.APIKey) {
	if m.deviceKeys[apiKey.ID] {
		gatewayhook.MarkDevice(c, &gatewayhook.DeviceRef{ID: 900 + apiKey.ID, UserID: apiKey.UserID, APIKeyID: apiKey.ID})
	}
}

const (
	deviceKey         = "sk-device"
	disabledDeviceKey = "sk-device-disabled"
	userKey           = "sk-user"
)

func gatewayKeyRepo() gatewayKeys {
	user := &service.User{ID: 7, Status: service.StatusActive, Balance: 100, Concurrency: 1}
	key := func(id int64, secret, status string) *service.APIKey {
		return &service.APIKey{ID: id, UserID: 7, Key: secret, Status: status, User: user}
	}
	return gatewayKeys{keys: map[string]*service.APIKey{
		deviceKey:         key(1, deviceKey, service.StatusActive),
		disabledDeviceKey: key(2, disabledDeviceKey, service.StatusDisabled),
		userKey:           key(3, userKey, service.StatusActive),
	}}
}

// gatewayRouter builds the gateway routes with the real upstream API-key
// middlewares (standard or simple run mode): /v1/messages with the H6 refusal
// rewriter in front like the real /v1 group, /responses (a root alias
// without it) and the Gemini-native /v1beta route.
func gatewayRouter(t *testing.T, c *Component, mode string, reached *int) *gin.Engine {
	t.Helper()
	gatewayhook.Reset()
	t.Cleanup(gatewayhook.Reset)
	gatewayhook.RegisterKeyMarker(deviceMarker{deviceKeys: map[int64]bool{1: true, 2: true}})
	gatewayhook.RegisterRequestGuard(c)

	cfg := &config.Config{RunMode: mode}
	svc := service.NewAPIKeyService(gatewayKeyRepo(), nil, nil, nil, nil, nil, cfg)
	handler := func(g *gin.Context) {
		*reached++
		g.Status(http.StatusNoContent)
	}
	gin.SetMode(gin.TestMode)
	r := gin.New()
	v1 := r.Group("/v1")
	v1.Use(gatewayhook.EnrichRefusals())
	v1.POST("/messages", gin.HandlerFunc(middleware.NewAPIKeyAuthMiddleware(svc, nil, cfg)), handler)
	r.POST("/responses", gin.HandlerFunc(middleware.NewAPIKeyAuthMiddleware(svc, nil, cfg)), handler)
	r.POST("/v1beta/models/*modelAction", middleware.APIKeyAuthWithSubscriptionGoogle(svc, nil, cfg), handler)
	return r
}

func gatewayCall(r http.Handler, path, key, version string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{"model":"claude-sonnet-4"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("x-goog-api-key", key)
	req.Header.Set("X-Claudex-Platform", "darwin")
	req.Header.Set("X-Claudex-Arch", "arm64")
	if version != "" {
		req.Header.Set("X-Claudex-Version", version)
	}
	r.ServeHTTP(rec, req)
	return rec
}

var gatewayPaths = []string{"/v1/messages", "/responses", "/v1beta/models/gemini-2.5-pro:generateContent"}

func enforcedSetting(enforce bool) string {
	return strings.Replace(designSetting(), `"enforce_minimum_on_gateway": false`,
		`"enforce_minimum_on_gateway": `+map[bool]string{true: "true", false: "false"}[enforce], 1)
}

func TestGatewayMinimumVersionIsOffByDefault(t *testing.T) {
	for _, raw := range []string{"", designSetting()} {
		c, _ := newComponent(t, raw)
		reached := 0
		r := gatewayRouter(t, c, config.RunModeStandard, &reached)
		for _, path := range gatewayPaths {
			rec := gatewayCall(r, path, deviceKey, "0.9.0")
			require.Equal(t, http.StatusNoContent, rec.Code, "%s: %s", path, rec.Body.String())
		}
		require.Equal(t, len(gatewayPaths), reached)
	}
}

func TestGatewayMinimumVersionRefusesOldDeviceKeys(t *testing.T) {
	for _, mode := range []string{config.RunModeStandard, config.RunModeSimple} {
		t.Run(mode, func(t *testing.T) {
			c, _ := newComponent(t, enforcedSetting(true))
			reached := 0
			r := gatewayRouter(t, c, mode, &reached)

			for _, path := range gatewayPaths {
				rec := gatewayCall(r, path, deviceKey, "1.1.0")
				require.Equal(t, http.StatusUpgradeRequired, rec.Code, "%s: %s", path, rec.Body.String())
				require.JSONEq(t, `{"code":"CLAUDEX_UPGRADE_REQUIRED",
					"message":"This version of Claudex (1.1.0) is no longer supported. Update to 1.4.0 to keep working.",
					"claudex":{"v":1,"reason":"UPGRADE_REQUIRED","kind":"upgrade","reprovision":false,"action":"update",
						"minimum_version":"1.2.0","latest_version":"1.4.0","download_url":"https://dl.example.com/Claudex-1.4.0-arm64.zip",
						"message":"This version of Claudex (1.1.0) is no longer supported. Update to 1.4.0 to keep working."}}`,
					rec.Body.String(), path)

				// A missing or malformed version header counts as 0.0.0.
				for _, version := range []string{"", "not-a-version"} {
					rec = gatewayCall(r, path, deviceKey, version)
					require.Equal(t, http.StatusUpgradeRequired, rec.Code, "%s %q", path, version)
					var body struct {
						Message string `json:"message"`
					}
					require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
					require.Equal(t, "This version of Claudex is no longer supported. Update to 1.4.0 to keep working.", body.Message)
				}

				// At or above the minimum (pre-release of the minimum is below it).
				require.Equal(t, http.StatusUpgradeRequired, gatewayCall(r, path, deviceKey, "1.2.0-rc.1").Code, path)
				for _, version := range []string{"1.2.0", "1.2.0+claudex.1", "1.3.2", "1.4.0", "2.0.0"} {
					rec = gatewayCall(r, path, deviceKey, version)
					require.Equal(t, http.StatusNoContent, rec.Code, "%s %s: %s", path, version, rec.Body.String())
				}

				// Keys that are not Claudex device keys are never affected.
				require.Equal(t, http.StatusNoContent, gatewayCall(r, path, userKey, "0.1.0").Code, path)
				require.Equal(t, http.StatusNoContent, gatewayCall(r, path, userKey, "").Code, path)

				// A disabled device key gets the upstream API_KEY_DISABLED first
				// (the Gemini-native middleware words it in Google's error shape).
				rec = gatewayCall(r, path, disabledDeviceKey, "0.1.0")
				require.Equal(t, http.StatusUnauthorized, rec.Code, path)
				require.Contains(t, rec.Body.String(), "API key is disabled", path)
				if !strings.HasPrefix(path, "/v1beta/") {
					require.Contains(t, rec.Body.String(), `"code":"API_KEY_DISABLED"`, path)
				}
				require.NotContains(t, rec.Body.String(), "UPGRADE", path)
			}
			require.Equal(t, len(gatewayPaths)*(5+2), reached, "only the allowed requests reached the handler")
		})
	}
}

func TestGatewayMinimumVersionNeedsAMinimum(t *testing.T) {
	c, _ := newComponent(t, `{"channels":{"stable":{"latest_version":"1.4.0"}},"enforce_minimum_on_gateway":true}`)
	reached := 0
	r := gatewayRouter(t, c, config.RunModeStandard, &reached)
	require.Equal(t, http.StatusNoContent, gatewayCall(r, "/v1/messages", deviceKey, "0.0.1").Code)

	// Turning enforcement off again takes effect immediately on this node.
	c, _ = newComponent(t, enforcedSetting(true))
	r = gatewayRouter(t, c, config.RunModeStandard, &reached)
	require.Equal(t, http.StatusUpgradeRequired, gatewayCall(r, "/v1/messages", deviceKey, "1.0.0").Code)
	s, err := decodeSetting([]byte(enforcedSetting(false)))
	require.NoError(t, err)
	_, err = c.setting.Set(context.Background(), s)
	require.NoError(t, err)
	require.Equal(t, http.StatusNoContent, gatewayCall(r, "/v1/messages", deviceKey, "1.0.0").Code)
}

func TestGatewayGuardPriority(t *testing.T) {
	c, _ := newComponent(t, "")
	require.Equal(t, gatewayhook.PriorityVersion, c.Priority())
	require.Greater(t, c.Priority(), gatewayhook.PriorityDevice, "revoked devices are refused before the version check")
	require.Less(t, c.Priority(), gatewayhook.PriorityUsageRules, "an outdated client is told to update before usage rules count")
}
