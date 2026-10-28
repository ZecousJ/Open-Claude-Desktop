package web

// CLAUDEX: W-SITE SiteServer replaces the single FrontendServer.Middleware:
// it dispatches every non-API path between the Vue console (/admin and a few
// public pages at the root), 302s for the old console paths and the web app
// SPA that owns the rest of the site (web plan W-SRV 1.1-1.3; the path table
// is sitepaths/reserved_paths.json).

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/web/sitepaths"
	"github.com/gin-gonic/gin"
)

// PublicSettingsProvider is an interface to fetch public settings
type PublicSettingsProvider interface {
	GetPublicSettingsForInjection(ctx context.Context) (any, error)
}

// WebAppConfigProvider backs the web app zone: its on/off switch and the
// public config injected as window.__CLAUDEX_WEB__ (only what the pages need
// before sign-in). The claudex/web component implements it; WebAppEnabled is
// called for every web app request and must be cheap (cached).
type WebAppConfigProvider interface {
	WebAppEnabled(ctx context.Context) bool
	WebAppPublicConfig(ctx context.Context) (any, error)
}

// SiteOptions configures a SiteServer.
type SiteOptions struct {
	// Settings fills window.__APP_CONFIG__ in the console index. nil serves
	// the console index as built (setup wizard).
	Settings PublicSettingsProvider
	// WebApp is the web app switch and public config. nil keeps the web app
	// on and injects {}.
	WebApp WebAppConfigProvider
	// AppDir is a directory with a web app build (index.html, assets/) that
	// replaces the embedded dist/app (config claudex.web.app_dir, env
	// CLAUDEX_WEB_APP_DIR), so the web app can be updated without a new
	// server binary.
	AppDir string
	// SetupMode is the first-run setup wizard: "/" goes to /admin/setup and
	// the web app is off.
	SetupMode bool
}

const (
	siteSettingsTimeout = 2 * time.Second
	siteEnabledTimeout  = time.Second
	setupPath           = "/admin/setup"
	consoleHome         = "/admin/"
	indexFile           = "index.html"
)

// ErrNoFrontend is returned by NewSiteServer when neither the console nor the
// web app is available (a build without -tags embed and no app dir).
var ErrNoFrontend = errors.New("no frontend: build with -tags embed or set claudex.web.app_dir")

// spaZone is one single-page app: its files, its index.html template and the
// rendered index cache.
type spaZone struct {
	name        string
	files       fs.FS
	baseHTML    []byte
	cache       *HTMLCache
	overrideDir string // local files that take precedence over files

	// diskIndex is the index.html of an app directory build: a new build
	// swapped into the directory is served without a restart (owner,
	// 2026-10-03: each web deploy restarted the server). Read again at most
	// every indexRecheck.
	diskIndex string
	indexMu   sync.Mutex
	checkedAt time.Time
}

// indexRecheck is how often a disk index.html is read again.
const indexRecheck = 2 * time.Second

// base is the zone's index.html template, read again from disk when it
// changed.
func (z *spaZone) base() []byte {
	z.indexMu.Lock()
	defer z.indexMu.Unlock()
	if z.diskIndex == "" || time.Since(z.checkedAt) < indexRecheck {
		return z.baseHTML
	}
	z.checkedAt = time.Now()
	data, err := os.ReadFile(z.diskIndex)
	if err != nil || len(data) == 0 || bytes.Equal(data, z.baseHTML) {
		return z.baseHTML
	}
	z.baseHTML = data
	z.cache.SetBaseHTML(data)
	z.cache.Invalidate()
	return z.baseHTML
}

func newSPAZone(name string, files fs.FS, overrideDir string) (*spaZone, error) {
	if files == nil {
		return nil, nil
	}
	baseHTML, err := fs.ReadFile(files, indexFile)
	if err != nil {
		return nil, err
	}
	cache := NewHTMLCache()
	cache.SetBaseHTML(baseHTML)
	return &spaZone{name: name, files: files, baseHTML: baseHTML, cache: cache, overrideDir: overrideDir}, nil
}

// SiteServer serves the console and the web app.
type SiteServer struct {
	opts    SiteOptions
	console *spaZone
	app     *spaZone
}

// NewSiteServer builds the site from the embedded builds (dist/admin,
// dist/app) and opts.AppDir. The console override directory is data/public/admin,
// the web app's is data/public (favicon, robots.txt).
func NewSiteServer(opts SiteOptions) (*SiteServer, error) {
	consoleFS, appFS := embeddedSiteFS()
	appIndex := ""
	if dir := strings.TrimSpace(opts.AppDir); dir != "" {
		if info, err := os.Stat(filepath.Join(dir, indexFile)); err == nil && !info.IsDir() {
			appFS = os.DirFS(dir)
			appIndex = filepath.Join(dir, indexFile)
		} else {
			log.Printf("Warning: claudex.web.app_dir %q has no index.html, using the embedded web app", dir)
		}
	}
	publicDir := filepath.Join("data", "public")
	site, err := newSiteServer(opts, consoleFS, appFS, filepath.Join(publicDir, "admin"), publicDir)
	if err == nil && site.app != nil {
		site.app.diskIndex = appIndex
		site.app.checkedAt = time.Now()
	}
	return site, err
}

func newSiteServer(opts SiteOptions, consoleFS, appFS fs.FS, consoleOverride, appOverride string) (*SiteServer, error) {
	console, err := newSPAZone("console", consoleFS, consoleOverride)
	if err != nil {
		return nil, err
	}
	var app *spaZone
	if !opts.SetupMode {
		if app, err = newSPAZone("app", appFS, appOverride); err != nil {
			return nil, err
		}
	}
	if console == nil && app == nil {
		return nil, ErrNoFrontend
	}
	return &SiteServer{opts: opts, console: console, app: app}, nil
}

// HasConsole and HasWebApp report which SPAs this server has.
func (s *SiteServer) HasConsole() bool { return s != nil && s.console != nil }
func (s *SiteServer) HasWebApp() bool  { return s != nil && s.app != nil }

// InvalidateCache drops both rendered index pages (call when settings change).
func (s *SiteServer) InvalidateCache() {
	if s == nil {
		return
	}
	for _, z := range []*spaZone{s.console, s.app} {
		if z != nil && z.cache != nil {
			z.cache.Invalidate()
		}
	}
}

// Middleware dispatches a request (W-SRV 1.2):
//  1. Go routes (API, gateway, /s share pages) go on to the router;
//  2. /admin/... is the console (file, or the console index);
//  3. console public pages at the root get the console index;
//  4. old console paths answer 302 to /admin/... (query kept);
//  5. everything else is the web app (file, or the web app index);
//  6. without a web app (or switched off) "/" answers 302 to /admin/ and
//     other paths a plain 404.
//
// Only GET and HEAD are served; other methods go on to the router.
func (s *SiteServer) Middleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		reqPath := strings.TrimSpace(c.Request.URL.Path)
		if sitepaths.IsBypass(reqPath) || (c.Request.Method != http.MethodGet && c.Request.Method != http.MethodHead) {
			c.Next()
			return
		}
		switch sitepaths.Classify(reqPath, c.Request.URL.RawQuery) {
		case sitepaths.ZoneConsole:
			sub, _ := sitepaths.ConsoleSubpath(reqPath)
			s.serveZone(c, s.console, sub)
		case sitepaths.ZoneConsoleRoot:
			s.serveIndex(c, s.console)
		case sitepaths.ZoneLegacy:
			target, _ := sitepaths.LegacyRedirect(reqPath, c.Request.URL.RawQuery)
			c.Redirect(http.StatusFound, target)
			c.Abort()
		default:
			s.serveApp(c, reqPath)
		}
	}
}

func (s *SiteServer) serveApp(c *gin.Context, reqPath string) {
	if s.opts.SetupMode {
		if reqPath == "/" {
			c.Redirect(http.StatusFound, setupPath)
			c.Abort()
			return
		}
		notFound(c)
		return
	}
	if s.app == nil || !s.webAppEnabled(c) {
		if reqPath == "/" && s.console != nil {
			c.Redirect(http.StatusFound, consoleHome)
			c.Abort()
			return
		}
		notFound(c)
		return
	}
	s.serveZone(c, s.app, reqPath)
}

func (s *SiteServer) webAppEnabled(c *gin.Context) bool {
	if s.opts.WebApp == nil {
		return true
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), siteEnabledTimeout)
	defer cancel()
	return s.opts.WebApp.WebAppEnabled(ctx)
}

// serveZone serves reqPath (relative to the zone root) from z: a local
// override file, else an embedded file, else the zone's index. A missing file
// under assets/ is a 404 instead of the index, so a stale chunk URL fails
// cleanly rather than loading HTML as a script.
func (s *SiteServer) serveZone(c *gin.Context, z *spaZone, reqPath string) {
	if z == nil {
		notFound(c)
		return
	}
	cleanPath := strings.TrimPrefix(path.Clean("/"+reqPath), "/")
	if cleanPath == "" || cleanPath == indexFile {
		s.serveIndex(c, z)
		return
	}
	if tryServeOverrideFile(c, z.overrideDir, cleanPath) {
		return
	}
	if serveFSFile(c, z.files, cleanPath) {
		return
	}
	if strings.HasPrefix(cleanPath, "assets/") {
		notFound(c)
		return
	}
	s.serveIndex(c, z)
}

// serveIndex answers the zone's index.html with its config script (nonce
// from SecurityHeaders), cached per zone with an ETag.
func (s *SiteServer) serveIndex(c *gin.Context, z *spaZone) {
	if z == nil {
		notFound(c)
		return
	}
	nonce := middleware.GetNonceFromContext(c)
	z.base() // a new build on disk drops the rendered page
	cached := z.cache.Get()
	if cached == nil {
		rendered, configJSON, ok := s.render(c, z)
		if !ok {
			// Serve without caching; the next request tries the settings again.
			c.Header("Cache-Control", "no-cache")
			c.Data(http.StatusOK, "text/html; charset=utf-8", replaceNoncePlaceholder(rendered, nonce))
			c.Abort()
			return
		}
		z.cache.Set(rendered, configJSON)
		cached = &CachedHTML{Content: rendered}
		if fresh := z.cache.Get(); fresh != nil {
			cached = fresh
		}
	}
	if cached.ETag != "" && c.GetHeader("If-None-Match") == cached.ETag {
		c.Status(http.StatusNotModified)
		c.Abort()
		return
	}
	if cached.ETag != "" {
		c.Header("ETag", cached.ETag)
	}
	c.Header("Cache-Control", "no-cache") // Must revalidate
	c.Data(http.StatusOK, "text/html; charset=utf-8", replaceNoncePlaceholder(cached.Content, nonce))
	c.Abort()
}

// render builds a zone's index. ok is false when the config could not be
// read; the page is then served uncached (the console as built, the web app
// with an empty config).
func (s *SiteServer) render(c *gin.Context, z *spaZone) (html, configJSON []byte, ok bool) {
	ctx, cancel := context.WithTimeout(c.Request.Context(), siteSettingsTimeout)
	defer cancel()
	if z == s.app {
		configJSON = []byte("{}")
		ok = true
		if s.opts.WebApp != nil {
			ok = false
			if cfg, err := s.opts.WebApp.WebAppPublicConfig(ctx); err == nil {
				if data, err := json.Marshal(cfg); err == nil && !bytes.Equal(data, []byte("null")) {
					configJSON, ok = data, true
				}
			}
		}
		return renderAppIndex(z.base(), configJSON), configJSON, ok
	}
	if s.opts.Settings == nil {
		return z.baseHTML, []byte("{}"), true
	}
	settings, err := s.opts.Settings.GetPublicSettingsForInjection(ctx)
	if err != nil {
		return z.baseHTML, nil, false
	}
	settingsJSON, err := json.Marshal(settings)
	if err != nil {
		return z.baseHTML, nil, false
	}
	return renderConsoleIndex(z.baseHTML, settingsJSON), settingsJSON, true
}

// serveFSFile serves a regular file from fsys; false when there is none.
// Fingerprinted assets get the long-lived immutable Cache-Control.
func serveFSFile(c *gin.Context, fsys fs.FS, cleanPath string) bool {
	if fsys == nil || !fs.ValidPath(cleanPath) {
		return false
	}
	file, err := fsys.Open(cleanPath)
	if err != nil {
		return false
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil || info.IsDir() {
		return false
	}
	content, ok := file.(io.ReadSeeker)
	if !ok {
		data, err := io.ReadAll(file)
		if err != nil {
			return false
		}
		content = bytes.NewReader(data)
	}
	applyStaticAssetCacheHeaders(c.Writer.Header(), cleanPath)
	http.ServeContent(c.Writer, c.Request, path.Base(cleanPath), info.ModTime(), content)
	c.Abort()
	return true
}

// tryServeOverrideFile serves overrideDir/cleanPath when it is a regular
// file. Override files never get the immutable cache headers.
func tryServeOverrideFile(c *gin.Context, overrideDir, cleanPath string) bool {
	if overrideDir == "" {
		return false
	}
	filePath := filepath.Join(overrideDir, filepath.Clean("/"+cleanPath))
	info, err := os.Stat(filePath)
	if err != nil || info.IsDir() {
		return false
	}
	c.File(filePath)
	c.Abort()
	return true
}

func notFound(c *gin.Context) {
	c.String(http.StatusNotFound, "404 page not found")
	c.Abort()
}

// shouldBypassEmbeddedFrontend reports whether path is a Go route (the list
// lives in sitepaths/reserved_paths.json).
func shouldBypassEmbeddedFrontend(path string) bool {
	return sitepaths.IsBypass(strings.TrimSpace(path))
}

// ServeEmbeddedFrontend returns a middleware for serving the embedded site
// without settings injection (legacy; tests and callers without a settings
// service). Without an embedded frontend it answers 404.
func ServeEmbeddedFrontend() gin.HandlerFunc {
	site, err := NewSiteServer(SiteOptions{})
	if err != nil {
		return func(c *gin.Context) {
			if shouldBypassEmbeddedFrontend(c.Request.URL.Path) {
				c.Next()
				return
			}
			c.String(http.StatusNotFound, "Frontend not embedded. Build with -tags embed to include frontend.")
			c.Abort()
		}
	}
	return site.Middleware()
}
