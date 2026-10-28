package release

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"

	"github.com/stretchr/testify/require"
)

const (
	testSHA  = "3f5c2c7e0d9b4a1f8e6d5c4b3a291807f6e5d4c3b2a1908f7e6d5c4b3a291807"
	testNote = "## 1.4.0\n- Plan usage limits now show the current session."
)

func TestDesktopUpdaterConfigRoundTrip(t *testing.T) {
	raw := `{"channels":{"stable":{"latest_version":"1.4.0","desktop_updater_config":{"check_interval_ticks":2,"staged_peek_min_interval_minutes":30}}}}`
	setting, err := decodeSetting([]byte(raw))
	require.NoError(t, err)
	normalize(&setting)
	require.NoError(t, validate(&setting))
	stored, err := json.Marshal(setting)
	require.NoError(t, err)
	component, _ := newComponent(t, string(stored))
	state := component.Evaluate(context.Background(), "darwin", "arm64", "1.0.0")
	require.NotNil(t, state.DesktopUpdaterConfig)
	require.Equal(t, float64(2), *state.DesktopUpdaterConfig.CheckIntervalTicks)
	public, err := json.Marshal(PublicOf(state))
	require.NoError(t, err)
	require.Contains(t, string(public), `"desktop_updater_config":{"check_interval_ticks":2,"staged_peek_min_interval_minutes":30}`)
}

// designSetting is the example of design 2.2.
func designSetting() string {
	return `{
  "channels": {
    "stable": {
      "latest_version": "1.4.0",
      "minimum_version": "1.2.0",
      "published_at": "2026-09-20T08:00:00Z",
      "release_notes_url": "https://claudex.example.com/releases/1.4.0",
      "release_notes_md": "## 1.4.0\n- Plan usage limits now show the current session.",
      "downloads": {
        "darwin-arm64": {"url": "https://dl.example.com/Claudex-1.4.0-arm64.zip", "sha256": "` + testSHA + `"},
        "darwin-x64":   {"url": "https://dl.example.com/Claudex-1.4.0-x64.zip",   "sha256": ""},
        "win32-x64":    {"url": "https://dl.example.com/Claudex-Setup-1.4.0.exe", "sha256": ""},
        "linux-x64":    null
      }
    }
  },
  "enforce_minimum_on_gateway": false
}`
}

// newComponent returns a component over a memory repository holding raw
// (nothing when raw is "").
func newComponent(t *testing.T, raw string) (*Component, *MemorySettingRepo) {
	t.Helper()
	repo := NewMemorySettingRepo()
	if raw != "" {
		require.NoError(t, repo.Set(context.Background(), SettingKey, raw))
	}
	return New(&core.Env{Deps: core.Deps{SettingRepo: repo}, Now: time.Now}), repo
}

func TestReleaseStateTable(t *testing.T) {
	for _, tc := range []struct {
		name, version, latest, minimum, want string
	}{
		{"no release configured", "1.3.2", "", "", core.ReleaseStateUnknown},
		{"no client version", "", "1.4.0", "1.2.0", core.ReleaseStateUnknown},
		{"below minimum", "1.1.0", "1.4.0", "1.2.0", core.ReleaseStateRequired},
		{"four-part below minimum", "1.1.9.9", "1.4.0", "1.2.0", core.ReleaseStateRequired},
		{"at minimum", "1.2.0", "1.4.0", "1.2.0", core.ReleaseStateAvailable},
		{"between", "1.3.2", "1.4.0", "1.2.0", core.ReleaseStateAvailable},
		{"at latest", "1.4.0", "1.4.0", "1.2.0", core.ReleaseStateCurrent},
		{"newer than latest", "1.5.0", "1.4.0", "1.2.0", core.ReleaseStateCurrent},
		{"missing parts are zero", "1.4", "1.4.0", "1.2.0", core.ReleaseStateCurrent},
		{"no minimum never requires", "0.0.1", "1.4.0", "", core.ReleaseStateAvailable},
		// Pre-releases sort before their release.
		{"pre-release of latest", "1.4.0-beta.1", "1.4.0", "1.2.0", core.ReleaseStateAvailable},
		{"pre-release of minimum", "1.2.0-rc.1", "1.4.0", "1.2.0", core.ReleaseStateRequired},
		{"pre-release latest, older pre-release", "2.0.0-beta.1", "2.0.0-beta.2", "", core.ReleaseStateAvailable},
		{"pre-release identifiers compare numerically", "2.0.0-beta.10", "2.0.0-beta.2", "", core.ReleaseStateCurrent},
		{"alpha before beta", "2.0.0-alpha.9", "2.0.0-beta.1", "2.0.0-alpha.10", core.ReleaseStateRequired},
		{"release after its pre-release latest", "2.0.0", "2.0.0-beta.2", "", core.ReleaseStateCurrent},
		// Build metadata never affects precedence.
		{"build metadata on the client", "1.4.0+build.7", "1.4.0", "1.2.0", core.ReleaseStateCurrent},
		{"build metadata on latest", "1.4.0", "1.4.0+claudex.2", "1.2.0", core.ReleaseStateCurrent},
		{"build metadata on minimum", "1.2.0+claudex.1", "1.4.0", "1.2.0+claudex.9", core.ReleaseStateAvailable},
		{"build metadata below minimum", "1.1.0+claudex.99", "1.4.0", "1.2.0", core.ReleaseStateRequired},
	} {
		t.Run(tc.name, func(t *testing.T) {
			require.Equal(t, tc.want, state(tc.version, tc.latest, tc.minimum))

			// Same answer through Evaluate over a stored setting.
			raw := `{"channels":{}}`
			if tc.latest != "" {
				ch := map[string]any{"latest_version": tc.latest, "minimum_version": tc.minimum}
				data, err := json.Marshal(map[string]any{"channels": map[string]any{"stable": ch}})
				require.NoError(t, err)
				raw = string(data)
			}
			c, _ := newComponent(t, raw)
			require.Equal(t, tc.want, c.Evaluate(context.Background(), "darwin", "arm64", tc.version).State)
		})
	}
}

func TestEvaluateFieldsAndDownloads(t *testing.T) {
	ctx := context.Background()
	c, _ := newComponent(t, designSetting())
	published := time.Date(2026, 9, 20, 8, 0, 0, 0, time.UTC)

	rs := c.Evaluate(ctx, "darwin", "arm64", "1.3.2")
	require.Equal(t, core.ReleaseState{
		Channel: "stable", LatestVersion: "1.4.0", MinimumVersion: "1.2.0", State: core.ReleaseStateAvailable,
		Enforced: false, DownloadURL: "https://dl.example.com/Claudex-1.4.0-arm64.zip", SHA256: testSHA,
		ReleaseNotesURL: "https://claudex.example.com/releases/1.4.0", ReleaseNotesMD: testNote, PublishedAt: &published,
	}, rs)

	// A platform with an empty checksum, one with a null entry, one missing,
	// and requests without platform or arch: no download for the latter three.
	require.Equal(t, "https://dl.example.com/Claudex-1.4.0-x64.zip", c.Evaluate(ctx, "darwin", "x64", "1.3.2").DownloadURL)
	require.Empty(t, c.Evaluate(ctx, "darwin", "x64", "1.3.2").SHA256)
	for _, pa := range [][2]string{{"linux", "x64"}, {"linux", "arm64"}, {"", "arm64"}, {"darwin", ""}, {"", ""}} {
		rs := c.Evaluate(ctx, pa[0], pa[1], "1.3.2")
		require.Empty(t, rs.DownloadURL, pa)
		require.Empty(t, rs.SHA256, pa)
		require.Equal(t, "1.4.0", rs.LatestVersion, "the rest of the answer does not depend on the platform")
	}

	// Nothing stored, a corrupt value, an empty channel list: unknown, enforced
	// follows the switch, no channel.
	for _, raw := range []string{"", "{not json", `{"channels":{}}`, `{"channels":{"stable":null}}`} {
		c, _ := newComponent(t, raw)
		require.Equal(t, core.ReleaseState{State: core.ReleaseStateUnknown}, c.Evaluate(ctx, "darwin", "arm64", "1.0.0"), raw)
	}
	c, _ = newComponent(t, `{"enforce_minimum_on_gateway":true}`)
	require.Equal(t, core.ReleaseState{State: core.ReleaseStateUnknown, Enforced: true}, c.Evaluate(ctx, "", "", ""))
}

func TestEvaluateIgnoresInvalidStoredValues(t *testing.T) {
	// Values that never passed validation (written to the database by hand)
	// are treated as not set instead of reaching clients.
	c, _ := newComponent(t, `{"channels":{"stable":{
		"latest_version":"latest","minimum_version":"1.0.0",
		"release_notes_url":"http://insecure.example.com",
		"downloads":{"darwin-arm64":{"url":"javascript:alert(1)","sha256":"abc"}}}}}`)
	rs := c.Evaluate(context.Background(), "darwin", "arm64", "0.5.0")
	require.Equal(t, core.ReleaseState{Channel: "stable", State: core.ReleaseStateUnknown}, rs)

	// A version part beyond int64 and a publish time JSON cannot carry.
	c, _ = newComponent(t, `{"channels":{"stable":{"latest_version":"1.0.99999999999999999999",
		"published_at":"0000-01-01T00:00:00+01:00"}}}`)
	rs = c.Evaluate(context.Background(), "darwin", "arm64", "0.5.0")
	require.Equal(t, core.ReleaseState{Channel: "stable", State: core.ReleaseStateUnknown}, rs)
	_, err := json.Marshal(PublicOf(rs))
	require.NoError(t, err)

	c, _ = newComponent(t, `{"channels":{"stable":{"latest_version":"1.0.0","minimum_version":"2.0.0",
		"downloads":{"darwin-arm64":{"url":"https://dl.example.com/a.zip","sha256":"not-hex"}}}}}`)
	rs = c.Evaluate(context.Background(), "darwin", "arm64", "0.5.0")
	require.Empty(t, rs.MinimumVersion, "a minimum above latest is ignored")
	require.Equal(t, core.ReleaseStateAvailable, rs.State)
	require.Equal(t, "https://dl.example.com/a.zip", rs.DownloadURL)
	require.Empty(t, rs.SHA256, "a malformed checksum is not handed out")
}

func TestNormalizeTrimsAndKeepsNulls(t *testing.T) {
	s, err := decodeSetting([]byte(`{"channels":{"stable":{
		"latest_version":" 1.4.0 ","minimum_version":"\t1.2.0",
		"published_at":"2026-09-20T10:00:00+02:00",
		"release_notes_url":" https://claudex.example.com/r ","release_notes_md":"\n notes \n",
		"downloads":{"darwin-arm64":{"url":" https://dl.example.com/a.zip ","sha256":" ` + strings.ToUpper(testSHA) + ` "},
		             "win32-x64":{"url":"","sha256":""},"linux-x64":null}}}}`))
	require.NoError(t, err)
	normalize(&s)
	require.NoError(t, validate(&s))
	ch := s.Channels["stable"]
	require.Equal(t, "1.4.0", ch.LatestVersion)
	require.Equal(t, "1.2.0", ch.MinimumVersion)
	require.Equal(t, "https://claudex.example.com/r", ch.ReleaseNotesURL)
	require.Equal(t, "notes", ch.ReleaseNotesMD)
	require.Equal(t, time.Date(2026, 9, 20, 8, 0, 0, 0, time.UTC), *ch.PublishedAt)
	require.Equal(t, time.UTC, ch.PublishedAt.Location())
	require.Equal(t, &Download{URL: "https://dl.example.com/a.zip", SHA256: testSHA}, ch.Downloads["darwin-arm64"])
	require.Contains(t, ch.Downloads, "win32-x64")
	require.Nil(t, ch.Downloads["win32-x64"], "an empty entry is the same as null")
	require.Contains(t, ch.Downloads, "linux-x64")
	require.Nil(t, ch.Downloads["linux-x64"])

	var empty Setting
	normalize(&empty)
	require.NotNil(t, empty.Channels)
	require.NoError(t, validate(&empty))
}

// reasonAndField returns the error reason and metadata.field.
func reasonAndField(t *testing.T, err error) (string, string, string) {
	t.Helper()
	require.Error(t, err)
	var appErr *infraerrors.ApplicationError
	require.True(t, errors.As(err, &appErr), "%T %v", err, err)
	require.Equal(t, http.StatusBadRequest, infraerrors.Code(err))
	return infraerrors.Reason(err), appErr.Metadata["field"], appErr.Metadata["rule"]
}

func TestValidationErrorsNameTheField(t *testing.T) {
	long := strings.Repeat("x", maxNotesLength+1)
	for _, tc := range []struct {
		name, body, field, rule string
	}{
		{"not an object", `[1]`, "body", "json_object"},
		{"null body", `null`, "body", "json_object"},
		{"invalid JSON", `{"channels":`, "body", "json"},
		{"two objects", `{} {}`, "body", "json"},
		{"unknown top-level key", `{"enforce_minimum_on_gatway":true}`, "enforce_minimum_on_gatway", "unknown_field"},
		{"unknown channel key", `{"channels":{"stable":{"latest":"1.0.0"}}}`, "latest", "unknown_field"},
		{"unknown download key", `{"channels":{"stable":{"downloads":{"darwin-arm64":{"link":"https://a.example"}}}}}`, "link", "unknown_field"},
		{"wrong type", `{"enforce_minimum_on_gateway":"yes"}`, "enforce_minimum_on_gateway", "type"},
		{"wrong nested type", `{"channels":{"stable":{"latest_version":1.4}}}`, "channels.stable.latest_version", "type"},
		{"wrong download type", `{"channels":{"stable":{"downloads":{"win32-x64":"https://dl.example.com/a.exe"}}}}`, "channels.stable.downloads.win32-x64", "type"},
		{"other channel", `{"channels":{"beta":{"latest_version":"2.0.0"}}}`, "channels.beta", "unknown_channel"},
		{"other channel next to stable", `{"channels":{"stable":{},"nightly":null}}`, "channels.nightly", "unknown_channel"},
		{"bad latest", `{"channels":{"stable":{"latest_version":"v1.4"}}}`, "channels.stable.latest_version", "version"},
		{"latest with a part beyond int64", `{"channels":{"stable":{"latest_version":"1.0.99999999999999999999"}}}`, "channels.stable.latest_version", "version"},
		{"minimum with a part beyond int64", `{"channels":{"stable":{"latest_version":"1.4.0","minimum_version":"99999999999999999999"}}}`, "channels.stable.minimum_version", "version"},
		{"too long latest", `{"channels":{"stable":{"latest_version":"1.4.0-` + strings.Repeat("a", 30) + `"}}}`, "channels.stable.latest_version", "version"},
		{"bad minimum", `{"channels":{"stable":{"latest_version":"1.4.0","minimum_version":"1.x"}}}`, "channels.stable.minimum_version", "version"},
		{"minimum without latest", `{"channels":{"stable":{"minimum_version":"1.2.0"}}}`, "channels.stable.minimum_version", "requires_latest_version"},
		{"minimum above latest", `{"channels":{"stable":{"latest_version":"1.4.0","minimum_version":"1.4.1"}}}`, "channels.stable.minimum_version", "above_latest_version"},
		{"minimum release above pre-release latest", `{"channels":{"stable":{"latest_version":"1.4.0-beta.1","minimum_version":"1.4.0"}}}`, "channels.stable.minimum_version", "above_latest_version"},
		{"bad published_at", `{"channels":{"stable":{"published_at":"20 Sep 2026"}}}`, "channels.stable.published_at", "rfc3339"},
		{"published_at before year 1 in UTC", `{"channels":{"stable":{"published_at":"0001-01-01T00:00:00+01:00"}}}`, "channels.stable.published_at", "rfc3339"},
		{"published_at after 9999 in UTC", `{"channels":{"stable":{"published_at":"9999-12-31T23:00:00-02:00"}}}`, "channels.stable.published_at", "rfc3339"},
		{"http release notes", `{"channels":{"stable":{"release_notes_url":"http://claudex.example.com"}}}`, "channels.stable.release_notes_url", "https_url"},
		{"release notes too long", `{"channels":{"stable":{"release_notes_md":"` + long + `"}}}`, "channels.stable.release_notes_md", "max_length"},
		{"unknown platform", `{"channels":{"stable":{"downloads":{"darwin-ia32":{"url":"https://a.example/x"}}}}}`, "channels.stable.downloads.darwin-ia32", "unknown_platform"},
		{"download without url", `{"channels":{"stable":{"downloads":{"win32-x64":{"sha256":"` + testSHA + `"}}}}}`, "channels.stable.downloads.win32-x64.url", "https_url"},
		{"download over http", `{"channels":{"stable":{"downloads":{"win32-x64":{"url":"http://dl.example.com/a.exe"}}}}}`, "channels.stable.downloads.win32-x64.url", "https_url"},
		{"download with credentials", `{"channels":{"stable":{"downloads":{"win32-x64":{"url":"https://u:p@dl.example.com/a.exe"}}}}}`, "channels.stable.downloads.win32-x64.url", "https_url"},
		{"download url too long", `{"channels":{"stable":{"downloads":{"linux-arm64":{"url":"https://dl.example.com/` + strings.Repeat("a", 2000) + `"}}}}}`, "channels.stable.downloads.linux-arm64.url", "https_url"},
		{"short checksum", `{"channels":{"stable":{"downloads":{"win32-arm64":{"url":"https://dl.example.com/a.exe","sha256":"abc"}}}}}`, "channels.stable.downloads.win32-arm64.sha256", "sha256_hex"},
		{"ui pack without version", `{"channels":{"stable":{"ui":{"bridge":1,"url":"https://dl.example.com/ui.zip","sha256":"` + testSHA + `"}}}}`, "channels.stable.ui.version", "version"},
		{"ui pack without bridge", `{"channels":{"stable":{"ui":{"version":"1.0.0","url":"https://dl.example.com/ui.zip","sha256":"` + testSHA + `"}}}}`, "channels.stable.ui.bridge", "range"},
		{"ui pack over http", `{"channels":{"stable":{"ui":{"version":"1.0.0","bridge":1,"url":"http://dl.example.com/ui.zip","sha256":"` + testSHA + `"}}}}`, "channels.stable.ui.url", "https_url"},
		{"ui pack without checksum", `{"channels":{"stable":{"ui":{"version":"1.0.0","bridge":1,"url":"https://dl.example.com/ui.zip"}}}}`, "channels.stable.ui.sha256", "sha256_hex"},
		{"unknown ui key", `{"channels":{"stable":{"ui":{"signature":"x"}}}}`, "signature", "unknown_field"},
		{"non-hex checksum", `{"channels":{"stable":{"downloads":{"win32-arm64":{"url":"https://dl.example.com/a.exe","sha256":"` + strings.Repeat("g", 64) + `"}}}}}`, "channels.stable.downloads.win32-arm64.sha256", "sha256_hex"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, _ := newComponent(t, "")
			s, err := decodeSetting([]byte(tc.body))
			if err == nil {
				_, err = c.setting.Set(context.Background(), s)
			}
			reason, field, rule := reasonAndField(t, err)
			require.Equal(t, "CLAUDEX_RELEASE_INVALID", reason)
			require.Equal(t, tc.field, field)
			require.Equal(t, tc.rule, rule)
		})
	}

	// A long foreign key is shortened in the metadata.
	_, err := decodeSetting([]byte(`{"channels":{"` + strings.Repeat("é", 100) + `":null}}`))
	_, field, _ := reasonAndField(t, err)
	require.LessOrEqual(t, len(field), len("channels.")+maxFieldKey+len("…"))
}

func TestValidSettingsAreAccepted(t *testing.T) {
	for _, body := range []string{
		designSetting(),
		`{}`,
		`{"channels":{}}`,
		`{"channels":{"stable":null},"enforce_minimum_on_gateway":true}`,
		`{"channels":{"stable":{"latest_version":"1.4.0","minimum_version":"1.4.0"}}}`,
		`{"channels":{"stable":{"latest_version":"1.4.0-beta.2+claudex.1","minimum_version":"1.4.0-beta.1"}}}`,
		`{"channels":{"stable":{"latest_version":"1.4.0","published_at":null,"release_notes_md":"` + strings.Repeat("é", maxNotesLength) + `"}}}`,
		`{"channels":{"stable":{"latest_version":"1.4.0","published_at":""}},"updated_at":"2026-09-20T08:00:00Z"}`,
	} {
		c, _ := newComponent(t, "")
		s, err := decodeSetting([]byte(body))
		require.NoError(t, err, body)
		_, err = c.setting.Set(context.Background(), s)
		require.NoError(t, err, body)
	}
}

func TestBootstrapSection(t *testing.T) {
	c, _ := newComponent(t, designSetting())
	require.Equal(t, []string{core.SectionRelease}, c.Sections())
	require.Equal(t, core.NameRelease, core.SectionOwners[core.SectionRelease])

	sections, err := c.BootstrapSections(context.Background(), &core.BootstrapContext{Platform: "darwin", Arch: "arm64", AppVersion: "1.1.0"})
	require.NoError(t, err)
	data, err := json.Marshal(sections)
	require.NoError(t, err)
	require.JSONEq(t, `{"release":{
		"channel":"stable","latest_version":"1.4.0","minimum_version":"1.2.0","state":"required","enforced":false,
		"download_url":"https://dl.example.com/Claudex-1.4.0-arm64.zip","sha256":"`+testSHA+`",
		"release_notes_url":"https://claudex.example.com/releases/1.4.0","release_notes_md":`+mustJSON(t, testNote)+`,
		"published_at":"2026-09-20T08:00:00Z","ui":null}}`, string(data))

	// Nothing configured, no client headers: every field present, null.
	c, _ = newComponent(t, "")
	sections, err = c.BootstrapSections(context.Background(), &core.BootstrapContext{})
	require.NoError(t, err)
	data, err = json.Marshal(sections)
	require.NoError(t, err)
	require.JSONEq(t, `{"release":{"channel":null,"latest_version":null,"minimum_version":null,"state":"unknown","enforced":false,
		"download_url":null,"sha256":null,"release_notes_url":null,"release_notes_md":null,"published_at":null,"ui":null}}`, string(data))
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	data, err := json.Marshal(v)
	require.NoError(t, err)
	return string(data)
}

func TestNewDoesNotTouchDependencies(t *testing.T) {
	c := New(&core.Env{})
	require.Equal(t, core.NameRelease, c.Name())
	require.Equal(t, []string{SettingKey, MobileSettingKey}, c.SettingKeys())
	require.Equal(t, core.ReleaseStateUnknown, c.Evaluate(context.Background(), "darwin", "arm64", "1.0.0").State)
	require.NotPanics(t, func() { New(nil) })
}

func TestUIPackIsServedToEveryPlatform(t *testing.T) {
	ctx := context.Background()
	c, _ := newComponent(t, `{"channels":{"stable":{"latest_version":"1.4.0","ui":{"version":" 1.0.3 ","bridge":12,"url":"https://dl.example.com/ui-1.0.3.zip","sha256":"`+strings.ToUpper(testSHA)+`"}}}}`)
	want := &core.UIPack{Version: "1.0.3", Bridge: 12, URL: "https://dl.example.com/ui-1.0.3.zip", SHA256: testSHA}
	require.Equal(t, want, c.Evaluate(ctx, "darwin", "arm64", "1.4.0").UI)
	require.Equal(t, want, c.Evaluate(ctx, "win32", "x64", "1.3.0").UI)
	require.Equal(t, want, PublicOf(c.Evaluate(ctx, "", "", "")).UI)

	// Saved through the admin PUT: normalized, then valid.
	s, err := decodeSetting([]byte(`{"channels":{"stable":{"ui":{"version":"1.0.3","bridge":12,"url":"https://dl.example.com/ui.zip","sha256":"` + testSHA + `"}}}}`))
	require.NoError(t, err)
	_, err = c.setting.Set(ctx, s)
	require.NoError(t, err)

	// A pack stored by hand without a checksum never reaches clients.
	c, _ = newComponent(t, `{"channels":{"stable":{"ui":{"version":"1.0.3","bridge":12,"url":"https://dl.example.com/ui.zip","sha256":""}}}}`)
	require.Nil(t, c.Evaluate(ctx, "darwin", "arm64", "1.4.0").UI)
}

func TestLinuxPackageDownloads(t *testing.T) {
	ctx := context.Background()
	c, _ := newComponent(t, `{"channels":{"stable":{"latest_version":"0.0.28","downloads":{
		"linux-x64-deb":{"url":"https://dl.example.com/claudex_0.0.28_amd64.deb","sha256":"`+testSHA+`"},
		"linux-arm64-rpm":{"url":"https://dl.example.com/claudex-0.0.28.aarch64.rpm","sha256":"`+testSHA+`"}}}}}`)
	require.Equal(t, "https://dl.example.com/claudex_0.0.28_amd64.deb", c.Evaluate(ctx, "linux", "x64-deb", "0.0.27").DownloadURL)
	require.Equal(t, "https://dl.example.com/claudex-0.0.28.aarch64.rpm", c.Evaluate(ctx, "linux", "arm64-rpm", "0.0.27").DownloadURL)
	require.Empty(t, c.Evaluate(ctx, "linux", "x64", "0.0.27").DownloadURL)
}
