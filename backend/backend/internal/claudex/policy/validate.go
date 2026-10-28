package policy

import (
	"log/slog"
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
)

// Error reasons (design 1.8).
const (
	ReasonInvalid          = "CLAUDEX_POLICY_INVALID"
	ReasonRevisionConflict = "CLAUDEX_POLICY_REVISION_CONFLICT"
	ReasonGroupNotFound    = "CLAUDEX_GROUP_NOT_FOUND"
	ReasonUserNotFound     = "CLAUDEX_USER_NOT_FOUND"
)

// Validation rules, reported as metadata.rule next to metadata.field.
const (
	RuleInvalidJSON     = "invalid_json"                 // the body is not JSON
	RuleInvalidType     = "invalid_type"                 // wrong JSON type, or null where no null is allowed
	RuleUnknownField    = "unknown_field"                // a key the policy does not have
	RuleDuplicateField  = "duplicate_field"              // the same key twice in one object
	RuleRequired        = "required"                     // a required key is missing or a text is empty
	RuleBypass          = "bypass_not_policy_controlled" // Bypass permissions is the user's choice (owner decision 3)
	RuleUnknownMode     = "unknown_mode"                 // not auto|manual|acceptEdits|plan
	RuleEmptyModeList   = "empty_mode_list"              // a platform allows no mode
	RuleUnknownPlatform = "unknown_platform"             // not default|darwin|win32|linux
	RuleHTTPSRequired   = "https_required"               // not an https URL without credentials, <= 2000 bytes
	RuleTooMany         = "too_many"                     // list or override count over its limit
	RuleTooLong         = "too_long"                     // text over its length limit
	RuleOutOfRange      = "out_of_range"                 // number outside its range
	RuleInvalidName     = "invalid_name"                 // connector name not [a-zA-Z0-9_-]{1,100}
	RuleUnknownType     = "unknown_type"                 // attachment type outside the 26 built-in ones
	RuleInvalidDomain   = "invalid_domain"               // not a host name or *.host name
	RuleInvalidID       = "invalid_id"                   // override id not a positive integer
	RuleDuplicateID     = "duplicate_id"                 // the same group or user twice
	RuleTooLarge        = "too_large"                    // the policy JSON is over 256 KB
	RuleNotFound        = "not_found"                    // the group or user does not exist
	RuleInvalidModel    = "invalid_model"                // not an exact model id (1-200 characters, no spaces or *)
	RuleInvalidApp      = "invalid_app"                  // not a bundle id or program name (letters, digits, . _ - and spaces)
)

// Limits (design 2.3).
const (
	maxURLBytes         = 2000
	maxLearnMore        = 10
	maxLabelChars       = 60
	maxPlanLabelChars   = 20
	maxConnectors       = 200
	maxCommandChars     = 500
	maxConnectorArgs    = 50
	maxArgChars         = 500
	maxDomains          = 100
	maxDomainBytes      = 253
	maxMegabytes        = 20
	minWarnPercent      = 1
	maxWarnPercent      = 99
	maxScheduledTasks   = 100
	maxGroupOverrides   = 200
	maxUserOverrides    = 1000
	maxPolicyBytes      = 256 << 10
	maxOverrideIDDigits = 19
	// Round 2 (package POL).
	maxModelIDChars      = 200
	maxBlockedDomains    = 200
	maxDeniedApps        = 100
	maxAppChars          = 200
	minSearchesPerTurn   = 1
	maxSearchesPerTurn   = 200
	minActionsPerTurn    = 1
	maxActionsPerTurnCap = 1000
)

var (
	connectorNameRe = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,100}$`)
	hostLabel       = `[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?`
	domainRe        = regexp.MustCompile(`^(?:\*\.)?` + hostLabel + `(?:\.` + hostLabel + `)*$`)
	policyModeSet   = map[string]bool{"auto": true, "manual": true, "acceptEdits": true, "plan": true}
	attachmentSet   = func() map[string]bool {
		m := make(map[string]bool, len(AttachmentTypes))
		for _, t := range AttachmentTypes {
			m[t] = true
		}
		return m
	}()
	modePlatforms = map[string]bool{platformDefault: true, platformDarwin: true, platformWin32: true, platformLinux: true}
	// appNameRe is a macOS bundle id or a Windows/Linux program name.
	appNameRe = regexp.MustCompile(`^[A-Za-z0-9._ -]+$`)
)

var ruleMessages = map[string]string{
	RuleInvalidJSON:     "is not valid JSON",
	RuleInvalidType:     "has the wrong type",
	RuleUnknownField:    "is not a policy field",
	RuleDuplicateField:  "appears more than once",
	RuleRequired:        "is required",
	RuleBypass:          "cannot be set: Bypass permissions is always the user's own choice",
	RuleUnknownMode:     "has a mode other than auto, manual, acceptEdits or plan",
	RuleEmptyModeList:   "must allow at least one mode",
	RuleUnknownPlatform: "must be default, darwin, win32 or linux",
	RuleHTTPSRequired:   "must be an https URL without credentials, at most 2000 characters",
	RuleTooMany:         "has too many entries",
	RuleTooLong:         "is too long",
	RuleOutOfRange:      "is out of range",
	RuleInvalidName:     "must be 1-100 letters, digits, - or _",
	RuleUnknownType:     "has a file type Claudex cannot attach",
	RuleInvalidDomain:   "must be a lower-case host name or *.host name without port or path",
	RuleInvalidID:       "must be a positive integer id",
	RuleDuplicateID:     "is listed more than once",
	RuleTooLarge:        "is larger than 256 KB",
	RuleNotFound:        "does not exist",
	RuleInvalidModel:    "must be an exact model id of 1-200 characters without spaces or *",
	RuleInvalidApp:      "must be 1-200 letters, digits, spaces, dots, - or _ (a bundle id or program name)",
}

// invalid is the 400 CLAUDEX_POLICY_INVALID answer for one field and rule.
func invalid(field, rule string) error {
	msg := ruleMessages[rule]
	if msg == "" {
		msg = "is invalid"
	}
	name := field
	if name == "" {
		name = "The policy"
	} else {
		name = "Policy field " + name
	}
	return core.InvalidSetting(ReasonInvalid, field, rule, name+" "+msg+".")
}

func groupNotFound(field string, id int64) error {
	return infraerrors.BadRequest(ReasonGroupNotFound, "Group "+strconv.FormatInt(id, 10)+" does not exist.").
		WithMetadata(map[string]string{"field": field, "rule": RuleNotFound})
}

func userNotFound(field string, id int64) error {
	return infraerrors.BadRequest(ReasonUserNotFound, "User "+strconv.FormatInt(id, 10)+" does not exist.").
		WithMetadata(map[string]string{"field": field, "rule": RuleNotFound})
}

func revisionConflict(current int64) error {
	return infraerrors.Conflict(ReasonRevisionConflict,
		"The policy was changed by someone else. Reload it and apply your changes again.").
		WithMetadata(map[string]string{"current_revision": strconv.FormatInt(current, 10)})
}

// join builds a dotted field path.
func join(where, key string) string {
	if where == "" {
		return key
	}
	return where + "." + key
}

func index(where string, i int) string { return where + "[" + strconv.Itoa(i) + "]" }

// ---- typed validators: shared by the strict parser (PUT, preview) and the
// sanitizer that cleans a stored document on read.

// checkModes validates one permission-mode list and returns it deduplicated in
// the fixed order auto, manual, acceptEdits, plan.
func checkModes(list []string, where string) ([]string, error) {
	seen := map[string]bool{}
	for _, m := range list {
		if isBypass(m) {
			return nil, invalid(where, RuleBypass)
		}
		if !policyModeSet[m] {
			return nil, invalid(where, RuleUnknownMode)
		}
		seen[m] = true
	}
	out := make([]string, 0, len(seen))
	for _, m := range PolicyModes {
		if seen[m] {
			out = append(out, m)
		}
	}
	if len(out) == 0 {
		return nil, invalid(where, RuleEmptyModeList)
	}
	return out, nil
}

// isBypass recognizes every spelling of Bypass permissions.
func isBypass(s string) bool {
	return strings.Contains(strings.ToLower(s), "bypass")
}

func checkModeSpec(spec ModeSpec, where string) (ModeSpec, error) {
	if spec.ByPlatform == nil {
		list, err := checkModes(spec.List, where)
		if err != nil {
			return ModeSpec{}, err
		}
		return ModeSpec{List: list}, nil
	}
	out := ModeSpec{ByPlatform: make(map[string][]string, len(spec.ByPlatform))}
	for _, platform := range []string{platformDefault, platformDarwin, platformWin32, platformLinux} {
		list, ok := spec.ByPlatform[platform]
		if !ok {
			continue
		}
		checked, err := checkModes(list, join(where, platform))
		if err != nil {
			return ModeSpec{}, err
		}
		out.ByPlatform[platform] = checked
	}
	for platform := range spec.ByPlatform {
		if !modePlatforms[platform] {
			if isBypass(platform) {
				return ModeSpec{}, invalid(join(where, platform), RuleBypass)
			}
			return ModeSpec{}, invalid(join(where, platform), RuleUnknownPlatform)
		}
	}
	return out, nil
}

func checkURL(raw, where string) (string, error) {
	u, err := core.HTTPSURL(raw, maxURLBytes)
	if err != nil {
		return "", invalid(where, RuleHTTPSRequired)
	}
	return u, nil
}

// checkText trims a label and checks 1..limit characters.
func checkText(raw, where string, limit int) (string, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", invalid(where, RuleRequired)
	}
	if utf8.RuneCountInString(s) > limit {
		return "", invalid(where, RuleTooLong)
	}
	return s, nil
}

func checkLearnMore(list []Link, where string) ([]Link, error) {
	if len(list) > maxLearnMore {
		return nil, invalid(where, RuleTooMany)
	}
	out := make([]Link, 0, len(list))
	for i, l := range list {
		label, err := checkText(l.Label, join(index(where, i), "label"), maxLabelChars)
		if err != nil {
			return nil, err
		}
		u, err := checkURL(l.URL, join(index(where, i), "url"))
		if err != nil {
			return nil, err
		}
		out = append(out, Link{Label: label, URL: u})
	}
	return out, nil
}

func checkConnectors(list []ConnectorRule, where string) ([]ConnectorRule, error) {
	if len(list) > maxConnectors {
		return nil, invalid(where, RuleTooMany)
	}
	out := make([]ConnectorRule, 0, len(list))
	for i, r := range list {
		at := index(where, i)
		if !connectorNameRe.MatchString(r.Name) {
			return nil, invalid(join(at, "name"), RuleInvalidName)
		}
		rule := ConnectorRule{Name: r.Name}
		if r.URLPrefix != "" {
			u, err := checkURL(r.URLPrefix, join(at, "url_prefix"))
			if err != nil {
				return nil, err
			}
			rule.URLPrefix = u
		}
		if r.Command != "" {
			if utf8.RuneCountInString(r.Command) > maxCommandChars {
				return nil, invalid(join(at, "command"), RuleTooLong)
			}
			rule.Command = r.Command
		}
		if len(r.Args) > 0 {
			// Arguments only bind a local command: the client matches the
			// program and the argument list exactly.
			if r.Command == "" {
				return nil, invalid(join(at, "command"), RuleRequired)
			}
			if len(r.Args) > maxConnectorArgs {
				return nil, invalid(join(at, "args"), RuleTooMany)
			}
			for j, arg := range r.Args {
				if utf8.RuneCountInString(arg) > maxArgChars {
					return nil, invalid(index(join(at, "args"), j), RuleTooLong)
				}
			}
			rule.Args = cloneStrings(r.Args)
		}
		out = append(out, rule)
	}
	return out, nil
}

// checkDomains lower-cases, deduplicates and checks a host-name list.
func checkDomains(list []string, where string) ([]string, error) {
	return checkDomainsUpTo(list, where, maxDomains)
}

func checkDomainsUpTo(list []string, where string, limit int) ([]string, error) {
	if len(list) > limit {
		return nil, invalid(where, RuleTooMany)
	}
	out := make([]string, 0, len(list))
	seen := map[string]bool{}
	for i, raw := range list {
		d := strings.ToLower(strings.TrimSpace(raw))
		if len(d) > maxDomainBytes || !domainRe.MatchString(d) {
			return nil, invalid(index(where, i), RuleInvalidDomain)
		}
		if !seen[d] {
			seen[d] = true
			out = append(out, d)
		}
	}
	return out, nil
}

// checkTypes lower-cases, strips a leading dot, deduplicates and checks
// attachment types against the built-in list (keeping the given order).
func checkTypes(list []string, where string) ([]string, error) {
	out := make([]string, 0, len(list))
	seen := map[string]bool{}
	for i, raw := range list {
		t := strings.TrimPrefix(strings.ToLower(strings.TrimSpace(raw)), ".")
		if !attachmentSet[t] {
			return nil, invalid(index(where, i), RuleUnknownType)
		}
		if !seen[t] {
			seen[t] = true
			out = append(out, t)
		}
	}
	return out, nil
}

// checkMegabytes accepts (0, 20] megabytes that come to at least one byte:
// a limit that rounds to max_bytes 0 would block every attachment, which is
// what an empty types list is for.
func checkMegabytes(v float64, where string) error {
	if math.IsNaN(v) || v <= 0 || v > maxMegabytes || math.Round(v*bytesPerMegabyte) < 1 {
		return invalid(where, RuleOutOfRange)
	}
	return nil
}

func checkRange(v, lo, hi int, where string) error {
	if v < lo || v > hi {
		return invalid(where, RuleOutOfRange)
	}
	return nil
}

// checkModelID trims an exact model id: 1..200 characters, no white space,
// control characters or "*" (like the model catalog's model_id).
func checkModelID(raw, where string) (string, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", invalid(where, RuleRequired)
	}
	if !utf8.ValidString(s) || utf8.RuneCountInString(s) > maxModelIDChars ||
		strings.IndexFunc(s, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) || r == '*' }) >= 0 {
		return "", invalid(where, RuleInvalidModel)
	}
	return s, nil
}

// checkApps trims, deduplicates (ignoring case) and checks a list of bundle
// ids or program names.
func checkApps(list []string, where string) ([]string, error) {
	if len(list) > maxDeniedApps {
		return nil, invalid(where, RuleTooMany)
	}
	out := make([]string, 0, len(list))
	seen := map[string]bool{}
	for i, raw := range list {
		app := strings.TrimSpace(raw)
		if app == "" || utf8.RuneCountInString(app) > maxAppChars || !appNameRe.MatchString(app) {
			return nil, invalid(index(where, i), RuleInvalidApp)
		}
		if key := strings.ToLower(app); !seen[key] {
			seen[key] = true
			out = append(out, app)
		}
	}
	return out, nil
}

// checkRound2 validates the memory, research, browser, codex_runtime_mirror
// and computer_use fields of a patch into out.
func checkRound2(p Patch, out *Patch, where string) error {
	if p.Memory != nil {
		m := *p.Memory
		if m.Model.Set && m.Model.Valid {
			id, err := checkModelID(m.Model.Value, join(where, "memory.model"))
			if err != nil {
				return err
			}
			m.Model = Some(id)
		}
		out.Memory = &m
	}
	if p.Research != nil {
		r := *p.Research
		if r.MaxSearchesPerTurn != nil {
			if err := checkRange(*r.MaxSearchesPerTurn, minSearchesPerTurn, maxSearchesPerTurn,
				join(where, "research.max_searches_per_turn")); err != nil {
				return err
			}
		}
		out.Research = &r
	}
	if p.Browser != nil {
		b := *p.Browser
		if b.BlockedDomains != nil {
			list, err := checkDomainsUpTo(*b.BlockedDomains, join(where, "browser.blocked_domains"), maxBlockedDomains)
			if err != nil {
				return err
			}
			b.BlockedDomains = &list
		}
		out.Browser = &b
	}
	if p.CodexRuntimeMirror.Set && p.CodexRuntimeMirror.Valid {
		u, err := checkURL(p.CodexRuntimeMirror.Value, join(where, "codex_runtime_mirror"))
		if err != nil {
			return err
		}
		out.CodexRuntimeMirror = Some(u)
	}
	if p.ComputerUse != nil {
		c := *p.ComputerUse
		if c.DeniedApps != nil {
			list, err := checkApps(*c.DeniedApps, join(where, "computer_use.denied_apps"))
			if err != nil {
				return err
			}
			c.DeniedApps = &list
		}
		if c.MaxActionsPerTurn.Set && c.MaxActionsPerTurn.Valid {
			if err := checkRange(c.MaxActionsPerTurn.Value, minActionsPerTurn, maxActionsPerTurnCap,
				join(where, "computer_use.max_actions_per_turn")); err != nil {
				return err
			}
		}
		out.ComputerUse = &c
	}
	return nil
}

// checkPatch validates a typed patch and returns its canonical form (trimmed,
// lower-cased, deduplicated, fixed mode order).
func checkPatch(p Patch, where string) (Patch, error) {
	out := p
	if p.PermissionModes != nil {
		spec, err := checkModeSpec(*p.PermissionModes, join(where, "permission_modes"))
		if err != nil {
			return Patch{}, err
		}
		out.PermissionModes = &spec
	}
	if p.RemoteImageDomains.Set && p.RemoteImageDomains.Valid {
		list, err := checkDomains(p.RemoteImageDomains.Value, join(where, "remote_image_domains"))
		if err != nil {
			return Patch{}, err
		}
		out.RemoteImageDomains = Some(list)
	}
	if p.TrustedLinkDomains != nil {
		list, err := checkDomains(*p.TrustedLinkDomains, join(where, "trusted_link_domains"))
		if err != nil {
			return Patch{}, err
		}
		out.TrustedLinkDomains = &list
	}
	if p.Connectors.Set && p.Connectors.Valid {
		list, err := checkConnectors(p.Connectors.Value, join(where, "connectors"))
		if err != nil {
			return Patch{}, err
		}
		out.Connectors = Some(list)
	}
	if p.Attachments != nil {
		a := *p.Attachments
		at := join(where, "attachments")
		if a.MaxMegabytes.Set && a.MaxMegabytes.Valid {
			if err := checkMegabytes(a.MaxMegabytes.Value, join(at, "max_megabytes")); err != nil {
				return Patch{}, err
			}
		}
		if a.Types != nil {
			list, err := checkTypes(*a.Types, join(at, "types"))
			if err != nil {
				return Patch{}, err
			}
			a.Types = &list
		}
		out.Attachments = &a
	}
	if p.Links != nil {
		l := *p.Links
		at := join(where, "links")
		for _, f := range []struct {
			name string
			v    *Nullable[string]
		}{{"help", &l.Help}, {"plans", &l.Plans}, {"apps", &l.Apps}, {"get_more_usage", &l.GetMoreUsage}, {"usage_learn_more", &l.UsageLearnMore}} {
			if f.v.Set && f.v.Valid {
				u, err := checkURL(f.v.Value, join(at, f.name))
				if err != nil {
					return Patch{}, err
				}
				*f.v = Some(u)
			}
		}
		if l.LearnMore != nil {
			list, err := checkLearnMore(*l.LearnMore, join(at, "learn_more"))
			if err != nil {
				return Patch{}, err
			}
			l.LearnMore = &list
		}
		out.Links = &l
	}
	if p.UsageBanner != nil && p.UsageBanner.WarnPercent != nil {
		if err := checkRange(*p.UsageBanner.WarnPercent, minWarnPercent, maxWarnPercent, join(where, "usage_banner.warn_percent")); err != nil {
			return Patch{}, err
		}
	}
	if p.PlanLabel.Set && p.PlanLabel.Valid {
		label, err := checkText(p.PlanLabel.Value, join(where, "plan_label"), maxPlanLabelChars)
		if err != nil {
			return Patch{}, err
		}
		out.PlanLabel = Some(label)
	}
	if p.ScheduledTasks != nil && p.ScheduledTasks.ApprovalLifetimeDays.Set && p.ScheduledTasks.ApprovalLifetimeDays.Valid {
		if err := checkRange(p.ScheduledTasks.ApprovalLifetimeDays.Value, 0, 36500, join(where, "scheduled_tasks.approval_lifetime_days")); err != nil {
			return Patch{}, err
		}
	}
	if p.ScheduledTasks != nil && p.ScheduledTasks.MaxTasks.Set && p.ScheduledTasks.MaxTasks.Valid {
		if err := checkRange(p.ScheduledTasks.MaxTasks.Value, 0, maxScheduledTasks, join(where, "scheduled_tasks.max_tasks")); err != nil {
			return Patch{}, err
		}
	}
	if err := checkRound2(p, &out, where); err != nil {
		return Patch{}, err
	}
	return out, nil
}

// parseOverrideID accepts the decimal form of a positive int64.
func parseOverrideID(s string) (int64, bool) {
	if s == "" || len(s) > maxOverrideIDDigits || s[0] == '0' || s[0] == '+' || s[0] == '-' {
		return 0, false
	}
	id, err := strconv.ParseInt(s, 10, 64)
	return id, err == nil && id > 0
}

// validateDocument is the JSONSetting write check: counts, ids and every
// layer (the strict parser has already checked the same rules; this guards
// every other write path).
func validateDocument(d *Document) error {
	if len(d.GroupOverrides) > maxGroupOverrides {
		return invalid("group_overrides", RuleTooMany)
	}
	if len(d.UserOverrides) > maxUserOverrides {
		return invalid("user_overrides", RuleTooMany)
	}
	if _, err := checkPatch(d.Defaults, "defaults"); err != nil {
		return err
	}
	for _, layer := range []struct {
		name string
		m    map[string]Patch
	}{{"group_overrides", d.GroupOverrides}, {"user_overrides", d.UserOverrides}} {
		for key, p := range layer.m {
			if _, ok := parseOverrideID(key); !ok {
				return invalid(join(layer.name, key), RuleInvalidID)
			}
			if _, err := checkPatch(p, join(layer.name, key)); err != nil {
				return err
			}
		}
	}
	return nil
}

// normalizeDocument runs after every read (and before validation on write).
// A stored document should always be valid; if it is not (edited by hand,
// written by an older build), every invalid field is dropped so it inherits
// from the layer below, with a warning. Bypass never survives: it is removed
// from any mode list first (owner decision 3).
func normalizeDocument(d *Document) {
	if d.Version == 0 {
		d.Version = documentVersion
	}
	if d.Revision < 0 {
		d.Revision = 0
	}
	if d.GroupOverrides == nil {
		d.GroupOverrides = map[string]Patch{}
	}
	if d.UserOverrides == nil {
		d.UserOverrides = map[string]Patch{}
	}
	d.Defaults = sanitizePatch(d.Defaults, "defaults")
	for _, layer := range []struct {
		name string
		m    map[string]Patch
	}{{"group_overrides", d.GroupOverrides}, {"user_overrides", d.UserOverrides}} {
		for key, p := range layer.m {
			if _, ok := parseOverrideID(key); !ok {
				slog.Warn("claudex: policy override with an invalid id ignored", "key", SettingKey, "field", join(layer.name, key))
				delete(layer.m, key)
				continue
			}
			layer.m[key] = sanitizePatch(p, join(layer.name, key))
		}
	}
}

// sanitizePatch drops the invalid fields of a stored patch, one field at a
// time, and returns the canonical form of the rest.
func sanitizePatch(p Patch, where string) Patch {
	if p.PermissionModes != nil {
		p.PermissionModes = stripBypass(p.PermissionModes, join(where, "permission_modes"))
	}
	for {
		out, err := checkPatch(p, where)
		if err == nil {
			return out
		}
		field := infraerrors.FromError(err).Metadata["field"]
		slog.Warn("claudex: invalid stored policy field ignored", "key", SettingKey, "field", field, "error", err)
		if !dropField(&p, where, field) {
			// Should not happen: every rule names a field dropField knows.
			slog.Warn("claudex: invalid stored policy layer ignored", "key", SettingKey, "field", where)
			return Patch{}
		}
	}
}

// stripBypass removes Bypass from stored mode lists (it should never be
// there) and warns.
func stripBypass(spec *ModeSpec, where string) *ModeSpec {
	strip := func(list []string, at string) []string {
		out := make([]string, 0, len(list))
		for _, m := range list {
			if isBypass(m) {
				slog.Warn("claudex: bypass in a stored policy mode list dropped", "key", SettingKey, "field", at)
				continue
			}
			out = append(out, m)
		}
		return out
	}
	if spec.ByPlatform == nil {
		return &ModeSpec{List: strip(spec.List, where)}
	}
	m := make(map[string][]string, len(spec.ByPlatform))
	for k, list := range spec.ByPlatform {
		m[k] = strip(list, join(where, k))
	}
	return &ModeSpec{ByPlatform: m}
}

// dropField clears the top-level patch field that field (a path under where)
// belongs to. It reports false when it knows no such field.
func dropField(p *Patch, where, field string) bool {
	rest := strings.TrimPrefix(field, where+".")
	if rest == field {
		return false
	}
	name := rest
	if i := strings.IndexAny(name, ".["); i >= 0 {
		name = name[:i]
	}
	sub := strings.TrimPrefix(rest, name+".")
	switch name {
	case "permission_modes":
		p.PermissionModes = nil
	case "remote_image_domains":
		p.RemoteImageDomains = Nullable[[]string]{}
	case "trusted_link_domains":
		p.TrustedLinkDomains = nil
	case "connectors":
		p.Connectors = Nullable[[]ConnectorRule]{}
	case "attachments":
		if p.Attachments == nil {
			return false
		}
		a := *p.Attachments
		switch {
		case strings.HasPrefix(sub, "max_megabytes"):
			a.MaxMegabytes = Nullable[float64]{}
		case strings.HasPrefix(sub, "types"):
			a.Types = nil
		default:
			return false
		}
		p.Attachments = &a
	case "links":
		if p.Links == nil {
			return false
		}
		l := *p.Links
		switch {
		case sub == "help":
			l.Help = Nullable[string]{}
		case sub == "plans":
			l.Plans = Nullable[string]{}
		case sub == "apps":
			l.Apps = Nullable[string]{}
		case sub == "get_more_usage":
			l.GetMoreUsage = Nullable[string]{}
		case sub == "usage_learn_more":
			l.UsageLearnMore = Nullable[string]{}
		case strings.HasPrefix(sub, "learn_more"):
			l.LearnMore = nil
		default:
			return false
		}
		p.Links = &l
	case "usage_banner":
		p.UsageBanner = nil
	case "plan_label":
		p.PlanLabel = Nullable[string]{}
	case "scheduled_tasks":
		if p.ScheduledTasks == nil {
			return false
		}
		s := *p.ScheduledTasks
		if sub == "approval_lifetime_days" {
			s.ApprovalLifetimeDays = Nullable[int]{}
			p.ScheduledTasks = &s
			return true
		}
		s.MaxTasks = Nullable[int]{}
		p.ScheduledTasks = &s
	case "memory":
		if p.Memory == nil || !strings.HasPrefix(sub, "model") {
			return false
		}
		m := *p.Memory
		m.Model = Nullable[string]{}
		p.Memory = &m
	case "research":
		if p.Research == nil || !strings.HasPrefix(sub, "max_searches_per_turn") {
			return false
		}
		r := *p.Research
		r.MaxSearchesPerTurn = nil
		p.Research = &r
	case "browser":
		if p.Browser == nil || !strings.HasPrefix(sub, "blocked_domains") {
			return false
		}
		b := *p.Browser
		b.BlockedDomains = nil
		p.Browser = &b
	case "codex_runtime_mirror":
		p.CodexRuntimeMirror = Nullable[string]{}
	case "computer_use":
		if p.ComputerUse == nil {
			return false
		}
		c := *p.ComputerUse
		switch {
		case strings.HasPrefix(sub, "denied_apps"):
			c.DeniedApps = nil
		case strings.HasPrefix(sub, "max_actions_per_turn"):
			c.MaxActionsPerTurn = Nullable[int]{}
		default:
			return false
		}
		p.ComputerUse = &c
	default:
		return false
	}
	return true
}

// overrideKey is the map key of an override id.
func overrideKey(id int64) string { return strconv.FormatInt(id, 10) }
