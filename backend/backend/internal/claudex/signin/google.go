package signin

// Signing in with Google (LOGIN-GOOGLE). Two ways in, one finish:
//
//   - the web app: Google Identity Services' button hands the page an ID
//     token for the web client, which it posts as {id_token};
//   - the desktop app: the system browser runs Google's authorization with
//     PKCE for the desktop client and returns a code to a loopback address;
//     the app posts {code, code_verifier, redirect_uri} and this server,
//     which alone holds the desktop client's secret, exchanges it for the
//     ID token.
//
// Either way the ID token is checked with Google (signature, issuer,
// audience, expiry) through its tokeninfo endpoint, the address must be
// verified, and the account is found or created by the upstream verified
// OAuth identity rules (registration switch, email policy, identity
// binding). The sign-in then finishes through core.WebAuth().CodeLogin, so
// TOTP, backend mode and the login record apply as for a password.
//
// The client ids and the desktop secret come from the environment
// (CLAUDEX_GOOGLE_WEB_CLIENT_ID, CLAUDEX_GOOGLE_WEB_CLIENT_SECRET,
// CLAUDEX_GOOGLE_DESKTOP_CLIENT_ID, CLAUDEX_GOOGLE_DESKTOP_CLIENT_SECRET);
// without a client id that way of signing in is off. The web app may also
// post {code, redirect_uri: "postmessage"} from Google's code client popup
// (the page's own button); that code is exchanged with the web secret.

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
)

// Error reasons of the Google sign-in.
const (
	ReasonGoogleDisabled    = "CLAUDEX_GOOGLE_DISABLED"
	ReasonGoogleInvalid     = "CLAUDEX_GOOGLE_INVALID"
	ReasonGoogleUnverified  = "CLAUDEX_GOOGLE_EMAIL_UNVERIFIED"
	ReasonGoogleUnavailable = "CLAUDEX_GOOGLE_UNAVAILABLE"
)

var (
	errGoogleDisabled    = infraerrors.Forbidden(ReasonGoogleDisabled, "Signing in with Google is not available on this server.")
	errGoogleInvalid     = infraerrors.BadRequest(ReasonGoogleInvalid, "Google couldn’t confirm this sign-in. Try again.")
	errGoogleUnverified  = infraerrors.Forbidden(ReasonGoogleUnverified, "This Google account’s email address isn’t verified.")
	errGoogleUnavailable = infraerrors.ServiceUnavailable(ReasonGoogleUnavailable, "Google can’t be reached right now. Try again.")
)

const (
	googleTokenInfoURL = "https://oauth2.googleapis.com/tokeninfo"
	googleTokenURL     = "https://oauth2.googleapis.com/token"
	googleTimeout      = 10 * time.Second
	googleMaxBody      = 64 << 10
)

// GoogleConfig is where the Google sign-in's clients come from.
type GoogleConfig struct {
	WebClientID         string
	WebClientSecret     string
	DesktopClientID     string
	DesktopClientSecret string
}

func googleConfigFromEnv() GoogleConfig {
	return GoogleConfig{
		WebClientID:         strings.TrimSpace(os.Getenv("CLAUDEX_GOOGLE_WEB_CLIENT_ID")),
		WebClientSecret:     strings.TrimSpace(os.Getenv("CLAUDEX_GOOGLE_WEB_CLIENT_SECRET")),
		DesktopClientID:     strings.TrimSpace(os.Getenv("CLAUDEX_GOOGLE_DESKTOP_CLIENT_ID")),
		DesktopClientSecret: strings.TrimSpace(os.Getenv("CLAUDEX_GOOGLE_DESKTOP_CLIENT_SECRET")),
	}
}

// desktopReady: the desktop flow needs both its id and its secret.
func (g GoogleConfig) desktopReady() bool {
	return g.DesktopClientID != "" && g.DesktopClientSecret != ""
}

// webCodeReady: the web code client needs the web id and its secret.
func (g GoogleConfig) webCodeReady() bool {
	return g.WebClientID != "" && g.WebClientSecret != ""
}

// googleWebRedirect is the redirect a code from Google's popup code client
// is exchanged with.
const googleWebRedirect = "postmessage"

// audiences are the client ids an ID token may be for.
func (g GoogleConfig) audiences() []string {
	var out []string
	if g.WebClientID != "" {
		out = append(out, g.WebClientID)
	}
	if g.desktopReady() {
		out = append(out, g.DesktopClientID)
	}
	return out
}

// GoogleClaims is what the sign-in reads from a checked ID token.
type GoogleClaims struct {
	Subject       string
	Email         string
	EmailVerified bool
	Name          string
	Picture       string
}

type googleRequest struct {
	IDToken      string `json:"id_token"`
	Code         string `json:"code"`
	CodeVerifier string `json:"code_verifier"`
	RedirectURI  string `json:"redirect_uri"`
}

var (
	// PKCE verifiers are 43–128 unreserved characters (RFC 7636).
	pkceVerifier = regexp.MustCompile(`^[A-Za-z0-9._~-]{43,128}$`)
	// The desktop app listens on a loopback address of its own choosing.
	loopbackRedirect = regexp.MustCompile(`^http://(127\.0\.0\.1|localhost|\[::1\]):[0-9]{1,5}(/[A-Za-z0-9/_-]*)?$`)
)

func (c *Component) google() GoogleConfig {
	if c.googleConfig != nil {
		return *c.googleConfig
	}
	return googleConfigFromEnv()
}

func (c *Component) httpClient() *http.Client {
	if c.googleHTTP != nil {
		return c.googleHTTP
	}
	return &http.Client{Timeout: googleTimeout}
}

// POST /api/v1/claudex/auth/google/login: the same answer as POST
// /api/v1/auth/login (token pair and user, or the TOTP challenge).
func (c *Component) postGoogleLogin(g *gin.Context) {
	b := c.auth()
	if b == nil {
		response.ErrorFrom(g, errGoogleUnavailable)
		return
	}
	user, err := c.VerifyGoogle(g)
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

// VerifyGoogle reads the request ({id_token}, or the desktop's {code,
// code_verifier, redirect_uri}), checks the ID token with Google and
// returns the account it signs in to; the caller runs CodeLogin.
func (c *Component) VerifyGoogle(g *gin.Context) (*service.User, error) {
	cfg := c.google()
	audiences := cfg.audiences()
	if len(audiences) == 0 {
		return nil, errGoogleDisabled
	}
	var req googleRequest
	body, err := io.ReadAll(http.MaxBytesReader(g.Writer, g.Request.Body, maxBodyBytes))
	if err != nil || json.Unmarshal(body, &req) != nil {
		return nil, errBadBody
	}
	ctx := g.Request.Context()
	token := strings.TrimSpace(req.IDToken)
	if token == "" && req.RedirectURI == googleWebRedirect {
		if !cfg.webCodeReady() {
			return nil, errGoogleDisabled
		}
		if req.Code == "" || len(req.Code) > 2048 {
			return nil, errGoogleInvalid
		}
		token, err = c.exchangeGoogleCode(ctx, cfg.WebClientID, cfg.WebClientSecret, req)
		if err != nil {
			return nil, err
		}
	}
	if token == "" {
		if !cfg.desktopReady() {
			return nil, errGoogleDisabled
		}
		if req.Code == "" || len(req.Code) > 2048 || !pkceVerifier.MatchString(req.CodeVerifier) ||
			!loopbackRedirect.MatchString(req.RedirectURI) {
			return nil, errGoogleInvalid
		}
		token, err = c.exchangeGoogleCode(ctx, cfg.DesktopClientID, cfg.DesktopClientSecret, req)
		if err != nil {
			return nil, err
		}
	}
	if len(token) > 8192 {
		return nil, errGoogleInvalid
	}
	claims, err := c.checkGoogleToken(ctx, token, audiences)
	if err != nil {
		return nil, err
	}
	if !claims.EmailVerified {
		return nil, errGoogleUnverified
	}
	b := c.auth()
	if b == nil {
		return nil, errGoogleUnavailable
	}
	return b.OAuthUser(g, service.EmailOAuthIdentityInput{
		ProviderType:    "google",
		ProviderKey:     "google",
		ProviderSubject: claims.Subject,
		Email:           claims.Email,
		EmailVerified:   true,
		DisplayName:     claims.Name,
		AvatarURL:       claims.Picture,
	})
}

// exchangeGoogleCode trades an authorization code (the desktop's, with its
// PKCE verifier, or the web popup's) for its ID token.
func (c *Component) exchangeGoogleCode(ctx context.Context, clientID, secret string, req googleRequest) (string, error) {
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {req.Code},
		"redirect_uri":  {req.RedirectURI},
		"client_id":     {clientID},
		"client_secret": {secret},
	}
	if req.CodeVerifier != "" {
		form.Set("code_verifier", req.CodeVerifier)
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, googleTokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", errGoogleUnavailable
	}
	httpReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := c.httpClient().Do(httpReq)
	if err != nil {
		slog.Warn("claudex signin: google token exchange failed", "error", err)
		return "", errGoogleUnavailable
	}
	defer func() { _ = res.Body.Close() }()
	data, _ := io.ReadAll(io.LimitReader(res.Body, googleMaxBody))
	if res.StatusCode >= 500 {
		return "", errGoogleUnavailable
	}
	var out struct {
		IDToken string `json:"id_token"`
	}
	if res.StatusCode != http.StatusOK || json.Unmarshal(data, &out) != nil || out.IDToken == "" {
		return "", errGoogleInvalid
	}
	return out.IDToken, nil
}

// checkGoogleToken asks Google whether the ID token is genuine, then checks
// it is for one of this server's clients, from Google, and not expired.
func (c *Component) checkGoogleToken(ctx context.Context, token string, audiences []string) (GoogleClaims, error) {
	form := url.Values{"id_token": {token}}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, googleTokenInfoURL, strings.NewReader(form.Encode()))
	if err != nil {
		return GoogleClaims{}, errGoogleUnavailable
	}
	httpReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := c.httpClient().Do(httpReq)
	if err != nil {
		slog.Warn("claudex signin: google tokeninfo failed", "error", err)
		return GoogleClaims{}, errGoogleUnavailable
	}
	defer func() { _ = res.Body.Close() }()
	data, _ := io.ReadAll(io.LimitReader(res.Body, googleMaxBody))
	if res.StatusCode >= 500 {
		return GoogleClaims{}, errGoogleUnavailable
	}
	if res.StatusCode != http.StatusOK {
		return GoogleClaims{}, errGoogleInvalid
	}
	var info struct {
		Aud           string `json:"aud"`
		Iss           string `json:"iss"`
		Exp           string `json:"exp"`
		Sub           string `json:"sub"`
		Email         string `json:"email"`
		EmailVerified string `json:"email_verified"`
		Name          string `json:"name"`
		Picture       string `json:"picture"`
	}
	if json.Unmarshal(data, &info) != nil {
		return GoogleClaims{}, errGoogleInvalid
	}
	known := false
	for _, aud := range audiences {
		if info.Aud == aud {
			known = true
		}
	}
	exp, _ := strconv.ParseInt(info.Exp, 10, 64)
	if !known || (info.Iss != "accounts.google.com" && info.Iss != "https://accounts.google.com") ||
		exp <= c.now().Unix() || strings.TrimSpace(info.Sub) == "" || strings.TrimSpace(info.Email) == "" {
		return GoogleClaims{}, errGoogleInvalid
	}
	return GoogleClaims{
		Subject:       info.Sub,
		Email:         strings.ToLower(strings.TrimSpace(info.Email)),
		EmailVerified: info.EmailVerified == "true",
		Name:          strings.TrimSpace(info.Name),
		Picture:       strings.TrimSpace(info.Picture),
	}, nil
}
