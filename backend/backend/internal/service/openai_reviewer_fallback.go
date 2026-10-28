package service

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
)

// openAIReviewerModels are the models Codex's automatic approval reviewer
// ("Codex Auto Review", approvals_reviewer = auto_review) asks for. Claudex's
// Auto permission mode depends on them; when no account in the group can serve
// one (none maps it, or every account that does failed), the review goes to
// the group's cheapest model instead of failing, which Codex would otherwise
// treat as a rejection (owner, 2026-10-12).
var openAIReviewerModels = map[string]struct{}{
	"codex-auto-review": {},
}

// IsOpenAIReviewerModel reports whether model is an automatic approval
// reviewer model eligible for the cheapest-model fallback.
func IsOpenAIReviewerModel(model string) bool {
	_, ok := openAIReviewerModels[strings.ToLower(strings.TrimSpace(model))]
	return ok
}

// openAIReviewerFallbackCandidates lists the models a reviewer request may fall
// back to: the group's allowlist when it has one, otherwise every model the
// group's schedulable accounts map. Reviewer and image models are left out.
func openAIReviewerFallbackCandidates(group *Group, accounts []Account) []string {
	seen := map[string]struct{}{}
	var out []string
	add := func(model string) {
		model = strings.TrimSpace(model)
		lower := strings.ToLower(model)
		if model == "" || IsOpenAIReviewerModel(model) || strings.Contains(lower, "image") {
			return
		}
		if _, ok := seen[lower]; ok {
			return
		}
		seen[lower] = struct{}{}
		out = append(out, model)
	}
	if group != nil && group.ModelAllowlistEnabled() {
		for _, model := range group.ModelAllowlist.Models {
			add(model)
		}
		return out
	}
	for i := range accounts {
		for model := range accounts[i].GetModelMapping() {
			add(model)
		}
	}
	return out
}

// cheapestOpenAIModel picks the candidate with the lowest input + output price
// per token; models without a token price are skipped, ties go to the name.
func cheapestOpenAIModel(candidates []string, price func(model string) (float64, bool)) string {
	sorted := append([]string(nil), candidates...)
	sort.Strings(sorted)
	best, bestPrice := "", 0.0
	for _, model := range sorted {
		p, ok := price(model)
		if !ok {
			continue
		}
		if best == "" || p < bestPrice {
			best, bestPrice = model, p
		}
	}
	return best
}

// CheapestOpenAIGroupModel returns the cheapest text model the group serves,
// for a reviewer request no account can take; "" when there is none.
func (s *OpenAIGatewayService) CheapestOpenAIGroupModel(ctx context.Context, group *Group, groupID *int64) string {
	var accounts []Account
	if group == nil || !group.ModelAllowlistEnabled() {
		listed, err := s.listSchedulableAccounts(ctx, groupID, PlatformOpenAI)
		if err != nil {
			return ""
		}
		accounts = listed
	}
	return cheapestOpenAIModel(openAIReviewerFallbackCandidates(group, accounts), func(model string) (float64, bool) {
		if s.billingService == nil {
			return 0, false
		}
		pricing, err := s.billingService.GetModelPricing(model)
		if err != nil || pricing == nil {
			return 0, false
		}
		total := pricing.InputPricePerToken + pricing.OutputPricePerToken
		return total, total > 0
	})
}

// HideOpenAIReviewerModelsInCodexManifest marks reviewer models in a Codex
// models manifest as hidden, so Codex knows them but never offers them in a
// model picker (owner, 2026-10-12: "审查模型不要放在选项菜单"). The rewrite is
// deterministic, so the manifest's ETag stays valid. Bodies that are not a
// manifest come back unchanged.
func HideOpenAIReviewerModelsInCodexManifest(body []byte) []byte {
	models := gjson.GetBytes(body, "models")
	if !models.IsArray() {
		return body
	}
	out := body
	index := 0
	models.ForEach(func(_, entry gjson.Result) bool {
		if IsOpenAIReviewerModel(entry.Get("slug").String()) && entry.Get("visibility").String() != "hide" {
			if updated, err := sjson.SetBytes(out, fmt.Sprintf("models.%d.visibility", index), "hide"); err == nil {
				out = updated
			}
		}
		index++
		return true
	})
	return out
}
