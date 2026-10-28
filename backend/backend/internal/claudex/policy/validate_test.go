package policy

import (
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// putBody builds a PUT body with revision 0.
func putBody(defaults, groups, users string) string {
	return fmt.Sprintf(`{"revision":0,"defaults":%s,"group_overrides":%s,"user_overrides":%s}`, defaults, groups, users)
}

func defaultsBody(patch string) string { return putBody(patch, `[]`, `[]`) }

func repeat(item string, n int) string {
	parts := make([]string, n)
	for i := range parts {
		parts[i] = strings.ReplaceAll(item, "%d", fmt.Sprint(i+1))
	}
	return "[" + strings.Join(parts, ",") + "]"
}

// TestEveryValidationRuleNamesTheField sends one invalid PUT per rule (and per
// place the rule applies) and checks the 400 CLAUDEX_POLICY_INVALID answer
// names the field and the rule. Nothing is stored.
func TestEveryValidationRuleNamesTheField(t *testing.T) {
	long := func(n int) string { return strings.Repeat("x", n) }
	cases := []struct {
		name  string
		body  string
		field string
		rule  string
	}{
		// JSON shape
		{"not JSON", `{"revision":0,`, "", RuleInvalidJSON},
		{"trailing data after the object", defaultsBody(`{}`) + `{}`, "", RuleInvalidJSON},
		{"body not an object", `[]`, "", RuleInvalidType},
		{"unknown top-level key", `{"revision":0,"defaults":{},"group_overrides":[],"user_overrides":[],"extra":1}`, "extra", RuleUnknownField},
		{"repeated top-level key", `{"revision":0,"revision":0,"defaults":{},"group_overrides":[],"user_overrides":[]}`, "revision", RuleDuplicateField},
		{"repeated patch key", defaultsBody(`{"voice":true,"voice":false}`), "defaults.voice", RuleDuplicateField},
		{"revision missing", `{"defaults":{},"group_overrides":[],"user_overrides":[]}`, "revision", RuleRequired},
		{"revision not an integer", `{"revision":"0","defaults":{},"group_overrides":[],"user_overrides":[]}`, "revision", RuleInvalidType},
		{"revision fraction", `{"revision":0.5,"defaults":{},"group_overrides":[],"user_overrides":[]}`, "revision", RuleInvalidType},
		{"revision negative", `{"revision":-1,"defaults":{},"group_overrides":[],"user_overrides":[]}`, "revision", RuleOutOfRange},
		{"defaults missing", `{"revision":0,"group_overrides":[],"user_overrides":[]}`, "defaults", RuleRequired},
		{"group_overrides missing", `{"revision":0,"defaults":{},"user_overrides":[]}`, "group_overrides", RuleRequired},
		{"user_overrides missing", `{"revision":0,"defaults":{},"group_overrides":[]}`, "user_overrides", RuleRequired},
		{"defaults null", putBody(`null`, `[]`, `[]`), "defaults", RuleInvalidType},
		{"unknown patch field", defaultsBody(`{"fast":true}`), "defaults.fast", RuleUnknownField},
		{"research not an object", defaultsBody(`{"research":true}`), "defaults.research", RuleInvalidType},
		{"unknown research field", defaultsBody(`{"research":{"deep":true}}`), "defaults.research.deep", RuleUnknownField},
		{"research searches zero", defaultsBody(`{"research":{"max_searches_per_turn":0}}`), "defaults.research.max_searches_per_turn", RuleOutOfRange},
		{"research searches over 200", defaultsBody(`{"research":{"max_searches_per_turn":201}}`), "defaults.research.max_searches_per_turn", RuleOutOfRange},
		{"research searches null", defaultsBody(`{"research":{"max_searches_per_turn":null}}`), "defaults.research.max_searches_per_turn", RuleInvalidType},
		{"memory enabled null", defaultsBody(`{"memory":{"enabled":null}}`), "defaults.memory.enabled", RuleInvalidType},
		{"memory model blank", defaultsBody(`{"memory":{"model":"  "}}`), "defaults.memory.model", RuleRequired},
		{"memory model wildcard", defaultsBody(`{"memory":{"model":"gpt-*"}}`), "defaults.memory.model", RuleInvalidModel},
		{"memory model space", defaultsBody(`{"memory":{"model":"gpt 5"}}`), "defaults.memory.model", RuleInvalidModel},
		{"memory bypass key", defaultsBody(`{"memory":{"bypass":true}}`), "defaults.memory.bypass", RuleBypass},
		{"browser blocked domain", defaultsBody(`{"browser":{"blocked_domains":["https://x.com"]}}`), "defaults.browser.blocked_domains[0]", RuleInvalidDomain},
		{"browser blocked null", defaultsBody(`{"browser":{"blocked_domains":null}}`), "defaults.browser.blocked_domains", RuleInvalidType},
		{"browser unknown field", defaultsBody(`{"browser":{"import_cookies":true}}`), "defaults.browser.import_cookies", RuleUnknownField},
		{"ssh_remote string", defaultsBody(`{"ssh_remote":"yes"}`), "defaults.ssh_remote", RuleInvalidType},
		{"mirror http", defaultsBody(`{"codex_runtime_mirror":"http://mirror.example.com/npm/"}`), "defaults.codex_runtime_mirror", RuleHTTPSRequired},
		{"mirror number", defaultsBody(`{"codex_runtime_mirror":5}`), "defaults.codex_runtime_mirror", RuleInvalidType},
		{"computer use app", defaultsBody(`{"computer_use":{"denied_apps":["rm -rf /"]}}`), "defaults.computer_use.denied_apps[0]", RuleInvalidApp},
		{"computer use app blank", defaultsBody(`{"computer_use":{"denied_apps":["com.apple.Terminal"," "]}}`), "defaults.computer_use.denied_apps[1]", RuleInvalidApp},
		{"computer use actions zero", defaultsBody(`{"computer_use":{"max_actions_per_turn":0}}`), "defaults.computer_use.max_actions_per_turn", RuleOutOfRange},
		{"computer use actions over", defaultsBody(`{"computer_use":{"max_actions_per_turn":1001}}`), "defaults.computer_use.max_actions_per_turn", RuleOutOfRange},
		{"computer use enabled string", defaultsBody(`{"computer_use":{"enabled":"on"}}`), "defaults.computer_use.enabled", RuleInvalidType},
		{"bool field string", defaultsBody(`{"incognito":"yes"}`), "defaults.incognito", RuleInvalidType},
		{"bool field null", defaultsBody(`{"voice":null}`), "defaults.voice", RuleInvalidType},
		{"list field null", defaultsBody(`{"trusted_link_domains":null}`), "defaults.trusted_link_domains", RuleInvalidType},
		{"list element not a string", defaultsBody(`{"trusted_link_domains":["a.example.com",7]}`), "defaults.trusted_link_domains[1]", RuleInvalidType},
		{"plan_label number", defaultsBody(`{"plan_label":5}`), "defaults.plan_label", RuleInvalidType},
		{"attachments not an object", defaultsBody(`{"attachments":[]}`), "defaults.attachments", RuleInvalidType},

		// Bypass is never a policy value (owner decision 3)
		{"bypass in a group's win32 list (design example)", putBody(`{}`, `[{"group_id":4,"patch":{"permission_modes":{"default":["auto"],"win32":["manual","bypass"]}}}]`, `[]`), "group_overrides.4.permission_modes.win32", RuleBypass},
		{"bypass in the defaults list", defaultsBody(`{"permission_modes":["auto","bypass"]}`), "defaults.permission_modes", RuleBypass},
		{"Bypass spelled differently", defaultsBody(`{"permission_modes":["bypassPermissions"]}`), "defaults.permission_modes", RuleBypass},
		{"bypass in a user override", putBody(`{}`, `[]`, `[{"user_id":123,"patch":{"permission_modes":["Bypass"]}}]`), "user_overrides.123.permission_modes", RuleBypass},
		{"bypass as a platform key", defaultsBody(`{"permission_modes":{"bypass":["auto"]}}`), "defaults.permission_modes.bypass", RuleBypass},
		{"bypass as a patch field", defaultsBody(`{"bypass":false}`), "defaults.bypass", RuleBypass},
		{"escaped bypass key", defaultsBody(`{"\u0062ypass":true}`), "defaults.bypass", RuleBypass},
		{"escaped bypass mode", defaultsBody(`{"permission_modes":["b\u0079pass"]}`), "defaults.permission_modes", RuleBypass},
		{"allow_bypass under scheduled_tasks", defaultsBody(`{"scheduled_tasks":{"allow_bypass":false}}`), "defaults.scheduled_tasks.allow_bypass", RuleBypass},

		// permission modes
		{"unknown mode", defaultsBody(`{"permission_modes":["auto","yolo"]}`), "defaults.permission_modes", RuleUnknownMode},
		{"mode not a string", defaultsBody(`{"permission_modes":["auto",1]}`), "defaults.permission_modes", RuleInvalidType},
		{"modes not a list", defaultsBody(`{"permission_modes":"auto"}`), "defaults.permission_modes", RuleInvalidType},
		{"modes null", defaultsBody(`{"permission_modes":null}`), "defaults.permission_modes", RuleInvalidType},
		{"empty mode list", defaultsBody(`{"permission_modes":[]}`), "defaults.permission_modes", RuleEmptyModeList},
		{"empty platform list", defaultsBody(`{"permission_modes":{"default":["auto"],"linux":[]}}`), "defaults.permission_modes.linux", RuleEmptyModeList},
		{"unknown platform", defaultsBody(`{"permission_modes":{"freebsd":["auto"]}}`), "defaults.permission_modes.freebsd", RuleUnknownPlatform},

		// URLs
		{"http link", defaultsBody(`{"links":{"help":"http://docs.example.com"}}`), "defaults.links.help", RuleHTTPSRequired},
		{"link with credentials", defaultsBody(`{"links":{"plans":"https://user:pw@example.com"}}`), "defaults.links.plans", RuleHTTPSRequired},
		{"relative link", defaultsBody(`{"links":{"apps":"/apps"}}`), "defaults.links.apps", RuleHTTPSRequired},
		{"javascript link", defaultsBody(`{"links":{"get_more_usage":"javascript:alert(1)"}}`), "defaults.links.get_more_usage", RuleHTTPSRequired},
		{"link over 2000 bytes", defaultsBody(`{"links":{"usage_learn_more":"https://example.com/` + long(2000) + `"}}`), "defaults.links.usage_learn_more", RuleHTTPSRequired},
		{"learn_more url", defaultsBody(`{"links":{"learn_more":[{"label":"A","url":"ftp://example.com"}]}}`), "defaults.links.learn_more[0].url", RuleHTTPSRequired},
		{"connector url_prefix", defaultsBody(`{"connectors":[{"name":"x","url_prefix":"http://mcp.example.com"}]}`), "defaults.connectors[0].url_prefix", RuleHTTPSRequired},
		{"empty connector url_prefix", defaultsBody(`{"connectors":[{"name":"x","url_prefix":""}]}`), "defaults.connectors[0].url_prefix", RuleHTTPSRequired},
		{"unknown links key", defaultsBody(`{"links":{"docs":"https://example.com"}}`), "defaults.links.docs", RuleUnknownField},

		// labels and texts
		{"learn_more label missing", defaultsBody(`{"links":{"learn_more":[{"url":"https://example.com"}]}}`), "defaults.links.learn_more[0].label", RuleRequired},
		{"learn_more label blank", defaultsBody(`{"links":{"learn_more":[{"label":"  ","url":"https://example.com"}]}}`), "defaults.links.learn_more[0].label", RuleRequired},
		{"learn_more label too long", defaultsBody(`{"links":{"learn_more":[{"label":"` + long(61) + `","url":"https://example.com"}]}}`), "defaults.links.learn_more[0].label", RuleTooLong},
		{"learn_more too many", defaultsBody(`{"links":{"learn_more":` + repeat(`{"label":"L%d","url":"https://example.com/%d"}`, 11) + `}}`), "defaults.links.learn_more", RuleTooMany},
		{"plan_label empty", defaultsBody(`{"plan_label":""}`), "defaults.plan_label", RuleRequired},
		{"plan_label too long", defaultsBody(`{"plan_label":"` + long(21) + `"}`), "defaults.plan_label", RuleTooLong},

		// connectors
		{"connector name with a space", defaultsBody(`{"connectors":["bad name"]}`), "defaults.connectors[0].name", RuleInvalidName},
		{"connector name too long", defaultsBody(`{"connectors":[{"name":"` + long(101) + `"}]}`), "defaults.connectors[0].name", RuleInvalidName},
		{"connector name missing", defaultsBody(`{"connectors":[{"command":"npx x"}]}`), "defaults.connectors[0].name", RuleRequired},
		{"connector command too long", defaultsBody(`{"connectors":[{"name":"x","command":"` + long(501) + `"}]}`), "defaults.connectors[0].command", RuleTooLong},
		{"connector command empty", defaultsBody(`{"connectors":[{"name":"x","command":""}]}`), "defaults.connectors[0].command", RuleRequired},
		{"connector unknown key", defaultsBody(`{"connectors":[{"name":"x","url":"https://mcp.example.com"}]}`), "defaults.connectors[0].url", RuleUnknownField},
		{"connector args without command", defaultsBody(`{"connectors":[{"name":"x","args":["a"]}]}`), "defaults.connectors[0].command", RuleRequired},
		{"connector args not a list", defaultsBody(`{"connectors":[{"name":"x","command":"npx","args":"-y"}]}`), "defaults.connectors[0].args", RuleInvalidType},
		{"connector args null", defaultsBody(`{"connectors":[{"name":"x","command":"npx","args":null}]}`), "defaults.connectors[0].args", RuleInvalidType},
		{"connector arg not a string", defaultsBody(`{"connectors":[{"name":"x","command":"npx","args":["-y",1]}]}`), "defaults.connectors[0].args[1]", RuleInvalidType},
		{"connector args too many", defaultsBody(`{"connectors":[{"name":"x","command":"npx","args":` + repeat(`"a%d"`, 51) + `}]}`), "defaults.connectors[0].args", RuleTooMany},
		{"connector arg too long", defaultsBody(`{"connectors":[{"name":"x","command":"npx","args":["` + long(501) + `"]}]}`), "defaults.connectors[0].args[0]", RuleTooLong},
		{"connectors too many", defaultsBody(`{"connectors":` + repeat(`"c%d"`, 201) + `}`), "defaults.connectors", RuleTooMany},
		{"connectors not a list", defaultsBody(`{"connectors":{}}`), "defaults.connectors", RuleInvalidType},

		// attachments
		{"max_megabytes zero", defaultsBody(`{"attachments":{"max_megabytes":0}}`), "defaults.attachments.max_megabytes", RuleOutOfRange},
		{"max_megabytes under one byte", defaultsBody(`{"attachments":{"max_megabytes":0.0000001}}`), "defaults.attachments.max_megabytes", RuleOutOfRange},
		{"max_megabytes over 20", defaultsBody(`{"attachments":{"max_megabytes":20.5}}`), "defaults.attachments.max_megabytes", RuleOutOfRange},
		{"max_megabytes string", defaultsBody(`{"attachments":{"max_megabytes":"10"}}`), "defaults.attachments.max_megabytes", RuleInvalidType},
		{"attachment type not built in", defaultsBody(`{"attachments":{"types":["png","exe"]}}`), "defaults.attachments.types[1]", RuleUnknownType},
		{"attachments unknown key", defaultsBody(`{"attachments":{"max_bytes":1}}`), "defaults.attachments.max_bytes", RuleUnknownField},

		// domains
		{"domain with port", defaultsBody(`{"trusted_link_domains":["example.com:443"]}`), "defaults.trusted_link_domains[0]", RuleInvalidDomain},
		{"domain with scheme", defaultsBody(`{"trusted_link_domains":["https://example.com"]}`), "defaults.trusted_link_domains[0]", RuleInvalidDomain},
		{"domain with path", defaultsBody(`{"remote_image_domains":["example.com/images"]}`), "defaults.remote_image_domains[0]", RuleInvalidDomain},
		{"bare wildcard", defaultsBody(`{"remote_image_domains":["*."]}`), "defaults.remote_image_domains[0]", RuleInvalidDomain},
		{"inner wildcard", defaultsBody(`{"trusted_link_domains":["a.*.example.com"]}`), "defaults.trusted_link_domains[0]", RuleInvalidDomain},
		{"too many domains", defaultsBody(`{"trusted_link_domains":` + repeat(`"h%d.example.com"`, 101) + `}`), "defaults.trusted_link_domains", RuleTooMany},

		// numbers
		{"warn_percent zero", defaultsBody(`{"usage_banner":{"warn_percent":0}}`), "defaults.usage_banner.warn_percent", RuleOutOfRange},
		{"warn_percent 100", defaultsBody(`{"usage_banner":{"warn_percent":100}}`), "defaults.usage_banner.warn_percent", RuleOutOfRange},
		{"warn_percent fraction", defaultsBody(`{"usage_banner":{"warn_percent":80.5}}`), "defaults.usage_banner.warn_percent", RuleInvalidType},
		{"warn_percent null", defaultsBody(`{"usage_banner":{"warn_percent":null}}`), "defaults.usage_banner.warn_percent", RuleInvalidType},
		{"max_tasks over 100", defaultsBody(`{"scheduled_tasks":{"max_tasks":101}}`), "defaults.scheduled_tasks.max_tasks", RuleOutOfRange},
		{"max_tasks negative", defaultsBody(`{"scheduled_tasks":{"max_tasks":-1}}`), "defaults.scheduled_tasks.max_tasks", RuleOutOfRange},
		{"max_tasks huge", defaultsBody(`{"scheduled_tasks":{"max_tasks":99999999999999999999}}`), "defaults.scheduled_tasks.max_tasks", RuleOutOfRange},
		{"scheduled_tasks enabled null", defaultsBody(`{"scheduled_tasks":{"enabled":null}}`), "defaults.scheduled_tasks.enabled", RuleInvalidType},

		// overrides
		{"group id zero", putBody(`{}`, `[{"group_id":0,"patch":{}}]`, `[]`), "group_overrides[0].group_id", RuleInvalidID},
		{"group id string", putBody(`{}`, `[{"group_id":"4","patch":{}}]`, `[]`), "group_overrides[0].group_id", RuleInvalidID},
		{"group id missing", putBody(`{}`, `[{"patch":{}}]`, `[]`), "group_overrides[0].group_id", RuleRequired},
		{"user id negative", putBody(`{}`, `[]`, `[{"user_id":-3,"patch":{}}]`), "user_overrides[0].user_id", RuleInvalidID},
		{"duplicate group", putBody(`{}`, `[{"group_id":4,"patch":{}},{"group_id":4,"patch":{"voice":false}}]`, `[]`), "group_overrides.4", RuleDuplicateID},
		{"duplicate user", putBody(`{}`, `[]`, `[{"user_id":123,"patch":{}},{"user_id":123,"patch":{}}]`), "user_overrides.123", RuleDuplicateID},
		{"override patch missing", putBody(`{}`, `[{"group_id":4}]`, `[]`), "group_overrides.4.patch", RuleRequired},
		{"override unknown key", putBody(`{}`, `[{"group_id":4,"patch":{},"name":"x"}]`, `[]`), "group_overrides[0].name", RuleUnknownField},
		{"override patch field error", putBody(`{}`, `[{"group_id":3,"patch":{"usage_banner":{"warn_percent":0}}}]`, `[]`), "group_overrides.3.usage_banner.warn_percent", RuleOutOfRange},
		{"overrides not a list", putBody(`{}`, `{}`, `[]`), "group_overrides", RuleInvalidType},
		{"too many group overrides", putBody(`{}`, repeat(`{"group_id":%d,"patch":{}}`, 201), `[]`), "group_overrides", RuleTooMany},
		{"too many user overrides", putBody(`{}`, `[]`, repeat(`{"user_id":%d,"patch":{}}`, 1001)), "user_overrides", RuleTooMany},

		{"too many blocked domains", defaultsBody(`{"browser":{"blocked_domains":` + repeat(`"d%d.example.com"`, 201) + `}}`),
			"defaults.browser.blocked_domains", RuleTooMany},
		{"too many denied apps", defaultsBody(`{"computer_use":{"denied_apps":` + repeat(`"app%d"`, 101) + `}}`),
			"defaults.computer_use.denied_apps", RuleTooMany},
		{"denied app too long", defaultsBody(`{"computer_use":{"denied_apps":["` + strings.Repeat("a", 201) + `"]}}`),
			"defaults.computer_use.denied_apps[0]", RuleInvalidApp},
		{"memory model too long", defaultsBody(`{"memory":{"model":"` + strings.Repeat("m", 201) + `"}}`),
			"defaults.memory.model", RuleInvalidModel},

		// size
		{"body over 256 KB", defaultsBody(`{"plan_label":"x"}` + strings.Repeat(" ", 256<<10)), "", RuleTooLarge},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t)
			r := f.put(tc.body)
			require.Equal(t, http.StatusBadRequest, r.status, "body %s", r.body)
			require.Equal(t, ReasonInvalid, r.reason)
			require.Equal(t, tc.field, r.field, "field")
			require.Equal(t, tc.rule, r.rule, "rule")
			require.NotEmpty(t, r.message)
			_, stored := f.settings.value(SettingKey)
			require.False(t, stored, "an invalid policy is never stored")
		})
	}
}

func TestOverrideReferencesMustExist(t *testing.T) {
	f := newFixture(t)
	r := f.put(putBody(`{}`, `[{"group_id":4,"patch":{}},{"group_id":99,"patch":{}}]`, `[]`))
	require.Equal(t, http.StatusBadRequest, r.status)
	require.Equal(t, ReasonGroupNotFound, r.reason)
	require.Equal(t, "group_overrides.99", r.field)
	require.Equal(t, RuleNotFound, r.rule)

	r = f.put(putBody(`{}`, `[]`, `[{"user_id":123,"patch":{}},{"user_id":555,"patch":{}}]`))
	require.Equal(t, http.StatusBadRequest, r.status)
	require.Equal(t, ReasonUserNotFound, r.reason)
	require.Equal(t, "user_overrides.555", r.field)
	require.Equal(t, RuleNotFound, r.rule)

	_, stored := f.settings.value(SettingKey)
	require.False(t, stored)
}

func TestParseCanonicalizes(t *testing.T) {
	u, err := ParseUpdate([]byte(putBody(`{
	  "permission_modes": {"win32": ["plan","manual","plan"], "default": ["acceptEdits","auto"]},
	  "trusted_link_domains": [" Docs.Example.COM ", "*.Example.org", "docs.example.com"],
	  "attachments": {"types": [".PNG", "md", "png"], "max_megabytes": 2.5},
	  "connectors": ["github", {"name": "linear", "url_prefix": " https://mcp.linear.app/sse "},
	                 {"name": "fs", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", " /srv/data "]}],
	  "links": {"learn_more": [{"label": "  Usage policy ", "url": "https://example.com/p"}], "help": null},
	  "plan_label": "  Max  "
	}`, `[]`, `[]`)), true)
	require.NoError(t, err)
	jsonEq(t, `{
	  "permission_modes": {"default": ["auto","acceptEdits"], "win32": ["manual","plan"]},
	  "trusted_link_domains": ["docs.example.com", "*.example.org"],
	  "attachments": {"max_megabytes": 2.5, "types": ["png","md"]},
	  "connectors": [{"name":"github"},{"name":"linear","url_prefix":"https://mcp.linear.app/sse"},
	                 {"name":"fs","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem"," /srv/data "]}],
	  "links": {"help": null, "learn_more": [{"label":"Usage policy","url":"https://example.com/p"}]},
	  "plan_label": "Max"
	}`, mustJSON(t, u.Defaults))
}

// TestParseCanonicalizesRound2 covers the memory, research, browser,
// ssh_remote, codex_runtime_mirror and computer_use fields.
func TestParseCanonicalizesRound2(t *testing.T) {
	u, err := ParseUpdate([]byte(putBody(`{
	  "memory": {"enabled": true, "default_on": true, "model": "  gpt-5.5-mini "},
	  "research": {"x_search": false, "max_searches_per_turn": 12},
	  "browser": {"external_sites": false, "blocked_domains": [" Mail.Example.COM ", "mail.example.com", "*.bank.example"]},
	  "ssh_remote": false,
	  "codex_runtime_mirror": "https://registry.npmmirror.com/",
	  "computer_use": {"enabled": true, "allow_full_control": false,
	                   "denied_apps": [" com.apple.Terminal ", "COM.APPLE.TERMINAL", "cmd.exe"], "max_actions_per_turn": 50}
	}`, `[]`, `[{"user_id":123,"patch":{"memory":{"model":null},"codex_runtime_mirror":null,"computer_use":{"max_actions_per_turn":null}}}]`)), true)
	require.NoError(t, err)
	jsonEq(t, `{
	  "memory": {"enabled": true, "default_on": true, "model": "gpt-5.5-mini"},
	  "research": {"x_search": false, "max_searches_per_turn": 12},
	  "browser": {"external_sites": false, "blocked_domains": ["mail.example.com", "*.bank.example"]},
	  "ssh_remote": false,
	  "codex_runtime_mirror": "https://registry.npmmirror.com/",
	  "computer_use": {"enabled": true, "allow_full_control": false,
	                   "denied_apps": ["com.apple.Terminal", "cmd.exe"], "max_actions_per_turn": 50}
	}`, mustJSON(t, u.Defaults))
	require.Len(t, u.Users, 1)
	jsonEq(t, `{"memory":{"model":null},"codex_runtime_mirror":null,"computer_use":{"max_actions_per_turn":null}}`,
		mustJSON(t, u.Users[0].Patch), "explicit nulls survive (they hide an inherited value)")
}

// TestStoredInvalidRound2FieldsAreDropped: invalid stored values of the new
// fields are dropped one by one; their valid neighbours stay.
func TestStoredInvalidRound2FieldsAreDropped(t *testing.T) {
	logs := captureLogs(t)
	d := doc(t, `{
	  "defaults": {"memory": {"enabled": false, "model": "bad model"},
	               "research": {"enabled": false, "max_searches_per_turn": 999},
	               "browser": {"dev_servers": false, "blocked_domains": ["https://bad/"]},
	               "codex_runtime_mirror": "http://mirror.example.com",
	               "computer_use": {"enabled": true, "denied_apps": ["a;b"], "max_actions_per_turn": 0}}
	}`)
	require.Equal(t, ptr(false), d.Defaults.Memory.Enabled)
	require.False(t, d.Defaults.Memory.Model.Set)
	require.Equal(t, ptr(false), d.Defaults.Research.Enabled)
	require.Nil(t, d.Defaults.Research.MaxSearchesPerTurn)
	require.Equal(t, ptr(false), d.Defaults.Browser.DevServers)
	require.Nil(t, d.Defaults.Browser.BlockedDomains)
	require.False(t, d.Defaults.CodexRuntimeMirror.Set)
	require.Equal(t, ptr(true), d.Defaults.ComputerUse.Enabled)
	require.Nil(t, d.Defaults.ComputerUse.DeniedApps)
	require.False(t, d.Defaults.ComputerUse.MaxActionsPerTurn.Set)
	require.NoError(t, validateDocument(&d))
	out := logs.String()
	for _, field := range []string{"defaults.memory.model", "defaults.research.max_searches_per_turn",
		"defaults.browser.blocked_domains[0]", "defaults.codex_runtime_mirror",
		"defaults.computer_use.denied_apps[0]", "defaults.computer_use.max_actions_per_turn"} {
		require.Contains(t, out, field)
	}
}

// TestStoredInvalidFieldsAreDropped: a stored document should always be
// valid, but one written by hand or by an older build is cleaned on read,
// field by field, with a warning; Bypass never survives.
func TestStoredInvalidFieldsAreDropped(t *testing.T) {
	logs := captureLogs(t)
	d := doc(t, `{
	  "revision": 3,
	  "defaults": {"permission_modes": ["auto","bypass"], "voice": false,
	               "links": {"help": "http://insecure.example.com", "apps": "https://apps.example.com"},
	               "usage_banner": {"warn_percent": 150}},
	  "group_overrides": {"4": {"permission_modes": {"default": ["bypass"], "win32": ["plan","bypass"]}},
	                      "x": {"voice": true}, "0": {"voice": true}},
	  "user_overrides": {"7": {"connectors": ["bad name"], "plan_label": "Pro"}}
	}`)
	require.Equal(t, &ModeSpec{List: []string{"auto"}}, d.Defaults.PermissionModes)
	require.Equal(t, ptr(false), d.Defaults.Voice)
	require.False(t, d.Defaults.Links.Help.Set, "the insecure link is dropped")
	require.Equal(t, Some("https://apps.example.com"), d.Defaults.Links.Apps)
	require.Nil(t, d.Defaults.UsageBanner)
	require.Nil(t, d.GroupOverrides["4"].PermissionModes, "a map left with an empty list is dropped whole")
	require.NotContains(t, d.GroupOverrides, "x")
	require.NotContains(t, d.GroupOverrides, "0")
	require.False(t, d.UserOverrides["7"].Connectors.Set)
	require.Equal(t, Some("Pro"), d.UserOverrides["7"].PlanLabel)
	require.NoError(t, validateDocument(&d))
	out := logs.String()
	require.Contains(t, out, "bypass in a stored policy mode list dropped")
	require.Contains(t, out, "defaults.links.help")
	require.Contains(t, out, "user_overrides.7.connectors")

	r := d.Resolve(ptr[int64](4), 7, "win32", Fallbacks{})
	require.Equal(t, []string{"auto"}, r.PermissionModes, "the group's list is gone, so the defaults' list (without bypass) applies")
	for _, m := range r.PermissionModes {
		require.NotContains(t, strings.ToLower(m), "bypass")
	}
}

// TestStoredConnectorArgsWithoutCommandAreDropped: arguments only bind a
// local command (strict match); a stored rule with arguments but no command
// is invalid, so the layer's connector list is dropped with a warning.
func TestStoredConnectorArgsWithoutCommandAreDropped(t *testing.T) {
	logs := captureLogs(t)
	d := doc(t, `{
	  "defaults": {"connectors": [{"name": "fs", "command": "npx", "args": ["-y", "pkg"]}]},
	  "user_overrides": {"7": {"connectors": [{"name": "fs", "args": ["-y", "other-pkg"]}]}}
	}`)
	require.False(t, d.UserOverrides["7"].Connectors.Set)
	require.Contains(t, logs.String(), "user_overrides.7.connectors[0].command")
	r := d.Resolve(nil, 7, "", Fallbacks{})
	require.Equal(t, []ConnectorRule{{Name: "fs", Command: "npx", Args: []string{"-y", "pkg"}}}, r.Connectors)
}

func TestValidateDocumentLimits(t *testing.T) {
	d := defaultDocument()
	normalizeDocument(&d)
	for i := 1; i <= maxGroupOverrides+1; i++ {
		d.GroupOverrides[overrideKey(int64(i))] = Patch{}
	}
	err := validateDocument(&d)
	require.Error(t, err)
	require.Contains(t, err.Error(), RuleTooMany)

	d = defaultDocument()
	normalizeDocument(&d)
	d.UserOverrides["abc"] = Patch{}
	require.ErrorContains(t, validateDocument(&d), RuleInvalidID)
}

func TestRuleMessagesCoverEveryRule(t *testing.T) {
	for _, rule := range []string{RuleInvalidJSON, RuleInvalidType, RuleUnknownField, RuleDuplicateField, RuleRequired, RuleBypass,
		RuleUnknownMode, RuleEmptyModeList, RuleUnknownPlatform, RuleHTTPSRequired, RuleTooMany, RuleTooLong, RuleOutOfRange,
		RuleInvalidName, RuleUnknownType, RuleInvalidDomain, RuleInvalidID, RuleDuplicateID, RuleTooLarge, RuleNotFound,
		RuleInvalidModel, RuleInvalidApp} {
		require.NotEmpty(t, ruleMessages[rule], rule)
	}
}
