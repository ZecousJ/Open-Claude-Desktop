// Package voice is the B7 component (design 2.8, owner decisions 18/19):
// dictation through a realtime transcription WebSocket. The desktop app
// connects to GET /v1/audio/realtime/transcriptions with its device key; the
// gateway checks the key, the Claudex guards and the usage rules, then relays
// the session to the upstream service with the API key an administrator
// stored here (claudex_voice), and bills the audio seconds forwarded. The
// web app (W-VOICE, web_ticket.go) opens the same endpoint with a one-time
// web ticket that becomes the user's managed web key before API-key
// authentication, so the same checks and billing apply to it.
//
// This package holds the settings (the upstream key is write-only and
// encrypted), the admin pages, the bootstrap section "voice", the session
// log (claudex_voice_sessions) and the relay itself (relay.go). The gateway
// handler lives in internal/handler/claudex_openai_audio.go and the billing
// in internal/service/claudex_openai_audio.go (the exception of design 1.3:
// they reuse unexported gateway helpers). Text to speech is not offered
// (owner decision 19).
package voice

import (
	"context"
	"errors"
	"sync/atomic"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/devices"
	"github.com/Wei-Shaw/sub2api/internal/claudex/gatewayhook"

	"github.com/gin-gonic/gin"
)

// Gateway route of the realtime transcription endpoint (c.FullPath()).
const RealtimeTranscriptionsPath = "/v1/audio/realtime/transcriptions"

// Error codes of the endpoint.
const (
	// ReasonDisabled: dictation is off or has no upstream key (404).
	ReasonDisabled = "CLAUDEX_AUDIO_DISABLED"
	// ReasonUnavailable: the stored upstream key cannot be read (503).
	ReasonUnavailable = "CLAUDEX_AUDIO_UNAVAILABLE"
	// ReasonDeviceKeyRequired: the key is not a Claudex device key (403).
	ReasonDeviceKeyRequired = "CLAUDEX_AUDIO_DEVICE_KEY_REQUIRED"
	// ReasonUpstreamUnavailable: the upstream handshake failed (502).
	ReasonUpstreamUnavailable = "CLAUDEX_AUDIO_UPSTREAM_UNAVAILABLE"
)

// BilledModel is the model name of dictation usage: the usage event (and so
// the per-model usage rules) and the session log use it.
const BilledModel = "realtime-transcription"

// Component is the B7 component.
type Component struct {
	env     *core.Env
	setting *core.JSONSetting[Settings]
	box     *secretBox
	// tickets are the one-time web tickets of the dictation socket
	// (web_ticket.go).
	tickets webTicketStore

	// webGate and webKeyIssuer replace the lookups in env.Components (tests).
	webGate      func() WebSessions
	webKeyIssuer func() devices.WebKeyIssuer
}

// active is the component the gateway handler reads (the last one built;
// the server builds exactly one module).
var active atomic.Pointer[Component]

// New builds the component. It must not call its dependencies or env.Peers:
// ProvideModule binds the peers after every component is built, and tests
// pass empty Deps.
func New(env *core.Env) *Component {
	if env == nil {
		env = &core.Env{}
	}
	c := &Component{
		env: env,
		setting: core.NewJSONSetting(env.SettingRepo, SettingKey, defaultSettings,
			core.WithNormalize(normalize), core.WithValidate(validate)),
		box:     newSecretBox(env.Config),
		tickets: newWebTicketStore(env),
	}
	active.Store(c)
	// W-VOICE: the web app's one-time ticket becomes the user's web key
	// before API-key authentication (ProvideModule reset the registry).
	gatewayhook.RegisterPreAuth(RealtimeTranscriptionsPath, webTicketPreAuth)
	return c
}

// Name implements core.Feature.
func (c *Component) Name() string { return core.NameVoice }

// SettingKeys implements core.SettingsOwner.
func (c *Component) SettingKeys() []string { return []string{c.setting.Key()} }

// Current returns the voice settings: the value of the per-process settings
// cache (60 s; a save on this node refreshes it at once). Without an
// installed component it returns the defaults, in which dictation is off.
func Current() Settings {
	if c := active.Load(); c != nil {
		return c.setting.Cached(context.Background())
	}
	s := defaultSettings()
	normalize(&s)
	return s
}

// Errors of ResolveUpstream.
var (
	ErrDisabled    = errors.New("voice: dictation is not enabled")
	ErrUnavailable = errors.New("voice: the upstream API key is unavailable")
)

// Upstream is what the gateway handler needs for one session. APIKey is the
// plaintext upstream key: send it only in the upstream Authorization header,
// never log it or return it.
type Upstream struct {
	URL    string
	APIKey string
	Limits Limits
}

// ResolveUpstream returns the upstream of a new session: ErrDisabled when
// dictation is off or has no key, ErrUnavailable when the stored key cannot
// be decrypted (the server encryption key changed).
func ResolveUpstream() (Upstream, error) {
	c := active.Load()
	if c == nil {
		return Upstream{}, ErrDisabled
	}
	t := c.setting.Cached(context.Background()).Transcription
	if !t.Enabled || !t.KeyConfigured() {
		return Upstream{}, ErrDisabled
	}
	key, err := c.box.open(t.APIKeyCiphertext)
	if err != nil {
		return Upstream{}, ErrUnavailable
	}
	return Upstream{URL: t.UpstreamURL, APIKey: key, Limits: limitsOf(t)}, nil
}

func limitsOf(t TranscriptionSettings) Limits {
	return Limits{
		MaxBytes:    t.MaxBytes,
		MaxDuration: time.Duration(t.MaxSessionSeconds) * time.Second,
		IdleTimeout: time.Duration(t.IdleTimeoutSeconds) * time.Second,
	}
}

// RecordSession stores one billed session in claudex_voice_sessions (the
// admin session list). It is idempotent per request id.
func RecordSession(ctx context.Context, s Session) error {
	c := active.Load()
	if c == nil || c.env.DB == nil {
		return errSessionStoreUnavailable
	}
	return insertSession(ctx, c.env.DB, s)
}

// RegisterAdminRoutes implements core.AdminRouter: GET/PUT /voice and
// GET /voice/estimated-usage (the session list), inside the admin group
// (admin auth, audit log, AdminComplianceGuard). PUT stores the upstream API
// key, so it goes through step-up like the other high-risk Claudex writes.
func (c *Component) RegisterAdminRoutes(g *gin.RouterGroup, stepUp gin.HandlerFunc) {
	if stepUp == nil {
		stepUp = func(g *gin.Context) { g.Next() }
	}
	g.GET("/voice", c.adminGet)
	g.PUT("/voice", stepUp, c.adminPut)
	g.GET("/voice/estimated-usage", c.adminSessions)
}

// Sections implements core.BootstrapContributor.
func (c *Component) Sections() []string { return []string{core.SectionVoice} }

// BootstrapSections implements core.BootstrapContributor.
func (c *Component) BootstrapSections(ctx context.Context, _ *core.BootstrapContext) (map[string]any, error) {
	return map[string]any{core.SectionVoice: bootstrapSectionFor(c.setting.Cached(ctx))}, nil
}

// BootstrapSection is the "voice" section of GET /api/v1/claudex/bootstrap.
type BootstrapSection struct {
	Transcription BootstrapTranscription `json:"transcription"`
	Available     BootstrapAvailability  `json:"available"`
}

// BootstrapTranscription describes the realtime transcription endpoint; path,
// audio and limits are null/0 while it is off.
type BootstrapTranscription struct {
	Enabled            bool            `json:"enabled"`
	Protocol           string          `json:"protocol"` // "websocket"
	Path               *string         `json:"path"`
	Audio              *BootstrapAudio `json:"audio"`
	MaxSessionSeconds  int             `json:"max_session_seconds"`
	MaxBytes           int64           `json:"max_bytes"`
	IdleTimeoutSeconds int             `json:"idle_timeout_seconds"`
}

// BootstrapAudio is the only audio format the endpoint accepts.
type BootstrapAudio struct {
	Format     string `json:"format"`
	SampleRate int    `json:"sample_rate"`
	Channels   int    `json:"channels"`
}

// BootstrapAvailability says what the desktop app can use.
type BootstrapAvailability struct {
	Transcription bool `json:"transcription"`
}

func bootstrapSectionFor(s Settings) BootstrapSection {
	t := s.Transcription
	on := t.Enabled && t.KeyConfigured()
	out := BootstrapSection{Transcription: BootstrapTranscription{Enabled: on, Protocol: "websocket"}}
	if on {
		path := RealtimeTranscriptionsPath
		out.Transcription.Path = &path
		out.Transcription.Audio = &BootstrapAudio{Format: AudioFormat, SampleRate: SampleRate, Channels: Channels}
		out.Transcription.MaxSessionSeconds = t.MaxSessionSeconds
		out.Transcription.MaxBytes = t.MaxBytes
		out.Transcription.IdleTimeoutSeconds = t.IdleTimeoutSeconds
	}
	out.Available.Transcription = on
	return out
}

var (
	_ core.Feature              = (*Component)(nil)
	_ core.SettingsOwner        = (*Component)(nil)
	_ core.AdminRouter          = (*Component)(nil)
	_ core.PublicRouter         = (*Component)(nil)
	_ core.BootstrapContributor = (*Component)(nil)
)
