//go:build integration

package bootstrap

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/service"

	_ "github.com/lib/pq"
	"github.com/stretchr/testify/require"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
)

// sqlSettings is a minimal service.SettingRepository over the upstream
// settings table (Claudex code may not import internal/repository).
type sqlSettings struct{ db *sql.DB }

func (s sqlSettings) GetValue(ctx context.Context, key string) (string, error) {
	var v string
	err := s.db.QueryRowContext(ctx, `SELECT value FROM settings WHERE key = $1`, key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", service.ErrSettingNotFound
	}
	return v, err
}
func (s sqlSettings) Get(ctx context.Context, key string) (*service.Setting, error) {
	v, err := s.GetValue(ctx, key)
	if err != nil {
		return nil, err
	}
	return &service.Setting{Key: key, Value: v}, nil
}
func (s sqlSettings) Set(ctx context.Context, key, value string) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO settings (key, value) VALUES ($1, $2)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, key, value)
	return err
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
func (s sqlSettings) SetMultiple(ctx context.Context, kv map[string]string) error {
	for k, v := range kv {
		if err := s.Set(ctx, k, v); err != nil {
			return err
		}
	}
	return nil
}
func (s sqlSettings) GetAll(context.Context) (map[string]string, error) {
	return nil, errors.New("unused")
}
func (s sqlSettings) Delete(ctx context.Context, key string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM settings WHERE key = $1`, key)
	return err
}

func startPostgres(t *testing.T) *sql.DB {
	t.Helper()
	ctx := context.Background()
	image := strings.TrimSpace(os.Getenv("SUB2API_TEST_POSTGRES_IMAGE"))
	if image == "" {
		image = "postgres:18-alpine"
	}
	pg, err := tcpostgres.Run(ctx, image,
		tcpostgres.WithDatabase("claudex_bootstrap_test"),
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
	// Like the server's pool (database.max_idle_conns defaults to 128), not
	// database/sql's 2, which would open a new connection per section.
	db.SetMaxIdleConns(32)
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

// dbContributor answers its section from a real query, like the finished B
// packages that read their tables.
func dbContributor(db *sql.DB, name, section, query string) core.Feature {
	return routedContributor{&contributor{name: name, sections: []string{section},
		fn: func(ctx context.Context, _ *core.BootstrapContext) (map[string]any, error) {
			var v string
			if err := db.QueryRowContext(ctx, query).Scan(&v); err != nil {
				return nil, err
			}
			return map[string]any{section: map[string]any{"value": v}}, nil
		}}}
}

// Against PostgreSQL: B9 reads the site name, the payment switch and the B4
// provisioning switch from the settings table; a section stuck in a slow
// query times out, its query is cancelled on the server and the others are
// served; with every section backed by a query the endpoint stays well under
// the 150 ms p95 of the design (local Docker, idle).
func TestBootstrapAgainstPostgres(t *testing.T) {
	ctx := context.Background()
	db := startPostgres(t)
	repo := sqlSettings{db: db}
	require.NoError(t, repo.SetMultiple(ctx, map[string]string{
		service.SettingKeySiteName:    "Claudex",
		service.SettingPaymentEnabled: "true",
		provisioningKey:               `{"enabled":false,"strategy":"subscription_then_default","max_devices_per_user":5}`,
	}))

	resolver := &plans{fn: func(ctx context.Context, _ int64, _ *int64) (*core.PlanRef, error) {
		var id int64
		if err := db.QueryRowContext(ctx, `SELECT 4::bigint`).Scan(&id); err != nil {
			return nil, err
		}
		plan := testPlan()
		plan.GroupID = id
		return plan, nil
	}}
	fast := []core.Feature{
		routedContributor{&contributor{name: core.NameDevices, sections: []string{core.SectionPlan, core.SectionDevice},
			fn: func(ctx context.Context, bc *core.BootstrapContext) (map[string]any, error) {
				var registered bool
				if err := db.QueryRowContext(ctx, `SELECT false`).Scan(&registered); err != nil {
					return nil, err
				}
				return map[string]any{core.SectionPlan: bc.Plan, core.SectionDevice: map[string]any{"registered": registered}}, nil
			}}},
		dbContributor(db, core.NamePolicy, core.SectionPolicy, `SELECT 'policy'`),
		dbContributor(db, core.NameCatalog, core.SectionModels, `SELECT 'models'`),
		dbContributor(db, core.NameUsage, core.SectionUsage, `SELECT 'usage'`),
		dbContributor(db, core.NameVoice, core.SectionVoice, `SELECT 'voice'`),
		dbContributor(db, core.NameFeedback, core.SectionFeedback, `SELECT 'feedback'`),
		userAndPublicRoutes{userRoutes{component{core.NamePayment}}},
	}
	newEnvFor := func(features ...core.Feature) *core.Env {
		env := newEnv(resolver, features...)
		env.SettingRepo = repo
		env.SettingService = service.NewSettingService(repo, &config.Config{})
		env.PaymentConfig = service.NewPaymentConfigService(nil, repo, nil)
		env.DB = db
		env.Now = time.Now
		return env
	}

	t.Run("slow section times out and its query is cancelled", func(t *testing.T) {
		slow := dbContributor(db, core.NameRelease, core.SectionRelease, `SELECT pg_sleep(30)::text`)
		c := newComponent(newEnvFor(append(append([]core.Feature{}, fast...), slow)...), 300*time.Millisecond)
		begin := time.Now()
		data := document(t, request(router(c, false), "/api/v1/claudex/bootstrap", nil))
		require.Less(t, time.Since(begin), 2*time.Second)
		require.Equal(t, []any{map[string]any{"section": "release", "code": "CLAUDEX_SECTION_TIMEOUT"}}, data["errors"])
		for _, section := range []string{"plan", "device", "policy", "models", "usage", "voice", "feedback"} {
			require.Contains(t, data, section)
		}
		require.Equal(t, "Claudex", object(t, data["server"])["site_name"])
		features := object(t, data["features"])
		require.Equal(t, true, features["payment"])
		require.Equal(t, true, features["desktop_checkout"])
		require.Equal(t, false, features["device_keys"], "provisioning is turned off in the settings table")

		require.Eventually(t, func() bool {
			var n int
			err := db.QueryRowContext(ctx, `SELECT count(*) FROM pg_stat_activity WHERE state = 'active' AND query LIKE '%pg_sleep(30)%' AND pid <> pg_backend_pid()`).Scan(&n)
			return err == nil && n == 0
		}, 5*time.Second, 50*time.Millisecond, "the timed-out query is cancelled on the server")
	})

	t.Run("latency and 304", func(t *testing.T) {
		r := router(newComponent(newEnvFor(fast...), 0), false)
		first := request(r, "/api/v1/claudex/bootstrap", nil)
		data := document(t, first)
		require.Empty(t, data["errors"])
		etag := first.Header().Get("ETag")

		const n = 100
		durations := make([]time.Duration, 0, n)
		for i := 0; i < n; i++ {
			begin := time.Now()
			rec := request(r, "/api/v1/claudex/bootstrap", map[string]string{"If-None-Match": etag})
			durations = append(durations, time.Since(begin))
			require.Equal(t, http.StatusNotModified, rec.Code, "generated_at changes, the ETag does not")
		}
		sort.Slice(durations, func(i, j int) bool { return durations[i] < durations[j] })
		p50, p95 := durations[n/2], durations[n*95/100]
		t.Logf("bootstrap over PostgreSQL with 7 query-backed sections: p50=%s p95=%s max=%s", p50, p95, durations[n-1])
		require.Less(t, p95, 150*time.Millisecond)
	})
}
