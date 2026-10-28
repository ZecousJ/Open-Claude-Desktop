//go:build integration

// Package testsupport starts the testcontainers the Claudex integration tests
// use (PostgreSQL, Redis). Every container gets the label
// claudex.it.run=<CLAUDEX_IT_RUN_ID> when scripts/backend/go.sh
// test-integration set that variable, so the script caps and removes the
// containers of its own run only and never those of a concurrent run in
// another checkout (Ryuk is disabled there).
package testsupport

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	tcredis "github.com/testcontainers/testcontainers-go/modules/redis"

	_ "github.com/lib/pq" // PostgreSQL driver for sql.Open("postgres", ...)
)

// RunLabel is the container label go.sh filters on.
const RunLabel = "claudex.it.run"

// RunIDEnv names the variable go.sh passes into the test container.
const RunIDEnv = "CLAUDEX_IT_RUN_ID"

// Default images; go.sh passes SUB2API_TEST_POSTGRES_IMAGE (upstream's
// repository tests read it too) and CLAUDEX_TEST_REDIS_IMAGE.
const (
	DefaultPostgresImage = "postgres:18-alpine"
	DefaultRedisImage    = "redis:8.4-alpine"
)

// RunID is this run's id, or "" outside go.sh.
func RunID() string { return strings.TrimSpace(os.Getenv(RunIDEnv)) }

// Labels are the labels every Claudex test container gets.
func Labels() map[string]string {
	labels := map[string]string{"claudex.it": "true"}
	if id := RunID(); id != "" {
		labels[RunLabel] = id
	}
	return labels
}

// Customizers puts the run labels in front of a testcontainers module's options.
func Customizers(opts ...testcontainers.ContainerCustomizer) []testcontainers.ContainerCustomizer {
	return append([]testcontainers.ContainerCustomizer{testcontainers.WithLabels(Labels())}, opts...)
}

// Skip reports whether a failed container start should skip the tests:
// outside CI a machine without Docker skips; in CI (go.sh sets CI=true) the
// tests fail instead.
func Skip(err error) bool {
	return err != nil && os.Getenv("CI") == ""
}

func image(env, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(env)); v != "" {
		return v
	}
	return fallback
}

// Postgres is a started PostgreSQL container.
type Postgres struct {
	Container *tcpostgres.PostgresContainer
	DSN       string
}

// StartPostgres starts PostgreSQL with this database, labelled for the run.
func StartPostgres(ctx context.Context, database string) (*Postgres, error) {
	pg, err := tcpostgres.Run(ctx, image("SUB2API_TEST_POSTGRES_IMAGE", DefaultPostgresImage),
		Customizers(
			tcpostgres.WithDatabase(database),
			tcpostgres.WithUsername("postgres"),
			tcpostgres.WithPassword("postgres"),
			tcpostgres.BasicWaitStrategies(),
		)...,
	)
	if err != nil {
		if pg != nil {
			_ = pg.Terminate(ctx)
		}
		return nil, fmt.Errorf("start postgres: %w", err)
	}
	dsn, err := pg.ConnectionString(ctx, "sslmode=disable", "TimeZone=UTC")
	if err != nil {
		_ = pg.Terminate(ctx)
		return nil, fmt.Errorf("postgres dsn: %w", err)
	}
	return &Postgres{Container: pg, DSN: dsn}, nil
}

// Open opens the database and waits up to 30 s for it to answer.
func (p *Postgres) Open(ctx context.Context) (*sql.DB, error) {
	db, err := sql.Open("postgres", p.DSN)
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(30 * time.Second)
	for {
		err = db.PingContext(ctx)
		if err == nil || time.Now().After(deadline) {
			break
		}
		time.Sleep(250 * time.Millisecond)
	}
	if err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("postgres ping: %w", err)
	}
	return db, nil
}

// Terminate stops the container; errors are only logged.
func (p *Postgres) Terminate(ctx context.Context) {
	if p == nil || p.Container == nil {
		return
	}
	if err := p.Container.Terminate(ctx); err != nil {
		log.Printf("testsupport: terminate postgres: %v", err)
	}
}

// Redis is a started Redis container with a connected client.
type Redis struct {
	Container *tcredis.RedisContainer
	Client    *redis.Client
}

// StartRedis starts Redis, labelled for the run, and connects to it.
func StartRedis(ctx context.Context) (*Redis, error) {
	rc, err := tcredis.Run(ctx, image("CLAUDEX_TEST_REDIS_IMAGE", DefaultRedisImage), Customizers()...)
	if err != nil {
		if rc != nil {
			_ = rc.Terminate(ctx)
		}
		return nil, fmt.Errorf("start redis: %w", err)
	}
	uri, err := rc.ConnectionString(ctx)
	if err != nil {
		_ = rc.Terminate(ctx)
		return nil, fmt.Errorf("redis address: %w", err)
	}
	opts, err := redis.ParseURL(uri)
	if err != nil {
		_ = rc.Terminate(ctx)
		return nil, fmt.Errorf("redis address %q: %w", uri, err)
	}
	client := redis.NewClient(opts)
	deadline := time.Now().Add(30 * time.Second)
	for {
		err = client.Ping(ctx).Err()
		if err == nil || time.Now().After(deadline) {
			break
		}
		time.Sleep(250 * time.Millisecond)
	}
	if err != nil {
		_ = client.Close()
		_ = rc.Terminate(ctx)
		return nil, fmt.Errorf("redis ping: %w", err)
	}
	return &Redis{Container: rc, Client: client}, nil
}

// Terminate closes the client and stops the container.
func (r *Redis) Terminate(ctx context.Context) {
	if r == nil {
		return
	}
	if r.Client != nil {
		_ = r.Client.Close()
	}
	if r.Container != nil {
		if err := r.Container.Terminate(ctx); err != nil {
			log.Printf("testsupport: terminate redis: %v", err)
		}
	}
}
