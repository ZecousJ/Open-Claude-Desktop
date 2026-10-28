package feedback

import (
	"strconv"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
)

// SettingKey stores Settings (design 1.6).
const SettingKey = "claudex_feedback"

// Settings is the claudex_feedback document. Both parts are off by default:
// nothing is collected until an administrator turns it on, and the desktop
// app additionally needs the user's consent.
type Settings struct {
	Diagnostics DiagnosticsSettings `json:"diagnostics"`
	Feedback    FeedbackSettings    `json:"feedback"`
}

// DiagnosticsSettings controls POST /api/v1/claudex/diagnostics.
type DiagnosticsSettings struct {
	Enabled          bool `json:"enabled"`
	RetentionDays    int  `json:"retention_days"`
	MaxPerUserPerDay int  `json:"max_per_user_per_day"`
}

// FeedbackSettings controls POST /api/v1/claudex/feedback.
type FeedbackSettings struct {
	Enabled       bool `json:"enabled"`
	RetentionDays int  `json:"retention_days"`
	// AllowConversationExcerpt keeps the excerpt a user chose to attach;
	// otherwise the server drops it and answers excerpt_dropped:true.
	AllowConversationExcerpt bool `json:"allow_conversation_excerpt"`
	MaxPerUserPerDay         int  `json:"max_per_user_per_day"`
}

// Limits of the settings (the console validates the same ranges).
const (
	minRetentionDays            = 1
	maxDiagnosticsRetentionDays = 365
	maxFeedbackRetentionDays    = 730
	minPerUserPerDay            = 1
	maxPerUserPerDay            = 1000
)

func defaultSettings() Settings {
	return Settings{
		Diagnostics: DiagnosticsSettings{Enabled: false, RetentionDays: 30, MaxPerUserPerDay: 200},
		Feedback:    FeedbackSettings{Enabled: false, RetentionDays: 180, AllowConversationExcerpt: false, MaxPerUserPerDay: 100},
	}
}

// normalizeSettings clamps a stored value into range, so a hand-edited
// document can never make the retention job delete fresh rows (0 days) or
// lift the daily caps. Writes are validated before this runs (validateSettings
// on the request), so a PUT with an out-of-range value is refused, not
// clamped.
func normalizeSettings(s *Settings) {
	s.Diagnostics.RetentionDays = clamp(s.Diagnostics.RetentionDays, minRetentionDays, maxDiagnosticsRetentionDays)
	s.Diagnostics.MaxPerUserPerDay = clamp(s.Diagnostics.MaxPerUserPerDay, minPerUserPerDay, maxPerUserPerDay)
	s.Feedback.RetentionDays = clamp(s.Feedback.RetentionDays, minRetentionDays, maxFeedbackRetentionDays)
	s.Feedback.MaxPerUserPerDay = clamp(s.Feedback.MaxPerUserPerDay, minPerUserPerDay, maxPerUserPerDay)
}

// validateSettings answers 400 CLAUDEX_SETTING_INVALID (metadata field, rule)
// for the first value out of range.
func validateSettings(s *Settings) error {
	checks := []struct {
		field    string
		value    int
		min, max int
	}{
		{"diagnostics.retention_days", s.Diagnostics.RetentionDays, minRetentionDays, maxDiagnosticsRetentionDays},
		{"diagnostics.max_per_user_per_day", s.Diagnostics.MaxPerUserPerDay, minPerUserPerDay, maxPerUserPerDay},
		{"feedback.retention_days", s.Feedback.RetentionDays, minRetentionDays, maxFeedbackRetentionDays},
		{"feedback.max_per_user_per_day", s.Feedback.MaxPerUserPerDay, minPerUserPerDay, maxPerUserPerDay},
	}
	for _, c := range checks {
		if c.value < c.min || c.value > c.max {
			return core.InvalidSetting("", c.field, "range",
				c.field+" must be between "+strconv.Itoa(c.min)+" and "+strconv.Itoa(c.max)+".")
		}
	}
	return nil
}

func clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
