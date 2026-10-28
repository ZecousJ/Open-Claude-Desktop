//go:build unit

package usage

import (
	"strings"
	"testing"
	"time"

	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"

	"github.com/stretchr/testify/require"
)

func TestModelPatternsMatchCaseInsensitivelyByExactNameOrPrefix(t *testing.T) {
	r := compileRule(activeRule{ID: 5, Kind: KindModels, Patterns: []string{"Claude-Opus-*", "gpt-5.5"}})
	for _, m := range []string{"claude-opus-4", "CLAUDE-OPUS-4-1-20250805", "claude-opus-", "gpt-5.5", "GPT-5.5"} {
		require.True(t, r.matches(m), m)
	}
	for _, m := range []string{"claude-sonnet-4", "gpt-5.5-mini", "claude-opu", "", "  "} {
		require.False(t, r.matches(m), m)
	}
	require.True(t, r.matchesAny("gpt-4o", "", "claude-opus-4"), "any of the names is enough")
	require.False(t, r.matchesAny())
	require.Equal(t, []string{"Claude-Opus-*", "gpt-5.5"}, r.clientModels())

	// A stray "*" never widens a per-model rule to every model.
	wide := compileRule(activeRule{Kind: KindModels, Patterns: []string{"*"}})
	require.False(t, wide.matches("claude-opus-4"))

	for _, kind := range []string{KindSession, KindAllModels} {
		all := compileRule(activeRule{Kind: kind, Patterns: []string{"*"}})
		require.True(t, all.matches("anything"))
		require.True(t, all.matchesAny(), "rules for every model apply without a model name")
		require.Nil(t, all.clientModels())
	}
}

func TestRuleFieldsDefaultsAndValidation(t *testing.T) {
	f := ruleFields{Kind: " session ", LimitUSD: 5}
	require.NoError(t, f.normalizeAndValidate())
	require.Equal(t, KindSession, f.Kind)
	require.Equal(t, DefaultSessionLabel, f.Label)
	require.Equal(t, []string{"*"}, f.ModelPatterns)
	require.Equal(t, DefaultSessionWindow, f.WindowSeconds, "a session is 5 hours unless set")

	f = ruleFields{Kind: KindAllModels, WindowSeconds: 604800, LimitUSD: 100, ModelPatterns: []string{" * "}}
	require.NoError(t, f.normalizeAndValidate())
	require.Equal(t, DefaultAllModelsLabel, f.Label)
	require.Equal(t, []string{"*"}, f.ModelPatterns)

	f = ruleFields{Kind: KindModels, Label: " Opus ", WindowSeconds: 604800, LimitUSD: 20.123456789,
		ModelPatterns: []string{" claude-opus-* ", "CLAUDE-OPUS-*", "", "claude-opus-4"}}
	require.NoError(t, f.normalizeAndValidate())
	require.Equal(t, "Opus", f.Label)
	require.Equal(t, []string{"claude-opus-*", "claude-opus-4"}, f.ModelPatterns, "trimmed, empty and case duplicates dropped")
	require.Equal(t, 20.12345679, f.LimitUSD, "8 decimals like the column")

	many := make([]string, MaxPatterns+1)
	for i := range many {
		many[i] = "m" + strings.Repeat("x", i+1)
	}
	gid := int64(0)
	for name, tc := range map[string]struct {
		f     ruleFields
		field string
	}{
		"unknown kind":        {ruleFields{Kind: "daily", WindowSeconds: 3600, LimitUSD: 1}, "kind"},
		"group id zero":       {ruleFields{Kind: KindSession, GroupID: &gid, LimitUSD: 1}, "group"},
		"models needs label":  {ruleFields{Kind: KindModels, ModelPatterns: []string{"x"}, WindowSeconds: 3600, LimitUSD: 1}, "label"},
		"label too long":      {ruleFields{Kind: KindModels, Label: strings.Repeat("é", 61), ModelPatterns: []string{"x"}, WindowSeconds: 3600, LimitUSD: 1}, "label"},
		"session patterns":    {ruleFields{Kind: KindSession, ModelPatterns: []string{"claude-*"}, LimitUSD: 1}, "patterns"},
		"models no patterns":  {ruleFields{Kind: KindModels, Label: "Opus", WindowSeconds: 3600, LimitUSD: 1}, "patterns"},
		"models bare star":    {ruleFields{Kind: KindModels, Label: "All", ModelPatterns: []string{"*"}, WindowSeconds: 3600, LimitUSD: 1}, "patterns"},
		"inner wildcard":      {ruleFields{Kind: KindModels, Label: "Opus", ModelPatterns: []string{"claude-*-opus"}, WindowSeconds: 3600, LimitUSD: 1}, "patterns"},
		"pattern with space":  {ruleFields{Kind: KindModels, Label: "Opus", ModelPatterns: []string{"claude opus"}, WindowSeconds: 3600, LimitUSD: 1}, "patterns"},
		"pattern too long":    {ruleFields{Kind: KindModels, Label: "Opus", ModelPatterns: []string{strings.Repeat("a", 201)}, WindowSeconds: 3600, LimitUSD: 1}, "patterns"},
		"too many patterns":   {ruleFields{Kind: KindModels, Label: "Opus", ModelPatterns: many, WindowSeconds: 3600, LimitUSD: 1}, "patterns"},
		"window too short":    {ruleFields{Kind: KindAllModels, WindowSeconds: 3599, LimitUSD: 1}, "window"},
		"window too long":     {ruleFields{Kind: KindAllModels, WindowSeconds: 2592001, LimitUSD: 1}, "window"},
		"window missing":      {ruleFields{Kind: KindAllModels, LimitUSD: 1}, "window"},
		"limit zero":          {ruleFields{Kind: KindSession, LimitUSD: 0}, "limit"},
		"limit negative":      {ruleFields{Kind: KindSession, LimitUSD: -1}, "limit"},
		"limit below a cent8": {ruleFields{Kind: KindSession, LimitUSD: 0.000000001}, "limit"},
		"limit too large":     {ruleFields{Kind: KindSession, LimitUSD: 1e12}, "limit"},
	} {
		t.Run(name, func(t *testing.T) {
			err := tc.f.normalizeAndValidate()
			require.Error(t, err)
			app := infraerrors.FromError(err)
			require.Equal(t, 400, int(app.Code))
			require.Equal(t, "CLAUDEX_USAGE_RULE_INVALID", app.Reason)
			require.Equal(t, tc.field, app.Metadata["field"])
		})
	}
}

func TestWindowLabelsMessagesAndPercent(t *testing.T) {
	require.Equal(t, "5h", windowLabel(18000))
	require.Equal(t, "7d", windowLabel(604800))
	require.Equal(t, "1d", windowLabel(86400))
	require.Equal(t, "30d", windowLabel(2592000))
	require.Equal(t, "90m", windowLabel(5400))
	require.Equal(t, "3601s", windowLabel(3601))

	resets := time.Date(2026, 10, 2, 8, 0, 0, 0, time.UTC)
	require.Equal(t, "You've reached the Opus limit. It resets Oct 2, 8:00 AM UTC.", limitMessage(KindModels, "Opus", resets))
	require.Equal(t, "You've reached your session limit. It resets Oct 2, 8:00 AM UTC.", limitMessage(KindSession, "Current session", resets))
	require.Equal(t, "You've reached your usage limit for all models. It resets Oct 2, 8:00 AM UTC.",
		limitMessage(KindAllModels, "All models", resets.In(time.FixedZone("CST", 8*3600))), "always UTC")

	require.Equal(t, 24, percentOf(1.2, 5))
	require.Equal(t, 100, percentOf(20.13, 20))
	require.Equal(t, 0, percentOf(0, 20))
	require.Equal(t, 0, percentOf(3, 0))
	require.Equal(t, 20.13, roundUSD(20.130000000004))
}

func TestModelNameFormsIncludeTheUpstreamAllowlistCandidates(t *testing.T) {
	forms := modelNameForms(" models/claude-opus-4-5 ", "Claude-Sonnet-4-5-thinking", "openai/gpt-5.5-xhigh", "")
	for _, want := range []string{
		"models/claude-opus-4-5", "claude-opus-4-5", "claude-opus-4-5-20251101",
		"Claude-Sonnet-4-5-thinking", "claude-sonnet-4-5-thinking", "claude-sonnet-4-5-20250929",
		"openai/gpt-5.5-xhigh", "gpt-5.5-xhigh",
	} {
		require.Contains(t, forms, want)
	}
	require.NotContains(t, forms, "")
	require.Empty(t, modelNameForms("", "  "))
}
