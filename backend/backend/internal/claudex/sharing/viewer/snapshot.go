// Package viewer renders the public pages of hosted shares (design R1 4.6
// and 5): the share page at /s/<token>, the sandboxed artifact documents at
// /s/<token>/a/<n>, the plain-text sources at /s/<token>/raw/<n>, the
// no-script report form (POST /s/<token>/report) and the embedded Mermaid
// runtime at /s/_assets/.
//
// The package does not touch the database. The sharing component implements
// Source (and, when it counts views or takes reports, ViewCounter and
// Reporter) and calls Register from its core.PageRouter hook. The snapshot
// body travels as the stored JSON (schema 1, see DecodeSnapshot), so the
// sharing package and this one share the wire format, not Go types: sharing
// imports viewer, never the other way round.
//
// Pages carry no script. Artifact content only ever runs inside documents
// served with a Content-Security-Policy sandbox (opaque origin: no cookies,
// no localStorage of the admin console, no network) and framed with
// sandbox="allow-scripts".
package viewer

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// Artifact languages a snapshot may carry (claudex_share_contents body,
// artifacts[].language).
const (
	LanguageHTML     = "html"
	LanguageSVG      = "svg"
	LanguageMarkdown = "markdown"
	LanguageMermaid  = "mermaid"
	LanguageCode     = "code"
)

// Share kinds (claudex_shares.kind).
const (
	KindConversation = "conversation"
	KindArtifact     = "artifact"
)

// Snapshot is the stored body of a share (schema 1). It mirrors
// sharing.Snapshot field for field on the wire.
type Snapshot struct {
	Kind       string     `json:"kind"`
	Title      string     `json:"title"`
	Mode       string     `json:"mode,omitempty"`
	ModelLabel string     `json:"model_label,omitempty"`
	Messages   []Message  `json:"messages,omitempty"`
	Artifacts  []Artifact `json:"artifacts,omitempty"`
}

// Message is one message of a conversation snapshot. User text is shown as
// typed (like the desktop app); assistant text is Markdown.
type Message struct {
	Role      string   `json:"role"`
	Text      string   `json:"text"`
	Activity  []string `json:"activity,omitempty"`
	Artifacts []int    `json:"artifacts,omitempty"`
}

// Artifact is one artifact of a snapshot.
type Artifact struct {
	Title        string `json:"title"`
	Language     string `json:"language"`
	CodeLanguage string `json:"code_language,omitempty"`
	Content      string `json:"content"`
}

// ErrBadSnapshot means a stored body cannot be shown.
var ErrBadSnapshot = errors.New("viewer: unreadable snapshot")

// DecodeSnapshot reads a stored snapshot body. It only checks what the
// viewer relies on (a known kind and roles, known artifact languages,
// artifact references in range); size limits are the sharing component's job
// when the snapshot is written.
func DecodeSnapshot(body []byte) (Snapshot, error) {
	var s Snapshot
	if err := json.Unmarshal(body, &s); err != nil {
		return Snapshot{}, fmt.Errorf("%w: %v", ErrBadSnapshot, err)
	}
	if err := s.Check(); err != nil {
		return Snapshot{}, err
	}
	return s, nil
}

// Check reports whether the viewer can show the snapshot.
func (s Snapshot) Check() error {
	switch s.Kind {
	case KindConversation:
	case KindArtifact:
		if len(s.Artifacts) != 1 || len(s.Messages) != 0 {
			return fmt.Errorf("%w: an artifact share holds exactly one artifact", ErrBadSnapshot)
		}
	default:
		return fmt.Errorf("%w: unknown kind %q", ErrBadSnapshot, s.Kind)
	}
	for i, a := range s.Artifacts {
		if !KnownLanguage(a.Language) {
			return fmt.Errorf("%w: artifact %d has unknown language %q", ErrBadSnapshot, i, a.Language)
		}
	}
	for i, m := range s.Messages {
		if m.Role != "user" && m.Role != "assistant" {
			return fmt.Errorf("%w: message %d has unknown role %q", ErrBadSnapshot, i, m.Role)
		}
		for _, n := range m.Artifacts {
			if n < 0 || n >= len(s.Artifacts) {
				return fmt.Errorf("%w: message %d references artifact %d", ErrBadSnapshot, i, n)
			}
		}
	}
	return nil
}

// KnownLanguage reports whether the viewer can show an artifact language.
func KnownLanguage(language string) bool {
	switch language {
	case LanguageHTML, LanguageSVG, LanguageMarkdown, LanguageMermaid, LanguageCode:
		return true
	}
	return false
}

var tokenPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

// ValidToken reports whether s has the shape of a share token (base64url of
// 32 random bytes, no padding). Requests with any other token answer 404
// without a lookup.
func ValidToken(s string) bool { return tokenPattern.MatchString(s) }

// langClass keeps a fenced-code or code-artifact language usable as a class
// name suffix and a label.
func langClass(lang string) string {
	lang = strings.ToLower(strings.TrimSpace(lang))
	var b buf
	for _, r := range lang {
		if b.Len() >= 32 {
			break
		}
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' || r == '_' || r == '+' || r == '#' || r == '.' {
			b.r(r)
		}
	}
	return b.String()
}
