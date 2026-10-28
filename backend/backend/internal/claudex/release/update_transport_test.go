package release

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestUpdateRequestChannelAndCap(t *testing.T) {
	const channel = "77a14fc4-808e-4345-ac3e-090be671bf94"
	raw := `{"channels":{"stable":{"latest_version":"1.0.0"},"` + channel + `":{"latest_version":"2.0.0"}}}`
	setting, err := decodeSetting([]byte(raw))
	require.NoError(t, err)
	require.NoError(t, validate(&setting))
	component, _ := newComponent(t, raw)
	ctx := context.Background()
	require.Equal(t, "1.0.0", component.Evaluate(ctx, "darwin", "arm64", "0.9.0").LatestVersion)
	request := WithUpdateRequest(ctx, channel, "2.0.0")
	require.Equal(t, "2.0.0", component.Evaluate(request, "darwin", "arm64", "0.9.0").LatestVersion)
	require.Equal(t, channel, component.Evaluate(request, "darwin", "arm64", "0.9.0").Channel)
	capped := WithUpdateRequest(ctx, channel, "1.0.0")
	require.Empty(t, component.Evaluate(capped, "darwin", "arm64", "0.9.0").LatestVersion)
}

func TestUniversalMacDownloadFallback(t *testing.T) {
	raw := `{"channels":{"stable":{"latest_version":"1.0.0","downloads":{"darwin-universal":{"url":"https://dl.example/universal.zip","sha256":"` + testSHA + `"},"darwin-arm64":{"url":"https://dl.example/arm64.zip","sha256":"` + testSHA + `"}}}}}`
	setting, err := decodeSetting([]byte(raw))
	require.NoError(t, err)
	require.NoError(t, validate(&setting))
	component, _ := newComponent(t, raw)
	require.Equal(t, "https://dl.example/arm64.zip", component.Evaluate(context.Background(), "darwin", "arm64", "0.9.0").DownloadURL)
	require.Equal(t, "https://dl.example/universal.zip", component.Evaluate(context.Background(), "darwin", "x64", "0.9.0").DownloadURL)
}
