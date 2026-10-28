package catalog

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
)

// GroupModel is one model of a group as the console's group view lists it.
type GroupModel struct {
	ModelID string `json:"model_id"`
	// Placement is where the group shows it (main when not configured).
	Placement string `json:"placement"`
	// Configured: the group has a placement row for it.
	Configured bool `json:"configured"`
	// SortOrder is the placement's own order (null: the description's).
	SortOrder *int `json:"sort_order"`
	// Order is the effective order the menus use.
	Order int `json:"order"`
	// Listed: the group's key gets the model (/v1/models); a placement of a
	// model the key no longer gets is kept but shows nowhere.
	Listed bool `json:"listed"`
	// IsDefault: the group chose it as its default model.
	IsDefault bool `json:"is_default"`
	// MetaID is the shared description's id (0: not described).
	MetaID      int64  `json:"meta_id"`
	DisplayName string `json:"display_name"`
}

// GroupModels is one group's models (GET /models/groups).
type GroupModels struct {
	ID       int64        `json:"id"`
	Name     string       `json:"name"`
	Platform string       `json:"platform"`
	Models   []GroupModel `json:"models"`
}

// groupModels lists the group's models: what its key gets, then placements
// of models it no longer gets, ordered as the menus order them.
func (c *Component) groupModels(ctx context.Context, grp *service.Group) (*GroupModels, error) {
	rows, err := c.store.Scope(ctx, grp.ID)
	if err != nil {
		return nil, err
	}
	places, err := c.placementsOf(ctx, grp.ID)
	if err != nil {
		return nil, err
	}
	listed := c.listedModels(ctx, grp)
	meta := map[string]Row{}
	for _, r := range rows {
		if r.GroupDeleted {
			continue
		}
		cur, ok := meta[r.ModelID]
		// The group's own row replaces the global one.
		if !ok || (cur.GroupID == nil && r.GroupID != nil) {
			meta[r.ModelID] = r
		}
	}
	if listed == nil {
		for id := range meta {
			listed = append(listed, id)
		}
	}
	placed := map[string]Placement{}
	for _, p := range places {
		placed[p.ModelID] = p
	}
	out := &GroupModels{ID: grp.ID, Name: grp.Name, Platform: grp.Platform, Models: []GroupModel{}}
	seen := map[string]bool{}
	add := func(id string, isListed bool) {
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			return
		}
		seen[id] = true
		m := GroupModel{ModelID: id, Placement: PlacementMain, Listed: isListed, DisplayName: id, Order: unplacedSort}
		if r, ok := meta[id]; ok {
			m.MetaID, m.Order = r.ID, r.SortOrder
			if r.DisplayName != "" {
				m.DisplayName = r.DisplayName
			}
			if r.Hidden {
				m.Placement = PlacementMore // as ResolveGroup reads it
			}
		}
		if p, ok := placed[id]; ok {
			m.Configured, m.Placement, m.SortOrder, m.IsDefault = true, p.Placement, p.SortOrder, p.IsDefault
			if p.SortOrder != nil {
				m.Order = *p.SortOrder
			}
		}
		out.Models = append(out.Models, m)
	}
	for _, id := range listed {
		add(id, true)
	}
	for _, p := range places {
		add(p.ModelID, false)
	}
	sort.SliceStable(out.Models, func(i, j int) bool {
		a, b := out.Models[i], out.Models[j]
		if a.Order != b.Order {
			return a.Order < b.Order
		}
		return a.ModelID < b.ModelID
	})
	return out, nil
}

// adminGroups: GET /api/v1/admin/claudex/models/groups — every active
// group with its models and where it shows them.
func (c *Component) adminGroups(g *gin.Context) {
	groups := c.groupReader()
	if groups == nil {
		response.ErrorFrom(g, errNoGroups)
		return
	}
	active, err := groups.ListActive(g.Request.Context())
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	sort.Slice(active, func(i, j int) bool { return active[i].ID < active[j].ID })
	if len(active) > maxCandidateGroups {
		active = active[:maxCandidateGroups]
	}
	out := make([]*GroupModels, 0, len(active))
	for i := range active {
		gm, err := c.groupModels(g.Request.Context(), &active[i])
		if err != nil {
			response.ErrorFrom(g, err)
			return
		}
		out = append(out, gm)
	}
	response.Success(g, gin.H{"groups": out})
}

// adminSetPlacements: PUT /api/v1/admin/claudex/models/groups/:id/placements
// {items: [{model_id, placement, sort_order}]} replaces the group's
// placements and answers the group as GET lists it.
func (c *Component) adminSetPlacements(g *gin.Context) {
	id, err := pathID(g)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	places, ok := c.store.(placementStore)
	if !ok {
		response.ErrorFrom(g, errNoDB)
		return
	}
	groups := c.groupReader()
	if groups == nil {
		response.ErrorFrom(g, errNoGroups)
		return
	}
	grp, err := groups.GetByIDLite(g.Request.Context(), id)
	if errors.Is(err, service.ErrGroupNotFound) || (err == nil && grp == nil) {
		response.ErrorFrom(g, ErrGroupNotFound)
		return
	}
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	raw, err := readBody(g)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	var body struct {
		Items []Placement `json:"items"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		response.ErrorFrom(g, invalid("body", "malformed_json", "The request body must be a JSON object with items"))
		return
	}
	list, err := normalizePlacements(body.Items)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	var by *int64
	if uid, ok := core.Subject(g); ok {
		by = &uid
	}
	err = places.SetPlacements(g.Request.Context(), grp.ID, list, by)
	c.cache.clear()
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	gm, err := c.groupModels(g.Request.Context(), grp)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	response.Success(g, gm)
}
