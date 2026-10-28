package webconsole_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/claudex"
	"github.com/Wei-Shaw/sub2api/internal/claudex/gatewayhook"
	claudexhook "github.com/Wei-Shaw/sub2api/internal/claudex/hook"
	"github.com/Wei-Shaw/sub2api/internal/claudex/webconsole"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// readOnlyRepo serves fixed settings values.
type readOnlyRepo struct {
	service.SettingRepository
	values map[string]string
}

func (r readOnlyRepo) GetValue(_ context.Context, key string) (string, error) {
	if v, ok := r.values[key]; ok {
		return v, nil
	}
	return "", service.ErrSettingNotFound
}

func (r readOnlyRepo) Get(ctx context.Context, key string) (*service.Setting, error) {
	v, err := r.GetValue(ctx, key)
	if err != nil {
		return nil, err
	}
	return &service.Setting{Key: key, Value: v}, nil
}

// TestModuleServesWebConsoleWithoutSignIn goes through claudex.ProvideModule
// and the module's route groups: the public route needs no JWT (the user
// group would answer 401 here), validates the X-Claudex-* headers and is
// registered exactly once.
func TestModuleServesWebConsoleWithoutSignIn(t *testing.T) {
	gatewayhook.Reset()
	claudexhook.Reset()
	t.Cleanup(func() {
		gatewayhook.Reset()
		claudexhook.Reset()
	})
	for raw, want := range map[string]string{"": `{"admin_only":true}`, `{"admin_only":false}`: `{"admin_only":false}`} {
		values := map[string]string{}
		if raw != "" {
			values[webconsole.SettingKey] = raw
		}
		m := claudex.ProvideModule(claudex.Deps{SettingRepo: readOnlyRepo{values: values}})
		gin.SetMode(gin.TestMode)
		r := gin.New()
		jwtAuth := middleware.JWTAuthMiddleware(func(c *gin.Context) {
			middleware.AbortWithError(c, http.StatusUnauthorized, "UNAUTHORIZED", "Authorization required")
		})
		m.RegisterRoutes(r.Group("/api/v1"), jwtAuth, middleware.AuditLogMiddleware(func(c *gin.Context) { c.Next() }), nil, nil)

		n := 0
		for _, route := range r.Routes() {
			if route.Path == "/api/v1/claudex/web-console" {
				n++
				require.Equal(t, http.MethodGet, route.Method)
			}
		}
		require.Equal(t, 1, n)

		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/claudex/web-console", nil))
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		require.JSONEq(t, `{"code":0,"message":"success","data":`+want+`}`, rec.Body.String())
		require.Equal(t, "public, max-age=60", rec.Header().Get("Cache-Control"))

		rec = httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/api/v1/claudex/web-console", nil)
		req.Header.Set("X-Claudex-Platform", "beos")
		r.ServeHTTP(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
		require.Contains(t, rec.Body.String(), "CLAUDEX_INVALID_CLIENT_HEADER")
	}
}
