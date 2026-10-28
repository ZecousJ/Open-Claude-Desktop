//go:build integration

package webhost

import (
	"context"
	"database/sql"
	"log"
	"os"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core/testsupport"
	"github.com/Wei-Shaw/sub2api/migrations"

	_ "github.com/lib/pq"
	"github.com/stretchr/testify/require"
)

var itDB *sql.DB

func TestMain(m *testing.M) {
	ctx := context.Background()
	pg, err := testsupport.StartPostgres(ctx, "claudex_webhost_test")
	if err != nil {
		if testsupport.Skip(err) {
			log.Printf("docker is not available; skipping the webhost integration tests: %v", err)
			os.Exit(0)
		}
		log.Fatalf("start postgres: %v", err)
	}
	itDB, err = pg.Open(ctx)
	if err != nil {
		log.Fatalf("open db: %v", err)
	}
	// A stand-in for the upstream users table, then the real 0090 (twice:
	// it must be idempotent).
	if _, err := itDB.ExecContext(ctx, `CREATE TABLE users (id BIGSERIAL PRIMARY KEY);
INSERT INTO users DEFAULT VALUES; INSERT INTO users DEFAULT VALUES;`); err != nil {
		log.Fatalf("schema: %v", err)
	}
	for _, name := range []string{"claudex_0090_runners.sql", "claudex_0092_runner_disable.sql"} {
		ddl, err := migrations.FS.ReadFile(name)
		if err != nil {
			log.Fatalf("read migration: %v", err)
		}
		for i := 0; i < 2; i++ {
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

func TestSQLDirectory(t *testing.T) {
	ctx := context.Background()
	d := &sqlDirectory{db: itDB}
	token, err := newRunnerToken()
	require.NoError(t, err)
	rec, err := d.Create(ctx, "home", 1, hashRunnerToken(token))
	require.NoError(t, err)
	require.Equal(t, "home", rec.Name)
	require.EqualValues(t, 1, rec.CreatedBy)

	got, err := d.Authenticate(ctx, hashRunnerToken(token))
	require.NoError(t, err)
	require.Equal(t, rec.ID, got.ID)
	_, err = d.Authenticate(ctx, hashRunnerToken("other"))
	require.ErrorIs(t, err, ErrNoRunner)

	require.NoError(t, d.Seen(ctx, rec.ID, "1.2.3", map[string]string{"region": "home", "bad\x01": "x"}))
	list, err := d.List(ctx)
	require.NoError(t, err)
	require.Len(t, list, 1)
	require.Equal(t, "1.2.3", list[0].LastVersion)
	require.Equal(t, "home", list[0].Labels["region"])
	require.NotNil(t, list[0].LastSeenAt)

	// Assignments: none, set, moved; a deleted user's row goes with it.
	a, err := d.Assignment(ctx, 2)
	require.NoError(t, err)
	require.Equal(t, "", a)
	require.NoError(t, d.Assign(ctx, 2, rec.LinkID()))
	require.NoError(t, d.Assign(ctx, 2, LocalRunnerID))
	a, err = d.Assignment(ctx, 2)
	require.NoError(t, err)
	require.Equal(t, LocalRunnerID, a)
	_, err = itDB.ExecContext(ctx, `DELETE FROM users WHERE id = 2`)
	require.NoError(t, err)
	a, err = d.Assignment(ctx, 2)
	require.NoError(t, err)
	require.Equal(t, "", a)

	// Rename and switch off: a disabled runner cannot authenticate, and
	// switching it on again restores it.
	newName, off, on := "office", true, false
	upd, err := d.Update(ctx, rec.ID, &newName, nil)
	require.NoError(t, err)
	require.Equal(t, "office", upd.Name)
	require.Nil(t, upd.DisabledAt)
	upd, err = d.Update(ctx, rec.ID, nil, &off)
	require.NoError(t, err)
	require.NotNil(t, upd.DisabledAt)
	require.Equal(t, "office", upd.Name)
	_, err = d.Authenticate(ctx, hashRunnerToken(token))
	require.ErrorIs(t, err, ErrNoRunner)
	upd, err = d.Update(ctx, rec.ID, nil, &on)
	require.NoError(t, err)
	require.Nil(t, upd.DisabledAt)
	_, err = d.Authenticate(ctx, hashRunnerToken(token))
	require.NoError(t, err)
	_, err = d.Update(ctx, 9999, &newName, nil)
	require.ErrorIs(t, err, ErrNoRunner)

	// A revoked token never links again.
	_, err = d.Revoke(ctx, rec.ID)
	require.NoError(t, err)
	_, err = d.Authenticate(ctx, hashRunnerToken(token))
	require.ErrorIs(t, err, ErrNoRunner)
	_, err = d.Revoke(ctx, 9999)
	require.ErrorIs(t, err, ErrNoRunner)
	_, err = d.Update(ctx, rec.ID, &newName, nil)
	require.ErrorIs(t, err, ErrNoRunner)
}
