package web

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	claudexhook "github.com/Wei-Shaw/sub2api/internal/claudex/hook"
	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
	ratelimit "github.com/Wei-Shaw/sub2api/internal/middleware"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
)

// Error reasons of the auth routes.
const (
	ReasonSessionEnded = "CLAUDEX_WEB_SESSION_ENDED"
	ReasonNoSession    = "CLAUDEX_WEB_NO_SESSION"
)

var (
	errDisabled    = infraerrors.Forbidden(webproto.ErrCodeDisabled, "The web app is turned off.")
	errNotAllowed  = infraerrors.Forbidden(webproto.ErrCodeNotAllowed, "Your account cannot use the web app. Ask an administrator for access.")
	errNoBackend   = infraerrors.ServiceUnavailable("CLAUDEX_WEB_AUTH_UNAVAILABLE", "Sign-in is temporarily unavailable. Try again.")
	errNoCookie    = infraerrors.Unauthorized(ReasonNoSession, "Sign in to continue.")
	errEnded       = infraerrors.Unauthorized(ReasonSessionEnded, "This web session ended. Sign in again.")
	errUnavailable = infraerrors.ServiceUnavailable("CLAUDEX_WEB_SESSIONS_UNAVAILABLE", "Service temporarily unavailable. Try again.")
)

// Per-IP limits per minute, the same as the upstream /api/v1/auth routes.
var authLimits = map[string]int{
	webproto.AuthLogin:           20,
	webproto.AuthTwoFactor:       20,
	webproto.AuthCancelTwoFactor: 20,
	webproto.AuthRegister:        5,
	webproto.AuthSendCode:        5,
	webproto.AuthForgotPassword:  5,
	webproto.AuthResetPassword:   10,
	webproto.AuthRefresh:         30,
	webproto.AuthLogout:          30,
	webproto.AuthRevokeAll:       10,
	webproto.AuthEventsTicket:    60,
	webproto.AuthPasskeyBegin:    20,
	webproto.AuthPasskeyFinish:   20,
	webproto.AuthEmailCodeSend:   5,
	webproto.AuthEmailCodeLogin:  20,
	webproto.AuthGoogleLogin:     20,
	webproto.AuthAccounts:        60,
}

// selfService are the flows backend mode turns off (the upstream
// BackendModeAuthGuard blocks them on /api/v1/auth too).
var selfService = map[string]bool{
	webproto.AuthRegister:       true,
	webproto.AuthSendCode:       true,
	webproto.AuthForgotPassword: true,
	webproto.AuthResetPassword:  true,
	webproto.AuthEmailCodeSend:  true,
}

func (c *Component) registerAuthRoutes(g *gin.RouterGroup) {
	g.Use(c.csrf, c.requireEnabled)
	route := func(name string, h gin.HandlerFunc) {
		g.POST("/"+name, c.limit(name), c.backendModeGuard(name), h)
	}
	route(webproto.AuthLogin, c.login)
	route(webproto.AuthTwoFactor, c.twoFactor)
	route(webproto.AuthCancelTwoFactor, c.cancelTwoFactor)
	route(webproto.AuthRegister, c.register)
	route(webproto.AuthSendCode, c.passThrough(func(b core.WebAuthBackend, g *gin.Context) (any, error) { return b.SendCode(g) }))
	route(webproto.AuthForgotPassword, c.passThrough(func(b core.WebAuthBackend, g *gin.Context) (any, error) { return b.ForgotPassword(g) }))
	route(webproto.AuthResetPassword, c.passThrough(func(b core.WebAuthBackend, g *gin.Context) (any, error) { return b.ResetPassword(g) }))
	route(webproto.AuthPasskeyBegin, c.passThrough(func(b core.WebAuthBackend, g *gin.Context) (any, error) { return b.PasskeyBegin(g) }))
	route(webproto.AuthPasskeyFinish, c.passkeyFinish)
	route(webproto.AuthRefresh, c.refresh)
	route(webproto.AuthLogout, c.logout)
	route(webproto.AuthRevokeAll, c.revokeAll)
	route(webproto.AuthEventsTicket, c.eventsTicket)
	route(webproto.AuthEmailCodeSend, c.emailCodeSend)
	route(webproto.AuthEmailCodeLogin, c.emailCodeLogin)
	route(webproto.AuthGoogleLogin, c.googleLogin)
	route(webproto.AuthAccounts, c.accounts)
}

// requireEnabled answers 403 CLAUDEX_WEB_DISABLED while the web app is off.
func (c *Component) requireEnabled(g *gin.Context) {
	if !c.setting.Cached(g.Request.Context()).Enabled {
		response.ErrorFrom(g, errDisabled)
		g.Abort()
		return
	}
	g.Next()
}

// limit applies the upstream per-IP limit, failing closed on Redis errors
// like the upstream auth routes. Without Redis (tests) it passes.
func (c *Component) limit(name string) gin.HandlerFunc {
	n := authLimits[name]
	if c.env.Redis == nil || n <= 0 {
		return func(g *gin.Context) { g.Next() }
	}
	key := "claudex-web-auth-" + strings.ReplaceAll(name, "/", "-")
	return ratelimit.NewRateLimiter(c.env.Redis).LimitWithOptions(key, n, time.Minute,
		ratelimit.RateLimitOptions{FailureMode: ratelimit.RateLimitFailClose})
}

func (c *Component) backendModeGuard(name string) gin.HandlerFunc {
	if !selfService[name] {
		return func(g *gin.Context) { g.Next() }
	}
	return func(g *gin.Context) {
		if svc := c.env.SettingService; svc != nil && svc.IsBackendModeEnabled(g.Request.Context()) {
			response.Forbidden(g, "Backend mode is active. Registration and self-service auth flows are disabled.")
			g.Abort()
			return
		}
		g.Next()
	}
}

func (c *Component) backendOr503(g *gin.Context) (core.WebAuthBackend, bool) {
	b := c.auth()
	if b == nil {
		response.ErrorFrom(g, errNoBackend)
		return nil, false
	}
	return b, true
}

// passThrough answers the upstream result as is (no session involved).
func (c *Component) passThrough(run func(core.WebAuthBackend, *gin.Context) (any, error)) gin.HandlerFunc {
	return func(g *gin.Context) {
		b, ok := c.backendOr503(g)
		if !ok {
			return
		}
		out, err := run(b, g)
		if err != nil {
			response.ErrorFrom(g, err)
			return
		}
		response.Success(g, out)
	}
}

// POST auth/login: the 2FA challenge goes back as is, otherwise a session.
func (c *Component) login(g *gin.Context) {
	b, ok := c.backendOr503(g)
	if !ok {
		return
	}
	user, challenge, err := b.Login(g)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	if challenge != nil {
		response.Success(g, challenge)
		return
	}
	c.issue(g, user)
}

// emailCode returns the email code sign-in (package signin).
func (c *Component) emailCode() core.EmailCodeSignIn {
	if c.emailCodes != nil {
		return c.emailCodes
	}
	return core.FindEmailCodeSignIn(c.env)
}

// POST auth/email-code/send: the signin component's answer as is.
func (c *Component) emailCodeSend(g *gin.Context) {
	ec := c.emailCode()
	if ec == nil {
		response.ErrorFrom(g, errNoBackend)
		return
	}
	g.Set(core.EmailLinkOriginKey, c.siteOrigin(g))
	out, err := ec.SendEmailCode(g)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	response.Success(g, out)
}

// POST auth/email-code/login: like login, with the email code instead of
// the password; the 2FA challenge goes back as is (auth/2fa completes it),
// otherwise a session.
func (c *Component) emailCodeLogin(g *gin.Context) {
	b, ok := c.backendOr503(g)
	if !ok {
		return
	}
	ec := c.emailCode()
	if ec == nil {
		response.ErrorFrom(g, errNoBackend)
		return
	}
	verified, err := ec.VerifyEmailCode(g)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	user, challenge, err := b.CodeLogin(g, verified)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	if challenge != nil {
		response.Success(g, challenge)
		return
	}
	c.issue(g, user)
}

// googleLogin signs in with Google (package signin) into the cookie session.
func (c *Component) googleLogin(g *gin.Context) {
	b, ok := c.backendOr503(g)
	if !ok {
		return
	}
	gs := core.FindGoogleSignIn(c.env)
	if gs == nil {
		response.ErrorFrom(g, errNoBackend)
		return
	}
	verified, err := gs.VerifyGoogle(g)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	user, challenge, err := b.CodeLogin(g, verified)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	if challenge != nil {
		response.Success(g, challenge)
		return
	}
	c.issue(g, user)
}

func (c *Component) twoFactor(g *gin.Context) {
	c.userFlow(g, func(b core.WebAuthBackend) (*service.User, error) { return b.TwoFactor(g) })
}

func (c *Component) register(g *gin.Context) {
	c.userFlow(g, func(b core.WebAuthBackend) (*service.User, error) { return b.Register(g) })
}

func (c *Component) passkeyFinish(g *gin.Context) {
	c.userFlow(g, func(b core.WebAuthBackend) (*service.User, error) { return b.PasskeyFinish(g) })
}

func (c *Component) userFlow(g *gin.Context, run func(core.WebAuthBackend) (*service.User, error)) {
	b, ok := c.backendOr503(g)
	if !ok {
		return
	}
	user, err := run(b)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	c.issue(g, user)
}

func (c *Component) cancelTwoFactor(g *gin.Context) {
	b, ok := c.backendOr503(g)
	if !ok {
		return
	}
	if err := b.CancelTwoFactor(g); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	response.Success(g, gin.H{"cancelled": true})
}

// SessionUser is the user part of a session answer.
type SessionUser struct {
	ID       int64  `json:"id"`
	Email    string `json:"email"`
	Username string `json:"username"`
	Role     string `json:"role"`
}

// SessionResponse answers login, 2FA, register, passkey and refresh. The
// refresh token is only in the cookie.
type SessionResponse struct {
	AccessToken string      `json:"access_token"`
	TokenType   string      `json:"token_type"`
	ExpiresIn   int         `json:"expires_in"`
	SessionID   int64       `json:"session_id"`
	User        SessionUser `json:"user"`
}

func sessionUser(u *service.User) SessionUser {
	return SessionUser{ID: u.ID, Email: u.Email, Username: u.Username, Role: u.Role}
}

// allowed reports whether the settings let the user in.
func (c *Component) allowed(ctx context.Context, u *service.User) bool {
	s := c.setting.Cached(ctx)
	return s.Enabled && s.allows(u.ID, u.Email, u.IsAdmin())
}

// issue starts a web session for a user the upstream flow signed in.
func (c *Component) issue(g *gin.Context, user *service.User) {
	ctx := g.Request.Context()
	if user == nil {
		response.ErrorFrom(g, errNoBackend)
		return
	}
	if !user.IsActive() {
		response.ErrorFrom(g, service.ErrUserNotActive)
		return
	}
	if !c.allowed(ctx, user) {
		response.ErrorFrom(g, errNotAllowed)
		return
	}
	// Another account for this browser: only while it holds fewer than
	// webproto.BrowserAccounts (signing the same account in again replaces
	// its cookie).
	if atAccountLimit(g.Request, user.ID) {
		response.ErrorFrom(g, errAccountLimit)
		return
	}
	auth := c.env.AuthService
	if auth == nil || c.env.DB == nil {
		response.ErrorFrom(g, errUnavailable)
		return
	}
	pair, err := auth.GenerateTokenPair(ctx, user, "")
	if err != nil {
		slog.Error("claudex web: token pair failed", "user_id", user.ID, "error", err)
		response.ErrorFrom(g, errUnavailable)
		return
	}
	claims, err := auth.ValidateToken(pair.AccessToken)
	if err != nil || claims.SessionID == "" {
		_ = auth.RevokeRefreshToken(ctx, pair.RefreshToken)
		response.ErrorFrom(g, errUnavailable)
		return
	}
	now := c.now()
	sess, ended, err := c.store.create(ctx, Session{
		UserID:    user.ID,
		FamilyID:  claims.SessionID,
		UserAgent: clip(g.Request.UserAgent(), 256),
		IP:        clip(middleware.SecurityClientIP(g), 64),
		ExpiresAt: now.Add(c.refreshTTL()),
	}, c.setting.Cached(ctx).MaxSessionsPerUser, now, c.revokedUntil(now))
	if err != nil {
		slog.Error("claudex web: create session failed", "user_id", user.ID, "error", err)
		_ = auth.RevokeSessionFamily(ctx, claims.SessionID)
		response.ErrorFrom(g, errUnavailable)
		return
	}
	c.dropFamilies(ctx, ended)
	middleware.SetAuditActor(g, user.ID, user.Email)
	// The account's own cookie; the browser's other accounts stay signed in.
	c.setAccountCookie(g, user.ID, pair.RefreshToken)
	g.Header("Cache-Control", "no-store")
	response.Success(g, SessionResponse{
		AccessToken: pair.AccessToken,
		TokenType:   "Bearer",
		ExpiresIn:   pair.ExpiresIn,
		SessionID:   sess.ID,
		User:        sessionUser(user),
	})
}

// clip cuts s to at most n bytes on a rune boundary.
func clip(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	cut := n
	for cut > 0 && !utf8RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}

func utf8RuneStart(b byte) bool { return b&0xC0 != 0x80 }

// POST auth/refresh {account?}: rotates the refresh token of the account the
// body names (its own cookie), or, without a name, of the bare cookie or
// else one of the browser's account cookies (sessionCookie).
func (c *Component) refresh(g *gin.Context) {
	ctx := g.Request.Context()
	name, rt := sessionCookie(g, requestedAccount(g), true)
	if rt == "" {
		response.ErrorFrom(g, errNoCookie)
		return
	}
	auth := c.env.AuthService
	if auth == nil || c.env.DB == nil {
		response.ErrorFrom(g, errUnavailable)
		return
	}
	clearCookie := func() { clearCookieNamed(g, name) }
	result, err := auth.RefreshTokenPair(ctx, rt)
	if err != nil {
		if code := infraerrors.Code(err); code >= 400 && code < 500 {
			clearCookie()
		}
		response.ErrorFrom(g, err)
		return
	}
	claims, err := auth.ValidateToken(result.AccessToken)
	if err != nil || claims.SessionID == "" {
		response.ErrorFrom(g, errUnavailable)
		return
	}
	now := c.now()
	end := func(reason string, answer error) {
		if _, err := c.store.revoke(ctx, 0, 0, claims.SessionID, reason, now, c.revokedUntil(now)); err != nil && !errors.Is(err, errNoSession) {
			slog.Warn("claudex web: ending session failed", "error", err)
		}
		_ = auth.RevokeSessionFamily(ctx, claims.SessionID)
		clearCookie()
		response.ErrorFrom(g, answer)
	}
	sess, err := c.store.byFamily(ctx, claims.SessionID)
	if errors.Is(err, errNoSession) {
		// A console refresh token: never a web session.
		_ = auth.RevokeSessionFamily(ctx, claims.SessionID)
		clearCookie()
		response.ErrorFrom(g, errEnded)
		return
	}
	if err != nil {
		response.ErrorFrom(g, errUnavailable)
		return
	}
	if !sess.active(now) || sess.UserID != claims.UserID {
		end(RevokedUser, errEnded)
		return
	}
	if !c.setting.Cached(ctx).Enabled {
		response.ErrorFrom(g, errDisabled)
		return
	}
	var user *service.User
	if c.env.Users != nil {
		user, err = c.env.Users.GetByID(ctx, claims.UserID)
		if err != nil {
			response.ErrorFrom(g, errUnavailable)
			return
		}
	} else {
		user = &service.User{ID: claims.UserID, Email: claims.Email, Role: result.UserRole, Status: service.StatusActive}
	}
	if !c.allowed(ctx, user) {
		end(RevokedAdmin, errNotAllowed)
		return
	}
	if svc := c.env.SettingService; svc != nil && svc.IsBackendModeEnabled(ctx) && result.UserRole != service.RoleAdmin {
		response.Forbidden(g, "Backend mode is active. Only admin login is allowed.")
		return
	}
	ok, err := c.store.touch(ctx, sess.ID, now, now.Add(c.refreshTTL()), clip(middleware.SecurityClientIP(g), 64), clip(g.Request.UserAgent(), 256))
	if err != nil {
		response.ErrorFrom(g, errUnavailable)
		return
	}
	if !ok {
		end(RevokedUser, errEnded)
		return
	}
	// The account's own cookie; a bare cookie (or one under another
	// account's name) moves there.
	c.setAccountCookie(g, claims.UserID, result.RefreshToken)
	if name != webproto.AccountCookie(claims.UserID) {
		clearCookie()
	}
	g.Header("Cache-Control", "no-store")
	response.Success(g, SessionResponse{
		AccessToken: result.AccessToken,
		TokenType:   "Bearer",
		ExpiresIn:   result.ExpiresIn,
		SessionID:   sess.ID,
		User:        sessionUser(user),
	})
}

// POST auth/logout: ends the tab's session. Always succeeds and clears the
// cookie.
func (c *Component) logout(g *gin.Context) {
	ctx := g.Request.Context()
	auth := c.env.AuthService
	family := ""
	// The account the body names (its own cookie), else the bare cookie.
	name, rt := sessionCookie(g, requestedAccount(g), false)
	if auth != nil {
		if tok := bearer(g); tok != "" {
			// An expired access token still names its session.
			if claims, err := auth.ValidateToken(tok); claims != nil && (err == nil || errors.Is(err, service.ErrTokenExpired)) {
				family = claims.SessionID
			}
		}
		switch {
		case rt != "" && family == "":
			// "Remove {email} from this device" signs out an account the
			// tab does not show, without its access token: one last
			// rotation names the session, which then ends like any other.
			if result, err := auth.RefreshTokenPair(ctx, rt); err == nil {
				if claims, err := auth.ValidateToken(result.AccessToken); err == nil && claims.SessionID != "" {
					family = claims.SessionID
					_ = auth.RevokeSessionFamily(ctx, family)
				} else {
					_ = auth.RevokeRefreshToken(ctx, result.RefreshToken)
				}
			}
		case rt != "":
			if err := auth.RevokeRefreshToken(ctx, rt); err != nil {
				slog.Debug("claudex web: revoking refresh token failed", "error", err)
			}
		}
	}
	if family != "" && c.env.DB != nil {
		now := c.now()
		if _, err := c.store.revoke(ctx, 0, 0, family, RevokedLogout, now, c.revokedUntil(now)); err != nil && !errors.Is(err, errNoSession) {
			slog.Warn("claudex web: ending session failed", "error", err)
		} else if err == nil {
			_ = auth.RevokeSessionFamily(ctx, family)
		}
	}
	// Only this account's cookie: the browser's other accounts stay signed in.
	clearCookieNamed(g, name)
	response.Success(g, gin.H{"message": "Logged out successfully"})
}

// POST auth/revoke-all: the upstream "log out of all devices" plus every
// Claudex session (devices, web).
func (c *Component) revokeAll(g *gin.Context) {
	user, _, ok := c.bearerUser(g)
	if !ok {
		return
	}
	ctx := g.Request.Context()
	if err := c.env.AuthService.RevokeAllUserTokens(ctx, user.ID); err != nil {
		slog.Error("claudex web: revoke all failed", "user_id", user.ID, "error", err)
		response.InternalError(g, "Failed to revoke sessions")
		return
	}
	if err := claudexhook.SessionsRevoked(ctx, user.ID, "revoke_all"); err != nil {
		slog.Error("claudex web: revoking Claudex sessions failed", "user_id", user.ID, "error", err)
		response.InternalError(g, "Failed to revoke sessions")
		return
	}
	// This account's cookie; the bare one only in a browser that has no
	// account cookie for it (then the bare one was this account's).
	if _, own := browserAccounts(g.Request)[user.ID]; own {
		clearCookieNamed(g, webproto.AccountCookie(user.ID))
	} else {
		clearRefreshCookie(g)
	}
	response.Success(g, gin.H{"message": "All sessions have been revoked. Please log in again."})
}

// POST auth/events-ticket {tabId}: a one-time ticket for the event stream.
func (c *Component) eventsTicket(g *gin.Context) {
	user, _, ok := c.bearerUser(g)
	if !ok {
		return
	}
	ctx := g.Request.Context()
	if !c.allowed(ctx, user) {
		response.ErrorFrom(g, errNotAllowed)
		return
	}
	var req webproto.TicketRequest
	if err := g.ShouldBindJSON(&req); err != nil || !webproto.ValidTabID(req.TabID) {
		response.ErrorFrom(g, infraerrors.BadRequest(webproto.ErrCodeBadRequest, "tabId must be 8-64 letters, digits, '-' or '_'."))
		return
	}
	if h := g.GetHeader(webproto.HeaderTab); h != "" && h != req.TabID {
		response.ErrorFrom(g, infraerrors.BadRequest(webproto.ErrCodeBadRequest, "tabId does not match the tab header."))
		return
	}
	ticket, err := c.issueTicket(ctx, user.ID, req.TabID)
	if err != nil {
		slog.Error("claudex web: ticket failed", "error", err)
		response.ErrorFrom(g, errUnavailable)
		return
	}
	g.Header("Cache-Control", "no-store")
	response.Success(g, webproto.TicketResponse{Ticket: ticket, ExpiresIn: int(webproto.TicketTTL / time.Second)})
}

func bearer(g *gin.Context) string {
	parts := strings.SplitN(g.GetHeader("Authorization"), " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return ""
	}
	return strings.TrimSpace(parts[1])
}

// bearerUser runs the checks of the upstream JWT middleware (plus the H9b
// revocation check) for the auth routes that need a signed-in tab; they sit
// in the public group because they share the cookie path.
func (c *Component) bearerUser(g *gin.Context) (*service.User, *service.JWTClaims, bool) {
	auth, users := c.env.AuthService, c.env.Users
	if auth == nil || users == nil {
		response.ErrorFrom(g, errUnavailable)
		return nil, nil, false
	}
	header := g.GetHeader("Authorization")
	if header == "" {
		middleware.AbortWithError(g, http.StatusUnauthorized, "UNAUTHORIZED", "Authorization header is required")
		return nil, nil, false
	}
	parts := strings.SplitN(header, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		middleware.AbortWithError(g, http.StatusUnauthorized, "INVALID_AUTH_HEADER", "Authorization header format must be 'Bearer {token}'")
		return nil, nil, false
	}
	tok := strings.TrimSpace(parts[1])
	if tok == "" {
		middleware.AbortWithError(g, http.StatusUnauthorized, "EMPTY_TOKEN", "Token cannot be empty")
		return nil, nil, false
	}
	claims, err := auth.ValidateToken(tok)
	if err != nil {
		if errors.Is(err, service.ErrTokenExpired) {
			middleware.AbortWithError(g, http.StatusUnauthorized, "TOKEN_EXPIRED", "Token has expired")
		} else {
			middleware.AbortWithError(g, http.StatusUnauthorized, "INVALID_TOKEN", "Invalid token")
		}
		return nil, nil, false
	}
	user, err := users.GetByID(g.Request.Context(), claims.UserID)
	if err != nil {
		if errors.Is(err, service.ErrUserNotFound) {
			middleware.AbortWithError(g, http.StatusUnauthorized, "USER_NOT_FOUND", "User not found")
		} else {
			middleware.AbortWithError(g, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to load user")
		}
		return nil, nil, false
	}
	if !user.IsActive() {
		middleware.AbortWithError(g, http.StatusUnauthorized, "USER_INACTIVE", "User account is not active")
		return nil, nil, false
	}
	if claims.TokenVersion != user.TokenVersion {
		middleware.AbortWithError(g, http.StatusUnauthorized, "TOKEN_REVOKED", "Token has been revoked (password changed)")
		return nil, nil, false
	}
	var issuedAt time.Time
	if claims.IssuedAt != nil {
		issuedAt = claims.IssuedAt.Time
	}
	switch claudexhook.JWTRevoked(g.Request.Context(), claims.UserID, issuedAt, claims.SessionID) {
	case claudexhook.Revoked:
		middleware.AbortWithError(g, http.StatusUnauthorized, "CLAUDEX_SESSION_REVOKED", "This session was signed out. Sign in again.")
		return nil, nil, false
	case claudexhook.CheckFailed:
		middleware.AbortWithError(g, http.StatusServiceUnavailable, "CLAUDEX_SESSION_CHECK_FAILED", "Service temporarily unavailable. Try again.")
		return nil, nil, false
	}
	middleware.SetAuditActor(g, user.ID, user.Email)
	return user, claims, true
}
