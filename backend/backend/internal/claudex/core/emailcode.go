package core

import (
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
)

// EmailLinkOriginKey carries the web host's CSRF-validated callback origin.
const EmailLinkOriginKey = "claudex.signin.callbackOrigin"

// EmailCodeSignIn is the email code sign-in (LOGIN; package signin). The web
// app's cookie session routes (package web) wrap it; they find it with
// FindEmailCodeSignIn instead of importing the component. Both methods bind
// the request body themselves and answer ApplicationErrors.
type EmailCodeSignIn interface {
	// SendEmailCode handles {email}: the same answer ({countdown}) whether or
	// not an account exists; mail only goes to an existing active account.
	SendEmailCode(c *gin.Context) (any, error)
	// VerifyEmailCode handles {email, code} and returns the account the code
	// was sent to. The code is spent; the caller still runs
	// WebAuthBackend.CodeLogin (active, backend mode, 2FA).
	VerifyEmailCode(c *gin.Context) (*service.User, error)
}

// FindEmailCodeSignIn returns the installed component that implements
// EmailCodeSignIn, nil when there is none.
func FindEmailCodeSignIn(env *Env) EmailCodeSignIn {
	if env == nil {
		return nil
	}
	for _, f := range env.Components {
		if s, ok := f.(EmailCodeSignIn); ok {
			return s
		}
	}
	return nil
}

// GoogleSignIn is the Claudex Google sign-in (package signin): it checks the
// Google ID token in the request and returns the account it signs in to.
// The caller still runs WebAuthBackend.CodeLogin.
type GoogleSignIn interface {
	VerifyGoogle(c *gin.Context) (*service.User, error)
}

// FindGoogleSignIn returns the installed component that implements
// GoogleSignIn, nil when there is none.
func FindGoogleSignIn(env *Env) GoogleSignIn {
	if env == nil {
		return nil
	}
	for _, f := range env.Components {
		if g, ok := f.(GoogleSignIn); ok {
			return g
		}
	}
	return nil
}
