package handler

// CLAUDEX: W-PATHS the OAuth handlers' front-end page constants must land in
// the console (/admin/...) or on a console page kept at the site root.

import (
	"net/url"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/web/sitepaths"
	"github.com/stretchr/testify/require"
)

func TestClaudexHandlerFrontendPathsStayInConsole(t *testing.T) {
	cases := map[string]string{
		"wechatOAuthDefaultRedirectTo":                      wechatOAuthDefaultRedirectTo,
		"wechatOAuthDefaultFrontendCB":                      wechatOAuthDefaultFrontendCB,
		"wechatPaymentOAuthDefaultTo":                       wechatPaymentOAuthDefaultTo,
		"wechatPaymentOAuthFrontendCB":                      wechatPaymentOAuthFrontendCB,
		"linuxDoOAuthDefaultRedirectTo":                     linuxDoOAuthDefaultRedirectTo,
		"linuxDoOAuthDefaultFrontendCB":                     linuxDoOAuthDefaultFrontendCB,
		"oidcOAuthDefaultRedirectTo":                        oidcOAuthDefaultRedirectTo,
		"oidcOAuthDefaultFrontendCB":                        oidcOAuthDefaultFrontendCB,
		"dingTalkOAuthDefaultRedirectTo":                    dingTalkOAuthDefaultRedirectTo,
		"dingTalkOAuthDefaultFrontendCB":                    dingTalkOAuthDefaultFrontendCB,
		"emailOAuthDefaultRedirect":                         emailOAuthDefaultRedirect,
		"normalizeWeChatPaymentRedirectPath(\"\")":          normalizeWeChatPaymentRedirectPath(""),
		"normalizeWeChatPaymentRedirectPath(\"/payment\")":  normalizeWeChatPaymentRedirectPath("/payment"),
		"normalizeWeChatPaymentRedirectPath(\"/purchase\")": normalizeWeChatPaymentRedirectPath("/purchase?from=wechat"),
	}
	for name, emitted := range cases {
		u, err := url.Parse(emitted)
		require.NoError(t, err, name)
		zone := sitepaths.Classify(u.Path, u.RawQuery)
		require.Truef(t, zone == sitepaths.ZoneConsole || zone == sitepaths.ZoneConsoleRoot,
			"%s = %q, classified %s; want console or console-root", name, emitted, zone)
	}
	require.Equal(t, "/admin/my/purchase?from=wechat", normalizeWeChatPaymentRedirectPath("/purchase?from=wechat"))
	require.Equal(t, "/admin/my/purchase?x=1", normalizeWeChatPaymentRedirectPath("/payment?x=1"))
}
