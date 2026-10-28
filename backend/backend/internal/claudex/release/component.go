// Package release is the B1 component for the desktop client release info
// (design 2.2):
//
//   - setting claudex_client_release (admin GET/PUT /api/v1/admin/claudex/release,
//     PUT behind step-up);
//   - core.ReleaseInfo: the module registers the public
//     GET /api/v1/claudex/release and merges Evaluate into its answer (this
//     package never registers that route);
//   - the bootstrap section "release";
//   - the gateway RequestGuard (priority 20, hook H5b) that answers 426
//     CLAUDEX_UPGRADE_REQUIRED to Claudex device keys of desktop versions
//     below the minimum, only when enforce_minimum_on_gateway is on (owner
//     decision 7: off by default).
package release

import (
	"context"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/service"
)

// Component is the B1 client-release component.
type Component struct {
	env     *core.Env
	setting *core.JSONSetting[Setting]
	mobile  *core.JSONSetting[MobileSetting]
}

// New builds the component. It does not touch its dependencies or env.Peers
// (ProvideModule binds the peers after every component is built, and tests
// pass empty Deps).
func New(env *core.Env) *Component {
	var repo service.SettingRepository
	if env != nil {
		repo = env.SettingRepo
	}
	return &Component{
		env:     env,
		setting: core.NewJSONSetting(repo, SettingKey, defaults, core.WithNormalize(normalize), core.WithValidate(validate)),
		mobile:  core.NewJSONSetting(repo, MobileSettingKey, mobileDefaults),
	}
}

// Name implements core.Feature.
func (c *Component) Name() string { return core.NameRelease }

// SettingKeys implements core.SettingsOwner.
func (c *Component) SettingKeys() []string { return []string{c.setting.Key(), c.mobile.Key()} }

// Evaluate implements core.ReleaseInfo for a client on platform/arch running
// version (each may be ""; the callers pass validated values).
//
// state: nothing configured or no version → unknown; version < minimum →
// required; version < latest → available; otherwise current (semver
// precedence, build metadata ignored). Values that fail validation (written
// to the database by hand) are treated as not set.
func (c *Component) Evaluate(ctx context.Context, platform, arch, version string) core.ReleaseState {
	s := c.setting.Cached(ctx)
	rs := core.ReleaseState{State: core.ReleaseStateUnknown, Enforced: s.EnforceMinimumOnGateway}
	request, _ := ctx.Value(updateRequestKey{}).(updateRequest)
	// A test channel that is gone (removed once its release went out) falls
	// back to stable: a device still naming it keeps getting the published
	// release and interface pack instead of none, which would take its pack
	// back to the installer's interface.
	channel := ChannelStable
	if core.ValidDeviceID(request.channelUUID) && s.Channels[request.channelUUID] != nil {
		channel = request.channelUUID
	}
	ch := s.Channels[channel]
	if ch == nil {
		return rs
	}
	rs.Channel = channel
	rs.DesktopUpdaterConfig = ch.DesktopUpdaterConfig
	if validVersion(request.maxVersion) && validVersion(ch.LatestVersion) && core.CompareVersions(ch.LatestVersion, request.maxVersion) > 0 {
		return rs
	}
	if validVersion(ch.LatestVersion) {
		rs.LatestVersion = ch.LatestVersion
	}
	if rs.LatestVersion != "" && validVersion(ch.MinimumVersion) && core.CompareVersions(ch.MinimumVersion, rs.LatestVersion) <= 0 {
		rs.MinimumVersion = ch.MinimumVersion
	}
	if u, err := core.HTTPSURL(ch.ReleaseNotesURL, maxURLLength); err == nil {
		rs.ReleaseNotesURL = u
	}
	rs.ReleaseNotesMD = ch.ReleaseNotesMD
	if ch.PublishedAt != nil && validPublishedAt(*ch.PublishedAt) {
		t := ch.PublishedAt.UTC()
		rs.PublishedAt = &t
	}
	if platform != "" && arch != "" {
		d := ch.Downloads[platform+"-"+arch]
		if d == nil && platform == "darwin" {
			d = ch.Downloads["darwin-universal"]
		}
		if d != nil {
			if u, err := core.HTTPSURL(d.URL, maxURLLength); err == nil {
				rs.DownloadURL = u
				if sha256Hex.MatchString(d.SHA256) {
					rs.SHA256 = d.SHA256
				}
			}
			if a := d.AppPack; a != nil && sha256Hex.MatchString(a.SHA256) && sha256Hex.MatchString(a.Keep) && validVersion(a.Runtime) {
				if u, err := core.HTTPSURL(a.URL, maxURLLength); err == nil {
					rs.AppPack = &core.AppPack{URL: u, SHA256: a.SHA256, Runtime: a.Runtime, Keep: a.Keep}
				}
			}
		}
	}
	// The interface pack serves every desktop platform alike (it is the
	// window's own code); values that fail validation are left out.
	if ui := ch.UI; ui != nil && validVersion(ui.Version) && ui.Bridge >= 1 && sha256Hex.MatchString(ui.SHA256) {
		if u, err := core.HTTPSURL(ui.URL, maxURLLength); err == nil {
			rs.UI = &core.UIPack{Version: ui.Version, Bridge: ui.Bridge, URL: u, SHA256: ui.SHA256}
		}
	}
	rs.State = state(version, rs.LatestVersion, rs.MinimumVersion)
	return rs
}

type updateRequestKey struct{}
type updateRequest struct{ channelUUID, maxVersion string }

func WithUpdateRequest(ctx context.Context, channelUUID, maxVersion string) context.Context {
	return context.WithValue(ctx, updateRequestKey{}, updateRequest{channelUUID, maxVersion})
}

func state(version, latest, minimum string) string {
	switch {
	case latest == "" || version == "":
		return core.ReleaseStateUnknown
	case minimum != "" && core.CompareVersions(version, minimum) < 0:
		return core.ReleaseStateRequired
	case core.CompareVersions(version, latest) < 0:
		return core.ReleaseStateAvailable
	}
	return core.ReleaseStateCurrent
}

// Public is the client release part of GET /api/v1/claudex/release and of
// the bootstrap section "release": empty values are null (same shape as the
// module's merge in routes.go).
type Public struct {
	DesktopUpdaterConfig *core.DesktopUpdaterConfig `json:"desktop_updater_config,omitempty"`
	Channel              *string                    `json:"channel"`
	LatestVersion        *string                    `json:"latest_version"`
	MinimumVersion       *string                    `json:"minimum_version"`
	State                string                     `json:"state"`
	Enforced             bool                       `json:"enforced"`
	DownloadURL          *string                    `json:"download_url"`
	SHA256               *string                    `json:"sha256"`
	ReleaseNotesURL      *string                    `json:"release_notes_url"`
	ReleaseNotesMD       *string                    `json:"release_notes_md"`
	PublishedAt          *time.Time                 `json:"published_at"`
	UI                   *core.UIPack               `json:"ui"`
	AppPack              *core.AppPack              `json:"app_pack,omitempty"`
}

// PublicOf converts a release evaluation to its JSON shape.
func PublicOf(rs core.ReleaseState) Public {
	st := rs.State
	if st == "" {
		st = core.ReleaseStateUnknown
	}
	p := Public{
		DesktopUpdaterConfig: rs.DesktopUpdaterConfig,
		Channel:              nullable(rs.Channel),
		LatestVersion:        nullable(rs.LatestVersion),
		MinimumVersion:       nullable(rs.MinimumVersion),
		State:                st,
		Enforced:             rs.Enforced,
		DownloadURL:          nullable(rs.DownloadURL),
		SHA256:               nullable(rs.SHA256),
		ReleaseNotesURL:      nullable(rs.ReleaseNotesURL),
		ReleaseNotesMD:       nullable(rs.ReleaseNotesMD),
		UI:                   rs.UI,
		AppPack:              rs.AppPack,
	}
	if rs.PublishedAt != nil {
		t := rs.PublishedAt.UTC()
		p.PublishedAt = &t
	}
	return p
}

func nullable(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// Sections implements core.BootstrapContributor.
func (c *Component) Sections() []string { return []string{core.SectionRelease} }

// BootstrapSections implements core.BootstrapContributor: the release fields
// of GET /api/v1/claudex/release (without api_version and server) for the
// client headers of the bootstrap request.
func (c *Component) BootstrapSections(ctx context.Context, bc *core.BootstrapContext) (map[string]any, error) {
	var platform, arch, version string
	if bc != nil {
		platform, arch, version = bc.Platform, bc.Arch, bc.AppVersion
	}
	return map[string]any{core.SectionRelease: PublicOf(c.Evaluate(ctx, platform, arch, version))}, nil
}

var (
	_ core.Feature              = (*Component)(nil)
	_ core.ReleaseInfo          = (*Component)(nil)
	_ core.SettingsOwner        = (*Component)(nil)
	_ core.AdminRouter          = (*Component)(nil)
	_ core.BootstrapContributor = (*Component)(nil)
	_ core.PublicRouter         = (*Component)(nil)
)
