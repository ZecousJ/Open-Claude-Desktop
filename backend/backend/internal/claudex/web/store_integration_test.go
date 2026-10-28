//go:build integration

package web

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"os"
	"sync"
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
	pg, err := testsupport.StartPostgres(ctx, "claudex_web_test")
	if err != nil {
		if testsupport.Skip(err) {
			log.Printf("docker is not available; skipping the web integration tests: %v", err)
			os.Exit(0)
		}
		log.Fatalf("start postgres: %v", err)
	}
	itDB, err = pg.Open(ctx)
	if err != nil {
		log.Fatalf("open db: %v", err)
	}
	// Stand-ins for the upstream users table and B4's claudex_revoked_sessions
	// (same columns as claudex_0020_devices.sql), then the real 0080.
	if _, err := itDB.ExecContext(ctx, `CREATE TABLE users (id BIGSERIAL PRIMARY KEY, email VARCHAR(255) NOT NULL DEFAULT '');
CREATE TABLE claudex_revoked_sessions (
    session_family_id VARCHAR(64) PRIMARY KEY,
    user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    revoked_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at        TIMESTAMPTZ NOT NULL);
INSERT INTO users (email) SELECT 'user' || g || '@example.com' FROM generate_series(1, 9) AS g;`); err != nil {
		log.Fatalf("schema: %v", err)
	}
	for _, name := range []string{"claudex_0080_web_sessions.sql", "claudex_0142_native_sessions.sql"} {
		ddl, err := migrations.FS.ReadFile(name)
		if err != nil {
			log.Fatalf("read migration: %v", err)
		}
		for i := 0; i < 2; i++ { // idempotent
			if _, err := itDB.ExecContext(ctx, string(ddl)); err != nil {
				log.Fatalf("migration %s run %d: %v", name, i, err)
			}
		}
	}
	code := m.Run()
	_ = itDB.Close()
	pg.Terminate(ctx)
	os.Exit(code)
}

func family(t *testing.T, n int) string {
	t.Helper()
	return fmt.Sprintf("%s-%d", t.Name(), n)
}

func revokedFamilies(t *testing.T, userID int64) map[string]bool {
	t.Helper()
	rows, err := itDB.Query(`SELECT session_family_id FROM claudex_revoked_sessions WHERE user_id = $1`, userID)
	require.NoError(t, err)
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var f string
		require.NoError(t, rows.Scan(&f))
		out[f] = true
	}
	return out
}

func TestStoreCapRevokeList(t *testing.T) {
	ctx := context.Background()
	s := &store{db: itDB}
	const uid = 2
	now := time.Date(2026, 9, 28, 8, 0, 0, 0, time.UTC)
	until := now.Add(48 * time.Hour)

	var created []*Session
	for i := 0; i < 4; i++ {
		at := now.Add(time.Duration(i) * time.Minute)
		sess, ended, err := s.create(ctx, Session{UserID: uid, FamilyID: family(t, i), UserAgent: "ua", IP: "1.2.3.4", ExpiresAt: at.Add(24 * time.Hour)}, 3, at, until)
		require.NoError(t, err)
		created = append(created, sess)
		if i < 3 {
			require.Empty(t, ended)
		} else {
			require.Equal(t, []string{family(t, 0)}, ended, "the oldest past the cap ends")
		}
	}
	require.True(t, revokedFamilies(t, uid)[family(t, 0)])
	old, err := s.byFamily(ctx, family(t, 0))
	require.NoError(t, err)
	require.Equal(t, RevokedCap, old.RevokedReason)

	later := now.Add(10 * time.Minute)
	list, err := s.listActive(ctx, uid, later)
	require.NoError(t, err)
	require.Len(t, list, 3)
	require.Equal(t, created[3].ID, list[0].ID, "newest first")

	// Touch extends; a revoked session cannot be touched.
	ok, err := s.touch(ctx, created[3].ID, later, later.Add(24*time.Hour), "5.6.7.8", "ua2")
	require.NoError(t, err)
	require.True(t, ok)
	ok, err = s.touch(ctx, created[0].ID, later, later.Add(24*time.Hour), "", "")
	require.NoError(t, err)
	require.False(t, ok)

	// Another user cannot revoke the row by id.
	_, err = s.revoke(ctx, 3, created[1].ID, "", RevokedUser, later, until)
	require.ErrorIs(t, err, errNoSession)
	got, err := s.revoke(ctx, uid, created[1].ID, "", RevokedUser, later, until)
	require.NoError(t, err)
	require.Equal(t, family(t, 1), got.FamilyID)
	require.NotNil(t, got.RevokedAt)
	require.True(t, revokedFamilies(t, uid)[family(t, 1)])

	// By family, any user (the refresh and logout paths).
	got, err = s.revoke(ctx, 0, 0, family(t, 2), RevokedLogout, later, until)
	require.NoError(t, err)
	require.Equal(t, RevokedLogout, got.RevokedReason)
	// Again: no error, row as it is.
	got, err = s.revoke(ctx, 0, 0, family(t, 2), RevokedUser, later, until)
	require.NoError(t, err)
	require.Equal(t, RevokedLogout, got.RevokedReason)
	_, err = s.revoke(ctx, 0, 0, "unknown-family", RevokedLogout, later, until)
	require.ErrorIs(t, err, errNoSession)
	_, err = s.revoke(ctx, 3, 0, family(t, 3), RevokedLogout, later, until)
	require.ErrorIs(t, err, errNoSession, "family bound to its user when given")

	families, err := s.revokeAll(ctx, uid, RevokedRevokeAll, later, until)
	require.NoError(t, err)
	require.Equal(t, []string{family(t, 3)}, families)
	list, err = s.listActive(ctx, uid, later)
	require.NoError(t, err)
	require.Empty(t, list)

	n, err := s.cleanup(ctx, later.Add(31*24*time.Hour), keepEnded)
	require.NoError(t, err)
	require.GreaterOrEqual(t, n, int64(4))
	var left int
	require.NoError(t, itDB.QueryRow(`SELECT COUNT(*) FROM claudex_web_sessions WHERE user_id = $1`, uid).Scan(&left))
	require.Zero(t, left)
}

func TestStoreCapConcurrent(t *testing.T) {
	ctx := context.Background()
	s := &store{db: itDB}
	const uid = 4
	now := time.Date(2026, 9, 28, 8, 0, 0, 0, time.UTC)
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, _, err := s.create(ctx, Session{UserID: uid, FamilyID: family(t, i), ExpiresAt: now.Add(time.Hour)}, 5, now, now.Add(2*time.Hour))
			require.NoError(t, err)
		}(i)
	}
	wg.Wait()
	list, err := s.listActive(ctx, uid, now)
	require.NoError(t, err)
	require.Len(t, list, 5)
	require.Len(t, revokedFamilies(t, uid), 7)
}

func TestStoreRevokedReasonCheck(t *testing.T) {
	_, err := itDB.Exec(`INSERT INTO claudex_web_sessions (user_id, family_id, expires_at, revoked_reason) VALUES (5, 'bad-reason', NOW(), 'bogus')`)
	require.Error(t, err)
}

func TestOnSessionsRevoked(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 9, 28, 8, 0, 0, 0, time.UTC)
	c := New(nil)
	c.env.DB = itDB
	c.env.Now = func() time.Time { return now }
	c.store = &store{db: itDB}
	const uid = 6
	for i := 0; i < 2; i++ {
		_, _, err := c.store.create(ctx, Session{UserID: uid, FamilyID: family(t, i), ExpiresAt: now.Add(time.Hour)}, 10, now, now.Add(2*time.Hour))
		require.NoError(t, err)
	}
	require.NoError(t, c.OnSessionsRevoked(ctx, uid, "revoke_all"))
	list, err := c.store.listActive(ctx, uid, now)
	require.NoError(t, err)
	require.Empty(t, list)
	require.Len(t, revokedFamilies(t, uid), 2)
}
