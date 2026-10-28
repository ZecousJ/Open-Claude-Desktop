package devices

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/service"
)

// ResolvePlan implements core.PlanResolver (design 2.5 "计划分组解析"). Only
// active, undeleted groups the user may bind are candidates, limited to
// allowed_group_ids when that list is not empty:
//
//  1. the requested group when it is a candidate;
//  2. fixed: the default group, or CLAUDEX_NO_PLAN;
//  3. subscription_then_default: the candidate with the latest-expiring
//     active subscription (ties: smallest group id), else the default group,
//     else the candidate with the smallest id, else CLAUDEX_NO_PLAN.
func (c *Component) ResolvePlan(ctx context.Context, userID int64, requested *int64) (*core.PlanRef, error) {
	plan, _, err := c.resolvePlanAndGroups(ctx, userID, requested)
	return plan, err
}

// resolvePlanAndGroups resolves the plan and the groups the user's devices
// hold a key for (keyGroupsFor), from one read of the available groups.
func (c *Component) resolvePlanAndGroups(ctx context.Context, userID int64, requested *int64) (*core.PlanRef, []service.Group, error) {
	keys := c.keys()
	if keys == nil || userID <= 0 {
		return nil, nil, core.ErrNoPlan
	}
	groups, err := keys.GetAvailableGroups(ctx, userID)
	if err != nil {
		if errors.Is(err, service.ErrUserNotFound) {
			return nil, nil, core.ErrNoPlan
		}
		return nil, nil, fmt.Errorf("claudex devices: list available groups: %w", err)
	}
	var subs []service.UserSubscription
	if src := c.subscriptions(); src != nil {
		if subs, err = src.ListActiveUserSubscriptions(ctx, userID); err != nil {
			return nil, nil, fmt.Errorf("claudex devices: list subscriptions: %w", err)
		}
	}
	settings := c.settings(ctx)
	plan, err := choosePlan(settings, groups, subs, requested, c.now())
	if err != nil {
		return nil, nil, err
	}
	return plan, keyGroupsFor(settings, groups, plan.GroupID), nil
}

// choosePlan is the pure part of ResolvePlan.
func choosePlan(p Provisioning, groups []service.Group, subs []service.UserSubscription, requested *int64, now time.Time) (*core.PlanRef, error) {
	candidates := make(map[int64]*service.Group, len(groups))
	for i := range groups {
		if g := &groups[i]; planCandidate(p, g) {
			candidates[g.ID] = g
		}
	}
	// The latest-expiring active subscription of each group.
	active := map[int64]*service.UserSubscription{}
	for i := range subs {
		s := &subs[i]
		if s.Status != service.SubscriptionStatusActive || !s.ExpiresAt.After(now) || s.DeletedAt != nil {
			continue
		}
		if prev, ok := active[s.GroupID]; !ok || s.ExpiresAt.After(prev.ExpiresAt) {
			active[s.GroupID] = s
		}
	}
	ref := func(id int64) *core.PlanRef {
		g := candidates[id]
		subType := g.SubscriptionType
		if subType == "" {
			subType = service.SubscriptionTypeStandard
		}
		out := &core.PlanRef{
			GroupID:          g.ID,
			GroupName:        g.Name,
			Platform:         g.Platform,
			Protocol:         core.ProtocolForPlatform(g.Platform),
			SubscriptionType: subType,
		}
		if s := active[id]; s != nil {
			subID := s.ID
			expires := s.ExpiresAt.UTC()
			out.SubscriptionID = &subID
			out.ExpiresAt = &expires
			out.Subscribed = true
		}
		return out
	}

	if requested != nil && candidates[*requested] != nil {
		return ref(*requested), nil
	}
	if p.Strategy == StrategyFixed {
		if p.DefaultGroupID != nil && candidates[*p.DefaultGroupID] != nil {
			return ref(*p.DefaultGroupID), nil
		}
		return nil, core.ErrNoPlan
	}
	var best *service.UserSubscription
	for id, s := range active {
		if candidates[id] == nil {
			continue
		}
		if best == nil || s.ExpiresAt.After(best.ExpiresAt) || (s.ExpiresAt.Equal(best.ExpiresAt) && s.GroupID < best.GroupID) {
			best = s
		}
	}
	if best != nil {
		return ref(best.GroupID), nil
	}
	if p.DefaultGroupID != nil && candidates[*p.DefaultGroupID] != nil {
		return ref(*p.DefaultGroupID), nil
	}
	var smallest int64
	for id := range candidates {
		if smallest == 0 || id < smallest {
			smallest = id
		}
	}
	if smallest != 0 {
		return ref(smallest), nil
	}
	return nil, core.ErrNoPlan
}

// planCandidate reports whether a group the user may bind can be a plan group
// (and so hold a device key): active, and in allowed_group_ids when that list
// is not empty.
func planCandidate(p Provisioning, g *service.Group) bool {
	if g == nil || g.ID <= 0 || g.Status != service.StatusActive {
		return false
	}
	return len(p.AllowedGroupIDs) == 0 || containsID(p.AllowedGroupIDs, g.ID)
}
