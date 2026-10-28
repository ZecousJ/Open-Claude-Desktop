//go:build unit

package handler

// CLAUDEX: tests for the LOGIN email code bridge (CodeLogin, RespondLogin).

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/config"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func newCodeLoginAdapter(t *testing.T, backendMode bool) (*claudexWebAuth, *service.AuthService) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	value := "false"
	if backendMode {
		value = "true"
	}
	settings := service.NewSettingService(&passkeySwitchSettingRepo{
		value:  value,
		values: map[string]string{service.SettingKeyBackendModeEnabled: value},
	}, &config.Config{})
	repo := &userHandlerRepoStub{user: &service.User{ID: 3, Email: "u@example.com", Role: service.RoleUser, Status: service.StatusActive}}
	cfg := &config.Config{JWT: config.JWTConfig{Secret: "test-secret", ExpireHour: 1, AccessTokenExpireMinutes: 60}}
	auth := service.NewAuthService(nil, repo, nil, nil, cfg, nil, nil, nil, nil, nil, nil, nil, nil)
	h := &AuthHandler{authService: auth, settingSvc: settings, userService: service.NewUserService(repo, nil, nil, nil)}
	w, ok := newClaudexWebAuth(h, nil).(*claudexWebAuth)
	require.True(t, ok)
	return w, auth
}

func codeLoginContext() (*gin.Context, *httptest.ResponseRecorder) {
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	c.Request = httptest.NewRequest(http.MethodPost, "/api/v1/claudex/auth/email-code/login", nil)
	return c, rec
}

func TestClaudexCodeLoginRunsTheUpstreamChecks(t *testing.T) {
	w, _ := newCodeLoginAdapter(t, false)
	c, _ := codeLoginContext()
	_, _, err := w.CodeLogin(c, &service.User{ID: 3, Email: "u@example.com", Role: service.RoleUser, Status: service.StatusDisabled})
	require.ErrorIs(t, err, service.ErrUserNotActive, "the same error as the password login")
	_, _, err = w.CodeLogin(c, nil)
	require.Error(t, err)

	w, _ = newCodeLoginAdapter(t, true)
	c, _ = codeLoginContext()
	_, _, err = w.CodeLogin(c, &service.User{ID: 3, Email: "u@example.com", Role: service.RoleUser, Status: service.StatusActive})
	require.Equal(t, "BACKEND_MODE_ADMIN_ONLY", infraerrors.Reason(err), "backend mode only lets admins in")
}

func TestClaudexRespondLoginIsTheUpstreamAnswer(t *testing.T) {
	w, _ := newCodeLoginAdapter(t, false)
	c, rec := codeLoginContext()
	c.Request = c.Request.WithContext(context.Background())
	w.RespondLogin(c, &service.User{ID: 3, Email: "u@example.com", Role: service.RoleUser, Status: service.StatusActive})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var body struct {
		Data struct {
			AccessToken string `json:"access_token"`
			TokenType   string `json:"token_type"`
			User        struct {
				ID    int64  `json:"id"`
				Email string `json:"email"`
			} `json:"user"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.NotEmpty(t, body.Data.AccessToken)
	require.Equal(t, "Bearer", body.Data.TokenType)
	require.Equal(t, int64(3), body.Data.User.ID)
}
