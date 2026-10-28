package voice

import (
	"fmt"
	"net"
	"net/url"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
)

// SettingKey stores the voice settings (design 2.8, owner decisions 18/19).
const SettingKey = "claudex_voice"

// ReasonInvalid is the 400 reason of a rejected settings document.
const ReasonInvalid = "CLAUDEX_VOICE_INVALID"

// DefaultUpstreamURL is the realtime transcription service an unset
// setting uses: none, until the administrator enters one.
const DefaultUpstreamURL = ""

// Audio format of the realtime endpoint: 16 kHz mono signed 16-bit
// little-endian PCM, so one second of audio is 32000 bytes. Sessions are
// billed by the audio bytes forwarded upstream divided by BytesPerSecond.
const (
	AudioFormat     = "pcm_s16le"
	SampleRate      = 16000
	Channels        = 1
	BytesPerSecond  = 32000
	upstreamURLMax  = 2048
	apiKeyMinLength = 8
	apiKeyMaxLength = 512
)

// Limits of the settings.
const (
	MinMaxSessionSeconds        = 10
	MaxMaxSessionSeconds        = 3600
	MinMaxBytes           int64 = BytesPerSecond                        // 1 s of audio
	MaxMaxBytes           int64 = MaxMaxSessionSeconds * BytesPerSecond // 1 h of audio
	MinIdleTimeoutSeconds       = 5
	MaxIdleTimeoutSeconds       = 300

	defaultMaxSessionSeconds        = 300
	defaultMaxBytes           int64 = defaultMaxSessionSeconds * BytesPerSecond
	defaultIdleTimeoutSeconds       = 30
)

// Settings is the stored claudex_voice document. Dictation is off until an
// administrator stores the upstream API key and turns it on. There is no
// read-aloud (speech) section: owner decision 19 removed text to speech.
type Settings struct {
	Transcription TranscriptionSettings `json:"transcription"`
}

// TranscriptionSettings configures GET /v1/audio/realtime/transcriptions, a
// WebSocket relay to the realtime transcription service.
type TranscriptionSettings struct {
	Enabled bool `json:"enabled"`
	// UpstreamURL is the wss:// URL of the realtime transcription service.
	UpstreamURL string `json:"upstream_url"`
	// APIKeyCiphertext is the upstream API key encrypted with the server's
	// secret encryption key (AES-256-GCM, see secret.go). It never leaves the
	// server: the admin view only says whether a key is stored and shows its
	// last characters (APIKeyHint).
	APIKeyCiphertext string `json:"api_key_ciphertext,omitempty"`
	APIKeyHint       string `json:"api_key_hint,omitempty"`
	// MaxSessionSeconds limits the wall-clock length of one session.
	MaxSessionSeconds int `json:"max_session_seconds"`
	// MaxBytes limits the audio forwarded upstream in one session.
	MaxBytes int64 `json:"max_bytes"`
	// IdleTimeoutSeconds closes a session in which neither side sent a frame
	// for this long.
	IdleTimeoutSeconds int `json:"idle_timeout_seconds"`
}

// KeyConfigured reports whether an upstream API key is stored.
func (t TranscriptionSettings) KeyConfigured() bool { return t.APIKeyCiphertext != "" }

func defaultSettings() Settings {
	return Settings{Transcription: TranscriptionSettings{
		UpstreamURL:        DefaultUpstreamURL,
		MaxSessionSeconds:  defaultMaxSessionSeconds,
		MaxBytes:           defaultMaxBytes,
		IdleTimeoutSeconds: defaultIdleTimeoutSeconds,
	}}
}

// normalize trims the URL. It never changes numbers: out-of-range values are
// reported by validate.
func normalize(s *Settings) {
	s.Transcription.UpstreamURL = strings.TrimSpace(s.Transcription.UpstreamURL)
	if s.Transcription.APIKeyCiphertext == "" {
		s.Transcription.APIKeyHint = ""
	}
}

func validate(s *Settings) error {
	t := &s.Transcription
	// No service yet is allowed while dictation is off.
	if t.UpstreamURL != "" || t.Enabled {
		if err := validateUpstreamURL(t.UpstreamURL); err != nil {
			return err
		}
	}
	if t.MaxSessionSeconds < MinMaxSessionSeconds || t.MaxSessionSeconds > MaxMaxSessionSeconds {
		return invalid("transcription.max_session_seconds", "range",
			fmt.Sprintf("transcription.max_session_seconds must be between %d and %d", MinMaxSessionSeconds, MaxMaxSessionSeconds))
	}
	if t.MaxBytes < MinMaxBytes || t.MaxBytes > MaxMaxBytes {
		return invalid("transcription.max_bytes", "range",
			fmt.Sprintf("transcription.max_bytes must be between %d and %d", MinMaxBytes, MaxMaxBytes))
	}
	if t.IdleTimeoutSeconds < MinIdleTimeoutSeconds || t.IdleTimeoutSeconds > MaxIdleTimeoutSeconds {
		return invalid("transcription.idle_timeout_seconds", "range",
			fmt.Sprintf("transcription.idle_timeout_seconds must be between %d and %d", MinIdleTimeoutSeconds, MaxIdleTimeoutSeconds))
	}
	if t.Enabled && !t.KeyConfigured() {
		return invalid("transcription.api_key", "required", "Store the upstream API key before turning dictation on")
	}
	return nil
}

// validateUpstreamURL accepts wss:// URLs, and ws:// only for loopback hosts
// (local tests and development), without credentials or a fragment. The API
// key goes in the Authorization header, never in the URL.
func validateUpstreamURL(raw string) error {
	const field = "transcription.upstream_url"
	if raw == "" || len(raw) > upstreamURLMax {
		return invalid(field, "length", fmt.Sprintf("%s must be 1-%d characters", field, upstreamURLMax))
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.Opaque != "" {
		return invalid(field, "format", field+" must be an absolute wss:// URL")
	}
	switch u.Scheme {
	case "wss":
	case "ws":
		if !isLoopbackHost(u.Hostname()) {
			return invalid(field, "scheme", field+" must use wss:// (ws:// is only allowed for localhost)")
		}
	default:
		return invalid(field, "scheme", field+" must be a wss:// URL")
	}
	if u.User != nil || u.Fragment != "" {
		return invalid(field, "format", field+" must not contain credentials or a fragment")
	}
	for name := range u.Query() {
		if n := strings.ToLower(name); n == "api_key" || n == "key" || n == "token" {
			return invalid(field, "format", field+" must not carry the API key; store it in transcription.api_key")
		}
	}
	return nil
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// validateAPIKey checks a key an administrator submits.
func validateAPIKey(key string) error {
	const field = "transcription.api_key"
	n := utf8.RuneCountInString(key)
	if n < apiKeyMinLength || n > apiKeyMaxLength {
		return invalid(field, "length", fmt.Sprintf("%s must be %d-%d characters", field, apiKeyMinLength, apiKeyMaxLength))
	}
	for _, r := range key {
		if unicode.IsSpace(r) || unicode.IsControl(r) {
			return invalid(field, "format", field+" must not contain spaces or control characters")
		}
	}
	return nil
}

// keyHint is the part of an API key the admin view shows: its last four
// characters, and only for keys long enough that this reveals little.
func keyHint(key string) string {
	r := []rune(key)
	if len(r) < 16 {
		return ""
	}
	return string(r[len(r)-4:])
}

func invalid(field, rule, message string) error {
	return core.InvalidSetting(ReasonInvalid, field, rule, message)
}
