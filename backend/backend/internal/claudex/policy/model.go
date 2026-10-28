package policy

import (
	"bytes"
	"encoding/json"
	"errors"
	"time"
)

// SettingKey stores the policy document (design 1.6, 2.3).
const SettingKey = "claudex_client_policy"

// documentVersion is the "version" of the stored document.
const documentVersion = 1

// Platforms a permission-mode map may name besides "default".
const (
	platformDefault = "default"
	platformDarwin  = "darwin"
	platformWin32   = "win32"
	platformLinux   = "linux"
)

// PolicyModes are the permission modes a policy may allow, in output order.
// Bypass permissions is not one of them: it is always the user's own choice
// (owner decision 3), so no policy value can name it.
var PolicyModes = []string{"auto", "manual", "acceptEdits", "plan"}

// AttachmentTypes are the file extensions the desktop client can attach
// (shared/client-policy.ts attachmentTypes); a policy may only narrow them.
var AttachmentTypes = []string{
	"png", "jpg", "jpeg", "webp", "gif",
	"pdf", "docx", "pptx", "xlsx",
	"txt", "md", "csv", "ts", "tsx", "js", "jsx", "py", "json", "yaml", "yml",
	"html", "css", "rs", "go", "java", "c", "cpp", "xml", "toml", "log",
}

// Document is the stored setting claudex_client_policy.
type Document struct {
	Version        int              `json:"version"`
	Revision       int64            `json:"revision"`
	UpdatedAt      *time.Time       `json:"updated_at"`
	UpdatedBy      *int64           `json:"updated_by"`
	Defaults       Patch            `json:"defaults"`
	GroupOverrides map[string]Patch `json:"group_overrides"`
	UserOverrides  map[string]Patch `json:"user_overrides"`
}

// Patch is one layer of the policy (defaults, a group override or a user
// override). Every field is optional: an absent field inherits the layer
// below. Nullable fields tell "absent" (inherit) from an explicit null.
type Patch struct {
	PermissionModes          *ModeSpec                 `json:"permission_modes,omitempty"`
	Incognito                *bool                     `json:"incognito,omitempty"`
	WebSearch                *bool                     `json:"web_search,omitempty"`
	WebSearchDefault         *bool                     `json:"web_search_default,omitempty"`
	Voice                    *bool                     `json:"voice,omitempty"`
	LocalMCPEditing          *bool                     `json:"local_mcp_editing,omitempty"`
	DeveloperModeEnabled     *bool                     `json:"developer_mode_enabled,omitempty"`
	DesktopExtensionsEnabled *bool                     `json:"desktop_extensions_enabled,omitempty"`
	DeveloperMCPEnabled      *bool                     `json:"developer_mcp_enabled,omitempty"`
	RemoteImages             *bool                     `json:"remote_images,omitempty"`
	RemoteImageDomains       Nullable[[]string]        `json:"remote_image_domains,omitzero"`
	ExternalLinks            *bool                     `json:"external_links,omitempty"`
	TrustedLinkDomains       *[]string                 `json:"trusted_link_domains,omitempty"`
	Connectors               Nullable[[]ConnectorRule] `json:"connectors,omitzero"`
	Attachments              *AttachmentsPatch         `json:"attachments,omitempty"`
	Links                    *LinksPatch               `json:"links,omitempty"`
	UsageBanner              *UsageBannerPatch         `json:"usage_banner,omitempty"`
	PlanLabel                Nullable[string]          `json:"plan_label,omitzero"`
	ScheduledTasks           *ScheduledTasksPatch      `json:"scheduled_tasks,omitempty"`
	ApprovalsAlwaysAllow     *bool                     `json:"approvals_always_allow,omitempty"`
	// Round 2 (package POL): optional blocks the desktop client reads as
	// optional fields. An older client ignores them.
	Memory             *MemoryPatch      `json:"memory,omitempty"`
	Research           *ResearchPatch    `json:"research,omitempty"`
	Browser            *BrowserPatch     `json:"browser,omitempty"`
	SSHRemote          *bool             `json:"ssh_remote,omitempty"`
	CodexRuntimeMirror Nullable[string]  `json:"codex_runtime_mirror,omitzero"`
	ComputerUse        *ComputerUsePatch `json:"computer_use,omitempty"`
	// Dynamic workflows may run, and must be approved each time (an older
	// client ignores both).
	Workflows                *bool `json:"workflows,omitempty"`
	WorkflowApprovalRequired *bool `json:"workflow_approval_required,omitempty"`
}

// MemoryPatch overrides the memory switches field by field (R3). Memory
// only applies to Chat and Cowork.
type MemoryPatch struct {
	// Enabled is the master switch; off hides memory in the client and the
	// memory component refuses writes (stored memory is kept).
	Enabled *bool `json:"enabled,omitempty"`
	// SearchChats allows "Search and reference chats".
	SearchChats *bool `json:"search_chats,omitempty"`
	// Generate allows "Generate memory from chat history".
	Generate *bool `json:"generate,omitempty"`
	// DefaultOn is the state of the user's two switches until the user
	// chooses (built-in: off).
	DefaultOn *bool `json:"default_on,omitempty"`
	// Model is the model that writes the memory summary; null uses the
	// plan's default model. The client uses it only when the plan's catalog
	// lists it.
	Model Nullable[string] `json:"model,omitzero"`
}

// ResearchPatch overrides Research mode field by field (R4/R5). Research and
// X search both need web_search: with web_search off they resolve to off.
type ResearchPatch struct {
	Enabled *bool `json:"enabled,omitempty"`
	// XSearch lets grok models search X next to the web (in Research and
	// with plain web search).
	XSearch *bool `json:"x_search,omitempty"`
	// MaxSearchesPerTurn caps the searches of one Research turn.
	MaxSearchesPerTurn *int `json:"max_searches_per_turn,omitempty"`
}

// BrowserPatch overrides the built-in browser's agent tools field by field
// (R8). The browser runs on the user's computer; the service never sees a
// page.
type BrowserPatch struct {
	// Enabled offers the Browser tools and panel in Code.
	Enabled *bool `json:"enabled,omitempty"`
	// ExternalSites lets the agent act on sites other than local development
	// addresses (browsing by hand is not limited).
	ExternalSites *bool `json:"external_sites,omitempty"`
	// AllowScript offers the tool that runs JavaScript in a page.
	AllowScript *bool `json:"allow_script,omitempty"`
	// DevServers lets the agent start dev servers from launch.json.
	DevServers *bool `json:"dev_servers,omitempty"`
	// BlockedDomains are added to the domains the layers below block (a
	// later layer cannot unblock one). A domain blocks its subdomains too,
	// for the agent and for browsing by hand.
	BlockedDomains *[]string `json:"blocked_domains,omitempty"`
}

// ComputerUsePatch overrides computer use field by field (R10).
type ComputerUsePatch struct {
	// Enabled offers computer use (built-in: off).
	Enabled *bool `json:"enabled,omitempty"`
	// AllowFullControl allows the full-control mode besides app-by-app
	// access.
	AllowFullControl *bool `json:"allow_full_control,omitempty"`
	// DeniedApps are added to the apps the layers below deny (bundle ids or
	// program names; a later layer cannot allow one again).
	DeniedApps *[]string `json:"denied_apps,omitempty"`
	// MaxActionsPerTurn lowers the client's own cap; null keeps it.
	MaxActionsPerTurn Nullable[int] `json:"max_actions_per_turn,omitzero"`
}

// AttachmentsPatch overrides attachment limits field by field.
type AttachmentsPatch struct {
	MaxMegabytes Nullable[float64] `json:"max_megabytes,omitzero"`
	Types        *[]string         `json:"types,omitempty"`
}

// LinksPatch overrides the account-menu and usage links field by field;
// learn_more is replaced as a whole.
type LinksPatch struct {
	Help           Nullable[string] `json:"help,omitzero"`
	Plans          Nullable[string] `json:"plans,omitzero"`
	Apps           Nullable[string] `json:"apps,omitzero"`
	GetMoreUsage   Nullable[string] `json:"get_more_usage,omitzero"`
	UsageLearnMore Nullable[string] `json:"usage_learn_more,omitzero"`
	LearnMore      *[]Link          `json:"learn_more,omitempty"`
}

// UsageBannerPatch overrides the usage warning threshold.
type UsageBannerPatch struct {
	WarnPercent *int `json:"warn_percent,omitempty"`
}

// ScheduledTasksPatch overrides scheduled tasks field by field. It has no
// Bypass setting: scheduled tasks follow the user's own Bypass choice.
type ScheduledTasksPatch struct {
	ApprovalLifetimeDays Nullable[int] `json:"approval_lifetime_days,omitzero"`
	Enabled              *bool         `json:"enabled,omitempty"`
	MaxTasks             Nullable[int] `json:"max_tasks,omitzero"`
}

// Link is a labelled https link.
type Link struct {
	Label string `json:"label"`
	URL   string `json:"url"`
}

// ConnectorRule allows one MCP server by name, optionally bound to a remote
// address prefix or a local command. A local command is matched strictly:
// the program and its argument list must both be equal (Args absent means
// no arguments), so allowing "npx" does not allow every npm package. A bare
// JSON string is accepted as {"name": s}.
type ConnectorRule struct {
	Name      string   `json:"name"`
	URLPrefix string   `json:"url_prefix,omitempty"`
	Command   string   `json:"command,omitempty"`
	Args      []string `json:"args,omitempty"`
}

// UnmarshalJSON accepts the object form and the plain-name string form.
func (r *ConnectorRule) UnmarshalJSON(b []byte) error {
	b = bytes.TrimSpace(b)
	if len(b) > 0 && b[0] == '"' {
		var name string
		if err := json.Unmarshal(b, &name); err != nil {
			return err
		}
		*r = ConnectorRule{Name: name}
		return nil
	}
	type plain ConnectorRule
	var v plain
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	*r = ConnectorRule(v)
	return nil
}

// ModeSpec is the stored permission_modes: one list for every platform, or a
// map from default|darwin|win32|linux to a list.
type ModeSpec struct {
	List       []string
	ByPlatform map[string][]string
}

// MarshalJSON writes the list form, or the map form when ByPlatform is set.
func (m ModeSpec) MarshalJSON() ([]byte, error) {
	if m.ByPlatform != nil {
		return json.Marshal(m.ByPlatform)
	}
	if m.List == nil {
		return []byte("[]"), nil
	}
	return json.Marshal(m.List)
}

// UnmarshalJSON reads either form.
func (m *ModeSpec) UnmarshalJSON(b []byte) error {
	b = bytes.TrimSpace(b)
	switch {
	case len(b) > 0 && b[0] == '[':
		var list []string
		if err := json.Unmarshal(b, &list); err != nil {
			return err
		}
		*m = ModeSpec{List: list}
		return nil
	case len(b) > 0 && b[0] == '{':
		var byPlatform map[string][]string
		if err := json.Unmarshal(b, &byPlatform); err != nil {
			return err
		}
		if byPlatform == nil {
			byPlatform = map[string][]string{}
		}
		*m = ModeSpec{ByPlatform: byPlatform}
		return nil
	}
	return errors.New("permission_modes must be a list or an object")
}

// forPlatform picks the list for a platform: its own key, then "default";
// ok is false when neither exists (the caller then uses the built-in list).
func (m *ModeSpec) forPlatform(platform string) (list []string, ok bool) {
	if m == nil {
		return nil, false
	}
	if m.ByPlatform == nil {
		return m.List, true
	}
	if platform != "" {
		if list, ok := m.ByPlatform[platform]; ok {
			return list, true
		}
	}
	list, ok = m.ByPlatform[platformDefault]
	return list, ok
}

// Nullable is a JSON field with three states: absent (Set false: inherit),
// null (Set, not Valid) or a value. Tag it `json:",omitzero"` so an absent
// field stays absent when written.
type Nullable[T any] struct {
	Set   bool
	Valid bool
	Value T
}

// Null returns an explicit null.
func Null[T any]() Nullable[T] { return Nullable[T]{Set: true} }

// Some returns a present, non-null value.
func Some[T any](v T) Nullable[T] { return Nullable[T]{Set: true, Valid: true, Value: v} }

// IsZero reports an absent field (for omitzero).
func (n Nullable[T]) IsZero() bool { return !n.Set }

// MarshalJSON writes null or the value.
func (n Nullable[T]) MarshalJSON() ([]byte, error) {
	if !n.Set || !n.Valid {
		return []byte("null"), nil
	}
	return json.Marshal(n.Value)
}

// UnmarshalJSON records presence, null or the value.
func (n *Nullable[T]) UnmarshalJSON(b []byte) error {
	var zero T
	n.Set = true
	if bytes.Equal(bytes.TrimSpace(b), []byte("null")) {
		n.Valid, n.Value = false, zero
		return nil
	}
	n.Valid, n.Value = true, zero
	return json.Unmarshal(b, &n.Value)
}

// Resolved is the policy one client gets (GET /api/v1/claudex/policy, the
// bootstrap section "policy" and the admin preview).
type Resolved struct {
	Revision int64  `json:"revision"`
	GroupID  *int64 `json:"group_id"`
	Fields
}

// Fields are the resolved policy values (design 1.6.1). There is no Bypass
// field: Bypass permissions is the user's own choice (owner decision 3).
type Fields struct {
	PermissionModes          []string            `json:"permission_modes"`
	Incognito                bool                `json:"incognito"`
	WebSearch                bool                `json:"web_search"`
	WebSearchDefault         bool                `json:"web_search_default"`
	Voice                    bool                `json:"voice"`
	LocalMCPEditing          bool                `json:"local_mcp_editing"`
	DeveloperModeEnabled     bool                `json:"developer_mode_enabled"`
	DesktopExtensionsEnabled bool                `json:"desktop_extensions_enabled"`
	DeveloperMCPEnabled      bool                `json:"developer_mcp_enabled"`
	RemoteImages             bool                `json:"remote_images"`
	RemoteImageDomains       []string            `json:"remote_image_domains"`
	ExternalLinks            bool                `json:"external_links"`
	TrustedLinkDomains       []string            `json:"trusted_link_domains"`
	Connectors               []ConnectorRule     `json:"connectors"`
	Attachments              ResolvedAttachments `json:"attachments"`
	Links                    ResolvedLinks       `json:"links"`
	UsageBanner              ResolvedUsageBanner `json:"usage_banner"`
	PlanLabel                *string             `json:"plan_label"`
	ScheduledTasks           ResolvedScheduled   `json:"scheduled_tasks"`
	ApprovalsAlwaysAllow     bool                `json:"approvals_always_allow"`
	Memory                   ResolvedMemory      `json:"memory"`
	Research                 ResolvedResearch    `json:"research"`
	Browser                  ResolvedBrowser     `json:"browser"`
	SSHRemote                bool                `json:"ssh_remote"`
	CodexRuntimeMirror       *string             `json:"codex_runtime_mirror"`
	ComputerUse              ResolvedComputerUse `json:"computer_use"`
	Workflows                bool                `json:"workflows"`
	WorkflowApprovalRequired bool                `json:"workflow_approval_required"`
}

// ResolvedMemory is the memory policy; with Enabled off every switch is off.
type ResolvedMemory struct {
	Enabled     bool    `json:"enabled"`
	SearchChats bool    `json:"search_chats"`
	Generate    bool    `json:"generate"`
	DefaultOn   bool    `json:"default_on"`
	Model       *string `json:"model"`
}

// ResolvedResearch is the Research policy; Enabled and XSearch are off
// whenever web_search is off.
type ResolvedResearch struct {
	Enabled            bool `json:"enabled"`
	XSearch            bool `json:"x_search"`
	MaxSearchesPerTurn int  `json:"max_searches_per_turn"`
}

// ResolvedBrowser is the built-in browser policy.
type ResolvedBrowser struct {
	Enabled        bool     `json:"enabled"`
	ExternalSites  bool     `json:"external_sites"`
	AllowScript    bool     `json:"allow_script"`
	DevServers     bool     `json:"dev_servers"`
	BlockedDomains []string `json:"blocked_domains"`
}

// ResolvedComputerUse is the computer-use policy; MaxActionsPerTurn nil
// keeps the client's own cap.
type ResolvedComputerUse struct {
	Enabled           bool     `json:"enabled"`
	AllowFullControl  bool     `json:"allow_full_control"`
	DeniedApps        []string `json:"denied_apps"`
	MaxActionsPerTurn *int     `json:"max_actions_per_turn"`
}

// ResolvedAttachments is the attachment policy; MaxBytes nil keeps the
// client's built-in ceilings, an empty Types list turns attachments off.
type ResolvedAttachments struct {
	MaxBytes *int64   `json:"max_bytes"`
	Types    []string `json:"types"`
}

// ResolvedLinks are the links the client shows; nil hides a link.
type ResolvedLinks struct {
	Help           *string `json:"help"`
	Plans          *string `json:"plans"`
	Apps           *string `json:"apps"`
	GetMoreUsage   *string `json:"get_more_usage"`
	UsageLearnMore *string `json:"usage_learn_more"`
	LearnMore      []Link  `json:"learn_more"`
}

// ResolvedUsageBanner is the usage warning threshold in percent.
type ResolvedUsageBanner struct {
	WarnPercent int `json:"warn_percent"`
}

// ResolvedScheduled is the scheduled-task policy; MaxTasks nil is unlimited.
type ResolvedScheduled struct {
	ApprovalLifetimeDays *int `json:"approval_lifetime_days,omitempty"`
	Enabled              bool `json:"enabled"`
	MaxTasks             *int `json:"max_tasks"`
}

// Built-in defaults (design 1.6.1).
const (
	builtinWarnPercent = 80
	// builtinMaxSearches is the default search cap of one Research turn.
	builtinMaxSearches = 30
	bytesPerMegabyte   = 1 << 20
)

// Builtin returns the built-in policy: nothing restricted.
func Builtin() Fields {
	return Fields{
		PermissionModes:          append([]string(nil), PolicyModes...),
		Incognito:                true,
		WebSearch:                true,
		WebSearchDefault:         false,
		Voice:                    true,
		LocalMCPEditing:          true,
		DeveloperModeEnabled:     true,
		DesktopExtensionsEnabled: true,
		DeveloperMCPEnabled:      true,
		RemoteImages:             true,
		RemoteImageDomains:       nil,
		ExternalLinks:            true,
		TrustedLinkDomains:       []string{},
		Connectors:               nil,
		Attachments:              ResolvedAttachments{MaxBytes: nil, Types: append([]string(nil), AttachmentTypes...)},
		Links:                    ResolvedLinks{LearnMore: []Link{}},
		UsageBanner:              ResolvedUsageBanner{WarnPercent: builtinWarnPercent},
		PlanLabel:                nil,
		ScheduledTasks:           ResolvedScheduled{Enabled: true, MaxTasks: nil},
		ApprovalsAlwaysAllow:     true,
		Memory:                   ResolvedMemory{Enabled: true, SearchChats: true, Generate: true, DefaultOn: false, Model: nil},
		Research:                 ResolvedResearch{Enabled: true, XSearch: true, MaxSearchesPerTurn: builtinMaxSearches},
		Browser: ResolvedBrowser{
			Enabled: true, ExternalSites: true, AllowScript: true, DevServers: true, BlockedDomains: []string{},
		},
		SSHRemote:          true,
		Workflows:          true,
		CodexRuntimeMirror: nil,
		// Computer use stays off until an administrator turns it on.
		ComputerUse: ResolvedComputerUse{
			Enabled: false, AllowFullControl: true, DeniedApps: []string{}, MaxActionsPerTurn: nil,
		},
	}
}

// defaultDocument is the value of a missing setting. Maps stay nil here and
// are filled by normalize (see core.JSONSetting).
func defaultDocument() Document {
	return Document{Version: documentVersion}
}
