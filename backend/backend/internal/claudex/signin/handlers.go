package signin

import (
	"context"
	"encoding/json"
	"errors"
	"html"
	"io"
	"log/slog"
	"net/http"
	"net/mail"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
)

// Error reasons.
const (
	ReasonDisabled    = "CLAUDEX_EMAIL_CODE_DISABLED"
	ReasonInvalid     = "CLAUDEX_EMAIL_CODE_INVALID"
	ReasonAlreadyUsed = "CLAUDEX_EMAIL_CODE_ALREADY_USED"
	ReasonTooFrequent = "CLAUDEX_EMAIL_CODE_TOO_FREQUENT"
	ReasonUnavailable = "CLAUDEX_EMAIL_CODE_UNAVAILABLE"
	ReasonBadRequest  = "CLAUDEX_EMAIL_CODE_BAD_REQUEST"
)

var (
	// ErrDisabled: the admin switch is off, SMTP is not configured or
	// backend mode is on.
	ErrDisabled = infraerrors.Forbidden(ReasonDisabled, "Signing in with an email code is not available on this server.")
	// ErrInvalid: wrong, expired or voided code.
	ErrInvalid     = infraerrors.BadRequest(ReasonInvalid, "That code is incorrect or has expired.")
	ErrAlreadyUsed = infraerrors.BadRequest(ReasonAlreadyUsed, "Code already used. Refresh the page and try again.")
	// ErrUnavailable: Redis (or the sign-in backend) is not reachable.
	ErrUnavailable = infraerrors.ServiceUnavailable(ReasonUnavailable, "Signing in with an email code is temporarily unavailable. Try again.")
	errBadEmail    = infraerrors.BadRequest(ReasonBadRequest, "Enter a valid email address.")
	errBadBody     = infraerrors.BadRequest(ReasonBadRequest, "The request body must be a JSON object.")

	errMailUnavailable = errors.New("claudex signin: no email service")
)

const (
	maxBodyBytes   = 4 << 10
	maxEmailBytes  = 254
	mailSendBudget = 60 * time.Second
)

// Options answers GET /api/v1/claudex/sign-in/options.
type Options struct {
	EmailCodeLogin   bool    `json:"email_code_login"`
	PrivacyPolicyURL *string `json:"privacy_policy_url"`
	// The Google clients the sign-in page may offer (LOGIN-GOOGLE): the web
	// button's and the desktop's; absent when that way is off.
	GoogleClientID        string `json:"google_client_id,omitempty"`
	GoogleDesktopClientID string `json:"google_desktop_client_id,omitempty"`
}

// SendResponse answers a send.
type SendResponse struct {
	Countdown int `json:"countdown"`
}

type codeRequest struct {
	Email         string `json:"email"`
	Code          string `json:"code"`
	RequestID     string `json:"request_id"`
	RequestSecret string `json:"request_secret"`
	Desktop       bool   `json:"desktop"`
	Link          bool   `json:"link"`
}

// GET /api/v1/claudex/sign-in/options (public, cached 5 s on this node).
func (c *Component) getOptions(g *gin.Context) {
	now := c.now()
	if e := c.options.Load(); e != nil && now.Before(e.expiresAt) {
		writeOptions(g, e.value)
		return
	}
	ctx := g.Request.Context()
	s := c.setting.Cached(ctx)
	out := Options{EmailCodeLogin: c.emailCodeAvailable(ctx)}
	if google := c.google(); !c.backendMode(ctx) {
		// The web app's button runs Google's code client, which needs the
		// web secret here to exchange its code.
		if google.webCodeReady() {
			out.GoogleClientID = google.WebClientID
		}
		if google.desktopReady() {
			out.GoogleDesktopClientID = google.DesktopClientID
		}
	}
	if s.PrivacyPolicyURL != "" {
		u := s.PrivacyPolicyURL
		out.PrivacyPolicyURL = &u
	}
	c.options.Store(&optionsEntry{value: out, expiresAt: now.Add(optionsTTL)})
	writeOptions(g, out)
}

func writeOptions(g *gin.Context, out Options) {
	g.Header("Cache-Control", "public, max-age=5")
	response.Success(g, out)
}

// readRequest binds {email, code} (at most 4 KiB) and normalizes the address.
func readRequest(g *gin.Context) (codeRequest, error) {
	var req codeRequest
	body, err := io.ReadAll(http.MaxBytesReader(g.Writer, g.Request.Body, maxBodyBytes))
	if err != nil {
		return req, errBadBody
	}
	if err := json.Unmarshal(body, &req); err != nil {
		return req, errBadBody
	}
	email, ok := normalizeEmail(req.Email)
	if !ok {
		return req, errBadEmail
	}
	req.Email = email
	req.Code = strings.TrimSpace(req.Code)
	if (req.RequestID != "" || req.RequestSecret != "" || req.Link) &&
		(!validRequestKey(req.RequestID) || !validRequestKey(req.RequestSecret)) {
		return req, errBadBody
	}
	return req, nil
}

func validRequestKey(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, char := range value {
		if (char < '0' || char > '9') && (char < 'a' || char > 'f') {
			return false
		}
	}
	return true
}

// normalizeEmail trims and lowercases a bare address ("a@b.c", no display
// name), at most 254 bytes.
func normalizeEmail(raw string) (string, bool) {
	s := strings.ToLower(strings.TrimSpace(raw))
	if s == "" || len(s) > maxEmailBytes {
		return "", false
	}
	addr, err := mail.ParseAddress(s)
	if err != nil || addr.Name != "" || addr.Address != s {
		return "", false
	}
	return s, true
}

// POST /api/v1/claudex/auth/email-code/send {email}
func (c *Component) postSend(g *gin.Context) {
	out, err := c.SendEmailCode(g)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	g.Header("Cache-Control", "no-store")
	response.Success(g, out)
}

// SendEmailCode implements core.EmailCodeSignIn.
func (c *Component) SendEmailCode(g *gin.Context) (any, error) {
	ctx := g.Request.Context()
	if !c.emailCodeAvailable(ctx) {
		return nil, ErrDisabled
	}
	req, err := readRequest(g)
	if err != nil {
		return nil, err
	}
	store := c.codes()
	if store == nil || c.env.UserRepo == nil {
		return nil, ErrUnavailable
	}
	id := store.id(req.Email)
	wait, err := store.reserveSend(ctx, id)
	if err != nil {
		slog.Error("claudex signin: send limit check failed", "error", err)
		return nil, ErrUnavailable
	}
	if wait > 0 {
		return nil, tooFrequent(g, wait)
	}
	// From here on the answer is the same whether or not the address has an
	// account; failures are only logged.
	user, err := c.env.UserRepo.GetByEmail(ctx, req.Email)
	if err != nil {
		if !errors.Is(err, service.ErrUserNotFound) {
			slog.Error("claudex signin: user lookup failed", "error", err)
		}
		return SendResponse{Countdown: int(sendCooldown / time.Second)}, nil
	}
	if user == nil || !user.IsActive() {
		return SendResponse{Countdown: int(sendCooldown / time.Second)}, nil
	}
	code, err := newCode()
	if err != nil {
		slog.Error("claudex signin: code generation failed", "error", err)
		return SendResponse{Countdown: int(sendCooldown / time.Second)}, nil
	}
	binding := ""
	if req.RequestID != "" {
		binding = store.mac("link", req.Email, req.RequestID, req.RequestSecret)
	}
	if err := store.save(ctx, id, store.codeHash(req.Email, code), user.ID, binding); err != nil {
		slog.Error("claudex signin: storing code failed", "user_id", user.ID, "error", err)
		return SendResponse{Countdown: int(sendCooldown / time.Second)}, nil
	}
	to := strings.TrimSpace(user.Email)
	link := ""
	if binding != "" {
		base := c.siteURL(ctx)
		if base == "" {
			base = g.GetString(core.EmailLinkOriginKey)
		}
		if req.Desktop {
			base = "claudex://sign-in"
		} else if base != "" {
			base += "/sign-in/callback"
		}
		if base != "" {
			link = base + "#" + url.Values{"email": {req.Email}, "request_id": {req.RequestID}, "code": {code}}.Encode()
		}
	}
	subject, body := codeEmail(c.siteName(ctx), c.siteURL(ctx), code, link)
	userID := user.ID
	mailCtx := context.WithoutCancel(ctx)
	c.goAsync(func() {
		sendCtx, cancel := context.WithTimeout(mailCtx, mailSendBudget)
		defer cancel()
		if err := c.mail(sendCtx, to, subject, body); err != nil {
			slog.Error("claudex signin: sending code failed", "user_id", userID, "error", err)
		}
	})
	return SendResponse{Countdown: int(sendCooldown / time.Second)}, nil
}

func tooFrequent(g *gin.Context, wait time.Duration) error {
	seconds := int64((wait + time.Second - 1) / time.Second)
	if seconds < 1 {
		seconds = 1
	}
	s := strconv.FormatInt(seconds, 10)
	g.Header("Retry-After", s)
	return infraerrors.TooManyRequests(ReasonTooFrequent, "Wait "+s+" seconds before asking for another code.").
		WithMetadata(map[string]string{"retry_after_seconds": s})
}

// codeEmail is the mail with the code, in the Claudex email layout, Chinese
// with the English under it (the upstream mailer sends HTML, so the text is
// escaped).
func codeEmail(site, siteURL, code string, links ...string) (subject, body string) {
	subject = "Your " + site + " sign-in code"
	linkHTML := ""
	if len(links) > 0 && links[0] != "" {
		linkHTML = `<p><a href="` + html.EscapeString(links[0]) + `">登录 / Sign in</a></p>`
	}
	body = service.ClaudexEmailHTML(service.ClaudexEmailLayout{
		SiteName: html.EscapeString(site),
		SiteURL:  html.EscapeString(siteURL),
		Title:    "登录验证码 / Sign-in code",
		Content: linkHTML + `<p>使用下面的验证码登录 ` + html.EscapeString(site) + `：<br><span style="color:#6b6a65;">Use this code to sign in to ` + html.EscapeString(site) + `:</span></p>
` + service.ClaudexEmailCode(code) + `
<p>验证码 10 分钟内有效。<br><span style="color:#6b6a65;">It expires in 10 minutes.</span></p>
<p class="muted" style="color:#6b6a65;font-size:13px;line-height:20px;">如果不是你本人在登录，可以忽略这封邮件。If you did not try to sign in, you can ignore this email.</p>`,
	})
	return subject, body
}

// POST /api/v1/claudex/auth/email-code/login {email, code}: the same answer
// as POST /api/v1/auth/login (token pair and user, or the TOTP challenge).
func (c *Component) postLogin(g *gin.Context) {
	b := c.auth()
	if b == nil {
		response.ErrorFrom(g, ErrUnavailable)
		return
	}
	user, err := c.VerifyEmailCode(g)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	signedIn, challenge, err := b.CodeLogin(g, user)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	g.Header("Cache-Control", "no-store")
	if challenge != nil {
		response.Success(g, challenge)
		return
	}
	b.RespondLogin(g, signedIn)
}

// VerifyEmailCode implements core.EmailCodeSignIn.
func (c *Component) VerifyEmailCode(g *gin.Context) (*service.User, error) {
	ctx := g.Request.Context()
	// Codes already sent stay usable while SMTP or backend mode change; the
	// backend mode check runs in CodeLogin (admins only).
	if !c.setting.Cached(ctx).EmailCodeLoginEnabled {
		return nil, ErrDisabled
	}
	req, err := readRequest(g)
	if err != nil {
		return nil, err
	}
	if !validCode(req.Code) {
		return nil, ErrInvalid
	}
	store := c.codes()
	if store == nil || c.env.UserRepo == nil {
		return nil, ErrUnavailable
	}
	proof := ""
	if req.Link {
		proof = store.mac("link", req.Email, req.RequestID, req.RequestSecret)
	}
	userID, err := store.verify(ctx, req.Email, req.Code, proof)
	if errors.Is(err, errUsedCode) {
		return nil, ErrAlreadyUsed
	}
	if errors.Is(err, errNoCode) {
		return nil, ErrInvalid
	}
	if err != nil {
		slog.Error("claudex signin: code check failed", "error", err)
		return nil, ErrUnavailable
	}
	user, err := c.env.UserRepo.GetByID(ctx, userID)
	if errors.Is(err, service.ErrUserNotFound) {
		return nil, ErrInvalid
	}
	if err != nil {
		slog.Error("claudex signin: user lookup failed", "user_id", userID, "error", err)
		return nil, ErrUnavailable
	}
	if user == nil || !strings.EqualFold(strings.TrimSpace(user.Email), req.Email) {
		// The account changed its address after the code was sent.
		return nil, ErrInvalid
	}
	return user, nil
}
