package web

// CLAUDEX: W-SITE no build tag: the untagged SiteServer (site.go) uses it.

import (
	"net/http"
	"path"
	"regexp"
	"strings"
)

// Vite emits content-hashed filenames under assets/, so the backend can apply
// immutable caching without relying on a reverse proxy to classify paths.
const staticAssetsCacheControl = "public, max-age=31536000, immutable"

var versionedOfficialAssetPath = regexp.MustCompile(`^assets/official-[0-9a-f]{20}/[^/]+\.(?:js|css|woff2?|ttf|png|svg|wasm)$`)
var bootstrapCatalogAssetPath = regexp.MustCompile(`^assets/bootstrap-catalog-[0-9a-f]{64}\.json$`)

// isFingerprintedEmbeddedAssetPath reports whether a cleaned URL path refers to
// a Vite asset whose filename contains the default eight-character build hash.
func isFingerprintedEmbeddedAssetPath(cleanPath string) bool {
	cleanPath = strings.TrimPrefix(cleanPath, "/")
	if !strings.HasPrefix(cleanPath, "assets/") {
		return false
	}

	filename := path.Base(cleanPath)
	extension := path.Ext(filename)
	stem := strings.TrimSuffix(filename, extension)
	const fingerprintLength = 8
	delimiterIndex := len(stem) - fingerprintLength - 1
	if extension == "" || delimiterIndex < 1 || stem[delimiterIndex] != '-' {
		return false
	}

	// Vite hashes use URL-safe characters and are stable for immutable caching.
	fingerprint := stem[delimiterIndex+1:]
	for _, char := range fingerprint {
		if (char >= 'a' && char <= 'z') ||
			(char >= 'A' && char <= 'Z') ||
			(char >= '0' && char <= '9') ||
			char == '_' || char == '-' {
			continue
		}
		return false
	}
	return true
}

// applyStaticAssetCacheHeaders sets Cache-Control for app assets.
// index.html / SPA routes must keep no-cache and are not handled here.
func applyStaticAssetCacheHeaders(header http.Header, cleanPath string) {
	if header == nil {
		return
	}
	switch {
	case versionedOfficialAssetPath.MatchString(strings.TrimPrefix(cleanPath, "/")),
		bootstrapCatalogAssetPath.MatchString(strings.TrimPrefix(cleanPath, "/")):
		header.Set("Cache-Control", staticAssetsCacheControl)
	case strings.HasPrefix(strings.TrimPrefix(cleanPath, "/"), "assets/v1/"):
		// The derived vendor bundles keep their upstream filenames when their bytes change.
		header.Set("Cache-Control", "no-cache")
	case isFingerprintedEmbeddedAssetPath(cleanPath):
		header.Set("Cache-Control", staticAssetsCacheControl)
	}
}
