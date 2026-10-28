package middleware

// CLAUDEX: file added by the Claudex fork (see backend/CLAUDEX_CHANGES.md).
//
// H9b: every access token is checked against the Claudex session revocations
// ("log out of all devices" and device revocations, B4) right after the
// upstream token-version check, in both the user JWT middleware and the
// admin JWT path. Without the Claudex module installed the check is a no-op.

import (
	"net/http"
	"time"

	claudexhook "github.com/Wei-Shaw/sub2api/internal/claudex/hook"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
)

// abortIfClaudexSessionRevoked answers 401 CLAUDEX_SESSION_REVOKED for a
// signed-out session and 503 CLAUDEX_SESSION_CHECK_FAILED when the revocation
// state cannot be read (fail closed), and reports whether it answered.
func abortIfClaudexSessionRevoked(c *gin.Context, claims *service.JWTClaims) bool {
	if claims == nil {
		return false
	}
	var issuedAt time.Time
	if claims.IssuedAt != nil {
		issuedAt = claims.IssuedAt.Time
	}
	switch claudexhook.JWTRevoked(c.Request.Context(), claims.UserID, issuedAt, claims.SessionID) {
	case claudexhook.Revoked:
		AbortWithError(c, http.StatusUnauthorized, "CLAUDEX_SESSION_REVOKED", "This session was signed out. Sign in again.")
		return true
	case claudexhook.CheckFailed:
		AbortWithError(c, http.StatusServiceUnavailable, "CLAUDEX_SESSION_CHECK_FAILED", "Service temporarily unavailable. Try again.")
		return true
	}
	return false
}
