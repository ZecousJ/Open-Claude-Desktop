//go:build integration

package announce

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
		tcpostgres.WithDatabase("claudex_announce_test"),
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
	name := fmt.Sprintf("announce_%d", pgSeq.Add(1))
	_, err := admin.Exec("CREATE DATABASE " + name)
	require.NoError(t, err)
	u, err := url.Parse(pgDSN)
	require.NoError(t, err)
	u.Path = "/" + name
	db := openDB(t, u.String())
	for i := 0; i < 2; i++ { // idempotent
		raw, err := fs.ReadFile(migrations.FS, "claudex_0110_announcements.sql")
		require.NoError(t, err)
		_, err = db.Exec(string(raw))
		require.NoError(t, err)
	}
	return db
}

func TestIntegrationAnnouncements(t *testing.T) {
	ctx := context.Background()
	s := &sqlStore{db: freshDB(t)}
	now := time.Date(2026, 9, 30, 8, 0, 0, 0, time.UTC)
	content := Content{Title: "Hello", Badge: "New", BodyHTML: "<p>Hi</p>", BodyFormat: "html", PrimaryLabel: "Go", PrimaryURL: "https://example.com"}

	a, err := s.create(ctx, content, 7, now)
	require.NoError(t, err)
	require.Equal(t, StatusDraft, a.Status)
	require.Equal(t, "html", a.BodyFormat)
	pending, err := s.pending(ctx, 1, now)
	require.NoError(t, err)
	require.Empty(t, pending, "a draft is not shown")

	a, err = s.publish(ctx, a.ID, now, now.Add(7*24*time.Hour))
	require.NoError(t, err)
	require.Equal(t, StatusPublished, a.Status)
	b, err := s.create(ctx, Content{Title: "Second", BodyFormat: "text"}, 7, now)
	require.NoError(t, err)
	_, err = s.publish(ctx, b.ID, now.Add(time.Minute), now.Add(2*time.Hour))
	require.NoError(t, err)

	pending, err = s.pending(ctx, 1, now.Add(time.Minute))
	require.NoError(t, err)
	require.Len(t, pending, 2)
	require.Equal(t, "Hello", pending[0].Title, "oldest first")

	// A close is final for that user, once; a second close is harmless.
	ok, err := s.markRead(ctx, a.ID, 1, "primary", now.Add(time.Minute))
	require.NoError(t, err)
	require.True(t, ok)
	ok, err = s.markRead(ctx, a.ID, 1, "close", now.Add(2*time.Minute))
	require.NoError(t, err)
	require.True(t, ok)
	pending, _ = s.pending(ctx, 1, now.Add(time.Minute))
	require.Len(t, pending, 1)
	require.Equal(t, "Second", pending[0].Title)
	pending, _ = s.pending(ctx, 2, now.Add(time.Minute))
	require.Len(t, pending, 2)

	got, err := s.get(ctx, a.ID)
	require.NoError(t, err)
	require.EqualValues(t, 1, got.Reads)
	var action string
	require.NoError(t, s.db.QueryRow(`SELECT action FROM claudex_announcement_reads WHERE announcement_id=$1 AND user_id=1`, a.ID).Scan(&action))
	require.Equal(t, "primary", action, "the first close is the one kept")

	// The second expires after two hours: gone for everyone, and closing it records nothing.
	later := now.Add(3 * time.Hour)
	pending, _ = s.pending(ctx, 2, later)
	require.Len(t, pending, 1)
	ok, err = s.markRead(ctx, b.ID, 2, "close", later)
	require.NoError(t, err)
	require.False(t, ok)

	// Editing with reset shows it again to everyone.
	edited := content
	edited.Title = "Hello again"
	u, err := s.update(ctx, a.ID, edited, true, later)
	require.NoError(t, err)
	require.Equal(t, "Hello again", u.Title)
	pending, _ = s.pending(ctx, 1, later)
	require.Len(t, pending, 1)

	// Withdrawn: shown to nobody; the list counts reads.
	_, err = s.withdraw(ctx, a.ID, later)
	require.NoError(t, err)
	pending, _ = s.pending(ctx, 1, later)
	require.Empty(t, pending)
	list, err := s.list(ctx)
	require.NoError(t, err)
	require.Len(t, list, 2)

	// Deleting removes its reads with it.
	gone, err := s.remove(ctx, a.ID)
	require.NoError(t, err)
	require.True(t, gone)
	var reads int
	require.NoError(t, s.db.QueryRow(`SELECT COUNT(*) FROM claudex_announcement_reads`).Scan(&reads))
	require.Zero(t, reads)
	gone, _ = s.remove(ctx, a.ID)
	require.False(t, gone)

	// Mail sends keep their message and progress.
	id, err := s.createMail(ctx, "Subject", "<p>x</p>", 3, 7, now)
	require.NoError(t, err)
	require.NoError(t, s.mailProgress(ctx, id, 2, 1, true, later))
	mails, err := s.listMails(ctx, 10)
	require.NoError(t, err)
	require.Len(t, mails, 1)
	require.Equal(t, "done", mails[0].Status)
	require.Equal(t, 2, mails[0].Sent)
	require.Equal(t, 1, mails[0].Failed)
	require.NotNil(t, mails[0].FinishedAt)
}
