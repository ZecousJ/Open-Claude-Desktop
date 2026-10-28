package sharing

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"

	"github.com/gin-gonic/gin"
)

const maxUserPageSize = 100

// ShareDTO is a share as the desktop app and the console see it (no
// content). URL is absolute when the server knows its public address;
// otherwise it is "" and clients join Path to the server address they use.
type ShareDTO struct {
	ID             int64      `json:"id"`
	Kind           Kind       `json:"kind"`
	SourceKey      string     `json:"source_key"`
	Title          string     `json:"title"`
	Status         Status     `json:"status"`
	DisabledReason string     `json:"disabled_reason"`
	Path           string     `json:"path"`
	URL            string     `json:"url"`
	CreatedAt      time.Time  `json:"created_at"`
	SnapshotAt     time.Time  `json:"snapshot_at"`
	UpdatedAt      time.Time  `json:"updated_at"`
	ExpiresAt      *time.Time `json:"expires_at"`
	ViewCount      int64      `json:"view_count"`
	ContentBytes   int64      `json:"content_bytes"`
	// InvitedOnly: no public page; only the invited people read the share.
	InvitedOnly bool `json:"invited_only"`
	// Invites are the invited addresses (lower-case).
	Invites       []string          `json:"invites"`
	InviteRoles   map[string]string `json:"invite_roles,omitempty"`
	ScreenshotURL string            `json:"screenshot_url,omitempty"`
}

func shareDTO(r *shareRow, base string) ShareDTO {
	path := sharePath(r.Token)
	url := ""
	if base != "" {
		url = joinBase(base, path)
	}
	return ShareDTO{
		ID: r.ID, Kind: r.Kind, SourceKey: r.SourceKey, Title: r.Title, Status: r.Status,
		DisabledReason: r.DisabledReason, Path: path, URL: url,
		CreatedAt: r.CreatedAt.UTC(), SnapshotAt: r.SnapshotAt.UTC(), UpdatedAt: r.UpdatedAt.UTC(),
		ExpiresAt: r.ExpiresAt, ViewCount: r.ViewCount, ContentBytes: r.ContentBytes,
		InvitedOnly: r.InvitedOnly, Invites: []string{},
	}
}

// StatusDTO answers GET /api/v1/claudex/sharing/status. The desktop app
// shows the public sharing options only when the matching flag is true.
type StatusDTO struct {
	// Enabled: the administrator turned sharing on and the server can store
	// shares.
	Enabled       bool `json:"enabled"`
	Conversations bool `json:"conversations"`
	Artifacts     bool `json:"artifacts"`
	// Blocked: the administrator turned sharing off for this account
	// (Conversations and Artifacts are then false).
	Blocked bool `json:"blocked"`
	// UsagePolicyURL is absolute; UsagePolicyPath is set for the server's
	// own legal page (join it to the server address when the URL is "").
	UsagePolicyURL   string `json:"usage_policy_url"`
	UsagePolicyPath  string `json:"usage_policy_path"`
	MaxSnapshotBytes int64  `json:"max_snapshot_bytes"`
	MaxArtifactBytes int64  `json:"max_artifact_bytes"`
	MaxActivePerUser int    `json:"max_active_per_user"`
	DefaultTTLDays   int    `json:"default_ttl_days"`
	// PublicBaseURL is where links point ("" = the server address).
	PublicBaseURL string `json:"public_base_url"`
	// ArtifactReports: the app's Report artifact can be sent (reports are
	// on and the server can keep them), whether or not sharing is on.
	ArtifactReports bool `json:"artifact_reports"`
	// ArtifactEmbeds: published artifacts can be embedded (Get embed code,
	// GET/PUT /shares/:id/embed and /s/<token>/embed).
	ArtifactEmbeds bool `json:"artifact_embeds"`
}

// GET /api/v1/claudex/sharing/status
func (c *Component) getStatus(g *gin.Context) {
	userID, ok := core.Subject(g)
	if !ok {
		response.ErrorFrom(g, infraerrors.Unauthorized("UNAUTHORIZED", "Sign in first."))
		return
	}
	ctx := g.Request.Context()
	s := c.setting.Cached(ctx)
	base, _ := c.publicBase(ctx, s)
	out := StatusDTO{
		MaxSnapshotBytes: s.MaxSnapshotBytes, MaxArtifactBytes: s.MaxArtifactBytes,
		MaxActivePerUser: s.MaxActivePerUser, DefaultTTLDays: s.DefaultTTLDays, PublicBaseURL: base,
		ArtifactReports: c.artifactReportsOpen(s),
	}
	if s.Enabled && c.hasDB() {
		blocked, err := c.store.isBlocked(ctx, userID)
		if err != nil {
			response.ErrorFrom(g, errStoreFailed.WithCause(err))
			return
		}
		out.Enabled, out.Blocked = true, blocked
		out.Conversations = s.Conversations && !blocked
		out.Artifacts = s.Artifacts && !blocked
		out.ArtifactEmbeds = out.Artifacts && c.embeds != nil
		out.UsagePolicyURL, out.UsagePolicyPath = c.usagePolicy(ctx, s, base)
	}
	g.Header("Cache-Control", "no-store")
	response.Success(g, out)
}

// shareRequest is the body of POST /shares and PUT /shares/:id.
type shareRequest struct {
	Kind      Kind      `json:"kind"`
	SourceKey string    `json:"source_key"`
	Title     string    `json:"title"`
	Snapshot  *Snapshot `json:"snapshot"`
	// Access is "link" (the default) or "invited": a new share limited to the
	// people invited to it. A refresh of a live share keeps its access.
	Access string `json:"access"`
}

// canPublish checks the switches in front of every write that publishes
// content: sharing on, the kind on, the user not blocked.
func (c *Component) canPublish(ctx context.Context, s Settings, userID int64, kind Kind) error {
	if !c.hasDB() {
		return ErrUnavailable
	}
	if !s.Enabled {
		return ErrSharingDisabled
	}
	if (kind == KindConversation && !s.Conversations) || (kind == KindArtifact && !s.Artifacts) {
		return ErrKindDisabled
	}
	blocked, err := c.store.isBlocked(ctx, userID)
	if err != nil {
		return errStoreFailed.WithCause(err)
	}
	if blocked {
		return ErrUserBlocked
	}
	return nil
}

// readShareRequest reads a JSON share request of at most the snapshot limit
// plus some overhead.
func readShareRequest(g *gin.Context, s Settings) (*shareRequest, error) {
	limit := s.MaxSnapshotBytes + requestOverheadBytes
	raw, err := io.ReadAll(http.MaxBytesReader(g.Writer, requestBody(g), limit))
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			return nil, tooLarge("snapshot", s.MaxSnapshotBytes)
		}
		return nil, invalidShare("body", "The request body can't be read.")
	}
	var req shareRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, invalidShare("body", "The request must be a JSON object with kind, source_key, title and snapshot.")
	}
	return &req, nil
}

func titleOf(req *shareRequest) string {
	if t := strings.TrimSpace(req.Title); t != "" {
		return t
	}
	if req.Snapshot != nil {
		return req.Snapshot.Title
	}
	return ""
}

// POST /api/v1/claudex/shares {kind, source_key, title, snapshot}. Sharing a
// source that already has a live share refreshes its snapshot and keeps the
// link (200); a new share answers 201.
func (c *Component) createShare(g *gin.Context) {
	userID, ok := core.Subject(g)
	if !ok {
		response.ErrorFrom(g, infraerrors.Unauthorized("UNAUTHORIZED", "Sign in first."))
		return
	}
	ctx := g.Request.Context()
	s := c.setting.Cached(ctx)
	if !c.hasDB() {
		response.ErrorFrom(g, ErrUnavailable)
		return
	}
	if !s.Enabled {
		response.ErrorFrom(g, ErrSharingDisabled)
		return
	}
	req, err := readShareRequest(g, s)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	if req.Kind != KindConversation && req.Kind != KindArtifact {
		response.ErrorFrom(g, invalidShare("kind", "kind must be conversation or artifact."))
		return
	}
	if err := c.canPublish(ctx, s, userID, req.Kind); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	sourceKey, ok := SourceKey(req.SourceKey)
	if !ok {
		response.ErrorFrom(g, invalidShare("source_key", "source_key must be 1 to 512 bytes."))
		return
	}
	body, err := normalizeSnapshot(req.Snapshot, req.Kind, titleOf(req), limitsOf(s))
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	now := c.now()
	var expires *time.Time
	if s.DefaultTTLDays > 0 {
		t := now.Add(time.Duration(s.DefaultTTLDays) * 24 * time.Hour)
		expires = &t
	}
	row, created, err := c.store.upsert(ctx, upsertInput{
		UserID: userID, Kind: req.Kind, SourceKey: sourceKey, Title: req.Snapshot.Title, Body: body,
		Now: now, ExpiresAt: expires, MaxActive: s.MaxActivePerUser, NewToken: newToken,
		InvitedOnly: req.Access == AccessInvited,
	})
	if err != nil {
		c.writeStoreError(g, err)
		return
	}
	base, _ := c.publicBase(ctx, s)
	middleware.SetAuditExtra(g, map[string]any{"result": map[bool]string{true: "created", false: "updated"}[created]})
	if created {
		response.Created(g, c.shareView(ctx, row, base))
		return
	}
	response.Success(g, c.shareView(ctx, row, base))
}

// PUT /api/v1/claudex/shares/:id {title?, snapshot}: new snapshot, same link.
func (c *Component) updateShare(g *gin.Context) {
	userID, ok := core.Subject(g)
	if !ok {
		response.ErrorFrom(g, infraerrors.Unauthorized("UNAUTHORIZED", "Sign in first."))
		return
	}
	id, ok := idParam(g, "id")
	if !ok {
		response.ErrorFrom(g, ErrShareNotFound)
		return
	}
	ctx := g.Request.Context()
	s := c.setting.Cached(ctx)
	if !c.hasDB() {
		response.ErrorFrom(g, ErrUnavailable)
		return
	}
	existing, err := c.store.getLive(ctx, userID, id)
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	if existing == nil || existing.expired(c.now()) {
		response.ErrorFrom(g, ErrShareNotFound)
		return
	}
	if err := c.canPublish(ctx, s, userID, existing.Kind); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	req, err := readShareRequest(g, s)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	if req.Kind != "" && req.Kind != existing.Kind {
		response.ErrorFrom(g, invalidShare("kind", "A share keeps its kind."))
		return
	}
	title := titleOf(req)
	if title == "" {
		title = existing.Title
	}
	body, err := normalizeSnapshot(req.Snapshot, existing.Kind, title, limitsOf(s))
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	row, err := c.store.updateSnapshot(ctx, userID, id, req.Snapshot.Title, body, c.now())
	if err != nil {
		c.writeStoreError(g, err)
		return
	}
	base, _ := c.publicBase(ctx, s)
	response.Success(g, c.shareView(ctx, row, base))
}

// GET /api/v1/claudex/shares?kind=&source_key=&page=&page_size= (the
// user's live shares, newest first, without content). Listing and deleting
// keep working while sharing is off, so users can always clean up.
func (c *Component) listShares(g *gin.Context) {
	userID, ok := core.Subject(g)
	if !ok {
		response.ErrorFrom(g, infraerrors.Unauthorized("UNAUTHORIZED", "Sign in first."))
		return
	}
	kind := Kind(strings.TrimSpace(g.Query("kind")))
	if kind != "" && kind != KindConversation && kind != KindArtifact {
		response.ErrorFrom(g, invalidFilter("kind"))
		return
	}
	var sourceKey string
	if raw := g.Query("source_key"); raw != "" {
		var ok bool
		if sourceKey, ok = SourceKey(raw); !ok {
			response.ErrorFrom(g, invalidFilter("source_key"))
			return
		}
	}
	page, size := pageParams(g, maxUserPageSize)
	ctx := g.Request.Context()
	if !c.hasDB() {
		response.Paginated(g, []ShareDTO{}, 0, page, size)
		return
	}
	rows, total, err := c.store.listUser(ctx, userID, kind, sourceKey, c.now(), page, size)
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	base, _ := c.publicBase(ctx, c.setting.Cached(ctx))
	items := make([]ShareDTO, 0, len(rows))
	for i := range rows {
		items = append(items, c.shareView(ctx, &rows[i], base))
	}
	g.Header("Cache-Control", "no-store")
	response.Paginated(g, items, total, page, size)
}

// GET /api/v1/claudex/shares/:id
func (c *Component) getShare(g *gin.Context) {
	userID, ok := core.Subject(g)
	if !ok {
		response.ErrorFrom(g, infraerrors.Unauthorized("UNAUTHORIZED", "Sign in first."))
		return
	}
	id, ok := idParam(g, "id")
	if !ok || !c.hasDB() {
		response.ErrorFrom(g, ErrShareNotFound)
		return
	}
	ctx := g.Request.Context()
	row, err := c.store.getLive(ctx, userID, id)
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	if row == nil || row.expired(c.now()) {
		response.ErrorFrom(g, ErrShareNotFound)
		return
	}
	base, _ := c.publicBase(ctx, c.setting.Cached(ctx))
	g.Header("Cache-Control", "no-store")
	response.Success(g, c.shareView(ctx, row, base))
}

// DELETE /api/v1/claudex/shares/:id: stop sharing. The link dies at once,
// the content is deleted and the token is never reused. Idempotent: an
// unknown, foreign or already revoked id answers revoked:false.
func (c *Component) deleteShare(g *gin.Context) {
	userID, ok := core.Subject(g)
	if !ok {
		response.ErrorFrom(g, infraerrors.Unauthorized("UNAUTHORIZED", "Sign in first."))
		return
	}
	id, ok := idParam(g, "id")
	if !ok || !c.hasDB() {
		response.Success(g, gin.H{"revoked": false})
		return
	}
	done, err := c.store.revoke(g.Request.Context(), userID, id, c.now())
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	middleware.SetAuditExtra(g, map[string]any{"result": map[bool]string{true: "revoked", false: "not_found"}[done]})
	response.Success(g, gin.H{"revoked": done})
}

func (c *Component) writeStoreError(g *gin.Context, err error) {
	switch {
	case errors.Is(err, ErrQuota):
		response.ErrorFrom(g, ErrQuota)
	case errors.Is(err, ErrShareDisabled):
		response.ErrorFrom(g, ErrShareDisabled)
	case errors.Is(err, ErrShareNotFound):
		response.ErrorFrom(g, ErrShareNotFound)
	default:
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
	}
}

// requestBody is the request body, never nil.
func requestBody(g *gin.Context) io.ReadCloser {
	if g.Request.Body == nil {
		return http.NoBody
	}
	return g.Request.Body
}

func idParam(g *gin.Context, name string) (int64, bool) {
	id, err := strconv.ParseInt(g.Param(name), 10, 64)
	return id, err == nil && id > 0
}

// pageParams reads page and page_size (at most max).
func pageParams(g *gin.Context, max int) (page, size int) {
	page, size = response.ParsePagination(g)
	if size > max {
		size = max
	}
	return page, size
}
