package viewer

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
)

// The Mermaid runtime for diagram artifacts: the unmodified complete browser
// build of mermaid 12.0.0 (dist/mermaid.min.js, which includes elkjs; see
// assets/README.md and THIRD_PARTY_NOTICES.md), stored gzip-compressed.
//
//go:embed assets/mermaid.min.js.gz assets/LICENSE.mermaid.txt
var assetFS embed.FS

const mermaidAsset = "mermaid.min.js"

type asset struct {
	gz          []byte // gzip body, or nil for a plain one
	plain       []byte
	contentType string
	etag        string
}

var (
	assetsOnce sync.Once
	assets     map[string]*asset
)

func loadAssets() map[string]*asset {
	assetsOnce.Do(func() {
		assets = map[string]*asset{}
		if gz, err := assetFS.ReadFile("assets/mermaid.min.js.gz"); err == nil {
			assets[mermaidAsset] = &asset{gz: gz, contentType: "text/javascript; charset=utf-8", etag: etagOf(gz)}
		}
		if lic, err := assetFS.ReadFile("assets/LICENSE.mermaid.txt"); err == nil {
			assets["LICENSE.mermaid.txt"] = &asset{plain: lic, contentType: "text/plain; charset=utf-8", etag: etagOf(lic)}
		}
	})
	return assets
}

func etagOf(b []byte) string {
	sum := sha256.Sum256(b)
	return `"` + hex.EncodeToString(sum[:12]) + `"`
}

func acceptsGzip(r *http.Request) bool {
	for _, part := range strings.Split(r.Header.Get("Accept-Encoding"), ",") {
		name, params, _ := strings.Cut(strings.TrimSpace(part), ";")
		if !strings.EqualFold(strings.TrimSpace(name), "gzip") {
			continue
		}
		q := 1.0
		for _, p := range strings.Split(params, ";") {
			if k, v, ok := strings.Cut(strings.TrimSpace(p), "="); ok && strings.TrimSpace(k) == "q" {
				if f, err := strconv.ParseFloat(strings.TrimSpace(v), 64); err == nil {
					q = f
				}
			}
		}
		return q > 0
	}
	return false
}

// ServeAsset answers GET /s/_assets/<name>. The runtime is public code: it
// may be cached, and cross-origin loads are allowed because the sandboxed
// artifact documents that load it have an opaque origin.
func ServeAsset(w http.ResponseWriter, r *http.Request, name string) {
	a := loadAssets()[strings.TrimPrefix(name, "/")]
	if a == nil {
		http.NotFound(w, r)
		return
	}
	h := w.Header()
	h.Del("X-Frame-Options")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("X-Robots-Tag", "noindex")
	h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	h.Set("Cross-Origin-Resource-Policy", "cross-origin")
	h.Set("Cache-Control", "public, max-age=86400")
	h.Set("Content-Type", a.contentType)
	h.Set("ETag", a.etag)
	h.Set("Vary", "Accept-Encoding")
	if match := r.Header.Get("If-None-Match"); match != "" && strings.Contains(match, a.etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	switch {
	case a.gz == nil:
		_, _ = w.Write(a.plain)
	case acceptsGzip(r):
		h.Set("Content-Encoding", "gzip")
		_, _ = w.Write(a.gz)
	default:
		zr, err := gzip.NewReader(bytes.NewReader(a.gz))
		if err != nil {
			http.Error(w, "asset unavailable", http.StatusInternalServerError)
			return
		}
		defer func() { _ = zr.Close() }()
		_, _ = io.Copy(w, zr) // #nosec G110 -- our own embedded file
	}
}
