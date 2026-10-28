//go:build unit

package middleware

// CLAUDEX: tests for the H9b session revocation check (claudex_session.go).

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	claudexhook "github.com/Wei-Shaw/sub2api/internal/claudex/hook"
	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestClaudexSessionRevocationOnUserAndAdminTokens(t *testing.T) {
	t.Cleanup(claudexhook.Reset)
	gin.SetMode(gin.TestMode)
	user := &service.User{ID: 1, Email: "u@example.com", Role: service.RoleUser, Status: service.StatusActive, TokenVersion: 1}
	admin := &service.User{ID: 2, Email: "a@example.com", Role: service.RoleAdmin, Status: service.StatusActive, TokenVersion: 1}

	cfg := &config.Config{}
	cfg.JWT.Secret = "test-jwt-secret-32bytes-long!!!"
	cfg.JWT.AccessTokenExpireMinutes = 60
	repo := &stubJWTUserRepo{users: map[int64]*service.User{1: user, 2: admin}}
	authSvc := service.NewAuthService(nil, repo, nil, nil, cfg, nil, nil, nil, nil, nil, nil, nil, nil)
	userSvc := service.NewUserService(repo, nil, nil, nil)

	r := gin.New()
	ok := func(c *gin.Context) { c.Status(http.StatusNoContent) }
	r.GET("/user", gin.HandlerFunc(NewJWTAuthMiddleware(authSvc, userSvc, nil, nil)), ok)
	r.GET("/optional", gin.HandlerFunc(NewOptionalJWTAuthMiddleware(authSvc, userSvc, nil, nil)), ok)
	r.GET("/admin", gin.HandlerFunc(NewAdminAuthMiddleware(authSvc, userSvc, nil, nil)), ok)

	userToken, err := authSvc.GenerateToken(context.Background(), user)
	require.NoError(t, err)
	adminToken, err := authSvc.GenerateToken(context.Background(), admin)
	require.NoError(t, err)

	call := func(path, token string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		r.ServeHTTP(rec, req)
		return rec
	}
	code := func(rec *httptest.ResponseRecorder) string {
		var body struct {
			Code string `json:"code"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		return body.Code
	}

	// No module installed: upstream behavior.
	claudexhook.Reset()
	require.Equal(t, http.StatusNoContent, call("/user", userToken).Code)
	require.Equal(t, http.StatusNoContent, call("/admin", adminToken).Code)

	var seenUser int64
	var seenIssuedAt time.Time
	state := claudexhook.Valid
	claudexhook.Install(claudexhook.Hooks{JWTRevoked: func(_ context.Context, userID int64, issuedAt time.Time, _ string) claudexhook.SessionState {
		seenUser, seenIssuedAt = userID, issuedAt
		return state
	}})

	require.Equal(t, http.StatusNoContent, call("/user", userToken).Code)
	require.Equal(t, int64(1), seenUser)
	require.WithinDuration(t, time.Now(), seenIssuedAt, time.Minute, "the token's iat reaches the check")

	state = claudexhook.Revoked
	for _, tc := range []struct{ path, token string }{{"/user", userToken}, {"/optional", userToken}, {"/admin", adminToken}} {
		rec := call(tc.path, tc.token)
		require.Equal(t, http.StatusUnauthorized, rec.Code, tc.path)
		require.Equal(t, "CLAUDEX_SESSION_REVOKED", code(rec), tc.path)
	}

	state = claudexhook.CheckFailed
	for _, tc := range []struct{ path, token string }{{"/user", userToken}, {"/admin", adminToken}} {
		rec := call(tc.path, tc.token)
		require.Equal(t, http.StatusServiceUnavailable, rec.Code, tc.path)
		require.Equal(t, "CLAUDEX_SESSION_CHECK_FAILED", code(rec), tc.path)
	}

	// Anonymous requests on optional routes are not checked.
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/optional", nil))
	require.Equal(t, http.StatusNoContent, rec.Code)
}
