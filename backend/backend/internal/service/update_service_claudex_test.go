//go:build unit

package service

// CLAUDEX: tests for the disabled upstream self-update (update_service_claudex.go).

import (
	"context"
	"net/http"
	"testing"
	"time"

	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/stretchr/testify/require"
)

// claudexNoNetworkGitHubClient fails the test on any call: a disabled update
// service must never reach GitHub.
type claudexNoNetworkGitHubClient struct{ t *testing.T }

func (c claudexNoNetworkGitHubClient) FetchLatestRelease(context.Context, string) (*GitHubRelease, error) {
	c.t.Fatal("FetchLatestRelease called while online update is disabled")
	return nil, nil
}

func (c claudexNoNetworkGitHubClient) FetchRecentReleases(context.Context, string, int) ([]*GitHubRelease, error) {
	c.t.Fatal("FetchRecentReleases called while online update is disabled")
	return nil, nil
}

func (c claudexNoNetworkGitHubClient) DownloadFile(context.Context, string, string, int64) error {
	c.t.Fatal("DownloadFile called while online update is disabled")
	return nil
}

func (c claudexNoNetworkGitHubClient) FetchChecksumFile(context.Context, string) ([]byte, error) {
	c.t.Fatal("FetchChecksumFile called while online update is disabled")
	return nil, nil
}

// claudexUnusedUpdateCache fails the test on any call: the disabled service
// neither reads nor writes the cached upstream release.
type claudexUnusedUpdateCache struct{ t *testing.T }

func (c claudexUnusedUpdateCache) GetUpdateInfo(context.Context) (string, error) {
	c.t.Fatal("GetUpdateInfo called while online update is disabled")
	return "", nil
}

func (c claudexUnusedUpdateCache) SetUpdateInfo(context.Context, string, time.Duration) error {
	c.t.Fatal("SetUpdateInfo called while online update is disabled")
	return nil
}

func TestClaudexProvideUpdateServiceDisablesSelfUpdate(t *testing.T) {
	svc := ProvideUpdateService(claudexUnusedUpdateCache{t}, claudexNoNetworkGitHubClient{t}, BuildInfo{Version: "0.2.8", BuildType: "release"})
	require.True(t, svc.SelfUpdateDisabled())

	info, err := svc.CheckUpdate(context.Background(), true)
	require.NoError(t, err)
	require.Equal(t, &UpdateInfo{
		CurrentVersion: "0.2.8",
		LatestVersion:  "0.2.8",
		HasUpdate:      false,
		BuildType:      "release",
		UpdateDisabled: true,
	}, info)

	versions, err := svc.ListRollbackVersions(context.Background())
	require.NoError(t, err)
	require.Empty(t, versions)

	for name, op := range map[string]func() error{
		"PerformUpdate":     func() error { return svc.PerformUpdate(context.Background()) },
		"Rollback":          svc.Rollback,
		"RollbackToVersion": func() error { return svc.RollbackToVersion(context.Background(), "0.2.7") },
	} {
		err := op()
		require.ErrorIs(t, err, ErrSelfUpdateDisabled, name)
		require.Equal(t, http.StatusForbidden, infraerrors.Code(err), name)
		require.Equal(t, "SELF_UPDATE_DISABLED", infraerrors.Reason(err), name)
	}
}

func TestClaudexNewUpdateServiceKeepsUpstreamBehaviour(t *testing.T) {
	// Only the production wiring disables online update; a directly constructed
	// service still checks upstream releases, so the upstream tests stay valid.
	svc := NewUpdateService(&updateServiceCacheStub{}, &updateServiceGitHubClientStub{
		release: &GitHubRelease{TagName: "v0.2.9"},
	}, "0.2.8", "release")
	require.False(t, svc.SelfUpdateDisabled())

	info, err := svc.CheckUpdate(context.Background(), true)
	require.NoError(t, err)
	require.True(t, info.HasUpdate)
	require.False(t, info.UpdateDisabled)
	require.Equal(t, "0.2.9", info.LatestVersion)
}

func TestClaudexSelfUpdateDisabledNilSafe(t *testing.T) {
	var svc *UpdateService
	require.False(t, svc.SelfUpdateDisabled())
}
