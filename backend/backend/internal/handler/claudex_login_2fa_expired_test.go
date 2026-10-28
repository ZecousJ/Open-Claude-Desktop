//go:build unit

package handler

// CLAUDEX: a 2FA login whose pending session is gone answers with a reason
// the apps recognise (they offer "Start again"), keeping the upstream status
// and message.

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// forgottenLoginSessions knows no pending 2FA login.
type forgottenLoginSessions struct{ service.TotpCache }

func (forgottenLoginSessions) GetLoginSession(context.Context, string) (*service.TotpLoginSession, error) {
	return nil, nil
}

func TestClaudexLogin2FAExpiredSessionHasAReason(t *testing.T) {
	gin.SetMode(gin.TestMode)
	h := &AuthHandler{totpService: service.NewTotpService(nil, nil, forgottenLoginSessions{}, nil, nil, nil)}
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	c.Request = httptest.NewRequest(http.MethodPost, "/api/v1/auth/login/2fa",
		bytes.NewBufferString(`{"temp_token":"expired-token","totp_code":"123456"}`))
	c.Request.Header.Set("Content-Type", "application/json")

	_, _, _, err := h.login2FAPrepare(c)
	require.Error(t, err)
	status, body := infraerrors.ToHTTP(err)
	require.Equal(t, http.StatusBadRequest, status)
	require.Equal(t, "CLAUDEX_2FA_SESSION_EXPIRED", body.Reason)
	require.Equal(t, "Invalid or expired 2FA session", body.Message)
}
