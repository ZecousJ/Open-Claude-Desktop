package sharing

// CLAUDEX: LOGIN the built-in notice page and page header have the sign-in
// page's look (star + serif wordmark, serif title, secondary button).

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// shotDir is where the notice pages are written for screenshots when the
// directory exists (scripts/backend/go.sh mounts work/backend/out at /out).
const shotDir = "/out/claudex-share-shots"

func writeShot(t *testing.T, name, body string) {
	t.Helper()
	if st, err := os.Stat(shotDir); err != nil || !st.IsDir() {
		return
	}
	require.NoError(t, os.WriteFile(filepath.Join(shotDir, name), []byte(body), 0o644))
}

func TestBuiltinNoticeLooksLikeSignIn(t *testing.T) {
	for _, tc := range []struct {
		status int
		kind   NoticeKind
		back   string
		file   string
	}{
		{http.StatusNotFound, NoticeNotFound, "", "builtin-404.html"},
		{http.StatusGone, NoticeRemoved, "", "builtin-410.html"},
		{http.StatusServiceUnavailable, NoticeNotFound, "", "builtin-503.html"},
		{http.StatusOK, NoticeReportReceived, "/s/abc", "builtin-report.html"},
	} {
		rec := httptest.NewRecorder()
		require.NoError(t, builtinRenderer{}.Notice(rec, tc.status, &NoticeView{Kind: tc.kind, SiteName: "Claudex", BackURL: tc.back}))
		require.Equal(t, tc.status, rec.Code)
		body := rec.Body.String()
		title, text := NoticeText(tc.kind)
		require.Contains(t, body, `<a class="brand" href="/"><svg class="star"`)
		require.Contains(t, body, `<span class="wm">Claudex</span>`)
		require.Contains(t, body, "<h1>"+strings.ReplaceAll(title, "'", "&#39;")+"</h1>")
		require.Contains(t, body, strings.ReplaceAll(text, "'", "&#39;"))
		require.NotContains(t, strings.ToLower(body), "<script")
		if tc.back != "" {
			require.Contains(t, body, `<a class="button" href="/s/abc">Back</a>`)
		} else {
			require.Contains(t, body, `<a class="button" href="/">Go to Claudex</a>`)
		}
		// The CSP is unchanged: inline styles only, nothing else.
		require.Equal(t, "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
			rec.Header().Get("Content-Security-Policy"))
		writeShot(t, tc.file, body)
	}
}

func TestBuiltinPageHeaderHasWordmark(t *testing.T) {
	rec := httptest.NewRecorder()
	require.NoError(t, builtinRenderer{}.Page(rec, &PageView{
		Title: "Plan a trip", SiteName: "Claudex", FrameSource: "'self'", SnapshotAt: time.Unix(0, 0),
		Snapshot: &Snapshot{Kind: KindConversation, Messages: []SnapshotMessage{{Role: "user", Text: "Hi"}}},
	}))
	body := rec.Body.String()
	require.Contains(t, body, `<header><a class="brand" href="/"><svg class="star"`)
	require.Contains(t, body, `<span class="wm">Claudex</span></a><span>Plan a trip</span></header>`)
	require.Equal(t, builtinPageCSP+"; frame-src 'self'", rec.Header().Get("Content-Security-Policy"))
}
