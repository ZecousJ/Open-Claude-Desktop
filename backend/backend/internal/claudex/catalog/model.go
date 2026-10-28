package catalog

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
)

// Efforts is the reasoning-effort vocabulary of the catalog, lowest first. It
// matches the upstream group max_reasoning_effort values plus "none" (the
// reasoning_effort_billing and effort-mapping value that turns reasoning off).
var Efforts = []string{"none", "minimal", "low", "medium", "high", "xhigh", "max"}

var effortRank = func() map[string]int {
	m := make(map[string]int, len(Efforts))
	for i, e := range Efforts {
		m[e] = i
	}
	return m
}()

// Limits of the admin input (design 2.4 and the table columns).
const (
	maxModelIDLen     = 200
	maxDisplayNameLen = 100
	maxDescriptionLen = 500
	maxUsageHintLen   = 40
	maxBadges         = 3
	maxSortOrder      = 1_000_000
	maxTokens         = 100_000_000
	maxBodyBytes      = 64 << 10
)

// badgePattern is the badge rule of design 2.4 (the client styles new, beta
// and legacy; anything else is shown as text).
var badgePattern = regexp.MustCompile(`^[A-Za-z0-9 .×x+-]{1,16}$`)

// Row is one catalog entry as stored (and as the admin API answers it).
type Row struct {
	ID      int64  `json:"id"`
	ModelID string `json:"model_id"`
	GroupID *int64 `json:"group_id"`
	// GroupName is the name of the group of a group row ("" for global rows
	// and for deleted groups).
	GroupName string `json:"group_name"`
	// GroupDeleted marks a group row whose group was deleted: resolution
	// ignores it and the console labels it "Deleted".
	GroupDeleted          bool      `json:"group_deleted"`
	DisplayName           string    `json:"display_name"`
	Description           string    `json:"description"`
	Badges                []string  `json:"badges"`
	SortOrder             int       `json:"sort_order"`
	Hidden                bool      `json:"hidden"`
	IsDefault             bool      `json:"is_default"`
	SupportedEfforts      []string  `json:"supported_efforts"` // null: the client gets no efforts field
	DefaultEffort         string    `json:"default_effort"`
	ContextWindow         *int      `json:"context_window"`
	AutoCompactTokens     *int      `json:"auto_compact_tokens"`
	FastTier              *bool     `json:"fast_tier"`
	UsageHint             string    `json:"usage_hint"`
	MinimumDesktopVersion string    `json:"minimum_desktop_version"`
	CreatedBy             *int64    `json:"created_by"`
	CreatedAt             time.Time `json:"created_at"`
	UpdatedAt             time.Time `json:"updated_at"`
}

// Input is the body of POST /admin/claudex/models and PUT /models/:id.
type Input struct {
	ModelID               string   `json:"model_id"`
	GroupID               *int64   `json:"group_id"`
	DisplayName           string   `json:"display_name"`
	Description           string   `json:"description"`
	Badges                []string `json:"badges"`
	SortOrder             int      `json:"sort_order"`
	Hidden                bool     `json:"hidden"`
	IsDefault             bool     `json:"is_default"`
	SupportedEfforts      []string `json:"supported_efforts"`
	DefaultEffort         string   `json:"default_effort"`
	ContextWindow         *int     `json:"context_window"`
	AutoCompactTokens     *int     `json:"auto_compact_tokens"`
	FastTier              *bool    `json:"fast_tier"`
	UsageHint             string   `json:"usage_hint"`
	MinimumDesktopVersion string   `json:"minimum_desktop_version"`
}

// Item is one model of the catalog the desktop client gets.
type Item struct {
	ID          string   `json:"id"`
	DisplayName string   `json:"display_name"`
	Description string   `json:"description"`
	Badges      []string `json:"badges"`
	Sort        int      `json:"sort"`
	// Hidden models are still sent: the client lists them under More models
	// (owner decision 11). A model is removed for good with the group model
	// allowlist.
	Hidden  bool `json:"hidden"`
	Default bool `json:"default"`
	// Efforts is absent when the row has no supported_efforts, and [] when
	// the group ceiling allows none of them.
	Efforts           *[]string `json:"efforts,omitempty"`
	DefaultEffort     string    `json:"default_effort,omitempty"`
	ContextWindow     *int      `json:"context_window"`
	AutoCompactTokens *int      `json:"auto_compact_tokens"`
	// Fast mode was dropped (R6): the admin API still accepts fast_tier, but
	// the client no longer gets a fast field.
	UsageHint             string `json:"usage_hint"`
	MinimumDesktopVersion string `json:"minimum_desktop_version,omitempty"`
	// WebSearch is how the model searches the web through the gateway:
	// "native" (the upstream's own web_search tool) or "none".
	WebSearch string `json:"web_search"`
	// XSearch reports that the model can also search X (grok models).
	XSearch bool `json:"x_search"`
	// GroupID is the group whose device key serves the model (MG); null in
	// a catalog without a group.
	GroupID *int64 `json:"group_id"`
	// groupRow: the entry comes from a row of the item's group rather than
	// a global row (Merge prefers such entries).
	groupRow bool
}

// Web search capabilities of a catalog item.
const (
	WebSearchNative = "native"
	WebSearchNone   = "none"
)

// Catalog is the answer of GET /api/v1/claudex/models and the bootstrap
// section "models".
type Catalog struct {
	GroupID      *int64  `json:"group_id"`
	DefaultModel *string `json:"default_model"`
	Items        []Item  `json:"items"`
}

// Candidates is the answer of GET /admin/claudex/models/candidates.
type Candidates struct {
	Models  []string            `json:"models"`
	Sources map[string][]string `json:"sources"`
}

// Candidate sources, in the order they are listed.
const (
	SourceAllowlist      = "allowlist"
	SourceDefaultMapped  = "default_mapped_model"
	SourceChannelPricing = "channel_pricing"
	SourceChannelMapping = "channel_mapping"
	SourceGroupPricing   = "group_pricing"
)

// Errors (design 1.8).
var (
	ErrNotFound = infraerrors.NotFound("CLAUDEX_MODEL_META_NOT_FOUND", "Model catalog entry not found")
	ErrConflict = infraerrors.Conflict("CLAUDEX_MODEL_META_CONFLICT",
		"This model already has a catalog entry for this scope")
	ErrDefaultConflict = infraerrors.Conflict("CLAUDEX_MODEL_META_CONFLICT",
		"Another default model was saved at the same time. Reload and try again.")
	ErrGroupNotFound = infraerrors.BadRequest("CLAUDEX_GROUP_NOT_FOUND", "Group not found")
)

func invalid(field, rule, message string) error {
	return core.InvalidSetting("CLAUDEX_MODEL_META_INVALID", field, rule, message)
}

// decodeInput reads an admin body. Unknown fields are ignored; a malformed
// body or a wrong JSON type is CLAUDEX_MODEL_META_INVALID. present reports
// which top-level keys the body contained.
func decodeInput(raw []byte) (in Input, present map[string]bool, err error) {
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(raw, &keys); err != nil || keys == nil {
		return in, nil, invalid("body", "malformed_json", "The request body must be a JSON object")
	}
	if err := json.Unmarshal(raw, &in); err != nil {
		field := "body"
		var typeErr *json.UnmarshalTypeError
		if errors.As(err, &typeErr) && typeErr.Field != "" {
			field = typeErr.Field
		}
		return in, nil, invalid(field, "wrong_type", "Invalid value for "+field)
	}
	present = make(map[string]bool, len(keys))
	for k := range keys {
		present[k] = true
	}
	return in, present, nil
}

// normalize trims and canonicalizes an input and checks every rule except
// the existence of the group (the handler checks that with the upstream
// groups).
func normalize(in *Input) error {
	in.ModelID = strings.TrimSpace(in.ModelID)
	switch {
	case in.ModelID == "":
		return invalid("model_id", "required", "Model ID is required")
	case !utf8.ValidString(in.ModelID) || strings.IndexFunc(in.ModelID, func(r rune) bool {
		return unicode.IsSpace(r) || unicode.IsControl(r) || r == '*'
	}) >= 0:
		return invalid("model_id", "invalid_characters", "Model ID must be an exact model name without spaces or wildcards")
	case utf8.RuneCountInString(in.ModelID) > maxModelIDLen:
		return invalid("model_id", "too_long", fmt.Sprintf("Model ID must be at most %d characters", maxModelIDLen))
	}
	if in.GroupID != nil && *in.GroupID <= 0 {
		return invalid("group_id", "positive", "Group ID must be a positive number, or null for every group")
	}

	var err error
	in.MinimumDesktopVersion = strings.TrimSpace(in.MinimumDesktopVersion)
	if in.MinimumDesktopVersion != "" && !core.ValidVersion(in.MinimumDesktopVersion) {
		return invalid("minimum_desktop_version", "invalid", "Invalid version")
	}
	if in.DisplayName, err = cleanText("display_name", in.DisplayName, maxDisplayNameLen, false); err != nil {
		return err
	}
	if in.Description, err = cleanText("description", in.Description, maxDescriptionLen, true); err != nil {
		return err
	}
	if in.UsageHint, err = cleanText("usage_hint", in.UsageHint, maxUsageHintLen, false); err != nil {
		return err
	}

	if len(in.Badges) > maxBadges {
		return invalid("badges", "too_many", fmt.Sprintf("At most %d badges", maxBadges))
	}
	badges := make([]string, 0, len(in.Badges))
	seen := map[string]bool{}
	for _, b := range in.Badges {
		b = strings.TrimSpace(b)
		if !badgePattern.MatchString(b) {
			return invalid("badges", "pattern", "A badge is 1 to 16 letters, digits, spaces or . × + -")
		}
		if seen[strings.ToLower(b)] {
			return invalid("badges", "duplicate", "Badges must be different")
		}
		seen[strings.ToLower(b)] = true
		badges = append(badges, b)
	}
	in.Badges = badges

	if in.SortOrder < -maxSortOrder || in.SortOrder > maxSortOrder {
		return invalid("sort_order", "out_of_range",
			fmt.Sprintf("Sort order must be between %d and %d", -maxSortOrder, maxSortOrder))
	}

	if in.SupportedEfforts != nil {
		efforts := make([]string, 0, len(in.SupportedEfforts))
		seenEffort := map[string]bool{}
		for _, e := range in.SupportedEfforts {
			e = strings.ToLower(strings.TrimSpace(e))
			if _, ok := effortRank[e]; !ok {
				return invalid("supported_efforts", "unknown_effort", "Efforts must be "+strings.Join(Efforts, ", "))
			}
			if seenEffort[e] {
				return invalid("supported_efforts", "duplicate", "Efforts must be different")
			}
			seenEffort[e] = true
			efforts = append(efforts, e)
		}
		sort.SliceStable(efforts, func(i, j int) bool { return effortRank[efforts[i]] < effortRank[efforts[j]] })
		in.SupportedEfforts = efforts
	}
	in.DefaultEffort = strings.ToLower(strings.TrimSpace(in.DefaultEffort))
	if in.DefaultEffort != "" {
		if in.SupportedEfforts == nil {
			return invalid("default_effort", "requires_supported_efforts", "Set the supported efforts before a default effort")
		}
		if !contains(in.SupportedEfforts, in.DefaultEffort) {
			return invalid("default_effort", "not_in_supported_efforts", "The default effort must be one of the supported efforts")
		}
	}

	if in.ContextWindow != nil && (*in.ContextWindow <= 0 || *in.ContextWindow > maxTokens) {
		return invalid("context_window", "out_of_range",
			fmt.Sprintf("Context window must be between 1 and %d tokens", maxTokens))
	}
	if in.AutoCompactTokens != nil {
		if *in.AutoCompactTokens <= 0 || *in.AutoCompactTokens > maxTokens {
			return invalid("auto_compact_tokens", "out_of_range",
				fmt.Sprintf("Auto-compact threshold must be between 1 and %d tokens", maxTokens))
		}
		if in.ContextWindow != nil && *in.AutoCompactTokens > *in.ContextWindow {
			return invalid("auto_compact_tokens", "exceeds_context_window",
				"Auto-compact threshold must not exceed the context window")
		}
	}
	return nil
}

// cleanText trims s and rejects invalid UTF-8, control characters
// (description may contain line breaks and tabs) and text longer than maxLen
// characters.
func cleanText(field, s string, maxLen int, multiline bool) (string, error) {
	s = strings.TrimSpace(s)
	if !utf8.ValidString(s) {
		return "", invalid(field, "invalid_characters", "Invalid text in "+field)
	}
	if utf8.RuneCountInString(s) > maxLen {
		return "", invalid(field, "too_long", fmt.Sprintf("%s must be at most %d characters", field, maxLen))
	}
	if strings.IndexFunc(s, func(r rune) bool {
		if multiline && (r == '\n' || r == '\t') {
			return false
		}
		return unicode.IsControl(r)
	}) >= 0 {
		return "", invalid(field, "invalid_characters", "Control characters are not allowed in "+field)
	}
	return s, nil
}

func contains(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}
