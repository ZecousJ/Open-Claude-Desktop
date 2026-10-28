package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"

	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/ip"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	middleware2 "github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
)

type PasskeyHandler struct {
	passkeys    *service.PasskeyService
	authService *service.AuthService
	settingSvc  *service.SettingService
}

func NewPasskeyHandler(
	passkeys *service.PasskeyService,
	authService *service.AuthService,
	settingService *service.SettingService,
) *PasskeyHandler {
	return &PasskeyHandler{
		passkeys:    passkeys,
		authService: authService,
		settingSvc:  settingService,
	}
}

type passkeyOptionsResponse struct {
	SessionToken string `json:"session_token"`
	Options      any    `json:"options"`
}

type passkeyFinishRequest struct {
	SessionToken string          `json:"session_token" binding:"required"`
	Name         string          `json:"name,omitempty"`
	Credential   json.RawMessage `json:"credential" binding:"required"`
}

type passkeyBeginLoginRequest struct {
	// TurnstileToken 承载阿里云验证码的 captchaVerifyParam（复用既有请求字段名）
	TurnstileToken        string `json:"turnstile_token"`
	TencentCaptchaTicket  string `json:"tencent_captcha_ticket"`
	TencentCaptchaRandstr string `json:"tencent_captcha_randstr"`
}

type passkeyRenameRequest struct {
	Name string `json:"name" binding:"required"`
}

// passkeyPasswordRequest carries the account password that gates passkey
// enrollment and revocation. Binding errors are tolerated: a missing or
// malformed body yields an empty password, which the service rejects with a
// precise PASSWORD_REQUIRED error.
type passkeyPasswordRequest struct {
	Password string `json:"password"`
}

func bindPasskeyPassword(c *gin.Context) string {
	var req passkeyPasswordRequest
	_ = c.ShouldBindJSON(&req)
	return req.Password
}

const passkeyFinishBodyMaxBytes = 64 * 1024

// BeginLogin starts a usernameless, discoverable-credential login ceremony.
func (h *PasskeyHandler) BeginLogin(c *gin.Context) {
	// CLAUDEX: W-AUTH the body moved to beginLoginCore, shared with the web app.
	resp, err := h.beginLoginCore(c)
	if err != nil {
		response.ErrorFrom(c, err)
		return
	}
	response.Success(c, *resp)
}

// beginLoginCore is BeginLogin without writing the response.
// CLAUDEX: W-AUTH extracted from BeginLogin unchanged.
func (h *PasskeyHandler) beginLoginCore(c *gin.Context) (*passkeyOptionsResponse, error) {
	if err := h.passkeysEnabledError(c.Request.Context()); err != nil {
		return nil, err
	}
	var req passkeyBeginLoginRequest
	_ = c.ShouldBindJSON(&req)
	if err := h.authService.VerifyActionCaptchaIfEnabled(c.Request.Context(), service.CaptchaProof{
		TurnstileToken: req.TurnstileToken,
		TencentTicket:  req.TencentCaptchaTicket,
		TencentRandstr: req.TencentCaptchaRandstr,
	}, ip.GetClientIP(c)); err != nil {
		return nil, err
	}
	assertion, token, err := h.passkeys.BeginLogin(c.Request.Context())
	if err != nil {
		return nil, err
	}
	return &passkeyOptionsResponse{SessionToken: token, Options: assertion}, nil
}

// FinishLogin validates a passkey assertion and creates a normal Sub2API token
// session. User verification is mandatory, so a successful passkey assertion
// already supplies phishing-resistant multi-factor authentication and does not
// enter the separate TOTP challenge flow.
func (h *PasskeyHandler) FinishLogin(c *gin.Context) {
	// CLAUDEX: W-AUTH the checks moved to finishLoginCore, shared with the web app.
	user, err := h.finishLoginCore(c)
	if err != nil {
		response.ErrorFrom(c, err)
		return
	}
	respondWithTokenPair(c, h.authService, user)
}

// finishLoginCore validates the assertion and returns the user (successful
// login recorded).
// CLAUDEX: W-AUTH extracted from FinishLogin unchanged.
func (h *PasskeyHandler) finishLoginCore(c *gin.Context) (*service.User, error) {
	if err := h.passkeysEnabledError(c.Request.Context()); err != nil {
		return nil, err
	}
	req, err := bindPasskeyFinishRequestCore(c)
	if err != nil {
		return nil, err
	}
	credentialRequest := cloneRequestWithJSON(c.Request, req.Credential)
	user, err := h.passkeys.FinishLogin(c.Request.Context(), req.SessionToken, credentialRequest)
	if err != nil {
		return nil, err
	}
	if err = h.ensureBackendModeAllowsUser(c.Request.Context(), user); err != nil {
		return nil, err
	}
	middleware2.SetAuditActor(c, user.ID, user.Email)
	c.Set("auth_method", service.AuditAuthMethodPasskey)
	h.authService.RecordSuccessfulLogin(c.Request.Context(), user.ID)
	return user, nil
}

func (h *PasskeyHandler) BeginRegistration(c *gin.Context) {
	if !h.requirePasskeysEnabled(c) {
		return
	}
	subject, ok := middleware2.GetAuthSubjectFromContext(c)
	if !ok {
		response.Unauthorized(c, "User not authenticated")
		return
	}
	creation, token, err := h.passkeys.BeginRegistration(c.Request.Context(), subject.UserID, bindPasskeyPassword(c))
	if err != nil {
		response.ErrorFrom(c, err)
		return
	}
	response.Success(c, passkeyOptionsResponse{SessionToken: token, Options: creation})
}

func (h *PasskeyHandler) FinishRegistration(c *gin.Context) {
	if !h.requirePasskeysEnabled(c) {
		return
	}
	subject, ok := middleware2.GetAuthSubjectFromContext(c)
	if !ok {
		response.Unauthorized(c, "User not authenticated")
		return
	}
	req, valid := bindPasskeyFinishRequest(c)
	if !valid {
		return
	}
	credentialRequest := cloneRequestWithJSON(c.Request, req.Credential)
	credential, err := h.passkeys.FinishRegistration(
		c.Request.Context(),
		subject.UserID,
		req.SessionToken,
		req.Name,
		credentialRequest,
	)
	if err != nil {
		response.ErrorFrom(c, err)
		return
	}
	response.Success(c, credential)
}

func (h *PasskeyHandler) List(c *gin.Context) {
	subject, ok := middleware2.GetAuthSubjectFromContext(c)
	if !ok {
		response.Unauthorized(c, "User not authenticated")
		return
	}
	credentials, err := h.passkeys.List(c.Request.Context(), subject.UserID)
	if err != nil {
		response.ErrorFrom(c, err)
		return
	}
	response.Success(c, credentials)
}

func (h *PasskeyHandler) Rename(c *gin.Context) {
	subject, credentialID, ok := passkeyMutationTarget(c)
	if !ok {
		return
	}
	var req passkeyRenameRequest
	if err := c.ShouldBindJSON(&req); err != nil || strings.TrimSpace(req.Name) == "" {
		response.BadRequest(c, "Passkey name is required")
		return
	}
	if err := h.passkeys.Rename(c.Request.Context(), subject.UserID, credentialID, req.Name); err != nil {
		response.ErrorFrom(c, err)
		return
	}
	response.Success(c, gin.H{"success": true})
}

func (h *PasskeyHandler) Delete(c *gin.Context) {
	subject, credentialID, ok := passkeyMutationTarget(c)
	if !ok {
		return
	}
	if err := h.passkeys.Delete(c.Request.Context(), subject.UserID, credentialID, bindPasskeyPassword(c)); err != nil {
		response.ErrorFrom(c, err)
		return
	}
	response.Success(c, gin.H{"success": true})
}

func (h *PasskeyHandler) requirePasskeysEnabled(c *gin.Context) bool {
	// CLAUDEX: W-AUTH the check moved to passkeysEnabledError, shared with the web app.
	if err := h.passkeysEnabledError(c.Request.Context()); err != nil {
		response.ErrorFrom(c, err)
		return false
	}
	return true
}

// passkeysEnabledError is requirePasskeysEnabled without writing the response.
// CLAUDEX: W-AUTH extracted from requirePasskeysEnabled unchanged.
func (h *PasskeyHandler) passkeysEnabledError(ctx context.Context) error {
	if h.settingSvc == nil {
		return service.ErrPasskeysDisabled
	}
	enabled, err := h.settingSvc.PasskeyEnabled(ctx)
	if err != nil {
		return err
	}
	if !enabled {
		return service.ErrPasskeysDisabled
	}
	return nil
}

func (h *PasskeyHandler) ensureBackendModeAllowsUser(ctx context.Context, user *service.User) error {
	if err := ensureLoginUserActive(user); err != nil {
		return err
	}
	if h.settingSvc == nil || !h.settingSvc.IsBackendModeEnabled(ctx) || user.IsAdmin() {
		return nil
	}
	return infraerrors.Forbidden("BACKEND_MODE_ADMIN_ONLY", "Backend mode is active. Only admin login is allowed.")
}

func bindPasskeyFinishRequest(c *gin.Context) (*passkeyFinishRequest, bool) {
	// CLAUDEX: W-AUTH the binding moved to bindPasskeyFinishRequestCore, shared with the web app.
	req, err := bindPasskeyFinishRequestCore(c)
	if err != nil {
		response.ErrorFrom(c, err)
		return nil, false
	}
	return req, true
}

// bindPasskeyFinishRequestCore is bindPasskeyFinishRequest without writing
// the response.
// CLAUDEX: W-AUTH extracted from bindPasskeyFinishRequest unchanged.
func bindPasskeyFinishRequestCore(c *gin.Context) (*passkeyFinishRequest, error) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, passkeyFinishBodyMaxBytes)
	var req passkeyFinishRequest
	if err := c.ShouldBindJSON(&req); err != nil || len(req.Credential) == 0 {
		return nil, badRequestError("Invalid passkey response")
	}
	return &req, nil
}

func cloneRequestWithJSON(original *http.Request, payload []byte) *http.Request {
	request := original.Clone(original.Context())
	request.Body = io.NopCloser(bytes.NewReader(payload))
	request.ContentLength = int64(len(payload))
	request.Header = original.Header.Clone()
	request.Header.Set("Content-Type", "application/json")
	return request
}

func passkeyMutationTarget(c *gin.Context) (middleware2.AuthSubject, int64, bool) {
	subject, ok := middleware2.GetAuthSubjectFromContext(c)
	if !ok {
		response.Unauthorized(c, "User not authenticated")
		return middleware2.AuthSubject{}, 0, false
	}
	credentialID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || credentialID <= 0 {
		response.BadRequest(c, "Invalid passkey ID")
		return middleware2.AuthSubject{}, 0, false
	}
	return subject, credentialID, true
}
