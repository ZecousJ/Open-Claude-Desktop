package sitepaths

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestClassify(t *testing.T) {
	cases := []struct {
		path, query string
		want        Zone
	}{
		{"/api/v1/auth/login", "", ZoneBypass},
		{"/v1/responses", "", ZoneBypass},
		{"/v1beta/models", "", ZoneBypass},
		{"/backend-api/codex", "", ZoneBypass},
		{"/antigravity/x", "", ZoneBypass},
		{"/setup/status", "", ZoneBypass},
		{"/health", "", ZoneBypass},
		{"/models", "", ZoneBypass},
		{"/responses", "", ZoneBypass},
		{"/responses/abc", "", ZoneBypass},
		{"/alpha/search", "", ZoneBypass},
		{"/images/generations", "", ZoneBypass},
		{"/videos/x", "", ZoneBypass},
		{"/s/abc", "", ZoneBypass},

		{"/admin", "", ZoneConsole},
		{"/admin/", "", ZoneConsole},
		{"/admin/users", "", ZoneConsole},
		{"/admin/assets/index-abcdef12.js", "", ZoneConsole},
		{"/administrator", "", ZoneApp},

		{"/desktop-pay", "", ZoneConsoleRoot},
		{"/desktop-only", "", ZoneConsoleRoot},
		{"/payment/result", "", ZoneConsoleRoot},
		{"/reset-password", "token=x", ZoneApp},
		{"/forgot-password", "", ZoneApp},
		{"/legal/terms", "", ZoneConsoleRoot},
		{"/legal/", "", ZoneApp},
		{"/auth/callback", "", ZoneConsoleRoot},
		{"/auth/oauth/callback", "", ZoneConsoleRoot},
		{"/auth/oidc/callback", "", ZoneConsoleRoot},
		{"/auth/linuxdo/callback", "", ZoneConsoleRoot},
		{"/auth/wechat/callback", "", ZoneConsoleRoot},
		{"/auth/dingtalk/callback", "", ZoneConsoleRoot},
		{"/auth/wechat/payment/callback", "", ZoneConsoleRoot},
		{"/auth/dingtalk/email-completion", "", ZoneConsoleRoot},

		{"/dashboard", "", ZoneLegacy},
		{"/setup", "", ZoneLegacy},
		{"/custom/7", "", ZoneLegacy},
		{"/custom/", "", ZoneApp},
		{"/login", "redirect=/admin/users", ZoneLegacy},
		{"/login", "redirect=/admin", ZoneLegacy},
		{"/login", "redirect=/administrator", ZoneApp},
		{"/login", "redirect=/chat/1", ZoneApp},
		{"/login", "", ZoneApp},
		{"/register", "", ZoneApp},

		{"/", "", ZoneApp},
		{"/new", "", ZoneApp},
		{"/chat/1", "", ZoneApp},
		{"/code", "", ZoneApp},
		{"/assets/app-12345678.js", "", ZoneApp},
		{"/settings/profile", "", ZoneApp},
		{"/unknown/path", "", ZoneApp},
	}
	for _, tc := range cases {
		if got := Classify(tc.path, tc.query); got != tc.want {
			t.Errorf("Classify(%q, %q) = %s, want %s", tc.path, tc.query, got, tc.want)
		}
	}
}

func TestLegacyRedirect(t *testing.T) {
	cases := []struct {
		path, query, want string
		ok                bool
	}{
		{"/setup", "", "/admin/setup", true},
		{"/home", "", "/admin/home", true},
		{"/dashboard", "", "/admin/my/dashboard", true},
		{"/keys", "page=2", "/admin/my/keys?page=2", true},
		{"/purchase", "", "/admin/my/purchase", true},
		{"/custom/42", "", "/admin/my/custom/42", true},
		{"/model-plaza", "", "/admin/model-plaza", true},
		{"/key-usage", "k=1", "/admin/key-usage?k=1", true},
		{"/email-verify", "", "/admin/email-verify", true},
		{"/payment/qrcode", "o=1", "/admin/payment/qrcode?o=1", true},
		{"/payment/stripe", "", "/admin/payment/stripe", true},
		{"/payment/stripe-popup", "", "/admin/payment/stripe-popup", true},
		{"/payment/airwallex", "", "/admin/payment/airwallex", true},
		{"/login", "redirect=%2Fadmin%2Fusers", "/admin/login?redirect=%2Fadmin%2Fusers", true},
		{"/login", "redirect=/admin/users&x=1", "/admin/login?redirect=/admin/users&x=1", true},
		{"/login", "redirect=/chat", "", false},
		{"/login", "", "", false},
		{"/payment/result", "", "", false},
		{"/", "", "", false},
	}
	for _, tc := range cases {
		got, ok := LegacyRedirect(tc.path, tc.query)
		if got != tc.want || ok != tc.ok {
			t.Errorf("LegacyRedirect(%q, %q) = %q, %v; want %q, %v", tc.path, tc.query, got, ok, tc.want, tc.ok)
		}
	}
}

func TestConsoleSubpath(t *testing.T) {
	cases := map[string]string{
		"/admin":                "/",
		"/admin/":               "/",
		"/admin/users":          "/users",
		"/admin/assets/a-1.css": "/assets/a-1.css",
	}
	for in, want := range cases {
		got, ok := ConsoleSubpath(in)
		if !ok || got != want {
			t.Errorf("ConsoleSubpath(%q) = %q, %v; want %q", in, got, ok, want)
		}
	}
	if _, ok := ConsoleSubpath("/adminx"); ok {
		t.Error("ConsoleSubpath(/adminx) should not match")
	}
}

// The layout must stay self-consistent: zones never overlap and every legacy
// target lives under the console.
func TestLayoutConsistency(t *testing.T) {
	l := Current()
	if l.Version < 1 {
		t.Fatalf("version = %d", l.Version)
	}
	for _, p := range append(append([]string{}, l.ConsoleRootPages.Exact...), l.ConsoleRootPages.Prefixes...) {
		if !strings.HasPrefix(p, "/") {
			t.Errorf("console root page %q must start with /", p)
		}
		if IsBypass(p) || IsConsole(p) {
			t.Errorf("console root page %q overlaps another zone", p)
		}
		if _, ok := l.LegacyRedirects.Exact[p]; ok {
			t.Errorf("console root page %q is also a legacy redirect", p)
		}
	}
	check := func(from, to string) {
		if IsBypass(from) || IsConsole(from) || IsConsoleRootPage(from) {
			t.Errorf("legacy path %q overlaps another zone", from)
		}
		if !IsConsole(to) {
			t.Errorf("legacy target %q for %q is outside %s", to, from, ConsoleBase())
		}
	}
	for from, to := range l.LegacyRedirects.Exact {
		check(from, to)
	}
	for from, to := range l.LegacyRedirects.Prefixes {
		if !strings.HasSuffix(from, "/") || !strings.HasSuffix(to, "/") {
			t.Errorf("legacy prefix %q -> %q must end with /", from, to)
		}
		check(from+"x", to+"x")
	}
	for _, reserved := range []string{"/login", "/register", "/"} {
		if _, ok := l.LegacyRedirects.Exact[reserved]; ok {
			t.Errorf("%q belongs to the web app and must not be a legacy redirect", reserved)
		}
	}
	lr := l.AdminLoginRedirect
	if lr.From != "/login" || !IsConsole(lr.To) || lr.RedirectParam == "" || lr.RedirectPrefix != ConsoleBase() {
		t.Errorf("admin_login_redirect = %+v", lr)
	}
}

func TestReservedPathsJSONIsCopied(t *testing.T) {
	raw := ReservedPathsJSON()
	var probe map[string]any
	if err := json.Unmarshal(raw, &probe); err != nil {
		t.Fatal(err)
	}
	raw[0] = 'x'
	if ReservedPathsJSON()[0] == 'x' {
		t.Fatal("ReservedPathsJSON must return a copy")
	}
}
