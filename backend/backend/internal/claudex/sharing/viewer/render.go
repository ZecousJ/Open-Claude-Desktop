package viewer

import (
	"bytes"
	"crypto/rand"
	"embed"
	"encoding/base64"
	"html/template"
	"net/http"
	"strconv"
	"strings"
	"time"
)

//go:embed templates/page.tmpl templates/content.tmpl templates/page.css templates/install.js templates/install-messages.json templates/tools.js templates/tool-api.js
var templateFS embed.FS

var (
	templates       = template.Must(template.ParseFS(templateFS, "templates/page.tmpl", "templates/content.tmpl"))
	pageCSS         = template.CSS(mustRead("templates/page.css")) // #nosec G203 -- our own embedded stylesheet
	installJS       = template.JS(mustRead("templates/install.js"))
	installMessages = template.JS(mustRead("templates/install-messages.json"))
	toolsJS         = template.JS(mustRead("templates/tools.js"))
)

func mustRead(name string) string {
	b, err := templateFS.ReadFile(name)
	if err != nil {
		panic(err)
	}
	return string(b)
}

// Report reasons accepted by the report form, in display order.
var reportReasons = []struct{ Value, Label string }{
	{"illegal", "Illegal content"},
	{"harmful", "Harmful or abusive"},
	{"privacy", "Private information"},
	{"spam", "Spam or scam"},
	{"other", "Something else"},
}

// ReportReasons returns the reason values of the report form (the
// claudex_share_reports.reason check constraint).
func ReportReasons() []string {
	out := make([]string, len(reportReasons))
	for i, r := range reportReasons {
		out[i] = r.Value
	}
	return out
}

func validReason(v string) bool {
	for _, r := range reportReasons {
		if r.Value == v {
			return true
		}
	}
	return false
}

// reportCategory is one choice of the report form: the live claude.ai
// report form's categories (2026-10-12), keyed as the app sends them, with
// the service reason each is filed under; "" for the four the live form
// sends to another form (copyright, trademark, private information, court
// orders), which this form refuses.
type reportCategory struct{ Value, Label, Reason string }

// reportCategories is the live order (kept in step with
// sharing.ReportCategoryOrder, which this package cannot import).
var reportCategories = []reportCategory{
	{"copyright_infringement", "Copyright infringement", ""},
	{"trademark_infringement", "Trademark infringement", ""},
	{"child_safety", "Child safety/sexual abuse", "illegal"},
	{"fraud", "Fraud", "illegal"},
	{"sexually_explicit_content", "Sexually Explicit content", "harmful"},
	{"non_consensual_intimate_imagery", "Non-consensual intimate imagery", "harmful"},
	{"violence_and_hate", "Violence and/or hate speech", "harmful"},
	{"illegal_goods", "Illegal goods", "illegal"},
	{"court_order", "Court order", ""},
	{"private_or_confidential_information", "Private/confidential information", ""},
	{"defamation", "Defamation", "illegal"},
	{"other_illegal", "Other illegal or unlawful content", "illegal"},
	{"violation_of_terms", "Violation of terms or usage policy", "other"},
}

// categoryReason is the service reason of a category the form takes.
func categoryReason(v string) (string, bool) {
	for _, c := range reportCategories {
		if c.Value == v {
			return c.Reason, c.Reason != ""
		}
	}
	return "", false
}

// MaxReporter is the longest reporter name or e-mail kept, in characters.
const MaxReporter = 255

// MaxReportDetail is the longest report detail kept, in characters.
const MaxReportDetail = 1000

// ---- security headers (design R1 5.2 and 5.7) ----

func setCommonHeaders(h http.Header) {
	h.Set("X-Robots-Tag", "noindex, nofollow, noarchive")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
}

// PageCSP is the base policy of share, status and report pages: no scripts,
// a nonce stylesheet, content-origin artifact frames and same-origin forms.
// Artifact pages additionally allow our nonce install/tool scripts, a data
// manifest and authenticated same-origin RPC; their frames remain opaque.
func PageCSP(nonce string, o Options) string {
	return pageCSP(nonce, resolve(o))
}

func pageCSP(nonce string, r resolved) string {
	frames := "'self'"
	if r.hasContent {
		frames = r.content.origin
	}
	return "default-src 'none'; style-src 'nonce-" + nonce + "'; img-src 'self' data:; frame-src " + frames +
		"; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
}

func setPageHeaders(h http.Header, nonce string, r resolved) {
	setCommonHeaders(h)
	h.Set("Content-Security-Policy", pageCSP(nonce, r))
	h.Set("X-Frame-Options", "DENY")
	h.Set("Cross-Origin-Opener-Policy", "same-origin")
	h.Set("Content-Type", "text/html; charset=utf-8")
}

// ContentCSP is the policy of an artifact document: a CSP sandbox (the
// document gets an opaque origin even when opened directly, so it can read
// no cookie and no storage of the site), inline script and style, the
// embedded Mermaid runtime, data: and blob: media, no network, and framing
// only by the share pages.
func ContentCSP(o Options) string { return contentCSP(resolve(o)) }

func contentCSP(r resolved) string {
	scripts := "'unsafe-inline' 'self'"
	ancestors := "'self'"
	switch {
	case r.hasContent:
		scripts += " " + r.content.origin + r.content.path + PathPrefix + "/_assets/"
		ancestors = r.public.origin
	case r.hasPublic:
		scripts += " " + r.public.origin + r.public.path + PathPrefix + "/_assets/"
		ancestors += " " + r.public.origin
	}
	return "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; default-src 'none'; script-src " + scripts +
		"; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'" +
		"; form-action 'none'; base-uri 'none'; frame-ancestors " + ancestors
}

func setContentHeaders(h http.Header, r resolved, contentType string) {
	setCommonHeaders(h)
	h.Del("X-Frame-Options") // framing is governed by frame-ancestors
	h.Set("Content-Security-Policy", contentCSP(r))
	h.Set("Cross-Origin-Resource-Policy", "same-site")
	h.Set("Content-Type", contentType)
}

// rawCSP keeps a source download inert even if a browser renders it.
const rawCSP = "default-src 'none'; sandbox"

// PathPrefix is the root path of the public pages (routes.go PagePrefix).
const PathPrefix = "/s"

func newNonce() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand does not fail on supported platforms; a fixed nonce
		// would still only allow our own inline stylesheet.
		return "claudex"
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// ---- view models ----

type artifactView struct {
	Title  string
	Label  string
	Badge  string
	Src    string
	RawSrc string
}

type messageView struct {
	User      bool
	Text      string
	HTML      template.HTML
	Activity  []string
	Artifacts []artifactView
}

type pageData struct {
	ScreenshotURL   string
	ToolsJS         template.JS
	InstallJS       template.JS
	InstallMessages template.JS
	Nonce           string
	CSS             template.CSS
	DocTitle        string
	SiteName        string
	Title           string
	Meta            string
	SharedOn        string
	UsagePolicyURL  string
	ReportAction    string
	Reasons         []struct{ Value, Label string }
	Categories      []reportCategory
	Messages        []messageView
	Artifact        *artifactView
	// Status pages.
	Heading  string
	Detail   string
	BackHref string
}

// links builds the URLs a page uses. Without a content origin they are
// relative to the page (/s/<token>), so a path prefix added by a reverse
// proxy keeps working.
type links struct {
	r     resolved
	token string
}

func (l links) content(n int) string {
	if l.r.hasContent {
		return l.r.content.origin + l.r.content.path + PathPrefix + "/" + l.token + "/a/" + strconv.Itoa(n)
	}
	return "./" + l.token + "/a/" + strconv.Itoa(n)
}

func (l links) raw(n int) string {
	if l.r.hasContent {
		return l.r.content.origin + l.r.content.path + PathPrefix + "/" + l.token + "/raw/" + strconv.Itoa(n)
	}
	return "./" + l.token + "/raw/" + strconv.Itoa(n)
}

func (l links) report() string { return "./" + l.token + "/report" }

var modeLabels = map[string]string{"chat": "Chat", "cowork": "Cowork", "code": "Code"}

func sharedOn(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format("Jan 2, 2006")
}

func artifactBadge(a Artifact) (badge, label string) {
	switch a.Language {
	case LanguageHTML:
		return "HTML", "Artifact · HTML"
	case LanguageSVG:
		return "SVG", "Artifact · SVG"
	case LanguageMarkdown:
		return "MD", "Artifact · Markdown"
	case LanguageMermaid:
		return "MMD", "Artifact · Diagram"
	}
	lang := langClass(a.CodeLanguage)
	if lang == "" {
		return "CODE", "Artifact · Code"
	}
	badge = strings.ToUpper(lang)
	if len(badge) > 4 {
		badge = badge[:4]
	}
	return badge, "Artifact · Code · " + lang
}

func (l links) artifact(snap Snapshot, n int) artifactView {
	a := snap.Artifacts[n]
	title := plainText(a.Title, 200)
	if title == "" {
		title = "Untitled artifact"
	}
	badge, label := artifactBadge(a)
	return artifactView{Title: title, Label: label, Badge: badge, Src: l.content(n), RawSrc: l.raw(n)}
}

func baseData(r resolved, nonce string) pageData {
	return pageData{Nonce: nonce, CSS: pageCSS, SiteName: r.siteName, UsagePolicyURL: r.usagePolicy}
}

// buildPage turns a share into the page model.
func buildPage(share *Share, token string, r resolved, nonce string, canReport bool) pageData {
	snap := share.Snapshot
	l := links{r: r, token: token}
	d := baseData(r, nonce)
	d.Title = plainText(snap.Title, 200)
	if d.Title == "" {
		if snap.Kind == KindArtifact {
			d.Title = "Shared artifact"
		} else {
			d.Title = "Shared chat"
		}
	}
	d.DocTitle = d.Title + " · " + r.siteName
	d.SharedOn = sharedOn(share.SharedAt)
	var meta []string
	if d.SharedOn != "" {
		meta = append(meta, "Shared "+d.SharedOn)
	}
	if m := modeLabels[snap.Mode]; m != "" {
		meta = append(meta, m)
	}
	if m := plainText(snap.ModelLabel, 80); m != "" {
		meta = append(meta, m)
	}
	d.Meta = strings.Join(meta, " · ")
	if canReport {
		d.ReportAction = l.report()
		d.Reasons = reportReasons
		d.Categories = reportCategories
	}
	if snap.Kind == KindArtifact {
		d.InstallJS, d.InstallMessages = installJS, installMessages
		d.ToolsJS = toolsJS
		a := l.artifact(snap, 0)
		d.Artifact = &a
		return d
	}
	referenced := make([]bool, len(snap.Artifacts))
	lastAssistant := -1
	for _, m := range snap.Messages {
		if m.Role == "user" {
			d.Messages = append(d.Messages, messageView{User: true, Text: strings.TrimSpace(m.Text)})
			continue
		}
		v := messageView{HTML: Markdown(m.Text)}
		for _, a := range m.Activity {
			if t := plainText(a, 160); t != "" {
				v.Activity = append(v.Activity, t)
			}
		}
		for _, n := range m.Artifacts {
			v.Artifacts = append(v.Artifacts, l.artifact(snap, n))
			referenced[n] = true
		}
		d.Messages = append(d.Messages, v)
		lastAssistant = len(d.Messages) - 1
	}
	// Artifacts no message points at still belong to the share: show them
	// after the last reply.
	for n, seen := range referenced {
		if seen {
			continue
		}
		if lastAssistant < 0 {
			d.Messages = append(d.Messages, messageView{})
			lastAssistant = len(d.Messages) - 1
		}
		d.Messages[lastAssistant].Artifacts = append(d.Messages[lastAssistant].Artifacts, l.artifact(snap, n))
	}
	return d
}

func execute(name string, data any) ([]byte, error) {
	var buf bytes.Buffer
	if err := templates.ExecuteTemplate(&buf, name, data); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// Render writes the share page for snap (design interface
// viewer.Render(w, Snapshot, Options)): a conversation page, or the framed
// artifact page for an artifact share. token is the share's token, sharedAt
// the snapshot time for the footer. The report form is shown when
// opts.AllowReports is set; the caller must then accept the form post.
func Render(w http.ResponseWriter, token string, snap Snapshot, sharedAt time.Time, opts Options) error {
	if err := snap.Check(); err != nil {
		return err
	}
	r := resolve(opts)
	return writePageWithOptions(w, http.StatusOK, &Share{Snapshot: snap, SharedAt: sharedAt}, token, r, r.reports, opts)
}

func writePage(w http.ResponseWriter, status int, share *Share, token string, r resolved, canReport bool) error {
	return writePageWithOptions(w, status, share, token, r, canReport, Options{})
}

func writePageWithOptions(w http.ResponseWriter, status int, share *Share, token string, r resolved, canReport bool, opts Options) error {
	nonce := newNonce()
	d := buildPage(share, token, r, nonce, canReport)
	d.ScreenshotURL = opts.ScreenshotURL
	if d.Artifact != nil {
		if opts.ArtifactURL != "" {
			d.Artifact.Src = opts.ArtifactURL
		}
		if opts.RawURL != "" {
			d.Artifact.RawSrc = opts.RawURL
		}
	}
	name := "conversation"
	if share.Snapshot.Kind == KindArtifact {
		name = "artifact"
	}
	body, err := execute(name, d)
	if err != nil {
		return err
	}
	setPageHeaders(w.Header(), nonce, r)
	if snap := share.Snapshot; snap.Kind == KindArtifact {
		policy := pageCSP(nonce, r)
		if opts.FrameSource != "" {
			policy = strings.Replace(policy, "frame-src 'self'", "frame-src "+opts.FrameSource, 1)
		}
		w.Header().Set("Content-Security-Policy", policy+"; script-src 'nonce-"+nonce+"'; manifest-src data:; connect-src 'self'")
	}
	w.WriteHeader(status)
	_, err = w.Write(body)
	return err
}

// Status pages.
const (
	notFoundHeading = "This link isn't available"
	notFoundDetail  = "The shared content may have been unshared, or the link may be incomplete."
	removedHeading  = "This content was removed by the administrator"
)

// RenderNotFound writes the 404 page used for unknown, revoked and expired
// links alike, and while sharing is switched off.
func RenderNotFound(w http.ResponseWriter, opts Options) {
	writeStatus(w, http.StatusNotFound, resolve(opts), notFoundHeading, notFoundDetail, "")
}

// RenderRemoved writes the 410 page of a share an administrator took down.
func RenderRemoved(w http.ResponseWriter, opts Options) {
	r := resolve(opts)
	writeStatus(w, http.StatusGone, r, removedHeading, "The administrator of "+r.siteName+" took this shared content down.", "")
}

func writeStatus(w http.ResponseWriter, status int, r resolved, heading, detail, back string) {
	nonce := newNonce()
	d := baseData(r, nonce)
	d.Heading, d.Detail, d.BackHref = heading, detail, back
	d.DocTitle = heading + " · " + r.siteName
	body, err := execute("status", d)
	setPageHeaders(w.Header(), nonce, r)
	if err != nil {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(heading + "\n"))
		return
	}
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// ---- artifact documents ----

type contentData struct {
	Title    string
	CSS      template.CSS
	HTML     template.HTML
	Code     string
	Lang     string
	AssetSrc string
}

// mermaidAssetSrc is relative to /s/<token>/a/<n>.
const mermaidAssetSrc = "../../_assets/" + mermaidAsset

// RenderArtifact writes artifact n's document for the sandboxed frame. HTML
// and SVG are sent as they are, under the content CSP; Markdown, code and
// Mermaid are wrapped in a small document.
func RenderArtifact(w http.ResponseWriter, a Artifact, opts Options) error {
	return writeArtifact(w, a, resolve(opts))
}

func writeArtifact(w http.ResponseWriter, a Artifact, r resolved) error {
	var body []byte
	contentType := "text/html; charset=utf-8"
	d := contentData{Title: plainText(a.Title, 200), CSS: pageCSS}
	var err error
	switch a.Language {
	case LanguageHTML:
		body = []byte(ToolDocument(a.Content, a.Language))
	case LanguageSVG:
		body = []byte(ToolDocument(a.Content, a.Language))
		contentType = "image/svg+xml; charset=utf-8"
	case LanguageMarkdown:
		d.HTML = Markdown(a.Content)
		body, err = execute("content-markdown", d)
	case LanguageMermaid:
		d.Code, d.AssetSrc = a.Content, mermaidAssetSrc
		body, err = execute("content-mermaid", d)
	default:
		d.Code, d.Lang = a.Content, langClass(a.CodeLanguage)
		body, err = execute("content-code", d)
	}
	if err != nil {
		return err
	}
	setContentHeaders(w.Header(), r, contentType)
	w.WriteHeader(http.StatusOK)
	_, err = w.Write(body)
	return err
}

var codeExtensions = map[string]string{
	"javascript": "js", "typescript": "ts", "python": "py", "ruby": "rb", "rust": "rs", "golang": "go",
	"kotlin": "kt", "csharp": "cs", "c#": "cs", "c++": "cpp", "shell": "sh", "bash": "sh", "zsh": "sh",
	"markdown": "md", "yaml": "yml", "text": "txt", "plaintext": "txt",
}

// RawFilename is the download name of an artifact's source.
func RawFilename(a Artifact) string {
	ext := "txt"
	switch a.Language {
	case LanguageHTML:
		ext = "html"
	case LanguageSVG:
		ext = "svg"
	case LanguageMarkdown:
		ext = "md"
	case LanguageMermaid:
		ext = "mmd"
	default:
		if l := langClass(a.CodeLanguage); l != "" {
			if e, ok := codeExtensions[l]; ok {
				ext = e
			} else if !strings.ContainsAny(l, "#+.") && len(l) <= 10 {
				ext = l
			}
		}
	}
	var b buf
	for _, c := range strings.ToLower(plainText(a.Title, 80)) {
		switch {
		case c >= 'a' && c <= 'z' || c >= '0' && c <= '9':
			b.r(c)
		case b.Len() > 0 && !strings.HasSuffix(b.String(), "-"):
			b.c('-')
		}
	}
	name := strings.Trim(b.String(), "-")
	if name == "" {
		name = "artifact"
	}
	return name + "." + ext
}

// RenderRaw writes an artifact's source as a plain-text download.
func RenderRaw(w http.ResponseWriter, a Artifact) error {
	h := w.Header()
	setCommonHeaders(h)
	h.Del("X-Frame-Options")
	h.Set("Content-Security-Policy", rawCSP)
	h.Set("Content-Type", "text/plain; charset=utf-8")
	h.Set("Content-Disposition", `attachment; filename="`+RawFilename(a)+`"`)
	w.WriteHeader(http.StatusOK)
	_, err := w.Write([]byte(a.Content))
	return err
}
