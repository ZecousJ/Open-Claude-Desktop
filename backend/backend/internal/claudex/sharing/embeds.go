package sharing

// Get embed code: the Publish dialog of a published artifact offers an
// iframe that other sites can show (live claude.ai bundle, 2026-10-12:
// c147e6f61 "Get embed code" with "Allowed domains" and "Embed code", the
// list read and written at /api/published_artifacts/<uuid>/embed_whitelist,
// the frame at <embed base>/public/artifacts/<uuid>/embed). In Claudex a
// published version is an artifact share, so the list belongs to the share
// (claudex_share_embeds) and the frame is GET /s/<token>/embed: the
// artifact's document with frame-ancestors set to the allowed domains, on
// the content host when there is one, like the page's own artifact frames.
// An empty list lets any site embed it.

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"

	"github.com/gin-gonic/gin"
)

// Limits of the allowed-domain list.
const (
	maxEmbedDomains     = 50
	maxEmbedDomainBytes = 253
)

// embedDomainPattern is the live dialog's check of one domain (live
// claude.ai bundle, 2026-10-12): host labels of letters, digits and inner
// hyphens, a top-level label of 2-26 characters, optionally "*." first.
var embedDomainPattern = regexp.MustCompile(`^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9][a-z0-9-]{0,24}[a-z0-9]$`)

// ValidEmbedDomain reports whether d (lower case, trimmed) is a domain the
// list takes.
func ValidEmbedDomain(d string) bool {
	return len(d) <= maxEmbedDomainBytes && embedDomainPattern.MatchString(d)
}

// errEmbedDomains is the 400 for a list with domains the check refuses
// (metadata: the first of them, and how many there were).
func errEmbedDomains(invalid []string) error {
	return infraerrors.BadRequest("CLAUDEX_EMBED_DOMAINS_INVALID", "Some domains are not valid.").
		WithMetadata(map[string]string{"field": "domains", "domain": invalid[0], "count": itoa64(int64(len(invalid)))})
}

// normalizeEmbedDomains trims, lower-cases and de-duplicates a list, keeping
// its order; the second result lists the domains that are not valid.
func normalizeEmbedDomains(in []string) (out, invalid []string) {
	seen := map[string]bool{}
	out = []string{}
	for _, d := range in {
		d = strings.ToLower(strings.TrimSpace(d))
		if d == "" || seen[d] {
			continue
		}
		seen[d] = true
		if !ValidEmbedDomain(d) {
			invalid = append(invalid, d)
			continue
		}
		out = append(out, d)
	}
	return out, invalid
}

// frameAncestors is the CSP frame-ancestors value of an embed: the allowed
// domains as host sources, or any site when there are none.
func frameAncestors(domains []string) string {
	if len(domains) == 0 {
		return "*"
	}
	return strings.Join(domains, " ")
}

// embedStore keeps the allowed domains (claudex_share_embeds; in memory in
// unit tests).
type embedStore interface {
	// embedDomains returns a share's list (empty when it has none).
	embedDomains(ctx context.Context, shareID int64) ([]string, error)
	putEmbedDomains(ctx context.Context, shareID int64, domains []string, now time.Time) error
}

func (s *sqlStore) embedDomains(ctx context.Context, shareID int64) ([]string, error) {
	if s.db == nil {
		return nil, errNoDatabase
	}
	var raw []byte
	err := s.db.QueryRowContext(ctx, `SELECT domains FROM claudex_share_embeds WHERE share_id = $1`, shareID).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return []string{}, nil
	}
	if err != nil {
		return nil, err
	}
	out := []string{}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (s *sqlStore) putEmbedDomains(ctx context.Context, shareID int64, domains []string, now time.Time) error {
	if s.db == nil {
		return errNoDatabase
	}
	raw, err := json.Marshal(domains)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO claudex_share_embeds (share_id, domains, updated_at) VALUES ($1, $2, $3)
ON CONFLICT (share_id) DO UPDATE SET domains = EXCLUDED.domains, updated_at = EXCLUDED.updated_at`,
		shareID, raw, now)
	return err
}

// EmbedDTO answers GET and PUT /shares/:id/embed.
type EmbedDTO struct {
	// Domains are the allowed domains (empty: any site).
	Domains []string `json:"domains"`
	// URL is the iframe address on the public or content host; Path is the
	// same on the server address (join it when URL is "").
	URL  string `json:"url"`
	Path string `json:"path"`
}

func embedPath(token string) string { return sharePath(token) + "/embed" }

// ownArtifactShare finds the caller's live, published artifact share, or
// writes why not.
func (c *Component) ownArtifactShare(g *gin.Context) (*shareRow, bool) {
	userID, ok := core.Subject(g)
	if !ok {
		response.ErrorFrom(g, infraerrors.Unauthorized("UNAUTHORIZED", "Sign in first."))
		return nil, false
	}
	id, ok := idParam(g, "id")
	if !ok || !c.hasDB() || c.embeds == nil {
		response.ErrorFrom(g, ErrShareNotFound)
		return nil, false
	}
	row, err := c.store.getLive(g.Request.Context(), userID, id)
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return nil, false
	}
	if row == nil || row.expired(c.now()) || row.Kind != KindArtifact || row.Status != StatusActive {
		response.ErrorFrom(g, ErrShareNotFound)
		return nil, false
	}
	return row, true
}

func (c *Component) embedView(ctx context.Context, row *shareRow, domains []string) EmbedDTO {
	s := c.setting.Cached(ctx)
	base := s.ContentBaseURL
	if base == "" {
		base, _ = c.publicBase(ctx, s)
	}
	path := embedPath(row.Token)
	out := EmbedDTO{Domains: domains, Path: path}
	if base != "" {
		out.URL = joinBase(base, path)
	}
	return out
}

// GET /api/v1/claudex/shares/:id/embed
func (c *Component) getEmbed(g *gin.Context) {
	row, ok := c.ownArtifactShare(g)
	if !ok {
		return
	}
	ctx := g.Request.Context()
	domains, err := c.embeds.embedDomains(ctx, row.ID)
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	g.Header("Cache-Control", "no-store")
	response.Success(g, c.embedView(ctx, row, domains))
}

// PUT /api/v1/claudex/shares/:id/embed {domains: [...]}: replaces the list;
// 400 CLAUDEX_EMBED_DOMAINS_INVALID when a domain fails the check, nothing
// stored then.
func (c *Component) putEmbed(g *gin.Context) {
	row, ok := c.ownArtifactShare(g)
	if !ok {
		return
	}
	var req struct {
		Domains []string `json:"domains"`
	}
	if err := readSmallJSON(g, &req); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	domains, invalid := normalizeEmbedDomains(req.Domains)
	if len(invalid) > 0 {
		response.ErrorFrom(g, errEmbedDomains(invalid))
		return
	}
	if len(domains) > maxEmbedDomains {
		response.ErrorFrom(g, invalidShare("domains", "Too many domains."))
		return
	}
	ctx := g.Request.Context()
	if err := c.embeds.putEmbedDomains(ctx, row.ID, domains, c.now()); err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	response.Success(g, c.embedView(ctx, row, domains))
}

// GET /s/:token/embed: the published artifact's document for other sites'
// iframes. It is served where the page's artifact documents are (the
// content host when there is one) and only for artifact shares; it runs
// under the renderer's CSP sandbox like the page's own frames.
func (c *Component) getEmbedPage(g *gin.Context) {
	ctx := g.Request.Context()
	s := c.setting.Cached(ctx)
	if s.ContentBaseURL != "" && !onContentHost(s, g.Request.Host) {
		c.notice(g, http.StatusNotFound, NoticeNotFound, "")
		return
	}
	res, err := c.resolveToken(ctx, g.Param("token"), true)
	if err != nil {
		c.pageError(g, err)
		return
	}
	if res.row.Kind != KindArtifact || len(res.snapshot.Artifacts) == 0 || c.embeds == nil {
		c.notice(g, http.StatusNotFound, NoticeNotFound, "")
		return
	}
	domains, err := c.embeds.embedDomains(ctx, res.row.ID)
	if err != nil {
		slog.Warn("claudex sharing: reading embed domains failed", "error", err)
		c.notice(g, http.StatusServiceUnavailable, NoticeNotFound, "")
		return
	}
	v := &ArtifactView{
		Token: res.row.Token, Index: 0, Artifact: res.snapshot.Artifacts[0],
		FrameAncestors: frameAncestors(domains), AssetBase: assetPrefix,
	}
	setPageHeaders(g.Writer)
	if err := currentRenderer().Artifact(g.Writer, v); err != nil {
		slog.Warn("claudex sharing: rendering an embed failed", "error", err)
	}
}
