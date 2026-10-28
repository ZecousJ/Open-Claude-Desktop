package service

import (
	_ "embed"
	"html"
	"strings"
)

// emailLogoPNG is the app icon at 56px (2x the 28px it shows at), sent
// inside each message that shows it (cid:claudex-logo): QQ Mail and others
// block or fail to fetch outside images (owner, 2026-10-02).
//
//go:embed assets/email-logo.png
var emailLogoPNG []byte

// emailLogoCID is the Content-ID the layout's logo refers to.
const emailLogoCID = "claudex-logo"

// CLAUDEX: one layout for every email the service sends, drawn as the
// Claudex sign-in page's light theme (owner, 2026-10-02): a #faf9f5 page,
// the app icon and the serif wordmark above a white card with a #e8e6dc
// rim and a 16px radius, the title in the serif face, a 3px accent line
// above it, dark rounded buttons, codes in a large monospace block on
// #f5f4ef, and one line of grey type under the card. Styles are inline as
// well as in <style>, since some mail clients drop the stylesheet.

// Email accents: the brand, and the states a message can carry.
const (
	EmailAccentBrand   = "#c6613f"
	EmailAccentSuccess = "#2e7d4f"
	EmailAccentWarning = "#b7791f"
	EmailAccentDanger  = "#b3261e"
)

// emailAccent maps the colours older templates passed (indigo, sky, amber,
// red…) onto the Claudex accents: red for danger, amber or orange for a
// warning, green for success, the brand colour for everything else.
func emailAccent(color string) string {
	switch strings.ToLower(strings.TrimSpace(color)) {
	case "#dc2626", "#ef4444", "#b91c1c", "#e11d48", "#b3261e", "#991b1b":
		return EmailAccentDanger
	case "#f59e0b", "#d97706", "#ea580c", "#f97316", "#b7791f", "#ca8a04":
		return EmailAccentWarning
	case "#16a34a", "#22c55e", "#059669", "#10b981", "#2e7d4f", "#15803d":
		return EmailAccentSuccess
	default:
		return EmailAccentBrand
	}
}

// ClaudexEmailLayout is what one email shows.
type ClaudexEmailLayout struct {
	// SiteName signs the footer and names the logo (already HTML; may be a
	// {{site_name}} placeholder).
	SiteName string
	// SiteURL is the service's address (already HTML; may be a {{site_url}}
	// placeholder). The logo no longer loads from it: it travels inside the
	// message (emailLogoCID).
	SiteURL string
	// Title heads the card (already HTML).
	Title string
	// Accent colours the line above the title (EmailAccent*; any older
	// template colour is mapped by emailAccent).
	Accent string
	// Content is the card's body (already HTML): paragraphs, and the
	// "button", "code", "muted" and "panel" classes below.
	Content string
	// Footer replaces the default footer line (already HTML).
	Footer string
}

const claudexEmailFont = `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', Roboto, Helvetica, Arial, sans-serif`
const claudexEmailSerif = `Georgia, 'Times New Roman', 'Songti SC', 'SimSun', serif`
const claudexEmailMono = `'SF Mono', SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace`

// ClaudexEmailHTML renders the layout as a full HTML document.
func ClaudexEmailHTML(l ClaudexEmailLayout) string {
	accent := emailAccent(l.Accent)
	site := strings.TrimSpace(l.SiteName)
	if site == "" {
		site = "Claudex"
	}
	footer := l.Footer
	if strings.TrimSpace(footer) == "" {
		footer = "This email was sent by " + site + ". Please do not reply directly."
	}
	logo := `<img src="cid:` + emailLogoCID + `" width="28" height="28" alt="" style="display:block;width:28px;height:28px;border:0;border-radius:7px;">`
	var b strings.Builder
	_, _ = b.WriteString(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<style>
  body { margin: 0; padding: 0; background: #faf9f5; }
  .cx-card p { margin: 0 0 14px; }
  .cx-card a { color: #2f6fb7; }
  .cx-card .button, .cx-card a.button { display: inline-block; padding: 12px 22px; border-radius: 8px; background: #141413; color: #ffffff !important; text-decoration: none; font-weight: 500; font-size: 15px; line-height: 20px; }
  .cx-card .code { margin: 18px 0; padding: 18px 12px; border-radius: 12px; background: #f5f4ef; font-family: ` + claudexEmailMono + `; font-size: 30px; line-height: 36px; font-weight: 600; letter-spacing: 8px; text-align: center; color: #141413; }
  .cx-card .muted { color: #6b6a65; font-size: 13px; line-height: 20px; word-break: break-all; }
  .cx-card .panel { margin: 16px 0; padding: 14px 16px; border-radius: 12px; background: #f5f4ef; }
  .cx-card table.cx-rows td { padding: 6px 0; border-bottom: 1px solid #eeece4; font-size: 14px; }
  @media (max-width: 600px) { .cx-card { padding: 28px 22px 24px !important; } }
</style>
</head>
<body style="margin:0;padding:0;background:#faf9f5;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#faf9f5;">
<tr><td align="center" style="padding:32px 16px 40px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;">
<tr><td style="padding:0 4px 20px;">
<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>`)
	if logo != "" {
		_, _ = b.WriteString(`<td style="padding-right:8px;vertical-align:middle;">` + logo + `</td>`)
	}
	_, _ = b.WriteString(`<td style="vertical-align:middle;font-family:` + claudexEmailSerif + `;font-size:22px;line-height:28px;color:#141413;letter-spacing:-0.3px;">` + site + `</td>
</tr></table>
</td></tr>
<tr><td class="cx-card" style="background:#ffffff;border:1px solid #e8e6dc;border-radius:16px;padding:36px 36px 30px;font-family:` + claudexEmailFont + `;font-size:15px;line-height:24px;color:#3d3d3a;">
<div style="width:32px;height:3px;border-radius:2px;background:` + accent + `;margin:0 0 18px;line-height:3px;font-size:0;">&nbsp;</div>
<h1 style="margin:0 0 18px;font-family:` + claudexEmailSerif + `;font-size:26px;line-height:34px;font-weight:400;color:#141413;letter-spacing:-0.2px;">` + l.Title + `</h1>
`)
	_, _ = b.WriteString(l.Content)
	_, _ = b.WriteString(`
</td></tr>
<tr><td style="padding:18px 4px 0;font-family:` + claudexEmailFont + `;font-size:12px;line-height:18px;color:#8c8c8a;">` + footer + `</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`)
	return b.String()
}

// ClaudexEmailButton is a dark rounded button (styled inline for clients
// that drop the stylesheet). href and label are plain text.
func ClaudexEmailButton(href, label string) string {
	return `<p style="margin:22px 0;"><a class="button" href="` + html.EscapeString(href) + `" style="display:inline-block;padding:12px 22px;border-radius:8px;background:#141413;color:#ffffff;text-decoration:none;font-weight:500;font-size:15px;line-height:20px;">` + html.EscapeString(label) + `</a></p>`
}

// ClaudexEmailCode is a one-time code in its block (code is plain text).
func ClaudexEmailCode(code string) string {
	return `<p class="code" style="margin:18px 0;padding:18px 12px;border-radius:12px;background:#f5f4ef;font-family:` + claudexEmailMono + `;font-size:30px;line-height:36px;font-weight:600;letter-spacing:8px;text-align:center;color:#141413;">` + html.EscapeString(code) + `</p>`
}
