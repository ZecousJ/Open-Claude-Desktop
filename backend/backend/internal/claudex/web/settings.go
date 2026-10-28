package web

import (
	"sort"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
)

// SettingKey stores the web app switch (admin: /api/v1/admin/claudex/web/settings).
const SettingKey = "claudex_web"

// Access modes.
const (
	ModeAllowlist = "allowlist" // only the listed users (and administrators)
	ModeEveryone  = "everyone"  // every active user
)

// Limits of the setting.
const (
	DefaultMaxSessions = 10
	MaxSessionsLimit   = 50
	maxAllowlist       = 1000
	maxEmailLength     = 254
)

// ReasonSettingsInvalid and ReasonSettingsConflict are the admin PUT errors.
const (
	ReasonSettingsInvalid  = "CLAUDEX_WEB_SETTINGS_INVALID"
	ReasonSettingsConflict = "CLAUDEX_WEB_SETTINGS_CONFLICT"
)

// Settings is the stored value of SettingKey.
type Settings struct {
	Enabled bool   `json:"enabled"`
	Mode    string `json:"mode"`
	// AllowlistUserIDs and AllowlistEmails are read in ModeAllowlist.
	AllowlistUserIDs []int64  `json:"allowlist_user_ids"`
	AllowlistEmails  []string `json:"allowlist_emails"`
	// MaxSessionsPerUser caps the active web sessions of one user; signing
	// in past the cap ends the oldest one.
	MaxSessionsPerUser int        `json:"max_web_sessions_per_user"`
	Revision           int64      `json:"revision"`
	UpdatedAt          *time.Time `json:"updated_at,omitempty"`
	UpdatedBy          *int64     `json:"updated_by,omitempty"`
}

// defaultSettings leaves slices nil: JSON decoding appends into non-nil
// defaults, normalize fills them in.
func defaultSettings() Settings {
	return Settings{Mode: ModeAllowlist, MaxSessionsPerUser: DefaultMaxSessions}
}

// normalizeSettings trims, lowercases and dedupes the lists and fills defaults.
// An unknown mode stays as is so validation can reject it on write; reads
// treat anything but ModeEveryone as the allowlist (fail closed).
func normalizeSettings(s *Settings) {
	s.Mode = strings.ToLower(strings.TrimSpace(s.Mode))
	if s.Mode == "" {
		s.Mode = ModeAllowlist
	}
	if s.MaxSessionsPerUser == 0 {
		s.MaxSessionsPerUser = DefaultMaxSessions
	}
	ids := make([]int64, 0, len(s.AllowlistUserIDs))
	seenID := make(map[int64]bool, len(s.AllowlistUserIDs))
	for _, id := range s.AllowlistUserIDs {
		if !seenID[id] {
			seenID[id] = true
			ids = append(ids, id)
		}
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	s.AllowlistUserIDs = ids

	emails := make([]string, 0, len(s.AllowlistEmails))
	seenEmail := make(map[string]bool, len(s.AllowlistEmails))
	for _, e := range s.AllowlistEmails {
		e = strings.ToLower(strings.TrimSpace(e))
		if e == "" || seenEmail[e] {
			continue
		}
		seenEmail[e] = true
		emails = append(emails, e)
	}
	sort.Strings(emails)
	s.AllowlistEmails = emails
}

func invalidSetting(field, rule, msg string) error {
	return core.InvalidSetting(ReasonSettingsInvalid, field, rule, msg)
}

func validateSettings(s *Settings) error {
	if s.Mode != ModeAllowlist && s.Mode != ModeEveryone {
		return invalidSetting("mode", "enum", "mode must be allowlist or everyone.")
	}
	if s.MaxSessionsPerUser < 1 || s.MaxSessionsPerUser > MaxSessionsLimit {
		return invalidSetting("max_web_sessions_per_user", "range", "max_web_sessions_per_user must be between 1 and 50.")
	}
	if len(s.AllowlistUserIDs) > maxAllowlist {
		return invalidSetting("allowlist_user_ids", "max_items", "allowlist_user_ids has more than 1000 entries.")
	}
	for _, id := range s.AllowlistUserIDs {
		if id <= 0 {
			return invalidSetting("allowlist_user_ids", "positive", "allowlist_user_ids must hold user ids.")
		}
	}
	if len(s.AllowlistEmails) > maxAllowlist {
		return invalidSetting("allowlist_emails", "max_items", "allowlist_emails has more than 1000 entries.")
	}
	for _, e := range s.AllowlistEmails {
		at := strings.IndexByte(e, '@')
		if len(e) > maxEmailLength || at <= 0 || at == len(e)-1 || strings.ContainsAny(e, " \t\r\n") {
			return invalidSetting("allowlist_emails", "email", "allowlist_emails must hold email addresses.")
		}
	}
	return nil
}

func newSetting(env *core.Env) *core.JSONSetting[Settings] {
	var repo = env.SettingRepo
	return core.NewJSONSetting(repo, SettingKey, defaultSettings,
		core.WithNormalize(normalizeSettings), core.WithValidate(validateSettings))
}

// allows reports whether the settings let this user use the web app.
// Administrators are always allowed so they can never lock themselves out.
func (s Settings) allows(userID int64, email string, isAdmin bool) bool {
	if isAdmin || s.Mode == ModeEveryone {
		return true
	}
	for _, id := range s.AllowlistUserIDs {
		if id == userID {
			return true
		}
	}
	email = strings.ToLower(strings.TrimSpace(email))
	if email == "" {
		return false
	}
	for _, e := range s.AllowlistEmails {
		if e == email {
			return true
		}
	}
	return false
}
