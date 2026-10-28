package release_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/claudex/release"
	"github.com/stretchr/testify/require"
)

func TestReleaseTransportQuery(t *testing.T) {
	const channel = "77a14fc4-808e-4345-ac3e-090be671bf94"
	repo := release.NewMemorySettingRepo()
	require.NoError(t, repo.Set(context.Background(), release.SettingKey,
		`{"channels":{"stable":{"latest_version":"1.0.0"},"`+channel+`":{"latest_version":"2.0.0"}}}`))
	_, router := moduleRouter(t, repo)
	base := "/api/v1/claudex/release?platform=darwin&arch=arm64&version=0.9.0"
	response := get(router, base+"&channelUuid="+channel, nil)
	require.Equal(t, http.StatusOK, response.Code)
	require.Contains(t, data(t, response), `"latest_version":"2.0.0"`)
	response = get(router, base+"&channelUuid="+channel+"&maxVersion=1.0.0", nil)
	require.Equal(t, http.StatusOK, response.Code)
	require.Contains(t, data(t, response), `"latest_version":null`)
	// A channel that no longer exists answers as stable.
	response = get(router, base+"&channelUuid=5d0c3a8e-1f4b-4e2a-9c7d-3b6a8f2e1d40", nil)
	require.Equal(t, http.StatusOK, response.Code)
	require.Contains(t, data(t, response), `"latest_version":"1.0.0"`)
	require.Contains(t, data(t, response), `"channel":"stable"`)
	for _, query := range []string{"&channelUuid=invalid", "&maxVersion=invalid"} {
		require.Equal(t, http.StatusBadRequest, get(router, base+query, nil).Code)
	}
}

func TestReleaseAppPack(t *testing.T) {
	repo := release.NewMemorySettingRepo()
	sum := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	require.NoError(t, repo.Set(context.Background(), release.SettingKey,
		`{"channels":{"stable":{"latest_version":"1.0.0","downloads":{"win32-x64":{"url":"https://x.example/Claudex-Setup-1.0.0.exe","sha256":"`+sum+
			`","app_pack":{"url":"https://x.example/Claudex-1.0.0-win-x64-app.zip","sha256":"`+sum+`","runtime":"44.4.3","keep":"`+sum+`"}}}}}}`))
	_, router := moduleRouter(t, repo)
	win := get(router, "/api/v1/claudex/release?platform=win32&arch=x64&version=0.9.0", nil)
	require.Equal(t, http.StatusOK, win.Code)
	require.Contains(t, data(t, win), `"app_pack":{"url":"https://x.example/Claudex-1.0.0-win-x64-app.zip"`)
	require.Contains(t, data(t, win), `"runtime":"44.4.3"`)
	mac := get(router, "/api/v1/claudex/release?platform=darwin&arch=arm64&version=0.9.0", nil)
	require.NotContains(t, data(t, mac), `app_pack`)
}
