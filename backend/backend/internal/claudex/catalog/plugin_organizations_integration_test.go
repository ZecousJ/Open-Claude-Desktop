//go:build integration

package catalog

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/Wei-Shaw/sub2api/migrations"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

type pluginOrganizationTestUsers struct {
	service.UserRepository
	db *sql.DB
}

func (r pluginOrganizationTestUsers) GetByID(ctx context.Context, id int64) (*service.User, error) {
	user := &service.User{ID: id, Status: service.StatusActive, Role: service.RoleUser}
	err := r.db.QueryRowContext(ctx, "SELECT email FROM users WHERE id = $1 AND deleted_at IS NULL", id).Scan(&user.Email)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, service.ErrUserNotFound
	}
	return user, err
}

func (pluginOrganizationTestUsers) GetUserAvatar(context.Context, int64) (*service.UserAvatar, error) {
	return nil, nil
}

func (pluginOrganizationTestUsers) UpdateUserLastActiveAt(context.Context, int64, time.Time) error {
	return nil
}

func TestIntegrationPluginOrganizationMarketplaceMembership(t *testing.T) {
	var db *sql.DB
	if dsn := os.Getenv("CLAUDEX_PLUGIN_ORGANIZATION_TEST_DSN"); dsn != "" {
		var err error
		db, err = sql.Open("postgres", dsn)
		require.NoError(t, err)
		t.Cleanup(func() { _ = db.Close() })
		_, err = db.Exec("CREATE TABLE users (id BIGINT PRIMARY KEY, email TEXT NOT NULL, deleted_at TIMESTAMPTZ)")
		require.NoError(t, err)
	} else {
		db = startPostgres(t)
	}
	for _, file := range []string{"claudex_0015_plugin_organizations.sql", "claudex_0016_plugin_organization_catalog.sql", "claudex_0017_plugin_organization_packages.sql"} {
		migration, err := migrations.FS.ReadFile(file)
		require.NoError(t, err)
		for range 2 {
			_, err = db.Exec(string(migration))
			require.NoError(t, err)
		}
	}
	_, err := db.Exec(`
		INSERT INTO users (id, email) VALUES
			(101, 'member@example.test'), (102, 'admin@example.test'), (103, 'outside@example.test');
		INSERT INTO claudex_plugin_organizations (id, name) VALUES
			('10000000-0000-4000-8000-000000000001', 'Alpha'),
			('10000000-0000-4000-8000-000000000002', 'Beta'),
			('10000000-0000-4000-8000-000000000003', 'Empty');
		INSERT INTO claudex_plugin_organization_members (organization_id, user_id, role) VALUES
			('10000000-0000-4000-8000-000000000001', 101, 'member'),
			('10000000-0000-4000-8000-000000000001', 102, 'admin'),
			('10000000-0000-4000-8000-000000000002', 102, 'member'),
			('10000000-0000-4000-8000-000000000003', 101, 'member');
		INSERT INTO claudex_plugin_organization_marketplaces (id, organization_id, name, display_name) VALUES
			('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'catalog', 'Alpha Plugins'),
			('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'catalog', 'Beta Plugins');
		INSERT INTO claudex_plugin_organization_catalog
			(marketplace_id, name, display_name, description, version, repository, commit_sha, source_path, installation_preference)
		VALUES
			('20000000-0000-4000-8000-000000000001', 'productivity', 'Productivity', 'Daily workflow skills', '1.3.1',
			 'anthropics/knowledge-work-plugins', 'e91a134584eb798bac7fb0379358006a2b63b965', 'productivity', 'available'),
			('20000000-0000-4000-8000-000000000002', 'productivity', 'Productivity', 'Daily workflow skills', '1.3.1',
			 'anthropics/knowledge-work-plugins', 'e91a134584eb798bac7fb0379358006a2b63b965', 'productivity', 'required'),
			('20000000-0000-4000-8000-000000000001', 'hidden', 'Hidden', '', '',
			 'anthropics/knowledge-work-plugins', 'e91a134584eb798bac7fb0379358006a2b63b965', 'productivity', 'not_available');`)
	require.NoError(t, err)
	archive := []byte("the stored archive")
	if file := os.Getenv("CLAUDEX_PLUGIN_ORGANIZATION_TEST_ARCHIVE"); file != "" {
		archive, err = os.ReadFile(file)
		require.NoError(t, err)
	}
	checksum := sha256.Sum256(archive)
	digest := hex.EncodeToString(checksum[:])
	_, err = db.Exec(`INSERT INTO claudex_plugin_organization_packages
		(marketplace_id, name, commit_sha, sha256, archive)
		VALUES ('20000000-0000-4000-8000-000000000001', 'productivity', 'e91a134584eb798bac7fb0379358006a2b63b965', $1, $2)`, digest, archive)
	require.NoError(t, err)

	users := pluginOrganizationTestUsers{db: db}
	cfg := &config.Config{}
	cfg.JWT.Secret = "organization-marketplace-integration-test-secret"
	cfg.JWT.AccessTokenExpireMinutes = 5
	auth := service.NewAuthService(nil, users, nil, nil, cfg, nil, nil, nil, nil, nil, nil, nil, nil)
	userService := service.NewUserService(users, nil, nil, nil)
	newRouter := func(catalogDB *sql.DB) *gin.Engine {
		r := gin.New()
		g := r.Group("/api/v1/claudex", gin.HandlerFunc(middleware.NewJWTAuthMiddleware(auth, userService, nil, nil)))
		New(&core.Env{Deps: core.Deps{DB: catalogDB}}).RegisterUserRoutes(g)
		return r
	}
	tokens := make(map[int64]string)
	for _, userID := range []int64{101, 102, 103} {
		user, err := users.GetByID(t.Context(), userID)
		require.NoError(t, err)
		tokens[userID], err = auth.GenerateToken(t.Context(), user)
		require.NoError(t, err)
	}

	request := func(r *gin.Engine, userID int64, path string, status int) *httptest.ResponseRecorder {
		t.Helper()
		if !strings.HasPrefix(path, "/plugin-organization-catalog") {
			path = "/plugin-organizations" + path
		}
		req := httptest.NewRequest(http.MethodGet, "/api/v1/claudex"+path, nil)
		if token := tokens[userID]; token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		req.Header.Set("X-Actor", "admin")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		require.Equal(t, status, w.Code, w.Body.String())
		if userID != 0 {
			require.Equal(t, "no-store", w.Header().Get("Cache-Control"))
		}
		return w
	}

	const alpha = "/10000000-0000-4000-8000-000000000001/marketplaces"
	const beta = "/10000000-0000-4000-8000-000000000002/marketplaces"
	const empty = "/10000000-0000-4000-8000-000000000003/marketplaces"
	router := newRouter(db)
	request(router, 0, alpha, http.StatusUnauthorized)
	memberOrganizations := decodeDirectoryData[[]pluginOrganization](t, request(router, 101, "", http.StatusOK))
	require.Equal(t, []string{"Alpha", "Empty"}, []string{memberOrganizations[0].Name, memberOrganizations[1].Name})
	require.Equal(t, "member", memberOrganizations[0].Role)
	adminOrganizations := decodeDirectoryData[[]pluginOrganization](t, request(router, 102, "", http.StatusOK))
	require.Len(t, adminOrganizations, 2)
	require.Equal(t, "admin", adminOrganizations[0].Role)
	require.Empty(t, decodeDirectoryData[[]pluginOrganization](t, request(router, 103, "", http.StatusOK)))
	require.Empty(t, decodeDirectoryData[[]organizationMarketplace](t, request(router, 101, empty, http.StatusOK)))
	require.Equal(t, "Alpha Plugins", decodeDirectoryData[[]organizationMarketplace](t, request(router, 101, alpha, http.StatusOK))[0].DisplayName)
	require.Equal(t, "Beta Plugins", decodeDirectoryData[[]organizationMarketplace](t, request(router, 102, beta, http.StatusOK))[0].DisplayName)
	require.Contains(t, request(router, 101, beta, http.StatusNotFound).Body.String(), "CLAUDEX_PLUGIN_ORGANIZATION_NOT_FOUND")
	request(router, 103, alpha, http.StatusNotFound)
	request(router, 101, "/not-a-uuid/marketplaces", http.StatusNotFound)
	const catalogPath = "/plugin-organization-catalog"
	memberCatalog := request(router, 101, catalogPath, http.StatusOK)
	require.NotContains(t, memberCatalog.Body.String(), "anthropics/knowledge-work-plugins")
	require.NotContains(t, memberCatalog.Body.String(), "e91a1345")
	memberPlugins := decodeDirectoryData[[]organizationPlugin](t, memberCatalog)
	require.Len(t, memberPlugins, 1)
	require.Equal(t, "Productivity", memberPlugins[0].DisplayName)
	require.Equal(t, "available", memberPlugins[0].InstallationPreference)
	require.True(t, memberPlugins[0].PackageAvailable)
	authorization := catalogPath + "/" + memberPlugins[0].ID + "/authorization"
	packageRoute := catalogPath + "/" + memberPlugins[0].ID + "/packages/"
	grant := decodeDirectoryData[organizationPluginGrant](t, request(router, 101, authorization, http.StatusOK))
	require.Equal(t, digest, grant.Digest)
	bundle := request(router, 101, packageRoute+digest, http.StatusOK)
	require.Equal(t, "application/zip", bundle.Header().Get("Content-Type"))
	require.Equal(t, strconv.Itoa(len(archive)), bundle.Header().Get("Content-Length"))
	require.Equal(t, archive, bundle.Body.Bytes())
	request(router, 101, packageRoute+strings.Repeat("0", 64), http.StatusNotFound)
	request(router, 103, authorization, http.StatusNotFound)
	request(router, 103, packageRoute+digest, http.StatusNotFound)
	updatePolicy := func(policy string) {
		_, err := db.Exec("UPDATE claudex_plugin_organization_catalog SET installation_preference = $1 WHERE marketplace_id = $2 AND name = 'productivity'", policy, memberPlugins[0].MarketplaceID)
		require.NoError(t, err)
	}
	updatePolicy("not_available")
	request(router, 101, packageRoute+digest, http.StatusNotFound)
	updatePolicy("available")
	large := bytes.Repeat(archive, 262144/len(archive)+1)
	largeHash := sha256.Sum256(large)
	largeDigest := hex.EncodeToString(largeHash[:])
	_, err = db.Exec("UPDATE claudex_plugin_organization_packages SET archive = $1, sha256 = $2 WHERE marketplace_id = $3 AND name = 'productivity'",
		large, largeDigest, memberPlugins[0].MarketplaceID)
	require.NoError(t, err)
	request(router, 101, packageRoute+digest, http.StatusNotFound)
	require.Equal(t, large, request(router, 101, packageRoute+largeDigest, http.StatusOK).Body.Bytes())
	adminPlugins := decodeDirectoryData[[]organizationPlugin](t, request(router, 102, catalogPath, http.StatusOK))
	require.Len(t, adminPlugins, 2)
	require.NotEqual(t, adminPlugins[0].ID, adminPlugins[1].ID)
	require.NotEqual(t, adminPlugins[0].PackageAvailable, adminPlugins[1].PackageAvailable)
	require.Empty(t, decodeDirectoryData[[]organizationPlugin](t, request(router, 103, catalogPath, http.StatusOK)))

	// Fresh component instances use the persisted membership and revocation.
	router = newRouter(db)
	request(router, 101, alpha, http.StatusOK)
	_, err = db.Exec("DELETE FROM claudex_plugin_organization_members WHERE organization_id = $1 AND user_id = $2", "10000000-0000-4000-8000-000000000001", 101)
	require.NoError(t, err)
	request(router, 101, alpha, http.StatusNotFound)
	require.Empty(t, decodeDirectoryData[[]organizationPlugin](t, request(router, 101, catalogPath, http.StatusOK)))
	request(router, 101, packageRoute+digest, http.StatusNotFound)
	request(router, 101, packageRoute+largeDigest, http.StatusNotFound)
	request(router, 102, alpha, http.StatusOK)
	request(newRouter(nil), 101, "", http.StatusServiceUnavailable)
}
