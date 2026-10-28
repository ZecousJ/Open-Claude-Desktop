package release

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestApps(t *testing.T) {
	ctx := context.Background()
	c, repo := newComponent(t, "")
	data, err := json.Marshal(c.Apps(ctx))
	require.NoError(t, err)
	require.JSONEq(t, `{"desktop":null,"android":null,"ios":null}`, string(data))

	require.NoError(t, repo.Set(ctx, SettingKey, `{"channels":{"stable":{"latest_version":"0.0.11","published_at":"2026-10-06T10:00:00Z",
		"downloads":{"darwin-arm64":{"url":"https://d.example/Claudex.dmg","sha256":""},"win32-x64":{"url":"http://d.example/x.exe","sha256":""},"linux-x64":null}}}}`))
	require.NoError(t, repo.Set(ctx, MobileSettingKey, `{"android":{"version":"0.4.0","url":"https://d.example/claudex.apk","sha256":"nope"},"ios":{"url":"javascript:alert(1)"}}`))
	c = New(c.env)
	data, err = json.Marshal(c.Apps(ctx))
	require.NoError(t, err)
	// Only https addresses; a bad sha256 is dropped, the app is kept.
	require.JSONEq(t, `{"desktop":{"version":"0.0.11","published_at":"2026-10-06T10:00:00Z","downloads":{"darwin-arm64":"https://d.example/Claudex.dmg"}},
		"android":{"version":"0.4.0","url":"https://d.example/claudex.apk","sha256":""},"ios":null}`, string(data))
}

func TestMobileNotesPassThroughWithinLimit(t *testing.T) {
	app := cleanApp(&MobileApp{Version: "0.8.0", URL: "https://example.com/a.apk", Notes: "  新增应用内更新。 "})
	if app == nil || app.Notes != "新增应用内更新。" {
		t.Fatalf("notes = %+v", app)
	}
	long := cleanApp(&MobileApp{Version: "0.8.0", URL: "https://example.com/a.apk", Notes: strings.Repeat("长", maxMobileNotes+1)})
	if long == nil || long.Notes != "" {
		t.Fatalf("over-long notes kept: %d", len(long.Notes))
	}
}
