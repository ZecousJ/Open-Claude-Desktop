package policy

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"strings"
)

// The strict parser for admin input (PUT /admin/claudex/policy and the draft
// of POST /policy/preview): every object is read key by key, so an unknown or
// repeated key, a null where none is allowed and a wrong JSON type all answer
// 400 CLAUDEX_POLICY_INVALID with the exact field path (design 2.3).

// patchKeys are the PolicyPatch fields (design 1.6.1).
var patchKeys = []string{
	"permission_modes", "incognito", "web_search", "web_search_default", "voice", "local_mcp_editing", "developer_mode_enabled", "desktop_extensions_enabled", "developer_mcp_enabled",
	"remote_images", "remote_image_domains", "external_links", "trusted_link_domains", "connectors",
	"attachments", "links", "usage_banner", "plan_label", "scheduled_tasks", "approvals_always_allow",
	"memory", "research", "browser", "ssh_remote", "codex_runtime_mirror", "computer_use",
	"workflows", "workflow_approval_required",
}

// object is one JSON object read key by key.
type object struct {
	where string
	keys  []string
	vals  map[string]json.RawMessage
}

func isNull(raw json.RawMessage) bool { return bytes.Equal(bytes.TrimSpace(raw), []byte("null")) }

// readObject reads a JSON object, rejecting null, other types and repeated keys.
func readObject(raw json.RawMessage, where string) (*object, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	tok, err := dec.Token()
	if err != nil {
		return nil, invalid(where, RuleInvalidJSON)
	}
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return nil, invalid(where, RuleInvalidType)
	}
	o := &object{where: where, vals: map[string]json.RawMessage{}}
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return nil, invalid(where, RuleInvalidJSON)
		}
		key, ok := tok.(string)
		if !ok {
			return nil, invalid(where, RuleInvalidJSON)
		}
		var val json.RawMessage
		if err := dec.Decode(&val); err != nil {
			return nil, invalid(join(where, key), RuleInvalidJSON)
		}
		if _, dup := o.vals[key]; dup {
			return nil, invalid(join(where, key), RuleDuplicateField)
		}
		o.keys = append(o.keys, key)
		o.vals[key] = val
	}
	if _, err := dec.Token(); err != nil {
		return nil, invalid(where, RuleInvalidJSON)
	}
	return o, nil
}

// only rejects keys outside allowed (a key that names Bypass gets the Bypass
// rule, so no spelling of it slips through as a mere typo).
func (o *object) only(allowed ...string) error {
	set := make(map[string]bool, len(allowed))
	for _, k := range allowed {
		set[k] = true
	}
	for _, k := range o.keys {
		if set[k] {
			continue
		}
		if isBypass(k) {
			return invalid(join(o.where, k), RuleBypass)
		}
		return invalid(join(o.where, k), RuleUnknownField)
	}
	return nil
}

func (o *object) get(key string) (json.RawMessage, bool) {
	v, ok := o.vals[key]
	return v, ok
}

func (o *object) path(key string) string { return join(o.where, key) }

func decodeBool(raw json.RawMessage, where string) (bool, error) {
	switch string(bytes.TrimSpace(raw)) {
	case "true":
		return true, nil
	case "false":
		return false, nil
	}
	return false, invalid(where, RuleInvalidType)
}

func decodeString(raw json.RawMessage, where string) (string, error) {
	var s string
	if isNull(raw) || json.Unmarshal(raw, &s) != nil {
		return "", invalid(where, RuleInvalidType)
	}
	return s, nil
}

// decodeInt reads an integer literal (no fraction or exponent).
func decodeInt(raw json.RawMessage, where string) (int64, error) {
	text := string(bytes.TrimSpace(raw))
	if text == "" || strings.ContainsAny(text, ".eE\"[{ntf") {
		return 0, invalid(where, RuleInvalidType)
	}
	n, err := strconv.ParseInt(text, 10, 64)
	if err != nil {
		var numErr *strconv.NumError
		if errors.As(err, &numErr) && errors.Is(numErr.Err, strconv.ErrRange) {
			return 0, invalid(where, RuleOutOfRange)
		}
		return 0, invalid(where, RuleInvalidType)
	}
	return n, nil
}

// decodeNumber reads a number literal (json.Number alone would also take a
// quoted number).
func decodeNumber(raw json.RawMessage, where string) (float64, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || (trimmed[0] != '-' && (trimmed[0] < '0' || trimmed[0] > '9')) {
		return 0, invalid(where, RuleInvalidType)
	}
	var n json.Number
	dec := json.NewDecoder(bytes.NewReader(trimmed))
	dec.UseNumber()
	if dec.Decode(&n) != nil {
		return 0, invalid(where, RuleInvalidType)
	}
	f, err := n.Float64()
	if err != nil {
		return 0, invalid(where, RuleOutOfRange)
	}
	return f, nil
}

func decodeArray(raw json.RawMessage, where string) ([]json.RawMessage, error) {
	var list []json.RawMessage
	if isNull(raw) || json.Unmarshal(raw, &list) != nil {
		return nil, invalid(where, RuleInvalidType)
	}
	if list == nil {
		list = []json.RawMessage{}
	}
	return list, nil
}

// decodeStringList reads a list of strings; elementPaths reports errors at
// where[i] instead of where.
func decodeStringList(raw json.RawMessage, where string, elementPaths bool) ([]string, error) {
	items, err := decodeArray(raw, where)
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(items))
	for i, item := range items {
		at := where
		if elementPaths {
			at = index(where, i)
		}
		s, err := decodeString(item, at)
		if err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, nil
}

// decodeModes reads one mode list. Errors name the list (as in the design's
// example field group_overrides.4.permission_modes.win32).
func decodeModes(raw json.RawMessage, where string) ([]string, error) {
	items, err := decodeArray(raw, where)
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		s, err := decodeString(item, where)
		if err != nil {
			return nil, err
		}
		if isBypass(s) {
			return nil, invalid(where, RuleBypass)
		}
		out = append(out, s)
	}
	return out, nil
}

func parseModeSpec(raw json.RawMessage, where string) (ModeSpec, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) > 0 && trimmed[0] == '{' {
		o, err := readObject(raw, where)
		if err != nil {
			return ModeSpec{}, err
		}
		spec := ModeSpec{ByPlatform: map[string][]string{}}
		for _, key := range o.keys {
			if !modePlatforms[key] {
				if isBypass(key) {
					return ModeSpec{}, invalid(o.path(key), RuleBypass)
				}
				return ModeSpec{}, invalid(o.path(key), RuleUnknownPlatform)
			}
			list, err := decodeModes(o.vals[key], o.path(key))
			if err != nil {
				return ModeSpec{}, err
			}
			spec.ByPlatform[key] = list
		}
		return spec, nil
	}
	list, err := decodeModes(raw, where)
	if err != nil {
		return ModeSpec{}, err
	}
	return ModeSpec{List: list}, nil
}

func parseNullableString(raw json.RawMessage, where string) (Nullable[string], error) {
	if isNull(raw) {
		return Null[string](), nil
	}
	s, err := decodeString(raw, where)
	if err != nil {
		return Nullable[string]{}, err
	}
	return Some(s), nil
}

func parseConnectors(raw json.RawMessage, where string) (Nullable[[]ConnectorRule], error) {
	if isNull(raw) {
		return Null[[]ConnectorRule](), nil
	}
	items, err := decodeArray(raw, where)
	if err != nil {
		return Nullable[[]ConnectorRule]{}, err
	}
	if len(items) > maxConnectors {
		return Nullable[[]ConnectorRule]{}, invalid(where, RuleTooMany)
	}
	rules := make([]ConnectorRule, 0, len(items))
	for i, item := range items {
		at := index(where, i)
		trimmed := bytes.TrimSpace(item)
		if len(trimmed) > 0 && trimmed[0] == '"' {
			name, err := decodeString(item, at)
			if err != nil {
				return Nullable[[]ConnectorRule]{}, err
			}
			rules = append(rules, ConnectorRule{Name: name})
			continue
		}
		o, err := readObject(item, at)
		if err != nil {
			return Nullable[[]ConnectorRule]{}, err
		}
		if err := o.only("name", "url_prefix", "command", "args"); err != nil {
			return Nullable[[]ConnectorRule]{}, err
		}
		var rule ConnectorRule
		v, ok := o.get("name")
		if !ok {
			return Nullable[[]ConnectorRule]{}, invalid(o.path("name"), RuleRequired)
		}
		if rule.Name, err = decodeString(v, o.path("name")); err != nil {
			return Nullable[[]ConnectorRule]{}, err
		}
		if v, ok := o.get("url_prefix"); ok {
			if rule.URLPrefix, err = decodeString(v, o.path("url_prefix")); err != nil {
				return Nullable[[]ConnectorRule]{}, err
			}
			if rule.URLPrefix == "" {
				return Nullable[[]ConnectorRule]{}, invalid(o.path("url_prefix"), RuleHTTPSRequired)
			}
		}
		if v, ok := o.get("command"); ok {
			if rule.Command, err = decodeString(v, o.path("command")); err != nil {
				return Nullable[[]ConnectorRule]{}, err
			}
			if strings.TrimSpace(rule.Command) == "" {
				return Nullable[[]ConnectorRule]{}, invalid(o.path("command"), RuleRequired)
			}
		}
		if v, ok := o.get("args"); ok {
			// Arguments only bind a local command (strict match: program and
			// arguments both equal).
			if _, hasCommand := o.get("command"); !hasCommand {
				return Nullable[[]ConnectorRule]{}, invalid(o.path("command"), RuleRequired)
			}
			if rule.Args, err = decodeStringList(v, o.path("args"), true); err != nil {
				return Nullable[[]ConnectorRule]{}, err
			}
		}
		rules = append(rules, rule)
	}
	return Some(rules), nil
}

func parseAttachments(raw json.RawMessage, where string) (*AttachmentsPatch, error) {
	o, err := readObject(raw, where)
	if err != nil {
		return nil, err
	}
	if err := o.only("max_megabytes", "types"); err != nil {
		return nil, err
	}
	a := &AttachmentsPatch{}
	if v, ok := o.get("max_megabytes"); ok {
		if isNull(v) {
			a.MaxMegabytes = Null[float64]()
		} else {
			mb, err := decodeNumber(v, o.path("max_megabytes"))
			if err != nil {
				return nil, err
			}
			a.MaxMegabytes = Some(mb)
		}
	}
	if v, ok := o.get("types"); ok {
		list, err := decodeStringList(v, o.path("types"), true)
		if err != nil {
			return nil, err
		}
		a.Types = &list
	}
	return a, nil
}

func parseLinks(raw json.RawMessage, where string) (*LinksPatch, error) {
	o, err := readObject(raw, where)
	if err != nil {
		return nil, err
	}
	if err := o.only("help", "plans", "apps", "get_more_usage", "usage_learn_more", "learn_more"); err != nil {
		return nil, err
	}
	l := &LinksPatch{}
	for _, f := range []struct {
		name string
		dst  *Nullable[string]
	}{{"help", &l.Help}, {"plans", &l.Plans}, {"apps", &l.Apps}, {"get_more_usage", &l.GetMoreUsage}, {"usage_learn_more", &l.UsageLearnMore}} {
		if v, ok := o.get(f.name); ok {
			if *f.dst, err = parseNullableString(v, o.path(f.name)); err != nil {
				return nil, err
			}
		}
	}
	if v, ok := o.get("learn_more"); ok {
		at := o.path("learn_more")
		items, err := decodeArray(v, at)
		if err != nil {
			return nil, err
		}
		if len(items) > maxLearnMore {
			return nil, invalid(at, RuleTooMany)
		}
		list := make([]Link, 0, len(items))
		for i, item := range items {
			lo, err := readObject(item, index(at, i))
			if err != nil {
				return nil, err
			}
			if err := lo.only("label", "url"); err != nil {
				return nil, err
			}
			var link Link
			for _, f := range []struct {
				name string
				dst  *string
			}{{"label", &link.Label}, {"url", &link.URL}} {
				fv, ok := lo.get(f.name)
				if !ok {
					return nil, invalid(lo.path(f.name), RuleRequired)
				}
				if *f.dst, err = decodeString(fv, lo.path(f.name)); err != nil {
					return nil, err
				}
			}
			list = append(list, link)
		}
		l.LearnMore = &list
	}
	return l, nil
}

func parseUsageBanner(raw json.RawMessage, where string) (*UsageBannerPatch, error) {
	o, err := readObject(raw, where)
	if err != nil {
		return nil, err
	}
	if err := o.only("warn_percent"); err != nil {
		return nil, err
	}
	u := &UsageBannerPatch{}
	if v, ok := o.get("warn_percent"); ok {
		n, err := decodeInt(v, o.path("warn_percent"))
		if err != nil {
			return nil, err
		}
		if n < minWarnPercent || n > maxWarnPercent {
			return nil, invalid(o.path("warn_percent"), RuleOutOfRange)
		}
		pct := int(n)
		u.WarnPercent = &pct
	}
	return u, nil
}

func parseScheduledTasks(raw json.RawMessage, where string) (*ScheduledTasksPatch, error) {
	o, err := readObject(raw, where)
	if err != nil {
		return nil, err
	}
	if err := o.only("enabled", "max_tasks", "approval_lifetime_days"); err != nil {
		return nil, err
	}
	s := &ScheduledTasksPatch{}
	if v, ok := o.get("approval_lifetime_days"); ok {
		if isNull(v) {
			s.ApprovalLifetimeDays = Null[int]()
		} else {
			n, err := decodeInt(v, o.path("approval_lifetime_days"))
			if err != nil {
				return nil, err
			}
			if n < 0 || n > 36500 {
				return nil, invalid(o.path("approval_lifetime_days"), RuleOutOfRange)
			}
			s.ApprovalLifetimeDays = Some(int(n))
		}
	}
	if v, ok := o.get("enabled"); ok {
		b, err := decodeBool(v, o.path("enabled"))
		if err != nil {
			return nil, err
		}
		s.Enabled = &b
	}
	if v, ok := o.get("max_tasks"); ok {
		if isNull(v) {
			s.MaxTasks = Null[int]()
		} else {
			n, err := decodeInt(v, o.path("max_tasks"))
			if err != nil {
				return nil, err
			}
			if n < 0 || n > maxScheduledTasks {
				return nil, invalid(o.path("max_tasks"), RuleOutOfRange)
			}
			s.MaxTasks = Some(int(n))
		}
	}
	return s, nil
}

// boolFields reads the optional booleans of an object into their targets.
func (o *object) boolFields(fields map[string]**bool) error {
	for _, key := range o.keys {
		dst, ok := fields[key]
		if !ok {
			continue
		}
		b, err := decodeBool(o.vals[key], o.path(key))
		if err != nil {
			return err
		}
		*dst = &b
	}
	return nil
}

func parseMemory(raw json.RawMessage, where string) (*MemoryPatch, error) {
	o, err := readObject(raw, where)
	if err != nil {
		return nil, err
	}
	if err := o.only("enabled", "search_chats", "generate", "default_on", "model"); err != nil {
		return nil, err
	}
	m := &MemoryPatch{}
	if err := o.boolFields(map[string]**bool{
		"enabled": &m.Enabled, "search_chats": &m.SearchChats, "generate": &m.Generate, "default_on": &m.DefaultOn,
	}); err != nil {
		return nil, err
	}
	if v, ok := o.get("model"); ok {
		if m.Model, err = parseNullableString(v, o.path("model")); err != nil {
			return nil, err
		}
	}
	return m, nil
}

func parseResearch(raw json.RawMessage, where string) (*ResearchPatch, error) {
	o, err := readObject(raw, where)
	if err != nil {
		return nil, err
	}
	if err := o.only("enabled", "x_search", "max_searches_per_turn"); err != nil {
		return nil, err
	}
	r := &ResearchPatch{}
	if err := o.boolFields(map[string]**bool{"enabled": &r.Enabled, "x_search": &r.XSearch}); err != nil {
		return nil, err
	}
	if v, ok := o.get("max_searches_per_turn"); ok {
		at := o.path("max_searches_per_turn")
		n, err := decodeInt(v, at)
		if err != nil {
			return nil, err
		}
		if n < minSearchesPerTurn || n > maxSearchesPerTurn {
			return nil, invalid(at, RuleOutOfRange)
		}
		limit := int(n)
		r.MaxSearchesPerTurn = &limit
	}
	return r, nil
}

func parseBrowser(raw json.RawMessage, where string) (*BrowserPatch, error) {
	o, err := readObject(raw, where)
	if err != nil {
		return nil, err
	}
	if err := o.only("enabled", "external_sites", "allow_script", "dev_servers", "blocked_domains"); err != nil {
		return nil, err
	}
	b := &BrowserPatch{}
	if err := o.boolFields(map[string]**bool{
		"enabled": &b.Enabled, "external_sites": &b.ExternalSites, "allow_script": &b.AllowScript, "dev_servers": &b.DevServers,
	}); err != nil {
		return nil, err
	}
	if v, ok := o.get("blocked_domains"); ok {
		list, err := decodeStringList(v, o.path("blocked_domains"), true)
		if err != nil {
			return nil, err
		}
		b.BlockedDomains = &list
	}
	return b, nil
}

func parseComputerUse(raw json.RawMessage, where string) (*ComputerUsePatch, error) {
	o, err := readObject(raw, where)
	if err != nil {
		return nil, err
	}
	if err := o.only("enabled", "allow_full_control", "denied_apps", "max_actions_per_turn"); err != nil {
		return nil, err
	}
	c := &ComputerUsePatch{}
	if err := o.boolFields(map[string]**bool{"enabled": &c.Enabled, "allow_full_control": &c.AllowFullControl}); err != nil {
		return nil, err
	}
	if v, ok := o.get("denied_apps"); ok {
		list, err := decodeStringList(v, o.path("denied_apps"), true)
		if err != nil {
			return nil, err
		}
		c.DeniedApps = &list
	}
	if v, ok := o.get("max_actions_per_turn"); ok {
		if isNull(v) {
			c.MaxActionsPerTurn = Null[int]()
		} else {
			at := o.path("max_actions_per_turn")
			n, err := decodeInt(v, at)
			if err != nil {
				return nil, err
			}
			if n < minActionsPerTurn || n > maxActionsPerTurnCap {
				return nil, invalid(at, RuleOutOfRange)
			}
			c.MaxActionsPerTurn = Some(int(n))
		}
	}
	return c, nil
}

// ParsePatch strictly reads one PolicyPatch and returns its canonical form.
// where prefixes every error field ("defaults", "group_overrides.4", ...).
func ParsePatch(raw json.RawMessage, where string) (Patch, error) {
	o, err := readObject(raw, where)
	if err != nil {
		return Patch{}, err
	}
	if err := o.only(patchKeys...); err != nil {
		return Patch{}, err
	}
	var p Patch
	for _, key := range o.keys {
		v, at := o.vals[key], o.path(key)
		switch key {
		case "permission_modes":
			spec, err := parseModeSpec(v, at)
			if err != nil {
				return Patch{}, err
			}
			p.PermissionModes = &spec
		case "incognito", "web_search", "web_search_default", "voice", "local_mcp_editing", "developer_mode_enabled", "desktop_extensions_enabled", "developer_mcp_enabled",
			"remote_images", "external_links", "approvals_always_allow", "ssh_remote",
			"workflows", "workflow_approval_required":
			b, err := decodeBool(v, at)
			if err != nil {
				return Patch{}, err
			}
			*boolField(&p, key) = &b
		case "remote_image_domains":
			if isNull(v) {
				p.RemoteImageDomains = Null[[]string]()
				continue
			}
			list, err := decodeStringList(v, at, true)
			if err != nil {
				return Patch{}, err
			}
			p.RemoteImageDomains = Some(list)
		case "trusted_link_domains":
			list, err := decodeStringList(v, at, true)
			if err != nil {
				return Patch{}, err
			}
			p.TrustedLinkDomains = &list
		case "connectors":
			if p.Connectors, err = parseConnectors(v, at); err != nil {
				return Patch{}, err
			}
		case "attachments":
			if p.Attachments, err = parseAttachments(v, at); err != nil {
				return Patch{}, err
			}
		case "links":
			if p.Links, err = parseLinks(v, at); err != nil {
				return Patch{}, err
			}
		case "usage_banner":
			if p.UsageBanner, err = parseUsageBanner(v, at); err != nil {
				return Patch{}, err
			}
		case "plan_label":
			if p.PlanLabel, err = parseNullableString(v, at); err != nil {
				return Patch{}, err
			}
		case "scheduled_tasks":
			if p.ScheduledTasks, err = parseScheduledTasks(v, at); err != nil {
				return Patch{}, err
			}
		case "memory":
			if p.Memory, err = parseMemory(v, at); err != nil {
				return Patch{}, err
			}
		case "research":
			if p.Research, err = parseResearch(v, at); err != nil {
				return Patch{}, err
			}
		case "browser":
			if p.Browser, err = parseBrowser(v, at); err != nil {
				return Patch{}, err
			}
		case "codex_runtime_mirror":
			if p.CodexRuntimeMirror, err = parseNullableString(v, at); err != nil {
				return Patch{}, err
			}
		case "computer_use":
			if p.ComputerUse, err = parseComputerUse(v, at); err != nil {
				return Patch{}, err
			}
		}
	}
	return checkPatch(p, where)
}

func boolField(p *Patch, key string) **bool {
	switch key {
	case "incognito":
		return &p.Incognito
	case "web_search":
		return &p.WebSearch
	case "web_search_default":
		return &p.WebSearchDefault
	case "voice":
		return &p.Voice
	case "local_mcp_editing":
		return &p.LocalMCPEditing
	case "developer_mode_enabled":
		return &p.DeveloperModeEnabled
	case "desktop_extensions_enabled":
		return &p.DesktopExtensionsEnabled
	case "developer_mcp_enabled":
		return &p.DeveloperMCPEnabled
	case "remote_images":
		return &p.RemoteImages
	case "external_links":
		return &p.ExternalLinks
	case "ssh_remote":
		return &p.SSHRemote
	case "workflows":
		return &p.Workflows
	case "workflow_approval_required":
		return &p.WorkflowApprovalRequired
	default: // approvals_always_allow
		return &p.ApprovalsAlwaysAllow
	}
}

// Override is one group or user override of an admin request.
type Override struct {
	ID    int64
	Patch Patch
}

// Update is a parsed PUT /admin/claudex/policy body (also the preview draft).
type Update struct {
	Revision    int64
	HasRevision bool
	Defaults    Patch
	Groups      []Override
	Users       []Override
}

// readBody reads at most maxPolicyBytes of a request body.
func readBody(r io.Reader) ([]byte, error) {
	if r == nil {
		return nil, invalid("", RuleInvalidJSON)
	}
	body, err := io.ReadAll(io.LimitReader(r, maxPolicyBytes+1))
	if err != nil {
		return nil, invalid("", RuleInvalidJSON)
	}
	if len(body) > maxPolicyBytes {
		return nil, invalid("", RuleTooLarge)
	}
	return body, nil
}

// ParseUpdate strictly reads a PUT body. defaults, group_overrides and
// user_overrides are required (a PUT replaces the whole policy, so a missing
// list must not silently delete every override); revision is required when
// requireRevision is set.
func ParseUpdate(body []byte, requireRevision bool) (Update, error) {
	if !json.Valid(body) {
		return Update{}, invalid("", RuleInvalidJSON)
	}
	return parseUpdate(body, "", requireRevision)
}

func parseUpdate(raw json.RawMessage, where string, requireRevision bool) (Update, error) {
	o, err := readObject(raw, where)
	if err != nil {
		return Update{}, err
	}
	if err := o.only("revision", "defaults", "group_overrides", "user_overrides"); err != nil {
		return Update{}, err
	}
	var u Update
	if v, ok := o.get("revision"); ok {
		n, err := decodeInt(v, o.path("revision"))
		if err != nil {
			return Update{}, err
		}
		if n < 0 {
			return Update{}, invalid(o.path("revision"), RuleOutOfRange)
		}
		u.Revision, u.HasRevision = n, true
	} else if requireRevision {
		return Update{}, invalid(o.path("revision"), RuleRequired)
	}
	v, ok := o.get("defaults")
	if !ok {
		return Update{}, invalid(o.path("defaults"), RuleRequired)
	}
	if u.Defaults, err = ParsePatch(v, o.path("defaults")); err != nil {
		return Update{}, err
	}
	if u.Groups, err = parseOverrides(o, "group_overrides", "group_id", maxGroupOverrides); err != nil {
		return Update{}, err
	}
	if u.Users, err = parseOverrides(o, "user_overrides", "user_id", maxUserOverrides); err != nil {
		return Update{}, err
	}
	return u, nil
}

func parseOverrides(o *object, key, idKey string, limit int) ([]Override, error) {
	v, ok := o.get(key)
	if !ok {
		return nil, invalid(o.path(key), RuleRequired)
	}
	where := o.path(key)
	items, err := decodeArray(v, where)
	if err != nil {
		return nil, err
	}
	if len(items) > limit {
		return nil, invalid(where, RuleTooMany)
	}
	out := make([]Override, 0, len(items))
	seen := map[int64]bool{}
	for i, item := range items {
		eo, err := readObject(item, index(where, i))
		if err != nil {
			return nil, err
		}
		if err := eo.only(idKey, "patch"); err != nil {
			return nil, err
		}
		idRaw, ok := eo.get(idKey)
		if !ok {
			return nil, invalid(eo.path(idKey), RuleRequired)
		}
		id, err := decodeInt(idRaw, eo.path(idKey))
		if err != nil || id <= 0 {
			return nil, invalid(eo.path(idKey), RuleInvalidID)
		}
		at := join(where, overrideKey(id))
		if seen[id] {
			return nil, invalid(at, RuleDuplicateID)
		}
		seen[id] = true
		patchRaw, ok := eo.get("patch")
		if !ok {
			return nil, invalid(join(at, "patch"), RuleRequired)
		}
		patch, err := ParsePatch(patchRaw, at)
		if err != nil {
			return nil, err
		}
		out = append(out, Override{ID: id, Patch: patch})
	}
	return out, nil
}

// PreviewRequest is a parsed POST /admin/claudex/policy/preview body.
type PreviewRequest struct {
	GroupID  *int64
	UserID   *int64
	Platform string
	Draft    *Update
}

// ParsePreview strictly reads a preview body.
func ParsePreview(body []byte) (PreviewRequest, error) {
	var req PreviewRequest
	if len(bytes.TrimSpace(body)) == 0 {
		return req, nil
	}
	if !json.Valid(body) {
		return req, invalid("", RuleInvalidJSON)
	}
	o, err := readObject(body, "")
	if err != nil {
		return req, err
	}
	if err := o.only("group_id", "user_id", "platform", "draft"); err != nil {
		return req, err
	}
	for _, f := range []struct {
		key string
		dst **int64
	}{{"group_id", &req.GroupID}, {"user_id", &req.UserID}} {
		v, ok := o.get(f.key)
		if !ok || isNull(v) {
			continue
		}
		id, err := decodeInt(v, f.key)
		if err != nil || id <= 0 {
			return req, invalid(f.key, RuleInvalidID)
		}
		*f.dst = &id
	}
	if v, ok := o.get("platform"); ok && !isNull(v) {
		p, err := decodeString(v, "platform")
		if err != nil {
			return req, err
		}
		if p != "" && p != platformDarwin && p != platformWin32 && p != platformLinux {
			return req, invalid("platform", RuleUnknownPlatform)
		}
		req.Platform = p
	}
	if v, ok := o.get("draft"); ok && !isNull(v) {
		draft, err := parseUpdate(v, "draft", false)
		if err != nil {
			return req, err
		}
		req.Draft = &draft
	}
	return req, nil
}
