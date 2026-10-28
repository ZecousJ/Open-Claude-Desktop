package core

import (
	"sync/atomic"

	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
)

// WebAuthBackend runs the upstream sign-in flows for the web app (W-AUTH)
// without writing a response: the web component calls it and then starts its
// own cookie session. The implementation lives in internal/handler (Claudex
// code must not import handler), where the upstream handlers call the same
// code, so captcha, backend mode, 2FA and every other upstream check stays in
// one place. Each method binds the request body itself; errors are
// ApplicationErrors carrying the status and message the upstream handler
// would answer with.
type WebAuthBackend interface {
	// Login checks email and password. It returns the user, or a non-nil
	// challenge (the upstream TOTP answer: requires_2fa, temp_token,
	// user_email_masked) when a second factor is needed.
	Login(c *gin.Context) (user *service.User, challenge any, err error)
	// TwoFactor completes a login with {temp_token, totp_code}.
	TwoFactor(c *gin.Context) (*service.User, error)
	// CancelTwoFactor drops the pending login session {temp_token}.
	CancelTwoFactor(c *gin.Context) error
	// Register creates an account (upstream registration and its checks).
	Register(c *gin.Context) (*service.User, error)
	// SendCode sends the registration verification code; the answer is the
	// upstream one ({message, countdown}).
	SendCode(c *gin.Context) (any, error)
	// ForgotPassword sends the reset link; the answer is the upstream one.
	ForgotPassword(c *gin.Context) (any, error)
	// ResetPassword sets a new password; the answer is the upstream one.
	ResetPassword(c *gin.Context) (any, error)
	// PasskeyBegin starts a passkey login ({session_token, options}).
	PasskeyBegin(c *gin.Context) (any, error)
	// PasskeyFinish completes a passkey login.
	PasskeyFinish(c *gin.Context) (*service.User, error)
	// CodeLogin finishes a sign-in whose first factor was checked by Claudex
	// (the email code of package signin): every upstream login check that is
	// not about the password (active user, backend mode, recording the login)
	// and the TOTP challenge, exactly as Login answers them.
	CodeLogin(c *gin.Context, user *service.User) (signedIn *service.User, challenge any, err error)
	// RespondLogin writes the upstream POST /api/v1/auth/login success answer
	// (token pair and user) for a user CodeLogin signed in.
	RespondLogin(c *gin.Context, user *service.User)
	// OAuthUser finds or creates the account of a verified OAuth identity
	// (the Claudex Google sign-in) with the upstream registration checks and
	// identity binding, without signing it in: CodeLogin does that.
	OAuthUser(c *gin.Context, identity service.EmailOAuthIdentityInput) (*service.User, error)
}

type webAuthHolder struct{ b WebAuthBackend }

var webAuth atomic.Pointer[webAuthHolder]

// SetWebAuthBackend installs the backend (handler.ProvideHandlers). nil
// removes it.
func SetWebAuthBackend(b WebAuthBackend) {
	if b == nil {
		webAuth.Store(nil)
		return
	}
	webAuth.Store(&webAuthHolder{b: b})
}

// WebAuth returns the installed backend, nil before the handlers are built
// (the web auth routes then answer 503).
func WebAuth() WebAuthBackend {
	if h := webAuth.Load(); h != nil {
		return h.b
	}
	return nil
}
