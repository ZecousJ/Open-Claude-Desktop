//go:build embed

package web

// CLAUDEX: W-SITE the embedded site has two builds: dist/admin (the Vue
// console, Vite base /admin/) and dist/app (the web app). The serving code
// moved to site.go (SiteServer) and render.go; FrontendServer is gone.

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var frontendFS embed.FS

const (
	embeddedConsoleDir = "dist/admin"
	embeddedAppDir     = "dist/app"
)

// embeddedSiteFS returns the embedded console and web app builds, nil for a
// build that is not there.
func embeddedSiteFS() (console, app fs.FS) {
	return embeddedSub(embeddedConsoleDir), embeddedSub(embeddedAppDir)
}

func embeddedSub(dir string) fs.FS {
	if _, err := frontendFS.ReadFile(dir + "/" + indexFile); err != nil {
		return nil
	}
	sub, err := fs.Sub(frontendFS, dir)
	if err != nil {
		return nil
	}
	return sub
}

// HasEmbeddedFrontend reports whether the console build is embedded.
func HasEmbeddedFrontend() bool {
	_, err := frontendFS.ReadFile(embeddedConsoleDir + "/" + indexFile)
	return err == nil
}

// HasEmbeddedWebApp reports whether the web app build is embedded.
func HasEmbeddedWebApp() bool {
	_, err := frontendFS.ReadFile(embeddedAppDir + "/" + indexFile)
	return err == nil
}
