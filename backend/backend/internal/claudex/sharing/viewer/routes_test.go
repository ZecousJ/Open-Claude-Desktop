package viewer

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const (
	tokA       = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" // conversation
	tokB       = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" // artifact share
	tokRemoved = "RRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR"
	tokBroken  = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
	tokFail    = "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF"
)

var sharedAt = time.Date(2026, 9, 26, 10, 0, 0, 0, time.UTC)

func conversation() Snapshot {
	return Snapshot{
		Kind: KindConversation, Title: "Plan <the> trip", Mode: "chat", ModelLabel: "Claude Sonnet",
		Messages: []Message{
			{Role: "user", Text: "Draw <b>me</b> a diagram"},
			{Role: "assistant", Text: "Here it is:\n\n**Bold** <script>alert(1)</script>", Activity: []string{"Ran a command"}, Artifacts: []int{0}},
			{Role: "assistant", Text: "And a page."},
		},
		Artifacts: []Artifact{
			{Title: "Flow", Language: LanguageMermaid, Content: "graph TD\nA-->B</pre><script>alert(1)</script>"},
			{Title: "Unreferenced page", Language: LanguageHTML, Content: "<h1>Hi</h1><script>document.title='x'</script>"},
			{Title: "Notes", Language: LanguageMarkdown, Content: "# Notes\n\n<script>x</script>"},
			{Title: "main", Language: LanguageCode, CodeLanguage: "TypeScript", Content: "const a = '<b>';"},
			{Title: "Logo", Language: LanguageSVG, Content: `<svg xmlns="http://www.w3.org/2000/svg"/>`},
		},
	}
}

type fakeSource struct {
	opts    Options
	mu      sync.Mutex
	views   []string
	reports []Report
	repErr  error
}

func (f *fakeSource) Options(context.Context) Options { return f.opts }

func (f *fakeSource) Lookup(_ context.Context, token string) (*Share, error) {
	switch token {
	case tokA:
		return &Share{SharedAt: sharedAt, Snapshot: conversation()}, nil
	case tokB:
		return &Share{SharedAt: sharedAt, Snapshot: Snapshot{Kind: KindArtifact, Title: "Chart", Artifacts: []Artifact{{Title: "Chart", Language: LanguageHTML, Content: "<p>chart</p>"}}}}, nil
	case tokRemoved:
		return &Share{Removed: true}, nil
	case tokBroken:
		return &Share{Snapshot: Snapshot{Kind: "weird"}}, nil
	case tokFail:
		return nil, errors.New("database down")
	}
	return nil, ErrNotFound
}

func (f *fakeSource) CountView(_ context.Context, token, _ string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.views = append(f.views, token)
}

func (f *fakeSource) Report(_ context.Context, _ string, r Report, _ string) error {
	if f.repErr != nil {
		return f.repErr
	}
	f.reports = append(f.reports, r)
	return nil
}

// newRouter mounts the viewer like module.RegisterPageRoutes does, behind a
// stand-in for the upstream SecurityHeaders middleware, which writes the
// console's headers first.
func newRouter(src Source) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Header("X-Frame-Options", "DENY")
		c.Header("Content-Security-Policy", "default-src 'self'; script-src 'self' 'nonce-console'")
		c.Header("Referrer-Policy", "strict-origin-when-cross-origin")
		c.Next()
	})
	Register(r.Group(PathPrefix), src)
	return r
}

func do(r http.Handler, method, target, host string, body io.Reader, hdr map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, body)
	if host != "" {
		req.Host = host
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

func get(r http.Handler, target string) *httptest.ResponseRecorder {
	return do(r, http.MethodGet, target, "", nil, nil)
}

func assertCommon(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	assert.Equal(t, "noindex, nofollow, noarchive", rec.Header().Get("X-Robots-Tag"))
	assert.Equal(t, "no-referrer", rec.Header().Get("Referrer-Policy"))
	assert.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
	assert.Equal(t, "nosniff", rec.Header().Get("X-Content-Type-Options"))
}

func TestConversationPage(t *testing.T) {
	src := &fakeSource{opts: Options{AllowReports: true, UsagePolicyURL: "https://example.com/policy"}}
	rec := get(newRouter(src), "/s/"+tokA)
	require.Equal(t, http.StatusOK, rec.Code)
	assertCommon(t, rec)
	h := rec.Header()
	assert.Equal(t, "DENY", h.Get("X-Frame-Options"))
	assert.Equal(t, "text/html; charset=utf-8", h.Get("Content-Type"))
	csp := h.Get("Content-Security-Policy")
	assert.Regexp(t, `^default-src 'none'; style-src 'nonce-[A-Za-z0-9_-]{22}'; img-src 'self' data:; frame-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'$`, csp)

	body := rec.Body.String()
	nonce := strings.TrimSuffix(strings.SplitN(strings.SplitN(csp, "'nonce-", 2)[1], "'", 2)[0], "")
	assert.Contains(t, body, `<style nonce="`+nonce+`">`)
	assert.NotContains(t, strings.ToLower(body), "<script", "the page itself never carries script")
	assert.Contains(t, body, "<title>Plan &lt;the&gt; trip · Claudex</title>")
	assert.Contains(t, body, `<div class="bubble">Draw &lt;b&gt;me&lt;/b&gt; a diagram</div>`)
	// The page ends with a way to start one's own chat (live claude.ai shared page).
	assert.Contains(t, body, `<div class="continue"><a class="button" href="/">Ask Claudex your own question</a></div>`)
	assert.Less(t, strings.Index(body, "</main>"), strings.Index(body, `class="continue"`))
	assert.Contains(t, body, "<strong>Bold</strong> &lt;script&gt;alert(1)&lt;/script&gt;")
	assert.Contains(t, body, "<li>Ran a command</li>")
	assert.Contains(t, body, "Shared Sep 26, 2026 · Chat · Claude Sonnet")
	assert.Contains(t, body, `src="./`+tokA+`/a/0"`)
	assert.Contains(t, body, `sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"`)
	assert.NotContains(t, body, "allow-same-origin")
	assert.Contains(t, body, `href="./`+tokA+`/raw/0"`)
	// Unreferenced artifacts are shown after the last reply.
	assert.Contains(t, body, "Unreferenced page")
	assert.Less(t, strings.Index(body, "And a page."), strings.Index(body, "Unreferenced page"))
	assert.Contains(t, body, `action="./`+tokA+`/report"`)
	assert.Contains(t, body, `<option value="violation_of_terms">Violation of terms or usage policy</option>`)
	assert.Contains(t, body, `<option value="court_order" data-elsewhere>Court order</option>`)
	assert.Contains(t, body, `href="https://example.com/policy"`)
	assert.Contains(t, body, "Shared from Claudex on Sep 26, 2026.")
	assert.Equal(t, []string{tokA}, src.views)

	// Two page loads get different nonces.
	other := get(newRouter(src), "/s/"+tokA).Header().Get("Content-Security-Policy")
	assert.NotEqual(t, csp, other)
}

func TestPageWithoutReports(t *testing.T) {
	rec := get(newRouter(&fakeSource{}), "/s/"+tokA)
	require.Equal(t, http.StatusOK, rec.Code)
	assert.NotContains(t, rec.Body.String(), "<form")
	assert.NotContains(t, rec.Body.String(), "Usage Policy")

	// A source that cannot take reports never shows the form.
	type onlySource struct{ Source }
	rec = get(newRouter(onlySource{&fakeSource{opts: Options{AllowReports: true}}}), "/s/"+tokA)
	assert.NotContains(t, rec.Body.String(), "<form")
}

func TestArtifactSharePage(t *testing.T) {
	rec := get(newRouter(&fakeSource{opts: Options{SiteName: "Acme AI"}}), "/s/"+tokB)
	require.Equal(t, http.StatusOK, rec.Code)
	body := rec.Body.String()
	assert.Contains(t, body, `<body class="full">`)
	assert.Contains(t, body, `class="full-frame" title="Chart" src="./`+tokB+`/a/0"`)
	assert.Contains(t, body, `<span class="wordmark">Acme AI</span></a>`) // CLAUDEX: LOGIN star + serif wordmark
}

func TestNotFoundIsUniform(t *testing.T) {
	r := newRouter(&fakeSource{})
	var first string
	for _, target := range []string{"/s/short", "/s/" + strings.Repeat("A", 44), "/s/" + strings.Repeat("Z", 43), "/s/" + tokBroken, "/s/" + strings.Repeat("*", 43)} {
		rec := get(r, target)
		assert.Equal(t, http.StatusNotFound, rec.Code, target)
		assertCommon(t, rec)
		assert.Equal(t, "DENY", rec.Header().Get("X-Frame-Options"))
		body := stripNonce(rec.Body.String())
		if first == "" {
			first = body
		}
		assert.Equal(t, first, body, "404 pages must not tell the cases apart (%s)", target)
		assert.Contains(t, body, "This link isn&#39;t available")
	}
}

// stripNonce removes the per-response nonce.
func stripNonce(body string) string {
	i := strings.Index(body, `nonce="`)
	if i < 0 {
		return body
	}
	j := strings.Index(body[i+7:], `"`)
	return body[:i] + body[i+7+j:]
}

func TestRemovedAndErrors(t *testing.T) {
	r := newRouter(&fakeSource{})
	rec := get(r, "/s/"+tokRemoved)
	assert.Equal(t, http.StatusGone, rec.Code)
	assert.Contains(t, rec.Body.String(), "This content was removed by the administrator")
	rec = get(r, "/s/"+tokRemoved+"/a/0")
	assert.Equal(t, http.StatusGone, rec.Code)
	assert.Equal(t, "text/plain; charset=utf-8", rec.Header().Get("Content-Type"))
	rec = get(r, "/s/"+tokFail)
	assert.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.NotContains(t, rec.Body.String(), "database down")
}

func TestArtifactDocuments(t *testing.T) {
	r := newRouter(&fakeSource{})
	wantCSP := "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; default-src 'none'; script-src 'unsafe-inline' 'self'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'"
	cases := []struct {
		n, contentType string
		contains       []string
		excludes       []string
	}{
		{"0", "text/html; charset=utf-8", []string{`<script src="../../_assets/mermaid.min.js">`, "A--&gt;B&lt;/pre&gt;&lt;script&gt;alert(1)&lt;/script&gt;", `securityLevel: "strict"`}, []string{"</pre><script>alert"}},
		{"1", "text/html; charset=utf-8", []string{"<h1>Hi</h1><script>document.title='x'</script>"}, nil},
		{"2", "text/html; charset=utf-8", []string{"<h1>Notes</h1>", "&lt;script&gt;x&lt;/script&gt;"}, []string{"<script>x"}},
		{"3", "text/html; charset=utf-8", []string{`<code class="language-typescript">const a = &#39;&lt;b&gt;&#39;;</code>`}, nil},
		{"4", "image/svg+xml; charset=utf-8", []string{`<svg xmlns="http://www.w3.org/2000/svg"/>`}, nil},
	}
	for _, c := range cases {
		rec := get(r, "/s/"+tokA+"/a/"+c.n)
		require.Equal(t, http.StatusOK, rec.Code, c.n)
		assertCommon(t, rec)
		assert.Equal(t, c.contentType, rec.Header().Get("Content-Type"), c.n)
		assert.Equal(t, wantCSP, rec.Header().Get("Content-Security-Policy"), c.n)
		assert.Empty(t, rec.Header().Get("X-Frame-Options"), "content documents are framed (%s)", c.n)
		assert.Equal(t, "same-site", rec.Header().Get("Cross-Origin-Resource-Policy"))
		for _, s := range c.contains {
			assert.Contains(t, rec.Body.String(), s, c.n)
		}
		for _, s := range c.excludes {
			assert.NotContains(t, rec.Body.String(), s, c.n)
		}
	}
	for _, bad := range []string{"5", "-1", "01", "x", "99999999999999999999"} {
		assert.Equal(t, http.StatusNotFound, get(r, "/s/"+tokA+"/a/"+bad).Code, bad)
	}
}

func TestRawSource(t *testing.T) {
	r := newRouter(&fakeSource{})
	rec := get(r, "/s/"+tokA+"/raw/3")
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "text/plain; charset=utf-8", rec.Header().Get("Content-Type"))
	assert.Equal(t, `attachment; filename="main.ts"`, rec.Header().Get("Content-Disposition"))
	assert.Equal(t, "default-src 'none'; sandbox", rec.Header().Get("Content-Security-Policy"))
	assert.Equal(t, "const a = '<b>';", rec.Body.String())
	assert.Equal(t, `attachment; filename="flow.mmd"`, get(r, "/s/"+tokA+"/raw/0").Header().Get("Content-Disposition"))
	assert.Equal(t, `attachment; filename="unreferenced-page.html"`, get(r, "/s/"+tokA+"/raw/1").Header().Get("Content-Disposition"))
}

func TestRawFilename(t *testing.T) {
	assert.Equal(t, "artifact.txt", RawFilename(Artifact{Language: LanguageCode}))
	assert.Equal(t, "a-b.py", RawFilename(Artifact{Title: "A / B", Language: LanguageCode, CodeLanguage: "python"}))
	assert.Equal(t, "x.cs", RawFilename(Artifact{Title: "x", Language: LanguageCode, CodeLanguage: "C#"}))
	assert.Equal(t, "evil.md", RawFilename(Artifact{Title: "\"; evil=\"", Language: LanguageMarkdown}))
	assert.Equal(t, "artifact.md", RawFilename(Artifact{Title: "\"\r\n", Language: LanguageMarkdown}))
}

func TestSeparateContentOrigin(t *testing.T) {
	src := &fakeSource{opts: Options{PublicBaseURL: "https://share.example", ContentBaseURL: "https://usercontent.example/"}}
	r := newRouter(src)

	page := do(r, http.MethodGet, "/s/"+tokA, "share.example", nil, nil)
	require.Equal(t, http.StatusOK, page.Code)
	assert.Contains(t, page.Header().Get("Content-Security-Policy"), "frame-src https://usercontent.example;")
	assert.Contains(t, page.Body.String(), `src="https://usercontent.example/s/`+tokA+`/a/0"`)
	assert.Contains(t, page.Body.String(), `href="https://usercontent.example/s/`+tokA+`/raw/0"`)

	// Pages never answer on the content host, content never on the page host.
	assert.Equal(t, http.StatusNotFound, do(r, http.MethodGet, "/s/"+tokA, "usercontent.example", nil, nil).Code)
	assert.Equal(t, http.StatusNotFound, do(r, http.MethodGet, "/s/"+tokA+"/a/0", "share.example", nil, nil).Code)
	assert.Equal(t, http.StatusNotFound, do(r, http.MethodGet, "/s/"+tokA+"/raw/0", "share.example", nil, nil).Code)
	assert.Equal(t, http.StatusNotFound, do(r, http.MethodGet, "/s/_assets/mermaid.min.js", "share.example", nil, nil).Code)

	doc := do(r, http.MethodGet, "/s/"+tokA+"/a/0", "UserContent.example:443", nil, nil)
	require.Equal(t, http.StatusOK, doc.Code)
	csp := doc.Header().Get("Content-Security-Policy")
	assert.Contains(t, csp, "script-src 'unsafe-inline' 'self' https://usercontent.example/s/_assets/;")
	assert.True(t, strings.HasSuffix(csp, "frame-ancestors https://share.example"), csp)
	assert.Equal(t, http.StatusOK, do(r, http.MethodGet, "/s/_assets/mermaid.min.js", "usercontent.example", nil, map[string]string{"Accept-Encoding": "gzip"}).Code)

	// A content origin on the page host, or without a public base, is ignored.
	for _, o := range []Options{{ContentBaseURL: "https://usercontent.example"}, {PublicBaseURL: "https://share.example", ContentBaseURL: "https://SHARE.example:443/x"}} {
		src.opts = o
		assert.Equal(t, http.StatusOK, do(r, http.MethodGet, "/s/"+tokA+"/a/0", "share.example", nil, nil).Code)
		assert.Contains(t, do(r, http.MethodGet, "/s/"+tokA, "share.example", nil, nil).Body.String(), `src="./`+tokA+`/a/0"`)
	}
}

func TestPublicBaseOnlyAddsExplicitSources(t *testing.T) {
	csp := ContentCSP(Options{PublicBaseURL: "https://example.com/prefix/"})
	assert.Contains(t, csp, "script-src 'unsafe-inline' 'self' https://example.com/prefix/s/_assets/;")
	assert.True(t, strings.HasSuffix(csp, "frame-ancestors 'self' https://example.com"), csp)
	// Invalid base URLs are ignored.
	assert.Equal(t, ContentCSP(Options{}), ContentCSP(Options{PublicBaseURL: "javascript:alert(1)"}))
	assert.Equal(t, ContentCSP(Options{}), ContentCSP(Options{PublicBaseURL: "https://user:pw@example.com"}))
}

func TestReportForm(t *testing.T) {
	src := &fakeSource{opts: Options{AllowReports: true}}
	r := newRouter(src)
	post := func(token string, form url.Values) *httptest.ResponseRecorder {
		return do(r, http.MethodPost, "/s/"+token+"/report", "", strings.NewReader(form.Encode()),
			map[string]string{"Content-Type": "application/x-www-form-urlencoded"})
	}
	rec := post(tokA, url.Values{"reason": {"spam"}, "detail": {"  " + strings.Repeat("é", 1200) + " "}})
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Body.String(), "The administrator will review this.")
	assert.Contains(t, rec.Body.String(), `href="../`+tokA+`"`)
	require.Len(t, src.reports, 1)
	assert.Equal(t, "spam", src.reports[0].Reason)
	assert.Equal(t, MaxReportDetail, len([]rune(src.reports[0].Detail)))

	assert.Equal(t, http.StatusBadRequest, post(tokA, url.Values{"reason": {"because"}}).Code)
	assert.Equal(t, http.StatusNotFound, post("nope", url.Values{"reason": {"spam"}}).Code)
	assert.Equal(t, http.StatusGone, post(tokRemoved, url.Values{"reason": {"spam"}}).Code)
	big := do(r, http.MethodPost, "/s/"+tokA+"/report", "", strings.NewReader("reason=spam&detail="+strings.Repeat("a", 20000)),
		map[string]string{"Content-Type": "application/x-www-form-urlencoded"})
	assert.Equal(t, http.StatusBadRequest, big.Code)

	src.repErr = ErrTooManyReports
	assert.Equal(t, http.StatusTooManyRequests, post(tokA, url.Values{"reason": {"spam"}}).Code)
	src.repErr = ErrReportsOff
	assert.Equal(t, http.StatusNotFound, post(tokA, url.Values{"reason": {"spam"}}).Code)
	src.repErr = nil

	src.opts.AllowReports = false
	assert.Equal(t, http.StatusNotFound, post(tokA, url.Values{"reason": {"spam"}}).Code)
	assert.Len(t, src.reports, 1)
}

func TestMermaidAsset(t *testing.T) {
	r := newRouter(&fakeSource{})
	gz := do(r, http.MethodGet, "/s/_assets/mermaid.min.js", "", nil, map[string]string{"Accept-Encoding": "br, gzip;q=0.8"})
	require.Equal(t, http.StatusOK, gz.Code)
	assert.Equal(t, "gzip", gz.Header().Get("Content-Encoding"))
	assert.Equal(t, "text/javascript; charset=utf-8", gz.Header().Get("Content-Type"))
	assert.Equal(t, "cross-origin", gz.Header().Get("Cross-Origin-Resource-Policy"))
	assert.Equal(t, "public, max-age=86400", gz.Header().Get("Cache-Control"))
	assert.Empty(t, gz.Header().Get("X-Frame-Options"))
	zr, err := gzip.NewReader(bytes.NewReader(gz.Body.Bytes()))
	require.NoError(t, err)
	js, err := io.ReadAll(zr)
	require.NoError(t, err)
	assert.Greater(t, len(js), 1<<20)
	assert.True(t, bytes.HasPrefix(js, []byte(`"use strict";`)))

	plain := do(r, http.MethodGet, "/s/_assets/mermaid.min.js", "", nil, map[string]string{"Accept-Encoding": "gzip;q=0"})
	require.Equal(t, http.StatusOK, plain.Code)
	assert.Empty(t, plain.Header().Get("Content-Encoding"))
	assert.Equal(t, js, plain.Body.Bytes())

	etag := gz.Header().Get("ETag")
	require.NotEmpty(t, etag)
	assert.Equal(t, http.StatusNotModified, do(r, http.MethodGet, "/s/_assets/mermaid.min.js", "", nil, map[string]string{"If-None-Match": etag}).Code)

	lic := get(r, "/s/_assets/LICENSE.mermaid.txt")
	assert.Equal(t, http.StatusOK, lic.Code)
	assert.Contains(t, lic.Body.String(), "MIT")
	for _, bad := range []string{"/s/_assets/", "/s/_assets/../snapshot.go", "/s/_assets/mermaid.min.js.gz", "/s/_assets/x/mermaid.min.js"} {
		assert.Equal(t, http.StatusNotFound, get(r, bad).Code, bad)
	}
}

func TestRenderFunctions(t *testing.T) {
	rec := httptest.NewRecorder()
	require.NoError(t, Render(rec, tokA, conversation(), sharedAt, Options{}))
	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Body.String(), "Plan &lt;the&gt; trip")
	assert.Error(t, Render(httptest.NewRecorder(), tokA, Snapshot{Kind: "x"}, sharedAt, Options{}))

	rec = httptest.NewRecorder()
	RenderNotFound(rec, Options{})
	assert.Equal(t, http.StatusNotFound, rec.Code)
	rec = httptest.NewRecorder()
	RenderRemoved(rec, Options{SiteName: "Acme"})
	assert.Equal(t, http.StatusGone, rec.Code)
	assert.Contains(t, rec.Body.String(), "The administrator of Acme took this shared content down.")

	rec = httptest.NewRecorder()
	require.NoError(t, RenderArtifact(rec, Artifact{Language: LanguageSVG, Content: "<svg/>"}, Options{}))
	assert.Equal(t, "image/svg+xml; charset=utf-8", rec.Header().Get("Content-Type"))
}

func TestDecodeSnapshot(t *testing.T) {
	s, err := DecodeSnapshot([]byte(`{"kind":"conversation","title":"t","messages":[{"role":"user","text":"hi"},{"role":"assistant","text":"yo","artifacts":[0]}],"artifacts":[{"title":"a","language":"html","content":"<p>"}]}`))
	require.NoError(t, err)
	assert.Equal(t, "hi", s.Messages[0].Text)
	for _, bad := range []string{
		`nope`,
		`{"kind":"other"}`,
		`{"kind":"artifact","artifacts":[]}`,
		`{"kind":"artifact","artifacts":[{"language":"html"},{"language":"html"}]}`,
		`{"kind":"conversation","artifacts":[{"language":"exe"}]}`,
		`{"kind":"conversation","messages":[{"role":"system","text":"x"}]}`,
		`{"kind":"conversation","messages":[{"role":"assistant","artifacts":[3]}]}`,
	} {
		_, err := DecodeSnapshot([]byte(bad))
		assert.ErrorIs(t, err, ErrBadSnapshot, bad)
	}
	assert.True(t, ValidToken(tokA))
	assert.True(t, ValidToken("_-"+strings.Repeat("a", 41)))
	assert.False(t, ValidToken(tokA+"A"))
	assert.False(t, ValidToken(strings.Repeat("=", 43)))
	assert.Equal(t, []string{"illegal", "harmful", "privacy", "spam", "other"}, ReportReasons())
}

func TestUsagePolicyLink(t *testing.T) {
	for raw, want := range map[string]string{
		"https://example.com/policy": "https://example.com/policy",
		"  /legal/terms ":            "/legal/terms",
		"/legal/terms?lang=en":       "/legal/terms?lang=en",
		"":                           "",
		"/":                          "",
		"http://example.com/policy":  "",
		"//evil.example/policy":      "",
		`/\evil.example`:             "",
		"javascript:alert(1)":        "",
		"legal/terms":                "",
		"/legal terms":               "",
		`/legal"onmouseover=x`:       "",
	} {
		assert.Equal(t, want, usagePolicyLink(raw), raw)
	}
	rec := get(newRouter(&fakeSource{opts: Options{UsagePolicyURL: "/legal/terms"}}), "/s/"+tokA)
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Body.String(), `href="/legal/terms"`)
}
