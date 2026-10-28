// Package announce is the announcements component: pop-up notices the
// Claudex apps show once to every signed-in user, and e-mail notices sent to
// chosen users.
//
// An administrator writes an announcement in the console (badge, title, an
// HTML body with its own styles, an optional picture and button) and
// publishes it for a while (a day, a week, …). Until it expires the apps
// fetch it and show it in a dialog; whatever the person presses (the button,
// the dismiss button or the close button) is recorded, and the notice never
// comes back for them. A withdrawn or expired announcement is shown to
// nobody, read or not. Published announcements can be edited (optionally
// showing them again to everyone) and withdrawn at any time.
//
// The body is the administrator's HTML: the apps draw it in a sandboxed frame
// without scripts, so it can style itself but cannot reach the app.
//
// Routes:
//   - user:  GET /api/v1/claudex/announcements/pending,
//     POST /api/v1/claudex/announcements/:id/read
//   - admin: /api/v1/admin/claudex/announcements (list, create), /:id (get,
//     put, delete), /:id/publish, /:id/withdraw; /announcement-mails (list,
//     send; sending needs step-up).
package announce

import (
	"context"
	"database/sql"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"

	"github.com/gin-gonic/gin"
)

// Component is the announcements component.
type Component struct {
	env   *core.Env
	store store
	// mailer sends one e-mail; nil uses the upstream SMTP service (tests set it).
	mailer func(ctx context.Context, to, subject, body string) error
	// emails resolves user ids to their addresses; nil uses env.UserRepo.
	emails func(ctx context.Context, ids []int64) map[int64]string
	// pause is the wait between two e-mails of a send (SMTP rate limits).
	pause time.Duration
}

// New builds the component. It must not call its dependencies here (tests
// pass empty Deps).
func New(env *core.Env) *Component {
	var db *sql.DB
	if env != nil {
		db = env.DB
	}
	return &Component{env: env, store: &sqlStore{db: db}, pause: 300 * time.Millisecond}
}

// Name implements core.Feature.
func (c *Component) Name() string { return core.NameAnnouncements }

func (c *Component) now() time.Time {
	if c.env != nil && c.env.Now != nil {
		return c.env.Now()
	}
	return time.Now()
}

func (c *Component) hasDB() bool {
	s, ok := c.store.(*sqlStore)
	return !ok || s.db != nil
}

// RegisterUserRoutes implements core.UserRouter.
func (c *Component) RegisterUserRoutes(g *gin.RouterGroup) {
	g.GET("/announcements/pending", c.getPending)
	g.POST("/announcements/:id/read", c.postRead)
}

// RegisterAdminRoutes implements core.AdminRouter. Publishing reaches every
// user and an e-mail send reaches people's inboxes: both need step-up.
func (c *Component) RegisterAdminRoutes(g *gin.RouterGroup, stepUp gin.HandlerFunc) {
	g.GET("/announcements", c.adminList)
	g.POST("/announcements", c.adminCreate)
	g.GET("/announcements/:id", c.adminGet)
	g.PUT("/announcements/:id", c.adminUpdate)
	g.DELETE("/announcements/:id", c.adminDelete)
	g.POST("/announcements/:id/publish", stepUp, c.adminPublish)
	g.POST("/announcements/:id/withdraw", c.adminWithdraw)
	g.GET("/announcement-mails", c.adminListMails)
	g.POST("/announcement-mails", stepUp, c.adminSendMail)
}
