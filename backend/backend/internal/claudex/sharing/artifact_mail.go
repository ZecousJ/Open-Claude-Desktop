package sharing

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"html"
	"log/slog"
	"regexp"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
)

// The e-mails about artifacts an account can turn off (live claude.ai,
// 2026-10-21, Settings → General → Notifications): Mentions and replies
// (someone @mentions you in a comment on an artifact, or comments on one
// whose comments you are part of), Comments on your artifacts (someone
// comments on an artifact you own; it follows Mentions and replies until it
// is set) and Artifacts shared with you (an invitation). All are on until
// the account turns them off.
type ArtifactMailPreferences struct {
	Mentions bool `json:"mentions"`
	Comments bool `json:"comments"`
	Shares   bool `json:"shares"`
}

type artifactMailPatch struct {
	Mentions *bool `json:"mentions"`
	Comments *bool `json:"comments"`
	Shares   *bool `json:"shares"`
}

type mailPrefStore interface {
	getMailPrefs(context.Context, int64) (ArtifactMailPreferences, error)
	putMailPrefs(context.Context, int64, artifactMailPatch) (ArtifactMailPreferences, error)
}

func defaultMailPrefs() ArtifactMailPreferences {
	return ArtifactMailPreferences{Mentions: true, Comments: true, Shares: true}
}

func (s *sqlStore) getMailPrefs(ctx context.Context, userID int64) (ArtifactMailPreferences, error) {
	prefs := defaultMailPrefs()
	if s == nil || s.db == nil {
		return prefs, nil
	}
	var comments sql.NullBool
	err := s.db.QueryRowContext(ctx, `SELECT mentions, comments, shares FROM claudex_artifact_mail_prefs WHERE user_id=$1`, userID).Scan(&prefs.Mentions, &comments, &prefs.Shares)
	if errors.Is(err, sql.ErrNoRows) {
		return defaultMailPrefs(), nil
	}
	prefs.Comments = prefs.Mentions
	if comments.Valid {
		prefs.Comments = comments.Bool
	}
	return prefs, err
}

func (s *sqlStore) putMailPrefs(ctx context.Context, userID int64, patch artifactMailPatch) (ArtifactMailPreferences, error) {
	if s == nil || s.db == nil {
		return ArtifactMailPreferences{}, errors.New("no database")
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO claudex_artifact_mail_prefs (user_id, mentions, comments, shares, updated_at)
	 VALUES ($1, COALESCE($2, TRUE), $3, COALESCE($4, TRUE), NOW()) ON CONFLICT (user_id) DO UPDATE SET
	 mentions=COALESCE($2, claudex_artifact_mail_prefs.mentions),
	 comments=COALESCE($3, claudex_artifact_mail_prefs.comments),
	 shares=COALESCE($4, claudex_artifact_mail_prefs.shares),
	 updated_at=NOW()`, userID, patch.Mentions, patch.Comments, patch.Shares)
	if err != nil {
		return ArtifactMailPreferences{}, err
	}
	return s.getMailPrefs(ctx, userID)
}

func (c *Component) artifactMailPrefs(ctx context.Context, userID int64) ArtifactMailPreferences {
	if c.mailPrefs == nil || userID == 0 {
		return defaultMailPrefs()
	}
	prefs, err := c.mailPrefs.getMailPrefs(ctx, userID)
	if err != nil {
		// A read that fails sends nothing rather than mail someone who
		// turned it off.
		return ArtifactMailPreferences{}
	}
	return prefs
}

// GET /api/v1/claudex/sharing/mail-preferences
func (c *Component) getMailPreferences(g *gin.Context) {
	userID, ok := core.Subject(g)
	if !ok {
		response.ErrorFrom(g, ErrShareNotFound)
		return
	}
	prefs := defaultMailPrefs()
	if c.mailPrefs != nil {
		var err error
		if prefs, err = c.mailPrefs.getMailPrefs(g.Request.Context(), userID); err != nil {
			response.ErrorFrom(g, errStoreFailed.WithCause(err))
			return
		}
	}
	g.Header("Cache-Control", "no-store")
	response.Success(g, prefs)
}

// PATCH /api/v1/claudex/sharing/mail-preferences
func (c *Component) patchMailPreferences(g *gin.Context) {
	userID, ok := core.Subject(g)
	if !ok {
		response.ErrorFrom(g, ErrShareNotFound)
		return
	}
	var patch artifactMailPatch
	if err := readSmallJSON(g, &patch); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	if c.mailPrefs == nil {
		response.ErrorFrom(g, errStoreFailed)
		return
	}
	prefs, err := c.mailPrefs.putMailPrefs(g.Request.Context(), userID, patch)
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	g.Header("Cache-Control", "no-store")
	response.Success(g, prefs)
}

type userByEmail interface {
	GetByEmail(context.Context, string) (*service.User, error)
}

// userIDOf is the account an address signs in with, 0 when there is none.
func (c *Component) userIDOf(ctx context.Context, email string) int64 {
	if c.env == nil || c.env.UserRepo == nil || email == "" {
		return 0
	}
	repo, ok := c.env.UserRepo.(userByEmail)
	if !ok {
		return 0
	}
	user, err := repo.GetByEmail(ctx, email)
	if err != nil || user == nil {
		return 0
	}
	return user.ID
}

// mentionPattern finds the addresses a comment @mentions.
var mentionPattern = regexp.MustCompile(`@([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})`)

// commentMail is who hears of a new comment on a shared artifact and why:
// the people it @mentions (among those who can read it) and who commented
// before ("Mentions and replies"), and its owner ("Comments on your
// artifacts"), each once, never its author.
func commentRecipients(author, owner string, readers []string, earlier []SnapshotComment, text string) map[string]string {
	out := map[string]string{}
	canRead := map[string]bool{owner: true}
	for _, reader := range readers {
		canRead[reader] = true
	}
	for _, match := range mentionPattern.FindAllStringSubmatch(text, -1) {
		if address := strings.ToLower(match[1]); canRead[address] {
			out[address] = "mention"
		}
	}
	for _, comment := range earlier {
		if address := strings.ToLower(comment.Author); address != "" && canRead[address] {
			if _, seen := out[address]; !seen {
				out[address] = "reply"
			}
		}
	}
	if _, seen := out[owner]; !seen && owner != "" {
		out[owner] = "owner"
	}
	delete(out, author)
	return out
}

// mailComment tells the people a new comment concerns, each as their
// preferences allow. It runs after the answer; a failure is a log line.
func (c *Component) mailComment(row *shareRow, link, author, text string, earlier []SnapshotComment) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
		defer cancel()
		defer func() { _ = recover() }()
		owner := c.emailOf(ctx, row.UserID)
		recipients := commentRecipients(author, owner, c.invitesOf(ctx, row.ID), earlier, text)
		for address, why := range recipients {
			id := row.UserID
			if address != owner {
				id = c.userIDOf(ctx, address)
			}
			prefs := c.artifactMailPrefs(ctx, id)
			if (why == "owner" && !prefs.Comments) || (why != "owner" && !prefs.Mentions) {
				continue
			}
			subject, body := commentMail(author, row.Title, text, link, why)
			if err := c.sendMail(ctx, address, subject, body); err != nil {
				slog.Warn("claudex sharing: comment e-mail not sent", "reason", err.Error())
			}
		}
	}()
}

// commentMail is the message about a comment.
func commentMail(author, title, text, link, why string) (subject, body string) {
	name := strings.TrimSpace(title)
	if name == "" {
		name = "an artifact"
	} else {
		name = "“" + name + "”"
	}
	heading, headingCN := "New comment on "+name, "作品有新评论"
	switch why {
	case "mention":
		heading, headingCN = author+" mentioned you on "+name, "有人在评论中提到了你"
	case "reply":
		heading, headingCN = author+" replied on "+name, "你参与的评论有新回复"
	}
	subject = heading
	site := ""
	if i := strings.Index(link, "://"); i > 0 {
		if j := strings.Index(link[i+3:], "/"); j > 0 {
			site = link[:i+3+j]
		}
	}
	quote := html.EscapeString(strings.TrimSpace(text))
	if len([]rune(quote)) > 600 {
		quote = string([]rune(quote)[:600]) + "…"
	}
	body = service.ClaudexEmailHTML(service.ClaudexEmailLayout{
		SiteName: "Claudex",
		SiteURL:  html.EscapeString(site),
		Title:    headingCN + " / " + html.EscapeString(heading),
		Content: fmt.Sprintf(`<p><strong>%s</strong> 在 %s 上评论：<br><span style="color:#6b6a65;"><strong>%s</strong> commented on %s:</span></p>
<p style="white-space:pre-wrap;border-left:3px solid #d9d7cf;padding-left:12px;">%s</p>
%s
<p class="muted" style="color:#6b6a65;font-size:13px;line-height:20px;">你可以在 Claudex 的设置 → 通用 → 通知中关闭这类邮件。You can turn these e-mails off in Claudex under Settings → General → Notifications.</p>`,
			html.EscapeString(author), html.EscapeString(name), html.EscapeString(author), html.EscapeString(name), quote,
			service.ClaudexEmailButton(link, "打开作品 / Open the artifact")),
	})
	return subject, body
}
