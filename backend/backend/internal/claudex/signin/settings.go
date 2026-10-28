package signin

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"unicode"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
)

// SettingKey stores Settings (admin: /api/v1/admin/claudex/sign-in).
const SettingKey = "claudex_sign_in"

// ReasonSettingInvalid is the 400 reason of an invalid admin PUT.
const ReasonSettingInvalid = "CLAUDEX_SIGN_IN_INVALID"

// maxPolicyURLBytes caps privacy_policy_url.
const maxPolicyURLBytes = 2000

// Settings is the claudex_sign_in document.
type Settings struct {
	// EmailCodeLoginEnabled offers "sign in with an email code". It only
	// works while SMTP is configured and backend mode is off.
	EmailCodeLoginEnabled bool `json:"email_code_login_enabled"`
	// PrivacyPolicyURL is linked from the sign-in page: "" (none), an
	// https:// address or a site path starting with "/".
	PrivacyPolicyURL string `json:"privacy_policy_url"`
}

func defaultSettings() Settings { return Settings{} }

func normalizeSettings(s *Settings) {
	s.PrivacyPolicyURL = strings.TrimSpace(s.PrivacyPolicyURL)
}

func validateSettings(s *Settings) error {
	if s.PrivacyPolicyURL != "" && !validPolicyURL(s.PrivacyPolicyURL) {
		return invalid("privacy_policy_url", "url",
			"privacy_policy_url must be empty, an https:// address or a path on this site starting with \"/\" (at most 2000 characters).")
	}
	return nil
}

// validPolicyURL accepts an https:// URL or a site path ("/legal/privacy"),
// never a protocol-relative "//host" or a backslash path.
func validPolicyURL(s string) bool {
	if len(s) > maxPolicyURLBytes {
		return false
	}
	if strings.HasPrefix(s, "/") {
		if strings.HasPrefix(s, "//") || strings.ContainsRune(s, '\\') {
			return false
		}
		for _, r := range s {
			if unicode.IsSpace(r) || unicode.IsControl(r) {
				return false
			}
		}
		return true
	}
	_, err := core.HTTPSURL(s, maxPolicyURLBytes)
	return err == nil
}

func invalid(field, rule, message string) error {
	return core.InvalidSetting(ReasonSettingInvalid, field, rule, message)
}

// settingsUpdate is the admin PUT body; fields left out keep their values.
type settingsUpdate struct {
	EmailCodeLoginEnabled *bool   `json:"email_code_login_enabled"`
	PrivacyPolicyURL      *string `json:"privacy_policy_url"`
}

// decodeUpdate reads one JSON object with no unknown fields.
func decodeUpdate(body []byte) (settingsUpdate, error) {
	var upd settingsUpdate
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return upd, invalid("body", "json_object", "Send the sign-in settings as a JSON object.")
	}
	dec := json.NewDecoder(bytes.NewReader(trimmed))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&upd); err != nil {
		var typeErr *json.UnmarshalTypeError
		if errors.As(err, &typeErr) && typeErr.Field != "" {
			return upd, invalid(typeErr.Field, "type", "The value of "+typeErr.Field+" has the wrong type.")
		}
		if strings.HasPrefix(err.Error(), "json: unknown field ") {
			return upd, invalid("body", "unknown_field", "Unknown setting "+strings.TrimPrefix(err.Error(), "json: unknown field ")+".")
		}
		return upd, invalid("body", "json", "The request body is not valid JSON.")
	}
	if err := dec.Decode(&json.RawMessage{}); !errors.Is(err, io.EOF) {
		return upd, invalid("body", "json", "The request body must hold one JSON object.")
	}
	return upd, nil
}
