//go:build unit

package handler

// CLAUDEX: tests for the H9 hook in AuthHandler.RevokeAllSessions.

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"testing"

	claudexhook "github.com/Wei-Shaw/sub2api/internal/claudex/hook"
	"github.com/Wei-Shaw/sub2api/internal/config"
	middleware2 "github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestRevokeAllSessionsSignsOutClaudexDevices(t *testing.T) {
	gin.SetMode(gin.TestMode)
	t.Cleanup(claudexhook.Reset)
	newHandler := func() (*AuthHandler, *userHandlerRefreshTokenCacheStub) {
		repo := &userHandlerRepoStub{user: &service.User{ID: 29, Email: "s@example.com", Role: service.RoleUser, Status: service.StatusActive}}
		cache := &userHandlerRefreshTokenCacheStub{}
		cfg := &config.Config{JWT: config.JWTConfig{Secret: "test-secret", ExpireHour: 1}}
		return &AuthHandler{authService: service.NewAuthService(nil, repo, nil, cache, cfg, nil, nil, nil, nil, nil, nil, nil, nil)}, cache
	}
	call := func(h *AuthHandler) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(rec)
		c.Request = httptest.NewRequest(http.MethodPost, "/api/v1/auth/revoke-all-sessions", nil)
		c.Set(string(middleware2.ContextKeyUser), middleware2.AuthSubject{UserID: 29})
		h.RevokeAllSessions(c)
		return rec
	}

	var calls []string
	var fail error
	claudexhook.Install(claudexhook.Hooks{SessionsRevoked: func(_ context.Context, userID int64, reason string) error {
		calls = append(calls, reason)
		require.Equal(t, int64(29), userID)
		return fail
	}})

	h, cache := newHandler()
	require.Equal(t, http.StatusOK, call(h).Code)
	require.Equal(t, []string{"revoke_all"}, calls)
	require.Equal(t, []int64{29}, cache.revokedUserIDs, "refresh tokens are revoked first")

	// A failure must not be reported as success: the client retries.
	fail = errors.New("db down")
	h, _ = newHandler()
	require.Equal(t, http.StatusInternalServerError, call(h).Code)
}

// TestPasswordResetDoesNotRevokeClaudexDevices pins owner decision 4: the
// Claudex sign-out hook is called from "log out of all devices" only, never
// from password reset or the other session-revoking paths.
func TestPasswordResetDoesNotRevokeClaudexDevices(t *testing.T) {
	src, err := os.ReadFile("auth_handler.go")
	require.NoError(t, err)
	require.Len(t, regexp.MustCompile(`claudexhook\.SessionsRevoked\(`).FindAll(src, -1), 1)
	body := regexp.MustCompile(`(?s)func \(h \*AuthHandler\) RevokeAllSessions\(.*?\n}\n`).Find(src)
	require.NotNil(t, body)
	require.Contains(t, string(body), "claudexhook.SessionsRevoked(")
}
