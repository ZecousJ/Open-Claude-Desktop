package catalog

import (
	"sort"
	"strings"

	"github.com/Wei-Shaw/sub2api/internal/service"
)

// Resolve builds the catalog of one group (design 2.4) from stored rows.
//
//   - groupID 0 means no group: only global rows count.
//   - A group row replaces the global row of the same model entirely; rows of
//     other groups and rows whose group was deleted are ignored.
//   - efforts = supported_efforts cut to the group max_reasoning_effort
//     ("none" is never cut; an unknown or empty ceiling cuts nothing); the
//     field is absent when supported_efforts is null. default_effort falls
//     back to the middle of what is left (the lower middle for an even
//     count) when the configured one was cut.
//   - default_model = the group's default row, else the global default row,
//     else null; an item is "default" when it is that model.
//   - Hidden rows stay in the list (the client shows them under More models).
//   - Items are ordered by sort order, then model id.
//   - web_search and x_search come from the group's platform (see
//     searchCapabilities); without a group every model reports "none".
func Resolve(rows []Row, groupID int64, maxReasoningEffort string) Catalog {
	return ResolveFor(rows, groupID, maxReasoningEffort, "")
}

// ResolveFor is Resolve for a group on a platform (the group's upstream
// platform, which decides the models' search capabilities).
func ResolveFor(rows []Row, groupID int64, maxReasoningEffort, platform string) Catalog {
	type pick struct {
		row       Row
		fromGroup bool
	}
	picked := map[string]pick{}
	var groupDefault, globalDefault *Row
	for i := range rows {
		r := rows[i]
		if r.GroupDeleted {
			continue
		}
		switch {
		case r.GroupID == nil:
			if cur, ok := picked[r.ModelID]; !ok || (!cur.fromGroup && r.ID < cur.row.ID) {
				picked[r.ModelID] = pick{row: r}
			}
			if r.IsDefault && betterDefault(&r, globalDefault) {
				globalDefault = &rows[i]
			}
		case groupID > 0 && *r.GroupID == groupID:
			if cur, ok := picked[r.ModelID]; !ok || !cur.fromGroup || r.ID < cur.row.ID {
				picked[r.ModelID] = pick{row: r, fromGroup: true}
			}
			if r.IsDefault && betterDefault(&r, groupDefault) {
				groupDefault = &rows[i]
			}
		}
	}

	maxRank, capped := effortCeiling(maxReasoningEffort)
	cat := Catalog{Items: make([]Item, 0, len(picked))}
	if groupID > 0 {
		id := groupID
		cat.GroupID = &id
	}
	switch {
	case groupDefault != nil:
		m := groupDefault.ModelID
		cat.DefaultModel = &m
	case globalDefault != nil:
		m := globalDefault.ModelID
		cat.DefaultModel = &m
	}

	for _, p := range picked {
		r := p.row
		item := Item{
			ID:                    r.ModelID,
			DisplayName:           r.DisplayName,
			Description:           r.Description,
			Badges:                r.Badges,
			Sort:                  r.SortOrder,
			Hidden:                r.Hidden,
			Default:               cat.DefaultModel != nil && *cat.DefaultModel == r.ModelID,
			ContextWindow:         copyInt(r.ContextWindow),
			AutoCompactTokens:     copyInt(r.AutoCompactTokens),
			UsageHint:             r.UsageHint,
			MinimumDesktopVersion: r.MinimumDesktopVersion,
			groupRow:              p.fromGroup,
		}
		if groupID > 0 {
			gid := groupID
			item.GroupID = &gid
			item.WebSearch, item.XSearch = searchCapabilities(platform, r.ModelID)
		} else {
			item.WebSearch = WebSearchNone
		}
		if item.DisplayName == "" {
			item.DisplayName = r.ModelID
		}
		item.Badges = make([]string, len(r.Badges))
		copy(item.Badges, r.Badges)
		if r.SupportedEfforts != nil {
			efforts := make([]string, 0, len(r.SupportedEfforts))
			for _, e := range r.SupportedEfforts {
				rank, known := effortRank[e]
				if !known || (capped && rank > maxRank) {
					continue
				}
				efforts = append(efforts, e)
			}
			sort.SliceStable(efforts, func(i, j int) bool { return effortRank[efforts[i]] < effortRank[efforts[j]] })
			item.Efforts = &efforts
			switch {
			case len(efforts) == 0:
			case contains(efforts, r.DefaultEffort):
				item.DefaultEffort = r.DefaultEffort
			default:
				item.DefaultEffort = efforts[(len(efforts)-1)/2]
			}
		}
		cat.Items = append(cat.Items, item)
	}
	sort.Slice(cat.Items, func(i, j int) bool {
		a, b := cat.Items[i], cat.Items[j]
		if a.Sort != b.Sort {
			return a.Sort < b.Sort
		}
		return a.ID < b.ID
	})
	return cat
}

// searchCapabilities derives a model's search tools from its group's
// platform (R45a): the OpenAI Responses upstream runs the built-in
// web_search tool, and the grok gateway passes web_search and x_search on to
// xAI. Other platforms answer "none" (the gateway has no search for them). A
// composite group routes by model, so its models are read by model family:
// grok-* as grok, gpt-*, chatgpt-*, codex-* and o1/o3/o4* as OpenAI.
func searchCapabilities(platform, modelID string) (webSearch string, xSearch bool) {
	switch strings.ToLower(strings.TrimSpace(platform)) {
	case service.PlatformGrok:
		return WebSearchNative, true
	case service.PlatformOpenAI:
		return WebSearchNative, false
	case service.PlatformAnthropic:
		// CLAUDEX: Claude's server-side web search, which the bridge returns
		// as OpenAI's hosted search (apicompat/anthropic_server_tools.go).
		return WebSearchNative, false
	case service.PlatformComposite:
		id := strings.ToLower(modelID)
		switch {
		case strings.HasPrefix(id, "grok"):
			return WebSearchNative, true
		case strings.HasPrefix(id, "claude"):
			return WebSearchNative, false
		case strings.HasPrefix(id, "gpt-"), strings.HasPrefix(id, "chatgpt-"), strings.HasPrefix(id, "codex-"),
			strings.HasPrefix(id, "o1"), strings.HasPrefix(id, "o3"), strings.HasPrefix(id, "o4"):
			return WebSearchNative, false
		}
	}
	return WebSearchNone, false
}

// betterDefault keeps a deterministic default if a scope ever holds two (the
// unique index prevents it): the lowest sort order, then the lowest id.
func betterDefault(candidate, current *Row) bool {
	if current == nil {
		return true
	}
	if candidate.SortOrder != current.SortOrder {
		return candidate.SortOrder < current.SortOrder
	}
	return candidate.ID < current.ID
}

// effortCeiling maps a group max_reasoning_effort to a rank. Values the
// upstream normalizer does not accept mean "no ceiling", like upstream.
func effortCeiling(maxReasoningEffort string) (rank int, capped bool) {
	normalized := service.NormalizeMaxReasoningEffort(maxReasoningEffort)
	if normalized == "" {
		return 0, false
	}
	rank, capped = effortRank[normalized]
	return rank, capped
}

func copyInt(v *int) *int {
	if v == nil {
		return nil
	}
	n := *v
	return &n
}

// Merge combines the catalogs of a device's groups (MG) into one: the first
// catalog is the plan group's, the others follow in the order given (by group
// id). A model id listed by several groups keeps one entry: an entry from a
// group's own row before one from a global row (global rows appear in every
// group's catalog), then the first group in order, so the plan group wins,
// then the smallest group id.
// The default model is the plan group's default, else the first default of
// the other groups. Items keep their own group_id and are ordered like
// Resolve (sort order, then model id).
func Merge(cats ...*Catalog) Catalog {
	out := Catalog{Items: []Item{}}
	seen := map[string]bool{}
	for i, cat := range cats {
		if cat == nil {
			continue
		}
		if i == 0 {
			out.GroupID = copyInt64(cat.GroupID)
		}
		if out.DefaultModel == nil && cat.DefaultModel != nil {
			m := *cat.DefaultModel
			out.DefaultModel = &m
		}
	}
	for _, own := range []bool{true, false} {
		for _, cat := range cats {
			if cat == nil {
				continue
			}
			for _, item := range cat.Items {
				if seen[item.ID] || item.groupRow != own {
					continue
				}
				seen[item.ID] = true
				item.GroupID = copyInt64(item.GroupID)
				out.Items = append(out.Items, item)
			}
		}
	}
	for i := range out.Items {
		out.Items[i].Default = out.DefaultModel != nil && *out.DefaultModel == out.Items[i].ID
	}
	sort.SliceStable(out.Items, func(i, j int) bool {
		a, b := out.Items[i], out.Items[j]
		if a.Sort != b.Sort {
			return a.Sort < b.Sort
		}
		return a.ID < b.ID
	})
	return out
}

func copyInt64(v *int64) *int64 {
	if v == nil {
		return nil
	}
	n := *v
	return &n
}
