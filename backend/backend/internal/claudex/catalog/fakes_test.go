package catalog

import (
	"context"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/service"
)

// memStore is an in-memory metaStore with the table's rules: one row per
// (model, scope), one default per scope (switched atomically), rows of
// deleted groups flagged.
type memStore struct {
	mu      sync.Mutex
	next    int64
	rows    map[int64]Row
	deleted map[int64]bool // deleted groups
	names   map[int64]string
	err     error
	scopes  int // Scope calls (cache checks)
	now     func() time.Time
	// placements of groups (placementStore)
	placements map[int64][]Placement
}

func newMemStore() *memStore {
	return &memStore{rows: map[int64]Row{}, deleted: map[int64]bool{}, names: map[int64]string{},
		now: func() time.Time { return time.Date(2026, 9, 26, 2, 30, 0, 0, time.UTC) }}
}

func (s *memStore) decorate(r Row) Row {
	if r.GroupID != nil {
		r.GroupDeleted = s.deleted[*r.GroupID]
		if !r.GroupDeleted {
			r.GroupName = s.names[*r.GroupID]
		} else {
			r.GroupName = ""
		}
	}
	r.Badges = append([]string{}, r.Badges...)
	if r.SupportedEfforts != nil {
		r.SupportedEfforts = append([]string{}, r.SupportedEfforts...)
	}
	return r
}

func (s *memStore) sorted(keep func(Row) bool) []Row {
	out := []Row{}
	for _, r := range s.rows {
		if keep(r) {
			out = append(out, s.decorate(r))
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

func (s *memStore) Scope(_ context.Context, groupID int64) ([]Row, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.scopes++
	if s.err != nil {
		return nil, s.err
	}
	return s.sorted(func(r Row) bool {
		return r.GroupID == nil || (*r.GroupID == groupID && !s.deleted[groupID])
	}), nil
}

func (s *memStore) List(_ context.Context, f listFilter) ([]Row, int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return nil, 0, s.err
	}
	all := s.sorted(func(r Row) bool {
		switch f.Scope {
		case scopeGlobal:
			if r.GroupID != nil {
				return false
			}
		case scopeGroup:
			if r.GroupID == nil || *r.GroupID != f.GroupID {
				return false
			}
		}
		q := strings.ToLower(strings.TrimSpace(f.Query))
		return q == "" || strings.Contains(strings.ToLower(r.ModelID), q) || strings.Contains(strings.ToLower(r.DisplayName), q)
	})
	total := int64(len(all))
	from := (f.Page - 1) * f.PageSize
	if from > len(all) {
		from = len(all)
	}
	to := min(from+f.PageSize, len(all))
	return all[from:to], total, nil
}

func (s *memStore) Get(_ context.Context, id int64) (*Row, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.rows[id]
	if !ok {
		return nil, ErrNotFound
	}
	out := s.decorate(r)
	return &out, nil
}

func scopeOf(g *int64) int64 {
	if g == nil {
		return 0
	}
	return *g
}

func (s *memStore) apply(r *Row, in Input) {
	r.DisplayName, r.Description, r.Badges = in.DisplayName, in.Description, in.Badges
	r.SortOrder, r.Hidden, r.IsDefault = in.SortOrder, in.Hidden, in.IsDefault
	r.SupportedEfforts, r.DefaultEffort = in.SupportedEfforts, in.DefaultEffort
	r.ContextWindow, r.AutoCompactTokens, r.FastTier, r.UsageHint = in.ContextWindow, in.AutoCompactTokens, in.FastTier, in.UsageHint
	r.MinimumDesktopVersion = in.MinimumDesktopVersion
	r.UpdatedAt = s.now()
}

func (s *memStore) clearDefault(scope, keep int64) {
	for id, r := range s.rows {
		if id != keep && scopeOf(r.GroupID) == scope && r.IsDefault {
			r.IsDefault = false
			s.rows[id] = r
		}
	}
}

func (s *memStore) Create(_ context.Context, in Input, createdBy *int64) (*Row, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return nil, s.err
	}
	for _, r := range s.rows {
		if r.ModelID == in.ModelID && scopeOf(r.GroupID) == scopeOf(in.GroupID) {
			return nil, ErrConflict.WithMetadata(map[string]string{"field": "model_id"})
		}
	}
	if in.IsDefault {
		s.clearDefault(scopeOf(in.GroupID), 0)
	}
	s.next++
	r := Row{ID: s.next, ModelID: in.ModelID, GroupID: in.GroupID, CreatedBy: createdBy, CreatedAt: s.now()}
	s.apply(&r, in)
	s.rows[r.ID] = r
	out := s.decorate(r)
	return &out, nil
}

func (s *memStore) Update(_ context.Context, id int64, in Input) (*Row, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return nil, s.err
	}
	r, ok := s.rows[id]
	if !ok {
		return nil, ErrNotFound
	}
	if in.IsDefault {
		s.clearDefault(scopeOf(r.GroupID), id)
	}
	s.apply(&r, in)
	s.rows[id] = r
	out := s.decorate(r)
	return &out, nil
}

func (s *memStore) Delete(_ context.Context, id int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return s.err
	}
	if _, ok := s.rows[id]; !ok {
		return ErrNotFound
	}
	delete(s.rows, id)
	return nil
}

// fakeGroups is a groupReader; missing groups are service.ErrGroupNotFound.
type fakeGroups struct {
	mu     sync.Mutex
	groups map[int64]*service.Group
	err    error
	reads  int
}

func (f *fakeGroups) GetByIDLite(_ context.Context, id int64) (*service.Group, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reads++
	if f.err != nil {
		return nil, f.err
	}
	g, ok := f.groups[id]
	if !ok {
		return nil, service.ErrGroupNotFound
	}
	cp := *g
	return &cp, nil
}

func (f *fakeGroups) ListActive(_ context.Context) ([]service.Group, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return nil, f.err
	}
	out := []service.Group{}
	for _, g := range f.groups {
		if g.Status == service.StatusActive {
			out = append(out, *g)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

// fakeChannels is a channelReader.
type fakeChannels struct {
	byGroup map[int64]*service.Channel
	err     error
}

func (f *fakeChannels) GetChannelForGroup(_ context.Context, groupID int64) (*service.Channel, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.byGroup[groupID], nil
}

// fakePlans is a core.PlanResolver: a user may use the groups listed for
// them; anything else resolves to their first group, like B4's resolver.
type fakePlans struct {
	allowed map[int64][]int64
	err     error
	calls   []*int64
}

func (f *fakePlans) ResolvePlan(_ context.Context, userID int64, requested *int64) (*core.PlanRef, error) {
	f.calls = append(f.calls, requested)
	if f.err != nil {
		return nil, f.err
	}
	groups := f.allowed[userID]
	if len(groups) == 0 {
		return nil, core.ErrNoPlan
	}
	pick := groups[0]
	if requested != nil {
		for _, g := range groups {
			if g == *requested {
				pick = g
			}
		}
	}
	return &core.PlanRef{GroupID: pick, Platform: "openai", Protocol: "responses"}, nil
}

// Placements of the memStore (claudex_model_placements).
func (s *memStore) Placements(_ context.Context, groupID int64) ([]Placement, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return nil, s.err
	}
	return append([]Placement(nil), s.placements[groupID]...), nil
}

func (s *memStore) SetPlacements(_ context.Context, groupID int64, list []Placement, _ *int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return s.err
	}
	if s.placements == nil {
		s.placements = map[int64][]Placement{}
	}
	s.placements[groupID] = append([]Placement(nil), list...)
	return nil
}

// fakeLister answers a group's /v1/models listing; a group without an entry
// lists nothing it knows of (nil: the described models stand in).
type fakeLister struct {
	mu    sync.Mutex
	byID  map[int64][]string
	asked int
}

func (f *fakeLister) ListedModelIDs(_ context.Context, group *service.Group) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.asked++
	return f.byID[group.ID]
}
