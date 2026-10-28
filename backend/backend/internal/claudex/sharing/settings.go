package sharing

import (
	"net"
	"net/url"
	"strconv"
	"strings"
	"unicode"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
)

// SettingKey stores Settings (design R1 3.3).
const SettingKey = "claudex_sharing"

// Settings is the claudex_sharing document. Sharing is off until an
// administrator turns it on (owner default: off); public links never expire
// unless DefaultTTLDays is set.
type Settings struct {
	// Enabled is the master switch. While it is off nothing can be shared
	// and every /s/<token> page answers 404; stored shares are kept.
	Enabled       bool `json:"enabled"`
	Conversations bool `json:"conversations"`
	Artifacts     bool `json:"artifacts"`
	// PublicBaseURL is where the public pages live ("" = fall back to the
	// upstream frontend URL, then to a path the client completes with its own
	// server address). Links are built when read, never stored.
	PublicBaseURL string `json:"public_base_url"`
	// ContentBaseURL is an optional separate host for artifact documents
	// (the iframe content). It needs PublicBaseURL and a different host.
	ContentBaseURL string `json:"content_base_url"`
	// UsagePolicyURL is linked from the desktop share dialogs ("" = the
	// server's own usage-policy legal document when it has content).
	UsagePolicyURL   string `json:"usage_policy_url"`
	MaxSnapshotBytes int64  `json:"max_snapshot_bytes"`
	MaxArtifactBytes int64  `json:"max_artifact_bytes"`
	MaxActivePerUser int    `json:"max_active_per_user"`
	// DefaultTTLDays sets expires_at of new shares (0 = never expire).
	DefaultTTLDays int  `json:"default_ttl_days"`
	AllowReports   bool `json:"allow_reports"`
}

// Limits of the settings (the console validates the same ranges).
const (
	minSnapshotBytes     int64 = 64 << 10
	maxSnapshotBytes     int64 = 32 << 20
	minArtifactBytes     int64 = 16 << 10
	maxActivePerUserMax        = 100000
	maxTTLDays                 = 3650
	maxSettingURLBytes         = 2048
	defaultSnapshotBytes int64 = 8 << 20
	defaultArtifactBytes int64 = 2 << 20
	defaultActivePerUser       = 200
)

func defaultSettings() Settings {
	return Settings{
		Enabled:          false,
		Conversations:    true,
		Artifacts:        true,
		MaxSnapshotBytes: defaultSnapshotBytes,
		MaxArtifactBytes: defaultArtifactBytes,
		MaxActivePerUser: defaultActivePerUser,
		DefaultTTLDays:   0,
		AllowReports:     true,
	}
}

// normalizeSettings trims the links and clamps a stored value into range,
// so a hand-edited document can never lift the size caps. A PUT with an
// out-of-range value is refused by validateSettings before this matters.
func normalizeSettings(s *Settings) {
	s.PublicBaseURL = trimBase(s.PublicBaseURL)
	s.ContentBaseURL = trimBase(s.ContentBaseURL)
	s.UsagePolicyURL = strings.TrimSpace(s.UsagePolicyURL)
	s.MaxSnapshotBytes = clamp64(s.MaxSnapshotBytes, minSnapshotBytes, maxSnapshotBytes)
	s.MaxArtifactBytes = clamp64(s.MaxArtifactBytes, minArtifactBytes, s.MaxSnapshotBytes)
	if s.MaxActivePerUser < 1 {
		s.MaxActivePerUser = 1
	}
	if s.MaxActivePerUser > maxActivePerUserMax {
		s.MaxActivePerUser = maxActivePerUserMax
	}
	if s.DefaultTTLDays < 0 {
		s.DefaultTTLDays = 0
	}
	if s.DefaultTTLDays > maxTTLDays {
		s.DefaultTTLDays = maxTTLDays
	}
}

// validateSettings answers 400 CLAUDEX_SETTING_INVALID (metadata field,
// rule) for the first invalid value.
func validateSettings(s *Settings) error {
	if s.PublicBaseURL != "" {
		if _, err := parseBaseURL(s.PublicBaseURL); err != nil {
			return core.InvalidSetting("", "public_base_url", "url",
				"public_base_url must be an https:// address without a query or fragment (http:// only for localhost).")
		}
	}
	if s.ContentBaseURL != "" {
		cu, err := parseBaseURL(s.ContentBaseURL)
		if err != nil {
			return core.InvalidSetting("", "content_base_url", "url",
				"content_base_url must be an https:// address without a query or fragment (http:// only for localhost).")
		}
		if s.PublicBaseURL == "" {
			return core.InvalidSetting("", "content_base_url", "requires_public_base_url",
				"Set public_base_url before a separate content address.")
		}
		pu, _ := parseBaseURL(s.PublicBaseURL)
		if pu != nil && strings.EqualFold(pu.Hostname(), cu.Hostname()) {
			return core.InvalidSetting("", "content_base_url", "same_host",
				"content_base_url must use a different host than public_base_url.")
		}
	}
	if s.UsagePolicyURL != "" {
		if _, err := core.HTTPSURL(s.UsagePolicyURL, maxSettingURLBytes); err != nil {
			return core.InvalidSetting("", "usage_policy_url", "url", "usage_policy_url must be an https:// address.")
		}
	}
	ranges := []struct {
		field    string
		value    int64
		min, max int64
	}{
		{"max_snapshot_bytes", s.MaxSnapshotBytes, minSnapshotBytes, maxSnapshotBytes},
		{"max_artifact_bytes", s.MaxArtifactBytes, minArtifactBytes, s.MaxSnapshotBytes},
		{"max_active_per_user", int64(s.MaxActivePerUser), 1, maxActivePerUserMax},
		{"default_ttl_days", int64(s.DefaultTTLDays), 0, maxTTLDays},
	}
	for _, r := range ranges {
		if r.value < r.min || r.value > r.max {
			return core.InvalidSetting("", r.field, "range",
				r.field+" must be between "+strconv.FormatInt(r.min, 10)+" and "+strconv.FormatInt(r.max, 10)+".")
		}
	}
	return nil
}

// parseBaseURL accepts https://host[:port][/prefix] (http:// only for a
// loopback host, for development), with no user info, query or fragment.
func parseBaseURL(raw string) (*url.URL, error) {
	s := strings.TrimSpace(raw)
	if s == "" || len(s) > maxSettingURLBytes {
		return nil, core.ErrInvalidURL
	}
	for _, r := range s {
		if unicode.IsSpace(r) || unicode.IsControl(r) {
			return nil, core.ErrInvalidURL
		}
	}
	u, err := url.Parse(s)
	if err != nil || u.Host == "" || u.Hostname() == "" || u.User != nil || u.Opaque != "" ||
		u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.Contains(s, "#") {
		return nil, core.ErrInvalidURL
	}
	switch strings.ToLower(u.Scheme) {
	case "https":
	case "http":
		if !isLoopbackHost(u.Hostname()) {
			return nil, core.ErrInvalidURL
		}
	default:
		return nil, core.ErrInvalidURL
	}
	return u, nil
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") || strings.HasSuffix(strings.ToLower(host), ".localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func trimBase(s string) string {
	return strings.TrimRight(strings.TrimSpace(s), "/")
}

func clamp64(v, lo, hi int64) int64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
