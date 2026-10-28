package web

// Checks other components use for web-session requests they serve
// themselves (W-VOICE: the dictation ticket and the dictation socket). They
// are the checks of the auth routes: the voice component registers its
// ticket route beside them and finds this component through env.Components.

import (
	"context"
	"errors"
	"time"

	claudexhook "github.com/Wei-Shaw/sub2api/internal/claudex/hook"
	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
)

// ErrNoWebSession answers a token that does not belong to an active web
// session (a console token, or a session that ended).
var ErrNoWebSession = errEnded

// AuthorizeWebPost runs the checks of the web auth POST routes for a route
// another component registers under /web/auth: CSRF (X-Claudex-Web and the
// site's own origin), the site switch, the bearer access token (upstream JWT
// checks and the revocation check), the allowlist, and that the token
// belongs to an active web session. On failure it has written the answer
// and ok is false.
func (c *Component) AuthorizeWebPost(g *gin.Context) (userID int64, sessionID string, issuedAt time.Time, ok bool) {
	if g.GetHeader(webproto.HeaderWeb) != "1" || !c.sameOrigin(g) {
		response.ErrorFrom(g, errCSRF)
		return 0, "", time.Time{}, false
	}
	ctx := g.Request.Context()
	if !c.setting.Cached(ctx).Enabled {
		response.ErrorFrom(g, errDisabled)
		return 0, "", time.Time{}, false
	}
	user, claims, authed := c.bearerUser(g)
	if !authed {
		return 0, "", time.Time{}, false
	}
	if !c.allowed(ctx, user) {
		response.ErrorFrom(g, errNotAllowed)
		return 0, "", time.Time{}, false
	}
	if claims.IssuedAt != nil {
		issuedAt = claims.IssuedAt.Time
	}
	if err := c.activeSession(ctx, user.ID, claims.SessionID); err != nil {
		response.ErrorFrom(g, err)
		return 0, "", time.Time{}, false
	}
	return user.ID, claims.SessionID, issuedAt, true
}

// CheckWebCaller checks again, later (for example when a ticket is
// redeemed), that the web session a token belonged to may still act: the
// site is on, the user is active and allowed, the session row is active and
// the token was not revoked ("log out of all devices", a signed-out
// session). It returns ErrNoWebSession (401) or a 403/503 error.
func (c *Component) CheckWebCaller(ctx context.Context, userID int64, sessionID string, issuedAt time.Time) error {
	if !c.setting.Cached(ctx).Enabled {
		return errDisabled
	}
	if userID <= 0 || sessionID == "" {
		return ErrNoWebSession
	}
	users := c.env.Users
	if users == nil {
		return errUnavailable
	}
	user, err := users.GetByID(ctx, userID)
	if err != nil {
		if errors.Is(err, service.ErrUserNotFound) {
			return ErrNoWebSession
		}
		return errUnavailable
	}
	if !user.IsActive() {
		return ErrNoWebSession
	}
	if !c.allowed(ctx, user) {
		return errNotAllowed
	}
	switch claudexhook.JWTRevoked(ctx, userID, issuedAt, sessionID) {
	case claudexhook.Revoked:
		return ErrNoWebSession
	case claudexhook.CheckFailed:
		return errUnavailable
	}
	return c.activeSession(ctx, userID, sessionID)
}

// activeSession checks that sessionID is an active web session of the user.
func (c *Component) activeSession(ctx context.Context, userID int64, sessionID string) error {
	if sessionID == "" {
		return ErrNoWebSession
	}
	if c.env.DB == nil {
		return errUnavailable
	}
	sess, err := c.store.byFamily(ctx, sessionID)
	switch {
	case errors.Is(err, errNoSession):
		return ErrNoWebSession
	case err != nil:
		return errUnavailable
	case sess.UserID != userID || !sess.active(c.now()):
		return ErrNoWebSession
	}
	return nil
}

// SameSiteRequest reports whether the request comes from the web app's own
// origin (Origin, or Sec-Fetch-Site without one): the WebSocket upgrade
// check against cross-site WebSocket hijacking.
func (c *Component) SameSiteRequest(g *gin.Context) bool { return c.sameOrigin(g) }
