package memory

import (
	"strconv"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/pkg/response"

	"github.com/gin-gonic/gin"
)

// AdminStats is GET /api/v1/admin/claudex/memory/stats.
type AdminStats struct {
	Stats
	// EncryptionKeyReady is false when the server has no fixed secret key:
	// memory cannot be stored until one is configured (TOTP_ENCRYPTION_KEY).
	EncryptionKeyReady bool `json:"encryption_key_ready"`
}

// AdminPrefs is a user's stored switches (nil fields: never set, the
// policy's default_on applies).
type AdminPrefs struct {
	Set         bool       `json:"set"`
	SearchChats *bool      `json:"search_chats"`
	Generate    *bool      `json:"generate"`
	UpdatedAt   *time.Time `json:"updated_at"`
}

// AdminUserMemory is GET /api/v1/admin/claudex/memory/users/:id: metadata
// only. It never carries memory text (tests check the field set).
type AdminUserMemory struct {
	UserID     int64       `json:"user_id"`
	Prefs      AdminPrefs  `json:"prefs"`
	Scopes     []ScopeMeta `json:"scopes"`
	Documents  int         `json:"documents"`
	Edits      int         `json:"edits"`
	TotalBytes int         `json:"total_bytes"`
}

// GET /api/v1/admin/claudex/memory/stats
func (c *Component) adminStats(g *gin.Context) {
	st, err := c.store.stats(g.Request.Context())
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	response.Success(g, AdminStats{Stats: st, EncryptionKeyReady: c.box.CanStore()})
}

// adminUserID reads :id and answers 404 for an unknown user.
func (c *Component) adminUserID(g *gin.Context) (int64, bool) {
	id, err := strconv.ParseInt(strings.TrimSpace(g.Param("id")), 10, 64)
	if err != nil || id <= 0 {
		response.ErrorFrom(g, ErrUserNotFound)
		return 0, false
	}
	exists, err := c.store.userExists(g.Request.Context(), id)
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return 0, false
	}
	if !exists {
		response.ErrorFrom(g, ErrUserNotFound)
		return 0, false
	}
	return id, true
}

// GET /api/v1/admin/claudex/memory/users/:id
func (c *Component) adminUser(g *gin.Context) {
	userID, ok := c.adminUserID(g)
	if !ok {
		return
	}
	ctx := g.Request.Context()
	prefs, err := c.store.prefs(ctx, userID)
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	scopes, err := c.store.scopeMeta(ctx, userID)
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	out := AdminUserMemory{UserID: userID, Scopes: scopes}
	if prefs != nil {
		search, generate, updated := prefs.SearchChats, prefs.Generate, prefs.UpdatedAt
		out.Prefs = AdminPrefs{Set: true, SearchChats: &search, Generate: &generate, UpdatedAt: &updated}
	}
	for _, s := range scopes {
		if s.HasDocument {
			out.Documents++
		}
		out.Edits += s.Edits
		out.TotalBytes += s.ContentBytes + s.EditBytes
	}
	response.Success(g, out)
}

// DELETE /api/v1/admin/claudex/memory/users/:id (step-up): clears every
// document and edit of the user. The user's switches stay, so memory starts
// again from nothing if they keep it on.
func (c *Component) adminClear(g *gin.Context) {
	userID, ok := c.adminUserID(g)
	if !ok {
		return
	}
	docs, edits, err := c.store.deleteAll(g.Request.Context(), userID)
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	response.Success(g, DeleteResult{DeletedDocs: docs, DeletedEdits: edits})
}
