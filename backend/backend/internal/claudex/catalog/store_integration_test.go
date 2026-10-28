//go:build integration

package catalog

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/Wei-Shaw/sub2api/migrations"

	"github.com/lib/pq"
	"github.com/stretchr/testify/require"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
)

// startPostgres starts PostgreSQL with the two upstream tables the migration
// references (same key and soft-delete columns as migrations/001_init.sql)
// and applies claudex_0010_model_meta.sql twice (it must be idempotent).
func startPostgres(t *testing.T) *sql.DB {
	t.Helper()
	ctx := context.Background()
	image := strings.TrimSpace(os.Getenv("SUB2API_TEST_POSTGRES_IMAGE"))
	if image == "" {
		image = "postgres:18-alpine"
	}
	pg, err := tcpostgres.Run(ctx, image,
		tcpostgres.WithDatabase("claudex_catalog_test"),
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
	_, err = db.ExecContext(ctx, `
		CREATE TABLE users (id BIGSERIAL PRIMARY KEY, email VARCHAR(255) NOT NULL, deleted_at TIMESTAMPTZ);
		CREATE TABLE groups (id BIGSERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL, deleted_at TIMESTAMPTZ);
		INSERT INTO users (email) VALUES ('admin@example.com');
		INSERT INTO groups (name) VALUES ('claudex-pro'), ('claudex-team'), ('exclusive');`)
	require.NoError(t, err)
	migration, err := migrations.FS.ReadFile("claudex_0010_model_meta.sql")
	require.NoError(t, err)
	for i := 0; i < 2; i++ {
		_, err = db.ExecContext(ctx, string(migration))
		require.NoError(t, err, "apply %d", i+1)
	}
	minimumVersion, err := migrations.FS.ReadFile("claudex_0162_model_minimum_desktop_version.sql")
	require.NoError(t, err)
	for i := 0; i < 2; i++ {
		_, err = db.ExecContext(ctx, string(minimumVersion))
		require.NoError(t, err, "apply minimum desktop version %d", i+1)
	}
	return db
}

func pqCode(err error) (code, constraint string) {
	var pqErr *pq.Error
	if errors.As(err, &pqErr) {
		return string(pqErr.Code), pqErr.Constraint
	}
	return "", ""
}

func TestIntegrationMigrationConstraints(t *testing.T) {
	db := startPostgres(t)
	ctx := context.Background()
	exec := func(q string, args ...any) error {
		_, err := db.ExecContext(ctx, q, args...)
		return err
	}
	insert := func(model string, group any, isDefault bool) error {
		return exec(`INSERT INTO claudex_model_meta (model_id, group_id, is_default) VALUES ($1, $2, $3)`, model, group, isDefault)
	}

	// Defaults of the columns.
	require.NoError(t, insert("a", nil, false))
	var badges string
	var efforts sql.NullString
	var hidden bool
	var fast sql.NullBool
	require.NoError(t, db.QueryRowContext(ctx, `SELECT badges::text, supported_efforts::text, hidden, fast_tier
		FROM claudex_model_meta WHERE model_id = 'a'`).Scan(&badges, &efforts, &hidden, &fast))
	require.Equal(t, "[]", badges)
	require.False(t, efforts.Valid)
	require.False(t, hidden)
	require.False(t, fast.Valid)

	// Unique scope: one row per model and scope (global = group 0).
	code, constraint := pqCode(insert("a", nil, false))
	require.Equal(t, "23505", code)
	require.Equal(t, "uq_claudex_model_meta_scope", constraint)
	require.NoError(t, insert("a", 1, false), "the same model may have a group row")
	require.NoError(t, insert("a", 2, false), "and a row in another group")
	code, constraint = pqCode(insert("a", 1, false))
	require.Equal(t, "23505", code)
	require.Equal(t, "uq_claudex_model_meta_scope", constraint)

	// One default per scope.
	require.NoError(t, insert("d1", nil, true))
	code, constraint = pqCode(insert("d2", nil, true))
	require.Equal(t, "23505", code)
	require.Equal(t, "uq_claudex_model_meta_default", constraint)
	require.NoError(t, insert("d1", 1, true), "each group has its own default")
	code, _ = pqCode(insert("d2", 1, true))
	require.Equal(t, "23505", code)
	require.NoError(t, insert("d3", 1, false), "non-default rows are not limited")

	// Checks and foreign keys.
	code, _ = pqCode(exec(`INSERT INTO claudex_model_meta (model_id, context_window) VALUES ('c', 0)`))
	require.Equal(t, "23514", code)
	code, _ = pqCode(exec(`INSERT INTO claudex_model_meta (model_id, auto_compact_tokens) VALUES ('c', -1)`))
	require.Equal(t, "23514", code)
	code, _ = pqCode(insert("c", 999, false))
	require.Equal(t, "23503", code)
	code, _ = pqCode(exec(`INSERT INTO claudex_model_meta (model_id, display_name) VALUES ('c', $1)`, strings.Repeat("n", 101)))
	require.Equal(t, "22001", code, "display_name is VARCHAR(100)")

	// A hard group delete cascades, a hard user delete keeps the row.
	require.NoError(t, exec(`INSERT INTO claudex_model_meta (model_id, created_by) VALUES ('by-admin', 1)`))
	require.NoError(t, exec(`DELETE FROM groups WHERE id = 2`))
	var n int
	require.NoError(t, db.QueryRowContext(ctx, `SELECT COUNT(*) FROM claudex_model_meta WHERE group_id = 2`).Scan(&n))
	require.Zero(t, n)
	require.NoError(t, exec(`DELETE FROM users WHERE id = 1`))
	var createdBy sql.NullInt64
	require.NoError(t, db.QueryRowContext(ctx, `SELECT created_by FROM claudex_model_meta WHERE model_id = 'by-admin'`).Scan(&createdBy))
	require.False(t, createdBy.Valid)

	// The indexes the design lists exist.
	for _, idx := range []string{"uq_claudex_model_meta_scope", "uq_claudex_model_meta_default", "idx_claudex_model_meta_group"} {
		var found bool
		require.NoError(t, db.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = $1)`, idx).Scan(&found))
		require.True(t, found, idx)
	}
}

func storeFor(db *sql.DB) sqlStore { return sqlStore{db: func() *sql.DB { return db }} }

func TestIntegrationSQLStore(t *testing.T) {
	db := startPostgres(t)
	ctx := context.Background()
	s := storeFor(db)
	admin := int64(1)

	in := Input{ModelID: "gpt-5.5", DisplayName: "GPT-5.5", Badges: []string{"new"}, SortOrder: 10, IsDefault: true,
		SupportedEfforts: []string{"low", "medium"}, DefaultEffort: "medium", ContextWindow: intp(400000),
		AutoCompactTokens: intp(320000), FastTier: boolp(true), UsageHint: "1.5× usage", MinimumDesktopVersion: "1.2.3"}
	require.NoError(t, normalize(&in))
	row, err := s.Create(ctx, in, &admin)
	require.NoError(t, err)
	require.Equal(t, "gpt-5.5", row.ModelID)
	require.Equal(t, "1.2.3", row.MinimumDesktopVersion)
	require.Nil(t, row.GroupID)
	require.Equal(t, []string{"new"}, row.Badges)
	require.Equal(t, []string{"low", "medium"}, row.SupportedEfforts)
	require.Equal(t, 400000, *row.ContextWindow)
	require.True(t, *row.FastTier)
	require.Equal(t, admin, *row.CreatedBy)
	require.Equal(t, time.UTC, row.CreatedAt.Location())

	empty := Input{ModelID: "plain", SupportedEfforts: []string{}}
	require.NoError(t, normalize(&empty))
	plain, err := s.Create(ctx, empty, nil)
	require.NoError(t, err)
	require.NotNil(t, plain.SupportedEfforts, "[] round-trips as [] (not null)")
	require.Empty(t, plain.SupportedEfforts)
	require.Nil(t, plain.CreatedBy)
	require.Nil(t, plain.FastTier)

	_, err = s.Create(ctx, Input{ModelID: "gpt-5.5", Badges: []string{}}, nil)
	require.ErrorIs(t, err, ErrConflict)
	require.Equal(t, http.StatusConflict, infraerrors.Code(err))
	_, err = s.Create(ctx, Input{ModelID: "x", GroupID: i64p(999), Badges: []string{}}, nil)
	require.ErrorIs(t, err, ErrGroupNotFound)

	g1, err := s.Create(ctx, Input{ModelID: "gpt-5.5", GroupID: i64p(1), DisplayName: "Team", Badges: []string{}}, nil)
	require.NoError(t, err)
	require.Equal(t, "claudex-pro", g1.GroupName)
	g3, err := s.Create(ctx, Input{ModelID: "exclusive-model", GroupID: i64p(3), IsDefault: true, Badges: []string{}}, nil)
	require.NoError(t, err)

	// Update replaces the mutable fields.
	upd := Input{ModelID: "ignored", GroupID: i64p(3), DisplayName: "GPT-5.5 new", Badges: []string{}}
	updated, err := s.Update(ctx, row.ID, upd)
	require.NoError(t, err)
	require.Equal(t, "gpt-5.5", updated.ModelID, "model_id never changes")
	require.Nil(t, updated.GroupID, "group_id never changes")
	require.Equal(t, "GPT-5.5 new", updated.DisplayName)
	require.Nil(t, updated.SupportedEfforts)
	require.Nil(t, updated.ContextWindow)
	require.False(t, updated.IsDefault)
	require.False(t, updated.UpdatedAt.Before(updated.CreatedAt))
	_, err = s.Update(ctx, 99999, upd)
	require.ErrorIs(t, err, ErrNotFound)

	// Scope: global + that group; a soft-deleted group's rows no longer count.
	rows, err := s.Scope(ctx, 1)
	require.NoError(t, err)
	require.Len(t, rows, 3)
	rows, err = s.Scope(ctx, 0)
	require.NoError(t, err)
	require.Len(t, rows, 2)
	_, err = db.ExecContext(ctx, `UPDATE groups SET deleted_at = NOW() WHERE id = 3`)
	require.NoError(t, err)
	rows, err = s.Scope(ctx, 3)
	require.NoError(t, err)
	require.Len(t, rows, 2, "rows of a deleted group are ignored")

	// List: filters, search with LIKE metacharacters, paging, deleted label.
	list, total, err := s.List(ctx, listFilter{Scope: scopeAll, Page: 1, PageSize: 50})
	require.NoError(t, err)
	require.EqualValues(t, 4, total)
	require.Nil(t, list[0].GroupID, "global rows first")
	var deleted Row
	for _, r := range list {
		if r.ID == g3.ID {
			deleted = r
		}
	}
	require.True(t, deleted.GroupDeleted)
	require.Equal(t, "", deleted.GroupName)
	_, total, err = s.List(ctx, listFilter{Scope: scopeGlobal, Page: 1, PageSize: 50})
	require.NoError(t, err)
	require.EqualValues(t, 2, total)
	list, total, err = s.List(ctx, listFilter{Scope: scopeGroup, GroupID: 1, Page: 1, PageSize: 50})
	require.NoError(t, err)
	require.EqualValues(t, 1, total)
	require.Equal(t, "Team", list[0].DisplayName)
	_, total, err = s.List(ctx, listFilter{Query: "GPT-5.5 NEW", Page: 1, PageSize: 50})
	require.NoError(t, err)
	require.EqualValues(t, 1, total, "search is case-insensitive on the display name")
	_, total, err = s.List(ctx, listFilter{Query: "%", Page: 1, PageSize: 50})
	require.NoError(t, err)
	require.EqualValues(t, 0, total, "% is a literal")
	_, total, err = s.List(ctx, listFilter{Query: "gpt_5", Page: 1, PageSize: 50})
	require.NoError(t, err)
	require.EqualValues(t, 0, total, "_ is a literal")
	// PostgreSQL rejects NUL and invalid UTF-8 in a text parameter: a search
	// with them is cleaned instead of failing with a 500.
	for _, q := range []string{"\x00", "gpt\x00-5.5", "\xff", "GPT-5.5\xff NEW"} {
		_, total, err = s.List(ctx, listFilter{Query: q, Page: 1, PageSize: 50})
		require.NoError(t, err, "%q", q)
		require.Positive(t, total, "%q", q)
	}
	list, total, err = s.List(ctx, listFilter{Page: 2, PageSize: 3})
	require.NoError(t, err)
	require.EqualValues(t, 4, total)
	require.Len(t, list, 1)

	// Delete.
	require.NoError(t, s.Delete(ctx, plain.ID))
	require.ErrorIs(t, s.Delete(ctx, plain.ID), ErrNotFound)
	_, err = s.Get(ctx, plain.ID)
	require.ErrorIs(t, err, ErrNotFound)
}

func defaultsIn(t *testing.T, db *sql.DB, scope int64) []string {
	t.Helper()
	rows, err := db.Query(`SELECT model_id FROM claudex_model_meta WHERE COALESCE(group_id, 0) = $1 AND is_default ORDER BY model_id`, scope)
	require.NoError(t, err)
	defer func() { _ = rows.Close() }()
	var out []string
	for rows.Next() {
		var m string
		require.NoError(t, rows.Scan(&m))
		out = append(out, m)
	}
	return out
}

func TestIntegrationDefaultSwitchIsTransactional(t *testing.T) {
	db := startPostgres(t)
	ctx := context.Background()
	s := storeFor(db)

	a, err := s.Create(ctx, Input{ModelID: "a", IsDefault: true, Badges: []string{}}, nil)
	require.NoError(t, err)
	g, err := s.Create(ctx, Input{ModelID: "g", GroupID: i64p(1), IsDefault: true, Badges: []string{}}, nil)
	require.NoError(t, err)

	// A failed write rolls back the default it cleared.
	_, err = s.Create(ctx, Input{ModelID: "a", IsDefault: true, Badges: []string{}}, nil)
	require.ErrorIs(t, err, ErrConflict)
	require.Equal(t, []string{"a"}, defaultsIn(t, db, 0), "the conflicting insert did not clear the default")

	b, err := s.Create(ctx, Input{ModelID: "b", IsDefault: true, Badges: []string{}}, nil)
	require.NoError(t, err)
	require.Equal(t, []string{"b"}, defaultsIn(t, db, 0))
	require.Equal(t, []string{"g"}, defaultsIn(t, db, 1), "other scopes keep their default")
	_, err = s.Update(ctx, a.ID, Input{IsDefault: true, Badges: []string{}})
	require.NoError(t, err)
	require.Equal(t, []string{"a"}, defaultsIn(t, db, 0))
	_, err = s.Update(ctx, g.ID, Input{IsDefault: false, Badges: []string{}})
	require.NoError(t, err)
	require.Empty(t, defaultsIn(t, db, 1))

	// Concurrent default switches in one scope: all succeed, one default remains.
	for round := 0; round < 5; round++ {
		var wg sync.WaitGroup
		errs := make(chan error, 16)
		start := make(chan struct{})
		for i := 0; i < 8; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				<-start
				model := "m" + strconv.Itoa(round) + "-" + strconv.Itoa(i)
				if _, err := s.Create(ctx, Input{ModelID: model, IsDefault: true, Badges: []string{}}, nil); err != nil {
					errs <- err
				}
			}(i)
		}
		for _, id := range []int64{a.ID, b.ID} {
			wg.Add(1)
			go func(id int64) {
				defer wg.Done()
				<-start
				if _, err := s.Update(ctx, id, Input{IsDefault: true, Badges: []string{}}); err != nil {
					errs <- err
				}
			}(id)
		}
		close(start)
		wg.Wait()
		close(errs)
		for err := range errs {
			require.NoError(t, err, "round %d", round)
		}
		require.Len(t, defaultsIn(t, db, 0), 1, "round %d", round)
	}
}

// TestIntegrationConsoleDefaultReachesClientAndBootstrap is the acceptance
// check of design 2.4: after the console sets the default model, GET
// /claudex/models and the bootstrap section "models" both name it; a group
// the user cannot use is ignored.
func TestIntegrationConsoleDefaultReachesClientAndBootstrap(t *testing.T) {
	db := startPostgres(t)
	h := newHarness(t)
	h.store = nil
	h.c.store = storeFor(db)
	h.groups.groups = map[int64]*service.Group{
		1: {ID: 1, Name: "claudex-pro", Platform: service.PlatformOpenAI, Status: service.StatusActive, MaxReasoningEffort: "high"},
		2: {ID: 2, Name: "claudex-team", Platform: service.PlatformOpenAI, Status: service.StatusActive},
		3: {ID: 3, Name: "exclusive", Platform: service.PlatformOpenAI, Status: service.StatusActive},
	}
	h.plans.allowed = map[int64][]int64{7: {1}}

	h.create(`{"model_id":"gpt-5.5","display_name":"GPT-5.5","sort_order":10,"is_default":true,
		"supported_efforts":["low","medium","high","xhigh"],"default_effort":"xhigh"}`)
	h.create(`{"model_id":"gpt-5.5-mini","sort_order":20}`)
	h.create(`{"model_id":"secret","group_id":3,"is_default":true}`)
	_, env := h.user("/api/v1/claudex/models?group_id=3")
	cat := decodeCatalog(t, env)
	require.Equal(t, int64(1), *cat.GroupID, "group 3 is not the user's")
	require.Equal(t, "gpt-5.5", *cat.DefaultModel)
	require.NotContains(t, ids(cat), "secret")
	gpt := item(t, cat, "gpt-5.5")
	require.Equal(t, []string{"low", "medium", "high"}, *gpt.Efforts, "cut to the group ceiling")
	require.Equal(t, "medium", gpt.DefaultEffort)

	// The console makes the mini model the default of group 1.
	h.create(`{"model_id":"gpt-5.5-mini","group_id":1,"sort_order":20,"is_default":true}`)
	_, env = h.user("/api/v1/claudex/models")
	cat = decodeCatalog(t, env)
	require.Equal(t, "gpt-5.5-mini", *cat.DefaultModel)

	plan, err := h.plans.ResolvePlan(context.Background(), 7, i64p(3))
	require.NoError(t, err)
	sections, err := h.c.BootstrapSections(context.Background(), &core.BootstrapContext{UserID: 7, Plan: plan})
	require.NoError(t, err)
	raw, err := json.Marshal(sections[core.SectionModels])
	require.NoError(t, err)
	require.JSONEq(t, string(env.Data), string(raw))
	fromBootstrap, ok := sections[core.SectionModels].(*Catalog)
	require.True(t, ok)
	require.Equal(t, "gpt-5.5-mini", *fromBootstrap.DefaultModel)
}
