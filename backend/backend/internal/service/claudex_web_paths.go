package service

// CLAUDEX: W-PATHS front-end page paths the server emits (web plan W-SRV
// section 3). The Vue console now lives under /admin and its user pages under
// /admin/my/*; the site root belongs to the web app. The layout is defined by
// internal/web/sitepaths (reserved_paths.json); every path here must classify
// as ZoneConsole or ZoneConsoleRoot (claudex_web_paths_test.go).

import (
	"net/url"
	"strings"

	"github.com/Wei-Shaw/sub2api/internal/web/sitepaths"
)

const (
	// ClaudexPurchaseReturnPath is where the WeChat in-app payment OAuth flow
	// resumes (upstream "/purchase"). It moves to the web app billing page once
	// that page ships (PLAN Q8).
	ClaudexPurchaseReturnPath = "/admin/my/purchase"
	// ClaudexDefaultLoginRedirectPath is the default page after a third-party
	// OAuth sign-in when the frontend passed no redirect (upstream "/dashboard").
	ClaudexDefaultLoginRedirectPath = "/admin/my/dashboard"
)

// ClaudexResolveLegacyPagePath maps an old root console page path (with an
// optional ?query and #fragment) to its final /admin location, so stored
// values such as "/purchase?from=wechat" keep working without relying on the
// Go 302. Paths that are not legacy console pages are returned unchanged.
func ClaudexResolveLegacyPagePath(path string) string {
	if !strings.HasPrefix(path, "/") || strings.HasPrefix(path, "//") {
		return path
	}
	rest, fragment, hasFragment := strings.Cut(path, "#")
	pathOnly, rawQuery, _ := strings.Cut(rest, "?")
	target, ok := sitepaths.LegacyRedirect(pathOnly, rawQuery)
	if !ok {
		return path
	}
	if hasFragment {
		target += "#" + fragment
	}
	return target
}

// claudexResolveLegacyPageURL does the same for an absolute URL, but only when
// its host is one of this site's hosts (a link to another site is left alone).
// Relative paths are handled by ClaudexResolveLegacyPagePath.
func claudexResolveLegacyPageURL(raw string, siteHosts []string) string {
	trimmed := strings.TrimSpace(raw)
	if strings.HasPrefix(trimmed, "/") {
		return ClaudexResolveLegacyPagePath(trimmed)
	}
	u, err := url.Parse(trimmed)
	if err != nil || u.Host == "" {
		return raw
	}
	if scheme := strings.ToLower(u.Scheme); scheme != "http" && scheme != "https" {
		return raw
	}
	sameSite := false
	for _, host := range siteHosts {
		if host != "" && strings.EqualFold(host, u.Host) {
			sameSite = true
			break
		}
	}
	if !sameSite {
		return raw
	}
	target, ok := sitepaths.LegacyRedirect(u.Path, u.RawQuery)
	if !ok {
		return raw
	}
	path, rawQuery, _ := strings.Cut(target, "?")
	u.Path = path
	u.RawPath = ""
	u.RawQuery = rawQuery
	return u.String()
}
