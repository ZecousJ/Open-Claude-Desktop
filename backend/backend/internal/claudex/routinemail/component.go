// Package routinemail e-mails the signed-in person when one of their
// scheduled tasks finishes, fails or needs them (the original's Scheduled
// tasks e-mail, routines.enable_email; live claude.ai bundle, 2026-10-14,
// c0db37792). The apps decide whether a run should mail (the person's
// Settings → Notifications switch and the task's own "Email" choice) and
// call this route; the service only ever writes to the caller's own address.
//
// Routes:
//   - user: GET /api/v1/claudex/routines/email, POST /api/v1/claudex/routines/email
package routinemail

import (
	"context"
	"errors"
	"html"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"

	"github.com/gin-gonic/gin"
)

// Name is the component's name (core.Feature).
const Name = "routine-mail"

// At most this many mails per person per hour; more are dropped quietly.
const perHour = 30

// Component sends scheduled-task mail.
type Component struct {
	env *core.Env
	// mailer and address replace the SMTP service and the user lookup (tests).
	mailer  func(ctx context.Context, to, subject, body string) error
	address func(ctx context.Context, userID int64) string

	mu        sync.Mutex
	sent      map[int64][]time.Time
	codeSent  map[string]time.Time
	codeState func(context.Context, int64, string) (bool, string, error)
}

// New builds the component. It must not call its dependencies here.
func New(env *core.Env) *Component {
	return &Component{env: env, sent: map[int64][]time.Time{}}
}

// Name implements core.Feature.
func (c *Component) Name() string { return Name }

// RegisterUserRoutes implements core.UserRouter.
func (c *Component) RegisterUserRoutes(g *gin.RouterGroup) {
	g.GET("/routines/email", c.getStatus)
	g.POST("/routines/email", c.postRun)
	g.GET("/code/email", c.getCodeStatus)
	g.POST("/code/email", c.postCodeEvent)
}

func (c *Component) now() time.Time {
	if c.env != nil && c.env.Now != nil {
		return c.env.Now()
	}
	return time.Now()
}

func (c *Component) canSend(ctx context.Context) bool {
	if c.mailer != nil {
		return true
	}
	if c.env == nil || c.env.Email == nil {
		return false
	}
	cfg, err := c.env.Email.GetSMTPConfig(ctx)
	return err == nil && cfg != nil && strings.TrimSpace(cfg.Host) != ""
}

func (c *Component) send(ctx context.Context, to, subject, body string) error {
	if c.mailer != nil {
		return c.mailer(ctx, to, subject, body)
	}
	if c.env == nil || c.env.Email == nil {
		return errors.New("no mail service")
	}
	return c.env.Email.SendEmail(ctx, to, subject, body)
}

func (c *Component) emailOf(ctx context.Context, userID int64) string {
	if c.address != nil {
		return c.address(ctx, userID)
	}
	if c.env == nil || c.env.UserRepo == nil {
		return ""
	}
	u, err := c.env.UserRepo.GetByID(ctx, userID)
	if err != nil || u == nil {
		return ""
	}
	return strings.TrimSpace(u.Email)
}

// allow counts a mail against the person's hourly budget.
func (c *Component) allow(userID int64) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	cutoff := c.now().Add(-time.Hour)
	kept := c.sent[userID][:0]
	for _, at := range c.sent[userID] {
		if at.After(cutoff) {
			kept = append(kept, at)
		}
	}
	if len(kept) >= perHour {
		c.sent[userID] = kept
		return false
	}
	c.sent[userID] = append(kept, c.now())
	return true
}

// GET /routines/email: whether this service can send the mail.
func (c *Component) getStatus(g *gin.Context) {
	if _, ok := core.Subject(g); !ok {
		response.ErrorFrom(g, infraerrors.Unauthorized("UNAUTHORIZED", "Sign in first."))
		return
	}
	response.Success(g, gin.H{"available": c.canSend(g.Request.Context())})
}

type runRequest struct {
	Task    string `json:"task"`
	Outcome string `json:"outcome"`
	Summary string `json:"summary"`
	Link    string `json:"link"`
}

// POST /routines/email: mail the caller about one of their runs.
func (c *Component) postRun(g *gin.Context) {
	userID, ok := core.Subject(g)
	if !ok {
		response.ErrorFrom(g, infraerrors.Unauthorized("UNAUTHORIZED", "Sign in first."))
		return
	}
	var in runRequest
	if err := g.ShouldBindJSON(&in); err != nil {
		response.ErrorFrom(g, infraerrors.BadRequest("BAD_REQUEST", "The request could not be read."))
		return
	}
	in.Task = strings.TrimSpace(in.Task)
	if in.Task == "" || len(in.Task) > 200 || len(in.Summary) > 2000 || len(in.Link) > 2000 {
		response.ErrorFrom(g, infraerrors.BadRequest("BAD_REQUEST", "The request could not be read."))
		return
	}
	if in.Outcome != "completed" && in.Outcome != "failed" && in.Outcome != "needs_attention" {
		response.ErrorFrom(g, infraerrors.BadRequest("BAD_REQUEST", "The request could not be read."))
		return
	}
	ctx := g.Request.Context()
	to := c.emailOf(ctx, userID)
	if to == "" || !c.canSend(ctx) {
		response.Success(g, gin.H{"sent": false})
		return
	}
	if !c.allow(userID) {
		response.Success(g, gin.H{"sent": false})
		return
	}
	subject, body := runMail(in)
	if err := c.send(ctx, to, subject, body); err != nil {
		response.ErrorFrom(g, infraerrors.ServiceUnavailable("MAIL_FAILED", "The e-mail could not be sent."))
		return
	}
	response.Success(g, gin.H{"sent": true})
}

// runMail is the message: the task, what happened, its summary and a link.
func runMail(in runRequest) (subject, body string) {
	heading := map[string]string{
		"completed":       "Your scheduled task finished",
		"failed":          "Your scheduled task didn’t finish",
		"needs_attention": "Your scheduled task needs you",
	}[in.Outcome]
	subject = heading + ": " + in.Task
	parts := []string{
		"<h2 style=\"font:600 18px system-ui,sans-serif;margin:0 0 12px\">" + html.EscapeString(heading) + "</h2>",
		"<p style=\"font:15px system-ui,sans-serif;margin:0 0 12px\"><strong>" + html.EscapeString(in.Task) + "</strong></p>",
	}
	if s := strings.TrimSpace(in.Summary); s != "" {
		parts = append(parts, "<p style=\"font:14px system-ui,sans-serif;color:#444;white-space:pre-wrap;margin:0 0 16px\">"+html.EscapeString(s)+"</p>")
	}
	if u, err := url.Parse(strings.TrimSpace(in.Link)); err == nil && u.Scheme == "https" && u.Host != "" {
		parts = append(parts, "<p style=\"font:14px system-ui,sans-serif;margin:0\"><a href=\""+html.EscapeString(u.String())+"\">Open in Claudex</a></p>")
	}
	parts = append(parts, "<p style=\"font:12px system-ui,sans-serif;color:#888;margin:24px 0 0\">You get these e-mails because Scheduled tasks e-mail is on in Claudex’s notification settings.</p>")
	return subject, strings.Join(parts, "")
}
