package service

import "testing"

func TestIsOpenAIReviewerModel(t *testing.T) {
	if !IsOpenAIReviewerModel("codex-auto-review") || !IsOpenAIReviewerModel(" Codex-Auto-Review ") {
		t.Fatal("codex-auto-review is a reviewer model")
	}
	if IsOpenAIReviewerModel("gpt-6.1-sol") || IsOpenAIReviewerModel("") {
		t.Fatal("ordinary models are not reviewer models")
	}
}

func TestOpenAIReviewerFallbackCandidatesUsesTheAllowlist(t *testing.T) {
	group := &Group{ModelAllowlist: GroupModelAllowlist{Enabled: true, Models: []string{
		"gpt-6.1-sol", "codex-auto-review", "gpt-image-2", "gpt-5.6-sol", "GPT-5.6-sol",
	}}}
	got := openAIReviewerFallbackCandidates(group, nil)
	want := []string{"gpt-6.1-sol", "gpt-5.6-sol"}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("candidates = %v, want %v", got, want)
	}
}

func TestCheapestOpenAIModelSkipsUnpricedModels(t *testing.T) {
	prices := map[string]float64{"gpt-6.1-sol": 3, "gpt-5.6-sol": 1.5, "gpt-6-astra": 1.5}
	price := func(model string) (float64, bool) {
		p, ok := prices[model]
		return p, ok
	}
	if got := cheapestOpenAIModel([]string{"gpt-6.1-sol", "unpriced", "gpt-6-astra", "gpt-5.6-sol"}, price); got != "gpt-5.6-sol" {
		t.Fatalf("cheapest = %q, want gpt-5.6-sol (tie broken by name)", got)
	}
	if got := cheapestOpenAIModel([]string{"unpriced"}, price); got != "" {
		t.Fatalf("no priced model should give \"\", got %q", got)
	}
}

func TestReviewerModelsAreNeverListed(t *testing.T) {
	allow := GroupModelAllowlist{Enabled: true, Models: []string{"gpt-6.1-sol", "codex-auto-review"}}
	got := allow.FilterForListing([]string{"gpt-6.1-sol", "codex-auto-review", "gpt-5.6-sol"})
	if len(got) != 1 || got[0] != "gpt-6.1-sol" {
		t.Fatalf("listing = %v, want [gpt-6.1-sol]", got)
	}
	if !allow.Allows("codex-auto-review") {
		t.Fatal("the reviewer model stays allowed for requests")
	}
	off := GroupModelAllowlist{}
	got = off.FilterForListing([]string{"codex-auto-review", "gpt-6.1-sol"})
	if len(got) != 1 || got[0] != "gpt-6.1-sol" {
		t.Fatalf("listing without an allowlist = %v, want [gpt-6.1-sol]", got)
	}
}

func TestHideOpenAIReviewerModelsInCodexManifest(t *testing.T) {
	body := []byte(`{"models":[{"slug":"codex-auto-review","visibility":"list"},{"slug":"gpt-6.1-sol","visibility":"list"}]}`)
	got := string(HideOpenAIReviewerModelsInCodexManifest(body))
	want := `{"models":[{"slug":"codex-auto-review","visibility":"hide"},{"slug":"gpt-6.1-sol","visibility":"list"}]}`
	if got != want {
		t.Fatalf("manifest = %s, want %s", got, want)
	}
	plain := []byte(`{"object":"list","data":[]}`)
	if string(HideOpenAIReviewerModelsInCodexManifest(plain)) != string(plain) {
		t.Fatal("a body without models is left alone")
	}
}

func TestAllowlistListingNeverAddsReviewerModelsBack(t *testing.T) {
	allow := GroupModelAllowlist{Enabled: true, Models: []string{"gpt-6.1-sol", "codex-auto-review"}}
	mapped := []string{"gpt-6.1-sol", "codex-auto-review"}
	got := AllowlistListing(allow, []string{"gpt-6.1-sol"}, mapped)
	if len(got) != 1 || got[0] != "gpt-6.1-sol" {
		t.Fatalf("listing = %v, want [gpt-6.1-sol]", got)
	}
}
