package usage

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/Wei-Shaw/sub2api/internal/pkg/claude"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/openai"
	"github.com/Wei-Shaw/sub2api/internal/service"
)

// Rule kinds (claudex_usage_rules.kind).
const (
	KindSession   = "session"    // "Current session", model_patterns ["*"], 5 h by default
	KindAllModels = "all_models" // "Weekly limits · All models", model_patterns ["*"]
	KindModels    = "models"     // one row per rule, labelled with the rule's label
)

// Limits of the rule fields (design 2.6 and the migration's CHECKs).
const (
	MinWindowSeconds     = 3600
	MaxWindowSeconds     = 2592000
	DefaultSessionWindow = 18000
	MaxPatterns          = 50
	MaxPatternLength     = 200
	MaxLabelLength       = 60
	// maxLimitUSD keeps limit_usd inside NUMERIC(20,8) (12 integer digits).
	maxLimitUSD = 1e12
)

// Default labels of the kinds whose rows the client names itself.
const (
	DefaultSessionLabel   = "Current session"
	DefaultAllModelsLabel = "All models"
)

// Rule is one usage rule as stored and shown to administrators.
type Rule struct {
	ID            int64     `json:"id"`
	GroupID       *int64    `json:"group_id"`
	GroupName     *string   `json:"group_name"`
	GroupDeleted  bool      `json:"group_deleted"`
	Kind          string    `json:"kind"`
	Label         string    `json:"label"`
	ModelPatterns []string  `json:"model_patterns"`
	WindowSeconds int       `json:"window_seconds"`
	LimitUSD      float64   `json:"limit_usd"`
	Enabled       bool      `json:"enabled"`
	ShowInClient  bool      `json:"show_in_client"`
	SortOrder     int       `json:"sort_order"`
	CreatedBy     *int64    `json:"created_by"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

// activeRule is an enabled rule compiled for the hot paths (precheck,
// counting, usage-status).
type activeRule struct {
	ID            int64
	GroupID       *int64
	Kind          string
	Label         string
	Patterns      []string // as stored
	WindowSeconds int
	LimitUSD      float64
	ShowInClient  bool
	SortOrder     int

	allModels bool
	exact     map[string]bool // lowercased exact names
	prefixes  []string        // lowercased prefixes of "prefix*" patterns
}

func compileRule(r activeRule) *activeRule {
	out := r
	out.exact = map[string]bool{}
	out.prefixes = nil
	out.allModels = r.Kind != KindModels
	if !out.allModels {
		for _, p := range r.Patterns {
			p = strings.ToLower(strings.TrimSpace(p))
			switch {
			case p == "" || p == "*":
				// A bare "*" is only valid for session/all_models (validation
				// rejects it for models); never widen a models rule by accident.
			case strings.HasSuffix(p, "*"):
				out.prefixes = append(out.prefixes, strings.TrimSuffix(p, "*"))
			default:
				out.exact[p] = true
			}
		}
	}
	return &out
}

// matches reports whether a model name falls under the rule (case-insensitive;
// exact names or "prefix*").
func (r *activeRule) matches(model string) bool {
	if r.allModels {
		return true
	}
	m := strings.ToLower(strings.TrimSpace(model))
	if m == "" {
		return false
	}
	if r.exact[m] {
		return true
	}
	for _, p := range r.prefixes {
		if strings.HasPrefix(m, p) {
			return true
		}
	}
	return false
}

// modelNameForms adds to model names the forms upstream serves them as. It
// is a superset of the group model allowlist's candidates
// (service.groupModelAllowlistCandidates): the name without a provider or
// "models/" prefix (Antigravity and Gemini clients, "openai/..."), the Claude
// OAuth id of a short name with "-thinking" removed, the OpenAI alias spelling
// ("gpt5.5", "GPT_5.5") and the OpenAI-compatible name without a
// reasoning-effort suffix. Without them a request for "models/claude-opus-4-5"
// is served as Opus but passes the Opus rule. Upstream normalizations that are
// not exported (such as Codex date suffixes) are only caught by "prefix*"
// patterns.
func modelNameForms(models ...string) []string {
	out := make([]string, 0, len(models)*4)
	seen := map[string]bool{}
	add := func(v string) {
		v = strings.TrimSpace(v)
		if v != "" && !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	for _, m := range models {
		m = strings.TrimSpace(m)
		if m == "" {
			continue
		}
		for _, v := range []string{m, strings.ToLower(m)} {
			add(v)
			last := v
			if i := strings.LastIndexByte(v, '/'); i >= 0 {
				last = v[i+1:]
			}
			add(last)
			add(claude.NormalizeModelID(strings.TrimSuffix(last, "-thinking")))
			add(service.NormalizeOpenAICompatRequestedModel(v))
			add(openai.CanonicalizeOpenAIModelAliasSpelling(v))
		}
	}
	return out
}

// matchesAny reports whether any of the names falls under the rule.
func (r *activeRule) matchesAny(models ...string) bool {
	if r.allModels {
		return true
	}
	for _, m := range models {
		if r.matches(m) {
			return true
		}
	}
	return false
}

// clientModels is the "models" value shown to clients: the patterns of a
// per-model rule, nil for the rules that cover every model.
func (r *activeRule) clientModels() []string {
	if r.Kind != KindModels {
		return nil
	}
	return append([]string(nil), r.Patterns...)
}

// kindRank orders rule rows the way usage-status lists them.
func kindRank(kind string) int {
	switch kind {
	case KindSession:
		return 0
	case KindAllModels:
		return 1
	default:
		return 2
	}
}

// windowLabel turns a window length into the short form clients show and map
// ("5h", "7d", "30d"; minutes or seconds only for odd lengths).
func windowLabel(seconds int) string {
	switch {
	case seconds <= 0:
		return ""
	case seconds%86400 == 0:
		return strconv.Itoa(seconds/86400) + "d"
	case seconds%3600 == 0:
		return strconv.Itoa(seconds/3600) + "h"
	case seconds%60 == 0:
		return strconv.Itoa(seconds/60) + "m"
	default:
		return strconv.Itoa(seconds) + "s"
	}
}

// resetTimeText formats a reset time for English messages, always in UTC:
// "Oct 2, 8:00 AM UTC". Clients may reformat resets_at in local time.
func resetTimeText(t time.Time) string {
	return t.UTC().Format("Jan 2, 3:04 PM") + " UTC"
}

// limitMessage is the English refusal text for a rule.
func limitMessage(kind, label string, resetsAt time.Time) string {
	when := resetTimeText(resetsAt)
	switch kind {
	case KindSession:
		return "You've reached your session limit. It resets " + when + "."
	case KindAllModels:
		return "You've reached your usage limit for all models. It resets " + when + "."
	default:
		return "You've reached the " + label + " limit. It resets " + when + "."
	}
}

// roundUSD drops float noise from USD amounts (the columns keep 8 decimals).
func roundUSD(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	return math.Round(v*1e8) / 1e8
}

// percentOf is min(100, round(used/limit*100)), 0 without a limit.
func percentOf(used, limit float64) int {
	if limit <= 0 || used <= 0 {
		return 0
	}
	p := math.Round(used / limit * 100)
	if p > 100 {
		return 100
	}
	return int(p)
}

// Errors (design 1.8).
var (
	ErrRuleNotFound = infraerrors.NotFound("CLAUDEX_USAGE_RULE_NOT_FOUND", "Usage rule not found.")
	ErrGroupMissing = infraerrors.BadRequest("CLAUDEX_GROUP_NOT_FOUND", "The group does not exist or was deleted.")
	ErrUserMissing  = infraerrors.BadRequest("CLAUDEX_USER_NOT_FOUND", "The user does not exist or was deleted.")
)

func invalidRule(field, rule, message string) error {
	return infraerrors.BadRequest("CLAUDEX_USAGE_RULE_INVALID", message).
		WithMetadata(map[string]string{"field": field, "rule": rule})
}

// ruleFields is the editable part of a rule after defaults are applied.
type ruleFields struct {
	GroupID       *int64
	Kind          string
	Label         string
	ModelPatterns []string
	WindowSeconds int
	LimitUSD      float64
	Enabled       bool
	ShowInClient  bool
	SortOrder     int
}

// normalizeAndValidate trims and checks the fields (group existence is
// checked by the caller). Session and all-models rules always cover every
// model; per-model rules need 1..50 patterns, each an exact name or a
// "prefix*" wildcard, compared case-insensitively.
func (f *ruleFields) normalizeAndValidate() error {
	f.Kind = strings.TrimSpace(f.Kind)
	switch f.Kind {
	case KindSession, KindAllModels, KindModels:
	default:
		return invalidRule("kind", "enum", "Kind must be session, all_models or models.")
	}
	if f.GroupID != nil && *f.GroupID <= 0 {
		return invalidRule("group", "positive", "Group id must be a positive number, or null for every group.")
	}

	f.Label = strings.TrimSpace(f.Label)
	if f.Label == "" {
		switch f.Kind {
		case KindSession:
			f.Label = DefaultSessionLabel
		case KindAllModels:
			f.Label = DefaultAllModelsLabel
		default:
			return invalidRule("label", "required", "Per-model rules need a label, such as Opus.")
		}
	}
	if utf8.RuneCountInString(f.Label) > MaxLabelLength || hasControl(f.Label) {
		return invalidRule("label", "length", fmt.Sprintf("Label must be at most %d characters without control characters.", MaxLabelLength))
	}

	if f.Kind != KindModels {
		for _, p := range f.ModelPatterns {
			if strings.TrimSpace(p) != "*" {
				return invalidRule("patterns", "all_models_only", "Session and all-models rules always cover every model; leave model_patterns as [\"*\"].")
			}
		}
		f.ModelPatterns = []string{"*"}
	} else {
		patterns, err := normalizePatterns(f.ModelPatterns)
		if err != nil {
			return err
		}
		f.ModelPatterns = patterns
	}

	if f.WindowSeconds == 0 && f.Kind == KindSession {
		f.WindowSeconds = DefaultSessionWindow
	}
	if f.WindowSeconds < MinWindowSeconds || f.WindowSeconds > MaxWindowSeconds {
		return invalidRule("window", "range", fmt.Sprintf("Window must be between %d and %d seconds (1 hour to 30 days).", MinWindowSeconds, MaxWindowSeconds))
	}
	if math.IsNaN(f.LimitUSD) || math.IsInf(f.LimitUSD, 0) || f.LimitUSD <= 0 || f.LimitUSD >= maxLimitUSD {
		return invalidRule("limit", "range", "Limit must be a positive USD amount below 1,000,000,000,000.")
	}
	f.LimitUSD = roundUSD(f.LimitUSD)
	if f.LimitUSD <= 0 {
		return invalidRule("limit", "range", "Limit must be at least 0.00000001 USD.")
	}
	if f.SortOrder < math.MinInt32 || f.SortOrder > math.MaxInt32 {
		return invalidRule("sort_order", "range", "Sort order is out of range.")
	}
	return nil
}

func normalizePatterns(in []string) ([]string, error) {
	out := make([]string, 0, len(in))
	seen := map[string]bool{}
	for _, raw := range in {
		p := strings.TrimSpace(raw)
		if p == "" {
			continue
		}
		if utf8.RuneCountInString(p) > MaxPatternLength {
			return nil, invalidRule("patterns", "length", fmt.Sprintf("Each model pattern must be at most %d characters.", MaxPatternLength))
		}
		if p == "*" {
			return nil, invalidRule("patterns", "bare_wildcard", "A per-model rule cannot match every model; use an all-models rule instead.")
		}
		if i := strings.Index(p, "*"); i >= 0 && i != len(p)-1 {
			return nil, invalidRule("patterns", "wildcard_suffix", "Model patterns are exact names or end with a single * (for example claude-opus-*).")
		}
		if strings.IndexFunc(p, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }) >= 0 {
			return nil, invalidRule("patterns", "characters", "Model patterns cannot contain spaces or control characters.")
		}
		key := strings.ToLower(p)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, p)
	}
	if len(out) == 0 {
		return nil, invalidRule("patterns", "required", "Per-model rules need at least one model pattern.")
	}
	if len(out) > MaxPatterns {
		return nil, invalidRule("patterns", "count", fmt.Sprintf("A rule can have at most %d model patterns.", MaxPatterns))
	}
	return out, nil
}

func hasControl(s string) bool {
	return strings.IndexFunc(s, unicode.IsControl) >= 0
}
