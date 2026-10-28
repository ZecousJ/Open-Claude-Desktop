// Package sitepaths classifies request paths into the site zones of the
// Claudex URL layout (web plan W-SRV 1.1): Go routes, the Vue console under
// /admin, the console's public pages at the root, legacy console paths that
// 302 to /admin, and the web app that owns everything else.
//
// The layout lives in reserved_paths.json, the single source of truth shared
// by the Go dispatcher (internal/web), the security headers middleware and the
// web app route tests. This package has no build tags and imports nothing from
// the server so both internal/web and internal/server/middleware can use it.
package sitepaths

import (
	_ "embed"
	"encoding/json"
	"net/url"
	"sort"
	"strings"
)

//go:embed reserved_paths.json
var reservedPathsJSON []byte

// ReservedPathsJSON returns the raw layout file (for tests and tools).
func ReservedPathsJSON() []byte {
	out := make([]byte, len(reservedPathsJSON))
	copy(out, reservedPathsJSON)
	return out
}

// Layout is the parsed reserved_paths.json.
type Layout struct {
	Version int `json:"version"`
	Bypass  struct {
		Exact    []string `json:"exact"`
		Prefixes []string `json:"prefixes"`
	} `json:"bypass"`
	Console struct {
		Base string `json:"base"`
	} `json:"console"`
	ConsoleRootPages struct {
		Exact    []string `json:"exact"`
		Prefixes []string `json:"prefixes"`
	} `json:"console_root_pages"`
	LegacyRedirects struct {
		Exact    map[string]string `json:"exact"`
		Prefixes map[string]string `json:"prefixes"`
	} `json:"legacy_redirects"`
	AdminLoginRedirect struct {
		From           string `json:"from"`
		To             string `json:"to"`
		RedirectParam  string `json:"redirect_param"`
		RedirectPrefix string `json:"redirect_prefix"`
	} `json:"admin_login_redirect"`
}

type prefixTarget struct{ from, to string }

var (
	layout           Layout
	bypassExact      map[string]bool
	consoleRootExact map[string]bool
	legacyPrefixes   []prefixTarget // longest prefix first
)

func init() {
	if err := json.Unmarshal(reservedPathsJSON, &layout); err != nil {
		panic("sitepaths: invalid reserved_paths.json: " + err.Error())
	}
	if layout.Console.Base == "" || !strings.HasPrefix(layout.Console.Base, "/") || strings.HasSuffix(layout.Console.Base, "/") {
		panic("sitepaths: console.base must look like /admin")
	}
	bypassExact = toSet(layout.Bypass.Exact)
	consoleRootExact = toSet(layout.ConsoleRootPages.Exact)
	for from, to := range layout.LegacyRedirects.Prefixes {
		legacyPrefixes = append(legacyPrefixes, prefixTarget{from, to})
	}
	sort.Slice(legacyPrefixes, func(i, j int) bool {
		if len(legacyPrefixes[i].from) != len(legacyPrefixes[j].from) {
			return len(legacyPrefixes[i].from) > len(legacyPrefixes[j].from)
		}
		return legacyPrefixes[i].from < legacyPrefixes[j].from
	})
}

func toSet(values []string) map[string]bool {
	set := make(map[string]bool, len(values))
	for _, v := range values {
		set[v] = true
	}
	return set
}

// Current returns a copy of the parsed layout.
func Current() Layout {
	out := layout
	out.Bypass.Exact = append([]string(nil), layout.Bypass.Exact...)
	out.Bypass.Prefixes = append([]string(nil), layout.Bypass.Prefixes...)
	out.ConsoleRootPages.Exact = append([]string(nil), layout.ConsoleRootPages.Exact...)
	out.ConsoleRootPages.Prefixes = append([]string(nil), layout.ConsoleRootPages.Prefixes...)
	out.LegacyRedirects.Exact = make(map[string]string, len(layout.LegacyRedirects.Exact))
	for k, v := range layout.LegacyRedirects.Exact {
		out.LegacyRedirects.Exact[k] = v
	}
	out.LegacyRedirects.Prefixes = make(map[string]string, len(layout.LegacyRedirects.Prefixes))
	for k, v := range layout.LegacyRedirects.Prefixes {
		out.LegacyRedirects.Prefixes[k] = v
	}
	return out
}

// Zone is where a request path belongs.
type Zone int

const (
	// ZoneApp is the web app SPA (the default for every unreserved path).
	ZoneApp Zone = iota
	// ZoneBypass is a Go route (API, gateway, hosted share pages).
	ZoneBypass
	// ZoneConsole is /admin and everything below it.
	ZoneConsole
	// ZoneConsoleRoot is a console public page served at the site root.
	ZoneConsoleRoot
	// ZoneLegacy is an old console path answered with a 302 to /admin.
	ZoneLegacy
)

func (z Zone) String() string {
	switch z {
	case ZoneBypass:
		return "bypass"
	case ZoneConsole:
		return "console"
	case ZoneConsoleRoot:
		return "console-root"
	case ZoneLegacy:
		return "legacy"
	default:
		return "app"
	}
}

// ConsoleBase is the console mount point ("/admin").
func ConsoleBase() string { return layout.Console.Base }

// IsBypass reports whether path is served by Go routes and never by a SPA.
func IsBypass(path string) bool {
	if bypassExact[path] {
		return true
	}
	for _, prefix := range layout.Bypass.Prefixes {
		if strings.HasPrefix(path, prefix) {
			return true
		}
	}
	return false
}

// IsConsole reports whether path is /admin or below it.
func IsConsole(path string) bool {
	base := layout.Console.Base
	return path == base || strings.HasPrefix(path, base+"/")
}

// ConsoleSubpath strips the console base: "/admin" and "/admin/" give "/",
// "/admin/assets/x.js" gives "/assets/x.js". ok is false outside the console.
func ConsoleSubpath(path string) (string, bool) {
	if !IsConsole(path) {
		return "", false
	}
	rest := strings.TrimPrefix(path, layout.Console.Base)
	if rest == "" {
		rest = "/"
	}
	return rest, true
}

// IsConsoleRootPage reports whether path is a console public page rendered at
// the site root (/desktop-pay, OAuth callbacks, ...).
func IsConsoleRootPage(path string) bool {
	if consoleRootExact[path] {
		return true
	}
	for _, prefix := range layout.ConsoleRootPages.Prefixes {
		if strings.HasPrefix(path, prefix) && len(path) > len(prefix) {
			return true
		}
	}
	return false
}

// LegacyRedirect returns the /admin location for an old console path, with
// rawQuery kept. The caller answers 302 (never 301: a cached permanent
// redirect could not be taken back).
func LegacyRedirect(path, rawQuery string) (string, bool) {
	target, ok := legacyTarget(path, rawQuery)
	if !ok {
		return "", false
	}
	if rawQuery != "" {
		target += "?" + rawQuery
	}
	return target, true
}

func legacyTarget(path, rawQuery string) (string, bool) {
	if to, ok := layout.LegacyRedirects.Exact[path]; ok {
		return to, true
	}
	for _, p := range legacyPrefixes {
		if strings.HasPrefix(path, p.from) && len(path) > len(p.from) {
			return p.to + strings.TrimPrefix(path, p.from), true
		}
	}
	lr := layout.AdminLoginRedirect
	if path == lr.From && rawQuery != "" {
		values, err := url.ParseQuery(rawQuery)
		if err != nil {
			return "", false
		}
		redirect := values.Get(lr.RedirectParam)
		if redirect == lr.RedirectPrefix || strings.HasPrefix(redirect, lr.RedirectPrefix+"/") || strings.HasPrefix(redirect, lr.RedirectPrefix+"?") {
			return lr.To, true
		}
	}
	return "", false
}

// Classify returns the zone of a request path (rawQuery only matters for the
// /login?redirect=/admin... redirect).
func Classify(path, rawQuery string) Zone {
	switch {
	case IsBypass(path):
		return ZoneBypass
	case IsConsole(path):
		return ZoneConsole
	case IsConsoleRootPage(path):
		return ZoneConsoleRoot
	}
	if _, ok := legacyTarget(path, rawQuery); ok {
		return ZoneLegacy
	}
	return ZoneApp
}
