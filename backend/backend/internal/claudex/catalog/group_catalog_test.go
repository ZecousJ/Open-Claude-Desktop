//go:build unit

package catalog

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"
)

// A group lists every model its key gets: described ones by their shared
// description, others by their id after them; placements put them in the
// main menu, under More models or nowhere; the first of the main menu is
// the default whatever an entry says.
func TestResolveGroupListsTheGroupsModels(t *testing.T) {
	g := int64(4)
	rows := []Row{
		{ID: 1, ModelID: "gpt-6", DisplayName: "GPT-6", SortOrder: 10, IsDefault: true},
		{ID: 2, ModelID: "gpt-6-mini", DisplayName: "GPT-6 mini", SortOrder: 20},
		{ID: 3, ModelID: "gpt-old", DisplayName: "GPT old", SortOrder: 30, Hidden: true},
		{ID: 4, ModelID: "not-listed", DisplayName: "Elsewhere", SortOrder: 1},
	}
	listed := []string{"gpt-6", "gpt-6-mini", "gpt-old", "claude-new", "gpt-gone"}
	cat := ResolveGroup(rows, []Placement{
		{ModelID: "gpt-6", Placement: PlacementMore},
		{ModelID: "gpt-gone", Placement: PlacementHidden},
	}, listed, g, "", "openai")

	require.Equal(t, []string{"gpt-6", "gpt-6-mini", "gpt-old", "claude-new"}, ids(cat),
		"hidden and unlisted models are out; an undescribed one comes after the described")
	require.True(t, item(t, cat, "gpt-6").Hidden, "placed under More models")
	require.False(t, item(t, cat, "gpt-6-mini").Hidden)
	require.True(t, item(t, cat, "gpt-old").Hidden, "described as hidden before placements: More models")
	require.False(t, item(t, cat, "claude-new").Hidden, "a new model shows in the main menu")
	require.Equal(t, "claude-new", item(t, cat, "claude-new").DisplayName)
	require.Equal(t, &g, item(t, cat, "claude-new").GroupID)
	require.Equal(t, "gpt-6-mini", *cat.DefaultModel, "the first of the main menu, not the entry marked default")
	require.True(t, item(t, cat, "gpt-6-mini").Default)
	require.False(t, item(t, cat, "gpt-6").Default)

	// A placement's order wins over the description's; main ahead of more.
	cat = ResolveGroup(rows, []Placement{
		{ModelID: "claude-new", Placement: PlacementMain, SortOrder: intp(0)},
		{ModelID: "gpt-old", Placement: PlacementMain},
	}, listed, g, "", "openai")
	require.Equal(t, []string{"claude-new", "gpt-6", "gpt-6-mini", "gpt-old", "gpt-gone"}, ids(cat))
	require.False(t, item(t, cat, "gpt-old").Hidden, "placed back in the main menu")
	require.Equal(t, "claude-new", *cat.DefaultModel)

	// Only More models: the first item is the default.
	cat = ResolveGroup(rows, []Placement{{ModelID: "gpt-6", Placement: PlacementMore}}, []string{"gpt-6", "gpt-old"}, g, "", "openai")
	require.Equal(t, "gpt-6", *cat.DefaultModel)

	// No listing (the gateway cannot say): the described models.
	cat = ResolveGroup(rows, nil, nil, g, "", "openai")
	require.Equal(t, []string{"not-listed", "gpt-6", "gpt-6-mini", "gpt-old"}, ids(cat))

	// The group's chosen default wins, under More models too; when it is
	// hidden or no longer offered the next in menu order takes over.
	cat = ResolveGroup(rows, []Placement{{ModelID: "gpt-old", Placement: PlacementMore, IsDefault: true}}, listed, g, "", "openai")
	require.Equal(t, "gpt-old", *cat.DefaultModel)
	require.True(t, item(t, cat, "gpt-old").Default)
	cat = ResolveGroup(rows, []Placement{{ModelID: "gpt-gone", Placement: PlacementMain, IsDefault: true}},
		[]string{"gpt-6", "gpt-6-mini"}, g, "", "openai")
	require.Equal(t, "gpt-6", *cat.DefaultModel, "the chosen default is no longer offered")

	// Nothing listed: nothing to show.
	cat = ResolveGroup(rows, nil, []string{}, g, "", "openai")
	require.Empty(t, cat.Items)
	require.Nil(t, cat.DefaultModel)
}

func TestNormalizePlacements(t *testing.T) {
	out, err := normalizePlacements([]Placement{
		{ModelID: " gpt-6 ", Placement: PlacementMain, SortOrder: intp(3)},
		{ModelID: "gpt-6", Placement: PlacementHidden},
		{ModelID: "claude", Placement: PlacementMore},
	})
	require.NoError(t, err)
	require.Equal(t, []Placement{
		{ModelID: "gpt-6", Placement: PlacementMain, SortOrder: intp(3)},
		{ModelID: "claude", Placement: PlacementMore},
	}, out, "trimmed, the first entry of a model kept")
	_, err = normalizePlacements([]Placement{{ModelID: "x", Placement: "pinned"}})
	require.Error(t, err)
	_, err = normalizePlacements([]Placement{{ModelID: "a b", Placement: PlacementMain}})
	require.Error(t, err)
	_, err = normalizePlacements([]Placement{{ModelID: "x", Placement: PlacementMain, SortOrder: intp(-1)}})
	require.Error(t, err)
	_, err = normalizePlacements([]Placement{
		{ModelID: "a", Placement: PlacementMain, IsDefault: true},
		{ModelID: "b", Placement: PlacementMore, IsDefault: true},
	})
	require.Error(t, err, "one default")
	_, err = normalizePlacements([]Placement{{ModelID: "a", Placement: PlacementHidden, IsDefault: true}})
	require.Error(t, err, "a hidden model cannot be the default")
}

func TestAdminGroupPlacements(t *testing.T) {
	h := newHarness(t)
	h.seed()
	lister := &fakeLister{byID: map[int64][]string{
		4: {"gpt-5.5", "gpt-5.5-mini", "gpt-4.1", "claude-sonnet-5"},
		5: {"gpt-5.5"},
	}}
	h.c.lister = func() modelLister { return lister }

	rec, env := h.do(http.MethodGet, "/api/v1/admin/claudex/models/groups", nil, "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var listing struct {
		Groups []GroupModels `json:"groups"`
	}
	require.NoError(t, json.Unmarshal(env.Data, &listing))
	require.Len(t, listing.Groups, 3, "every active group")
	g4 := listing.Groups[0]
	require.Equal(t, int64(4), g4.ID)
	require.Equal(t, "claudex-pro", g4.Name)
	var got []string
	for _, m := range g4.Models {
		got = append(got, m.ModelID+":"+m.Placement)
	}
	require.Equal(t, []string{"gpt-5.5:main", "gpt-5.5-mini:main", "gpt-4.1:more", "claude-sonnet-5:main"}, got)
	require.Equal(t, "GPT-5.5", g4.Models[0].DisplayName)
	require.Equal(t, "claude-sonnet-5", g4.Models[3].DisplayName)
	require.Zero(t, g4.Models[3].MetaID, "not described")
	require.True(t, g4.Models[3].Listed)

	stepUps := h.stepUps
	rec, env = h.do(http.MethodPut, "/api/v1/admin/claudex/models/groups/4/placements", nil,
		`{"items":[{"model_id":"claude-sonnet-5","placement":"main","sort_order":0},
		           {"model_id":"gpt-5.5","placement":"more"},
		           {"model_id":"gpt-5.5-mini","placement":"hidden"}]}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, stepUps+1, h.stepUps, "a write steps up")
	var saved GroupModels
	require.NoError(t, json.Unmarshal(env.Data, &saved))
	require.Equal(t, "claude-sonnet-5", saved.Models[0].ModelID)
	require.True(t, saved.Models[0].Configured)

	// The group's catalog follows at once (the cache was cleared).
	rec, env = h.user("/api/v1/claudex/models?group_id=4")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	cat := decodeCatalog(t, env)
	require.Equal(t, []string{"claude-sonnet-5", "gpt-5.5", "gpt-4.1"}, ids(cat), "the mini is hidden")
	require.Equal(t, "claude-sonnet-5", *cat.DefaultModel)
	require.True(t, item(t, cat, "gpt-5.5").Hidden, "under More models")

	rec, _ = h.do(http.MethodPut, "/api/v1/admin/claudex/models/groups/4/placements", nil,
		`{"items":[{"model_id":"x","placement":"top"}]}`)
	require.Equal(t, http.StatusBadRequest, rec.Code)
	rec, _ = h.do(http.MethodPut, "/api/v1/admin/claudex/models/groups/404/placements", nil, `{"items":[]}`)
	require.Equal(t, http.StatusBadRequest, rec.Code, "an unknown group")
}

// A dated snapshot the administrator did not place goes where its model was
// placed; one placed itself keeps its own placement.
func TestResolveGroupSnapshotsFollowTheirModel(t *testing.T) {
	g := int64(4)
	listed := []string{"claude-opus-5-5", "claude-opus-4-5", "claude-opus-4-5-20251101",
		"claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-sonnet-4-5-20250929", "claude-x-1234"}
	cat := ResolveGroup(nil, []Placement{
		{ModelID: "claude-opus-4-5", Placement: PlacementHidden},
		{ModelID: "claude-haiku-4-5", Placement: PlacementMore, SortOrder: intp(3), IsDefault: true},
	}, listed, g, "", "anthropic")
	require.Equal(t, []string{"claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-opus-5-5", "claude-sonnet-4-5-20250929", "claude-x-1234"}, ids(cat),
		"the hidden snapshot is out; order by sort order, then id")
	require.True(t, item(t, cat, "claude-haiku-4-5-20251001").Hidden, "under More models with its model")
	require.False(t, item(t, cat, "claude-sonnet-4-5-20250929").Hidden, "its model is not placed: the main menu")
	require.False(t, item(t, cat, "claude-x-1234").Hidden, "not a dated snapshot")
	require.Equal(t, "claude-haiku-4-5", *cat.DefaultModel, "the default stays the model's, not its snapshot's")

	base, ok := snapshotBase("claude-opus-4-5-20251101")
	require.True(t, ok)
	require.Equal(t, "claude-opus-4-5", base)
	_, ok = snapshotBase("gpt-5.5")
	require.False(t, ok)
}
