//go:build embed

package web

// CLAUDEX: W-SITE checks the real embedded builds (dist/admin, and dist/app
// when present). The dispatch, injection and cache tests run on in-memory
// builds in site_test.go; the rendering tests moved to render_test.go.

import (
	"net/http"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestHasEmbeddedFrontend(t *testing.T) {
	assert.True(t, HasEmbeddedFrontend(), "an embed build needs dist/admin/index.html")
}

func TestEmbeddedSiteServesConsole(t *testing.T) {
	s, err := NewSiteServer(SiteOptions{})
	require.NoError(t, err)
	require.True(t, s.HasConsole())
	assert.Equal(t, HasEmbeddedWebApp(), s.HasWebApp())

	r := newTestRouter(s)
	w := do(r, http.MethodGet, "/admin/")
	assert.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Body.String(), "<!doctype html>")
	assert.Contains(t, w.Body.String(), "/admin/assets/", "the console must be built with Vite base /admin/")
}

// Tests for legacy ServeEmbeddedFrontend function
func TestServeEmbeddedFrontend(t *testing.T) {
	r := gin.New()
	r.Use(ServeEmbeddedFrontend())
	w := do(r, http.MethodGet, "/admin/")
	assert.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Header().Get("Content-Type"), "text/html")
	assert.Equal(t, http.StatusFound, do(r, http.MethodGet, "/dashboard").Code)
}

func BenchmarkSiteServerServeIndex(b *testing.B) {
	s, err := NewSiteServer(SiteOptions{Settings: &countingSettings{settings: map[string]string{"test": "value"}}})
	if err != nil {
		b.Fatal(err)
	}
	r := newTestRouter(s)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		do(r, http.MethodGet, "/admin/")
	}
}
