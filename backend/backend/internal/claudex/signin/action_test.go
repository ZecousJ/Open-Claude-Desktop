package signin

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func actionRequest(engine *gin.Engine, path, body string, userID int64, sid string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Test-User", strconv.FormatInt(userID, 10))
	req.Header.Set("Test-Session", sid)
	result := httptest.NewRecorder()
	engine.ServeHTTP(result, req)
	return result
}

func actionRouter(c *Component) *gin.Engine {
	engine := gin.New()
	engine.Use(func(g *gin.Context) {
		uid, _ := strconv.ParseInt(g.GetHeader("Test-User"), 10, 64)
		g.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: uid})
		g.Set(middleware.ContextKeySessionID, g.GetHeader("Test-Session"))
	})
	c.RegisterUserRoutes(engine.Group("/api/v1/claudex"))
	engine.POST("/sensitive", c.ActionVerificationGuard("delete your account"), func(g *gin.Context) { g.Status(204) })
	return engine
}

func TestActionVerificationRefusesWithoutStorageOrSession(t *testing.T) {
	c := New(&core.Env{})
	router := actionRouter(c)
	result := actionRequest(router, "/sensitive", "", 7, "session")
	require.Equal(t, 403, result.Code)
	require.Contains(t, result.Body.String(), "action_verification_required")
	require.Contains(t, result.Body.String(), "delete your account")
	require.Equal(t, "no-store", result.Header().Get("Cache-Control"))
}

func TestActionVerificationMasksDestination(t *testing.T) {
	require.Equal(t, "a****@example.com", maskEmail("alice@example.com"))
	require.Equal(t, "*@example.com", maskEmail("a@example.com"))
	require.Equal(t, "your email address", maskEmail(""))
}

func TestActionVerificationSendConfirmAndFreshness(t *testing.T) {
	f := newFixture(t, nil)
	router := actionRouter(f.c)
	send := actionRequest(router, "/api/v1/claudex/action-verification/send", "{}", 7, "session")
	require.Equal(t, 200, send.Code, send.Body.String())
	require.Contains(t, send.Body.String(), `"code_length":6`)
	code := f.lastCode()
	require.Len(t, code, 6)
	require.Equal(t, "Alice@Example.com", f.mails[0].to)
	require.Equal(t, "Confirm it’s you", f.mails[0].subject)
	require.Equal(t, 403, actionRequest(router, "/sensitive", "", 7, "session").Code)
	result := actionRequest(router, "/api/v1/claudex/action-verification/confirm", `{"code":"`+code+`"}`, 7, "session")
	require.Equal(t, 200, result.Code, result.Body.String())
	require.Equal(t, 204, actionRequest(router, "/sensitive", "", 7, "session").Code)
	require.Equal(t, 403, actionRequest(router, "/sensitive", "", 7, "other-session").Code)
	f.mr.FastForward(10 * time.Minute)
	require.Equal(t, 403, actionRequest(router, "/sensitive", "", 7, "session").Code)
}

func TestActionVerificationCodeIsBoundToUserSessionAndEmail(t *testing.T) {
	f := newFixture(t, nil)
	repo := f.c.env.UserRepo.(*userRepo)
	repo.users[9] = &service.User{ID: 9, Email: "other@example.com", Role: service.RoleUser, Status: service.StatusActive}
	router := actionRouter(f.c)
	require.Equal(t, 200, actionRequest(router, "/api/v1/claudex/action-verification/send", "{}", 7, "session").Code)
	code := f.lastCode()
	for _, pair := range []struct {
		user int64
		sid  string
	}{{9, "session"}, {7, "other-session"}} {
		result := actionRequest(router, "/api/v1/claudex/action-verification/confirm", `{"code":"`+code+`"}`, pair.user, pair.sid)
		require.Equal(t, 400, result.Code)
		require.Contains(t, result.Body.String(), "challenge_expired")
	}
	original := repo.users[7].Email
	repo.users[7].Email = "changed@example.com"
	result := actionRequest(router, "/api/v1/claudex/action-verification/confirm", `{"code":"`+code+`"}`, 7, "session")
	require.Contains(t, result.Body.String(), "invalid_code")
	repo.users[7].Email = original
	require.Equal(t, 200, actionRequest(router, "/api/v1/claudex/action-verification/confirm", `{"code":"`+code+`"}`, 7, "session").Code)
	result = actionRequest(router, "/api/v1/claudex/action-verification/confirm", `{"code":"`+code+`"}`, 7, "session")
	require.Equal(t, 400, result.Code)
}

func TestActionVerificationCooldownAndHourlyLimit(t *testing.T) {
	f := newFixture(t, nil)
	router := actionRouter(f.c)
	require.Equal(t, 200, actionRequest(router, "/api/v1/claudex/action-verification/send", "{}", 7, "session").Code)
	result := actionRequest(router, "/api/v1/claudex/action-verification/send", "{}", 7, "other-session")
	require.Equal(t, 429, result.Code)
	require.Contains(t, result.Body.String(), `"retry_after_seconds":60`)
	for sent := 1; sent < sendsPerHour; sent++ {
		f.mr.FastForward(time.Minute)
		require.Equal(t, 200, actionRequest(router, "/api/v1/claudex/action-verification/send", "{}", 7, "session").Code)
	}
	f.mr.FastForward(time.Minute)
	require.Equal(t, 429, actionRequest(router, "/api/v1/claudex/action-verification/send", "{}", 7, "session").Code)
	require.Len(t, f.mails, sendsPerHour)
}

func TestActionVerificationAttemptsExpiryAndDeliveryFailure(t *testing.T) {
	f := newFixture(t, nil)
	router := actionRouter(f.c)
	require.Equal(t, 200, actionRequest(router, "/api/v1/claudex/action-verification/send", "{}", 7, "session").Code)
	code := f.lastCode()
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		result := actionRequest(router, "/api/v1/claudex/action-verification/confirm", `{"code":"`+wrongCode(code)+`"}`, 7, "session")
		expected := "invalid_code"
		if attempt == maxAttempts {
			expected = "challenge_locked"
		}
		require.Contains(t, result.Body.String(), expected)
	}
	result := actionRequest(router, "/api/v1/claudex/action-verification/confirm", `{"code":"`+code+`"}`, 7, "session")
	require.Contains(t, result.Body.String(), "challenge_locked")
	f.mr.FastForward(time.Minute)
	require.Equal(t, 200, actionRequest(router, "/api/v1/claudex/action-verification/send", "{}", 7, "session").Code)
	code = f.lastCode()
	f.mr.FastForward(codeTTL)
	result = actionRequest(router, "/api/v1/claudex/action-verification/confirm", `{"code":"`+code+`"}`, 7, "session")
	require.Contains(t, result.Body.String(), "challenge_expired")
	f.c.sendMail = func(context.Context, string, string, string) error { return errors.New("SMTP unavailable") }
	result = actionRequest(router, "/api/v1/claudex/action-verification/send", "{}", 7, "session")
	require.Equal(t, 503, result.Code)
	require.Contains(t, result.Body.String(), "code_not_sent")
	require.Equal(t, 403, actionRequest(router, "/sensitive", "", 7, "session").Code)
}
