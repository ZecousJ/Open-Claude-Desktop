package catalog

import (
	"context"
	"errors"
	"sort"
	"strings"

	"github.com/Wei-Shaw/sub2api/internal/service"
)

// maxCandidateGroups bounds the union over active groups when no group_id is
// given (global rows apply to every group).
const maxCandidateGroups = 500

// candidates lists model ids an administrator may want to describe: from the
// group model allowlist, the default mapped model, the channel model pricing
// and mapping of the group's channel (exact names only; wildcard patterns are
// skipped) and the group's own model pricing. It reads the upstream services,
// never the upstream tables. Without a group it unions every active group.
func (c *Component) candidates(ctx context.Context, groupID *int64) (*Candidates, error) {
	groups := c.groupReader()
	if groups == nil {
		return nil, errNoGroups
	}
	var list []service.Group
	if groupID != nil {
		grp, err := groups.GetByIDLite(ctx, *groupID)
		if errors.Is(err, service.ErrGroupNotFound) || (err == nil && grp == nil) {
			return nil, ErrGroupNotFound
		}
		if err != nil {
			return nil, err
		}
		list = []service.Group{*grp}
	} else {
		active, err := groups.ListActive(ctx)
		if err != nil {
			return nil, err
		}
		if len(active) > maxCandidateGroups {
			active = active[:maxCandidateGroups]
		}
		list = active
	}

	acc := newCandidateSet()
	channels := c.channelReader()
	for i := range list {
		grp := &list[i]
		if grp.ModelAllowlist.Enabled {
			for _, m := range grp.ModelAllowlist.Models {
				acc.add(m, SourceAllowlist)
			}
		}
		acc.add(grp.DefaultMappedModel, SourceDefaultMapped)
		for _, p := range grp.ModelPricing {
			for _, m := range p.Models {
				acc.add(m, SourceGroupPricing)
			}
		}
		if channels == nil {
			continue
		}
		ch, err := channels.GetChannelForGroup(ctx, grp.ID)
		if err != nil {
			return nil, err
		}
		if ch == nil {
			continue
		}
		for _, p := range ch.ModelPricing {
			if !platformMatches(grp.Platform, p.Platform) {
				continue
			}
			for _, m := range p.Models {
				acc.add(m, SourceChannelPricing)
			}
		}
		for platform, mapping := range ch.ModelMapping {
			if !platformMatches(grp.Platform, platform) {
				continue
			}
			for from := range mapping {
				acc.add(from, SourceChannelMapping)
			}
		}
	}
	return acc.result(), nil
}

// platformMatches mirrors the channel lookup: a composite group matches
// every platform, other groups only their own (an entry without a platform
// matches any group).
func platformMatches(groupPlatform, entryPlatform string) bool {
	entryPlatform = strings.TrimSpace(entryPlatform)
	return entryPlatform == "" || groupPlatform == service.PlatformComposite ||
		strings.EqualFold(entryPlatform, groupPlatform)
}

var sourceOrder = map[string]int{
	SourceAllowlist:      0,
	SourceDefaultMapped:  1,
	SourceChannelPricing: 2,
	SourceChannelMapping: 3,
	SourceGroupPricing:   4,
}

type candidateSet struct {
	sources map[string]map[string]bool
}

func newCandidateSet() *candidateSet {
	return &candidateSet{sources: map[string]map[string]bool{}}
}

func (s *candidateSet) add(model, source string) {
	model = strings.TrimSpace(model)
	if model == "" || strings.ContainsAny(model, "* \t\r\n") || len(model) > maxModelIDLen {
		return
	}
	if s.sources[model] == nil {
		s.sources[model] = map[string]bool{}
	}
	s.sources[model][source] = true
}

func (s *candidateSet) result() *Candidates {
	out := &Candidates{Models: make([]string, 0, len(s.sources)), Sources: make(map[string][]string, len(s.sources))}
	for model, set := range s.sources {
		out.Models = append(out.Models, model)
		list := make([]string, 0, len(set))
		for src := range set {
			list = append(list, src)
		}
		sort.Slice(list, func(i, j int) bool { return sourceOrder[list[i]] < sourceOrder[list[j]] })
		out.Sources[model] = list
	}
	sort.Slice(out.Models, func(i, j int) bool {
		a, b := strings.ToLower(out.Models[i]), strings.ToLower(out.Models[j])
		if a != b {
			return a < b
		}
		return out.Models[i] < out.Models[j]
	})
	return out
}
