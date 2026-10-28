// Package sharing is the R1 component: hosted shares of conversations and
// artifacts, served as public read-only pages at /s/<token> (round 2, owner
// decision R1; design R1).
//
// Sharing is off until an administrator turns it on (setting
// claudex_sharing, PUT with step-up). A share is a snapshot the desktop app
// builds (prompts, reply text, artifacts; never tool commands or output),
// validated and stored in claudex_share_contents; the link is a 256-bit
// capability token. Public links are built when read from the administrator's
// public base URL (then the upstream frontend URL, then a path the client
// completes), never hard-coded or stored. Visitors need no account; they can
// report a share, and reports go to the administrator's queue.
//
// Routes (design R1 3.4):
//   - page (core.PageRouter, root group /s): GET /s/:token, GET /s/:token/a/:n,
//     GET /s/:token/raw/:n, GET /s/:token/embed, POST /s/:token/report,
//     GET /s/_assets/*path
//     (HTML drawn by the Renderer that sharing/viewer registers);
//   - public JSON: POST /api/v1/claudex/shared/:token/reports;
//   - user: GET /sharing/status, POST/GET /shares, GET/PUT/DELETE /shares/:id
//     (snapshot bodies stay out of the audit log, see routes.go),
//     POST /sharing/artifact-reports (the app's Report artifact),
//     GET/PUT /shares/:id/embed (Get embed code's allowed domains);
//   - admin: /api/v1/admin/claudex/sharing/* (settings, shares, content,
//     take-down, reports, artifact reports, per-user blocks).
package sharing

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
)

// Cleanup job: expired shares and shares of deleted accounts are revoked
// (content deleted) every hour, in batches.
const (
	cleanupFirstRun  = 2 * time.Minute
	cleanupInterval  = time.Hour
	cleanupBatch     = 500
	cleanupMaxRounds = 200
	cleanupTimeout   = 10 * time.Minute
)

// Component is the R1 component.
type Component struct {
	env      *core.Env
	setting  *core.JSONSetting[Settings]
	store    store
	upstream upstreamValues
	// artifactReports keeps Report artifact (the same database as store).
	artifactReports artifactReportStore
	// embeds keeps Get embed code's allowed domains (the same database).
	embeds       embedStore
	codeSettings codeSettingsStore
	// mailPrefs keeps which artifact e-mails each account wants.
	mailPrefs mailPrefStore
	// mailer sends an invitation e-mail; nil uses the upstream SMTP service.
	mailer func(ctx context.Context, to, subject, body string) error
	// ipKey keys the HMAC of visitor addresses (report duplicates, view
	// counting): derived from the server's JWT secret so every node agrees,
	// random when there is none.
	ipKeyOnce sync.Once
	ipKey     [32]byte
}

// New builds the component. Like every component it must not call its
// dependencies or env.Peers here (tests pass empty Deps).
func New(env *core.Env) *Component {
	var repo service.SettingRepository
	var db *sql.DB
	if env != nil {
		repo, db = env.SettingRepo, env.DB
	}
	sqls := &sqlStore{db: db}
	c := &Component{
		env: env,
		setting: core.NewJSONSetting(repo, SettingKey, defaultSettings,
			core.WithNormalize(normalizeSettings), core.WithValidate(validateSettings)),
		store:           sqls,
		artifactReports: sqls,
		embeds:          sqls,
		codeSettings:    sqls,
		mailPrefs:       sqls,
	}
	return c
}

// Name implements core.Feature.
func (c *Component) Name() string { return core.NameSharing }

// SettingKeys implements core.SettingsOwner.
func (c *Component) SettingKeys() []string { return []string{c.setting.Key()} }

// Settings returns the current settings (cached for 60 s).
func (c *Component) Settings(ctx context.Context) Settings { return c.setting.Cached(ctx) }

// RegisterUserRoutes implements core.UserRouter.
func (c *Component) RegisterUserRoutes(g *gin.RouterGroup) {
	g.GET("/sharing/status", c.getStatus)
	g.GET("/sharing/code-settings", c.getCodeSettings)
	g.PATCH("/sharing/code-settings", c.patchCodeSettings)
	g.GET("/sharing/mail-preferences", c.getMailPreferences)
	g.PATCH("/sharing/mail-preferences", c.patchMailPreferences)
	g.GET("/shares", c.listShares)
	g.POST("/shares", c.env.Heavy(), c.createShare)
	g.GET("/shares/:id", c.getShare)
	g.PUT("/shares/:id", c.env.Heavy(), c.updateShare)
	g.DELETE("/shares/:id", c.deleteShare)
	g.PUT("/shares/:id/access", c.putAccess)
	g.POST("/shares/:id/invites", c.postInvite)
	g.DELETE("/shares/:id/invites", c.deleteInvite)
	g.GET("/shares/:id/embed", c.getEmbed)
	g.PUT("/shares/:id/embed", c.putEmbed)
	g.GET("/sharing/shared-with-me", c.listSharedWithMe)
	g.GET("/sharing/shared-with-me/:token", c.env.Heavy(), c.getSharedWithMe)
	g.PUT("/sharing/shared-with-me/:token/artifact", c.env.Heavy(), c.putSharedArtifact)
	g.POST("/sharing/shared-with-me/:token/artifact-access", c.env.Heavy(), c.postArtifactEditAccess)
	g.POST("/sharing/shared-with-me/:token/report", c.postSharedWithMeReport)
	g.POST("/sharing/artifact-reports", c.env.Heavy(), c.postArtifactReport)
}

// RegisterPublicRoutes implements core.PublicRouter (anonymous reports).
func (c *Component) RegisterPublicRoutes(g *gin.RouterGroup) {
	g.POST("/shared/:token/reports", c.postReportJSON)
}

// RegisterPageRoutes implements core.PageRouter.
func (c *Component) RegisterPageRoutes(g *gin.RouterGroup) {
	g.GET("/:token", c.getPage)
	g.GET("/:token/screenshot", c.getScreenshot)
	g.GET("/:token/a/:n", c.getArtifact)
	g.GET("/:token/raw/:n", c.getRaw)
	g.GET("/:token/embed", c.getEmbedPage)
	g.POST("/:token/report", c.postReportForm)
	g.GET("/_assets/*path", c.getAsset)
}

// RegisterAdminRoutes implements core.AdminRouter. Writes that publish,
// unpublish or delete content, change the settings or block a user need
// step-up.
func (c *Component) RegisterAdminRoutes(g *gin.RouterGroup, stepUp gin.HandlerFunc) {
	a := g.Group("/sharing")
	a.GET("/settings", c.adminGetSettings)
	a.PUT("/settings", stepUp, c.adminPutSettings)
	a.GET("/shares", c.adminListShares)
	a.GET("/shares/:id", c.adminGetShare)
	a.GET("/shares/:id/content", c.adminGetContent)
	a.GET("/shares/:id/preview", c.adminPreview)
	a.POST("/shares/:id/disable", stepUp, c.adminDisable)
	a.POST("/shares/:id/enable", stepUp, c.adminEnable)
	a.DELETE("/shares/:id", stepUp, c.adminDelete)
	a.GET("/reports", c.adminListReports)
	a.POST("/reports/:id/resolve", stepUp, c.adminResolveReport)
	a.GET("/artifact-reports", c.adminListArtifactReports)
	a.GET("/artifact-reports/:id", c.adminGetArtifactReport)
	a.POST("/artifact-reports/:id/resolve", stepUp, c.adminResolveArtifactReport)
	a.GET("/blocks", c.adminListBlocks)
	a.PUT("/blocks/:user_id", stepUp, c.adminPutBlock)
	a.DELETE("/blocks/:user_id", stepUp, c.adminDeleteBlock)
	a.POST("/users/:user_id/disable-all", stepUp, c.adminDisableAll)
}

// Start implements core.Starter: the hourly cleanup job.
func (c *Component) Start(ctx context.Context) {
	if c.env == nil || c.env.DB == nil {
		return
	}
	go c.cleanupLoop(ctx)
}

func (c *Component) cleanupLoop(ctx context.Context) {
	timer := time.NewTimer(cleanupFirstRun)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		runCtx, cancel := context.WithTimeout(ctx, cleanupTimeout)
		expired, orphaned, err := c.Cleanup(runCtx)
		cancel()
		if err != nil {
			slog.Warn("claudex sharing: cleanup failed", "error", err)
		} else if expired+orphaned > 0 {
			slog.Info("claudex sharing: cleanup", "expired", expired, "deleted_authors", orphaned)
		}
		timer.Reset(cleanupInterval)
	}
}

// Cleanup revokes (and deletes the content of) expired shares and shares
// whose author's account was deleted.
func (c *Component) Cleanup(ctx context.Context) (expired, orphaned int64, err error) {
	now := c.now()
	if expired, err = drain(ctx, func() (int64, error) { return c.store.purgeExpired(ctx, now, cleanupBatch) }); err != nil {
		return expired, 0, err
	}
	orphaned, err = drain(ctx, func() (int64, error) { return c.store.purgeDeletedAuthors(ctx, now, cleanupBatch) })
	return expired, orphaned, err
}

func drain(ctx context.Context, step func() (int64, error)) (int64, error) {
	var total int64
	for round := 0; round < cleanupMaxRounds; round++ {
		if err := ctx.Err(); err != nil {
			return total, err
		}
		n, err := step()
		total += n
		if err != nil {
			return total, err
		}
		if n < cleanupBatch {
			break
		}
	}
	return total, nil
}

func (c *Component) now() time.Time {
	if c.env != nil && c.env.Now != nil {
		return c.env.Now().UTC()
	}
	return time.Now().UTC()
}

// hasDB reports whether shares can be stored at all.
func (c *Component) hasDB() bool {
	if s, ok := c.store.(*sqlStore); ok {
		return s != nil && s.db != nil
	}
	return c.store != nil
}

// visitorHash is an HMAC of the visitor address with a per-day key, so it
// matches within a day and cannot be reversed or linked across days.
func (c *Component) visitorHash(ip string, now time.Time) string {
	if ip == "" {
		return ""
	}
	c.ipKeyOnce.Do(func() {
		if c.env != nil && c.env.Config != nil && c.env.Config.JWT.Secret != "" {
			c.ipKey = sha256.Sum256([]byte("claudex-sharing-visitor:" + c.env.Config.JWT.Secret))
			return
		}
		_, _ = rand.Read(c.ipKey[:])
	})
	mac := hmac.New(sha256.New, c.ipKey[:])
	_, _ = mac.Write([]byte(now.UTC().Format("2006-01-02") + "|" + ip))
	return hex.EncodeToString(mac.Sum(nil))
}

func isNotFound(err error) bool { return errors.Is(err, service.ErrSettingNotFound) }

var (
	_ core.Feature       = (*Component)(nil)
	_ core.SettingsOwner = (*Component)(nil)
	_ core.UserRouter    = (*Component)(nil)
	_ core.PublicRouter  = (*Component)(nil)
	_ core.PageRouter    = (*Component)(nil)
	_ core.AdminRouter   = (*Component)(nil)
	_ core.Starter       = (*Component)(nil)
)
