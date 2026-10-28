package routinemail

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"html"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/gin-gonic/gin"
)

// Code email belongs to the caller's persisted cloud profile. It is independent
// of scheduled-task email and Code permission push; local sessions never use it.
func (c *Component) getCodeStatus(g *gin.Context) {
	userID, ok := core.Subject(g)
	if !ok {
		response.ErrorFrom(g, infraerrors.Unauthorized("UNAUTHORIZED", "Sign in first."))
		return
	}
	ctx := g.Request.Context()
	available := (c.codeState != nil || (c.env != nil && c.env.DB != nil)) && c.emailOf(ctx, userID) != "" && c.canSend(ctx)
	response.Success(g, gin.H{"available": available})
}

type codeEventRequest struct {
	ConversationID string `json:"conversationId"`
	EventID        string `json:"eventId"`
	Outcome        string `json:"outcome"`
}

func (c *Component) cloudCodeState(ctx context.Context, userID int64, conversationID string) (bool, string, error) {
	if c.codeState != nil {
		return c.codeState(ctx, userID, conversationID)
	}
	if c.env == nil || c.env.DB == nil {
		return false, "", nil
	}
	var enabled bool
	var title string
	// Both rows are scoped to the authenticated user. The sender cannot choose
	// an address, title, message, or a session belonging to another account.
	err := c.env.DB.QueryRowContext(ctx, `SELECT COALESCE(s.doc->'notifyCodeEmail' = 'true'::jsonb, false), c.title
FROM claudex_web_conversations c JOIN claudex_web_settings s ON s.user_id = c.user_id
WHERE c.user_id = $1 AND c.id = $2 AND c.mode = 'code' AND NOT c.archived
AND COALESCE(c.doc->'incognito', 'false'::jsonb) <> 'true'::jsonb
AND COALESCE(c.doc->'linkedToComputer', 'false'::jsonb) <> 'true'::jsonb
AND COALESCE(c.doc->'chatDeviceBinding', 'null'::jsonb) = 'null'::jsonb
AND COALESCE(c.doc->'environment'->>'kind', '') <> 'ssh'`, userID, conversationID).Scan(&enabled, &title)
	if errors.Is(err, sql.ErrNoRows) {
		return false, "", nil
	}
	return enabled, title, err
}

func (c *Component) reserveCode(userID int64, in codeEventRequest) (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.codeSent == nil {
		c.codeSent = make(map[string]time.Time)
	}
	cutoff := c.now().Add(-time.Hour)
	for key, at := range c.codeSent {
		if at.Before(cutoff) {
			delete(c.codeSent, key)
		}
	}
	key := fmt.Sprintf("%d:%s:%s", userID, in.ConversationID, in.EventID)
	if _, exists := c.codeSent[key]; exists {
		return key, false
	}
	kept := c.sent[userID][:0]
	for _, at := range c.sent[userID] {
		if at.After(cutoff) {
			kept = append(kept, at)
		}
	}
	if len(kept) >= perHour {
		c.sent[userID] = kept
		return key, false
	}
	c.sent[userID] = append(kept, c.now())
	c.codeSent[key] = c.now()
	return key, true
}

func (c *Component) postCodeEvent(g *gin.Context) {
	userID, ok := core.Subject(g)
	if !ok {
		response.ErrorFrom(g, infraerrors.Unauthorized("UNAUTHORIZED", "Sign in first."))
		return
	}
	var in codeEventRequest
	if err := g.ShouldBindJSON(&in); err != nil || len(in.ConversationID) == 0 || len(in.ConversationID) > 128 || len(in.EventID) == 0 || len(in.EventID) > 200 || strings.ContainsAny(in.EventID, "\r\n") || (in.Outcome != "completed" && in.Outcome != "failed" && in.Outcome != "needs_attention") {
		response.ErrorFrom(g, infraerrors.BadRequest("BAD_REQUEST", "The request could not be read."))
		return
	}
	ctx := g.Request.Context()
	enabled, title, err := c.cloudCodeState(ctx, userID, in.ConversationID)
	if err != nil {
		response.ErrorFrom(g, infraerrors.ServiceUnavailable("CODE_EMAIL_FAILED", "The email preference could not be checked."))
		return
	}
	to := c.emailOf(ctx, userID)
	if !enabled || to == "" || !c.canSend(ctx) {
		response.Success(g, gin.H{"sent": false})
		return
	}
	key, reserved := c.reserveCode(userID, in)
	if !reserved {
		response.Success(g, gin.H{"sent": false})
		return
	}
	heading := map[string]string{"completed": "Your Code session finished", "failed": "Your Code session didn’t finish", "needs_attention": "Your Code session needs you"}[in.Outcome]
	title = strings.Join(strings.Fields(title), " ")
	if title == "" {
		title = "Code session"
	}
	if len(title) > 200 {
		title = title[:200]
	}
	body := "<h2>" + html.EscapeString(heading) + "</h2><p>" + html.EscapeString(title) + "</p><p>Open Claudex to continue this session.</p><p>You receive these emails because cloud Code email is on in your notification settings.</p>"
	if err := c.send(ctx, to, heading+": "+title, body); err != nil {
		c.mu.Lock()
		delete(c.codeSent, key)
		c.mu.Unlock()
		response.ErrorFrom(g, infraerrors.ServiceUnavailable("MAIL_FAILED", "The email could not be sent."))
		return
	}
	response.Success(g, gin.H{"sent": true})
}
