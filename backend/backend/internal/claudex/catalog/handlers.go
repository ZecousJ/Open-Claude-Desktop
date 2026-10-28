package catalog

import (
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
)

const (
	defaultPageSize = 50
	maxPageSize     = 200
	maxPage         = 1_000_000 // keeps OFFSET far from overflowing
)

var errUnauthorized = infraerrors.Unauthorized("UNAUTHORIZED", "Authorization required")

// optionalGroupID reads ?group_id=. A missing, malformed or non-positive
// value is nil: the plan resolver then picks the user's plan group, exactly
// like a group the user cannot use.
func optionalGroupID(c *gin.Context) *int64 {
	raw := strings.TrimSpace(c.Query("group_id"))
	if raw == "" {
		return nil
	}
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || id <= 0 {
		return nil
	}
	return &id
}

// getModels: GET /api/v1/claudex/models?group_id=.
func (c *Component) getModels(g *gin.Context) {
	userID, ok := core.Subject(g)
	if !ok {
		response.ErrorFrom(g, errUnauthorized)
		return
	}
	cat, err := c.catalogForUser(g.Request.Context(), userID, optionalGroupID(g))
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	core.WriteJSONWithETag(g, cat)
}

// adminList: GET /api/v1/admin/claudex/models?group_id=&q=&page=&page_size=.
// group_id absent = every row, 0 or "global" = global rows, N = rows of
// group N.
func (c *Component) adminList(g *gin.Context) {
	f := listFilter{Scope: scopeAll, Query: g.Query("q"), Page: 1, PageSize: defaultPageSize}
	switch raw := strings.TrimSpace(g.Query("group_id")); strings.ToLower(raw) {
	case "":
	case "0", "global", "null":
		f.Scope = scopeGlobal
	default:
		id, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || id <= 0 {
			response.ErrorFrom(g, invalid("group_id", "positive", "group_id must be a positive number, 0 or global"))
			return
		}
		f.Scope, f.GroupID = scopeGroup, id
	}
	if q := []rune(strings.TrimSpace(f.Query)); len(q) > maxModelIDLen {
		f.Query = string(q[:maxModelIDLen])
	}
	if v, err := strconv.Atoi(g.Query("page")); err == nil && v > 0 {
		f.Page = min(v, maxPage)
	}
	if v, err := strconv.Atoi(g.Query("page_size")); err == nil && v > 0 {
		f.PageSize = min(v, maxPageSize)
	}
	rows, total, err := c.store.List(g.Request.Context(), f)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	response.Paginated(g, rows, total, f.Page, f.PageSize)
}

func readBody(g *gin.Context) ([]byte, error) {
	raw, err := io.ReadAll(http.MaxBytesReader(g.Writer, g.Request.Body, maxBodyBytes))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return nil, invalid("body", "too_large", "The request body is too large")
		}
		return nil, invalid("body", "unreadable", "The request body could not be read")
	}
	return raw, nil
}

// adminCreate: POST /api/v1/admin/claudex/models.
func (c *Component) adminCreate(g *gin.Context) {
	raw, err := readBody(g)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	in, _, err := decodeInput(raw)
	if err == nil {
		err = normalize(&in)
	}
	if err == nil && in.GroupID != nil {
		err = c.checkGroup(g, *in.GroupID)
	}
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	var createdBy *int64
	if uid, ok := core.Subject(g); ok {
		createdBy = &uid
	}
	row, err := c.store.Create(g.Request.Context(), in, createdBy)
	c.cache.clear()
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	response.Success(g, row)
}

// checkGroup rejects a group that does not exist or was deleted.
func (c *Component) checkGroup(g *gin.Context, groupID int64) error {
	groups := c.groupReader()
	if groups == nil {
		return errNoGroups
	}
	grp, err := groups.GetByIDLite(g.Request.Context(), groupID)
	if errors.Is(err, service.ErrGroupNotFound) || (err == nil && grp == nil) {
		return ErrGroupNotFound
	}
	return err
}

func pathID(g *gin.Context) (int64, error) {
	id, err := strconv.ParseInt(g.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		return 0, invalid("id", "positive", "Invalid catalog entry id")
	}
	return id, nil
}

// adminUpdate: PUT /api/v1/admin/claudex/models/:id. Same body as POST;
// model_id and group_id cannot change (a different value is 400, leaving
// them out keeps them).
func (c *Component) adminUpdate(g *gin.Context) {
	id, err := pathID(g)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	raw, err := readBody(g)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	in, present, err := decodeInput(raw)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	existing, err := c.store.Get(g.Request.Context(), id)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	if present["model_id"] && strings.TrimSpace(in.ModelID) != existing.ModelID {
		response.ErrorFrom(g, invalid("model_id", "immutable", "The model of a catalog entry cannot change; add a new entry instead"))
		return
	}
	if present["group_id"] && !sameGroup(in.GroupID, existing.GroupID) {
		response.ErrorFrom(g, invalid("group_id", "immutable", "The group of a catalog entry cannot change; add a new entry instead"))
		return
	}
	in.ModelID, in.GroupID = existing.ModelID, existing.GroupID
	if err := normalize(&in); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	row, err := c.store.Update(g.Request.Context(), id, in)
	c.cache.clear()
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	response.Success(g, row)
}

func sameGroup(a, b *int64) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// adminDelete: DELETE /api/v1/admin/claudex/models/:id.
func (c *Component) adminDelete(g *gin.Context) {
	id, err := pathID(g)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	err = c.store.Delete(g.Request.Context(), id)
	c.cache.clear()
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	response.Success(g, gin.H{"deleted": true})
}

// adminCandidates: GET /api/v1/admin/claudex/models/candidates?group_id=.
func (c *Component) adminCandidates(g *gin.Context) {
	var groupID *int64
	if raw := strings.TrimSpace(g.Query("group_id")); raw != "" {
		id, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || id <= 0 {
			response.ErrorFrom(g, invalid("group_id", "positive", "group_id must be a positive number"))
			return
		}
		groupID = &id
	}
	out, err := c.candidates(g.Request.Context(), groupID)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	response.Success(g, out)
}
