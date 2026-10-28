//go:build unit

package handler

// CLAUDEX: tests for the H9b check on the OAuth bind access-token cookie.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	claudexhook "github.com/Wei-Shaw/sub2api/internal/claudex/hook"
	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// A stolen access token that "log out of all devices" ended must not start an
// OAuth identity binding through the cookie the public start routes read.
func TestOAuthBindRefusesSignedOutAccessTokens(t *testing.T) {
	gin.SetMode(gin.TestMode)
	t.Cleanup(claudexhook.Reset)
	repo := &userHandlerRepoStub{user: &service.User{ID: 29, Email: "s@example.com", Role: service.RoleUser, Status: service.StatusActive}}
	cfg := &config.Config{JWT: config.JWTConfig{Secret: "test-secret", ExpireHour: 1, AccessTokenExpireMinutes: 60}}
	auth := service.NewAuthService(nil, repo, nil, nil, cfg, nil, nil, nil, nil, nil, nil, nil, nil)
	h := &AuthHandler{authService: auth, userService: service.NewUserService(repo, nil, nil, nil)}
	token, err := auth.GenerateToken(context.Background(), repo.user)
	require.NoError(t, err)

	resolve := func() (*int64, error) {
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/oauth/linuxdo/start?intent=bind_current_user", nil)
		req.AddCookie(&http.Cookie{Name: oauthBindAccessTokenCookieName, Value: url.QueryEscape(token)})
		c.Request = req
		return h.resolveOAuthBindTargetUserID(c)
	}

	id, err := resolve()
	require.NoError(t, err, "a live token still binds")
	require.Equal(t, int64(29), *id)

	for _, state := range []claudexhook.SessionState{claudexhook.Revoked, claudexhook.CheckFailed} {
		claudexhook.Install(claudexhook.Hooks{JWTRevoked: func(_ context.Context, userID int64, issuedAt time.Time, _ string) claudexhook.SessionState {
			require.Equal(t, int64(29), userID)
			require.False(t, issuedAt.IsZero())
			return state
		}})
		_, err = resolve()
		require.ErrorIs(t, err, service.ErrInvalidToken, "session state %d", state)
	}
}
