// Package signin is the Claudex sign-in extension (package LOGIN): the
// options the sign-in page needs before a user signs in, and signing in with
// a one-time code sent by email, which Sub2API does not have.
//
// The code only replaces the password: the rest of the sign-in runs the
// upstream checks through core.WebAuth().CodeLogin (active user, backend
// mode, TOTP challenge, recording the login), and the desktop route answers
// exactly like POST /api/v1/auth/login. The web app wraps the same flow in
// its cookie session (package web, core.EmailCodeSignIn).
package signin

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"log/slog"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	ratelimit "github.com/Wei-Shaw/sub2api/internal/middleware"

	"github.com/gin-gonic/gin"
)

// Per-IP limits per minute (fail closed on Redis errors).
const (
	sendPerIPPerMinute  = 5
	loginPerIPPerMinute = 20
)

// optionsTTL is how long this node reuses the public options answer.
const optionsTTL = 5 * time.Second

// Component is the sign-in component.
type Component struct {
	env     *core.Env
	setting *core.JSONSetting[Settings]

	codeKey []byte
	options atomic.Pointer[optionsEntry]

	// Test hooks: nil means the real implementation.
	backend   core.WebAuthBackend
	smtpReady func(ctx context.Context) bool
	backendOn func(ctx context.Context) bool
	sendMail  func(ctx context.Context, to, subject, body string) error
	async     func(func())
	// Google sign-in hooks: nil reads the environment and calls Google.
	googleConfig *GoogleConfig
	googleHTTP   *http.Client
}

type optionsEntry struct {
	value     Options
	expiresAt time.Time
}

// New builds the component. It must not call its dependencies.
func New(env *core.Env) *Component {
	if env == nil {
		env = &core.Env{}
	}
	c := &Component{
		env: env,
		setting: core.NewJSONSetting(env.SettingRepo, SettingKey, defaultSettings,
			core.WithNormalize(normalizeSettings), core.WithValidate(validateSettings)),
	}
	c.codeKey = deriveCodeKey(env)
	return c
}

// deriveCodeKey returns the HMAC key for the stored codes: derived from the
// JWT secret so every node of a cluster agrees, or random for this process
// when there is none (tests).
func deriveCodeKey(env *core.Env) []byte {
	if env != nil && env.Config != nil && strings.TrimSpace(env.Config.JWT.Secret) != "" {
		sum := sha256.Sum256([]byte("claudex-signin-email-code\x00" + env.Config.JWT.Secret))
		return sum[:]
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		panic("claudex signin: no randomness: " + err.Error())
	}
	return key
}

// Name implements core.Feature.
func (c *Component) Name() string { return core.NameSignIn }

// SettingKeys implements core.SettingsOwner.
func (c *Component) SettingKeys() []string { return []string{SettingKey} }

// RegisterPublicRoutes implements core.PublicRouter (no JWT, no audit log:
// the bodies carry addresses and codes).
func (c *Component) RegisterPublicRoutes(g *gin.RouterGroup) {
	g.GET("/sign-in/options", c.getOptions)
	g.POST("/auth/email-code/send", c.limit("claudex-email-code-send", sendPerIPPerMinute), c.postSend)
	g.POST("/auth/email-code/login", c.limit("claudex-email-code-login", loginPerIPPerMinute), c.postLogin)
	g.POST("/auth/google/login", c.limit("claudex-google-login", loginPerIPPerMinute), c.postGoogleLogin)
}

// RegisterAdminRoutes implements core.AdminRouter; PUT needs step-up.
func (c *Component) RegisterAdminRoutes(g *gin.RouterGroup, stepUp gin.HandlerFunc) {
	if stepUp == nil {
		stepUp = func(g *gin.Context) { g.Next() }
	}
	g.GET("/sign-in", c.adminGet)
	g.PUT("/sign-in", stepUp, c.adminPut)
}

// limit is a per-IP limit that fails closed on Redis errors, like the
// upstream /api/v1/auth routes. Without Redis (tests) it passes.
func (c *Component) limit(key string, n int) gin.HandlerFunc {
	if c.env.Redis == nil {
		return func(g *gin.Context) { g.Next() }
	}
	return ratelimit.NewRateLimiter(c.env.Redis).LimitWithOptions(key, n, time.Minute,
		ratelimit.RateLimitOptions{FailureMode: ratelimit.RateLimitFailClose})
}

func (c *Component) now() time.Time {
	if c.env.Now != nil {
		return c.env.Now()
	}
	return time.Now()
}

func (c *Component) auth() core.WebAuthBackend {
	if c.backend != nil {
		return c.backend
	}
	return core.WebAuth()
}

func (c *Component) codes() *codeStore {
	if c.env.Redis == nil {
		return nil
	}
	return &codeStore{rdb: c.env.Redis, key: c.codeKey}
}

// smtpConfigured tells whether the upstream SMTP settings have a host (what
// the upstream email service needs to send).
func (c *Component) smtpConfigured(ctx context.Context) bool {
	if c.smtpReady != nil {
		return c.smtpReady(ctx)
	}
	if c.env.Email == nil {
		return false
	}
	cfg, err := c.env.Email.GetSMTPConfig(ctx)
	return err == nil && cfg != nil && strings.TrimSpace(cfg.Host) != ""
}

func (c *Component) backendMode(ctx context.Context) bool {
	if c.backendOn != nil {
		return c.backendOn(ctx)
	}
	return c.env.SettingService != nil && c.env.SettingService.IsBackendModeEnabled(ctx)
}

// emailCodeAvailable: the admin switch is on, SMTP is configured and
// backend mode is off.
func (c *Component) emailCodeAvailable(ctx context.Context) bool {
	return c.setting.Cached(ctx).EmailCodeLoginEnabled && c.smtpConfigured(ctx) && !c.backendMode(ctx)
}

func (c *Component) siteName(ctx context.Context) string {
	if c.env.SettingService != nil {
		if name := strings.TrimSpace(c.env.SettingService.GetSiteName(ctx)); name != "" {
			return name
		}
	}
	return "Claudex"
}

// siteURL is the service's address, for the mail's logo ("" without one).
func (c *Component) siteURL(ctx context.Context) string {
	if c.env == nil {
		return ""
	}
	base := ""
	if c.env.SettingService != nil {
		base = c.env.SettingService.GetFrontendURL(ctx)
	}
	if base == "" && c.env.Config != nil {
		base = c.env.Config.Server.FrontendURL
	}
	return strings.TrimRight(strings.TrimSpace(base), "/")
}

func (c *Component) mail(ctx context.Context, to, subject, body string) error {
	if c.sendMail != nil {
		return c.sendMail(ctx, to, subject, body)
	}
	if c.env.Email == nil {
		return errMailUnavailable
	}
	return c.env.Email.SendEmail(ctx, to, subject, body)
}

// goAsync runs fn in the background, so the answer takes the same time
// whether or not a mail is sent.
func (c *Component) goAsync(fn func()) {
	if c.async != nil {
		c.async(fn)
		return
	}
	go func() {
		defer func() {
			if r := recover(); r != nil {
				slog.Error("claudex signin: background send panicked", "panic", r)
			}
		}()
		fn()
	}()
}

var (
	_ core.EmailCodeSignIn = (*Component)(nil)
	_ core.GoogleSignIn    = (*Component)(nil)
)
