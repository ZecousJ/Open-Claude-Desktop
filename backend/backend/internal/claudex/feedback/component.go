// Package feedback is the B8 component: diagnostics and reply feedback intake
// (design 2.9, owner decision 1).
//
// Nothing is collected by default: the administrator turns diagnostics and
// reply feedback on separately (setting claudex_feedback, PUT with step-up),
// the desktop app only reports after the user agreed ("consent": true), and a
// reply feedback keeps a conversation excerpt only when the administrator
// allows excerpts and the user attached one. The server redacts every
// free-text field again, keeps the report text out of the audit log and
// deletes rows older than the retention period every hour.
//
//   - user:  POST /api/v1/claudex/diagnostics, POST /api/v1/claudex/feedback
//   - admin: GET/PUT /api/v1/admin/claudex/feedback-settings,
//     GET /diagnostics, GET/DELETE /diagnostics/:id,
//     GET /feedback, GET/DELETE /feedback/:id
//   - bootstrap section "feedback"
package feedback

import (
	"context"
	"database/sql"
	"log/slog"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
)

// Retention job (design 2.9: hourly, batches of 1000).
const (
	retentionFirstRun  = time.Minute
	retentionInterval  = time.Hour
	retentionBatch     = 1000
	retentionMaxRounds = 1000 // at most a million rows per table and run
	retentionTimeout   = 10 * time.Minute
)

// Component is the B8 component.
type Component struct {
	env     *core.Env
	setting *core.JSONSetting[Settings]
	store   store
}

// New builds the component. It must not call its dependencies or env.Peers:
// ProvideModule binds the peers after every component is built, and tests
// pass empty Deps.
func New(env *core.Env) *Component {
	var repo service.SettingRepository
	var db *sql.DB
	if env != nil {
		repo, db = env.SettingRepo, env.DB
	}
	return &Component{
		env: env,
		setting: core.NewJSONSetting(repo, SettingKey, defaultSettings,
			core.WithNormalize(normalizeSettings), core.WithValidate(validateSettings)),
		store: &sqlStore{db: db},
	}
}

// Name implements core.Feature.
func (c *Component) Name() string { return core.NameFeedback }

// SettingKeys implements core.SettingsOwner.
func (c *Component) SettingKeys() []string { return []string{c.setting.Key()} }

// Settings returns the current settings (cached for 60 s).
func (c *Component) Settings(ctx context.Context) Settings { return c.setting.Cached(ctx) }

// RegisterUserRoutes implements core.UserRouter. The module keeps both bodies
// out of the audit log as well; the handlers skip the audit entry entirely.
func (c *Component) RegisterUserRoutes(g *gin.RouterGroup) {
	g.POST("/diagnostics", c.postDiagnostics)
	g.POST("/feedback", c.postFeedback)
	g.GET("/feedback/history", c.ownFeedbackHistory)
	g.DELETE("/feedback/history/:uuid", c.withdrawOwnFeedback)
}

// RegisterAdminRoutes implements core.AdminRouter. Turning collection or
// excerpts on relaxes privacy, so the settings PUT needs step-up.
func (c *Component) RegisterAdminRoutes(g *gin.RouterGroup, stepUp gin.HandlerFunc) {
	g.GET("/feedback-settings", c.getSettings)
	g.PUT("/feedback-settings", stepUp, c.putSettings)
	g.GET("/diagnostics", c.listDiagnostics)
	g.GET("/diagnostics/:id", c.getDiagnostic)
	g.DELETE("/diagnostics/:id", c.deleteDiagnostic)
	g.GET("/feedback", c.listFeedback)
	g.GET("/feedback/:id", c.getFeedback)
	g.DELETE("/feedback/:id", c.deleteFeedback)
}

// Sections implements core.BootstrapContributor.
func (c *Component) Sections() []string { return []string{core.SectionFeedback} }

// BootstrapSections implements core.BootstrapContributor:
//
//	"feedback": {"diagnostics":{"enabled":false},
//	             "feedback":{"enabled":false,"allow_conversation_excerpt":false}}
//
// allow_conversation_excerpt is only true while feedback is enabled. B9 sets
// features.diagnostics / features.feedback from the two enabled flags.
func (c *Component) BootstrapSections(ctx context.Context, _ *core.BootstrapContext) (map[string]any, error) {
	s := c.setting.Cached(ctx)
	return map[string]any{core.SectionFeedback: bootstrapSection(s)}, nil
}

func bootstrapSection(s Settings) map[string]any {
	return map[string]any{
		"diagnostics": map[string]any{"enabled": s.Diagnostics.Enabled},
		"feedback": map[string]any{
			"enabled":                    s.Feedback.Enabled,
			"allow_conversation_excerpt": s.Feedback.Enabled && s.Feedback.AllowConversationExcerpt,
		},
	}
}

// Start implements core.Starter: the hourly retention job.
func (c *Component) Start(ctx context.Context) {
	if c.env == nil || c.env.DB == nil {
		return
	}
	go c.retentionLoop(ctx)
}

func (c *Component) retentionLoop(ctx context.Context) {
	timer := time.NewTimer(retentionFirstRun)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		runCtx, cancel := context.WithTimeout(ctx, retentionTimeout)
		diagnostics, feedback, err := c.PurgeExpired(runCtx)
		cancel()
		if err != nil {
			slog.Warn("claudex feedback: retention cleanup failed", "error", err)
		} else if diagnostics+feedback > 0 {
			slog.Info("claudex feedback: retention cleanup", "diagnostics", diagnostics, "feedback", feedback)
		}
		timer.Reset(retentionInterval)
	}
}

// PurgeExpired deletes diagnostics and feedback older than their retention
// periods, in batches of 1000. It reads the settings from the database and
// deletes nothing when that fails (the cached fallback would be the default
// retention, possibly shorter than the configured one).
func (c *Component) PurgeExpired(ctx context.Context) (diagnostics, feedback int64, err error) {
	s, err := c.setting.Get(ctx)
	if err != nil {
		return 0, 0, err
	}
	now := c.now()
	diagnostics, err = c.purgeTable(ctx, tableDiagnostics, now.Add(-time.Duration(s.Diagnostics.RetentionDays)*24*time.Hour))
	if err != nil {
		return diagnostics, 0, err
	}
	feedback, err = c.purgeTable(ctx, tableFeedback, now.Add(-time.Duration(s.Feedback.RetentionDays)*24*time.Hour))
	return diagnostics, feedback, err
}

func (c *Component) purgeTable(ctx context.Context, table string, cutoff time.Time) (int64, error) {
	var total int64
	for round := 0; round < retentionMaxRounds; round++ {
		n, err := c.store.purge(ctx, table, cutoff, retentionBatch)
		total += n
		if err != nil {
			return total, err
		}
		if n < retentionBatch {
			break
		}
	}
	return total, nil
}

func (c *Component) now() time.Time {
	if c.env != nil && c.env.Now != nil {
		return c.env.Now()
	}
	return time.Now()
}

var (
	_ core.Feature              = (*Component)(nil)
	_ core.SettingsOwner        = (*Component)(nil)
	_ core.UserRouter           = (*Component)(nil)
	_ core.AdminRouter          = (*Component)(nil)
	_ core.BootstrapContributor = (*Component)(nil)
	_ core.Starter              = (*Component)(nil)
)
