package claudex

import (
	"io"
	"net/http"
	"strings"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/geoip"
	"github.com/Wei-Shaw/sub2api/internal/claudex/release"
	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
	"github.com/Wei-Shaw/sub2api/internal/pkg/ip"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
)

// privateBodyRoutes are user routes whose request bodies never reach the
// audit log (diagnostics and feedback text, conversation excerpts, payment
// client secrets, share snapshots, memory text). The audit entry itself
// (who, when, which route, status) is still written, with an empty request
// body. Round 2 entries are listed before their components register the
// routes (B-S), so R1-B and R3-S1 need not edit this file.
var privateBodyRoutes = map[string]bool{
	http.MethodPost + " /api/v1/claudex/action-verification/confirm": true,
	http.MethodPost + " /api/v1/claudex/skills/scan":                 true,
	http.MethodPost + " /api/v1/claudex/directory/submissions":       true,
	http.MethodPut + " /api/v1/claudex/directory/submissions/:id":    true,
	http.MethodPost + " /api/v1/claudex/diagnostics":                 true,
	http.MethodPost + " /api/v1/claudex/feedback":                    true,
	http.MethodPost + " /api/v1/claudex/payment/checkout-links":      true,
	// R1 sharing: conversation and artifact snapshots.
	http.MethodPost + " /api/v1/claudex/shares":    true,
	http.MethodPut + " /api/v1/claudex/shares/:id": true,
	// Report chat: the reporter's name, e-mail and notes.
	http.MethodPost + " /api/v1/claudex/sharing/shared-with-me/:token/report":          true,
	http.MethodPost + " /api/v1/claudex/sharing/shared-with-me/:token/artifact-access": true,
	// R3 memory: memory documents and edits.
	http.MethodPut + " /api/v1/claudex/memory/docs/:scope": true,
	http.MethodPost + " /api/v1/claudex/memory/edits":      true,
	// Sign-up profile: the birthday.
	http.MethodPut + " /api/v1/claudex/account-profile": true,
	// First-run onboarding: the person's own "Other" answer.
	http.MethodPut + " /api/v1/claudex/onboarding": true,
	// Web app (webproto paths; W-SITE lists them before W-AUTH and W-HOST
	// register them): RPC arguments carry conversation text, uploads are user
	// files, the auth bodies carry passwords, 2FA codes and reset tokens.
	http.MethodPost + " " + webproto.PathRPC + ":method":                   true,
	http.MethodPost + " " + webproto.PathUploads:                           true,
	http.MethodPost + " " + webproto.PathAuth + webproto.AuthLogin:         true,
	http.MethodPost + " " + webproto.PathAuth + webproto.AuthTwoFactor:     true,
	http.MethodPost + " " + webproto.PathAuth + webproto.AuthRegister:      true,
	http.MethodPost + " " + webproto.PathAuth + webproto.AuthResetPassword: true,
}

// PagePrefix is the root path of the public Claudex pages (core.PageRouter;
// R1 hosted shares at /s/<token>). The embedded admin console never serves
// paths under it (internal/web shouldBypassEmbeddedFrontend).
const PagePrefix = "/s"

const ctxKeyPrivateBody = "claudex.private_body"

// hidePrivateBody runs just before the audit middleware and hands it an empty
// body for privateBodyRoutes; restorePrivateBody, right after it, puts the
// real body back for the handler.
func hidePrivateBody() gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request != nil && c.Request.Body != nil && privateBodyRoutes[c.Request.Method+" "+c.FullPath()] {
			c.Set(ctxKeyPrivateBody, c.Request.Body)
			c.Request.Body = http.NoBody
		}
		c.Next()
	}
}

func restorePrivateBody() gin.HandlerFunc {
	return func(c *gin.Context) {
		if v, ok := c.Get(ctxKeyPrivateBody); ok {
			if body, ok := v.(io.ReadCloser); ok {
				c.Request.Body = body
			}
		}
		c.Next()
	}
}

// RegisterRoutes adds the public and user routes under /api/v1/claudex. v1 is
// the /api/v1 group.
//
//   - public: panel per-IP rate limit, X-Claudex-* header validation;
//   - user: JWT (with the H9b revocation check), backend-mode guard, panel
//     rate limit, X-Claudex-* header validation, audit log (bodies of
//     privateBodyRoutes excluded) — the chain of the upstream /api/v1/user.
//
// Components must not register a top-level wildcard (/:id) because the two
// groups share the prefix, and must not register GET /release (the module
// owns it and merges core.ReleaseInfo into it).
func (m *Module) RegisterRoutes(
	v1 *gin.RouterGroup,
	jwtAuth middleware.JWTAuthMiddleware,
	auditLog middleware.AuditLogMiddleware,
	settingService *service.SettingService,
	panelRateLimiter *middleware.PanelRateLimiter,
) {
	if m == nil {
		return
	}

	public := v1.Group("/claudex")
	public.Use(panelRateLimiter.PublicIP())
	public.Use(core.ValidateClientHeaders())
	public.GET("/release", m.getRelease)
	for _, f := range m.features {
		if r, ok := f.(PublicRouter); ok {
			r.RegisterPublicRoutes(public)
		}
	}

	// Components reach the upstream "heavy" per-user limiter through env.Heavy().
	m.env.SetHeavy(panelRateLimiter.Heavy())

	user := v1.Group("/claudex")
	user.Use(gin.HandlerFunc(jwtAuth))
	user.Use(middleware.BackendModeUserGuard(settingService))
	user.Use(panelRateLimiter.Global())
	user.Use(core.ValidateClientHeaders())
	user.Use(hidePrivateBody())
	user.Use(gin.HandlerFunc(auditLog))
	user.Use(restorePrivateBody())
	user.Use(func(g *gin.Context) {
		if g.Request.Method == http.MethodDelete && g.FullPath() == "/api/v1/claudex/account" {
			m.ActionVerificationGuard("delete your account")(g)
		}
	})
	user.GET("/capabilities", m.getCapabilities)
	user.GET("/location", func(c *gin.Context) {
		c.Header("Cache-Control", "no-store")
		response.Success(c, geoip.Lookup(ip.GetClientIP(c)))
	})
	for _, f := range m.features {
		if r, ok := f.(UserRouter); ok {
			r.RegisterUserRoutes(user)
		}
	}
}

func (m *Module) ActionVerificationGuard(label string) gin.HandlerFunc {
	if m != nil {
		for _, feature := range m.features {
			if guard, ok := feature.(interface{ ActionVerificationGuard(string) gin.HandlerFunc }); ok {
				return guard.ActionVerificationGuard(label)
			}
		}
	}
	return func(g *gin.Context) { g.Next() }
}

// RegisterPageRoutes adds the public pages of every core.PageRouter under
// PagePrefix on the root router: per-IP panel rate limit only (no JWT, no
// audit log, no X-Claudex-* header check; visitors are browsers). A nil
// limiter (tests) means none.
func (m *Module) RegisterPageRoutes(r gin.IRouter, panelRateLimiter *middleware.PanelRateLimiter) {
	if m == nil {
		return
	}
	pages := r.Group(PagePrefix)
	pages.Use(panelRateLimiter.PublicIP())
	for _, f := range m.features {
		if p, ok := f.(PageRouter); ok {
			p.RegisterPageRoutes(pages)
		}
	}
}

// RegisterAdminRoutes adds the routes under /api/v1/admin/claudex. admin must
// be the upstream admin group, whose middleware (admin authentication, panel
// rate limit, audit log, AdminComplianceGuard) then applies to every route.
// stepUp is the upstream step-up middleware that components put in front of
// high-risk writes; nil (tests) means none.
func (m *Module) RegisterAdminRoutes(admin *gin.RouterGroup, stepUp gin.HandlerFunc) {
	if m == nil {
		return
	}
	if stepUp == nil {
		stepUp = func(c *gin.Context) { c.Next() }
	}
	g := admin.Group("/claudex")
	g.GET("/overview", m.getOverview)
	for _, f := range m.features {
		if r, ok := f.(AdminRouter); ok {
			r.RegisterAdminRoutes(g, stepUp)
		}
	}
}

// WebApp returns the component that switches the web app on or off and
// builds its public config (window.__CLAUDEX_WEB__), nil when no component
// implements core.WebAppConfig yet (the site then serves the web app with an
// empty config).
func (m *Module) WebApp() core.WebAppConfig {
	if m == nil {
		return nil
	}
	for _, f := range m.features {
		if w, ok := f.(core.WebAppConfig); ok {
			return w
		}
	}
	return nil
}

// ServerInfo describes the running server build.
type ServerInfo struct {
	Version   string `json:"version"`
	BuildType string `json:"build_type"`
}

// Capabilities is the answer of GET /api/v1/claudex/capabilities: the
// installed component names (troubleshooting and old-client probing; the
// desktop client decides features from bootstrap "features").
type Capabilities struct {
	APIVersion int      `json:"api_version"`
	Features   []string `json:"features"`
}

// UpstreamInfo identifies the Sub2API source the fork is based on.
type UpstreamInfo struct {
	Repository string `json:"repository"`
	Commit     string `json:"commit"`
}

// Overview is the answer of GET /api/v1/admin/claudex/overview.
type Overview struct {
	APIVersion         int           `json:"api_version"`
	Server             ServerInfo    `json:"server"`
	Upstream           UpstreamInfo  `json:"upstream"`
	SelfUpdateDisabled bool          `json:"self_update_disabled"`
	Features           []FeatureInfo `json:"features"`
}

func (m *Module) serverInfo() ServerInfo {
	return ServerInfo{Version: m.deps.BuildInfo.Version, BuildType: m.deps.BuildInfo.BuildType}
}

// releaseClient reads platform, arch and version for /claudex/release from
// the query (?platform=&arch=&version=&channel=) or the X-Claudex-* headers.
func releaseClient(c *gin.Context) (platform, arch, version string, err error) {
	h, err := core.ReadClientHeaders(c)
	if err != nil {
		return "", "", "", err
	}
	platform, arch, version = h.Platform, h.Arch, h.Version
	if v := strings.TrimSpace(c.Query("platform")); v != "" {
		if !core.ValidPlatform(v) {
			return "", "", "", core.InvalidClientHeader("platform")
		}
		platform = v
	}
	if v := strings.TrimSpace(c.Query("arch")); v != "" {
		if !core.ValidArch(v) {
			return "", "", "", core.InvalidClientHeader("arch")
		}
		arch = v
	}
	if v := strings.TrimSpace(c.Query("version")); v != "" {
		if !core.ValidVersion(v) {
			return "", "", "", core.InvalidClientHeader("version")
		}
		version = v
	}
	if v := strings.TrimSpace(c.Query("channel")); v != "" && v != "stable" {
		return "", "", "", core.InvalidClientHeader("channel")
	}
	// A Linux client names its package format; the download is that
	// format's ("linux-x64-deb"), the rest of the answer is the same.
	if v := strings.TrimSpace(c.Query("package")); v != "" {
		if platform != "linux" || !release.LinuxPackages[v] {
			return "", "", "", core.InvalidClientHeader("package")
		}
		if arch != "" {
			arch += "-" + v
		}
	}
	return platform, arch, version, nil
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// GET /api/v1/claudex/release (public). api_version and server come from the
// module; the client release fields come from core.ReleaseInfo (B1).
func (m *Module) getRelease(c *gin.Context) {
	platform, arch, version, err := releaseClient(c)
	if err != nil {
		response.ErrorFrom(c, err)
		return
	}
	channelUUID, maxVersion := c.Query("channelUuid"), c.Query("maxVersion")
	if channelUUID != "" && !core.ValidDeviceID(channelUUID) {
		response.ErrorFrom(c, core.InvalidClientHeader("channelUuid"))
		return
	}
	if maxVersion != "" && !core.ValidVersion(maxVersion) {
		response.ErrorFrom(c, core.InvalidClientHeader("maxVersion"))
		return
	}
	data := map[string]any{"api_version": APIVersion, "server": m.serverInfo()}
	if m.env != nil && m.env.Peers.Release != nil {
		ctx := release.WithUpdateRequest(c.Request.Context(), channelUUID, maxVersion)
		rs := m.env.Peers.Release.Evaluate(ctx, platform, arch, version)
		state := rs.State
		if state == "" {
			state = core.ReleaseStateUnknown
		}
		data["channel"] = nullable(rs.Channel)
		if rs.DesktopUpdaterConfig != nil {
			data["desktop_updater_config"] = rs.DesktopUpdaterConfig
		}
		data["latest_version"] = nullable(rs.LatestVersion)
		data["minimum_version"] = nullable(rs.MinimumVersion)
		data["state"] = state
		data["enforced"] = rs.Enforced
		data["download_url"] = nullable(rs.DownloadURL)
		data["sha256"] = nullable(rs.SHA256)
		data["release_notes_url"] = nullable(rs.ReleaseNotesURL)
		data["release_notes_md"] = nullable(rs.ReleaseNotesMD)
		if rs.PublishedAt != nil {
			data["published_at"] = rs.PublishedAt.UTC()
		} else {
			data["published_at"] = nil
		}
		data["ui"] = rs.UI
		if rs.AppPack != nil {
			data["app_pack"] = rs.AppPack
		}
	}
	c.Header("Cache-Control", "public, max-age=60")
	c.Header("Vary", "X-Claudex-Platform, X-Claudex-Arch, X-Claudex-Version")
	response.Success(c, data)
}

// GET /api/v1/claudex/capabilities
func (m *Module) getCapabilities(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	response.Success(c, Capabilities{APIVersion: APIVersion, Features: m.FeatureNames()})
}

// GET /api/v1/admin/claudex/overview
func (m *Module) getOverview(c *gin.Context) {
	response.Success(c, Overview{
		APIVersion:         APIVersion,
		Server:             m.serverInfo(),
		Upstream:           UpstreamInfo{Repository: UpstreamRepository, Commit: UpstreamCommit},
		SelfUpdateDisabled: m.deps.UpdateService.SelfUpdateDisabled(),
		Features:           m.featureInfos(),
	})
}
