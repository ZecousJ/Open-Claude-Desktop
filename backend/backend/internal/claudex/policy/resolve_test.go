package policy

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
)

func ptr[T any](v T) *T { return &v }

// doc parses a stored document the way the setting does (lenient decode, then
// normalize).
func doc(t *testing.T, raw string) Document {
	t.Helper()
	d := defaultDocument()
	require.NoError(t, json.Unmarshal([]byte(raw), &d))
	normalizeDocument(&d)
	return d
}

func resolvedJSON(t *testing.T, d Document, groupID *int64, userID int64, platform string, fb Fallbacks) map[string]any {
	t.Helper()
	var out map[string]any
	require.NoError(t, json.Unmarshal([]byte(mustJSON(t, d.Resolve(groupID, userID, platform, fb))), &out))
	return out
}

func TestResolveEmptyDocumentIsBuiltin(t *testing.T) {
	d := doc(t, `{}`)
	res := d.Resolve(nil, 0, "", Fallbacks{})
	require.Equal(t, Resolved{Revision: 0, GroupID: nil, Fields: Builtin()}, res)
	jsonEq(t, `{
	  "revision":0,"group_id":null,
	  "permission_modes":["auto","manual","acceptEdits","plan"],
	  "incognito":true,"web_search":true,"web_search_default":false,"voice":true,"local_mcp_editing":true,"developer_mode_enabled":true,"desktop_extensions_enabled":true,"developer_mcp_enabled":true,
	  "remote_images":true,"remote_image_domains":null,"external_links":true,"trusted_link_domains":[],
	  "connectors":null,
	  "attachments":{"max_bytes":null,"types":["png","jpg","jpeg","webp","gif","pdf","docx","pptx","xlsx","txt","md","csv","ts","tsx","js","jsx","py","json","yaml","yml","html","css","rs","go","java","c","cpp","xml","toml","log"]},
	  "links":{"help":null,"plans":null,"apps":null,"get_more_usage":null,"usage_learn_more":null,"learn_more":[]},
	  "usage_banner":{"warn_percent":80},"plan_label":null,
	  "scheduled_tasks":{"enabled":true,"max_tasks":null},"approvals_always_allow":true,
	  "memory":{"enabled":true,"search_chats":true,"generate":true,"default_on":false,"model":null},
	  "research":{"enabled":true,"x_search":true,"max_searches_per_turn":30},
	  "browser":{"enabled":true,"external_sites":true,"allow_script":true,"dev_servers":true,"blocked_domains":[]},
	  "ssh_remote":true,"codex_runtime_mirror":null,
	  "computer_use":{"enabled":false,"allow_full_control":true,"denied_apps":[],"max_actions_per_turn":null},
	  "workflows":true,"workflow_approval_required":false}`, mustJSON(t, res))
}

func TestResolveThreeLayers(t *testing.T) {
	d := doc(t, `{
	  "revision": 5,
	  "defaults": {"incognito": false, "voice": false, "plan_label": "Team", "web_search_default": true,
	               "trusted_link_domains": ["a.example.com"], "remote_image_domains": ["img.example.com"],
	               "approvals_always_allow": false},
	  "group_overrides": {"4": {"voice": true, "plan_label": "Max", "trusted_link_domains": ["b.example.com"]},
	                      "3": {"incognito": true}},
	  "user_overrides": {"123": {"plan_label": null, "remote_image_domains": null, "web_search": false},
	                     "999": {"voice": false}}
	}`)
	cases := []struct {
		name  string
		group *int64
		user  int64
		check func(t *testing.T, r Resolved)
	}{
		{name: "defaults only (no plan, other user)", group: nil, user: 1, check: func(t *testing.T, r Resolved) {
			require.False(t, r.Incognito)
			require.False(t, r.Voice)
			require.Equal(t, ptr("Team"), r.PlanLabel)
			require.True(t, r.WebSearchDefault)
			require.False(t, r.ApprovalsAlwaysAllow)
			require.Equal(t, []string{"a.example.com"}, r.TrustedLinkDomains)
			require.Equal(t, []string{"img.example.com"}, r.RemoteImageDomains)
		}},
		{name: "group replaces scalars and lists", group: ptr[int64](4), user: 1, check: func(t *testing.T, r Resolved) {
			require.True(t, r.Voice)
			require.Equal(t, ptr("Max"), r.PlanLabel)
			require.Equal(t, []string{"b.example.com"}, r.TrustedLinkDomains)
			require.False(t, r.Incognito, "group 4 does not touch incognito")
		}},
		{name: "user on top of group; null clears", group: ptr[int64](4), user: 123, check: func(t *testing.T, r Resolved) {
			require.True(t, r.Voice)
			require.Nil(t, r.PlanLabel, "the user override's null clears the group's label")
			require.Nil(t, r.RemoteImageDomains, "null means no domain restriction")
			require.False(t, r.WebSearch)
			require.Equal(t, []string{"b.example.com"}, r.TrustedLinkDomains)
		}},
		{name: "another group", group: ptr[int64](3), user: 1, check: func(t *testing.T, r Resolved) {
			require.True(t, r.Incognito)
			require.False(t, r.Voice)
			require.Equal(t, ptr("Team"), r.PlanLabel)
		}},
		{name: "override of a group that is not the plan never applies", group: ptr[int64](7), user: 1, check: func(t *testing.T, r Resolved) {
			require.False(t, r.Voice)
			require.Equal(t, ptr[int64](7), r.GroupID)
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := d.Resolve(tc.group, tc.user, "", Fallbacks{})
			require.Equal(t, int64(5), r.Revision)
			require.Equal(t, tc.group, r.GroupID)
			tc.check(t, r)
		})
	}
}

func TestResolveConnectorsThreeStates(t *testing.T) {
	d := doc(t, `{
	  "defaults": {"connectors": ["github", {"name": "local", "command": "npx", "args": ["-y", "@acme/mcp"]}]},
	  "group_overrides": {"1": {}, "2": {"connectors": null}, "3": {"connectors": []},
	                      "4": {"connectors": [{"name": "linear", "url_prefix": "https://mcp.linear.app"}]}},
	  "user_overrides": {"10": {"connectors": null}}
	}`)
	var inherited = `[{"name":"github"},{"name":"local","command":"npx","args":["-y","@acme/mcp"]}]`
	cases := []struct {
		name  string
		group int64
		user  int64
		want  string
	}{
		{"key missing inherits", 1, 0, inherited},
		{"null means no restriction", 2, 0, `null`},
		{"empty list allows none", 3, 0, `[]`},
		{"list replaces", 4, 0, `[{"name":"linear","url_prefix":"https://mcp.linear.app"}]`},
		{"user null over group list", 4, 10, `null`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := resolvedJSON(t, d, &tc.group, tc.user, "", Fallbacks{})
			jsonEq(t, tc.want, mustJSON(t, got["connectors"]))
		})
	}
}

func TestResolvePermissionModesByPlatform(t *testing.T) {
	d := doc(t, `{
	  "defaults": {"permission_modes": {"default": ["auto","manual","acceptEdits","plan"], "win32": ["plan","manual"]}},
	  "group_overrides": {"1": {"permission_modes": ["plan"]},
	                      "2": {"permission_modes": {"linux": ["manual"]}},
	                      "3": {"permission_modes": {"default": ["acceptEdits"], "darwin": ["auto"]}}}
	}`)
	cases := []struct {
		name     string
		group    *int64
		platform string
		want     []string
	}{
		{"platform key", nil, "win32", []string{"manual", "plan"}},
		{"default key", nil, "darwin", []string{"auto", "manual", "acceptEdits", "plan"}},
		{"no platform header uses default", nil, "", []string{"auto", "manual", "acceptEdits", "plan"}},
		{"group list replaces the whole map", ptr[int64](1), "win32", []string{"plan"}},
		{"group map without the platform or default falls back to built-in", ptr[int64](2), "win32", PolicyModes},
		{"group map, own platform", ptr[int64](2), "linux", []string{"manual"}},
		{"group map default", ptr[int64](3), "win32", []string{"acceptEdits"}},
		{"group map platform", ptr[int64](3), "darwin", []string{"auto"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := d.Resolve(tc.group, 0, tc.platform, Fallbacks{})
			require.Equal(t, tc.want, r.PermissionModes)
		})
	}
}

func TestResolveSubfieldMerge(t *testing.T) {
	d := doc(t, `{
	  "defaults": {
	    "attachments": {"max_megabytes": 10, "types": ["png","txt"]},
	    "links": {"help": "https://help.example.com", "apps": "https://apps.example.com",
	              "learn_more": [{"label": "A", "url": "https://a.example.com"}, {"label": "B", "url": "https://b.example.com"}]},
	    "usage_banner": {"warn_percent": 70},
	    "scheduled_tasks": {"enabled": false, "max_tasks": 5}
	  },
	  "group_overrides": {"4": {
	    "attachments": {"types": ["md"]},
	    "links": {"apps": null, "plans": "https://plans.example.com", "learn_more": [{"label": "C", "url": "https://c.example.com"}]},
	    "usage_banner": {},
	    "scheduled_tasks": {"max_tasks": null}
	  }},
	  "user_overrides": {"5": {"attachments": {"max_megabytes": null}, "scheduled_tasks": {"enabled": true}}}
	}`)
	r := d.Resolve(ptr[int64](4), 0, "", Fallbacks{})
	require.Equal(t, ptr[int64](10*1048576), r.Attachments.MaxBytes, "max_megabytes kept from defaults")
	require.Equal(t, []string{"md"}, r.Attachments.Types)
	require.Equal(t, ptr("https://help.example.com"), r.Links.Help)
	require.Nil(t, r.Links.Apps, "null clears the inherited link")
	require.Equal(t, ptr("https://plans.example.com"), r.Links.Plans)
	require.Equal(t, []Link{{Label: "C", URL: "https://c.example.com"}}, r.Links.LearnMore, "learn_more is replaced whole")
	require.Equal(t, 70, r.UsageBanner.WarnPercent)
	require.False(t, r.ScheduledTasks.Enabled)
	require.Nil(t, r.ScheduledTasks.MaxTasks)

	r = d.Resolve(ptr[int64](4), 5, "", Fallbacks{})
	require.Nil(t, r.Attachments.MaxBytes)
	require.True(t, r.ScheduledTasks.Enabled)

	r = d.Resolve(nil, 0, "", Fallbacks{})
	require.Equal(t, ptr(5), r.ScheduledTasks.MaxTasks)
	require.Len(t, r.Links.LearnMore, 2)
}

func TestResolveMaxMegabytesToBytes(t *testing.T) {
	for _, tc := range []struct {
		mb   string
		want *int64
	}{
		{"10", ptr[int64](10485760)},
		{"0.5", ptr[int64](524288)},
		{"20", ptr[int64](20971520)},
		{"1.25", ptr[int64](1310720)},
		{"null", nil},
	} {
		t.Run(tc.mb, func(t *testing.T) {
			d := doc(t, `{"defaults": {"attachments": {"max_megabytes": `+tc.mb+`}}}`)
			require.Equal(t, tc.want, d.Resolve(nil, 0, "", Fallbacks{}).Attachments.MaxBytes)
		})
	}
}

func TestResolveLinkFallbacks(t *testing.T) {
	fb := Fallbacks{DocURL: ptr("https://docs.example.com"), PurchaseSubscriptionURL: ptr("https://shop.example.com")}
	r := doc(t, `{}`).Resolve(nil, 0, "", fb)
	require.Equal(t, ptr("https://docs.example.com"), r.Links.Help)
	require.Equal(t, ptr("https://shop.example.com"), r.Links.Plans)
	require.Equal(t, ptr("https://shop.example.com"), r.Links.GetMoreUsage)
	require.Nil(t, r.Links.Apps)
	require.Nil(t, r.Links.UsageLearnMore)

	r = doc(t, `{"defaults": {"links": {"help": "https://own-help.example.com", "get_more_usage": "https://more.example.com"}}}`).Resolve(nil, 0, "", fb)
	require.Equal(t, ptr("https://own-help.example.com"), r.Links.Help, "an explicit link wins")
	require.Equal(t, ptr("https://more.example.com"), r.Links.GetMoreUsage)
	require.Equal(t, ptr("https://shop.example.com"), r.Links.Plans)
}

func TestResolveDoesNotAliasTheDocument(t *testing.T) {
	d := doc(t, `{"defaults": {"trusted_link_domains": ["a.example.com"], "connectors": ["x", {"name": "y", "command": "npx", "args": ["pkg"]}],
	  "links": {"learn_more": [{"label": "A", "url": "https://a.example.com"}]}, "permission_modes": ["plan"]}}`)
	r := d.Resolve(nil, 0, "", Fallbacks{})
	r.TrustedLinkDomains[0] = "changed"
	r.Connectors[0].Name = "changed"
	r.Connectors[1].Args[0] = "changed"
	r.Links.LearnMore[0].Label = "changed"
	r.PermissionModes[0] = "changed"
	again := d.Resolve(nil, 0, "", Fallbacks{})
	require.Equal(t, []string{"a.example.com"}, again.TrustedLinkDomains)
	require.Equal(t, "x", again.Connectors[0].Name)
	require.Equal(t, []string{"pkg"}, again.Connectors[1].Args)
	require.Equal(t, "A", again.Links.LearnMore[0].Label)
	require.Equal(t, []string{"plan"}, again.PermissionModes)
}

func TestNullableRoundTrip(t *testing.T) {
	type wrap struct {
		A Nullable[string] `json:"a,omitzero"`
		B Nullable[[]int]  `json:"b,omitzero"`
	}
	var w wrap
	require.NoError(t, json.Unmarshal([]byte(`{"a": null}`), &w))
	require.True(t, w.A.Set)
	require.False(t, w.A.Valid)
	require.False(t, w.B.Set)
	jsonEq(t, `{"a":null}`, mustJSON(t, w))

	w = wrap{}
	require.NoError(t, json.Unmarshal([]byte(`{"a": "x", "b": []}`), &w))
	require.Equal(t, Some("x"), w.A)
	require.True(t, w.B.Set && w.B.Valid)
	require.NotNil(t, w.B.Value)
	jsonEq(t, `{"a":"x","b":[]}`, mustJSON(t, w))
	jsonEq(t, `{}`, mustJSON(t, wrap{}))
}

// TestResolveRound2Layers: memory, research, browser, ssh_remote,
// codex_runtime_mirror and computer_use inherit field by field through the
// three layers.
func TestResolveRound2Layers(t *testing.T) {
	d := doc(t, `{
	  "defaults": {"memory": {"default_on": true, "model": "gpt-5.5-mini"},
	               "research": {"max_searches_per_turn": 20},
	               "browser": {"allow_script": false, "blocked_domains": ["mail.example.com"]},
	               "codex_runtime_mirror": "https://registry.npmmirror.com/",
	               "computer_use": {"enabled": true, "denied_apps": ["com.apple.Terminal"], "max_actions_per_turn": 100}},
	  "group_overrides": {"4": {"memory": {"generate": false},
	                            "research": {"x_search": false},
	                            "browser": {"external_sites": false, "blocked_domains": ["bank.example", "MAIL.example.com"]},
	                            "ssh_remote": false,
	                            "computer_use": {"allow_full_control": false, "denied_apps": ["cmd.exe", "COM.APPLE.TERMINAL"]}}},
	  "user_overrides": {"123": {"memory": {"model": null},
	                             "browser": {"blocked_domains": []},
	                             "codex_runtime_mirror": null,
	                             "computer_use": {"denied_apps": ["powershell.exe"], "max_actions_per_turn": null}}}
	}`)

	def := d.Resolve(nil, 0, "", Fallbacks{})
	require.Equal(t, ResolvedMemory{Enabled: true, SearchChats: true, Generate: true, DefaultOn: true, Model: ptr("gpt-5.5-mini")}, def.Memory)
	require.Equal(t, ResolvedResearch{Enabled: true, XSearch: true, MaxSearchesPerTurn: 20}, def.Research)
	require.Equal(t, ResolvedBrowser{Enabled: true, ExternalSites: true, AllowScript: false, DevServers: true,
		BlockedDomains: []string{"mail.example.com"}}, def.Browser)
	require.True(t, def.SSHRemote)
	require.Equal(t, ptr("https://registry.npmmirror.com/"), def.CodexRuntimeMirror)
	require.Equal(t, ResolvedComputerUse{Enabled: true, AllowFullControl: true, DeniedApps: []string{"com.apple.Terminal"},
		MaxActionsPerTurn: ptr(100)}, def.ComputerUse)

	group := d.Resolve(ptr[int64](4), 0, "", Fallbacks{})
	require.Equal(t, ResolvedMemory{Enabled: true, SearchChats: true, Generate: false, DefaultOn: true, Model: ptr("gpt-5.5-mini")}, group.Memory)
	require.Equal(t, ResolvedResearch{Enabled: true, XSearch: false, MaxSearchesPerTurn: 20}, group.Research)
	require.Equal(t, []string{"mail.example.com", "bank.example"}, group.Browser.BlockedDomains, "deny lists only grow")
	require.False(t, group.Browser.ExternalSites)
	require.False(t, group.SSHRemote)
	require.Equal(t, []string{"com.apple.Terminal", "cmd.exe"}, group.ComputerUse.DeniedApps, "compared without case")
	require.False(t, group.ComputerUse.AllowFullControl)

	user := d.Resolve(ptr[int64](4), 123, "", Fallbacks{})
	require.Nil(t, user.Memory.Model, "an explicit null hides the inherited model")
	require.Nil(t, user.CodexRuntimeMirror)
	require.Equal(t, []string{"mail.example.com", "bank.example"}, user.Browser.BlockedDomains,
		"an empty list at a later layer does not unblock anything")
	require.Equal(t, []string{"com.apple.Terminal", "cmd.exe", "powershell.exe"}, user.ComputerUse.DeniedApps)
	require.Nil(t, user.ComputerUse.MaxActionsPerTurn)
	require.True(t, user.ComputerUse.Enabled)

	// Resolving never changes the stored lists.
	user.Browser.BlockedDomains[0] = "changed"
	user.ComputerUse.DeniedApps[0] = "changed"
	again := d.Resolve(ptr[int64](4), 123, "", Fallbacks{})
	require.Equal(t, "mail.example.com", again.Browser.BlockedDomains[0])
	require.Equal(t, "com.apple.Terminal", again.ComputerUse.DeniedApps[0])
	require.Equal(t, []string{"mail.example.com"}, *d.Defaults.Browser.BlockedDomains)
}

// TestResolveRound2Dependencies: memory off turns its switches off; web
// search off turns Research and X search off, whatever the research block
// says, and web search on again at a later layer brings them back.
func TestResolveRound2Dependencies(t *testing.T) {
	d := doc(t, `{
	  "defaults": {"memory": {"enabled": false, "search_chats": true, "generate": true, "default_on": true},
	               "web_search": false, "research": {"enabled": true, "x_search": true}},
	  "group_overrides": {"4": {"web_search": true}},
	  "user_overrides": {"123": {"memory": {"enabled": true}}}
	}`)
	r := d.Resolve(nil, 0, "", Fallbacks{})
	require.Equal(t, ResolvedMemory{}, r.Memory)
	require.False(t, r.Research.Enabled)
	require.False(t, r.Research.XSearch)
	require.Equal(t, 30, r.Research.MaxSearchesPerTurn, "the cap keeps its value")

	r = d.Resolve(ptr[int64](4), 123, "", Fallbacks{})
	require.Equal(t, ResolvedMemory{Enabled: true, SearchChats: true, Generate: true, DefaultOn: true}, r.Memory)
	require.True(t, r.Research.Enabled)
	require.True(t, r.Research.XSearch)
}

// TestComputerUseIsOffByDefault: a service without a policy never offers
// computer use; SSH and the browser stay available.
func TestComputerUseIsOffByDefault(t *testing.T) {
	r := doc(t, `{}`).Resolve(nil, 0, "", Fallbacks{})
	require.False(t, r.ComputerUse.Enabled)
	require.True(t, r.SSHRemote)
	require.True(t, r.Browser.Enabled)
	require.Equal(t, []string{}, r.ComputerUse.DeniedApps)
	require.Equal(t, []string{}, r.Browser.BlockedDomains)
}
