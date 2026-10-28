package routes

// CLAUDEX: file added by the Claudex fork (see backend/CLAUDEX_CHANGES.md).

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/claudex"
	"github.com/Wei-Shaw/sub2api/internal/handler"
	servermiddleware "github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// complianceSettingRepo stands in for the settings table on the request path,
// where only AdminComplianceGuard reads a setting (the acknowledgement).
type complianceSettingRepo struct {
	service.SettingRepository
	acknowledged bool
}

func (r complianceSettingRepo) GetValue(_ context.Context, _ string) (string, error) {
	if r.acknowledged {
		raw, _ := json.Marshal(service.AdminComplianceAcknowledgement{Version: service.AdminComplianceVersion, AdminUserID: 1})
		return string(raw), nil
	}
	return "", service.ErrSettingNotFound
}

func TestClaudexAdminRoutesSitBehindAdminAuthAndComplianceGuard(t *testing.T) {
	gin.SetMode(gin.TestMode)
	adminAuth := servermiddleware.AdminAuthMiddleware(func(c *gin.Context) {
		if c.GetHeader("Authorization") == "" {
			servermiddleware.AbortWithError(c, http.StatusUnauthorized, "UNAUTHORIZED", "Authorization required")
			return
		}
		c.Set(string(servermiddleware.ContextKeyUser), servermiddleware.AuthSubject{UserID: 1})
		c.Set(string(servermiddleware.ContextKeyUserRole), service.RoleAdmin)
		c.Next()
	})
	auditLog := servermiddleware.AuditLogMiddleware(func(c *gin.Context) { c.Next() })
	stepUp := servermiddleware.StepUpAuthMiddleware(func(c *gin.Context) { c.Next() })

	for _, tc := range []struct {
		name         string
		auth         string
		acknowledged bool
		wantStatus   int
	}{
		{name: "unauthenticated", wantStatus: http.StatusUnauthorized},
		{name: "compliance pending", auth: "Bearer admin", wantStatus: http.StatusLocked},
		{name: "compliance accepted", auth: "Bearer admin", acknowledged: true, wantStatus: http.StatusOK},
	} {
		t.Run(tc.name, func(t *testing.T) {
			router := gin.New()
			settingService := service.NewSettingService(complianceSettingRepo{acknowledged: tc.acknowledged}, nil)
			handlers := &handler.Handlers{
				Admin:   &handler.AdminHandlers{},
				Claudex: claudex.NewModule(claudex.Deps{}),
			}
			RegisterAdminRoutes(router.Group("/api/v1"), handlers, adminAuth, auditLog, stepUp, settingService, nil)

			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodGet, "/api/v1/admin/claudex/overview", nil)
			if tc.auth != "" {
				request.Header.Set("Authorization", tc.auth)
			}
			router.ServeHTTP(recorder, request)
			require.Equal(t, tc.wantStatus, recorder.Code, recorder.Body.String())
		})
	}
}

func TestRegisterAdminRoutesWithoutClaudexModule(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	noop := func(c *gin.Context) { c.Next() }
	RegisterAdminRoutes(router.Group("/api/v1"), &handler.Handlers{Admin: &handler.AdminHandlers{}},
		servermiddleware.AdminAuthMiddleware(noop), servermiddleware.AuditLogMiddleware(noop),
		servermiddleware.StepUpAuthMiddleware(noop), nil, nil)
	for _, r := range router.Routes() {
		require.NotContains(t, r.Path, "/admin/claudex")
	}
}
