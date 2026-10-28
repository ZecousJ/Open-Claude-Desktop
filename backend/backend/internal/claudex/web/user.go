package web

import (
	"errors"
	"strconv"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/geoip"
	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
)

// CurrentSession answers GET /api/v1/claudex/web/session.
type CurrentSession struct {
	Allowed            bool     `json:"allowed"`
	Session            *Session `json:"session"`
	MaxSessionsPerUser int      `json:"max_web_sessions_per_user"`
}

// SessionList answers GET /api/v1/claudex/web/sessions.
type SessionList struct {
	Items            []SessionItem `json:"items"`
	CurrentSessionID int64         `json:"current_session_id,omitempty"`
}

// SessionItem is one listed session.
type SessionItem struct {
	Session
	Current      bool           `json:"current"`
	LocationInfo geoip.Location `json:"location_info"`
}

// GET /web/session: the session of the calling access token (null for a
// console token) and whether the user may use the web app.
func (c *Component) getSession(g *gin.Context) {
	ctx := g.Request.Context()
	uid, ok := core.Subject(g)
	if !ok {
		response.Unauthorized(g, "User not authenticated")
		return
	}
	s := c.setting.Cached(ctx)
	email := g.GetString(middleware.ContextKeyAuthEmail)
	role, _ := middleware.GetUserRoleFromContext(g)
	isAdmin := role == service.RoleAdmin
	out := CurrentSession{Allowed: s.allows(uid, email, isAdmin), MaxSessionsPerUser: s.MaxSessionsPerUser}
	if sid := core.SessionID(g); sid != "" && c.env.DB != nil {
		sess, err := c.store.byFamily(ctx, sid)
		switch {
		case err == nil && sess.UserID == uid && sess.active(c.now()):
			out.Session = sess
		case err != nil && !errors.Is(err, errNoSession):
			response.ErrorFrom(g, errUnavailable)
			return
		}
	}
	response.Success(g, out)
}

// GET /web/sessions: the user's active web sessions.
func (c *Component) listSessions(g *gin.Context) {
	uid, ok := core.Subject(g)
	if !ok {
		response.Unauthorized(g, "User not authenticated")
		return
	}
	if c.env.DB == nil {
		response.ErrorFrom(g, errUnavailable)
		return
	}
	rows, err := c.store.listActive(g.Request.Context(), uid, c.now())
	if err != nil {
		response.ErrorFrom(g, errUnavailable)
		return
	}
	sid := core.SessionID(g)
	out := SessionList{Items: make([]SessionItem, 0, len(rows))}
	for _, r := range rows {
		cur := sid != "" && r.FamilyID == sid
		if cur {
			out.CurrentSessionID = r.ID
		}
		out.Items = append(out.Items, SessionItem{Session: r, Current: cur, LocationInfo: geoip.Lookup(r.IP)})
	}
	response.Success(g, out)
}

// DELETE /web/sessions/:id: signs out one of the user's own sessions.
func (c *Component) deleteSession(g *gin.Context) {
	ctx := g.Request.Context()
	uid, ok := core.Subject(g)
	if !ok {
		response.Unauthorized(g, "User not authenticated")
		return
	}
	id, err := strconv.ParseInt(g.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		response.ErrorFrom(g, infraerrors.BadRequest(webproto.ErrCodeBadRequest, "Invalid session id."))
		return
	}
	if c.env.DB == nil {
		response.ErrorFrom(g, errUnavailable)
		return
	}
	now := c.now()
	sess, err := c.store.revoke(ctx, uid, id, "", RevokedUser, now, c.revokedUntil(now))
	if errors.Is(err, errNoSession) {
		response.ErrorFrom(g, infraerrors.NotFound("CLAUDEX_WEB_SESSION_NOT_FOUND", "Session not found."))
		return
	}
	if err != nil {
		response.ErrorFrom(g, errUnavailable)
		return
	}
	c.dropFamilies(ctx, []string{sess.FamilyID})
	response.Success(g, gin.H{"id": sess.ID, "revoked": true})
}
