package sharing

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"image/png"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Snapshot limits (design R1 3.2). The byte limits of the whole snapshot and
// of one artifact come from the settings.
const (
	maxTitleRunes         = 200
	maxModelLabelRunes    = 80
	maxMessages           = 500
	maxUserTextBytes      = 100 << 10
	maxAssistantTextBytes = 200 << 10
	maxActivityLines      = 20
	maxActivityRunes      = 120
	maxArtifacts          = 20
	maxSourceKeyBytes     = 512
	// requestOverheadBytes is what a request may carry beyond the snapshot
	// (kind, source_key, title, JSON escaping slack).
	requestOverheadBytes = 64 << 10
)

// ArtifactLanguages are the artifact formats a share may hold.
var ArtifactLanguages = map[string]bool{"html": true, "svg": true, "markdown": true, "mermaid": true, "code": true}

var (
	codeLanguageRe = regexp.MustCompile(`^[A-Za-z0-9+#._-]{1,32}$`)
	hexKeyRe       = regexp.MustCompile(`^[0-9a-fA-F]{64}$`)
	// tokenRe is the shape of a share token; anything else is a 404 without
	// a database lookup. Tokens never start with '_' (that would overlap the
	// static /s/_assets route) or '-'.
	tokenRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{42}$`)
)

// ValidToken reports whether s has the shape of a share token.
func ValidToken(s string) bool { return tokenRe.MatchString(s) }

// newToken returns 32 random bytes as base64url (43 characters) whose first
// character is a letter or digit.
func newToken() (string, error) {
	var b [32]byte
	for {
		if _, err := rand.Read(b[:]); err != nil {
			return "", err
		}
		t := base64.RawURLEncoding.EncodeToString(b[:])
		if ValidToken(t) {
			return t, nil
		}
	}
}

// SourceKey turns the client's key of a conversation or artifact into the
// stored form: a 64-character hex SHA-256 digest is kept (lowercased), any
// other string is hashed, so raw client ids never reach the database. The
// desktop app may send either and filter GET /shares?source_key= with the
// same value.
func SourceKey(raw string) (string, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > maxSourceKeyBytes {
		return "", false
	}
	if hexKeyRe.MatchString(raw) {
		return strings.ToLower(raw), true
	}
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:]), true
}

// limits are the size caps a snapshot is checked against.
type limits struct {
	SnapshotBytes int64
	ArtifactBytes int64
}

func limitsOf(s Settings) limits {
	return limits{SnapshotBytes: s.MaxSnapshotBytes, ArtifactBytes: s.MaxArtifactBytes}
}

// normalizeSnapshot validates a snapshot of the given kind in place (drops
// NUL characters, trims labels, sets Kind and Title) and returns its stored
// JSON. Errors are CLAUDEX_SHARE_INVALID (400) or CLAUDEX_SHARE_TOO_LARGE
// (413).
func normalizeSnapshot(s *Snapshot, kind Kind, title string, lim limits) ([]byte, error) {
	if s == nil {
		return nil, invalidShare("snapshot", "The snapshot is missing.")
	}
	s.Kind = kind
	if s.Screenshot != "" {
		const prefix = "data:image/png;base64,"
		if kind != KindArtifact || !strings.HasPrefix(s.Screenshot, prefix) || len(s.Screenshot) > 2<<20 {
			return nil, invalidShare("snapshot.screenshot", "The request failed.")
		}
		image, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(s.Screenshot, prefix))
		if err != nil {
			return nil, invalidShare("snapshot.screenshot", "The request failed.")
		}
		config, err := png.DecodeConfig(bytes.NewReader(image))
		if err != nil || config.Width != 600 || config.Height != 315 {
			return nil, invalidShare("snapshot.screenshot", "The request failed.")
		}
	}
	s.Title = cleanLabel(title)
	if utf8.RuneCountInString(s.Title) > maxTitleRunes {
		return nil, invalidShare("title", "The title is too long.")
	}
	s.Mode = strings.TrimSpace(s.Mode)
	switch s.Mode {
	case "", "chat", "cowork", "code":
	default:
		return nil, invalidShare("snapshot.mode", "Unknown mode.")
	}
	s.ModelLabel = cleanLabel(s.ModelLabel)
	if len(s.Repositories) > 20 {
		return nil, invalidShare("snapshot.repositories", "Too many repositories.")
	}
	for _, repository := range s.Repositories {
		if len(repository) > 200 || !codeRepositoryName.MatchString(repository) {
			return nil, invalidShare("snapshot.repositories", "Invalid repository.")
		}
	}
	if utf8.RuneCountInString(s.ModelLabel) > maxModelLabelRunes {
		return nil, invalidShare("snapshot.model_label", "The model label is too long.")
	}

	if len(s.Artifacts) > maxArtifacts {
		return nil, invalidShare("snapshot.artifacts", "A share holds at most "+strconv.Itoa(maxArtifacts)+" artifacts.")
	}
	for i := range s.Artifacts {
		a := &s.Artifacts[i]
		field := "snapshot.artifacts[" + strconv.Itoa(i) + "]"
		a.Title = cleanLabel(a.Title)
		if utf8.RuneCountInString(a.Title) > maxTitleRunes {
			return nil, invalidShare(field+".title", "The artifact title is too long.")
		}
		a.Language = strings.ToLower(strings.TrimSpace(a.Language))
		if !ArtifactLanguages[a.Language] {
			return nil, invalidShare(field+".language", "Unsupported artifact type.")
		}
		a.CodeLanguage = strings.TrimSpace(a.CodeLanguage)
		if a.Language != "code" {
			a.CodeLanguage = ""
		} else if a.CodeLanguage != "" && !codeLanguageRe.MatchString(a.CodeLanguage) {
			return nil, invalidShare(field+".code_language", "Invalid code language.")
		}
		a.Content = dropNUL(a.Content)
		if strings.TrimSpace(a.Content) == "" {
			return nil, invalidShare(field+".content", "The artifact is empty.")
		}
		if int64(len(a.Content)) > lim.ArtifactBytes {
			return nil, tooLarge(field+".content", lim.ArtifactBytes)
		}
	}

	switch kind {
	case KindArtifact:
		if len(s.Messages) != 0 || len(s.Artifacts) != 1 {
			return nil, invalidShare("snapshot", "An artifact share holds exactly one artifact and no messages.")
		}
	case KindConversation:
		if len(s.Messages) == 0 {
			return nil, invalidShare("snapshot.messages", "The conversation has no messages.")
		}
		if len(s.Messages) > maxMessages {
			return nil, tooLarge("snapshot.messages", int64(maxMessages))
		}
	default:
		return nil, invalidShare("kind", "Unknown share kind.")
	}

	for i := range s.Messages {
		m := &s.Messages[i]
		field := "snapshot.messages[" + strconv.Itoa(i) + "]"
		m.Text = dropNUL(m.Text)
		switch m.Role {
		case "user":
			if len(m.Text) > maxUserTextBytes {
				return nil, tooLarge(field+".text", maxUserTextBytes)
			}
		case "assistant":
			if len(m.Text) > maxAssistantTextBytes {
				return nil, tooLarge(field+".text", maxAssistantTextBytes)
			}
		default:
			return nil, invalidShare(field+".role", "A message role is user or assistant.")
		}
		if len(m.Activity) > maxActivityLines {
			return nil, invalidShare(field+".activity", "Too many activity lines.")
		}
		activity := m.Activity[:0]
		for _, line := range m.Activity {
			line = cleanLabel(line)
			if line == "" {
				continue
			}
			if utf8.RuneCountInString(line) > maxActivityRunes {
				return nil, invalidShare(field+".activity", "An activity line is too long.")
			}
			activity = append(activity, line)
		}
		m.Activity = activity
		if len(m.Activity) == 0 {
			m.Activity = nil
		}
		if len(m.Artifacts) > maxArtifacts {
			return nil, invalidShare(field+".artifacts", "Too many artifact references.")
		}
		seen := map[int]bool{}
		for _, idx := range m.Artifacts {
			if idx < 0 || idx >= len(s.Artifacts) || seen[idx] {
				return nil, invalidShare(field+".artifacts", "Invalid artifact reference.")
			}
			seen[idx] = true
		}
		if strings.TrimSpace(m.Text) == "" && len(m.Artifacts) == 0 && len(m.Activity) == 0 {
			return nil, invalidShare(field+".text", "A message is empty.")
		}
	}

	// Measure the snapshot without HTML escaping: json.Marshal turns every
	// <, > and & into six bytes, which would count an HTML artifact far
	// larger than the client (JSON.stringify) and JSONB see it.
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(s); err != nil {
		return nil, invalidShare("snapshot", "The snapshot can't be stored.")
	}
	body := bytes.TrimSuffix(buf.Bytes(), []byte("\n"))
	if int64(len(body)) > lim.SnapshotBytes {
		return nil, tooLarge("snapshot", lim.SnapshotBytes)
	}
	return body, nil
}

// cleanLabel makes a one-line label: control characters (newlines, NUL)
// become spaces, runs of spaces collapse, and the ends are trimmed.
func cleanLabel(s string) string {
	if s == "" {
		return ""
	}
	var b strings.Builder
	space := false
	for _, r := range s {
		if r < 0x20 || r == 0x7f || r == ' ' || r == ' ' || r == ' ' || r == ' ' {
			space = true
			continue
		}
		if space && b.Len() > 0 {
			_ = b.WriteByte(' ')
		}
		space = false
		_, _ = b.WriteRune(r)
	}
	return b.String()
}

// dropNUL removes NUL characters, which PostgreSQL JSONB cannot store.
func dropNUL(s string) string {
	if !strings.ContainsRune(s, 0) {
		return s
	}
	return strings.ReplaceAll(s, "\x00", "")
}

func itoa64(v int64) string { return strconv.FormatInt(v, 10) }
