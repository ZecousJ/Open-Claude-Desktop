package feedback

import (
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// The server redacts every free-text field again, whatever the client did
// (design 2.9): API keys, bearer tokens, JWTs, e-mail addresses and the user
// name inside home-directory paths.
var redactions = []struct {
	re   *regexp.Regexp
	repl string
}{
	// Authorization values first, so "Bearer sk-..." becomes one placeholder.
	{regexp.MustCompile(`(?i)\bBearer\s+\S+`), "Bearer [redacted]"},
	// OpenAI-style keys, including project and admin keys (sk-proj-..., sk-admin-...).
	{regexp.MustCompile(`\bsk-[A-Za-z0-9][A-Za-z0-9_-]*`), "sk-[redacted]"},
	// JWTs (access and refresh tokens).
	{regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+`), "[jwt]"},
	{regexp.MustCompile(`[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}`), "[email]"},
	// /Users/<name>, /home/<name> (macOS, Linux).
	{regexp.MustCompile(`(?i)/(Users|home)/[^/\s"'<>]+`), "/$1/[user]"},
	// C:\Users\<name>, also with forward slashes or JSON-escaped backslashes.
	{regexp.MustCompile(`(?i)\b([A-Z]):(\\+|/)Users(\\+|/)[^\\/\s"'<>]+`), "$1:${2}Users${3}[user]"},
}

// redact replaces secrets and personal data in s.
func redact(s string) string {
	if s == "" {
		return s
	}
	for _, r := range redactions {
		s = r.re.ReplaceAllString(s, r.repl)
	}
	return s
}

// truncateRunes cuts s to at most n characters (not bytes), never inside a
// UTF-8 sequence.
func truncateRunes(s string, n int) string {
	if n <= 0 {
		return ""
	}
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	i := 0
	for pos := range s {
		if i == n {
			return s[:pos]
		}
		i++
	}
	return s
}

// cleanText is the treatment of every free-text field: invalid UTF-8 and
// control characters removed (a single-line field turns them into spaces and
// collapses white space; a multiline one keeps newlines and tabs), trimmed,
// redacted, then cut to max characters. Redaction runs before the cut so a
// secret straddling the limit is still recognised.
func cleanText(s string, maxChars int, multiline bool) string {
	if s == "" {
		return ""
	}
	s = strings.ToValidUTF8(s, "")
	s = strings.Map(func(r rune) rune {
		if multiline && (r == '\n' || r == '\t') {
			return r
		}
		if r == '\r' && multiline {
			return -1
		}
		if unicode.IsControl(r) || r == '\u2028' || r == '\u2029' {
			if multiline {
				return -1
			}
			return ' '
		}
		return r
	}, s)
	if multiline {
		s = strings.TrimSpace(s)
	} else {
		// One line: every run of white space becomes a single space.
		s = strings.Join(strings.Fields(s), " ")
	}
	s = redact(s)
	return strings.TrimSpace(truncateRunes(s, maxChars))
}
