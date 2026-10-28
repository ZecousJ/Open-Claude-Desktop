//go:build integration

package status

import (
	"context"
	"database/sql"
	"fmt"
	"io/fs"
	"net/url"
	"os"
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
		tcpostgres.WithDatabase("claudex_status_test"),
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

func freshDB(t *testing.T) *sql.DB {
	t.Helper()
	pgOnce.Do(startPostgres)
	require.NoError(t, pgErr)
	admin := openDB(t, pgDSN)
	name := fmt.Sprintf("status_%d", pgSeq.Add(1))
	_, err := admin.Exec("CREATE DATABASE " + name)
	require.NoError(t, err)
	u, err := url.Parse(pgDSN)
	require.NoError(t, err)
	u.Path = "/" + name
	db := openDB(t, u.String())
	// The two Sub2API tables the component reads, as far as it reads them.
	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS channel_monitors (id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL,
		provider TEXT NOT NULL, primary_model TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT TRUE);
		CREATE TABLE channel_monitor_histories (id BIGSERIAL PRIMARY KEY, monitor_id BIGINT NOT NULL,
		model VARCHAR(200) NOT NULL, status VARCHAR(20) NOT NULL, checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
	require.NoError(t, err)
	for i := 0; i < 2; i++ { // idempotent
		for _, name := range []string{"claudex_0120_service_status.sql", "claudex_0121_status_incident_published.sql", "claudex_0122_status_incident_channel.sql"} {
			raw, err := fs.ReadFile(migrations.FS, name)
			require.NoError(t, err)
			_, err = db.Exec(string(raw))
			require.NoError(t, err)
		}
	}
	return db
}

func TestIntegrationServiceStatus(t *testing.T) {
	ctx := context.Background()
	db := freshDB(t)
	s := &sqlStore{db: db}
	loc, _ := time.LoadLocation(Timezone)
	// 10:00 in Shanghai on Sep 30.
	now := time.Date(2026, 9, 30, 10, 0, 0, 0, loc)
	_, err := db.Exec(`INSERT INTO channel_monitors (name, provider, primary_model, enabled) VALUES
		('codex','openai','gpt-6-sol',TRUE), ('grok','grok','grok-4.6',TRUE), ('off','openai','x',FALSE)`)
	require.NoError(t, err)
	check := func(monitor int64, model, status string, at time.Time) {
		_, err := db.Exec(`INSERT INTO channel_monitor_histories (monitor_id, model, status, checked_at) VALUES ($1,$2,$3,$4)`,
			monitor, model, status, at)
		require.NoError(t, err)
	}
	// Sep 29 (Shanghai): 3 checks, one failed; 23:30 UTC Sep 28 is Sep 29 07:30 in Shanghai.
	check(1, "gpt-6-sol", "operational", time.Date(2026, 9, 28, 23, 30, 0, 0, time.UTC))
	check(1, "gpt-6-sol", "degraded", time.Date(2026, 9, 29, 10, 0, 0, 0, loc))
	check(1, "gpt-6-sol", "error", time.Date(2026, 9, 29, 11, 0, 0, 0, loc))
	// Today: failing twice in a row now.
	check(1, "gpt-6-sol", "failed", now.Add(-10*time.Minute))
	check(1, "gpt-6-sol", "error", now.Add(-5*time.Minute))
	check(2, "grok-4.6", "operational", now.Add(-5*time.Minute))
	check(2, "grok-4.6", "operational", now.Add(-10*time.Minute))

	require.NoError(t, s.refresh(ctx, now.AddDate(0, 0, -35), Timezone, true))
	require.NoError(t, s.refresh(ctx, time.Date(2026, 9, 29, 0, 0, 0, 0, loc), Timezone, false))
	counts, err := s.counts(ctx, time.Date(2026, 9, 29, 0, 0, 0, 0, loc), time.Date(2026, 9, 30, 0, 0, 0, 0, loc))
	require.NoError(t, err)
	byDay := map[string]DayCounts{}
	for _, x := range counts {
		byDay[fmt.Sprintf("%d %s", x.MonitorID, x.Day.Format("2006-01-02"))] = x
	}
	require.Equal(t, 3, byDay["1 2026-09-29"].Total)
	require.Equal(t, 1, byDay["1 2026-09-29"].Degraded)
	require.Equal(t, 1, byDay["1 2026-09-29"].Failed)
	require.Equal(t, 2, byDay["1 2026-09-30"].Failed)

	// Sub2API forgets old checks: an existing day is kept by a backfill.
	_, err = db.Exec(`DELETE FROM channel_monitor_histories WHERE checked_at < $1`, time.Date(2026, 9, 29, 10, 30, 0, 0, loc))
	require.NoError(t, err)
	require.NoError(t, s.refresh(ctx, now.AddDate(0, 0, -35), Timezone, true))
	counts, _ = s.counts(ctx, time.Date(2026, 9, 29, 0, 0, 0, 0, loc), time.Date(2026, 9, 29, 0, 0, 0, 0, loc))
	require.Equal(t, 3, counts[0].Total)

	channels, err := s.channels(ctx, now.AddDate(0, 0, -90))
	require.NoError(t, err)
	require.Equal(t, []Channel{{1, "codex", "openai", "gpt-6-sol"}, {2, "grok", "grok", "grok-4.6"}}, channels)
	hours, err := s.slots(ctx, now.Add(-2*time.Hour), now.Add(time.Hour), Timezone, 60)
	require.NoError(t, err)
	byHour := map[string]int{}
	for _, h := range hours {
		byHour[fmt.Sprintf("%d %s", h.MonitorID, h.Day.In(loc).Format("15"))] += h.Total
	}
	require.Equal(t, 2, byHour["1 09"], "the two checks between 09:50 and 09:55")
	require.Equal(t, 2, byHour["2 09"])
	tens, err := s.slots(ctx, now.Add(-2*time.Hour), now.Add(time.Hour), Timezone, 10)
	require.NoError(t, err)
	byTen := map[string]int{}
	for _, c := range tens {
		byTen[fmt.Sprintf("%d %s", c.MonitorID, c.Day.In(loc).Format("15:04"))] += c.Total
	}
	require.Equal(t, 2, byTen["1 09:50"], "both checks fall in 09:50-10:00")
	latest, err := s.latest(ctx, now.Add(-24*time.Hour))
	require.NoError(t, err)
	require.Equal(t, []string{"error", "failed", "error"}, latest[key{1, "gpt-6-sol"}])

	// The component opens an incident for OpenAI, once.
	comp := &Component{store: s, loc: loc, env: nil}
	require.NoError(t, syncAt(ctx, comp, now))
	require.NoError(t, syncAt(ctx, comp, now.Add(time.Minute)))
	list, err := s.incidents(ctx, now.AddDate(0, 0, -1), 10, false)
	require.NoError(t, err)
	require.Len(t, list, 1)
	require.True(t, list[0].Auto)
	require.False(t, list[0].Published, "people see it once an administrator publishes it")
	seen, err := s.incidents(ctx, now.AddDate(0, 0, -1), 10, true)
	require.NoError(t, err)
	require.Empty(t, seen)
	yes := true
	published, err := s.update(ctx, list[0].ID, IncidentInput{Platform: "-", Published: &yes}, 7, now)
	require.NoError(t, err)
	require.True(t, published.Published)
	require.Len(t, published.Updates, 1, "publishing posts no update")
	seen, _ = s.incidents(ctx, now.AddDate(0, 0, -1), 10, true)
	require.Len(t, seen, 1)
	require.Equal(t, "codex", list[0].Platform, "the channel's name")
	require.Equal(t, StatusInvestigating, list[0].Status)
	require.Contains(t, list[0].Message, "codex")
	require.False(t, list[0].touched)

	// Healthy again: resolved on its own.
	check(1, "gpt-6-sol", "operational", now.Add(time.Minute))
	check(1, "gpt-6-sol", "operational", now.Add(2*time.Minute))
	require.NoError(t, syncAt(ctx, comp, now.Add(3*time.Minute)))
	inc, err := s.incident(ctx, list[0].ID)
	require.NoError(t, err)
	require.Equal(t, StatusResolved, inc.Status)
	require.NotNil(t, inc.ResolvedAt)
	require.Len(t, inc.Updates, 2)
	require.Equal(t, StatusResolved, inc.Updates[0].Status, "newest first")

	// An administrator's incident and its updates.
	mine, err := s.create(ctx, IncidentInput{Title: "Slow replies", Platform: "grok", Impact: ImpactDegraded,
		Status: StatusInvestigating, Message: "Looking into it."}, false, 7, now)
	require.NoError(t, err)
	require.True(t, mine.Published, "an administrator's incident is published unless they say otherwise")
	mine, err = s.update(ctx, mine.ID, IncidentInput{Platform: "-", Status: StatusIdentified, Message: "Found it."}, 7, now.Add(time.Hour))
	require.NoError(t, err)
	require.Equal(t, StatusIdentified, mine.Status)
	require.Equal(t, "Found it.", mine.Message)
	require.True(t, mine.touched)
	mine, err = s.update(ctx, mine.ID, IncidentInput{Title: "Slow xAI replies", Platform: "-"}, 7, now.Add(2*time.Hour))
	require.NoError(t, err)
	require.Equal(t, "Slow xAI replies", mine.Title)
	require.Equal(t, "grok", mine.Platform)
	require.Len(t, mine.Updates, 2, "an edit without status or message adds no update")
	mine, err = s.update(ctx, mine.ID, IncidentInput{Platform: "-", Status: StatusResolved, Message: "Fixed."}, 7, now.Add(3*time.Hour))
	require.NoError(t, err)
	require.NotNil(t, mine.ResolvedAt)
	mine, err = s.update(ctx, mine.ID, IncidentInput{Platform: "-", Status: StatusMonitoring}, 7, now.Add(4*time.Hour))
	require.NoError(t, err)
	require.Nil(t, mine.ResolvedAt, "reopened")
	missing, err := s.update(ctx, 999, IncidentInput{Platform: "-", Status: StatusResolved}, 7, now)
	require.NoError(t, err)
	require.Nil(t, missing)
	ok, err := s.remove(ctx, mine.ID)
	require.NoError(t, err)
	require.True(t, ok)
	require.NoError(t, s.prune(ctx, now))
}

// syncAt runs SyncIncidents with the component's clock at `at`.
func syncAt(ctx context.Context, c *Component, at time.Time) error {
	c.clock = func() time.Time { return at }
	return c.SyncIncidents(ctx)
}
