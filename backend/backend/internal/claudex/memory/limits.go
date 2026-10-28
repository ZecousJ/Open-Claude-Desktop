package memory

import (
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Limits checked by the server (design R3 3.1).
const (
	// MaxDocBytes is the largest memory document (plaintext, UTF-8 bytes).
	MaxDocBytes = 16 << 10
	// MaxEditsPerScope is the number of pending memory edits one scope keeps.
	MaxEditsPerScope = 50
	// MaxEditChars is the longest memory edit, in characters.
	MaxEditChars = 500
	// MaxScopes is the number of scopes per user: global plus 50 projects.
	MaxScopes = 51

	// maxBodyBytes bounds a request body: a full document is 16 KiB of text,
	// which JSON escaping can grow several times.
	maxBodyBytes = 128 << 10

	// Writes per user and hour (design R3 3.2).
	writeLimit = 120
)

// Scopes: the global memory and one per project (the desktop app's project
// UUID, lowercase).
const (
	ScopeGlobal        = "global"
	scopeProjectPrefix = "project:"
)

// Sources of a memory document.
const (
	SourceGenerated = "generated"
	SourceUser      = "user"
	SourceImport    = "import"
)

var projectIDPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// normalizeScope returns the canonical scope ("global" or
// "project:<lowercase uuid>") and whether raw names one.
func normalizeScope(raw string) (string, bool) {
	s := strings.TrimSpace(raw)
	if s == ScopeGlobal {
		return s, true
	}
	if len(s) > len(scopeProjectPrefix) && strings.EqualFold(s[:len(scopeProjectPrefix)], scopeProjectPrefix) {
		id := strings.ToLower(s[len(scopeProjectPrefix):])
		if projectIDPattern.MatchString(id) {
			return scopeProjectPrefix + id, true
		}
	}
	return "", false
}

func validSource(s string) bool {
	return s == SourceGenerated || s == SourceUser || s == SourceImport
}

// cleanEdit turns a memory edit into one line: invalid UTF-8 dropped, control
// characters and line breaks turned into spaces, runs of white space
// collapsed, trimmed.
func cleanEdit(s string) string {
	s = strings.ToValidUTF8(s, "")
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || r == '\u2028' || r == '\u2029' {
			return ' '
		}
		return r
	}, s)
	return strings.Join(strings.Fields(s), " ")
}

// secretPatterns recognise credentials a memory edit must never store
// (design R3 3.5: the same kinds as feedback/redact.go, plus private keys,
// cloud keys and passwords). Memory is about the user, never their secrets.
var secretPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{8,}`),
	regexp.MustCompile(`\bsk-[A-Za-z0-9][A-Za-z0-9_-]{8,}`),
	regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+`),
	regexp.MustCompile(`-----BEGIN [A-Z ]*PRIVATE KEY-----`),
	regexp.MustCompile(`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`),
	regexp.MustCompile(`\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}`),
	regexp.MustCompile(`\bxox[abposr]-[A-Za-z0-9-]{10,}`),
	regexp.MustCompile(`\bAIza[0-9A-Za-z_-]{35}\b`),
	regexp.MustCompile(`(?i)\b(?:password|passwd|passcode|api[ _-]?key|secret[ _-]?key|access[ _-]?token|private[ _-]?key)\s*(?:is|=|:)\s*\S+`),
}

var cardCandidate = regexp.MustCompile(`\b\d(?:[ -]?\d){12,18}\b`)

// looksSecret reports whether s contains something shaped like a credential
// or a payment card number.
func looksSecret(s string) bool {
	for _, re := range secretPatterns {
		if re.MatchString(s) {
			return true
		}
	}
	for _, m := range cardCandidate.FindAllString(s, -1) {
		if luhn(strings.NewReplacer(" ", "", "-", "").Replace(m)) {
			return true
		}
	}
	return false
}

// luhn reports whether digits (13-19 of them) pass the Luhn check.
func luhn(digits string) bool {
	if len(digits) < 13 || len(digits) > 19 {
		return false
	}
	sum := 0
	double := false
	for i := len(digits) - 1; i >= 0; i-- {
		d, err := strconv.Atoi(digits[i : i+1])
		if err != nil {
			return false
		}
		if double {
			d *= 2
			if d > 9 {
				d -= 9
			}
		}
		sum += d
		double = !double
	}
	return sum%10 == 0
}

func runeLen(s string) int { return utf8.RuneCountInString(s) }
