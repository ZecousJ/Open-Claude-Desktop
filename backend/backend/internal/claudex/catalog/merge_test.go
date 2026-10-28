package catalog

import (
	"context"
	"net/http"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/stretchr/testify/require"
)

func i64(v int64) *int64 { return &v }

func TestMergeKeepsOneEntryPerModel(t *testing.T) {
	plan := ResolveFor([]Row{
		with(globalRow(1, "gpt-5.5", 10), func(r *Row) { r.IsDefault = true }),
		groupRow(2, 4, "gpt-4.1", 30),
	}, 4, "", service.PlatformOpenAI)
	grok := ResolveFor([]Row{
		with(globalRow(1, "gpt-5.5", 10), func(r *Row) { r.IsDefault = true }),
		with(groupRow(3, 11, "grok-4", 5), func(r *Row) { r.IsDefault = true }),
		groupRow(4, 11, "gpt-4.1", 1), // the plan group lists it too
	}, 11, "", service.PlatformGrok)
	other := ResolveFor([]Row{groupRow(5, 12, "grok-4", 2)}, 12, "", service.PlatformGrok)

	got := Merge(&plan, &grok, &other)
	require.Equal(t, i64(4), got.GroupID)
	require.Equal(t, "gpt-5.5", *got.DefaultModel, "the plan group's default")
	type entry struct {
		id      string
		group   int64
		def     bool
		xSearch bool
	}
	var entries []entry
	for _, it := range got.Items {
		entries = append(entries, entry{it.ID, *it.GroupID, it.Default, it.XSearch})
	}
	require.Equal(t, []entry{
		{"grok-4", 11, false, true},  // group 11 before group 12
		{"gpt-5.5", 4, true, false},  // a global row: the plan group's copy
		{"gpt-4.1", 4, false, false}, // the plan group's own row wins over group 11's
	}, entries, "own rows first, then the plan group, then by group id; ordered by sort")

	// Deterministic, and the cached catalogs are not changed.
	for i := 0; i < 20; i++ {
		require.Equal(t, got, Merge(&plan, &grok, &other))
	}
	require.Equal(t, "grok-4", *grok.DefaultModel)
	for _, it := range grok.Items {
		require.Equal(t, int64(11), *it.GroupID)
	}

	// Without a plan default the next group's default is used.
	plan.DefaultModel = nil
	require.Equal(t, "grok-4", *Merge(&plan, &grok).DefaultModel)
	require.Empty(t, Merge().Items)
}

// fakeKeyGroups is the devices component's KeyGroupSource.
type fakeKeyGroups struct{ ids []int64 }

func (fakeKeyGroups) Name() string { return "devices" }
func (f fakeKeyGroups) KeyGroupIDs(context.Context, int64, *core.PlanRef) ([]int64, error) {
	return f.ids, nil
}

func TestUserModelsMergeTheDeviceGroups(t *testing.T) {
	h := newHarness(t)
	h.groups.groups[5].Platform = service.PlatformGrok
	h.create(`{"model_id":"gpt-5.5","display_name":"GPT-5.5","sort_order":10,"is_default":true}`)
	h.create(`{"model_id":"gpt-4.1","group_id":4,"display_name":"GPT-4.1","sort_order":30}`)
	h.create(`{"model_id":"grok-4","group_id":5,"display_name":"Grok 4","sort_order":20,"is_default":true}`)
	h.c.env.Components = []core.Feature{fakeKeyGroups{ids: []int64{4, 5}}}
	// Each group lists the models its key gets.
	lister := &fakeLister{byID: map[int64][]string{4: {"gpt-5.5", "gpt-4.1"}, 5: {"grok-4"}}}
	h.c.lister = func() modelLister { return lister }

	rec, env := h.user("/api/v1/claudex/models")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	cat := decodeCatalog(t, env)
	require.Equal(t, int64(4), *cat.GroupID)
	require.Equal(t, "gpt-5.5", *cat.DefaultModel)
	byID := map[string]Item{}
	for _, it := range cat.Items {
		byID[it.ID] = it
	}
	require.Len(t, byID, 3)
	require.Equal(t, int64(4), *byID["gpt-5.5"].GroupID)
	require.Equal(t, int64(4), *byID["gpt-4.1"].GroupID)
	require.Equal(t, int64(5), *byID["grok-4"].GroupID)
	require.True(t, byID["grok-4"].XSearch, "search capabilities follow the item's group")
	require.False(t, byID["grok-4"].Default)

	// An explicit group is that group's catalog only.
	rec, env = h.user("/api/v1/claudex/models?group_id=5")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	one := decodeCatalog(t, env)
	require.Equal(t, int64(5), *one.GroupID)
	require.Equal(t, "grok-4", *one.DefaultModel)

	// Bootstrap "models" is the merged catalog too.
	out, err := h.c.BootstrapSections(context.Background(), &core.BootstrapContext{UserID: 7, Plan: &core.PlanRef{GroupID: 4}})
	require.NoError(t, err)
	merged, _ := out[core.SectionModels].(*Catalog)
	require.Len(t, merged.Items, 3)
}
