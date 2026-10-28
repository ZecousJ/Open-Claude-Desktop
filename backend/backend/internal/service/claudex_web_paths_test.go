package service

// CLAUDEX: W-PATHS every front-end page path the server emits must land in the
// console (/admin/...) or on a console page kept at the site root, never in the
// web app zone (it would render the React app) or on a legacy path (it would
// depend on the Go 302).

import (
	"context"
	"net/url"
	"strings"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/web/sitepaths"
	"github.com/stretchr/testify/require"
)

func requireClaudexConsolePath(t *testing.T, source, emitted string) {
	t.Helper()
	u, err := url.Parse(emitted)
	require.NoError(t, err, source)
	zone := sitepaths.Classify(u.Path, u.RawQuery)
	require.Truef(t, zone == sitepaths.ZoneConsole || zone == sitepaths.ZoneConsoleRoot,
		"%s emits %q, classified %s; want console or console-root", source, emitted, zone)
}

func TestClaudexServerEmittedFrontendPathsStayInConsole(t *testing.T) {
	cases := []struct {
		source string
		path   string
	}{
		// Constants of this package.
		{"service.ClaudexPurchaseReturnPath", ClaudexPurchaseReturnPath},
		{"service.ClaudexDefaultLoginRedirectPath", ClaudexDefaultLoginRedirectPath},
		{"service.paymentResultReturnPath", paymentResultReturnPath},
		{"service.defaultWeChatConnectFrontend", defaultWeChatConnectFrontend},
		{"service.defaultGitHubOAuthFrontend", defaultGitHubOAuthFrontend},
		{"service.defaultGoogleOAuthFrontend", defaultGoogleOAuthFrontend},
		{"service.setting_parse OIDC frontend default", "/auth/oidc/callback"},

		// Handler constants (handler imports service, so they are mirrored here;
		// internal/handler/claudex_web_paths_test.go checks the real constants).
		{"handler.wechatOAuthDefaultFrontendCB", "/auth/wechat/callback"},
		{"handler.wechatPaymentOAuthFrontendCB", "/auth/wechat/payment/callback"},
		{"handler.linuxDoOAuthDefaultFrontendCB", "/auth/linuxdo/callback"},
		{"handler.oidcOAuthDefaultFrontendCB", "/auth/oidc/callback"},
		{"handler.dingTalkOAuthDefaultFrontendCB", "/auth/dingtalk/callback"},
		{"handler.auth_email_oauth frontend callback", "/auth/oauth/callback"},
		{"handler/admin.gemini_oauth_handler callback", "/auth/callback"},

		// Other packages.
		{"payment/provider.wxpayResultPath", "/payment/result"},
		{"claudex/payment.resultPath", "/payment/result"},
		{"claudex/payment desktop checkout", "/desktop-pay"},
		{"claudex/sharing usage policy fallback", "/legal/usage-policy"},
		{"config linuxdo frontend default", "/auth/linuxdo/callback"},
		{"config oidc frontend default", "/auth/oidc/callback"},
		{"config dingtalk frontend default", "/auth/dingtalk/callback"},
	}
	for _, tc := range cases {
		requireClaudexConsolePath(t, tc.source, tc.path)
	}
	// The emailed password reset link is the web app's page (2026-10-02):
	// Claudex's own new-password step, not the console's.
	require.Equal(t, sitepaths.ZoneApp, sitepaths.Classify("/reset-password", "email=a%40b.c&token=t"))
}

func TestClaudexPaymentReturnPathMapsLegacyValues(t *testing.T) {
	cases := map[string]string{
		"":                                   "/admin/my/purchase",
		"/payment":                           "/admin/my/purchase",
		"/payment?from=wechat":               "/admin/my/purchase?from=wechat",
		"/purchase":                          "/admin/my/purchase",
		"/purchase?from=wechat":              "/admin/my/purchase?from=wechat",
		"/subscriptions":                     "/admin/my/subscriptions",
		"/admin/my/purchase?tab=plans":       "/admin/my/purchase?tab=plans",
		"https://pay.example.com/purchase?x": "/admin/my/purchase?x",
		"https://pay.example.com/payment":    "/admin/my/purchase",
		"https://pay.example.com/":           "/",
		"not a url\x7f":                      "/admin/my/purchase",
	}
	for in, want := range cases {
		got := paymentRedirectPathFromURL(in)
		require.Equalf(t, want, got, "paymentRedirectPathFromURL(%q)", in)
		if strings.HasPrefix(want, "/admin") {
			requireClaudexConsolePath(t, "paymentRedirectPathFromURL("+in+")", got)
		}
	}
	require.Equal(t, "/admin/my/purchase?from=wechat", normalizePaymentRedirectPath(" /purchase?from=wechat "))
}

func TestClaudexResolveLegacyPagePath(t *testing.T) {
	cases := map[string]string{
		"/purchase":              "/admin/my/purchase",
		"/purchase?a=1#frag":     "/admin/my/purchase?a=1#frag",
		"/dashboard":             "/admin/my/dashboard",
		"/custom/abc":            "/admin/my/custom/abc",
		"/login?redirect=/admin": "/admin/login?redirect=/admin",
		"/login":                 "/login",
		"/payment/result":        "/payment/result",
		"/chat/1":                "/chat/1",
		"//evil.example/keys":    "//evil.example/keys",
		"relative":               "relative",
	}
	for in, want := range cases {
		require.Equalf(t, want, ClaudexResolveLegacyPagePath(in), "ClaudexResolveLegacyPagePath(%q)", in)
	}
	// Every legacy redirect target resolves into the console.
	for from := range sitepaths.Current().LegacyRedirects.Exact {
		requireClaudexConsolePath(t, "legacy "+from, ClaudexResolveLegacyPagePath(from))
	}
}

func TestClaudexNotificationEmailRewritesLegacyLinks(t *testing.T) {
	ctx := context.Background()
	repo := newNotificationEmailMemorySettingRepo()
	require.NoError(t, repo.Set(ctx, SettingKeyFrontendURL, "https://claudex.example.com"))
	svc := NewNotificationEmailService(repo, nil)

	cases := map[string]string{
		"/purchase": "/admin/my/purchase",
		"https://claudex.example.com/purchase?tab=b":         "https://claudex.example.com/admin/my/purchase?tab=b",
		"https://claudex.example.com/usage":                  "https://claudex.example.com/admin/my/usage",
		"https://claudex.example.com/settings/billing":       "https://claudex.example.com/settings/billing",
		"https://other.example.com/purchase":                 "https://other.example.com/purchase",
		"https://claudex.example.com/reset-password?token=x": "https://claudex.example.com/reset-password?token=x",
	}
	for in, want := range cases {
		vars := svc.runtimeVariables(ctx, NotificationEmailEventBalanceLow, "en", NotificationEmailSendInput{
			Event:          NotificationEmailEventBalanceLow,
			RecipientEmail: "user@example.com",
			Variables:      map[string]string{"recharge_url": in},
		})
		require.Equalf(t, want, vars["recharge_url"], "recharge_url %q", in)
		if strings.Contains(want, "/admin/") {
			u, err := url.Parse(want)
			require.NoError(t, err)
			requireClaudexConsolePath(t, "recharge_url "+in, u.RequestURI())
		}
	}
}
