package catalog

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
)

func globalRow(id int64, model string, sort int) Row {
	return Row{ID: id, ModelID: model, SortOrder: sort, Badges: []string{}}
}

func groupRow(id int64, group int64, model string, sort int) Row {
	r := globalRow(id, model, sort)
	r.GroupID = i64p(group)
	return r
}

func with(r Row, f func(*Row)) Row {
	f(&r)
	return r
}

func ids(cat Catalog) []string {
	out := make([]string, 0, len(cat.Items))
	for _, it := range cat.Items {
		out = append(out, it.ID)
	}
	return out
}

func item(t *testing.T, cat Catalog, id string) Item {
	t.Helper()
	for _, it := range cat.Items {
		if it.ID == id {
			return it
		}
	}
	t.Fatalf("no item %q in %v", id, ids(cat))
	return Item{}
}

func TestResolveTable(t *testing.T) {
	efforts := func(e ...string) func(*Row) {
		return func(r *Row) { r.SupportedEfforts = e }
	}
	cases := []struct {
		name        string
		rows        []Row
		group       int64
		maxEffort   string
		wantIDs     []string
		wantDefault *string
		check       func(t *testing.T, cat Catalog)
	}{
		{
			name:    "minimum desktop version reaches the client catalog",
			rows:    []Row{with(globalRow(1, "gpt-5.5", 10), func(r *Row) { r.MinimumDesktopVersion = "1.2.3" })},
			wantIDs: []string{"gpt-5.5"},
			check:   func(t *testing.T, cat Catalog) { require.Equal(t, "1.2.3", cat.Items[0].MinimumDesktopVersion) },
		},
		{
			name:    "empty catalog",
			wantIDs: []string{},
			check: func(t *testing.T, cat Catalog) {
				require.Nil(t, cat.GroupID)
				raw, err := json.Marshal(cat)
				require.NoError(t, err)
				require.JSONEq(t, `{"group_id":null,"default_model":null,"items":[]}`, string(raw))
			},
		},
		{
			name: "group row replaces the global row entirely",
			rows: []Row{
				with(globalRow(1, "gpt-5.5", 10), func(r *Row) {
					r.DisplayName, r.Description, r.UsageHint = "GPT-5.5", "global", "1×"
					r.ContextWindow, r.FastTier = intp(400000), boolp(true)
				}),
				with(groupRow(2, 4, "gpt-5.5", 30), func(r *Row) { r.DisplayName = "GPT-5.5 (team)" }),
				globalRow(3, "gpt-5.5-mini", 20),
			},
			group:   4,
			wantIDs: []string{"gpt-5.5-mini", "gpt-5.5"},
			check: func(t *testing.T, cat Catalog) {
				require.Equal(t, int64(4), *cat.GroupID)
				it := item(t, cat, "gpt-5.5")
				require.Equal(t, "GPT-5.5 (team)", it.DisplayName)
				require.Equal(t, "", it.Description, "no field is inherited from the global row")
				require.Equal(t, "", it.UsageHint)
				require.Nil(t, it.ContextWindow)
				require.Equal(t, 30, it.Sort)
			},
		},
		{
			name: "rows of other groups and of deleted groups are ignored",
			rows: []Row{
				globalRow(1, "a", 1),
				groupRow(2, 5, "b", 2),
				with(groupRow(3, 4, "c", 3), func(r *Row) { r.GroupDeleted = true }),
				with(groupRow(4, 4, "a", 9), func(r *Row) { r.GroupDeleted = true; r.DisplayName = "stale" }),
				with(groupRow(5, 4, "d", 0), func(r *Row) { r.GroupDeleted = true; r.IsDefault = true }),
			},
			group:   4,
			wantIDs: []string{"a"},
			check: func(t *testing.T, cat Catalog) {
				require.Equal(t, "a", item(t, cat, "a").DisplayName, "display name falls back to the model id")
				require.Nil(t, cat.DefaultModel, "a deleted group's default does not count")
			},
		},
		{
			name:    "no group: only global rows",
			rows:    []Row{globalRow(1, "a", 1), groupRow(2, 4, "b", 2)},
			wantIDs: []string{"a"},
		},
		{
			name: "hidden rows are still sent",
			rows: []Row{
				with(globalRow(1, "legacy", 5), func(r *Row) { r.Hidden = true; r.Badges = []string{"legacy"} }),
				globalRow(2, "new", 1),
			},
			wantIDs: []string{"new", "legacy"},
			check: func(t *testing.T, cat Catalog) {
				it := item(t, cat, "legacy")
				require.True(t, it.Hidden)
				require.Equal(t, []string{"legacy"}, it.Badges)
			},
		},
		{
			name:    "sort order then model id",
			rows:    []Row{globalRow(1, "b", 1), globalRow(2, "a", 1), globalRow(3, "c", -5)},
			wantIDs: []string{"c", "a", "b"},
		},
		{
			name: "group default wins over the global default",
			rows: []Row{
				with(globalRow(1, "a", 1), func(r *Row) { r.IsDefault = true }),
				with(groupRow(2, 4, "b", 2), func(r *Row) { r.IsDefault = true }),
			},
			group:       4,
			wantIDs:     []string{"a", "b"},
			wantDefault: strp("b"),
			check: func(t *testing.T, cat Catalog) {
				require.False(t, item(t, cat, "a").Default)
				require.True(t, item(t, cat, "b").Default)
			},
		},
		{
			name: "global default when the group has none",
			rows: []Row{
				with(globalRow(1, "a", 1), func(r *Row) { r.IsDefault = true }),
				groupRow(2, 4, "b", 2),
			},
			group:       4,
			wantIDs:     []string{"a", "b"},
			wantDefault: strp("a"),
		},
		{
			name: "global default survives a group row of the same model",
			rows: []Row{
				with(globalRow(1, "a", 1), func(r *Row) { r.IsDefault = true }),
				with(groupRow(2, 4, "a", 1), func(r *Row) { r.Description = "team" }),
			},
			group:       4,
			wantIDs:     []string{"a"},
			wantDefault: strp("a"),
			check: func(t *testing.T, cat Catalog) {
				it := item(t, cat, "a")
				require.True(t, it.Default)
				require.Equal(t, "team", it.Description)
			},
		},
		{
			name:    "no default anywhere",
			rows:    []Row{globalRow(1, "a", 1)},
			wantIDs: []string{"a"},
		},
		{
			name: "null efforts: no efforts field",
			rows: []Row{globalRow(1, "a", 1)},
			check: func(t *testing.T, cat Catalog) {
				raw, err := json.Marshal(cat.Items[0])
				require.NoError(t, err)
				require.NotContains(t, string(raw), `"efforts"`)
				require.NotContains(t, string(raw), `"default_effort"`)
				require.Contains(t, string(raw), `"context_window":null`)
				require.Contains(t, string(raw), `"auto_compact_tokens":null`)
				require.Contains(t, string(raw), `"badges":[]`)
			},
			wantIDs: []string{"a"},
		},
		{
			name:      "efforts cut to the group ceiling, default kept",
			rows:      []Row{with(globalRow(1, "a", 1), func(r *Row) { efforts("low", "medium", "high", "xhigh", "max")(r); r.DefaultEffort = "medium" })},
			group:     4,
			maxEffort: "high",
			wantIDs:   []string{"a"},
			check: func(t *testing.T, cat Catalog) {
				it := item(t, cat, "a")
				require.Equal(t, []string{"low", "medium", "high"}, *it.Efforts)
				require.Equal(t, "medium", it.DefaultEffort)
			},
		},
		{
			name:      "cut default falls back to the middle",
			rows:      []Row{with(globalRow(1, "a", 1), func(r *Row) { efforts("minimal", "low", "medium", "high", "xhigh")(r); r.DefaultEffort = "xhigh" })},
			group:     4,
			maxEffort: "high",
			wantIDs:   []string{"a"},
			check: func(t *testing.T, cat Catalog) {
				it := item(t, cat, "a")
				require.Equal(t, []string{"minimal", "low", "medium", "high"}, *it.Efforts)
				require.Equal(t, "low", it.DefaultEffort, "lower middle of four")
			},
		},
		{
			name:      "no configured default: middle of what is left",
			rows:      []Row{with(globalRow(1, "a", 1), efforts("low", "medium", "high"))},
			group:     4,
			maxEffort: "",
			wantIDs:   []string{"a"},
			check: func(t *testing.T, cat Catalog) {
				require.Equal(t, "medium", item(t, cat, "a").DefaultEffort)
			},
		},
		{
			name:      "none is never cut",
			rows:      []Row{with(globalRow(1, "a", 1), func(r *Row) { efforts("none", "minimal", "low", "medium")(r); r.DefaultEffort = "none" })},
			group:     4,
			maxEffort: "minimal",
			wantIDs:   []string{"a"},
			check: func(t *testing.T, cat Catalog) {
				it := item(t, cat, "a")
				require.Equal(t, []string{"none", "minimal"}, *it.Efforts)
				require.Equal(t, "none", it.DefaultEffort)
			},
		},
		{
			name:      "everything cut: empty list, no default effort",
			rows:      []Row{with(globalRow(1, "a", 1), func(r *Row) { efforts("xhigh", "max")(r); r.DefaultEffort = "max" })},
			group:     4,
			maxEffort: "low",
			wantIDs:   []string{"a"},
			check: func(t *testing.T, cat Catalog) {
				it := item(t, cat, "a")
				require.NotNil(t, it.Efforts)
				require.Empty(t, *it.Efforts)
				require.Equal(t, "", it.DefaultEffort)
				raw, err := json.Marshal(it)
				require.NoError(t, err)
				require.Contains(t, string(raw), `"efforts":[]`)
			},
		},
		{
			name:      "ceiling spelled like upstream (Extra-High) and max",
			rows:      []Row{with(globalRow(1, "a", 1), efforts("high", "xhigh", "max"))},
			group:     4,
			maxEffort: "Extra-High",
			wantIDs:   []string{"a"},
			check: func(t *testing.T, cat Catalog) {
				require.Equal(t, []string{"high", "xhigh"}, *item(t, cat, "a").Efforts)
			},
		},
		{
			name:      "unknown ceiling cuts nothing (upstream treats it as unlimited)",
			rows:      []Row{with(globalRow(1, "a", 1), efforts("low", "max"))},
			group:     4,
			maxEffort: "turbo",
			wantIDs:   []string{"a"},
			check: func(t *testing.T, cat Catalog) {
				require.Equal(t, []string{"low", "max"}, *item(t, cat, "a").Efforts)
			},
		},
		{
			name:      "no group: the ceiling argument is only a group setting",
			rows:      []Row{with(globalRow(1, "a", 1), efforts("low", "empty-ignored"))},
			maxEffort: "",
			wantIDs:   []string{"a"},
			check: func(t *testing.T, cat Catalog) {
				require.Equal(t, []string{"low"}, *item(t, cat, "a").Efforts, "unknown stored values are dropped")
			},
		},
		{
			name: "context window and usage hint pass through; fast_tier is not sent (R6)",
			rows: []Row{with(globalRow(1, "a", 1), func(r *Row) {
				r.FastTier, r.ContextWindow, r.AutoCompactTokens, r.UsageHint = boolp(true), intp(200000), intp(150000), "2× usage"
			})},
			wantIDs: []string{"a"},
			check: func(t *testing.T, cat Catalog) {
				it := item(t, cat, "a")
				raw, err := json.Marshal(it)
				require.NoError(t, err)
				require.NotContains(t, string(raw), `"fast"`)
				require.Equal(t, 200000, *it.ContextWindow)
				require.Equal(t, 150000, *it.AutoCompactTokens)
				require.Equal(t, "2× usage", it.UsageHint)
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cat := Resolve(tc.rows, tc.group, tc.maxEffort)
			require.Equal(t, tc.wantIDs, ids(cat))
			if tc.wantDefault == nil {
				require.Nil(t, cat.DefaultModel)
			} else {
				require.NotNil(t, cat.DefaultModel)
				require.Equal(t, *tc.wantDefault, *cat.DefaultModel)
			}
			if tc.check != nil {
				tc.check(t, cat)
			}
		})
	}
}

func TestResolveSearchCapabilitiesFollowThePlatform(t *testing.T) {
	rows := []Row{
		globalRow(1, "grok-4", 1),
		globalRow(2, "gpt-5.5", 2),
		globalRow(3, "o4-mini", 3),
		globalRow(4, "kimi-k2", 4),
	}
	type caps struct {
		web string
		x   bool
	}
	cases := []struct {
		name     string
		group    int64
		platform string
		want     map[string]caps
	}{
		{"no group: nothing is searchable", 0, "grok", map[string]caps{
			"grok-4": {"none", false}, "gpt-5.5": {"none", false}, "o4-mini": {"none", false}, "kimi-k2": {"none", false},
		}},
		{"grok group: web and X", 4, "grok", map[string]caps{
			"grok-4": {"native", true}, "gpt-5.5": {"native", true}, "o4-mini": {"native", true}, "kimi-k2": {"native", true},
		}},
		{"openai group: web only", 4, "openai", map[string]caps{
			"grok-4": {"native", false}, "gpt-5.5": {"native", false}, "o4-mini": {"native", false}, "kimi-k2": {"native", false},
		}},
		{"anthropic group: Claude's own web search", 4, "anthropic", map[string]caps{
			"grok-4": {"native", false}, "gpt-5.5": {"native", false}, "o4-mini": {"native", false}, "kimi-k2": {"native", false},
		}},
		{"other platforms: none", 4, "deepseek", map[string]caps{
			"grok-4": {"none", false}, "gpt-5.5": {"none", false}, "o4-mini": {"none", false}, "kimi-k2": {"none", false},
		}},
		{"composite group: by model family", 4, "composite", map[string]caps{
			"grok-4": {"native", true}, "gpt-5.5": {"native", false}, "o4-mini": {"native", false}, "kimi-k2": {"none", false},
		}},
		{"platform case and spaces do not matter", 4, " OpenAI ", map[string]caps{
			"grok-4": {"native", false}, "gpt-5.5": {"native", false}, "o4-mini": {"native", false}, "kimi-k2": {"native", false},
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cat := ResolveFor(rows, tc.group, "", tc.platform)
			for id, want := range tc.want {
				it := item(t, cat, id)
				require.Equal(t, want.web, it.WebSearch, id)
				require.Equal(t, want.x, it.XSearch, id)
			}
		})
	}
	// Resolve is ResolveFor without a platform: nothing is searchable.
	require.Equal(t, "none", item(t, Resolve(rows, 4, ""), "grok-4").WebSearch)
	raw, err := json.Marshal(item(t, ResolveFor(rows, 4, "", "grok"), "grok-4"))
	require.NoError(t, err)
	require.Contains(t, string(raw), `"web_search":"native","x_search":true`)
}

func TestResolveDoesNotShareSlicesWithRows(t *testing.T) {
	rows := []Row{with(globalRow(1, "a", 1), func(r *Row) { r.Badges = []string{"new"}; r.SupportedEfforts = []string{"low"} })}
	cat := Resolve(rows, 0, "")
	cat.Items[0].Badges[0] = "changed"
	(*cat.Items[0].Efforts)[0] = "changed"
	require.Equal(t, "new", rows[0].Badges[0])
	require.Equal(t, "low", rows[0].SupportedEfforts[0])
}
