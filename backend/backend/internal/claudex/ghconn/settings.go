package ghconn

import (
	"fmt"
	"net/url"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
)

// SettingKey stores the administrator's GitHub app settings.
const SettingKey = "claudex_github"

// ReasonInvalid is the 400 reason of a rejected settings document.
const ReasonInvalid = "CLAUDEX_GITHUB_INVALID"

// App kinds. Both run the same web application flow; a GitHub App's user
// tokens expire and are refreshed, an OAuth App's do not.
const (
	KindOAuthApp  = "oauth_app"
	KindGitHubApp = "github_app"
)

const (
	clientIDMax     = 100
	secretMinLength = 8
	secretMaxLength = 512
	baseURLMax      = 2048
)

// Settings is the stored claudex_github document. Connecting GitHub is off
// until an administrator stores the app's client id and secret and turns it
// on.
type Settings struct {
	Enabled  bool   `json:"enabled"`
	Kind     string `json:"kind"`
	ClientID string `json:"client_id"`
	// ClientSecretCiphertext is the app's client secret sealed with the
	// server's secret encryption key. It never leaves the server: the admin
	// view only says whether one is stored and shows its last characters.
	ClientSecretCiphertext string `json:"client_secret_ciphertext,omitempty"`
	ClientSecretHint       string `json:"client_secret_hint,omitempty"`
	// PublicBaseURL is the address users reach the service at (the OAuth
	// callback is PublicBaseURL + CallbackPath). Empty falls back to the
	// upstream frontend URL.
	PublicBaseURL string `json:"public_base_url"`
}

// SecretConfigured reports whether a client secret is stored.
func (s Settings) SecretConfigured() bool { return s.ClientSecretCiphertext != "" }

func defaultSettings() Settings { return Settings{Kind: KindOAuthApp} }

func normalize(s *Settings) {
	s.ClientID = strings.TrimSpace(s.ClientID)
	s.PublicBaseURL = strings.TrimRight(strings.TrimSpace(s.PublicBaseURL), "/")
	if s.Kind == "" {
		s.Kind = KindOAuthApp
	}
	if s.ClientSecretCiphertext == "" {
		s.ClientSecretHint = ""
	}
}

func validate(s *Settings) error {
	if s.Kind != KindOAuthApp && s.Kind != KindGitHubApp {
		return invalid("kind", "enum", "kind must be oauth_app or github_app")
	}
	if len(s.ClientID) > clientIDMax || strings.ContainsFunc(s.ClientID, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }) {
		return invalid("client_id", "format", fmt.Sprintf("client_id must be at most %d characters without spaces", clientIDMax))
	}
	if s.PublicBaseURL != "" {
		if _, err := parseBaseURL(s.PublicBaseURL); err != nil {
			return err
		}
	}
	if s.Enabled {
		switch {
		case s.ClientID == "":
			return invalid("client_id", "required", "Enter the app's client ID before turning GitHub on")
		case !s.SecretConfigured():
			return invalid("client_secret", "required", "Store the app's client secret before turning GitHub on")
		}
	}
	return nil
}

// parseBaseURL accepts an absolute https URL (http only for loopback hosts,
// for local development) without credentials, query or fragment.
func parseBaseURL(raw string) (*url.URL, error) {
	const field = "public_base_url"
	if len(raw) > baseURLMax {
		return nil, invalid(field, "length", "public_base_url is too long")
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.Opaque != "" {
		return nil, invalid(field, "format", "public_base_url must be an absolute URL such as https://claudex.example.com")
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, invalid(field, "format", "public_base_url must not contain credentials, a query or a fragment")
	}
	switch u.Scheme {
	case "https":
	case "http":
		h := u.Hostname()
		if h != "localhost" && h != "127.0.0.1" && h != "::1" {
			return nil, invalid(field, "scheme", "public_base_url must use https (http is only allowed for localhost)")
		}
	default:
		return nil, invalid(field, "scheme", "public_base_url must use https")
	}
	return u, nil
}

// validateSecret checks a client secret an administrator submits.
func validateSecret(secret string) error {
	const field = "client_secret"
	n := utf8.RuneCountInString(secret)
	if n < secretMinLength || n > secretMaxLength {
		return invalid(field, "length", fmt.Sprintf("client_secret must be %d-%d characters", secretMinLength, secretMaxLength))
	}
	for _, r := range secret {
		if unicode.IsSpace(r) || unicode.IsControl(r) {
			return invalid(field, "format", "client_secret must not contain spaces or control characters")
		}
	}
	return nil
}

// secretHint is the part of a secret the admin view shows: its last four
// characters, only for secrets long enough that this reveals little.
func secretHint(secret string) string {
	r := []rune(secret)
	if len(r) < 16 {
		return ""
	}
	return string(r[len(r)-4:])
}

func invalid(field, rule, message string) error {
	return core.InvalidSetting(ReasonInvalid, field, rule, message)
}
