package webstore

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"strconv"
	"strings"
	"unicode/utf8"
)

// jsonbSafe returns data with every \u0000 escape inside a JSON string
// replaced by \ufffd (U+FFFD): PostgreSQL's jsonb refuses the NUL character, and a
// model can produce one. Escaped backslashes (\\u0000) are left alone.
func jsonbSafe(data []byte) []byte {
	if !bytes.Contains(data, []byte(`u0000`)) {
		return data
	}
	out := make([]byte, 0, len(data))
	for i := 0; i < len(data); i++ {
		b := data[i]
		if b != '\\' || i+1 >= len(data) {
			out = append(out, b)
			continue
		}
		// An escape: copy it whole so \\ never starts another one.
		if data[i+1] == 'u' && i+6 <= len(data) && string(data[i+2:i+6]) == "0000" {
			out = append(out, '\\', 'u', 'f', 'f', 'f', 'd')
			i += 5
			continue
		}
		out = append(out, b, data[i+1])
		i++
	}
	return out
}

// object reports whether raw is a JSON object.
func object(raw json.RawMessage) bool {
	t := bytes.TrimSpace(raw)
	return len(t) > 0 && t[0] == '{'
}

// truncateUTF8 cuts s to at most n bytes on a rune boundary.
func truncateUTF8(s string, n int) string {
	if len(s) <= n {
		return s
	}
	s = s[:n]
	for len(s) > 0 && !utf8.ValidString(s) {
		s = s[:len(s)-1]
	}
	return s
}

// clean drops NUL characters and invalid UTF-8 from a column value.
func clean(s string) string {
	s = strings.ToValidUTF8(s, "\uFFFD")
	return strings.ReplaceAll(s, "\x00", "")
}

// searchText is the text of a turn search looks at: the prompt and the
// reply text (agentMessage items), never tool commands or their output.
func searchText(turn json.RawMessage) string {
	var t struct {
		Prompt string `json:"prompt"`
		Items  []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"items"`
	}
	if json.Unmarshal(turn, &t) != nil {
		return ""
	}
	parts := []string{t.Prompt}
	n := len(t.Prompt)
	for _, it := range t.Items {
		if n > searchTextBytes {
			break
		}
		if it.Type == "agentMessage" && it.Text != "" {
			parts = append(parts, it.Text)
			n += len(it.Text) + 1
		}
	}
	return clean(truncateUTF8(strings.Join(parts, "\n"), searchTextBytes))
}

// Cursors are opaque to the runner: base64url of a small JSON value.
func encodeCursor(v any) string {
	raw, _ := json.Marshal(v)
	return base64.RawURLEncoding.EncodeToString(raw)
}

func decodeCursor(s string, into any) bool {
	if s == "" || len(s) > 1024 {
		return false
	}
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return false
	}
	return json.Unmarshal(raw, into) == nil
}

func itoa(n int) string { return strconv.Itoa(n) }

// escapeLike escapes the LIKE wildcards of a search query (ESCAPE '\').
func escapeLike(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}
