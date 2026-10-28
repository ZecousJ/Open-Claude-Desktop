package usage

import (
	"math"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
)

// SettingKey stores the web run limits (admin: /api/v1/admin/claudex/web/usage/settings).
const SettingKey = "claudex_web_usage"

// Defaults and ranges of the setting (design W-SRV 6: one run per user, two on
// the 2 GB host, 30 minutes).
const (
	DefaultMaxConcurrentPerUser = 1
	DefaultMaxConcurrent        = 2
	DefaultMaxSessionMinutes    = 30

	maxConcurrentPerUserLimit = 20
	maxConcurrentLimit        = 500
	maxSessionMinutesLimit    = 24 * 60
	maxMinutePriceUSD         = 100
)

// ReasonSettingsInvalid and ReasonSettingsConflict are the admin PUT errors.
const (
	ReasonSettingsInvalid  = "CLAUDEX_WEB_USAGE_SETTINGS_INVALID"
	ReasonSettingsConflict = "CLAUDEX_WEB_USAGE_SETTINGS_CONFLICT"
)

// Settings is the stored value of SettingKey.
type Settings struct {
	// MaxConcurrentPerUser caps the runs one user has at the same time.
	MaxConcurrentPerUser int `json:"max_concurrent_sessions_per_user"`
	// MaxConcurrent caps the runs of every user together (this server).
	MaxConcurrent int `json:"max_concurrent_sessions"`
	// MaxSessionMinutes is the longest a run may last (Slot.Deadline).
	MaxSessionMinutes int `json:"max_session_minutes"`
	// RunnerMinutePriceUSD is informational: runner time is recorded, never
	// charged (web PLAN Q12); the console shows the price times the minutes.
	RunnerMinutePriceUSD float64    `json:"runner_minute_price_usd"`
	Revision             int64      `json:"revision"`
	UpdatedAt            *time.Time `json:"updated_at,omitempty"`
	UpdatedBy            *int64     `json:"updated_by,omitempty"`
}

func defaultSettings() Settings {
	return Settings{
		MaxConcurrentPerUser: DefaultMaxConcurrentPerUser,
		MaxConcurrent:        DefaultMaxConcurrent,
		MaxSessionMinutes:    DefaultMaxSessionMinutes,
	}
}

// normalizeSettings fills fields a stored value leaves out.
func normalizeSettings(s *Settings) {
	if s.MaxConcurrentPerUser == 0 {
		s.MaxConcurrentPerUser = DefaultMaxConcurrentPerUser
	}
	if s.MaxConcurrent == 0 {
		s.MaxConcurrent = DefaultMaxConcurrent
	}
	if s.MaxSessionMinutes == 0 {
		s.MaxSessionMinutes = DefaultMaxSessionMinutes
	}
}

func invalidSetting(field, rule, msg string) error {
	return core.InvalidSetting(ReasonSettingsInvalid, field, rule, msg)
}

func validateSettings(s *Settings) error {
	switch {
	case s.MaxConcurrentPerUser < 1 || s.MaxConcurrentPerUser > maxConcurrentPerUserLimit:
		return invalidSetting("max_concurrent_sessions_per_user", "range", "max_concurrent_sessions_per_user must be between 1 and 20.")
	case s.MaxConcurrent < 1 || s.MaxConcurrent > maxConcurrentLimit:
		return invalidSetting("max_concurrent_sessions", "range", "max_concurrent_sessions must be between 1 and 500.")
	case s.MaxConcurrentPerUser > s.MaxConcurrent:
		return invalidSetting("max_concurrent_sessions_per_user", "max", "max_concurrent_sessions_per_user cannot be more than max_concurrent_sessions.")
	case s.MaxSessionMinutes < 1 || s.MaxSessionMinutes > maxSessionMinutesLimit:
		return invalidSetting("max_session_minutes", "range", "max_session_minutes must be between 1 and 1440.")
	case math.IsNaN(s.RunnerMinutePriceUSD) || s.RunnerMinutePriceUSD < 0 || s.RunnerMinutePriceUSD > maxMinutePriceUSD:
		return invalidSetting("runner_minute_price_usd", "range", "runner_minute_price_usd must be between 0 and 100.")
	}
	return nil
}
