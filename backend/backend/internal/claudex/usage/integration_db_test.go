//go:build integration

package usage

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	_ "github.com/lib/pq"
	"github.com/stretchr/testify/require"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
)

// One PostgreSQL container serves every integration test of the package
// (internal and usage_test); each test gets its own database.
var (
	itOnce      sync.Once
	itContainer *tcpostgres.PostgresContainer
	itBaseDSN   string
	itStartErr  error
	itSeq       atomic.Int64
)

func TestMain(m *testing.M) {
	code := m.Run()
	if itContainer != nil {
		_ = itContainer.Terminate(context.Background())
	}
	os.Exit(code)
}

func startPostgres() {
	ctx := context.Background()
	image := strings.TrimSpace(os.Getenv("SUB2API_TEST_POSTGRES_IMAGE"))
	if image == "" {
		image = "postgres:18-alpine"
	}
	itContainer, itStartErr = tcpostgres.Run(ctx, image,
		tcpostgres.WithDatabase("claudex_usage_test"),
		tcpostgres.WithUsername("postgres"),
		tcpostgres.WithPassword("postgres"),
		tcpostgres.BasicWaitStrategies(),
	)
	if itStartErr != nil {
		return
	}
	itBaseDSN, itStartErr = itContainer.ConnectionString(ctx, "sslmode=disable")
}

func openWithRetry(t *testing.T, dsn string) *sql.DB {
	t.Helper()
	db, err := sql.Open("postgres", dsn)
	require.NoError(t, err)
	deadline := time.Now().Add(30 * time.Second)
	for db.PingContext(context.Background()) != nil && time.Now().Before(deadline) {
		time.Sleep(250 * time.Millisecond)
	}
	require.NoError(t, db.PingContext(context.Background()))
	return db
}

// NewIntegrationDB returns a fresh database with the columns of the upstream
// users and groups tables the Claudex tables refer to (001_init.sql), users
// 11, 12, 13 and groups 4, 6, 9, and migrations/claudex_0030_usage_rules.sql
// applied (twice: it is idempotent). It is exported for the gateway tests in
// package usage_test. The full upstream migration chain runs in
// internal/repository's integration tests.
func NewIntegrationDB(t *testing.T) *sql.DB {
	t.Helper()
	itOnce.Do(startPostgres)
	require.NoError(t, itStartErr)
	ctx := context.Background()

	admin := openWithRetry(t, itBaseDSN)
	name := fmt.Sprintf("claudex_usage_%d", itSeq.Add(1))
	_, err := admin.ExecContext(ctx, "CREATE DATABASE "+name)
	require.NoError(t, err)
	_ = admin.Close()

	u, err := url.Parse(itBaseDSN)
	require.NoError(t, err)
	u.Path = "/" + name
	db := openWithRetry(t, u.String())
	db.SetMaxOpenConns(60)
	t.Cleanup(func() { _ = db.Close() })

	_, err = db.ExecContext(ctx, `
CREATE TABLE users (id BIGSERIAL PRIMARY KEY, email VARCHAR(255) NOT NULL, deleted_at TIMESTAMPTZ);
CREATE TABLE groups (id BIGSERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL, deleted_at TIMESTAMPTZ);
INSERT INTO users (id, email) VALUES (11, 'eleven@example.com'), (12, 'twelve@example.com'), (13, 'thirteen@example.com');
INSERT INTO groups (id, name) VALUES (4, 'claudex-pro'), (6, 'pay-as-you-go'), (9, 'other');`)
	require.NoError(t, err)
	migration, err := os.ReadFile(filepath.Join("..", "..", "..", "migrations", "claudex_0030_usage_rules.sql"))
	require.NoError(t, err)
	_, err = db.ExecContext(ctx, string(migration))
	require.NoError(t, err)
	_, err = db.ExecContext(ctx, string(migration))
	require.NoError(t, err, "the migration is idempotent")
	return db
}

func iptr[T any](v T) *T { return &v }
