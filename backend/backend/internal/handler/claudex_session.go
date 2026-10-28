package handler

// CLAUDEX: file added by the Claudex fork (see backend/CLAUDEX_CHANGES.md).
//
// H9b outside the JWT middlewares: the OAuth "bind current user" flow reads
// the signed-in user's access token from the oauth_bind_access_token cookie
// on public OAuth start routes, so the middleware check never sees it. A
// token that "log out of all devices" or a device sign-out ended must not
// start an identity binding either (it would let a stolen token attach a new
// login to the account).

import (
	"context"
	"time"

	claudexhook "github.com/Wei-Shaw/sub2api/internal/claudex/hook"
	"github.com/Wei-Shaw/sub2api/internal/service"
)

// claudexAccessTokenEnded reports whether the Claudex session check refuses
// the token: signed out, or the state could not be read (fail closed).
func claudexAccessTokenEnded(ctx context.Context, claims *service.JWTClaims) bool {
	if claims == nil {
		return false
	}
	var issuedAt time.Time
	if claims.IssuedAt != nil {
		issuedAt = claims.IssuedAt.Time
	}
	return claudexhook.JWTRevoked(ctx, claims.UserID, issuedAt, claims.SessionID) != claudexhook.Valid
}
