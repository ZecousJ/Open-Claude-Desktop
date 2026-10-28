//go:build !embed

// Package web provides embedded web assets for the application.
package web

// CLAUDEX: W-SITE without -tags embed there is no embedded console or web
// app; SiteServer (site.go) can still serve a web app from
// claudex.web.app_dir. FrontendServer is gone (see embed_on.go).

import "io/fs"

func embeddedSiteFS() (console, app fs.FS) { return nil, nil }

// HasEmbeddedFrontend reports whether the console build is embedded.
func HasEmbeddedFrontend() bool {
	return false
}

// HasEmbeddedWebApp reports whether the web app build is embedded.
func HasEmbeddedWebApp() bool { return false }
