package service

import (
	"context"
	"strings"

	"github.com/Wei-Shaw/sub2api/internal/pkg/antigravity"
	"github.com/Wei-Shaw/sub2api/internal/pkg/claude"
	"github.com/Wei-Shaw/sub2api/internal/pkg/geminicli"
	"github.com/Wei-Shaw/sub2api/internal/pkg/openai"
	"github.com/Wei-Shaw/sub2api/internal/pkg/xai"
)

// CLAUDEX: the model listing of GET /v1/models, as ids, so the Claudex model
// catalog lists exactly the models a group's key gets (handler.Models keeps
// writing the responses; its helpers delegate here).

// compositeListingPlatforms are the concrete platforms a composite group
// lists models of, in listing order.
var compositeListingPlatforms = []string{PlatformAnthropic, PlatformGemini, PlatformOpenAI, PlatformAntigravity, PlatformGrok, PlatformKimi, PlatformZhipu, PlatformDeepseek, PlatformMiniMax, PlatformQwen, PlatformOpenCodeGo}

// DefaultListingModelIDs is a platform's built-in model list (/v1/models
// without account mappings).
func DefaultListingModelIDs(platform string) []string {
	switch platform {
	case PlatformOpenAI:
		return openai.DefaultModelIDs()
	case PlatformGemini:
		ids := make([]string, 0, len(geminicli.DefaultModels))
		for _, model := range geminicli.DefaultModels {
			ids = append(ids, model.ID)
		}
		return ids
	case PlatformAntigravity:
		models := antigravity.DefaultModels()
		ids := make([]string, 0, len(models))
		for _, model := range models {
			ids = append(ids, model.ID)
		}
		return ids
	case PlatformAnthropic:
		return claude.DefaultModelIDs()
	case PlatformGrok:
		return xai.DefaultModelIDs()
	case PlatformOpenCodeGo:
		return DefaultOpenCodeGoModelIDs()
	case PlatformComposite:
		ids := make([]string, 0)
		seen := make(map[string]struct{})
		for _, concretePlatform := range compositeListingPlatforms {
			for _, id := range DefaultListingModelIDs(concretePlatform) {
				if _, ok := seen[id]; ok {
					continue
				}
				seen[id] = struct{}{}
				ids = append(ids, id)
			}
		}
		return ids
	default:
		return claudeDefaultModelIDs()
	}
}

// claudeDefaultModelIDs is the list a platform without its own falls back to.
func claudeDefaultModelIDs() []string {
	ids := make([]string, 0, len(claude.DefaultModels))
	for _, model := range claude.DefaultModels {
		ids = append(ids, model.ID)
	}
	return ids
}

// ModelListingSource is what an allowlist filters: the account mapping keys
// (available), else the platform defaults (fallback); Anthropic lists both.
func ModelListingSource(platform string, availableModels, fallbackModels []string) []string {
	if len(availableModels) == 0 {
		return fallbackModels
	}
	if platform == PlatformAnthropic {
		return MergeModelIDs(availableModels, fallbackModels)
	}
	return availableModels
}

// MergeModelIDs joins two id lists, first occurrence first, blanks dropped.
func MergeModelIDs(primary, secondary []string) []string {
	seen := make(map[string]struct{}, len(primary)+len(secondary))
	merged := make([]string, 0, len(primary)+len(secondary))
	for _, models := range [][]string{primary, secondary} {
		for _, model := range models {
			model = strings.TrimSpace(model)
			if model == "" {
				continue
			}
			if _, ok := seen[model]; ok {
				continue
			}
			seen[model] = struct{}{}
			merged = append(merged, model)
		}
	}
	return merged
}

// CompositeListedModels unions a composite group's models over its concrete
// platforms (a schedulable platform without mappings adds its defaults, CN
// providers excepted: they have no static list).
func (s *GatewayService) CompositeListedModels(ctx context.Context, groupID *int64) []string {
	if s == nil {
		return nil
	}
	seen := make(map[string]struct{})
	models := make([]string, 0)
	schedulablePlatforms := s.GetSchedulablePlatforms(ctx, groupID)
	for _, platform := range compositeListingPlatforms {
		platformModels := s.GetAvailableModels(ctx, groupID, platform)
		if len(platformModels) == 0 {
			if _, ok := schedulablePlatforms[platform]; ok && !IsMultiProtocolAPIKeyProvider(platform) {
				platformModels = DefaultListingModelIDs(platform)
			}
		}
		for _, model := range platformModels {
			model = strings.TrimSpace(model)
			if model == "" {
				continue
			}
			if _, ok := seen[model]; ok {
				continue
			}
			seen[model] = struct{}{}
			models = append(models, model)
		}
	}
	return models
}

// ListedModelIDs is the id list GET /v1/models answers for a key of the
// group (handler.Models), except that an OpenAI group with the pinned Codex
// models manifest lists its account mappings like any other group: the
// manifest is fetched from the upstream per request.
func (s *GatewayService) ListedModelIDs(ctx context.Context, group *Group) []string {
	if s == nil || group == nil {
		return nil
	}
	groupID := &group.ID
	platform := group.Platform
	if platform == PlatformComposite {
		available := s.CompositeListedModels(ctx, groupID)
		if group.ModelAllowlistEnabled() {
			source := available
			if len(source) == 0 {
				source = DefaultListingModelIDs(PlatformComposite)
			}
			return AllowlistListing(group.ModelAllowlist, source, available)
		}
		if len(available) > 0 {
			return available
		}
		return DefaultListingModelIDs(PlatformComposite)
	}
	available := s.GetAvailableModels(ctx, groupID, platform)
	if group.ModelAllowlistEnabled() {
		return AllowlistListing(group.ModelAllowlist, ModelListingSource(platform, available, DefaultListingModelIDs(platform)), available)
	}
	if len(available) > 0 {
		return available
	}
	// The last fallback, as handler.Models writes it.
	switch platform {
	case PlatformOpenAI, PlatformGemini, PlatformGrok:
		return DefaultListingModelIDs(platform)
	default:
		return claudeDefaultModelIDs()
	}
}

// AllowlistListing is what a group with an enabled model allowlist offers
// in Claudex's catalog: what /v1/models lists (the source's models the
// allowlist lets through), then each model the allowlist names outright
// that the source does not advertise but the group's accounts can serve:
// accounts that declare no models (declared empty: passthrough or no
// mapping) take any, otherwise a declared model or wildcard must match. A
// named model no account maps would fail, so it stays out (2026-10-02:
// gpt-5.4, gpt-6-luna… listed although only six codex models are mapped).
func AllowlistListing(allowlist GroupModelAllowlist, source, declared []string) []string {
	listed := allowlist.FilterForListing(source)
	if !allowlist.Enabled {
		return listed
	}
	seen := make(map[string]struct{}, len(listed))
	for _, model := range listed {
		seen[strings.ToLower(model)] = struct{}{}
	}
	for _, entry := range allowlist.Models {
		entry = strings.TrimSpace(entry)
		// Reviewer models are allowed for Codex's automatic review, never offered.
		if entry == "" || strings.HasSuffix(entry, "*") || IsOpenAIReviewerModel(entry) {
			continue
		}
		if _, ok := seen[strings.ToLower(entry)]; ok {
			continue
		}
		if len(declared) > 0 && !declaresModel(declared, entry) {
			continue
		}
		seen[strings.ToLower(entry)] = struct{}{}
		listed = append(listed, entry)
	}
	return listed
}

// declaresModel reports whether an account mapping key names the model,
// exactly or by a trailing-* wildcard (case-insensitive).
func declaresModel(declared []string, model string) bool {
	model = strings.ToLower(model)
	for _, key := range declared {
		key = strings.ToLower(strings.TrimSpace(key))
		if key == model {
			return true
		}
		if prefix, ok := strings.CutSuffix(key, "*"); ok && strings.HasPrefix(model, prefix) {
			return true
		}
	}
	return false
}
