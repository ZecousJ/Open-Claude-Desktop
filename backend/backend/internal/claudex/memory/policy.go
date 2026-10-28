package memory

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
)

// Policy is the memory block of the client policy (B2 policy component,
// "memory": {enabled, search_chats, generate, default_on, model}). With
// Enabled off every switch is off (the policy component normalizes it; the
// memory component checks again).
type Policy struct {
	Enabled     bool    `json:"enabled"`
	SearchChats bool    `json:"search_chats"`
	Generate    bool    `json:"generate"`
	DefaultOn   bool    `json:"default_on"`
	Model       *string `json:"model"`
}

// defaultPolicy is the built-in policy default (POL): memory allowed, the
// user's switches off until they turn them on.
func defaultPolicy() Policy {
	return Policy{Enabled: true, SearchChats: true, Generate: true}
}

func (p Policy) normalized() Policy {
	if !p.Enabled {
		p.SearchChats, p.Generate, p.DefaultOn = false, false, false
	}
	return p
}

// policyFunc resolves the memory policy of a user (plan may be nil; the
// policy component then resolves the plan group itself).
type policyFunc func(ctx context.Context, userID int64, plan *core.PlanRef, platform string) (Policy, error)

// policyFromComponents reads the memory policy through the policy
// component's bootstrap section: components never import each other, and the
// section is the policy the desktop app gets for that user, plan group and
// platform. Without a policy component (tests, partial modules) the built-in
// default applies.
func (c *Component) policyFromComponents(ctx context.Context, userID int64, plan *core.PlanRef, platform string) (Policy, error) {
	if c.env == nil {
		return defaultPolicy(), nil
	}
	var source core.BootstrapContributor
	for _, f := range c.env.Components {
		if f == nil || f.Name() != core.NamePolicy {
			continue
		}
		bc, ok := f.(core.BootstrapContributor)
		if !ok {
			return defaultPolicy(), nil // B2 stub
		}
		source = bc
	}
	if source == nil {
		return defaultPolicy(), nil
	}
	sections, err := source.BootstrapSections(ctx, &core.BootstrapContext{UserID: userID, Plan: plan, Platform: platform})
	if err != nil {
		return Policy{}, err
	}
	resolved, ok := sections[core.SectionPolicy]
	if !ok {
		return Policy{}, errors.New("memory: the policy component returned no policy")
	}
	return memoryBlock(resolved)
}

// memoryBlock extracts "memory" from a resolved policy (any JSON-encodable
// value). A policy without the block (older policy component) keeps the
// built-in default.
func memoryBlock(resolved any) (Policy, error) {
	raw, err := json.Marshal(resolved)
	if err != nil {
		return Policy{}, fmt.Errorf("memory: encode policy: %w", err)
	}
	var doc struct {
		Memory *Policy `json:"memory"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return Policy{}, fmt.Errorf("memory: decode policy: %w", err)
	}
	if doc.Memory == nil {
		return defaultPolicy(), nil
	}
	return doc.Memory.normalized(), nil
}
