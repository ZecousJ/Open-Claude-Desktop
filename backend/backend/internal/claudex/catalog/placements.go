package catalog

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/service"
)

// Where a group shows a model (table claudex_model_placements,
// migrations/claudex_0011_model_placements.sql). A group's catalog lists
// every model its key gets (/v1/models, GatewayService.ListedModelIDs); the
// shared description (claudex_model_meta) names and describes it, and the
// placement puts it in the main menu, under More models, or nowhere.
const (
	PlacementMain   = "main"
	PlacementMore   = "more"
	PlacementHidden = "hidden"
)

// maxPlacements bounds one group's placement list (a save replaces it).
const maxPlacements = 500

// Placement is one group's choice for one model.
type Placement struct {
	ModelID   string `json:"model_id"`
	Placement string `json:"placement"`
	// SortOrder orders the model in its list; null keeps the description's.
	SortOrder *int `json:"sort_order"`
	// IsDefault names the group's default model (at most one); the catalog
	// uses it while the model is offered and not hidden.
	IsDefault bool `json:"is_default"`
}

func validPlacement(p string) bool {
	return p == PlacementMain || p == PlacementMore || p == PlacementHidden
}

// placementStore reads and writes the placements of a group.
type placementStore interface {
	Placements(ctx context.Context, groupID int64) ([]Placement, error)
	// SetPlacements replaces the group's placements.
	SetPlacements(ctx context.Context, groupID int64, list []Placement, by *int64) error
}

// normalizePlacements checks a save: known placements, model ids as the
// catalog takes them, one entry per model, sort orders in range, at most one
// default (and not a hidden one).
func normalizePlacements(list []Placement) ([]Placement, error) {
	if len(list) > maxPlacements {
		return nil, invalid("items", "too_many", fmt.Sprintf("At most %d models.", maxPlacements))
	}
	seen := map[string]bool{}
	defaults := 0
	out := make([]Placement, 0, len(list))
	for _, p := range list {
		id := strings.TrimSpace(p.ModelID)
		if id == "" || len(id) > maxModelIDLen || strings.ContainsAny(id, "* \t\r\n") {
			return nil, invalid("model_id", "invalid", "A model id is missing or not valid.")
		}
		if !validPlacement(p.Placement) {
			return nil, invalid("placement", "invalid", "Choose main, more or hidden.")
		}
		if p.SortOrder != nil && (*p.SortOrder < 0 || *p.SortOrder > maxSortOrder) {
			return nil, invalid("sort_order", "range", "The order is out of range.")
		}
		if seen[id] {
			continue
		}
		seen[id] = true
		if p.IsDefault {
			if p.Placement == PlacementHidden {
				return nil, invalid("is_default", "hidden", "A hidden model cannot be the default.")
			}
			if defaults++; defaults > 1 {
				return nil, invalid("is_default", "too_many", "Choose one default model.")
			}
		}
		out = append(out, Placement{ModelID: id, Placement: p.Placement, SortOrder: p.SortOrder, IsDefault: p.IsDefault})
	}
	return out, nil
}

func (s sqlStore) Placements(ctx context.Context, groupID int64) ([]Placement, error) {
	db, err := s.conn()
	if err != nil {
		return nil, err
	}
	rows, err := db.QueryContext(ctx, `SELECT model_id, placement, sort_order, is_default
		FROM claudex_model_placements WHERE group_id = $1 ORDER BY model_id`, groupID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []Placement
	for rows.Next() {
		var p Placement
		var order *int
		if err := rows.Scan(&p.ModelID, &p.Placement, &order, &p.IsDefault); err != nil {
			return nil, err
		}
		p.SortOrder = order
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s sqlStore) SetPlacements(ctx context.Context, groupID int64, list []Placement, by *int64) error {
	db, err := s.conn()
	if err != nil {
		return err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `DELETE FROM claudex_model_placements WHERE group_id = $1`, groupID); err != nil {
		return err
	}
	now := time.Now()
	for _, p := range list {
		if _, err := tx.ExecContext(ctx, `INSERT INTO claudex_model_placements
			(group_id, model_id, placement, sort_order, is_default, updated_by, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			groupID, p.ModelID, p.Placement, p.SortOrder, p.IsDefault, by, now); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// modelLister answers the ids /v1/models lists for a key of a group
// (*service.GatewayService).
type modelLister interface {
	ListedModelIDs(ctx context.Context, group *service.Group) []string
}

// unplacedSort orders a model without a placement order or a description
// after the described ones.
const unplacedSort = maxSortOrder + 1

// ResolveGroup builds a group's catalog from the models its key gets
// (listed), their shared descriptions (rows: global rows, and the group's
// own rows that replace them) and the group's placements:
//   - every listed model is an item unless placed hidden; a model without a
//     placement shows in the main menu (under More models when its
//     description was marked hidden, the meaning hidden had before);
//   - More models items are marked Hidden (the client lists them there);
//   - the order is the placement's, else the description's, else after the
//     described models by id;
//   - the default model is the group's chosen one while it is an item, else
//     the first of the main menu (else the first item).
//
// Without a listing (nil: the gateway cannot say) the described models are
// listed instead.
func ResolveGroup(rows []Row, placements []Placement, listed []string, groupID int64, maxReasoningEffort, platform string) Catalog {
	described := ResolveFor(rows, groupID, maxReasoningEffort, platform)
	byID := make(map[string]Item, len(described.Items))
	for _, item := range described.Items {
		byID[item.ID] = item
	}
	placed := make(map[string]Placement, len(placements))
	for _, p := range placements {
		placed[p.ModelID] = p
	}
	ids := listed
	if ids == nil {
		ids = make([]string, 0, len(described.Items))
		for _, item := range described.Items {
			ids = append(ids, item.ID)
		}
	}
	cat := Catalog{GroupID: described.GroupID, Items: make([]Item, 0, len(ids))}
	seen := map[string]bool{}
	for _, raw := range ids {
		id := strings.TrimSpace(raw)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		p, hasPlacement := placed[id]
		if !hasPlacement {
			// A dated snapshot (claude-opus-4-5-20251101) the administrator
			// did not place goes where its model was placed (owner,
			// 2026-10-02: unplaced snapshots showed in the main menu).
			if base, dated := snapshotBase(id); dated {
				p, hasPlacement = placed[base]
				p.SortOrder = nil
				p.IsDefault = false
			}
		}
		item, ok := byID[id]
		// Without a placement: under More models when its description was
		// marked so before placements existed, else the main menu.
		placement := PlacementMain
		if ok && item.Hidden {
			placement = PlacementMore
		}
		if hasPlacement {
			placement = p.Placement
		}
		if placement == PlacementHidden {
			continue
		}
		if !ok {
			item = Item{ID: id, DisplayName: id, Badges: []string{}, Sort: unplacedSort}
			if groupID > 0 {
				gid := groupID
				item.GroupID = &gid
				item.WebSearch, item.XSearch = searchCapabilities(platform, id)
			} else {
				item.WebSearch = WebSearchNone
			}
		}
		if hasPlacement && p.SortOrder != nil {
			item.Sort = *p.SortOrder
		}
		item.Hidden = placement == PlacementMore
		item.Default = false
		cat.Items = append(cat.Items, item)
	}
	sort.SliceStable(cat.Items, func(i, j int) bool {
		a, b := cat.Items[i], cat.Items[j]
		if a.Sort != b.Sort {
			return a.Sort < b.Sort
		}
		return a.ID < b.ID
	})
	// The default: the group's own choice while it is offered and shown
	// (hidden placements are not items), else the next in menu order, the
	// first of the main menu.
	pick := -1
	for i := range cat.Items {
		if p, ok := placed[cat.Items[i].ID]; ok && p.IsDefault {
			pick = i
			break
		}
	}
	for i := range cat.Items {
		if pick >= 0 {
			break
		}
		if !cat.Items[i].Hidden {
			pick = i
		}
	}
	if pick < 0 && len(cat.Items) > 0 {
		pick = 0
	}
	if pick >= 0 {
		cat.Items[pick].Default = true
		m := cat.Items[pick].ID
		cat.DefaultModel = &m
	}
	return cat
}

// snapshotBase is the model a dated snapshot id names: "claude-opus-4-5"
// for "claude-opus-4-5-20251101" (a trailing -YYYYMMDD).
func snapshotBase(id string) (string, bool) {
	i := strings.LastIndexByte(id, '-')
	if i <= 0 || len(id)-i-1 != 8 {
		return "", false
	}
	for _, r := range id[i+1:] {
		if r < '0' || r > '9' {
			return "", false
		}
	}
	return id[:i], true
}
