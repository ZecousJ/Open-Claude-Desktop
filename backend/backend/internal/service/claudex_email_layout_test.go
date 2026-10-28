package service

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// CLAUDEX: every email shares the Claudex layout.
func TestClaudexEmailLayout(t *testing.T) {
	body := ClaudexEmailHTML(ClaudexEmailLayout{
		SiteName: "Claudex",
		SiteURL:  "https://claudex.example/",
		Title:    "Your code",
		Accent:   "#dc2626",
		Content:  ClaudexEmailCode("123456") + ClaudexEmailButton("https://claudex.example/x?a=1&b=2", "Open"),
	})
	require.Contains(t, body, `src="cid:claudex-logo"`, "the logo travels inside the message")
	require.Contains(t, body, ">Your code</h1>")
	require.Contains(t, body, EmailAccentDanger, "older red accents read as danger")
	require.Contains(t, body, ">123456</p>")
	require.Contains(t, body, `href="https://claudex.example/x?a=1&amp;b=2"`, "the link is escaped")
	require.Contains(t, body, "This email was sent by Claudex.")

	plain := ClaudexEmailHTML(ClaudexEmailLayout{Title: "t", Content: "c"})
	require.Contains(t, plain, `src="cid:claudex-logo"`, "the logo needs no address")
	require.Contains(t, plain, EmailAccentBrand)

	// The message carries the logo as an inline part.
	msg, err := buildSMTPMessage(&SMTPConfig{Host: "smtp.example", From: "noreply@example.com"}, "a@example.com", "Hi", body)
	require.NoError(t, err)
	data := string(msg.data)
	require.Contains(t, data, "multipart/related")
	require.Contains(t, data, "Content-ID: <claudex-logo>")
	require.Contains(t, data, "Content-Type: image/png")
	plainMsg, err := buildSMTPMessage(&SMTPConfig{Host: "smtp.example", From: "noreply@example.com"}, "a@example.com", "Hi", "<p>no logo</p>")
	require.NoError(t, err)
	require.NotContains(t, string(plainMsg.data), "multipart/related", "a body without the logo stays one part")

	// The official templates render in it, with their placeholders kept.
	tmpl := notificationEmailOfficialTemplates[NotificationEmailEventAuthPasswordReset][notificationEmailDefaultLocale].HTML
	require.Contains(t, tmpl, "cid:claudex-logo")
	require.Contains(t, tmpl, "{{reset_url}}")
	require.True(t, strings.Contains(tmpl, "#faf9f5"))
}
