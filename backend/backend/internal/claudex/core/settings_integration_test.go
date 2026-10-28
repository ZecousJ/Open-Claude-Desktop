//go:build integration

package core

import (
	"context"
	"database/sql"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	_ "github.com/lib/pq"
	"github.com/stretchr/testify/require"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
)

// TestJSONSettingSwapIfUnchangedIsAtomic runs the compare-and-swap against a
// real PostgreSQL with the upstream settings table layout: of two writers
// starting from the same stored text exactly one wins, for both the insert and
// the update statement.
func TestJSONSettingSwapIfUnchangedIsAtomic(t *testing.T) {
	ctx := context.Background()
	image := strings.TrimSpace(os.Getenv("SUB2API_TEST_POSTGRES_IMAGE"))
	if image == "" {
		image = "postgres:18-alpine"
	}
	pg, err := tcpostgres.Run(ctx, image,
		tcpostgres.WithDatabase("claudex_core_test"),
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

	type policy struct {
		Revision int `json:"revision"`
	}
	repoFor := func() *JSONSetting[policy] {
		return NewJSONSetting[policy](nil, "claudex_swap_test", func() policy { return policy{} })
	}

	race := func(expectedRaw string, next int) (wins int) {
		var mu sync.Mutex
		var wg sync.WaitGroup
		var errs []error
		start := make(chan struct{})
		for i := 0; i < 2; i++ {
			wg.Add(1)
			go func(writer int) {
				defer wg.Done()
				<-start
				_, ok, err := repoFor().SwapIfUnchanged(ctx, db, expectedRaw, policy{Revision: next*10 + writer})
				mu.Lock()
				defer mu.Unlock()
				if err != nil {
					errs = append(errs, err)
				}
				if ok {
					wins++
				}
			}(i)
		}
		close(start)
		wg.Wait()
		require.Empty(t, errs)
		return wins
	}

	for round := 0; round < 20; round++ {
		_, err := db.ExecContext(ctx, `DELETE FROM settings WHERE key = 'claudex_swap_test'`)
		require.NoError(t, err)
		require.Equal(t, 1, race("", round), "insert round %d", round)

		var raw string
		require.NoError(t, db.QueryRowContext(ctx, `SELECT value FROM settings WHERE key = 'claudex_swap_test'`).Scan(&raw))
		require.Equal(t, 1, race(raw, round+100), "update round %d", round)
	}

	// A stored empty value counts as missing.
	_, err = db.ExecContext(ctx, `UPDATE settings SET value = '' WHERE key = 'claudex_swap_test'`)
	require.NoError(t, err)
	_, ok, err := repoFor().SwapIfUnchanged(ctx, db, "", policy{Revision: 1})
	require.NoError(t, err)
	require.True(t, ok)
	_, ok, err = repoFor().SwapIfUnchanged(ctx, db, "", policy{Revision: 2})
	require.NoError(t, err)
	require.False(t, ok, "an existing value is never overwritten by an insert")
}
