package sharing

import (
	"encoding/json"
	"html/template"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/sharing/viewer"
)

// Renderer draws the public pages. The component looks a share up, decides
// the status (404 not available, 410 removed) and sets the headers every
// page shares (robots, referrer, cache); the renderer writes Content-Type,
// its own Content-Security-Policy and X-Frame-Options, the status and the
// body.
//
// sharing/viewer (R1-V) implements it and installs itself with
// RegisterRenderer from an init function; sharing cannot import viewer
// (viewer renders the Snapshot types of this package), so the binary must
// import the viewer package somewhere for its init to run. Until then the
// built-in renderer below serves plain, escaped pages.
type Renderer interface {
	// Page writes GET /s/<token> with status 200.
	Page(w http.ResponseWriter, v *PageView) error
	// Artifact writes the document of one artifact (the iframe content,
	// GET /s/<token>/a/<n>) with status 200. It must answer with a CSP
	// sandbox so the document runs in an opaque origin even when opened
	// directly.
	Artifact(w http.ResponseWriter, v *ArtifactView) error
	// Notice writes a short page (not available, removed, report received)
	// with the given status.
	Notice(w http.ResponseWriter, status int, v *NoticeView) error
	// Asset serves GET /s/_assets/<path> (for example the mermaid runtime
	// used inside artifact documents); false means not found.
	Asset(w http.ResponseWriter, r *http.Request, path string) bool
}

var renderer atomic.Pointer[rendererBox]

type rendererBox struct{ r Renderer }

// RegisterRenderer installs the page renderer (nil restores the built-in
// one). The component reads it on every request, so the order of package
// initialization does not matter.
func RegisterRenderer(r Renderer) {
	if r == nil {
		renderer.Store(nil)
		return
	}
	renderer.Store(&rendererBox{r: r})
}

func currentRenderer() Renderer {
	if b := renderer.Load(); b != nil && b.r != nil {
		return b.r
	}
	return builtinRenderer{}
}

// PageView is what the renderer needs for GET /s/<token>.
type PageView struct {
	DisplayName   string
	ScreenshotURL string
	Token         string
	Kind          Kind
	Title         string
	SiteName      string
	CreatedAt     time.Time
	SnapshotAt    time.Time
	ExpiresAt     *time.Time
	Snapshot      *Snapshot
	// ArtifactURLs[i] is the iframe src of Snapshot.Artifacts[i]: a path on
	// this host, or an absolute URL on the separate content host.
	ArtifactURLs []string
	// RawURLs[i] downloads the source of Snapshot.Artifacts[i] as text.
	RawURLs []string
	// FrameSource is the CSP frame-src value for the artifact iframes:
	// 'self' or the content origin.
	FrameSource string
	// ReportURL is the form action (POST category, reporter_name,
	// reporter_email, notes, opt_out_of_training) of the Report form; ""
	// when the administrator turned reports off.
	ReportURL string
	// ReportReasons lists the service reasons, in display order (the form
	// before the live categories posted one; still accepted).
	ReportReasons []string
	// ReportCategories are the form's choices: the live report form's
	// categories, in its order.
	ReportCategories []ReportCategory
	// UsagePolicyURL is the administrator's usage policy link, "" when none.
	UsagePolicyURL string
}

// ArtifactView is what the renderer needs for GET /s/<token>/a/<n>.
type ArtifactView struct {
	Token    string
	Index    int
	Artifact SnapshotArtifact
	// FrameAncestors is the CSP frame-ancestors value: 'self' or the public
	// origin when artifact documents live on a separate content host.
	FrameAncestors string
	// AssetBase is the path of the static assets ("/s/_assets/") on the
	// host serving this document.
	AssetBase string
}

// NoticeKind names the notice pages.
type NoticeKind string

const (
	NoticeNotFound       NoticeKind = "not_found"       // 404: unknown, revoked, expired, sharing off
	NoticeRemoved        NoticeKind = "removed"         // 410: taken down by the administrator
	NoticeReportReceived NoticeKind = "report_received" // 200: after POST /s/<token>/report
	NoticeReportInvalid  NoticeKind = "report_invalid"  // 400: the report form was incomplete
	NoticeRateLimited    NoticeKind = "rate_limited"    // 429: too many reports
)

// NoticeView is what the renderer needs for a notice page.
type NoticeView struct {
	Kind     NoticeKind
	SiteName string
	// BackURL is the share page to return to ("" when there is none).
	BackURL string
}

// ReportCategory is one choice of the report form (live claude.ai bundle,
// 2026-10-12: the report form's 13 categories, its enum keys lower-cased as
// the app sends them). Takes is false for the categories the form sends
// elsewhere (copyright, trademark, private information, court orders): the
// form then shows a sentence instead of its fields, and they are refused.
type ReportCategory struct {
	Value string
	Label string
	Takes bool
}

// ReportCategoryOrder lists the report form's categories in the live order.
var ReportCategoryOrder = []ReportCategory{
	{"copyright_infringement", "Copyright infringement", false},
	{"trademark_infringement", "Trademark infringement", false},
	{"child_safety", "Child safety/sexual abuse", true},
	{"fraud", "Fraud", true},
	{"sexually_explicit_content", "Sexually Explicit content", true},
	{"non_consensual_intimate_imagery", "Non-consensual intimate imagery", true},
	{"violence_and_hate", "Violence and/or hate speech", true},
	{"illegal_goods", "Illegal goods", true},
	{"court_order", "Court order", false},
	{"private_or_confidential_information", "Private/confidential information", false},
	{"defamation", "Defamation", true},
	{"other_illegal", "Other illegal or unlawful content", true},
	{"violation_of_terms", "Violation of terms or usage policy", true},
}

// ReportReasonOrder is the display order of the report reasons.
var ReportReasonOrder = []string{"illegal", "harmful", "privacy", "spam", "other"}

// NoticeText returns the English title and body of a notice.
func NoticeText(k NoticeKind) (title, body string) {
	switch k {
	case NoticeRemoved:
		return "Content removed", "This content was removed by the administrator."
	case NoticeReportReceived:
		return "Report received", "Thanks, the administrator will review this."
	case NoticeReportInvalid:
		return "Report not sent", "Choose a report reason this form takes and try again."
	case NoticeRateLimited:
		return "Too many reports", "You've sent too many reports. Try again later."
	default:
		return "Link not available", "This link isn't available. It may have been removed or it may have expired."
	}
}

// ReportReasonLabel is the English label of a report reason.
func ReportReasonLabel(reason string) string {
	switch reason {
	case "illegal":
		return "Illegal content"
	case "harmful":
		return "Harmful or dangerous"
	case "privacy":
		return "Private information"
	case "spam":
		return "Spam or scam"
	default:
		return "Something else"
	}
}

// Security headers of the built-in renderer (the viewer sets its own).
const (
	builtinPageCSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; " +
		"base-uri 'none'; frame-ancestors 'none'"
	builtinArtifactCSP = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; default-src 'none'; " +
		"script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; " +
		"connect-src 'none'; form-action 'none'; base-uri 'none'"
)

// builtinRenderer serves plain pages until the viewer is installed: every
// text is escaped and shown as preformatted text, HTML and SVG artifacts run
// only inside a sandboxed iframe, and the page itself has no script.
type builtinRenderer struct{}

// CLAUDEX: LOGIN the header carries the Claudex star and serif wordmark
// (linking to the web app at /) and the notice page has the sign-in page's
// look (serif title, muted body, a secondary button); provisional, no
// reference capture. Styles stay inline, as the CSP above allows.
//
// The Report form is the live report form (live claude.ai bundle,
// 2026-10-12), as the app's Report dialog draws it: "Why are you reporting
// this?" with the 13 categories, then Your name, Your email and Additional
// information (all optional) once a category is chosen, or the "use this
// form" sentence for the categories it does not take, then "Opt out of
// training on this report", off by default: a checkbox drawn as the app's
// settings switch (36x20 track, 16px knob, 120ms knob move). The page runs
// no script, so CSS :has() shows the fields for the chosen category; a
// browser without it shows every field and the server refuses what the
// form does not take.

var builtinTemplates = template.Must(template.New("page").Funcs(template.FuncMap{
	"reasonLabel": ReportReasonLabel,
	"date":        func(t time.Time) string { return t.UTC().Format("Jan 2, 2006") },
	"sandboxed":   func(lang string) bool { return lang == "html" || lang == "svg" },
}).Parse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive"><meta name="referrer" content="no-referrer">
<title>{{if .Title}}{{.Title}} · {{end}}{{.SiteName}}</title>
<style>
:root{color-scheme:light dark;--bg:#faf9f5;--fg:#1f1e1d;--muted:#6b6a68;--bubble:#f0eee6;--line:#e5e3dc;--track:#c8c8c8;--on:#4177d1}
@media (prefers-color-scheme:dark){:root{--bg:#262624;--fg:#faf9f7;--muted:#a3a19b;--bubble:#303030;--line:#3a3a38;--track:#31302e;--on:#4076ce}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
header{display:flex;align-items:center;gap:12px;height:56px;padding:0 16px;border-bottom:1px solid var(--line)}
header span{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.brand{display:inline-flex;align-items:center;gap:6px;flex:none;color:var(--fg);text-decoration:none}
.brand .wm{font:400 22px/1 Georgia,"Times New Roman",serif;letter-spacing:-.3px;color:var(--fg)}
main{max-width:768px;margin:0 auto;padding:24px 16px}
.msg{white-space:pre-wrap;overflow-wrap:anywhere;margin:0 0 20px}
.user{background:var(--bubble);border-radius:18px;padding:10px 16px;margin-left:15%}
.act{color:var(--muted);font-size:13px;margin:-12px 0 20px}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.5 ui-monospace,Menlo,monospace}
iframe{width:100%;height:480px;border:1px solid var(--line);border-radius:8px;background:#fff}
.card{margin:0 0 20px}.card a{color:inherit;font-size:13px}
footer{max-width:768px;margin:0 auto;padding:16px;color:var(--muted);font-size:12px}
details{margin-top:12px}select,input,textarea,button{font:inherit}
.report{display:grid;gap:14px;max-width:480px;margin-top:12px}.report label{display:grid;gap:4px}
.report input:not([type=checkbox]),.report select,.report textarea{width:100%;box-sizing:border-box}
.report small{color:var(--muted);font-size:12px;line-height:17px}.report small+small{margin-top:4px}
.fields{display:grid;gap:14px}
.elsewhere{display:none;margin:0;padding:12px;border:1px solid var(--line);border-radius:8px;color:var(--muted);font-size:14px;line-height:20px}
.report:has(option[data-elsewhere]:checked) .elsewhere{display:block}
.report:has(option[data-elsewhere]:checked) .fields,.report:has(option[value=""]:checked) .fields{display:none}
.note{max-width:480px;color:var(--muted);font-size:12px}
</style></head><body>
<header><a class="brand" href="/"><svg class="star" viewBox="120 120 784 784" width="22" height="22" aria-hidden="true" focusable="false"><g fill="none" stroke="#d97757" stroke-width="64" stroke-linejoin="round"><path d="M392 492C282 362 362 182 582 162 632 262 622 402 392 492Z"/><path d="M469.3 398.1C526.9 237.8 722.8 217.1 850.1 397.6 788.5 490.9 662.3 552.3 469.3 398.1Z"/><path d="M589.3 418.1C756.9 387.8 872.8 547.1 780.1 747.6 668.5 740.9 552.3 662.3 589.3 418.1Z"/><path d="M632 532C742 662 662 842 442 862 392 762 402 622 632 532Z"/><path d="M554.7 625.9C497.1 786.2 301.2 806.9 173.9 626.4 235.5 533.1 361.7 471.7 554.7 625.9Z"/><path d="M434.7 605.9C267.1 636.2 151.2 476.9 243.9 276.4 355.5 283.1 471.7 361.7 434.7 605.9Z"/></g></svg><span class="wm">{{.SiteName}}</span></a>{{if .Title}}<span>{{.Title}}</span>{{end}}</header>
<main>{{if .DisplayName}}<p class="note">{{.DisplayName}}</p>{{end}}
{{range $i, $m := .Messages}}<div class="msg{{if eq $m.Role "user"}} user{{end}}">{{$m.Text}}</div>
{{if $m.Activity}}<div class="act">{{range $j, $a := $m.Activity}}{{if $j}} · {{end}}{{$a}}{{end}}</div>{{end}}
{{end}}
{{range .Artifacts}}<div class="card"><div><b>{{if .Title}}{{.Title}}{{else}}Artifact{{end}}</b></div>
{{if sandboxed .Language}}<iframe src="{{.URL}}" sandbox="allow-scripts" referrerpolicy="no-referrer" title="{{.Title}}"></iframe>
{{else}}<pre>{{.Content}}</pre>{{end}}
<a href="{{.URL}}" rel="noopener noreferrer" target="_blank">Open full page</a> · <a href="{{.Raw}}" rel="nofollow">View source</a></div>
{{end}}
</main>
<footer>Shared from {{.SiteName}} on {{date .SnapshotAt}}. Content is written by the person who shared it and AI.
{{if .ReportURL}}<details><summary>Report</summary><form class="report" method="post" action="{{.ReportURL}}">
<label>Why are you reporting this?<select name="category" required><option value="" selected disabled>Select report reason</option>{{range .Categories}}<option value="{{.Value}}"{{if not .Takes}} data-elsewhere{{end}}>{{.Label}}</option>{{end}}</select></label>
<p class="elsewhere" role="note">Please use this form to report copyright infringement.</p>
<div class="fields">
<label>Your name<input name="reporter_name" maxlength="255" placeholder="Optional"></label>
<label>Your email<small>If provided, we may contact you for additional information or updates on this report</small><input type="email" name="reporter_email" maxlength="255" placeholder="Optional"></label>
<label>Additional information<small>Please provide any additional information to help us understand your request.</small><small>If you are reporting the content as illegal/unlawful, please describe in detail why you believe the identified content is illegal/unlawful, citing specific provisions of law wherever possible.</small><small>If you are reporting the content as violating our policies (including our terms or Usage Policy), please describe in detail why you believe the identified content is in violation of our policies, with specific citations to our policies wherever possible.</small><textarea name="notes" rows="3" maxlength="1000" placeholder="Optional"></textarea></label>
<div><p class="switch"><label for="report-opt-out">Opt out of training on this report</label><input id="report-opt-out" type="checkbox" role="switch" name="opt_out_of_training" value="on" aria-describedby="report-opt-out-note"></p>
<p id="report-opt-out-note" class="note">Reports help the administrator of {{.SiteName}} keep this service safe and enforce its usage policy. Unless you opt out, the administrator may use reports to train models for moderation. Opt out of this use by changing the toggle above.</p></div>
<p><button type="submit">Report</button></p></div></form></details>{{end}}
</footer></body></html>
{{define "notice"}}<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive"><title>{{.Title}} · {{.SiteName}}</title>
<style>
:root{color-scheme:light dark;--bg:#faf9f5;--fg:#141413;--muted:#6b6a65;--secondary:#efede6}
@media (prefers-color-scheme:dark){:root{--bg:#111111;--fg:#f7f7f5;--muted:#8c8c8a;--secondary:#292929}}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.head{padding:24px 48px 0}
.brand{display:inline-flex;align-items:center;gap:6px;color:var(--fg);text-decoration:none}
.brand .wm{font:400 28px/1 Georgia,"Times New Roman",serif;letter-spacing:-.4px}
main{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px 24px 88px;text-align:center}
h1{max-width:760px;margin:0;font:400 clamp(34px,5.6vw,56px)/1.1 Georgia,"Times New Roman",serif;letter-spacing:-1px}
p{max-width:560px;margin:14px 0 0;font:400 20px/28px Georgia,"Times New Roman",serif;color:var(--muted)}
.button{display:inline-flex;align-items:center;height:36px;margin-top:32px;padding:0 14px;border-radius:8px;background:var(--secondary);color:var(--fg);font-size:15px;text-decoration:none}
.button:hover{opacity:.85}
@media (max-width:640px){.head{padding:16px 16px 0}main{justify-content:flex-start;padding:64px 16px 48px}}
</style></head>
<body><header class="head"><a class="brand" href="/"><svg class="star" viewBox="120 120 784 784" width="22" height="22" aria-hidden="true" focusable="false"><g fill="none" stroke="#d97757" stroke-width="64" stroke-linejoin="round"><path d="M392 492C282 362 362 182 582 162 632 262 622 402 392 492Z"/><path d="M469.3 398.1C526.9 237.8 722.8 217.1 850.1 397.6 788.5 490.9 662.3 552.3 469.3 398.1Z"/><path d="M589.3 418.1C756.9 387.8 872.8 547.1 780.1 747.6 668.5 740.9 552.3 662.3 589.3 418.1Z"/><path d="M632 532C742 662 662 842 442 862 392 762 402 622 632 532Z"/><path d="M554.7 625.9C497.1 786.2 301.2 806.9 173.9 626.4 235.5 533.1 361.7 471.7 554.7 625.9Z"/><path d="M434.7 605.9C267.1 636.2 151.2 476.9 243.9 276.4 355.5 283.1 471.7 361.7 434.7 605.9Z"/></g></svg><span class="wm">{{.SiteName}}</span></a></header>
<main><h1>{{.Title}}</h1><p>{{.Body}}</p>{{if .Back}}<a class="button" href="{{.Back}}">Back</a>{{else}}<a class="button" href="/">Go to {{.SiteName}}</a>{{end}}</main></body></html>
{{end}}`))

type builtinArtifact struct {
	SnapshotArtifact
	URL, Raw string
}

func (builtinRenderer) Page(w http.ResponseWriter, v *PageView) error {
	if v.Kind == KindArtifact && v.Snapshot != nil {
		body, err := json.Marshal(v.Snapshot)
		if err != nil {
			return err
		}
		snapshot, err := viewer.DecodeSnapshot(body)
		if err != nil {
			return err
		}
		return viewer.Render(w, v.Token, snapshot, v.SnapshotAt, viewer.Options{
			ScreenshotURL: screenshotURL(v),
			SiteName:      v.SiteName, UsagePolicyURL: v.UsagePolicyURL, AllowReports: v.ReportURL != "",
			ArtifactURL: firstURL(v.ArtifactURLs), RawURL: firstURL(v.RawURLs), FrameSource: v.FrameSource,
		})
	}
	data := struct {
		*PageView
		Messages   []SnapshotMessage
		Artifacts  []builtinArtifact
		Categories []ReportCategory
	}{PageView: v, Categories: v.ReportCategories}
	if v.Snapshot != nil {
		data.Messages = v.Snapshot.Messages
		for i, a := range v.Snapshot.Artifacts {
			ba := builtinArtifact{SnapshotArtifact: a}
			if i < len(v.ArtifactURLs) {
				ba.URL = v.ArtifactURLs[i]
			}
			if i < len(v.RawURLs) {
				ba.Raw = v.RawURLs[i]
			}
			data.Artifacts = append(data.Artifacts, ba)
		}
	}
	csp := builtinPageCSP + "; frame-src " + v.FrameSource
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Content-Security-Policy", csp)
	h.Set("X-Frame-Options", "DENY")
	w.WriteHeader(http.StatusOK)
	return builtinTemplates.Execute(w, data)
}

func screenshotURL(v *PageView) string {
	if v.ScreenshotURL != "" {
		return v.ScreenshotURL
	}
	if v.Snapshot != nil && v.Snapshot.Screenshot != "" {
		return sharePath(v.Token) + "/screenshot"
	}
	return ""
}

func firstURL(urls []string) string {
	if len(urls) == 0 {
		return ""
	}
	return urls[0]
}

func (builtinRenderer) Artifact(w http.ResponseWriter, v *ArtifactView) error {
	h := w.Header()
	h.Set("Content-Security-Policy", builtinArtifactCSP+"; frame-ancestors "+v.FrameAncestors)
	h.Del("X-Frame-Options")
	h.Set("Cross-Origin-Resource-Policy", "same-site")
	h.Set("X-Content-Type-Options", "nosniff")
	switch v.Artifact.Language {
	case "html":
		h.Set("Content-Type", "text/html; charset=utf-8")
	case "svg":
		h.Set("Content-Type", "image/svg+xml; charset=utf-8")
	default:
		// Markdown, mermaid and code are shown as text until the viewer
		// renders them.
		h.Set("Content-Type", "text/plain; charset=utf-8")
	}
	w.WriteHeader(http.StatusOK)
	_, err := w.Write([]byte(viewer.ToolDocument(v.Artifact.Content, v.Artifact.Language)))
	return err
}

func (builtinRenderer) Notice(w http.ResponseWriter, status int, v *NoticeView) error {
	title, body := NoticeText(v.Kind)
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
	h.Set("X-Frame-Options", "DENY")
	w.WriteHeader(status)
	return builtinTemplates.ExecuteTemplate(w, "notice", struct {
		Title, Body, SiteName, Back string
	}{title, body, v.SiteName, v.BackURL})
}

func (builtinRenderer) Asset(http.ResponseWriter, *http.Request, string) bool { return false }

// rawFileName is the download name of an artifact source.
func rawFileName(a SnapshotArtifact, n int) string {
	ext := map[string]string{"html": ".html", "svg": ".svg", "markdown": ".md", "mermaid": ".mmd"}[a.Language]
	if ext == "" {
		ext = ".txt"
	}
	base := strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			return r
		case r == ' ' || r == '.':
			return '-'
		}
		return -1
	}, a.Title)
	base = strings.Trim(base, "-")
	if len(base) > 60 {
		base = base[:60]
	}
	if base == "" {
		base = "artifact-" + strconv.Itoa(n+1)
	}
	return base + ext
}
