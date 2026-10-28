package handler

// CLAUDEX: file added by the Claudex fork (see backend/CLAUDEX_CHANGES.md).
//
// H16 the phone apps sign in through the upstream /api/v1/auth token-pair
// endpoints. Settings → Account → Active sessions lists every signed-in
// session, so the Claudex module hears of each token pair these endpoints
// answer (with the session family, user agent and IP) and of each refresh
// token given back at log out. The desktop app (X-Claudex-Platform) and the
// web app (X-Claudex-Client) have lists of their own; the module tells them
// apart. Never stops or changes the answer.

import (
	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	claudexhook "github.com/Wei-Shaw/sub2api/internal/claudex/hook"
	middleware2 "github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
)

// claudexTokensIssued reports an answered token pair (H16).
func claudexTokensIssued(c *gin.Context, authService *service.AuthService, accessToken string, refreshed bool) {
	if c == nil || authService == nil || accessToken == "" || c.GetHeader(core.HeaderClient) != "" {
		return
	}
	claims, err := authService.ValidateToken(accessToken)
	if err != nil || claims == nil || claims.SessionID == "" {
		return
	}
	claudexhook.TokensIssued(c.Request.Context(), claudexhook.TokenIssue{
		UserID:    claims.UserID,
		SessionID: claims.SessionID,
		UserAgent: c.Request.UserAgent(),
		IP:        middleware2.SecurityClientIP(c),
		Platform:  c.GetHeader(core.HeaderPlatform),
		Refreshed: refreshed,
	})
}

// claudexTokensReturned reports a refresh token given back at log out (H16).
// It runs before the token is revoked, while its family can still be read.
func claudexTokensReturned(c *gin.Context, authService *service.AuthService, refreshToken string) {
	if c == nil || authService == nil || refreshToken == "" {
		return
	}
	userID, family, ok := authService.RefreshTokenOwner(c.Request.Context(), refreshToken)
	if !ok {
		return
	}
	claudexhook.TokensReturned(c.Request.Context(), userID, family)
}
