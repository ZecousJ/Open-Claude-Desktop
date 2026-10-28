//go:build unit

package middleware

// CLAUDEX: tests for the H5/H5b gateway hooks in api_key_auth.go and
// api_key_auth_google.go.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/claudex/gatewayhook"
	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

type countingGuard struct {
	calls  int
	marked bool
	abort  bool
}

func (g *countingGuard) Priority() int { return 1 }
func (g *countingGuard) OnRequest(c *gin.Context, apiKey *service.APIKey) bool {
	g.calls++
	_, g.marked = gatewayhook.Device(c)
	if _, ok := GetAPIKeyFromContext(c); !ok {
		panic("the API key must be in the context when guards run")
	}
	if g.abort {
		AbortWithError(c, http.StatusTooManyRequests, "CLAUDEX_USAGE_LIMIT_EXCEEDED", "limit")
		return true
	}
	return false
}

type markAll struct{ calls int }

func (m *markAll) OnKeyResolved(c *gin.Context, apiKey *service.APIKey) {
	m.calls++
	gatewayhook.MarkDevice(c, &gatewayhook.DeviceRef{APIKeyID: apiKey.ID})
}

func TestClaudexGatewayHooksRunInBothAPIKeyMiddlewares(t *testing.T) {
	gin.SetMode(gin.TestMode)
	t.Cleanup(gatewayhook.Reset)
	key := func(status string) *service.APIKey {
		return &service.APIKey{ID: 42, Key: "sk-test", Status: status,
			User: &service.User{ID: 7, Status: service.StatusActive, Balance: 100, Concurrency: 1}}
	}

	for _, mode := range []string{config.RunModeStandard, config.RunModeSimple} {
		for _, google := range []bool{false, true} {
			name := mode
			if google {
				name += "/google"
			}
			t.Run(name, func(t *testing.T) {
				handlerCalls := 0
				router := func(status string) *gin.Engine {
					repo := fakeAPIKeyRepo{getByKey: func(context.Context, string) (*service.APIKey, error) {
						return key(status), nil
					}}
					cfg := &config.Config{RunMode: mode}
					svc := service.NewAPIKeyService(repo, nil, nil, nil, nil, nil, cfg)
					auth := gin.HandlerFunc(NewAPIKeyAuthMiddleware(svc, nil, cfg))
					if google {
						auth = APIKeyAuthWithSubscriptionGoogle(svc, nil, cfg)
					}
					r := gin.New()
					r.POST("/v1/messages", auth, func(c *gin.Context) {
						handlerCalls++
						c.Status(http.StatusNoContent)
					})
					return r
				}
				r := router(service.StatusActive)
				call := func() *httptest.ResponseRecorder {
					rec := httptest.NewRecorder()
					req := httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
					req.Header.Set("x-goog-api-key", "sk-test")
					req.Header.Set("Authorization", "Bearer sk-test")
					r.ServeHTTP(rec, req)
					return rec
				}

				gatewayhook.Reset()
				marker := &markAll{}
				guard := &countingGuard{}
				gatewayhook.RegisterKeyMarker(marker)
				gatewayhook.RegisterRequestGuard(guard)

				require.Equal(t, http.StatusNoContent, call().Code)
				require.Equal(t, 1, marker.calls)
				require.Equal(t, 1, guard.calls)
				require.True(t, guard.marked, "the marker runs before the guards")
				require.Equal(t, 1, handlerCalls)

				guard.abort = true
				rec := call()
				require.Equal(t, http.StatusTooManyRequests, rec.Code)
				require.Equal(t, 1, handlerCalls, "an aborting guard stops the request")
				require.Equal(t, 2, guard.calls)

				// An upstream rejection happens before the guards, after the marker.
				r = router(service.StatusDisabled)
				guard.abort = false
				rec = call()
				require.Equal(t, http.StatusUnauthorized, rec.Code)
				require.Equal(t, 3, marker.calls, "disabled keys are still marked (B6 describes the refusal)")
				require.Equal(t, 2, guard.calls, "guards only run after every upstream check passed")
			})
		}
	}
}
