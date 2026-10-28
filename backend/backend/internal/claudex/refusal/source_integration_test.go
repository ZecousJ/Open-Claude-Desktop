//go:build integration

package refusal

import (
	"context"
	"database/sql"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"

	_ "github.com/lib/pq"
	"github.com/stretchr/testify/require"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
)

// TestDeviceRevocationIsReadFromPostgres runs the direct claudex_devices read
// against a real PostgreSQL: API_KEY_DISABLED turns into DEVICE_REVOKED the
// moment the row is revoked (no cache in between), into KEY_DISABLED for an
// active device, and a key without a device row is not reported as revoked.
func TestDeviceRevocationIsReadFromPostgres(t *testing.T) {
	ctx := context.Background()
	image := strings.TrimSpace(os.Getenv("SUB2API_TEST_POSTGRES_IMAGE"))
	if image == "" {
		image = "postgres:18-alpine"
	}
	pg, err := tcpostgres.Run(ctx, image,
		tcpostgres.WithDatabase("claudex_refusal_test"),
		tcpostgres.WithUsername("postgres"),
		tcpostgres.WithPassword("postgres"),
		tcpostgres.BasicWaitStrategies(),
	)
	require.NoError(t, err)
	t.Cleanup(func() { _ = pg.Terminate(ctx) })
	dsn, err := pg.ConnectionString(ctx, "sslmode=disable")
	require.NoError(t, err)
	db, err := sql.Open("postgres", dsn)
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	deadline := time.Now().Add(30 * time.Second)
	for db.PingContext(ctx) != nil && time.Now().Before(deadline) {
		time.Sleep(250 * time.Millisecond)
	}

	// The columns B6 reads, with the types and index of B4's
	// claudex_0020_devices.sql (design 2.5); the foreign keys to users,
	// api_keys and groups are left out because this test has no upstream schema.
	_, err = db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS claudex_devices (
		id          BIGSERIAL PRIMARY KEY,
		user_id     BIGINT NOT NULL,
		api_key_id  BIGINT NULL,
		revoked_at  TIMESTAMPTZ NULL,
		revoked_reason VARCHAR(32) NOT NULL DEFAULT ''
	)`)
	require.NoError(t, err)
	_, err = db.ExecContext(ctx, `CREATE UNIQUE INDEX IF NOT EXISTS uq_claudex_devices_api_key ON claudex_devices (api_key_id) WHERE api_key_id IS NOT NULL`)
	require.NoError(t, err)
	// MG: the device's keys of its other groups (claudex_0021_device_group_keys.sql).
	_, err = db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS claudex_device_group_keys (
		id          BIGSERIAL PRIMARY KEY,
		device_id   BIGINT NOT NULL REFERENCES claudex_devices(id) ON DELETE CASCADE,
		user_id     BIGINT NOT NULL,
		group_id    BIGINT NOT NULL,
		api_key_id  BIGINT NOT NULL UNIQUE
	)`)
	require.NoError(t, err)
	_, err = db.ExecContext(ctx, `INSERT INTO claudex_devices (user_id, api_key_id) VALUES (7, 812), (7, 900)`)
	require.NoError(t, err)
	_, err = db.ExecContext(ctx, `INSERT INTO claudex_device_group_keys (device_id, user_id, group_id, api_key_id)
		SELECT id, 7, 11, 913 FROM claudex_devices WHERE api_key_id = 812`)
	require.NoError(t, err)
	_, err = db.ExecContext(ctx, `UPDATE claudex_devices SET revoked_at = NOW(), revoked_reason = 'admin' WHERE api_key_id = 900`)
	require.NoError(t, err)

	src := envSource{env: &core.Env{Deps: core.Deps{DB: db}}}
	revoked, found, err := src.DeviceRevoked(ctx, 812)
	require.NoError(t, err)
	require.True(t, found)
	require.False(t, revoked)
	revoked, found, err = src.DeviceRevoked(ctx, 900)
	require.NoError(t, err)
	require.True(t, found)
	require.True(t, revoked)
	revoked, found, err = src.DeviceRevoked(ctx, 913) // a group key of the active device
	require.NoError(t, err)
	require.True(t, found)
	require.False(t, revoked)
	revoked, found, err = src.DeviceRevoked(ctx, 12345)
	require.NoError(t, err)
	require.False(t, found)
	require.False(t, revoked)

	c := New(&core.Env{Deps: core.Deps{DB: db}, Now: time.Now})
	refusal := testRefusal(http.StatusUnauthorized, "API_KEY_DISABLED", "API key is disabled")
	require.Equal(t, ReasonKeyDisabled, c.Describe(describeCtx(nil), refusal).Reason)

	// Another node revokes the device: the very next refusal says so.
	_, err = db.ExecContext(ctx, `UPDATE claudex_devices SET revoked_at = NOW(), revoked_reason = 'revoke_all' WHERE api_key_id = 812`)
	require.NoError(t, err)
	d := c.Describe(describeCtx(nil), refusal)
	require.Equal(t, ReasonDeviceRevoked, d.Reason)
	revoked, found, err = src.DeviceRevoked(ctx, 913)
	require.NoError(t, err)
	require.True(t, found && revoked, "the device's group key is revoked with it")
	require.Equal(t, actionSignIn, d.Action)
	require.False(t, d.Reprovision)
}
