package bootstrap

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/gatewayhook"
	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/pkg/timezone"
)

// provisioningKey is the B4 devices setting; B9 reads only its "enabled"
// switch (design 2.5: device keys are provisioned while it is on).
const provisioningKey = "claudex_provisioning"

type provisioningView struct {
	Enabled bool `json:"enabled"`
}

// defaultProvisioningView matches the B4 default: provisioning is on until
// an administrator stores enabled:false.
func defaultProvisioningView() provisioningView { return provisioningView{Enabled: true} }

// fallbackSiteName is what upstream SettingService.GetSiteName answers when
// no site name is stored.
const fallbackSiteName = "Claudex"

// Server is the server section.
type Server struct {
	SiteName string `json:"site_name"`
	Version  string `json:"version"`  // build version, e.g. 0.2.8+claudex.1
	Timezone string `json:"timezone"` // IANA name the server runs in (as upstream public settings)
}

// Features tells the desktop client which server features it may show
// (design 2.10). A feature is true only when this server really serves it.
type Features struct {
	DeviceKeys         bool `json:"device_keys"`
	UsageStatus        bool `json:"usage_status"`
	StructuredRefusals bool `json:"structured_refusals"`
	ModelCatalog       bool `json:"model_catalog"`
	VoiceTranscription bool `json:"voice_transcription"`
	VoiceSpeech        bool `json:"voice_speech"`
	Payment            bool `json:"payment"`
	DesktopCheckout    bool `json:"desktop_checkout"`
	Redeem             bool `json:"redeem"`
	Diagnostics        bool `json:"diagnostics"`
	Feedback           bool `json:"feedback"`
	SelfDelete         bool `json:"self_delete"`
	Announcements      bool `json:"announcements"`
}

// localInfo is what B9 reads from upstream settings for server and features.
type localInfo struct {
	server             Server
	paymentEnabled     bool
	provisioningActive bool
}

// readLocal reads the site name, the upstream payment switch and the B4
// provisioning switch within the section budget; on timeout it falls back to
// the upstream defaults (and payment off).
func (c *Component) readLocal(ctx context.Context) localInfo {
	info, err := within(ctx, c.timeout, func(ctx context.Context) (localInfo, error) {
		info := c.fallbackLocal()
		if c.env.SettingService != nil {
			info.server.SiteName = c.env.SettingService.GetSiteName(ctx)
		}
		if c.env.PaymentConfig != nil {
			info.paymentEnabled = c.env.PaymentConfig.IsPaymentEnabled(ctx)
		}
		info.provisioningActive = c.provisioning.Cached(ctx).Enabled
		return info, nil
	})
	if err != nil {
		info = c.fallbackLocal()
		info.provisioningActive = c.provisioning.Default().Enabled
		slog.Warn("claudex bootstrap: reading server settings failed, using defaults", "code", sectionCode(err), "error", err)
	}
	return info
}

func (c *Component) fallbackLocal() localInfo {
	return localInfo{server: Server{
		SiteName: fallbackSiteName,
		Version:  c.env.BuildInfo.Version,
		Timezone: timezone.Name(),
	}}
}

// features computes the feature switches from the installed components, the
// upstream settings and the sections that made it into this document (a
// missing voice or feedback section turns its features off).
func (c *Component) features(info localInfo, sections map[string]json.RawMessage) Features {
	var voice struct {
		Available struct {
			Transcription bool `json:"transcription"`
			Speech        bool `json:"speech"`
		} `json:"available"`
	}
	if raw, ok := sections[core.SectionVoice]; ok {
		_ = json.Unmarshal(raw, &voice) // not an object: both stay false
	}
	var feedback struct {
		Diagnostics struct {
			Enabled bool `json:"enabled"`
		} `json:"diagnostics"`
		Feedback struct {
			Enabled bool `json:"enabled"`
		} `json:"feedback"`
	}
	if raw, ok := sections[core.SectionFeedback]; ok {
		_ = json.Unmarshal(raw, &feedback)
	}
	servesUserRoutes := func(f core.Feature) bool {
		_, ok := f.(core.UserRouter)
		return ok
	}
	servesCheckout := func(f core.Feature) bool {
		_, user := f.(core.UserRouter)
		_, public := f.(core.PublicRouter)
		return user && public
	}
	describesRefusals := func(f core.Feature) bool {
		_, ok := f.(gatewayhook.RefusalDescriber)
		return ok
	}
	payment := info.paymentEnabled
	return Features{
		// B4 serves POST /claudex/devices and provisioning is not turned off.
		DeviceKeys: info.provisioningActive && c.provides(core.NameDevices, servesUserRoutes),
		// B5 serves GET /claudex/usage-status.
		UsageStatus: c.provides(core.NameUsage, servesUserRoutes),
		// B6 describes gateway refusals of device keys.
		StructuredRefusals: c.provides(core.NameRefusal, describesRefusals),
		// B3 serves GET /claudex/models.
		ModelCatalog: c.provides(core.NameCatalog, servesUserRoutes),
		// B7's voice section says what is available.
		VoiceTranscription: voice.Available.Transcription,
		VoiceSpeech:        voice.Available.Speech,
		// Upstream payment_enabled; B10 serves the checkout links and the
		// public checkout API behind /desktop-pay.
		Payment:         payment,
		DesktopCheckout: payment && c.provides(core.NamePayment, servesCheckout),
		Redeem:          !c.simpleMode(),
		// B8's feedback section mirrors the administrator's switches.
		Diagnostics: feedback.Diagnostics.Enabled,
		Feedback:    feedback.Feedback.Enabled,
		// Owner decision: only administrators delete accounts.
		SelfDelete: false,
		// Upstream announcements are always there.
		Announcements: true,
	}
}

// provides reports whether the component with this name is installed and
// passes check (it implements the interface that serves the feature). A
// component still at its B0 stub serves nothing, so its feature stays off.
func (c *Component) provides(name string, check func(core.Feature) bool) bool {
	for _, f := range c.env.Components {
		if f != nil && f.Name() == name {
			return check(f)
		}
	}
	return false
}

// simpleMode reports whether the server runs upstream's simple mode, where
// balances and redeem codes are not used.
func (c *Component) simpleMode() bool {
	return c.env.Config != nil && c.env.Config.RunMode == config.RunModeSimple
}
