package sharing

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/stretchr/testify/require"
)

type memoryCodeSettings struct {
	values map[int64]CodeSharingSettings
}

type namedCodeUsers struct{ service.UserRepository }

func (namedCodeUsers) GetByIDIncludeDeleted(_ context.Context, userID int64) (*service.User, error) {
	return &service.User{ID: userID, Username: "Session author"}, nil
}

func (s *memoryCodeSettings) getCodeSettings(_ context.Context, userID int64) (CodeSharingSettings, error) {
	if value, ok := s.values[userID]; ok {
		return value, nil
	}
	return defaultCodeSettings(), nil
}

func (s *memoryCodeSettings) putCodeSettings(ctx context.Context, userID int64, patch codeSettingsPatch) (CodeSharingSettings, error) {
	value, _ := s.getCodeSettings(ctx, userID)
	if patch.RequireRepositoryAccess != nil {
		value.RequireRepositoryAccess = *patch.RequireRepositoryAccess
	}
	if patch.ShowName != nil {
		value.ShowName = *patch.ShowName
	}
	s.values[userID] = value
	return value, nil
}

type codeReader struct {
	allowed      bool
	viewer       int64
	repositories []string
}

func (r *codeReader) Name() string { return "code-reader" }
func (r *codeReader) CanReadCodeRepositories(_ context.Context, viewer int64, repositories []string) bool {
	r.viewer, r.repositories = viewer, repositories
	return r.allowed
}

func TestCodeSharingSettingsAccountIsolation(t *testing.T) {
	f := newFixture(t)
	f.c.codeSettings = &memoryCodeSettings{values: map[int64]CodeSharingSettings{}}
	var settings CodeSharingSettings
	f.do(http.MethodGet, "/api/v1/claudex/sharing/code-settings", "").into(t, &settings)
	require.Equal(t, defaultCodeSettings(), settings)
	f.do(http.MethodPatch, "/api/v1/claudex/sharing/code-settings", `{"showName":false}`).into(t, &settings)
	require.Equal(t, CodeSharingSettings{RequireRepositoryAccess: true, ShowName: false}, settings)
	f.userID = 8
	f.do(http.MethodGet, "/api/v1/claudex/sharing/code-settings", "").into(t, &settings)
	require.Equal(t, defaultCodeSettings(), settings)
}

func TestCodeSharingRepositoryAccessAndAnonymousName(t *testing.T) {
	ctx := context.Background()
	f := newFixture(t)
	settings := &memoryCodeSettings{values: map[int64]CodeSharingSettings{}}
	f.c.codeSettings = settings
	reader := &codeReader{}
	f.c.env.Components = []core.Feature{reader}
	f.c.env.UserRepo = namedCodeUsers{}
	snapshot := &Snapshot{Mode: "code", Repositories: []string{"octo/repo"}}
	name, err := f.c.codeDisplayName(ctx, 7, snapshot)
	require.NoError(t, err)
	require.Equal(t, "Session author", name)
	allowed, err := f.c.canReadCode(ctx, 7, 7, snapshot)
	require.NoError(t, err)
	require.True(t, allowed)
	allowed, err = f.c.canReadCode(ctx, 7, 8, snapshot)
	require.NoError(t, err)
	require.False(t, allowed)
	require.Equal(t, int64(8), reader.viewer)
	require.Equal(t, snapshot.Repositories, reader.repositories)
	reader.allowed = true
	allowed, err = f.c.canReadCode(ctx, 7, 8, snapshot)
	require.NoError(t, err)
	require.True(t, allowed)
	settings.values[7] = CodeSharingSettings{}
	allowed, err = f.c.canReadCode(ctx, 7, 0, snapshot)
	require.NoError(t, err)
	require.True(t, allowed)
	name, err = f.c.codeDisplayName(ctx, 7, snapshot)
	require.NoError(t, err)
	require.Empty(t, name)
}

func TestCodeSharePublicRouteRequiresAuthenticatedRepositoryCheck(t *testing.T) {
	f := newFixture(t)
	f.enable(nil)
	f.c.codeSettings = &memoryCodeSettings{values: map[int64]CodeSharingSettings{}}
	body := strings.Replace(conversationBody("code-session", "Code"), `"messages":`, `"mode":"code","repositories":["octo/repo"],"messages":`, 1)
	var share ShareDTO
	f.do(http.MethodPost, "/api/v1/claudex/shares", body).into(t, &share)
	require.NotEmpty(t, share.Path)
	page := f.serve(http.MethodGet, share.Path, "")
	require.Equal(t, http.StatusFound, page.Code)
	require.True(t, strings.HasSuffix(page.Header().Get("Location"), "/shared/"+strings.TrimPrefix(share.Path, "/s/")))
	res, err := f.c.resolveToken(context.Background(), strings.TrimPrefix(share.Path, "/s/"), true)
	require.ErrorIs(t, err, errCodeRepositoryAccess)
	require.NotNil(t, res)
	reader := &codeReader{}
	f.c.env.Components = []core.Feature{reader}
	f.userID = 8
	endpoint := "/api/v1/claudex/sharing/shared-with-me/" + strings.TrimPrefix(share.Path, "/s/")
	require.Equal(t, http.StatusNotFound, f.do(http.MethodGet, endpoint, "").Status)
	reader.allowed = true
	require.Equal(t, http.StatusOK, f.do(http.MethodGet, endpoint, "").Status)
	require.Equal(t, int64(8), reader.viewer)
	require.Equal(t, []string{"octo/repo"}, reader.repositories)
}
