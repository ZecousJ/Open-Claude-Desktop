//go:build integration

package memory

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/migrations"

	_ "github.com/lib/pq"
	"github.com/stretchr/testify/require"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
)

var (
	pgOnce      sync.Once
	pgContainer *tcpostgres.PostgresContainer
	pgDSN       string
	pgErr       error
	pgSeq       atomic.Int64
)

func TestMain(m *testing.M) {
	code := m.Run()
	if pgContainer != nil {
		_ = pgContainer.Terminate(context.Background())
	}
	os.Exit(code)
}

func startPostgres() {
	ctx := context.Background()
	image := strings.TrimSpace(os.Getenv("SUB2API_TEST_POSTGRES_IMAGE"))
	if image == "" {
		image = "postgres:18-alpine"
	}
	pgContainer, pgErr = tcpostgres.Run(ctx, image,
		tcpostgres.WithDatabase("claudex_memory_test"),
		tcpostgres.WithUsername("postgres"),
		tcpostgres.WithPassword("postgres"),
		tcpostgres.BasicWaitStrategies(),
	)
	if pgErr != nil {
		return
	}
	pgDSN, pgErr = pgContainer.ConnectionString(ctx, "sslmode=disable")
}

func openDB(t *testing.T, dsn string) *sql.DB {
	t.Helper()
	db, err := sql.Open("postgres", dsn)
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	deadline := time.Now().Add(30 * time.Second)
	for db.PingContext(context.Background()) != nil && time.Now().Before(deadline) {
		time.Sleep(250 * time.Millisecond)
	}
	require.NoError(t, db.PingContext(context.Background()))
	return db
}

func applyMemoryMigration(t *testing.T, db *sql.DB) {
	t.Helper()
	for _, name := range []string{"claudex_0070_memory.sql", "claudex_0181_memory_controls_versions.sql", "claudex_0183_memory_melange.sql", "claudex_0184_memory_cowork.sql"} {
		raw, err := fs.ReadFile(migrations.FS, name)
		require.NoError(t, err)
		_, err = db.ExecContext(context.Background(), string(raw))
		require.NoError(t, err)
	}
}

// freshDB creates an empty database with a minimal users table (and
// claudex_devices when withDevices, standing in for B4's migration), then
// applies claudex_0070_memory.sql from the embedded migrations.
func freshDB(t *testing.T, withDevices bool) *sql.DB {
	t.Helper()
	pgOnce.Do(startPostgres)
	require.NoError(t, pgErr)
	admin := openDB(t, pgDSN)
	name := fmt.Sprintf("memory_%d", pgSeq.Add(1))
	_, err := admin.Exec("CREATE DATABASE " + name)
	require.NoError(t, err)
	u, err := url.Parse(pgDSN)
	require.NoError(t, err)
	u.Path = "/" + name
	db := openDB(t, u.String())
	_, err = db.Exec(`CREATE TABLE users (id BIGSERIAL PRIMARY KEY, email VARCHAR(255) NOT NULL DEFAULT '')`)
	require.NoError(t, err)
	if withDevices {
		_, err = db.Exec(`CREATE TABLE claudex_devices (id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE)`)
		require.NoError(t, err)
	}
	applyMemoryMigration(t, db)
	_, err = db.Exec(`INSERT INTO users (email) SELECT 'user' || g || '@example.com' FROM generate_series(1, 9) AS g`)
	require.NoError(t, err)
	return db
}

func count(t *testing.T, db *sql.DB, query string, args ...any) int {
	t.Helper()
	var n int
	require.NoError(t, db.QueryRow(query, args...).Scan(&n))
	return n
}

func TestIntegrationMigration(t *testing.T) {
	// Without claudex_devices the migration applies, and again changes nothing.
	db := freshDB(t, false)
	applyMemoryMigration(t, db)
	require.Zero(t, count(t, db, `SELECT COUNT(*) FROM pg_constraint WHERE conname = 'fk_claudex_memory_edits_device'`))

	db = freshDB(t, true)
	applyMemoryMigration(t, db)
	require.Equal(t, 1, count(t, db, `SELECT COUNT(*) FROM pg_constraint WHERE conname = 'fk_claudex_memory_edits_device'`))
	_, err := db.Exec(`INSERT INTO claudex_devices (id, user_id) VALUES (51, 1)`)
	require.NoError(t, err)
	s := &sqlStore{db: db}
	ctx := context.Background()
	dev := int64(51)
	_, err = s.addEdit(ctx, 1, editWrite{Scope: "global", TextEnc: "e", TextBytes: 1, DeviceID: &dev, MaxPerScope: 50, MaxScopes: 51})
	require.NoError(t, err)
	missing := int64(52)
	_, err = s.addEdit(ctx, 1, editWrite{Scope: "global", TextEnc: "e", TextBytes: 1, DeviceID: &missing, MaxPerScope: 50, MaxScopes: 51})
	require.Error(t, err, "an unknown device id violates the foreign key")
	_, err = db.Exec(`DELETE FROM claudex_devices WHERE id = 51`)
	require.NoError(t, err)
	require.Equal(t, 1, count(t, db, `SELECT COUNT(*) FROM claudex_memory_edits WHERE device_id IS NULL`))

	// The table checks source; one document per user and scope.
	_, err = db.Exec(`INSERT INTO claudex_memory_docs (user_id, scope, content_enc, source) VALUES (1, 'global', 'x', 'robot')`)
	require.Error(t, err)
	_, err = s.saveDoc(ctx, 1, docWrite{Scope: "global", ContentEnc: "x", ContentBytes: 1, Source: SourceUser, MaxScopes: 51})
	require.NoError(t, err)
	_, err = db.Exec(`INSERT INTO claudex_memory_docs (user_id, scope, content_enc, source) VALUES (1, 'global', 'x', 'user')`)
	require.Error(t, err)

	// Everything goes with the user.
	on := true
	err = s.setPrefs(ctx, 1, prefsWrite{SearchChats: &on, Generate: &on})
	require.NoError(t, err)
	_, err = db.Exec(`DELETE FROM users WHERE id = 1`)
	require.NoError(t, err)
	for _, table := range []string{"claudex_memory_prefs", "claudex_memory_docs", "claudex_memory_edits"} {
		require.Zero(t, count(t, db, `SELECT COUNT(*) FROM `+table), table)
	}
}

func TestIntegrationControls(t *testing.T) {
	exerciseControls(t, newFixture(t, fixtureOptions{db: freshDB(t, false)}))
}

func TestIntegrationConcurrentControls(t *testing.T) {
	db := freshDB(t, false)
	s := &sqlStore{db: db}
	ctx := context.Background()
	initial, err := s.snapshot(ctx, 7, "")
	require.NoError(t, err)
	var wins atomic.Int64
	var conflicts atomic.Int64
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _, err := s.replaceControls(ctx, 7, "global", []editWrite{{TextEnc: "sealed", TextBytes: 6}}, initial.EmptyVersion)
			var conflict *controlsConflictError
			if err == nil {
				wins.Add(1)
			} else if errors.As(err, &conflict) {
				conflicts.Add(1)
			} else {
				t.Errorf("unexpected: %v", err)
			}
		}()
	}
	wg.Wait()
	require.EqualValues(t, 1, wins.Load())
	require.EqualValues(t, 11, conflicts.Load())
	require.Equal(t, 1, count(t, db, `SELECT COUNT(*) FROM claudex_memory_edits WHERE user_id=7`))
}

func TestIntegrationTypeScriptRemoteClient(t *testing.T) {
	f := newFixture(t, fixtureOptions{db: freshDB(t, false)})
	server := httptest.NewServer(f.router)
	defer server.Close()
	repo, err := filepath.Abs("../../../../..")
	require.NoError(t, err)
	cmd := exec.Command(filepath.Join(repo, "node_modules/.bin/tsx"), "tests/support/memory-remote-probe.ts", server.URL, t.TempDir())
	cmd.Dir = repo
	out, err := cmd.CombinedOutput()
	require.NoError(t, err, string(out))
	t.Log(string(out))
}

func TestIntegrationGeneratedSaveAfterPause(t *testing.T) {
	db := freshDB(t, false)
	store := &sqlStore{db: db}
	ctx := context.Background()
	on, off := true, false
	err := store.setPrefs(ctx, 7, prefsWrite{SearchChats: &on, Generate: &on})
	require.NoError(t, err)
	original, err := store.saveDoc(ctx, 7, docWrite{Scope: "global", ContentEnc: "previous", ContentBytes: 8, Source: SourceUser, MaxScopes: 1})
	require.NoError(t, err)
	err = store.setPrefs(ctx, 7, prefsWrite{Generate: &off})
	require.NoError(t, err)
	_, err = store.saveDoc(ctx, 7, docWrite{
		Scope: "global", ContentEnc: "late answer", ContentBytes: 11, Source: SourceGenerated,
		BaseRevision: original.Revision, RequireGenerate: true, MaxScopes: 1,
	})
	require.ErrorIs(t, err, ErrMemoryDisabled)
	docs, err := store.docs(ctx, 7, "global")
	require.NoError(t, err)
	require.Equal(t, []docRow{original}, docs)
}

func TestIntegrationControlsRollback(t *testing.T) {
	db := freshDB(t, false)
	s := &sqlStore{db: db}
	ctx := context.Background()
	_, version, err := s.replaceControls(ctx, 7, "global", []editWrite{{TextEnc: "original", TextBytes: 8}}, "v1:0:0:0")
	require.NoError(t, err)
	// Fail after DELETE and the first INSERT, not just at input validation.
	_, _, err = s.replaceControls(ctx, 7, "global", []editWrite{{TextEnc: "partial", TextBytes: 7}, {TextEnc: "invalid", TextBytes: -1}}, version)
	require.Error(t, err)
	after, err := s.snapshot(ctx, 7, "global")
	require.NoError(t, err)
	require.Equal(t, version, after.Versions["global"])
	require.Len(t, after.Edits, 1)
	require.Equal(t, "original", after.Edits[0].TextEnc)
}

func TestIntegrationStore(t *testing.T) {
	db := freshDB(t, false)
	s := &sqlStore{db: db}
	ctx := context.Background()

	p, err := s.prefs(ctx, 2)
	require.NoError(t, err)
	require.Nil(t, p)
	on, off := true, false
	err = s.setPrefs(ctx, 2, prefsWrite{SearchChats: &on, Generate: &off})
	require.NoError(t, err)
	err = s.setPrefs(ctx, 2, prefsWrite{SearchChats: &off, Generate: &on})
	require.NoError(t, err)
	p, err = s.prefs(ctx, 2)
	require.NoError(t, err)
	require.Equal(t, false, p.SearchChats)
	require.Equal(t, true, p.Generate)

	// Create, update, conflicts.
	d, err := s.saveDoc(ctx, 2, docWrite{Scope: "global", ContentEnc: "v1", ContentBytes: 2, Source: SourceUser, MaxScopes: 51})
	require.NoError(t, err)
	require.Equal(t, int64(1), d.Revision)
	require.Nil(t, d.GeneratedAt)
	_, err = s.saveDoc(ctx, 2, docWrite{Scope: "global", ContentEnc: "v", Source: SourceUser, MaxScopes: 51})
	var ce *conflictError
	require.True(t, errors.As(err, &ce))
	require.Equal(t, int64(1), ce.Current)
	_, err = s.saveDoc(ctx, 2, docWrite{Scope: "global", ContentEnc: "v", Source: SourceUser, BaseRevision: 3, MaxScopes: 51})
	require.True(t, errors.As(err, &ce))

	var ids []int64
	for i := 0; i < 3; i++ {
		e, err := s.addEdit(ctx, 2, editWrite{Scope: "global", TextEnc: fmt.Sprintf("e%d", i), TextBytes: 2, MaxPerScope: 3, MaxScopes: 51})
		require.NoError(t, err)
		ids = append(ids, e.ID)
	}
	_, err = s.addEdit(ctx, 2, editWrite{Scope: "global", TextEnc: "e", MaxPerScope: 3, MaxScopes: 51})
	require.ErrorIs(t, err, errEditLimit)

	upto := ids[1]
	d, err = s.saveDoc(ctx, 2, docWrite{Scope: "global", ContentEnc: "v2", ContentBytes: 5, Source: SourceGenerated, BaseRevision: 1, EditsUpto: &upto, MaxScopes: 51})
	require.NoError(t, err)
	require.Equal(t, int64(2), d.Revision)
	require.NotNil(t, d.GeneratedAt)
	edits, err := s.edits(ctx, 2, "global")
	require.NoError(t, err)
	require.Len(t, edits, 1)
	require.Equal(t, ids[2], edits[0].ID)
	d, err = s.saveDoc(ctx, 2, docWrite{Scope: "global", ContentEnc: "v3", ContentBytes: 5, Source: SourceUser, BaseRevision: 2, MaxScopes: 51})
	require.NoError(t, err)
	require.NotNil(t, d.GeneratedAt, "a user edit keeps generated_at")
	require.Equal(t, "v3", d.ContentEnc)

	// Scope limit counts documents and edits.
	_, err = s.addEdit(ctx, 2, editWrite{Scope: projectA, TextEnc: "p", TextBytes: 1, MaxPerScope: 3, MaxScopes: 2})
	require.NoError(t, err)
	_, err = s.saveDoc(ctx, 2, docWrite{Scope: "project:00000000-0000-4000-8000-000000000001", ContentEnc: "x", Source: SourceUser, MaxScopes: 2})
	require.ErrorIs(t, err, errScopeLimit)
	_, err = s.saveDoc(ctx, 2, docWrite{Scope: projectA, ContentEnc: "x", ContentBytes: 1, Source: SourceImport, MaxScopes: 2})
	require.NoError(t, err, "an existing scope never counts against the limit")

	revs, err := s.revisions(ctx, 2)
	require.NoError(t, err)
	require.Equal(t, map[string]int64{"global": 3, projectA: 1}, revs)
	docs, err := s.docs(ctx, 2, "")
	require.NoError(t, err)
	require.Len(t, docs, 2)
	docs, err = s.docs(ctx, 2, projectA)
	require.NoError(t, err)
	require.Len(t, docs, 1)

	meta, err := s.scopeMeta(ctx, 2)
	require.NoError(t, err)
	require.Len(t, meta, 2)
	require.Equal(t, "global", meta[0].Scope)
	require.Equal(t, 1, meta[0].Edits)
	require.Equal(t, int64(3), meta[0].Revision)
	require.Equal(t, projectA, meta[1].Scope)
	require.True(t, meta[1].HasDocument)
	require.Equal(t, "import", *meta[1].Source)

	// Stats over two users.
	_, err = s.addEdit(ctx, 3, editWrite{Scope: "global", TextEnc: "z", TextBytes: 4, MaxPerScope: 3, MaxScopes: 51})
	require.NoError(t, err)
	st, err := s.stats(ctx)
	require.NoError(t, err)
	require.Equal(t, Stats{UsersOptedIn: 1, UsersWithMemory: 2, Documents: 2, Edits: 3, TotalBytes: 5 + 1 + 2 + 1 + 4}, st)

	// Deletes are per user.
	ok, err := s.deleteEdit(ctx, 3, ids[2])
	require.NoError(t, err)
	require.False(t, ok, "user 3 cannot delete user 2's edit")
	ok, err = s.deleteEdit(ctx, 2, ids[2])
	require.NoError(t, err)
	require.True(t, ok)
	nd, ne, err := s.deleteScope(ctx, 2, projectA)
	require.NoError(t, err)
	require.Equal(t, [2]int64{1, 1}, [2]int64{nd, ne})
	nd, ne, err = s.deleteAll(ctx, 2)
	require.NoError(t, err)
	require.Equal(t, [2]int64{1, 0}, [2]int64{nd, ne})
	p, err = s.prefs(ctx, 2)
	require.NoError(t, err)
	require.NotNil(t, p, "reset keeps the switches")
	require.Equal(t, 1, count(t, db, `SELECT COUNT(*) FROM claudex_memory_edits WHERE user_id = 3`))

	exists, err := s.userExists(ctx, 3)
	require.NoError(t, err)
	require.True(t, exists)
	exists, err = s.userExists(ctx, 999)
	require.NoError(t, err)
	require.False(t, exists)
}

// Concurrent writers never overshoot the limits or skip a revision.
func TestIntegrationConcurrency(t *testing.T) {
	db := freshDB(t, false)
	s := &sqlStore{db: db}
	ctx := context.Background()
	var wg sync.WaitGroup
	var created, conflicts atomic.Int64
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := s.saveDoc(ctx, 4, docWrite{Scope: "global", ContentEnc: "x", Source: SourceUser, MaxScopes: 51})
			var ce *conflictError
			switch {
			case err == nil:
				created.Add(1)
			case errors.As(err, &ce):
				conflicts.Add(1)
			default:
				t.Error(err)
			}
		}()
	}
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = s.addEdit(ctx, 4, editWrite{Scope: "global", TextEnc: "e", MaxPerScope: 5, MaxScopes: 51})
		}()
	}
	wg.Wait()
	require.Equal(t, int64(1), created.Load())
	require.Equal(t, int64(7), conflicts.Load())
	require.Equal(t, 5, count(t, db, `SELECT COUNT(*) FROM claudex_memory_edits WHERE user_id = 4`))
}

// The handlers on a real database: encryption at rest and the admin view.
func TestIntegrationHandlers(t *testing.T) {
	db := freshDB(t, false)
	f := newFixture(t, fixtureOptions{db: db})
	f.userID = 5
	r := f.do(http.MethodPut, "/api/v1/claudex/memory/docs/global", `{"content":"Enjoys hiking in the Alps","source":"user","base_revision":0}`)
	require.Equal(t, http.StatusOK, r.Status, r.Raw)
	r = f.do(http.MethodPost, "/api/v1/claudex/memory/edits", `{"scope":"global","text":"Has two dogs"}`)
	require.Equal(t, http.StatusCreated, r.Status, r.Raw)
	require.Zero(t, count(t, db, `SELECT COUNT(*) FROM claudex_memory_docs WHERE content_enc LIKE '%Alps%'`))
	require.Zero(t, count(t, db, `SELECT COUNT(*) FROM claudex_memory_edits WHERE text_enc LIKE '%dogs%'`))
	v := f.memory()
	require.Equal(t, "Enjoys hiking in the Alps", *v.Docs[0].Content)
	require.Equal(t, "Has two dogs", *v.Edits[0].Text)

	r = f.do(http.MethodGet, "/api/v1/admin/claudex/memory/users/5", "")
	require.Equal(t, http.StatusOK, r.Status, r.Raw)
	require.NotContains(t, r.Raw, "Alps")
	require.NotContains(t, r.Raw, "dogs")
	require.Equal(t, http.StatusNotFound, f.do(http.MethodGet, "/api/v1/admin/claudex/memory/users/999", "").Status)
	require.Equal(t, http.StatusOK, f.do(http.MethodDelete, "/api/v1/admin/claudex/memory/users/5", "").Status)
	require.Empty(t, f.memory().Docs)
}
