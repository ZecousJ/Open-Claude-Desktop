// Package web is the web app's server side (W-AUTH): web sign-in sessions,
// the site switch and the public config the web app index gets.
//
// Sign-in runs the upstream flows through core.WebAuth() (captcha, backend
// mode, 2FA, passkeys stay upstream code). The component adds the browser
// session around them: the refresh token lives in an HttpOnly cookie scoped
// to the auth routes, the access token only in the tab's memory, every
// session is a row of claudex_web_sessions (per-user cap, list, sign-out),
// and the event stream is opened with a one-time ticket.
package web

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
)

const (
	// defaultRefreshTTL is the upstream default of jwt.refresh_token_expire_days.
	defaultRefreshTTL = 30 * 24 * time.Hour
	// revokedMargin keeps a revoked family in claudex_revoked_sessions a bit
	// past the last access token it could have minted.
	revokedMargin = time.Hour
	// keepEnded is how long ended sessions stay listed for audits.
	keepEnded       = 30 * 24 * time.Hour
	cleanupInterval = time.Hour
)

// Component is the web component.
type Component struct {
	env     *core.Env
	setting *core.JSONSetting[Settings]
	store   *store
	tickets ticketStore

	// backend is the upstream auth adapter; nil means core.WebAuth().
	backend core.WebAuthBackend
	// emailCodes is the email code sign-in; nil means the installed
	// core.EmailCodeSignIn component.
	emailCodes core.EmailCodeSignIn

	cleanupOnce sync.Once
}

// New builds the component. It must not call its dependencies.
func New(env *core.Env) *Component {
	if env == nil {
		env = &core.Env{}
	}
	c := &Component{env: env, setting: newSetting(env)}
	c.store = &store{db: env.DB}
	c.tickets = newTicketStore(env)
	return c
}

// Name implements core.Feature.
func (c *Component) Name() string { return core.NameWeb }

// SettingKeys implements core.SettingsOwner.
func (c *Component) SettingKeys() []string { return []string{c.setting.Key()} }

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

// refreshTTL is the upstream refresh-token lifetime: the cookie Max-Age and
// the session row expiry.
func (c *Component) refreshTTL() time.Duration {
	if cfg := c.env.Config; cfg != nil && cfg.JWT.RefreshTokenExpireDays > 0 {
		return time.Duration(cfg.JWT.RefreshTokenExpireDays) * 24 * time.Hour
	}
	return defaultRefreshTTL
}

// revokedUntil is how long a revoked family must stay in
// claudex_revoked_sessions.
func (c *Component) revokedUntil(now time.Time) time.Time {
	return now.Add(c.refreshTTL() + revokedMargin)
}

// RegisterPublicRoutes implements core.PublicRouter: the sign-in routes
// (no JWT, no audit log, so passwords and codes never reach the log).
func (c *Component) RegisterPublicRoutes(g *gin.RouterGroup) {
	c.registerAuthRoutes(g.Group("/web/auth"))
}

// RegisterUserRoutes implements core.UserRouter.
func (c *Component) RegisterUserRoutes(g *gin.RouterGroup) {
	// Native clients use the existing /api/v1/auth bearer-token flow. This
	// ticket route is in the JWT user group, not the browser cookie group:
	// it must not weaken csrf or expose a cookie-authenticated alias.
	// eventsTicket rechecks JWT validity, active user, revocation, web
	// availability and allowlist before issuing the same one-use ticket.
	g.POST("/mobile/events-ticket", c.requireEnabled, c.limit(webproto.AuthEventsTicket), c.eventsTicket)
	g.GET("/web/session", c.requireEnabled, c.getSession)
	g.GET("/web/sessions", c.requireEnabled, c.listSessions)
	g.DELETE("/web/sessions/:id", c.requireEnabled, c.deleteSession)
	// The phone apps' sign-ins (native.go): listed whether or not the web
	// app is on, like the desktop's devices.
	g.GET("/native-sessions", c.listNativeSessions)
	g.DELETE("/native-sessions/:id", c.deleteNativeSession)
}

// RegisterAdminRoutes implements core.AdminRouter; PUT needs step-up.
func (c *Component) RegisterAdminRoutes(g *gin.RouterGroup, stepUp gin.HandlerFunc) {
	g.GET("/web/settings", c.adminGet)
	if stepUp != nil {
		g.PUT("/web/settings", stepUp, c.adminPut)
	} else {
		g.PUT("/web/settings", c.adminPut)
	}
}

// Start implements core.Starter: hourly cleanup of old session rows.
func (c *Component) Start(ctx context.Context) {
	if c.env.DB == nil {
		return
	}
	c.cleanupOnce.Do(func() {
		go c.loop(ctx, 10*time.Minute, cleanupInterval, func(ctx context.Context) {
			if n, err := c.store.cleanup(ctx, c.now(), keepEnded); err != nil {
				slog.Error("claudex web: cleaning old sessions failed", "error", err)
			} else if n > 0 {
				slog.Info("claudex web: removed old sessions", "count", n)
			}
			if n, err := c.store.cleanupNative(ctx, c.now(), keepEnded); err != nil {
				slog.Error("claudex web: cleaning old app sessions failed", "error", err)
			} else if n > 0 {
				slog.Info("claudex web: removed old app sessions", "count", n)
			}
		})
	})
}

func (c *Component) loop(ctx context.Context, first, every time.Duration, run func(context.Context)) {
	timer := time.NewTimer(first)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		func() {
			defer func() {
				if r := recover(); r != nil {
					slog.Error("claudex web: background job panicked", "panic", r)
				}
			}()
			jobCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
			defer cancel()
			run(jobCtx)
		}()
		timer.Reset(every)
	}
}

// OnSessionsRevoked implements core.SessionRevoker ("log out of all
// devices"): every web session of the user ends. The upstream revoke-all
// already deleted the refresh tokens; this ends the rows and records the
// families so their access tokens stop at once.
func (c *Component) OnSessionsRevoked(ctx context.Context, userID int64, reason string) error {
	if c.env.DB == nil || userID <= 0 {
		return nil
	}
	now := c.now()
	families, err := c.store.revokeAll(ctx, userID, RevokedRevokeAll, now, c.revokedUntil(now))
	if err != nil {
		return err
	}
	c.dropFamilies(ctx, families)
	return c.store.revokeAllNative(ctx, userID, now)
}

// dropFamilies deletes the refresh tokens of ended sessions (best effort:
// the session row and claudex_revoked_sessions already refuse them).
func (c *Component) dropFamilies(ctx context.Context, families []string) {
	if c.env.AuthService == nil {
		return
	}
	for _, f := range families {
		if err := c.env.AuthService.RevokeSessionFamily(ctx, f); err != nil {
			slog.Warn("claudex web: revoking refresh tokens failed", "error", err)
		}
	}
}

// WebAppEnabled implements core.WebAppConfig (cached setting).
func (c *Component) WebAppEnabled(ctx context.Context) bool {
	return c.setting.Cached(ctx).Enabled
}

// Captcha settings the sign-in pages need.
type turnstileConfig struct {
	Enabled bool   `json:"enabled"`
	SiteKey string `json:"site_key"`
}

type tencentCaptchaConfig struct {
	Enabled bool   `json:"enabled"`
	AppID   string `json:"app_id"`
	Region  string `json:"region"`
}

type aliyunCaptchaConfig struct {
	Enabled bool   `json:"enabled"`
	SceneID string `json:"scene_id"`
	Prefix  string `json:"prefix"`
	Region  string `json:"region"`
}

// PublicConfig is window.__CLAUDEX_WEB__: only what the pages need before
// sign-in (no allowlist, no session cap).
type PublicConfig struct {
	Enabled                          bool                 `json:"enabled"`
	SiteName                         string               `json:"site_name"`
	SiteLogo                         string               `json:"site_logo"`
	BackendModeEnabled               bool                 `json:"backend_mode_enabled"`
	RegistrationEnabled              bool                 `json:"registration_enabled"`
	EmailVerifyEnabled               bool                 `json:"email_verify_enabled"`
	RegistrationEmailSuffixWhitelist []string             `json:"registration_email_suffix_whitelist"`
	InvitationCodeEnabled            bool                 `json:"invitation_code_enabled"`
	PromoCodeEnabled                 bool                 `json:"promo_code_enabled"`
	PasswordResetEnabled             bool                 `json:"password_reset_enabled"`
	TotpEnabled                      bool                 `json:"totp_enabled"`
	PasskeyEnabled                   bool                 `json:"passkey_enabled"`
	Turnstile                        turnstileConfig      `json:"turnstile"`
	TencentCaptcha                   tencentCaptchaConfig `json:"tencent_captcha"`
	AliyunCaptcha                    aliyunCaptchaConfig  `json:"aliyun_captcha"`
}

// WebAppPublicConfig implements core.WebAppConfig.
func (c *Component) WebAppPublicConfig(ctx context.Context) (any, error) {
	out := PublicConfig{
		Enabled:                          c.setting.Cached(ctx).Enabled,
		RegistrationEmailSuffixWhitelist: []string{},
	}
	svc := c.env.SettingService
	if svc == nil {
		return out, nil
	}
	ps, err := svc.GetPublicSettings(ctx)
	if err != nil {
		return nil, err
	}
	fillPublicConfig(&out, ps, svc.IsBackendModeEnabled(ctx))
	return out, nil
}

func fillPublicConfig(out *PublicConfig, ps *service.PublicSettings, backendMode bool) {
	if ps == nil {
		return
	}
	out.SiteName, out.SiteLogo = ps.SiteName, ps.SiteLogo
	out.BackendModeEnabled = backendMode
	// Backend mode blocks registration and the self-service flows.
	out.RegistrationEnabled = ps.RegistrationEnabled && !backendMode
	out.EmailVerifyEnabled = ps.EmailVerifyEnabled
	if ps.RegistrationEmailSuffixWhitelist != nil {
		out.RegistrationEmailSuffixWhitelist = ps.RegistrationEmailSuffixWhitelist
	}
	out.InvitationCodeEnabled = ps.InvitationCodeEnabled
	out.PromoCodeEnabled = ps.PromoCodeEnabled
	out.PasswordResetEnabled = ps.PasswordResetEnabled && !backendMode
	out.TotpEnabled = ps.TotpEnabled
	out.PasskeyEnabled = ps.PasskeyEnabled
	out.Turnstile = turnstileConfig{Enabled: ps.TurnstileEnabled, SiteKey: ps.TurnstileSiteKey}
	out.TencentCaptcha = tencentCaptchaConfig{Enabled: ps.TencentCaptchaEnabled, AppID: ps.TencentCaptchaAppID, Region: ps.TencentCaptchaRegion}
	out.AliyunCaptcha = aliyunCaptchaConfig{Enabled: ps.AliyunCaptchaEnabled, SceneID: ps.AliyunCaptchaSceneID, Prefix: ps.AliyunCaptchaPrefix, Region: ps.AliyunCaptchaRegion}
}

var (
	_ core.Feature        = (*Component)(nil)
	_ core.PublicRouter   = (*Component)(nil)
	_ core.UserRouter     = (*Component)(nil)
	_ core.AdminRouter    = (*Component)(nil)
	_ core.SettingsOwner  = (*Component)(nil)
	_ core.Starter        = (*Component)(nil)
	_ core.SessionRevoker = (*Component)(nil)
	_ core.WebAppConfig   = (*Component)(nil)
)
