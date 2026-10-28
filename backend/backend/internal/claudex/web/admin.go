package web

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"

	"github.com/gin-gonic/gin"
)

const maxSettingsBody = 256 << 10

// SettingsUpdate is the PUT body: the full setting plus the revision it was
// read at.
type SettingsUpdate struct {
	Enabled            bool     `json:"enabled"`
	Mode               string   `json:"mode"`
	AllowlistUserIDs   []int64  `json:"allowlist_user_ids"`
	AllowlistEmails    []string `json:"allowlist_emails"`
	MaxSessionsPerUser int      `json:"max_web_sessions_per_user"`
	Revision           *int64   `json:"revision"`
}

func revisionConflict(current int64) error {
	return infraerrors.Conflict(ReasonSettingsConflict, "The web settings changed since you loaded them. Reload and try again.").
		WithMetadata(map[string]string{"current_revision": strconv.FormatInt(current, 10)})
}

// GET /api/v1/admin/claudex/web/settings
func (c *Component) adminGet(g *gin.Context) {
	s, _, err := c.setting.GetRaw(g.Request.Context())
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	response.Success(g, s)
}

// PUT /api/v1/admin/claudex/web/settings (step-up)
func (c *Component) adminPut(g *gin.Context) {
	ctx := g.Request.Context()
	body, err := io.ReadAll(http.MaxBytesReader(g.Writer, g.Request.Body, maxSettingsBody))
	if err != nil {
		response.ErrorFrom(g, invalidSetting("", "too_large", "The request body is too large."))
		return
	}
	var upd SettingsUpdate
	if err := json.Unmarshal(body, &upd); err != nil {
		response.ErrorFrom(g, invalidSetting("", "json", "The request body must be a JSON object."))
		return
	}
	if upd.Revision == nil {
		response.ErrorFrom(g, invalidSetting("revision", "required", "revision is required."))
		return
	}
	cur, raw, err := c.setting.GetRaw(ctx)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	if *upd.Revision != cur.Revision {
		response.ErrorFrom(g, revisionConflict(cur.Revision))
		return
	}
	next := Settings{
		Enabled:            upd.Enabled,
		Mode:               upd.Mode,
		AllowlistUserIDs:   upd.AllowlistUserIDs,
		AllowlistEmails:    upd.AllowlistEmails,
		MaxSessionsPerUser: upd.MaxSessionsPerUser,
		Revision:           cur.Revision + 1,
	}
	now := c.now().UTC()
	next.UpdatedAt = &now
	if adminID, ok := core.Subject(g); ok {
		next.UpdatedBy = &adminID
	}
	normalizeSettings(&next)
	if err := validateSettings(&next); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	saved, ok, err := c.swap(ctx, raw, next)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	if !ok {
		current := cur.Revision + 1
		if latest, _, err := c.setting.GetRaw(ctx); err == nil {
			current = latest.Revision
		}
		response.ErrorFrom(g, revisionConflict(current))
		return
	}
	// config_version is on the upstream audit allowlist; "revision" is not.
	middleware.SetAuditExtra(g, map[string]any{"config_version": saved.Revision})
	response.Success(g, saved)
}

// swap writes next only if the stored value is still raw. Without a database
// handle (unit tests) it falls back to a plain write.
func (c *Component) swap(ctx context.Context, raw string, next Settings) (Settings, bool, error) {
	var (
		saved Settings
		ok    = true
		err   error
	)
	if c.env.DB != nil {
		saved, ok, err = c.setting.SwapIfUnchanged(ctx, c.env.DB, raw, next)
	} else {
		saved, err = c.setting.Set(ctx, next)
	}
	if err == nil && ok {
		c.setting.Invalidate()
	}
	return saved, ok, err
}
