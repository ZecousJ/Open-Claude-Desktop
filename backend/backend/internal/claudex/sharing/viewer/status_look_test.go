package viewer

// CLAUDEX: LOGIN the status pages have the sign-in page's look (star + serif
// wordmark, serif title, muted body, a secondary button) under the same CSP.

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// shotDir is where the pages are written for screenshots when the directory
// exists (scripts/backend/go.sh mounts work/backend/out at /out).
const shotDir = "/out/claudex-share-shots"

func writeShot(t *testing.T, name, body string) {
	t.Helper()
	if st, err := os.Stat(shotDir); err != nil || !st.IsDir() {
		return
	}
	require.NoError(t, os.WriteFile(filepath.Join(shotDir, name), []byte(body), 0o644))
}

func TestStatusPagesLookLikeSignIn(t *testing.T) {
	for _, tc := range []struct {
		name   string
		render func(w http.ResponseWriter)
		status int
		title  string
	}{
		{"viewer-404.html", func(w http.ResponseWriter) { RenderNotFound(w, Options{}) }, http.StatusNotFound, "This link isn&#39;t available"},
		{"viewer-410.html", func(w http.ResponseWriter) { RenderRemoved(w, Options{}) }, http.StatusGone, removedHeading},
	} {
		rec := httptest.NewRecorder()
		tc.render(rec)
		require.Equal(t, tc.status, rec.Code)
		body := rec.Body.String()
		assert.Contains(t, body, `<body class="status-page">`)
		assert.Contains(t, body, `<header class="status-head"><a class="brand" href="/"><svg class="brand-star"`)
		assert.Contains(t, body, `<span class="wordmark">Claudex</span></a></header>`)
		assert.Contains(t, body, "<h1>"+tc.title+"</h1>")
		assert.Contains(t, body, `<a class="secondary-button" href="/">Go to Claudex</a>`)
		assert.NotContains(t, strings.ToLower(body), "<script")
		assert.NotContains(t, body, `style="`, "inline style attributes would break the nonce CSP")
		csp := rec.Header().Get("Content-Security-Policy")
		assert.Contains(t, csp, "style-src 'nonce-")
		assert.Contains(t, csp, "default-src 'none'")
		writeShot(t, tc.name, body)
	}
}

func TestSharePageHeaderHasWordmark(t *testing.T) {
	rec := get(newRouter(&fakeSource{}), "/s/"+tokA)
	require.Equal(t, http.StatusOK, rec.Code)
	body := rec.Body.String()
	assert.Contains(t, body, "<header class=\"bar\">\n<a class=\"brand\" href=\"/\"><svg class=\"brand-star\"")
	assert.Contains(t, body, `<span class="wordmark">Claudex</span></a>`)
	writeShot(t, "viewer-share.html", body)
}
