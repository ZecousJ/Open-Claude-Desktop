package release

import (
	"context"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/gin-gonic/gin"
)

// MobileSettingKey stores the phone apps shown on the web downloads page
// (owner, 2026-10-07: Android first, iOS once it is on TestFlight).
//
//	{"android":{"version":"0.4.0","url":"https://...apk","sha256":"..."},
//	 "ios":{"version":"","url":"https://testflight.apple.com/join/..."}}
const MobileSettingKey = "claudex_mobile_release"

// MobileSetting is the stored value of claudex_mobile_release. It is written
// by the release script like claudex_client_release.
type MobileSetting struct {
	Android *MobileApp `json:"android"`
	IOS     *MobileApp `json:"ios"`
}

// MobileApp is one phone app: an APK, or a TestFlight invitation for iOS.
type MobileApp struct {
	Version string `json:"version"`
	URL     string `json:"url"`
	SHA256  string `json:"sha256"`
	// Notes is the release's "what's new" text, shown by the Android app's
	// update prompt (plain text, at most maxMobileNotes characters).
	Notes string `json:"notes,omitempty"`
}

const maxMobileNotes = 4000

// Apps is GET /api/v1/claudex/apps: what the downloads page offers. A missing
// entry is null.
type Apps struct {
	Desktop *DesktopApps `json:"desktop"`
	Android *MobileApp   `json:"android"`
	IOS     *MobileApp   `json:"ios"`
}

// DesktopApps is the latest stable desktop release with its installers by
// "<platform>-<arch>".
type DesktopApps struct {
	Version     string            `json:"version"`
	PublishedAt *time.Time        `json:"published_at"`
	Downloads   map[string]string `json:"downloads"`
}

// RegisterPublicRoutes implements core.PublicRouter.
func (c *Component) RegisterPublicRoutes(g *gin.RouterGroup) {
	g.GET("/apps", c.getApps)
}

func (c *Component) getApps(g *gin.Context) {
	g.Header("Cache-Control", "public, max-age=60")
	response.Success(g, c.Apps(g.Request.Context()))
}

// Apps lists the downloads; values that fail validation are left out.
func (c *Component) Apps(ctx context.Context) Apps {
	var out Apps
	s := c.setting.Cached(ctx)
	if ch := s.Channels[ChannelStable]; ch != nil && validVersion(ch.LatestVersion) {
		d := &DesktopApps{Version: ch.LatestVersion, Downloads: map[string]string{}}
		if ch.PublishedAt != nil && validPublishedAt(*ch.PublishedAt) {
			t := ch.PublishedAt.UTC()
			d.PublishedAt = &t
		}
		for _, p := range Platforms {
			if dl := ch.Downloads[p]; dl != nil {
				if u, err := core.HTTPSURL(dl.URL, maxURLLength); err == nil {
					d.Downloads[p] = u
				}
			}
		}
		out.Desktop = d
	}
	m := c.mobile.Cached(ctx)
	out.Android = cleanApp(m.Android)
	out.IOS = cleanApp(m.IOS)
	return out
}

func cleanApp(a *MobileApp) *MobileApp {
	if a == nil {
		return nil
	}
	u, err := core.HTTPSURL(a.URL, maxURLLength)
	if err != nil {
		return nil
	}
	app := &MobileApp{URL: u}
	if validVersion(a.Version) {
		app.Version = a.Version
	}
	if sha256Hex.MatchString(a.SHA256) {
		app.SHA256 = a.SHA256
	}
	if notes := strings.TrimSpace(a.Notes); notes != "" && utf8.RuneCountInString(notes) <= maxMobileNotes {
		app.Notes = notes
	}
	return app
}

func mobileDefaults() MobileSetting { return MobileSetting{} }
