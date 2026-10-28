//go:build integration

package ghconn

import (
	"context"
	"database/sql"
	"log"
	"os"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core/testsupport"
	"github.com/Wei-Shaw/sub2api/migrations"

	_ "github.com/lib/pq"
	"github.com/stretchr/testify/require"
)

var itDB *sql.DB

func TestMain(m *testing.M) {
	ctx := context.Background()
	pg, err := testsupport.StartPostgres(ctx, "claudex_ghconn_test")
	if err != nil {
		if testsupport.Skip(err) {
			log.Printf("docker is not available; skipping the ghconn integration tests: %v", err)
			os.Exit(0)
		}
		log.Fatalf("start postgres: %v", err)
	}
	itDB, err = pg.Open(ctx)
	if err != nil {
		log.Fatalf("open db: %v", err)
	}
	if _, err := itDB.ExecContext(ctx, `CREATE TABLE users (id BIGSERIAL PRIMARY KEY, email VARCHAR(255) NOT NULL DEFAULT '');
INSERT INTO users (email) SELECT 'user' || g || '@example.com' FROM generate_series(1, 5) AS g;`); err != nil {
		log.Fatalf("schema: %v", err)
	}
	ddl, err := migrations.FS.ReadFile("claudex_0093_gh_connections.sql")
	if err != nil {
		log.Fatalf("read migration: %v", err)
	}
	for i := 0; i < 2; i++ { // idempotent
		if _, err := itDB.ExecContext(ctx, string(ddl)); err != nil {
			log.Fatalf("migration run %d: %v", i, err)
		}
	}
	code := m.Run()
	_ = itDB.Close()
	pg.Terminate(ctx)
	os.Exit(code)
}

func TestSQLStoreConnectionRoundTrip(t *testing.T) {
	ctx := context.Background()
	st := &sqlStore{db: itDB}
	_, err := st.get(ctx, 1)
	require.ErrorIs(t, err, errNoRows)

	exp := time.Now().Add(8 * time.Hour).UTC().Truncate(time.Microsecond)
	require.NoError(t, st.upsert(ctx, connection{
		UserID: 1, GitHubID: 42, Login: "octo", TokenSealed: "sealed-a", RefreshSealed: "sealed-r",
		ExpiresAt: &exp, Scope: "repo", ConnectedAt: time.Now(),
	}))
	got, err := st.get(ctx, 1)
	require.NoError(t, err)
	require.Equal(t, "octo", got.Login)
	require.Equal(t, "sealed-r", got.RefreshSealed)
	require.NotNil(t, got.ExpiresAt)
	require.True(t, exp.Equal(*got.ExpiresAt))

	// Reconnecting replaces the row; a token without expiry has neither
	// refresh token nor expiry.
	require.NoError(t, st.upsert(ctx, connection{UserID: 1, GitHubID: 42, Login: "octo2", TokenSealed: "sealed-b", ConnectedAt: time.Now()}))
	got, err = st.get(ctx, 1)
	require.NoError(t, err)
	require.Equal(t, "octo2", got.Login)
	require.Empty(t, got.RefreshSealed)
	require.Nil(t, got.ExpiresAt)

	require.NoError(t, st.updateTokens(ctx, 1, "sealed-c", "sealed-d", &exp))
	got, _ = st.get(ctx, 1)
	require.Equal(t, "sealed-c", got.TokenSealed)
	require.Equal(t, "sealed-d", got.RefreshSealed)

	require.NoError(t, st.remove(ctx, 1))
	_, err = st.get(ctx, 1)
	require.ErrorIs(t, err, errNoRows)
	// Refreshing a disconnected user's tokens is a no-op, not a row.
	require.NoError(t, st.updateTokens(ctx, 1, "x", "", nil))
	_, err = st.get(ctx, 1)
	require.ErrorIs(t, err, errNoRows)
}

func TestSQLStoreStatesAreSingleUseAndExpire(t *testing.T) {
	ctx := context.Background()
	st := &sqlStore{db: itDB}
	now := time.Now()
	require.NoError(t, st.putState(ctx, "h1", oauthState{UserID: 2, VerifierSealed: "v", ExpiresAt: now.Add(time.Minute)}))
	got, err := st.takeState(ctx, "h1", now)
	require.NoError(t, err)
	require.EqualValues(t, 2, got.UserID)
	_, err = st.takeState(ctx, "h1", now)
	require.ErrorIs(t, err, errNoRows)

	require.NoError(t, st.putState(ctx, "h2", oauthState{UserID: 2, VerifierSealed: "v", ExpiresAt: now.Add(-time.Minute)}))
	_, err = st.takeState(ctx, "h2", now)
	require.ErrorIs(t, err, errNoRows)

	require.NoError(t, st.putState(ctx, "h3", oauthState{UserID: 3, VerifierSealed: "v", ExpiresAt: now.Add(-time.Hour)}))
	require.NoError(t, st.sweep(ctx, now))
	_, err = st.takeState(ctx, "h3", now.Add(-2*time.Hour))
	require.ErrorIs(t, err, errNoRows)
}

func TestConnectionsAreRemovedWithTheUser(t *testing.T) {
	ctx := context.Background()
	st := &sqlStore{db: itDB}
	require.NoError(t, st.upsert(ctx, connection{UserID: 4, GitHubID: 1, Login: "x", TokenSealed: "s", ConnectedAt: time.Now()}))
	require.NoError(t, st.putState(ctx, "h4", oauthState{UserID: 4, VerifierSealed: "v", ExpiresAt: time.Now().Add(time.Minute)}))
	_, err := itDB.ExecContext(ctx, `DELETE FROM users WHERE id = 4`)
	require.NoError(t, err)
	_, err = st.get(ctx, 4)
	require.ErrorIs(t, err, errNoRows)
	_, err = st.takeState(ctx, "h4", time.Now())
	require.ErrorIs(t, err, errNoRows)
}
