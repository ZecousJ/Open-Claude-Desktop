package announce

import (
	"context"
	"encoding/json"
	"errors"
	"html"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
)

func readJSON(g *gin.Context, into any) error {
	raw, err := io.ReadAll(http.MaxBytesReader(g.Writer, g.Request.Body, requestBodySize))
	if err != nil {
		return invalid("body", "The request is too large.")
	}
	if len(raw) == 0 {
		raw = []byte("{}")
	}
	if err := json.Unmarshal(raw, into); err != nil {
		return invalid("body", "The request must be a JSON object.")
	}
	return nil
}

func idParam(g *gin.Context) (int64, bool) {
	id, err := strconv.ParseInt(g.Param("id"), 10, 64)
	return id, err == nil && id > 0
}

func (c *Component) ready(g *gin.Context) bool {
	if !c.hasDB() {
		response.ErrorFrom(g, ErrUnavailable)
		return false
	}
	return true
}

// ---- user routes ----

// GET /api/v1/claudex/announcements/pending
func (c *Component) getPending(g *gin.Context) {
	userID, ok := core.Subject(g)
	if !ok {
		response.ErrorFrom(g, infraerrors.Unauthorized("UNAUTHORIZED", "Sign in first."))
		return
	}
	out := []UserDTO{}
	if c.hasDB() {
		rows, err := c.store.pending(g.Request.Context(), userID, c.now())
		if err != nil {
			response.ErrorFrom(g, errStoreFailed.WithCause(err))
			return
		}
		for i := range rows {
			out = append(out, rows[i].user())
		}
	}
	g.Header("Cache-Control", "no-store")
	response.Success(g, gin.H{"items": out})
}

// POST /api/v1/claudex/announcements/:id/read {action}
func (c *Component) postRead(g *gin.Context) {
	userID, ok := core.Subject(g)
	if !ok {
		response.ErrorFrom(g, infraerrors.Unauthorized("UNAUTHORIZED", "Sign in first."))
		return
	}
	id, ok := idParam(g)
	if !ok || !c.ready(g) {
		if !ok {
			response.ErrorFrom(g, ErrNotFound)
		}
		return
	}
	var req struct {
		Action string `json:"action"`
	}
	if err := readJSON(g, &req); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	action := strings.TrimSpace(req.Action)
	if action == "" {
		action = "close"
	}
	if !readActions[action] {
		response.ErrorFrom(g, invalid("action", "The action must be primary, dismiss or close."))
		return
	}
	live, err := c.store.markRead(g.Request.Context(), id, userID, action, c.now())
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	response.Success(g, gin.H{"recorded": live})
}

// ---- admin routes ----

// GET /api/v1/admin/claudex/announcements
func (c *Component) adminList(g *gin.Context) {
	if !c.ready(g) {
		return
	}
	rows, err := c.store.list(g.Request.Context())
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	now := c.now()
	out := make([]AdminDTO, 0, len(rows))
	for i := range rows {
		out = append(out, rows[i].admin(now))
	}
	response.Success(g, gin.H{"items": out, "mail_ready": c.canSendMail(g.Request.Context())})
}

// POST /api/v1/admin/claudex/announcements (a draft)
func (c *Component) adminCreate(g *gin.Context) {
	if !c.ready(g) {
		return
	}
	var in Content
	if err := readJSON(g, &in); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	in, err := in.normalize()
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	by, _ := core.Subject(g)
	r, err := c.store.create(g.Request.Context(), in, by, c.now())
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	response.Created(g, r.admin(c.now()))
}

// found loads the announcement of :id or writes why not.
func (c *Component) found(g *gin.Context) (*row, bool) {
	id, ok := idParam(g)
	if !ok {
		response.ErrorFrom(g, ErrNotFound)
		return nil, false
	}
	if !c.ready(g) {
		return nil, false
	}
	r, err := c.store.get(g.Request.Context(), id)
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return nil, false
	}
	if r == nil {
		response.ErrorFrom(g, ErrNotFound)
		return nil, false
	}
	return r, true
}

// GET /api/v1/admin/claudex/announcements/:id
func (c *Component) adminGet(g *gin.Context) {
	if r, ok := c.found(g); ok {
		response.Success(g, r.admin(c.now()))
	}
}

// PUT /api/v1/admin/claudex/announcements/:id {content…, reset_reads}
func (c *Component) adminUpdate(g *gin.Context) {
	r, ok := c.found(g)
	if !ok {
		return
	}
	var req struct {
		Content
		ResetReads bool `json:"reset_reads"`
	}
	if err := readJSON(g, &req); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	in, err := req.Content.normalize()
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	updated, err := c.store.update(g.Request.Context(), r.ID, in, req.ResetReads, c.now())
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	if updated == nil {
		response.ErrorFrom(g, ErrNotFound)
		return
	}
	updated.Reads = r.Reads
	if req.ResetReads {
		updated.Reads = 0
	}
	response.Success(g, updated.admin(c.now()))
}

// DELETE /api/v1/admin/claudex/announcements/:id
func (c *Component) adminDelete(g *gin.Context) {
	id, ok := idParam(g)
	if !ok || !c.ready(g) {
		if !ok {
			response.ErrorFrom(g, ErrNotFound)
		}
		return
	}
	done, err := c.store.remove(g.Request.Context(), id)
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	if !done {
		response.ErrorFrom(g, ErrNotFound)
		return
	}
	response.Success(g, gin.H{"deleted": true})
}

// POST /api/v1/admin/claudex/announcements/:id/publish {duration_hours}
// Publishing again (after a withdrawal or an expiry) starts a new period.
func (c *Component) adminPublish(g *gin.Context) {
	r, ok := c.found(g)
	if !ok {
		return
	}
	var req struct {
		DurationHours int `json:"duration_hours"`
	}
	if err := readJSON(g, &req); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	if req.DurationHours < 1 || req.DurationHours > maxDurationHrs {
		response.ErrorFrom(g, invalid("duration_hours", "Publish for between an hour and a year."))
		return
	}
	now := c.now()
	updated, err := c.store.publish(g.Request.Context(), r.ID, now, now.Add(time.Duration(req.DurationHours)*time.Hour))
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	if updated == nil {
		response.ErrorFrom(g, ErrNotFound)
		return
	}
	updated.Reads = r.Reads
	response.Success(g, updated.admin(now))
}

// POST /api/v1/admin/claudex/announcements/:id/withdraw
func (c *Component) adminWithdraw(g *gin.Context) {
	r, ok := c.found(g)
	if !ok {
		return
	}
	updated, err := c.store.withdraw(g.Request.Context(), r.ID, c.now())
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	if updated == nil {
		response.ErrorFrom(g, ErrNotFound)
		return
	}
	updated.Reads = r.Reads
	response.Success(g, updated.admin(c.now()))
}

// ---- e-mail ----

// canSendMail tells whether the service has SMTP set up.
func (c *Component) canSendMail(ctx context.Context) bool {
	if c.mailer != nil {
		return true
	}
	if c.env == nil || c.env.Email == nil {
		return false
	}
	cfg, err := c.env.Email.GetSMTPConfig(ctx)
	return err == nil && cfg != nil && strings.TrimSpace(cfg.Host) != ""
}

func (c *Component) sendMail(ctx context.Context, to, subject, body string) error {
	if c.mailer != nil {
		return c.mailer(ctx, to, subject, body)
	}
	if c.env == nil || c.env.Email == nil {
		return errors.New("no mail service")
	}
	return c.env.Email.SendEmail(ctx, to, subject, body)
}

// addresses resolves user ids to live addresses, deduplicated.
func (c *Component) addresses(ctx context.Context, ids []int64) []string {
	var found map[int64]string
	if c.emails != nil {
		found = c.emails(ctx, ids)
	} else {
		found = map[int64]string{}
		if c.env != nil && c.env.UserRepo != nil {
			for _, id := range ids {
				if u, err := c.env.UserRepo.GetByID(ctx, id); err == nil && u != nil {
					found[id] = u.Email
				}
			}
		}
	}
	seen := map[string]bool{}
	var out []string
	for _, id := range ids {
		email := strings.ToLower(strings.TrimSpace(found[id]))
		if email == "" || !strings.Contains(email, "@") || seen[email] {
			continue
		}
		seen[email] = true
		out = append(out, email)
	}
	return out
}

// GET /api/v1/admin/claudex/announcement-mails
func (c *Component) adminListMails(g *gin.Context) {
	if !c.ready(g) {
		return
	}
	mails, err := c.store.listMails(g.Request.Context(), 50)
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	if mails == nil {
		mails = []mailRow{}
	}
	response.Success(g, gin.H{"items": mails, "mail_ready": c.canSendMail(g.Request.Context())})
}

// POST /api/v1/admin/claudex/announcement-mails {subject, body_html, user_ids}
// The answer comes at once; the messages go out one by one in the background
// and the list shows how far the send got.
func (c *Component) adminSendMail(g *gin.Context) {
	if !c.ready(g) {
		return
	}
	var req struct {
		Subject  string  `json:"subject"`
		BodyHTML string  `json:"body_html"`
		UserIDs  []int64 `json:"user_ids"`
	}
	if err := readJSON(g, &req); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	subject := strings.TrimSpace(req.Subject)
	switch {
	case subject == "":
		response.ErrorFrom(g, invalid("subject", "Write a subject."))
		return
	case tooLong(subject, maxMailSubject):
		response.ErrorFrom(g, invalid("subject", "The subject can be up to 200 characters."))
		return
	case strings.ContainsAny(subject, "\r\n"):
		response.ErrorFrom(g, invalid("subject", "The subject must be one line."))
		return
	case strings.TrimSpace(req.BodyHTML) == "":
		response.ErrorFrom(g, invalid("body_html", "Write the message."))
		return
	case len(req.BodyHTML) > maxMailHTML:
		response.ErrorFrom(g, invalid("body_html", "The message can be up to 500 KB."))
		return
	case len(req.UserIDs) == 0:
		response.ErrorFrom(g, invalid("user_ids", "Choose who gets it."))
		return
	case len(req.UserIDs) > maxRecipients:
		response.ErrorFrom(g, invalid("user_ids", "Send to at most 500 people at a time."))
		return
	}
	ctx := g.Request.Context()
	if !c.canSendMail(ctx) {
		response.ErrorFrom(g, ErrMailOff)
		return
	}
	to := c.addresses(ctx, req.UserIDs)
	if len(to) == 0 {
		response.ErrorFrom(g, invalid("user_ids", "None of these people has an e-mail address."))
		return
	}
	by, _ := core.Subject(g)
	id, err := c.store.createMail(ctx, subject, req.BodyHTML, len(to), by, c.now())
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	go c.deliver(id, to, subject, c.mailDocument(ctx, subject, req.BodyHTML))
	response.Success(g, gin.H{"id": id, "recipients": len(to)})
}

// mailDocument puts the administrator's message in the Claudex email
// layout (the subject as its title); a whole HTML document is sent as written.
func (c *Component) mailDocument(ctx context.Context, subject, body string) string {
	lower := strings.ToLower(body)
	if strings.Contains(lower, "<html") || strings.Contains(lower, "<!doctype") {
		return body
	}
	site, siteURL := "Claudex", ""
	if c.env != nil && c.env.SettingService != nil {
		if name := strings.TrimSpace(c.env.SettingService.GetSiteName(ctx)); name != "" {
			site = name
		}
		siteURL = strings.TrimRight(strings.TrimSpace(c.env.SettingService.GetFrontendURL(ctx)), "/")
	}
	return service.ClaudexEmailHTML(service.ClaudexEmailLayout{
		SiteName: html.EscapeString(site),
		SiteURL:  html.EscapeString(siteURL),
		Title:    html.EscapeString(subject),
		Content:  body,
	})
}

// deliver sends one send's messages, recording progress every ten.
func (c *Component) deliver(id int64, to []string, subject, body string) {
	defer func() { _ = recover() }()
	ctx := context.Background()
	sent, failed := 0, 0
	for i, address := range to {
		mailCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
		if err := c.sendMail(mailCtx, address, subject, body); err != nil {
			failed++
			slog.Warn("claudex announcements: e-mail not sent", "mail", id, "reason", err.Error())
		} else {
			sent++
		}
		cancel()
		if (i+1)%10 == 0 && i+1 < len(to) {
			_ = c.store.mailProgress(ctx, id, sent, failed, false, c.now())
		}
		if c.pause > 0 && i+1 < len(to) {
			time.Sleep(c.pause)
		}
	}
	_ = c.store.mailProgress(ctx, id, sent, failed, true, c.now())
}
