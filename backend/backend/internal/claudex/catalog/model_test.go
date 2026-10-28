package catalog

import (
	"strings"
	"testing"

	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"

	"github.com/stretchr/testify/require"
)

func intp(v int) *int       { return &v }
func i64p(v int64) *int64   { return &v }
func boolp(v bool) *bool    { return &v }
func strp(v string) *string { return &v }

func validInput() Input {
	return Input{
		ModelID:           " gpt-5.5 ",
		DisplayName:       " GPT-5.5 ",
		Description:       "Our smartest model\nfor complex work",
		Badges:            []string{" new ", "1.5×"},
		SortOrder:         10,
		IsDefault:         true,
		SupportedEfforts:  []string{"XHIGH", "low", " medium", "high"},
		DefaultEffort:     "Medium",
		ContextWindow:     intp(400000),
		AutoCompactTokens: intp(320000),
		FastTier:          boolp(true),
		UsageHint:         "1.5× usage",
	}
}

func TestNormalizeCanonicalizes(t *testing.T) {
	in := validInput()
	in.MinimumDesktopVersion = " 1.2.3 "
	require.NoError(t, normalize(&in))
	require.Equal(t, "1.2.3", in.MinimumDesktopVersion)
	require.Equal(t, "gpt-5.5", in.ModelID)
	require.Equal(t, "GPT-5.5", in.DisplayName)
	require.Equal(t, []string{"new", "1.5×"}, in.Badges)
	require.Equal(t, []string{"low", "medium", "high", "xhigh"}, in.SupportedEfforts, "sorted by rank, lower case")
	require.Equal(t, "medium", in.DefaultEffort)

	empty := Input{ModelID: "m"}
	require.NoError(t, normalize(&empty))
	require.NotNil(t, empty.Badges, "badges are stored as [] never null")
	require.Empty(t, empty.Badges)
	require.Nil(t, empty.SupportedEfforts, "null efforts stay null")

	none := Input{ModelID: "m", SupportedEfforts: []string{}}
	require.NoError(t, normalize(&none))
	require.NotNil(t, none.SupportedEfforts, "[] stays [] (a model without effort levels)")

	withNone := Input{ModelID: "m", SupportedEfforts: []string{"low", "none"}, DefaultEffort: "none"}
	require.NoError(t, normalize(&withNone))
	require.Equal(t, []string{"none", "low"}, withNone.SupportedEfforts)
}

func TestNormalizeRejects(t *testing.T) {
	cases := []struct {
		name        string
		mutate      func(*Input)
		field, rule string
	}{
		{"invalid minimum desktop version", func(in *Input) { in.MinimumDesktopVersion = "newest" }, "minimum_desktop_version", "invalid"},
		{"missing model", func(in *Input) { in.ModelID = "  " }, "model_id", "required"},
		{"model with space", func(in *Input) { in.ModelID = "gpt 5" }, "model_id", "invalid_characters"},
		{"model wildcard", func(in *Input) { in.ModelID = "gpt-*" }, "model_id", "invalid_characters"},
		{"model control", func(in *Input) { in.ModelID = "gpt\x00" }, "model_id", "invalid_characters"},
		{"model too long", func(in *Input) { in.ModelID = strings.Repeat("m", 201) }, "model_id", "too_long"},
		{"group zero", func(in *Input) { in.GroupID = i64p(0) }, "group_id", "positive"},
		{"group negative", func(in *Input) { in.GroupID = i64p(-3) }, "group_id", "positive"},
		{"display name too long", func(in *Input) { in.DisplayName = strings.Repeat("é", 101) }, "display_name", "too_long"},
		{"display name newline", func(in *Input) { in.DisplayName = "a\nb" }, "display_name", "invalid_characters"},
		{"description too long", func(in *Input) { in.Description = strings.Repeat("d", 501) }, "description", "too_long"},
		{"description control", func(in *Input) { in.Description = "a\x07b" }, "description", "invalid_characters"},
		{"usage hint too long", func(in *Input) { in.UsageHint = strings.Repeat("u", 41) }, "usage_hint", "too_long"},
		{"four badges", func(in *Input) { in.Badges = []string{"a", "b", "c", "d"} }, "badges", "too_many"},
		{"badge too long", func(in *Input) { in.Badges = []string{strings.Repeat("b", 17)} }, "badges", "pattern"},
		{"badge empty", func(in *Input) { in.Badges = []string{" "} }, "badges", "pattern"},
		{"badge symbol", func(in *Input) { in.Badges = []string{"<b>"} }, "badges", "pattern"},
		{"badge duplicate", func(in *Input) { in.Badges = []string{"New", "new"} }, "badges", "duplicate"},
		{"sort too big", func(in *Input) { in.SortOrder = 1_000_001 }, "sort_order", "out_of_range"},
		{"sort too small", func(in *Input) { in.SortOrder = -1_000_001 }, "sort_order", "out_of_range"},
		{"unknown effort", func(in *Input) { in.SupportedEfforts = []string{"ultra"} }, "supported_efforts", "unknown_effort"},
		{"duplicate effort", func(in *Input) { in.SupportedEfforts = []string{"low", "LOW"} }, "supported_efforts", "duplicate"},
		{"default effort without list", func(in *Input) { in.SupportedEfforts = nil }, "default_effort", "requires_supported_efforts"},
		{"default effort not listed", func(in *Input) { in.DefaultEffort = "max" }, "default_effort", "not_in_supported_efforts"},
		{"context window zero", func(in *Input) { in.ContextWindow = intp(0) }, "context_window", "out_of_range"},
		{"context window huge", func(in *Input) { in.ContextWindow = intp(100_000_001) }, "context_window", "out_of_range"},
		{"auto compact zero", func(in *Input) { in.AutoCompactTokens = intp(0) }, "auto_compact_tokens", "out_of_range"},
		{"auto compact over window", func(in *Input) { in.AutoCompactTokens = intp(400001) }, "auto_compact_tokens", "exceeds_context_window"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := validInput()
			tc.mutate(&in)
			err := normalize(&in)
			require.Error(t, err)
			app := infraerrors.FromError(err)
			require.EqualValues(t, 400, app.Code)
			require.Equal(t, "CLAUDEX_MODEL_META_INVALID", app.Reason)
			require.Equal(t, tc.field, app.Metadata["field"])
			require.Equal(t, tc.rule, app.Metadata["rule"])
		})
	}
}

func TestNormalizeAllowsAutoCompactWithoutWindow(t *testing.T) {
	in := Input{ModelID: "m", AutoCompactTokens: intp(5000)}
	require.NoError(t, normalize(&in))
}

func TestDecodeInput(t *testing.T) {
	in, present, err := decodeInput([]byte(`{"model_id":"a","group_id":null,"hidden":true,"extra":1}`))
	require.NoError(t, err)
	require.Equal(t, "a", in.ModelID)
	require.Nil(t, in.GroupID)
	require.True(t, in.Hidden)
	require.True(t, present["group_id"])
	require.False(t, present["badges"])

	for body, field := range map[string]string{
		`[1]`:                  "body",
		`not json`:             "body",
		`null`:                 "body",
		`{"sort_order":"ten"}`: "sort_order",
		`{"badges":"new"}`:     "badges",
	} {
		_, _, err := decodeInput([]byte(body))
		require.Error(t, err, body)
		app := infraerrors.FromError(err)
		require.Equal(t, "CLAUDEX_MODEL_META_INVALID", app.Reason, body)
		require.Equal(t, field, app.Metadata["field"], body)
	}
}

func TestSearchTextDropsWhatPostgresRejects(t *testing.T) {
	for in, want := range map[string]string{
		" gpt-5.5 ":    "gpt-5.5",
		"gpt\x00-5.5":  "gpt-5.5",
		"\x00":         "",
		"\xff":         "",
		"GPT-5.5\xffx": "GPT-5.5x",
		"1.5× usage":   "1.5× usage",
		`100%_\`:       `100%_\`,
	} {
		require.Equal(t, want, searchText(in), "%q", in)
	}
}
