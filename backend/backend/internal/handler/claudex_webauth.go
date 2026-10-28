package handler

// CLAUDEX: W-AUTH the web app sign-in (internal/claudex/web) runs the upstream
// login, 2FA, registration, password reset and passkey flows through this
// adapter. It calls the same *Core functions the upstream handlers call, so
// every upstream check (captcha, backend mode, TOTP, active user, passkey
// switch) applies unchanged; only the token answer differs (the web component
// puts the refresh token in its cookie).

import (
	"net/http"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
)

// badRequestError is the error form of response.BadRequest(c, msg): the
// envelope ErrorFrom writes for it is identical (code 400, empty reason).
func badRequestError(msg string) error {
	return infraerrors.New(http.StatusBadRequest, "", msg)
}

// internalError is the error form of response.InternalError(c, msg).
func internalError(msg string) error {
	return infraerrors.New(http.StatusInternalServerError, "", msg)
}

type claudexWebAuth struct {
	auth    *AuthHandler
	passkey *PasskeyHandler
}

// newClaudexWebAuth returns the adapter, nil without an auth handler.
func newClaudexWebAuth(auth *AuthHandler, passkey *PasskeyHandler) core.WebAuthBackend {
	if auth == nil {
		return nil
	}
	return &claudexWebAuth{auth: auth, passkey: passkey}
}

func (w *claudexWebAuth) Login(c *gin.Context) (*service.User, any, error) {
	user, challenge, err := w.auth.loginCore(c)
	if err != nil {
		return nil, nil, err
	}
	if challenge != nil {
		return nil, *challenge, nil
	}
	return user, nil, nil
}

func (w *claudexWebAuth) TwoFactor(c *gin.Context) (*service.User, error) {
	if w.auth.totpService == nil {
		return nil, badRequestError("Invalid or expired 2FA session")
	}
	req, session, user, err := w.auth.login2FAPrepare(c)
	if err != nil {
		return nil, err
	}
	if session.PendingOAuthBind != nil {
		// Binding a pending OAuth identity needs the upstream OAuth browser
		// cookies, which the web app never has: finish it on the console.
		return nil, infraerrors.BadRequest("CLAUDEX_WEB_OAUTH_BIND_UNSUPPORTED", "Finish linking this sign-in method on the account page.")
	}
	// Same order as Login2FA: delete the login session after every check.
	_ = w.auth.totpService.DeleteLoginSession(c.Request.Context(), req.TempToken)
	w.auth.authService.RecordSuccessfulLogin(c.Request.Context(), user.ID)
	return user, nil
}

type claudexCancel2FARequest struct {
	TempToken string `json:"temp_token" binding:"required"`
}

func (w *claudexWebAuth) CancelTwoFactor(c *gin.Context) error {
	var req claudexCancel2FARequest
	if err := c.ShouldBindJSON(&req); err != nil {
		return badRequestError("Invalid request: " + err.Error())
	}
	if w.auth.totpService == nil {
		return nil
	}
	return w.auth.totpService.DeleteLoginSession(c.Request.Context(), req.TempToken)
}

func (w *claudexWebAuth) Register(c *gin.Context) (*service.User, error) {
	return w.auth.registerCore(c)
}

func (w *claudexWebAuth) SendCode(c *gin.Context) (any, error) {
	resp, err := w.auth.sendVerifyCodeCore(c)
	if err != nil {
		return nil, err
	}
	return *resp, nil
}

func (w *claudexWebAuth) ForgotPassword(c *gin.Context) (any, error) {
	resp, err := w.auth.forgotPasswordCore(c)
	if err != nil {
		return nil, err
	}
	return *resp, nil
}

func (w *claudexWebAuth) ResetPassword(c *gin.Context) (any, error) {
	resp, err := w.auth.resetPasswordCore(c)
	if err != nil {
		return nil, err
	}
	return *resp, nil
}

func (w *claudexWebAuth) PasskeyBegin(c *gin.Context) (any, error) {
	if w.passkey == nil {
		return nil, service.ErrPasskeysDisabled
	}
	resp, err := w.passkey.beginLoginCore(c)
	if err != nil {
		return nil, err
	}
	return *resp, nil
}

func (w *claudexWebAuth) PasskeyFinish(c *gin.Context) (*service.User, error) {
	if w.passkey == nil {
		return nil, service.ErrPasskeysDisabled
	}
	return w.passkey.finishLoginCore(c)
}

// CodeLogin finishes the Claudex email code sign-in (LOGIN) with the checks
// loginCore runs after the password: active user, backend mode, TOTP
// challenge, recording the login.
func (w *claudexWebAuth) CodeLogin(c *gin.Context, user *service.User) (*service.User, any, error) {
	if err := ensureLoginUserActive(user); err != nil {
		return nil, nil, err
	}
	signedIn, challenge, err := w.auth.loginAfterFirstFactor(c, user)
	if err != nil {
		return nil, nil, err
	}
	if challenge != nil {
		return nil, *challenge, nil
	}
	return signedIn, nil, nil
}

// RespondLogin writes the POST /api/v1/auth/login success answer.
func (w *claudexWebAuth) RespondLogin(c *gin.Context, user *service.User) {
	w.auth.respondWithTokenPair(c, user)
}

// OAuthUser resolves a verified OAuth identity's account (LOGIN-GOOGLE).
func (w *claudexWebAuth) OAuthUser(c *gin.Context, identity service.EmailOAuthIdentityInput) (*service.User, error) {
	if w.auth.authService == nil {
		return nil, service.ErrServiceUnavailable
	}
	return w.auth.authService.ResolveVerifiedEmailOAuthUser(c.Request.Context(), identity)
}

var _ core.WebAuthBackend = (*claudexWebAuth)(nil)
