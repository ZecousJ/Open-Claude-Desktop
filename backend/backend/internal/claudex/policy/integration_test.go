//go:build integration

package policy

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/service"

	_ "github.com/lib/pq"
	"github.com/stretchr/testify/require"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
)

// sqlSettings reads the settings table like the upstream repository (reads
// only: Claudex writes the policy through JSONSetting.SwapIfUnchanged).
type sqlSettings struct {
	service.SettingRepository
	db *sql.DB
}

func (s sqlSettings) GetValue(ctx context.Context, key string) (string, error) {
	var v string
	err := s.db.QueryRowContext(ctx, `SELECT value FROM settings WHERE key = $1`, key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", service.ErrSettingNotFound
	}
	return v, err
}

func (s sqlSettings) GetMultiple(ctx context.Context, keys []string) (map[string]string, error) {
	out := map[string]string{}
	for _, k := range keys {
		v, err := s.GetValue(ctx, k)
		if errors.Is(err, service.ErrSettingNotFound) {
			continue
		}
		if err != nil {
			return nil, err
		}
		out[k] = v
	}
	return out, nil
}

func startPostgres(t *testing.T) *sql.DB {
	t.Helper()
	ctx := context.Background()
	image := strings.TrimSpace(os.Getenv("SUB2API_TEST_POSTGRES_IMAGE"))
	if image == "" {
		image = "postgres:18-alpine"
	}
	pg, err := tcpostgres.Run(ctx, image,
		tcpostgres.WithDatabase("claudex_policy_test"),
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
	// Same layout as migrations/005_schema_parity.sql.
	_, err = db.ExecContext(ctx, `CREATE TABLE settings (
		id BIGSERIAL PRIMARY KEY,
		key VARCHAR(100) NOT NULL UNIQUE,
		value TEXT NOT NULL,
		updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
	require.NoError(t, err)
	return db
}

// newDBFixture is newFixture on a real database: settings are read with SQL
// and written with the real JSONSetting.SwapIfUnchanged.
func newDBFixture(t *testing.T, db *sql.DB) *fixture {
	t.Helper()
	f := newFixture(t)
	repo := sqlSettings{db: db}
	env := &core.Env{
		Deps: core.Deps{SettingRepo: repo, DB: db, GroupRepo: f.groups, UserRepo: f.users},
		Now:  func() time.Time { return f.now },
	}
	env.Peers.Plans = f.plans
	f.c = New(env)
	sqlSwap := f.c.swap
	f.c.swap = func(ctx context.Context, expectedRaw string, next Document) (Document, bool, error) {
		if f.beforeSwap != nil {
			f.beforeSwap()
		}
		return sqlSwap(ctx, expectedRaw, next)
	}
	f.buildEngine()
	return f
}

func storedRaw(t *testing.T, db *sql.DB) (raw string, exists bool) {
	t.Helper()
	err := db.QueryRow(`SELECT value FROM settings WHERE key = $1`, SettingKey).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false
	}
	require.NoError(t, err)
	return raw, true
}

func TestIntegrationPolicyOnPostgres(t *testing.T) {
	db := startPostgres(t)

	t.Run("first PUT inserts, stale revision 409, same-node GET sees it", func(t *testing.T) {
		_, err := db.Exec(`DELETE FROM settings`)
		require.NoError(t, err)
		f := newDBFixture(t, db)
		before := f.getPolicy(200, "", nil)
		require.Equal(t, http.StatusOK, before.status)
		require.EqualValues(t, 0, dataField(t, before, "revision"))

		r := f.put(putBody(`{"plan_label":"Team"}`, `[{"group_id":4,"patch":{"plan_label":"Max"}}]`, `[]`))
		require.Equal(t, http.StatusOK, r.status, "%s", r.body)
		raw, exists := storedRaw(t, db)
		require.True(t, exists)
		require.Contains(t, raw, `"revision":1,`)

		after := f.getPolicy(200, "", map[string]string{"If-None-Match": before.header.Get("ETag")})
		require.Equal(t, http.StatusOK, after.status)
		require.Equal(t, "Max", dataField(t, after, "plan_label"))
		require.NotEqual(t, before.header.Get("ETag"), after.header.Get("ETag"))
		require.Equal(t, http.StatusNotModified, f.getPolicy(200, "", map[string]string{"If-None-Match": after.header.Get("ETag")}).status)

		r = f.put(putBody(`{}`, `[]`, `[]`))
		require.Equal(t, http.StatusConflict, r.status)
		require.Equal(t, ReasonRevisionConflict, r.reason)
	})

	t.Run("two concurrent PUTs with the same revision: one 200, one 409", func(t *testing.T) {
		for round := 0; round < 10; round++ {
			for _, fresh := range []bool{true, false} {
				_, err := db.Exec(`DELETE FROM settings`)
				require.NoError(t, err)
				revision := 0
				if !fresh {
					_, err = db.Exec(`INSERT INTO settings (key, value) VALUES ($1, $2)`, SettingKey, `{"version":1,"revision":7}`)
					require.NoError(t, err)
					revision = 7
				}
				// Two nodes: separate components (separate caches) on one database.
				nodes := []*fixture{newDBFixture(t, db), newDBFixture(t, db)}
				var arrived sync.WaitGroup
				arrived.Add(2)
				for _, n := range nodes {
					n.beforeSwap = func() {
						arrived.Done()
						waitTimeout(t, &arrived, 10*time.Second)
					}
				}
				statuses := make([]int, 2)
				var wg sync.WaitGroup
				for i, n := range nodes {
					wg.Add(1)
					go func(i int, n *fixture) {
						defer wg.Done()
						statuses[i] = n.put(fmt.Sprintf(`{"revision":%d,"defaults":{"plan_label":"N%d"},"group_overrides":[],"user_overrides":[]}`, revision, i)).status
					}(i, n)
				}
				wg.Wait()
				require.ElementsMatch(t, []int{http.StatusOK, http.StatusConflict}, statuses, "round %d fresh=%v", round, fresh)
				raw, _ := storedRaw(t, db)
				require.Contains(t, raw, fmt.Sprintf(`"revision":%d,`, revision+1))
				winner := 0
				if statuses[1] == http.StatusOK {
					winner = 1
				}
				require.Contains(t, raw, fmt.Sprintf(`"plan_label":"N%d"`, winner))
			}
		}
	})

	t.Run("corrupt stored JSON serves the built-in policy and PUT repairs it", func(t *testing.T) {
		_, err := db.Exec(`DELETE FROM settings`)
		require.NoError(t, err)
		_, err = db.Exec(`INSERT INTO settings (key, value) VALUES ($1, $2)`, SettingKey, `{"revision": 4, "defaults": [`)
		require.NoError(t, err)
		logs := captureLogs(t)
		f := newDBFixture(t, db)
		r := f.getPolicy(200, "", nil)
		require.Equal(t, http.StatusOK, r.status)
		require.EqualValues(t, 0, dataField(t, r, "revision"))
		require.Contains(t, logs.String(), "unreadable setting")
		r = f.put(putBody(`{"voice":false}`, `[]`, `[]`))
		require.Equal(t, http.StatusOK, r.status, "%s", r.body)
		raw, _ := storedRaw(t, db)
		require.Contains(t, raw, `"revision":1,`)
	})
}
