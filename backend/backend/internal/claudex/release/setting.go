package release

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
)

// SettingKey stores the desktop release information (design 1.6).
const SettingKey = "claudex_client_release"

// ChannelStable is the default release channel.
const ChannelStable = "stable"

// Limits of the release setting (design 2.2).
const (
	maxURLLength   = 2000
	maxNotesLength = 20000 // characters of release_notes_md
	maxBodyBytes   = 256 << 10
	maxFieldKey    = 64 // longest map key echoed back in an error's metadata.field
	maxBridgeLevel = 1 << 20
)

// Platforms are the accepted download keys, "<platform>-<arch>" as sent in
// X-Claudex-Platform and X-Claudex-Arch.
// Linux has one download per package format as well
// ("linux-x64-deb", "-rpm", "-tar"), picked with ?package= (LinuxPackages).
var Platforms = []string{"darwin-arm64", "darwin-x64", "darwin-universal", "win32-x64", "win32-arm64", "linux-x64", "linux-arm64",
	"linux-x64-deb", "linux-x64-rpm", "linux-x64-tar", "linux-arm64-deb", "linux-arm64-rpm", "linux-arm64-tar"}

// LinuxPackages are the package formats a Linux client may ask for.
var LinuxPackages = map[string]bool{"deb": true, "rpm": true, "tar": true}

var (
	platformKeys = func() map[string]bool {
		m := make(map[string]bool, len(Platforms))
		for _, p := range Platforms {
			m[p] = true
		}
		return m
	}()
	sha256Hex = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// Setting is the stored value of claudex_client_release.
//
//	{"channels":{"stable":{"latest_version":"1.4.0","minimum_version":"1.2.0",...,
//	  "downloads":{"darwin-arm64":{"url":"https://...","sha256":""},"linux-x64":null}}},
//	 "enforce_minimum_on_gateway":false}
type Setting struct {
	Channels map[string]*Channel `json:"channels"`
	// EnforceMinimumOnGateway turns on the gateway 426 for Claudex device keys
	// of desktop versions below minimum_version (owner decision 7: off by
	// default).
	EnforceMinimumOnGateway bool `json:"enforce_minimum_on_gateway"`
}

// Channel is one release channel. Empty strings mean "not set".
type Channel struct {
	DesktopUpdaterConfig *core.DesktopUpdaterConfig `json:"desktop_updater_config,omitempty"`
	LatestVersion        string                     `json:"latest_version"`
	MinimumVersion       string                     `json:"minimum_version"`
	PublishedAt          *time.Time                 `json:"published_at"`
	ReleaseNotesURL      string                     `json:"release_notes_url"`
	ReleaseNotesMD       string                     `json:"release_notes_md"`
	Downloads            map[string]*Download       `json:"downloads"`
	// UI is the desktop interface pack, published without an installer.
	UI *core.UIPack `json:"ui,omitempty"`
}

// Download is the installer of one platform. A null entry means that
// platform has no download.
type Download struct {
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
	// AppPack updates an install of the same runtime without the installer
	// (Windows; core.AppPack).
	AppPack *core.AppPack `json:"app_pack,omitempty"`
}

// defaults is "nothing configured": no channel, no enforcement. Maps stay nil
// here (core.JSONSetting decodes stored JSON on top of the defaults) and are
// filled in normalize.
func defaults() Setting { return Setting{} }

// normalize trims the text fields, lower-cases checksums, stores times in UTC
// and turns empty download entries into null. It never drops invalid values:
// validate must still see them on write, and Evaluate ignores them on read.
func normalize(s *Setting) {
	if s.Channels == nil {
		s.Channels = map[string]*Channel{}
	}
	for _, ch := range s.Channels {
		if ch == nil {
			continue
		}
		ch.LatestVersion = strings.TrimSpace(ch.LatestVersion)
		ch.MinimumVersion = strings.TrimSpace(ch.MinimumVersion)
		ch.ReleaseNotesURL = strings.TrimSpace(ch.ReleaseNotesURL)
		ch.ReleaseNotesMD = strings.TrimSpace(ch.ReleaseNotesMD)
		if ch.PublishedAt != nil {
			t := ch.PublishedAt.UTC()
			ch.PublishedAt = &t
		}
		if ch.Downloads == nil {
			ch.Downloads = map[string]*Download{}
		}
		for key, d := range ch.Downloads {
			if d == nil {
				continue
			}
			d.URL = strings.TrimSpace(d.URL)
			d.SHA256 = strings.ToLower(strings.TrimSpace(d.SHA256))
			if a := d.AppPack; a != nil {
				a.URL = strings.TrimSpace(a.URL)
				a.SHA256 = strings.ToLower(strings.TrimSpace(a.SHA256))
				a.Runtime = strings.TrimSpace(a.Runtime)
				a.Keep = strings.ToLower(strings.TrimSpace(a.Keep))
				if a.URL == "" && a.SHA256 == "" && a.Runtime == "" && a.Keep == "" {
					d.AppPack = nil
				}
			}
			if d.URL == "" && d.SHA256 == "" && d.AppPack == nil {
				ch.Downloads[key] = nil
			}
		}
		if ui := ch.UI; ui != nil {
			ui.Version = strings.TrimSpace(ui.Version)
			ui.URL = strings.TrimSpace(ui.URL)
			ui.SHA256 = strings.ToLower(strings.TrimSpace(ui.SHA256))
			if ui.Version == "" && ui.URL == "" && ui.SHA256 == "" {
				ch.UI = nil
			}
		}
	}
}

// invalid is the 400 CLAUDEX_RELEASE_INVALID answer with metadata field and
// rule.
func invalid(field, rule, message string) error {
	return core.InvalidSetting("CLAUDEX_RELEASE_INVALID", field, rule, message)
}

// fieldKey keeps user-supplied map keys short in error metadata.
func fieldKey(key string) string {
	if len(key) <= maxFieldKey {
		return key
	}
	cut := maxFieldKey
	for cut > 0 && !utf8.RuneStart(key[cut]) {
		cut--
	}
	return key[:cut] + "…"
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// validVersion is core.ValidVersion with numeric parts that fit int64:
// core.CompareVersions sorts a version with a larger part as invalid (before
// every valid one), so such a latest version made every client "current".
func validVersion(v string) bool {
	if !core.ValidVersion(v) {
		return false
	}
	nums := v
	if i := strings.IndexAny(nums, "-+"); i >= 0 {
		nums = nums[:i]
	}
	for _, part := range strings.Split(nums, ".") {
		if _, err := strconv.ParseInt(part, 10, 64); err != nil {
			return false
		}
	}
	return true
}

// validPublishedAt keeps publish times that JSON can carry (years 1 to 9999
// in UTC): time.Time refuses to marshal others, which made the PUT a 500.
func validPublishedAt(t time.Time) bool {
	y := t.UTC().Year()
	return y >= 1 && y <= 9999
}

// validate checks a normalized setting (design 2.2).
func validate(s *Setting) error {
	for _, name := range sortedKeys(s.Channels) {
		if name != ChannelStable && !core.ValidDeviceID(name) {
			return invalid("channels."+fieldKey(name), "unknown_channel", "Use stable or a UUID release channel.")
		}
		if err := validateChannel(s.Channels[name], "channels."+name+"."); err != nil {
			return err
		}
	}
	return nil
}

func validateChannel(ch *Channel, p string) error {
	if ch == nil {
		return nil
	}
	if ch.LatestVersion != "" && !validVersion(ch.LatestVersion) {
		return invalid(p+"latest_version", "version", "Enter the latest version like 1.4.0 or 1.4.0-beta.1.")
	}
	if ch.MinimumVersion != "" {
		switch {
		case !validVersion(ch.MinimumVersion):
			return invalid(p+"minimum_version", "version", "Enter the minimum version like 1.2.0.")
		case ch.LatestVersion == "":
			return invalid(p+"minimum_version", "requires_latest_version", "Set the latest version before the minimum version.")
		case core.CompareVersions(ch.MinimumVersion, ch.LatestVersion) > 0:
			return invalid(p+"minimum_version", "above_latest_version", "The minimum version can't be newer than the latest version.")
		}
	}
	if ch.PublishedAt != nil && !validPublishedAt(*ch.PublishedAt) {
		return invalid(p+"published_at", "rfc3339", "Enter the publish time as an RFC 3339 timestamp like 2026-09-20T08:00:00Z.")
	}
	if ch.ReleaseNotesURL != "" {
		if _, err := core.HTTPSURL(ch.ReleaseNotesURL, maxURLLength); err != nil {
			return invalid(p+"release_notes_url", "https_url", "The release notes link must be an https URL of at most 2000 characters.")
		}
	}
	if utf8.RuneCountInString(ch.ReleaseNotesMD) > maxNotesLength {
		return invalid(p+"release_notes_md", "max_length", "Release notes can be at most 20000 characters.")
	}
	if ui := ch.UI; ui != nil {
		if !validVersion(ui.Version) {
			return invalid(p+"ui.version", "version", "Enter the interface pack version like 1.0.3.")
		}
		if ui.Bridge < 1 || ui.Bridge > maxBridgeLevel {
			return invalid(p+"ui.bridge", "range", "The bridge level must be a whole number from 1.")
		}
		if _, err := core.HTTPSURL(ui.URL, maxURLLength); err != nil {
			return invalid(p+"ui.url", "https_url", "The interface pack link must be an https URL of at most 2000 characters.")
		}
		if !sha256Hex.MatchString(ui.SHA256) {
			return invalid(p+"ui.sha256", "sha256_hex", "The interface pack needs its SHA-256 checksum (64 hexadecimal characters).")
		}
	}
	for _, key := range sortedKeys(ch.Downloads) {
		field := p + "downloads." + fieldKey(key)
		if !platformKeys[key] {
			return invalid(field, "unknown_platform", "Downloads are only for "+strings.Join(Platforms, ", ")+".")
		}
		d := ch.Downloads[key]
		if d == nil {
			continue
		}
		if _, err := core.HTTPSURL(d.URL, maxURLLength); err != nil {
			return invalid(field+".url", "https_url", "The download link must be an https URL of at most 2000 characters.")
		}
		if d.SHA256 != "" && !sha256Hex.MatchString(d.SHA256) {
			return invalid(field+".sha256", "sha256_hex", "The SHA-256 checksum must be 64 hexadecimal characters.")
		}
		if a := d.AppPack; a != nil {
			if _, err := core.HTTPSURL(a.URL, maxURLLength); err != nil {
				return invalid(field+".app_pack.url", "https_url", "The app pack link must be an https URL of at most 2000 characters.")
			}
			if !sha256Hex.MatchString(a.SHA256) {
				return invalid(field+".app_pack.sha256", "sha256_hex", "The app pack needs its SHA-256 checksum (64 hexadecimal characters).")
			}
			if !sha256Hex.MatchString(a.Keep) {
				return invalid(field+".app_pack.keep", "sha256_hex", "The app pack needs the SHA-256 of the files it leaves in place.")
			}
			if !validVersion(a.Runtime) {
				return invalid(field+".app_pack.runtime", "version", "The app pack needs the runtime version it was built for.")
			}
		}
	}
	return nil
}

// settingInput is the admin PUT body: the setting itself (strict: unknown
// keys are refused so a misspelled switch is never silently ignored), plus
// updated_at, which GET returns and a client may send back (ignored).
type settingInput struct {
	Channels                map[string]*channelInput `json:"channels"`
	EnforceMinimumOnGateway bool                     `json:"enforce_minimum_on_gateway"`
	UpdatedAt               json.RawMessage          `json:"updated_at"`
}

type channelInput struct {
	DesktopUpdaterConfig *core.DesktopUpdaterConfig `json:"desktop_updater_config"`
	LatestVersion        string                     `json:"latest_version"`
	MinimumVersion       string                     `json:"minimum_version"`
	PublishedAt          *string                    `json:"published_at"`
	ReleaseNotesURL      string                     `json:"release_notes_url"`
	ReleaseNotesMD       string                     `json:"release_notes_md"`
	Downloads            map[string]*Download       `json:"downloads"`
	UI                   *core.UIPack               `json:"ui"`
}

// decodeSetting parses an admin PUT body into a setting (not yet normalized
// or validated; JSONSetting.Set does both).
func decodeSetting(body []byte) (Setting, error) {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return Setting{}, invalid("body", "json_object", "Send the release settings as a JSON object.")
	}
	var in settingInput
	if err := decodeStrict(trimmed, &in); err != nil {
		return Setting{}, err
	}

	out := Setting{EnforceMinimumOnGateway: in.EnforceMinimumOnGateway, Channels: map[string]*Channel{}}
	for _, name := range sortedKeys(in.Channels) {
		if name != ChannelStable && !core.ValidDeviceID(name) {
			return Setting{}, invalid("channels."+fieldKey(name), "unknown_channel", "Use stable or a UUID release channel.")
		}
		ci := in.Channels[name]
		if ci == nil {
			out.Channels[name] = nil
			continue
		}
		ch := &Channel{
			DesktopUpdaterConfig: ci.DesktopUpdaterConfig,
			LatestVersion:        ci.LatestVersion,
			MinimumVersion:       ci.MinimumVersion,
			ReleaseNotesURL:      ci.ReleaseNotesURL,
			ReleaseNotesMD:       ci.ReleaseNotesMD,
			Downloads:            ci.Downloads,
			UI:                   ci.UI,
		}
		if ci.PublishedAt != nil && strings.TrimSpace(*ci.PublishedAt) != "" {
			t, err := time.Parse(time.RFC3339, strings.TrimSpace(*ci.PublishedAt))
			if err != nil {
				return Setting{}, invalid("channels."+name+".published_at", "rfc3339",
					"Enter the publish time as an RFC 3339 timestamp like 2026-09-20T08:00:00Z.")
			}
			ch.PublishedAt = &t
		}
		out.Channels[name] = ch
	}
	return out, nil
}

// decodeStrict decodes exactly one JSON value, refusing unknown keys, and
// maps decoding errors to CLAUDEX_RELEASE_INVALID.
func decodeStrict(data []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return decodeError(err)
	}
	if err := dec.Decode(&json.RawMessage{}); !errors.Is(err, io.EOF) {
		return invalid("body", "json", "The request body must hold one JSON object.")
	}
	return nil
}

func decodeError(err error) error {
	var typeErr *json.UnmarshalTypeError
	if errors.As(err, &typeErr) {
		field := typeErr.Field
		if field == "" {
			field = "body"
		}
		return invalid(field, "type", "The value of "+field+" has the wrong type.")
	}
	if name, ok := unknownField(err); ok {
		return invalid(fieldKey(name), "unknown_field", "Unknown setting "+strconv.Quote(fieldKey(name))+".")
	}
	return invalid("body", "json", "The request body is not valid JSON.")
}

// unknownField extracts the key from encoding/json's `json: unknown field "x"`.
func unknownField(err error) (string, bool) {
	const prefix = "json: unknown field "
	msg := err.Error()
	if !strings.HasPrefix(msg, prefix) {
		return "", false
	}
	name, uerr := strconv.Unquote(strings.TrimPrefix(msg, prefix))
	if uerr != nil {
		return "", false
	}
	return name, true
}
