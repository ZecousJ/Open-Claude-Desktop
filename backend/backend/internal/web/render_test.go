package web

// CLAUDEX: W-SITE the index rendering and HTML cache tests, moved from
// embed_test.go (unchanged) so they run without -tags embed.

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestInjectSiteTitle(t *testing.T) {
	t.Run("replaces_title_with_site_name", func(t *testing.T) {
		html := []byte(`<html><head><title>Sub2API - AI API Gateway</title></head><body></body></html>`)
		settingsJSON := []byte(`{"site_name":"MyCustomSite"}`)

		result := injectSiteTitle(html, settingsJSON)

		assert.Contains(t, string(result), "<title>MyCustomSite - AI API Gateway</title>")
		assert.NotContains(t, string(result), "Sub2API")
	})

	t.Run("returns_unchanged_when_site_name_empty", func(t *testing.T) {
		html := []byte(`<html><head><title>Sub2API - AI API Gateway</title></head><body></body></html>`)
		settingsJSON := []byte(`{"site_name":""}`)

		result := injectSiteTitle(html, settingsJSON)

		assert.Equal(t, string(html), string(result))
	})

	t.Run("returns_unchanged_when_site_name_missing", func(t *testing.T) {
		html := []byte(`<html><head><title>Sub2API - AI API Gateway</title></head><body></body></html>`)
		settingsJSON := []byte(`{"other_field":"value"}`)

		result := injectSiteTitle(html, settingsJSON)

		assert.Equal(t, string(html), string(result))
	})

	t.Run("returns_unchanged_when_invalid_json", func(t *testing.T) {
		html := []byte(`<html><head><title>Sub2API - AI API Gateway</title></head><body></body></html>`)
		settingsJSON := []byte(`{invalid json}`)

		result := injectSiteTitle(html, settingsJSON)

		assert.Equal(t, string(html), string(result))
	})

	t.Run("returns_unchanged_when_no_title_tag", func(t *testing.T) {
		html := []byte(`<html><head></head><body></body></html>`)
		settingsJSON := []byte(`{"site_name":"MyCustomSite"}`)

		result := injectSiteTitle(html, settingsJSON)

		assert.Equal(t, string(html), string(result))
	})

	t.Run("returns_unchanged_when_title_has_attributes", func(t *testing.T) {
		// The function looks for "<title>" literally, so attributes are not supported
		// This is acceptable since index.html uses plain <title> without attributes
		html := []byte(`<html><head><title lang="en">Sub2API</title></head><body></body></html>`)
		settingsJSON := []byte(`{"site_name":"NewSite"}`)

		result := injectSiteTitle(html, settingsJSON)

		// Should return unchanged since <title> with attributes is not matched
		assert.Equal(t, string(html), string(result))
	})

	t.Run("escapes_html_in_site_name", func(t *testing.T) {
		html := []byte(`<html><head><title>Sub2API - AI API Gateway</title></head><body></body></html>`)
		settingsJSON := []byte(`{"site_name":"</title><script>alert(1)</script><title>"}`)

		result := injectSiteTitle(html, settingsJSON)

		assert.NotContains(t, string(result), "<script>")
		assert.Contains(t, string(result), "&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;title&gt;")
	})

	t.Run("escapes_ampersand_in_site_name", func(t *testing.T) {
		html := []byte(`<html><head><title>Sub2API</title></head><body></body></html>`)
		settingsJSON := []byte(`{"site_name":"A&B"}`)

		result := injectSiteTitle(html, settingsJSON)

		assert.Contains(t, string(result), "<title>A&amp;B - AI API Gateway</title>")
	})

	t.Run("preserves_rest_of_html", func(t *testing.T) {
		html := []byte(`<html><head><meta charset="UTF-8"><title>Sub2API</title><script src="app.js"></script></head><body><div id="app"></div></body></html>`)
		settingsJSON := []byte(`{"site_name":"TestSite"}`)

		result := injectSiteTitle(html, settingsJSON)

		assert.Contains(t, string(result), `<meta charset="UTF-8">`)
		assert.Contains(t, string(result), `<script src="app.js"></script>`)
		assert.Contains(t, string(result), `<div id="app"></div>`)
		assert.Contains(t, string(result), "<title>TestSite - AI API Gateway</title>")
	})
}

func TestInjectSiteFavicon(t *testing.T) {
	t.Run("replaces_favicon_with_site_logo", func(t *testing.T) {
		html := []byte(`<html><head><link rel="icon" type="image/png" href="/logo.png" /></head></html>`)
		settingsJSON := []byte(`{"site_logo":"https://example.com/custom-logo.png"}`)

		result := injectSiteFavicon(html, settingsJSON)

		assert.Contains(t, string(result), `<link rel="icon" href="https://example.com/custom-logo.png" />`)
		assert.NotContains(t, string(result), `/logo.png`)
	})

	t.Run("supports_relative_and_data_image_urls", func(t *testing.T) {
		html := []byte(`<link rel="icon" href="/logo.png" />`)

		assert.Contains(t, string(injectSiteFavicon(html, []byte(`{"site_logo":"/uploads/logo.svg"}`))), `/uploads/logo.svg`)
		assert.Contains(t, string(injectSiteFavicon(html, []byte(`{"site_logo":"data:image/png;base64,abc"}`))), `data:image/png;base64,abc`)
	})

	t.Run("rejects_unsafe_logo_urls", func(t *testing.T) {
		html := []byte(`<link rel="icon" href="/logo.png" />`)

		result := injectSiteFavicon(html, []byte(`{"site_logo":"javascript:alert(1)"}`))

		assert.Equal(t, string(html), string(result))
	})

	t.Run("escapes_logo_url_for_html", func(t *testing.T) {
		html := []byte(`<link rel="icon" href="/logo.png" />`)

		result := injectSiteFavicon(html, []byte(`{"site_logo":"https://example.com/logo.png?a=1&b=2"}`))

		assert.Contains(t, string(result), `a=1&amp;b=2`)
	})
}

func TestReplaceNoncePlaceholder(t *testing.T) {
	t.Run("replaces_single_placeholder", func(t *testing.T) {
		html := []byte(`<script nonce="__CSP_NONCE_VALUE__">console.log('test');</script>`)
		nonce := "abc123xyz"

		result := replaceNoncePlaceholder(html, nonce)

		expected := `<script nonce="abc123xyz">console.log('test');</script>`
		assert.Equal(t, expected, string(result))
	})

	t.Run("replaces_multiple_placeholders", func(t *testing.T) {
		html := []byte(`<script nonce="__CSP_NONCE_VALUE__">a</script><script nonce="__CSP_NONCE_VALUE__">b</script>`)
		nonce := "nonce123"

		result := replaceNoncePlaceholder(html, nonce)

		assert.Equal(t, 2, strings.Count(string(result), `nonce="nonce123"`))
		assert.NotContains(t, string(result), NonceHTMLPlaceholder)
	})

	t.Run("handles_empty_nonce", func(t *testing.T) {
		html := []byte(`<script nonce="__CSP_NONCE_VALUE__">test</script>`)
		nonce := ""

		result := replaceNoncePlaceholder(html, nonce)

		assert.Equal(t, `<script nonce="">test</script>`, string(result))
	})

	t.Run("no_placeholder_returns_unchanged", func(t *testing.T) {
		html := []byte(`<script>console.log('test');</script>`)
		nonce := "abc123"

		result := replaceNoncePlaceholder(html, nonce)

		assert.Equal(t, string(html), string(result))
	})

	t.Run("handles_empty_html", func(t *testing.T) {
		html := []byte(``)
		nonce := "abc123"

		result := replaceNoncePlaceholder(html, nonce)

		assert.Empty(t, result)
	})
}

func TestNonceHTMLPlaceholder(t *testing.T) {
	t.Run("constant_value", func(t *testing.T) {
		assert.Equal(t, "__CSP_NONCE_VALUE__", NonceHTMLPlaceholder)
	})
}

// Tests for HTMLCache
func TestHTMLCache(t *testing.T) {
	t.Run("new_cache_returns_nil", func(t *testing.T) {
		cache := NewHTMLCache()
		assert.Nil(t, cache.Get())
	})

	t.Run("set_and_get", func(t *testing.T) {
		cache := NewHTMLCache()
		cache.SetBaseHTML([]byte("<html></html>"))

		html := []byte("<html><body>test</body></html>")
		settings := []byte(`{"key":"value"}`)
		cache.Set(html, settings)

		result := cache.Get()
		require.NotNil(t, result)
		assert.Equal(t, html, result.Content)
		assert.NotEmpty(t, result.ETag)
	})

	t.Run("invalidate_clears_cache", func(t *testing.T) {
		cache := NewHTMLCache()
		cache.SetBaseHTML([]byte("<html></html>"))

		html := []byte("<html><body>test</body></html>")
		settings := []byte(`{"key":"value"}`)
		cache.Set(html, settings)

		require.NotNil(t, cache.Get())

		cache.Invalidate()

		assert.Nil(t, cache.Get())
	})

	t.Run("etag_changes_with_settings", func(t *testing.T) {
		cache := NewHTMLCache()
		cache.SetBaseHTML([]byte("<html></html>"))

		html := []byte("<html><body>test</body></html>")

		cache.Set(html, []byte(`{"v":1}`))
		etag1 := cache.Get().ETag

		cache.Invalidate()
		cache.Set(html, []byte(`{"v":2}`))
		etag2 := cache.Get().ETag

		assert.NotEqual(t, etag1, etag2)
	})

	t.Run("etag_format", func(t *testing.T) {
		cache := NewHTMLCache()
		cache.SetBaseHTML([]byte("<html></html>"))

		cache.Set([]byte("<html></html>"), []byte(`{}`))
		result := cache.Get()

		// ETag should be quoted
		assert.True(t, strings.HasPrefix(result.ETag, `"`))
		assert.True(t, strings.HasSuffix(result.ETag, `"`))
		// Should contain dash separator
		assert.Contains(t, result.ETag[1:len(result.ETag)-1], "-")
	})
}

// Benchmark tests
func BenchmarkReplaceNoncePlaceholder(b *testing.B) {
	html := []byte(`<!DOCTYPE html><html><head><script nonce="__CSP_NONCE_VALUE__">window.__APP_CONFIG__={"test":"data"};</script></head><body></body></html>`)
	nonce := "abcdefghijklmnop123456=="

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		replaceNoncePlaceholder(html, nonce)
	}
}
