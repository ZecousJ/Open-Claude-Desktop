//go:build integration

package sharing

import (
	"context"
	"database/sql"
	"fmt"
	"io/fs"
	"net/http"
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
		tcpostgres.WithDatabase("claudex_sharing_test"),
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

// sharingMigrations are written to run again safely; claudex_0066 is a plain
// ALTER that the migration runner applies once.
var sharingMigrations = []string{"claudex_0060_sharing.sql", "claudex_0061_share_invites.sql", "claudex_0062_share_report_details.sql", "claudex_0063_artifact_edit_requests.sql", "claudex_0065_artifact_reports.sql", "claudex_0067_code_sharing_settings.sql"}

func applySharingMigration(t *testing.T, db *sql.DB, names ...string) {
	t.Helper()
	for _, name := range names {
		raw, err := fs.ReadFile(migrations.FS, name)
		require.NoError(t, err)
		_, err = db.ExecContext(context.Background(), string(raw))
		require.NoError(t, err)
	}
}

// freshDB creates an empty database with a minimal users table (soft
// delete like upstream) and applies claudex_0060_sharing.sql twice.
func freshDB(t *testing.T) *sql.DB {
	t.Helper()
	pgOnce.Do(startPostgres)
	require.NoError(t, pgErr)
	admin := openDB(t, pgDSN)
	name := fmt.Sprintf("sharing_%d", pgSeq.Add(1))
	_, err := admin.Exec("CREATE DATABASE " + name)
	require.NoError(t, err)
	u, err := url.Parse(pgDSN)
	require.NoError(t, err)
	u.Path = "/" + name
	db := openDB(t, u.String())
	_, err = db.Exec(`CREATE TABLE users (id BIGSERIAL PRIMARY KEY, email VARCHAR(255) NOT NULL DEFAULT '', deleted_at TIMESTAMPTZ NULL)`)
	require.NoError(t, err)
	applySharingMigration(t, db, sharingMigrations...)
	applySharingMigration(t, db, sharingMigrations...) // idempotent
	applySharingMigration(t, db, "claudex_0066_share_invite_roles.sql")
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

var itNow = time.Date(2026, 9, 26, 2, 30, 0, 0, time.UTC)

func upIn(userID int64, source string, now time.Time, max int) upsertInput {
	return upsertInput{UserID: userID, Kind: KindConversation, SourceKey: source, Title: "T " + source,
		Body: []byte(`{"kind":"conversation","title":"T","messages":[{"role":"user","text":"hi"}]}`),
		Now:  now, MaxActive: max, NewToken: newToken}
}

func TestIntegrationStoreShares(t *testing.T) {
	ctx := context.Background()
	db := freshDB(t)
	s := &sqlStore{db: db}

	a, created, err := s.upsert(ctx, upIn(1, "src-a", itNow, 2))
	require.NoError(t, err)
	require.True(t, created)
	require.True(t, ValidToken(a.Token))
	require.Equal(t, StatusActive, a.Status)

	// Same source: the snapshot is refreshed in place.
	in := upIn(1, "src-a", itNow.Add(time.Minute), 2)
	in.Title, in.Body = "Renamed", []byte(`{"kind":"conversation","title":"Renamed","messages":[{"role":"user","text":"again"}]}`)
	again, created, err := s.upsert(ctx, in)
	require.NoError(t, err)
	require.False(t, created)
	require.Equal(t, a.ID, again.ID)
	require.Equal(t, a.Token, again.Token)
	require.Equal(t, "Renamed", again.Title)
	snap, err := s.content(ctx, a.ID)
	require.NoError(t, err)
	require.Equal(t, "again", snap.Messages[0].Text)

	_, _, err = s.upsert(ctx, upIn(1, "src-b", itNow, 2))
	require.NoError(t, err)
	_, _, err = s.upsert(ctx, upIn(1, "src-c", itNow, 2))
	require.ErrorIs(t, err, ErrQuota)
	_, created, err = s.upsert(ctx, upIn(2, "src-a", itNow, 2))
	require.NoError(t, err)
	require.True(t, created, "sources are per user")

	rows, total, err := s.listUser(ctx, 1, "", "", itNow, 1, 10)
	require.NoError(t, err)
	require.EqualValues(t, 2, total)
	require.Len(t, rows, 2)
	rows, _, err = s.listUser(ctx, 1, KindConversation, "src-a", itNow, 1, 10)
	require.NoError(t, err)
	require.Len(t, rows, 1)

	// Update and take-down.
	up, err := s.updateSnapshot(ctx, 1, a.ID, "New", []byte(`{"kind":"conversation","messages":[{"role":"user","text":"u"}]}`), itNow.Add(2*time.Minute))
	require.NoError(t, err)
	require.Equal(t, "New", up.Title)
	_, err = s.updateSnapshot(ctx, 2, a.ID, "x", []byte(`{}`), itNow)
	require.ErrorIs(t, err, ErrShareNotFound)
	dis, err := s.setDisabled(ctx, a.ID, true, "policy", 9, itNow)
	require.NoError(t, err)
	require.Equal(t, StatusDisabled, dis.Status)
	require.Equal(t, "policy", dis.DisabledReason)
	require.EqualValues(t, 9, *dis.DisabledBy)
	_, err = s.updateSnapshot(ctx, 1, a.ID, "x", []byte(`{}`), itNow)
	require.ErrorIs(t, err, ErrShareDisabled)
	_, _, err = s.upsert(ctx, upIn(1, "src-a", itNow, 5))
	require.ErrorIs(t, err, ErrShareDisabled)
	en, err := s.setDisabled(ctx, a.ID, false, "", 9, itNow)
	require.NoError(t, err)
	require.Equal(t, StatusActive, en.Status)
	require.Nil(t, en.DisabledBy)

	// Views and token lookup.
	require.NoError(t, s.countView(ctx, a.ID, itNow))
	byTok, err := s.byToken(ctx, a.Token)
	require.NoError(t, err)
	require.EqualValues(t, 1, byTok.ViewCount)
	require.False(t, byTok.AuthorGone)
	missing, err := s.byToken(ctx, strings.Repeat("a", 43))
	require.NoError(t, err)
	require.Nil(t, missing)

	// Revoke: content gone, token kept and never reused, the slot is free.
	done, err := s.revoke(ctx, 2, a.ID, itNow)
	require.NoError(t, err)
	require.False(t, done, "not the owner")
	done, err = s.revoke(ctx, 1, a.ID, itNow)
	require.NoError(t, err)
	require.True(t, done)
	done, err = s.revoke(ctx, 1, a.ID, itNow)
	require.NoError(t, err)
	require.False(t, done)
	require.Zero(t, count(t, db, `SELECT COUNT(*) FROM claudex_share_contents WHERE share_id = $1`, a.ID))
	byTok, err = s.byToken(ctx, a.Token)
	require.NoError(t, err)
	require.Equal(t, StatusRevoked, byTok.Status)
	fresh, created, err := s.upsert(ctx, upIn(1, "src-a", itNow, 5))
	require.NoError(t, err)
	require.True(t, created)
	require.NotEqual(t, a.Token, fresh.Token)
	live, err := s.getLive(ctx, 0, a.ID)
	require.NoError(t, err)
	require.Nil(t, live)

	// Admin list: title search with LIKE characters escaped, open reports.
	_, err = db.Exec(`UPDATE claudex_shares SET title = '100% done_x' WHERE id = $1`, fresh.ID)
	require.NoError(t, err)
	ok, err := s.insertReport(ctx, fresh.ID, reportInput{Reason: "spam", Detail: "d"}, "h1", itNow)
	require.NoError(t, err)
	require.True(t, ok)
	ok, err = s.insertReport(ctx, fresh.ID, reportInput{Reason: "harmful"}, "h1", itNow)
	require.NoError(t, err)
	require.False(t, ok, "one report per visitor hash")
	reporter := int64(7)
	_, err = s.insertReport(ctx, fresh.ID, reportInput{Reason: "other", Category: "violation_of_terms", ReporterName: "Ann",
		ReporterEmail: "ann@example.com", ReporterUserID: &reporter, OptOutOfTraining: true}, "h2", itNow.Add(time.Second))
	require.NoError(t, err)
	list, total, err := s.adminList(ctx, adminFilter{Query: "100%", Page: 1, Size: 10})
	require.NoError(t, err)
	require.EqualValues(t, 1, total)
	require.EqualValues(t, 2, list[0].OpenReports)
	list, _, err = s.adminList(ctx, adminFilter{Query: "1_0", Page: 1, Size: 10})
	require.NoError(t, err)
	require.Empty(t, list, "_ is literal")
	list, _, err = s.adminList(ctx, adminFilter{Status: StatusRevoked, Page: 1, Size: 10})
	require.NoError(t, err)
	require.Len(t, list, 1)
	list, total, err = s.adminList(ctx, adminFilter{UserID: 2, Kind: KindConversation, Page: 1, Size: 10})
	require.NoError(t, err)
	require.EqualValues(t, 1, total)

	reports, total, err := s.listReports(ctx, reportFilter{Status: reportOpen, Page: 1, Size: 10})
	require.NoError(t, err)
	require.EqualValues(t, 2, total)
	require.Equal(t, "other", reports[0].Reason, "newest first")
	require.Equal(t, fresh.Token, reports[0].shareToken)
	require.Equal(t, "violation_of_terms", reports[0].Category)
	require.Equal(t, "Ann", reports[0].ReporterName)
	require.Equal(t, "ann@example.com", reports[0].ReporterEmail)
	require.EqualValues(t, 7, *reports[0].ReporterUserID)
	require.True(t, reports[0].OptOutOfTraining)
	require.False(t, reports[1].OptOutOfTraining, "off unless the reporter switched it on")
	require.Nil(t, reports[1].ReporterUserID)
	rep, err := s.resolveReport(ctx, reports[1].ID, reportResolved, true, 9, itNow)
	require.NoError(t, err)
	require.Equal(t, reportResolved, rep.Status)
	require.EqualValues(t, 9, *rep.ResolvedBy)
	require.Zero(t, count(t, db, `SELECT COUNT(*) FROM claudex_share_reports WHERE status = 'open'`))
	rep, err = s.resolveReport(ctx, 999, reportDismissed, false, 9, itNow)
	require.NoError(t, err)
	require.Nil(t, rep)

	n, err := s.disableAllOf(ctx, 1, "abuse", 9, itNow)
	require.NoError(t, err)
	require.EqualValues(t, 2, n)
}

func TestIntegrationStoreConcurrentQuota(t *testing.T) {
	ctx := context.Background()
	db := freshDB(t)
	s := &sqlStore{db: db}
	var wg sync.WaitGroup
	errs := make(chan error, 10)
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, _, err := s.upsert(ctx, upIn(3, fmt.Sprintf("s%d", i), itNow, 4))
			errs <- err
		}(i)
	}
	wg.Wait()
	close(errs)
	ok, quota := 0, 0
	for err := range errs {
		switch {
		case err == nil:
			ok++
		case strings.Contains(err.Error(), "CLAUDEX_SHARE_QUOTA"):
			quota++
		default:
			t.Fatalf("unexpected error: %v", err)
		}
	}
	require.Equal(t, 4, ok)
	require.Equal(t, 6, quota)

	// Concurrent shares of one source end with one live row.
	var wg2 sync.WaitGroup
	errs2 := make(chan error, 5)
	for i := 0; i < 5; i++ {
		wg2.Add(1)
		go func() {
			defer wg2.Done()
			_, _, err := s.upsert(ctx, upIn(4, "same", itNow, 10))
			errs2 <- err
		}()
	}
	wg2.Wait()
	close(errs2)
	for err := range errs2 {
		require.NoError(t, err)
	}
	require.Equal(t, 1, count(t, db, `SELECT COUNT(*) FROM claudex_shares WHERE user_id = 4`))
}

func TestIntegrationCleanupAndUsers(t *testing.T) {
	ctx := context.Background()
	db := freshDB(t)
	s := &sqlStore{db: db}

	exp := itNow.Add(time.Hour)
	in := upIn(5, "e", itNow, 10)
	in.ExpiresAt = &exp
	e, _, err := s.upsert(ctx, in)
	require.NoError(t, err)
	keep, _, err := s.upsert(ctx, upIn(5, "k", itNow, 10))
	require.NoError(t, err)

	// An expired share is retired when its source is shared again.
	in2 := upIn(5, "e", itNow.Add(2*time.Hour), 10)
	e2, created, err := s.upsert(ctx, in2)
	require.NoError(t, err)
	require.True(t, created)
	require.NotEqual(t, e.ID, e2.ID)

	in3 := upIn(5, "e3", itNow, 10)
	in3.ExpiresAt = &exp
	e3, _, err := s.upsert(ctx, in3)
	require.NoError(t, err)
	n, err := s.purgeExpired(ctx, itNow.Add(30*time.Minute), 10)
	require.NoError(t, err)
	require.Zero(t, n)
	n, err = s.purgeExpired(ctx, itNow.Add(2*time.Hour), 10)
	require.NoError(t, err)
	require.EqualValues(t, 1, n)
	gone, err := s.getLive(ctx, 0, e3.ID)
	require.NoError(t, err)
	require.Nil(t, gone)

	// Soft-deleted author: the page lookup says so, cleanup revokes.
	_, err = db.Exec(`UPDATE users SET deleted_at = NOW() WHERE id = 5`)
	require.NoError(t, err)
	row, err := s.byToken(ctx, keep.Token)
	require.NoError(t, err)
	require.True(t, row.AuthorGone)
	n, err = s.purgeDeletedAuthors(ctx, itNow, 1)
	require.NoError(t, err)
	require.EqualValues(t, 1, n, "batches are respected")
	n, err = s.purgeDeletedAuthors(ctx, itNow, 10)
	require.NoError(t, err)
	require.EqualValues(t, 1, n)
	require.Zero(t, count(t, db, `SELECT COUNT(*) FROM claudex_shares WHERE user_id = 5 AND status <> 'revoked'`))
	require.Zero(t, count(t, db, `SELECT COUNT(*) FROM claudex_share_contents c JOIN claudex_shares s ON s.id = c.share_id WHERE s.user_id = 5`))

	// Blocks need a live user; a hard-deleted user takes rows with it.
	b, found, err := s.putBlock(ctx, 5, "x", 9, itNow)
	require.NoError(t, err)
	require.False(t, found)
	require.Nil(t, b)
	b, found, err = s.putBlock(ctx, 6, "spam", 9, itNow)
	require.NoError(t, err)
	require.True(t, found)
	require.Equal(t, "spam", b.Reason)
	b, _, err = s.putBlock(ctx, 6, "again", 8, itNow.Add(time.Hour))
	require.NoError(t, err)
	require.Equal(t, "again", b.Reason)
	require.EqualValues(t, 9, *b.CreatedBy, "the first blocker is kept")
	blocked, err := s.isBlocked(ctx, 6)
	require.NoError(t, err)
	require.True(t, blocked)
	blocks, total, err := s.listBlocks(ctx, 1, 10)
	require.NoError(t, err)
	require.EqualValues(t, 1, total)
	require.Len(t, blocks, 1)
	_, _, err = s.upsert(ctx, upIn(6, "z", itNow, 10))
	require.NoError(t, err)
	_, err = db.Exec(`DELETE FROM users WHERE id = 6`)
	require.NoError(t, err)
	require.Zero(t, count(t, db, `SELECT COUNT(*) FROM claudex_shares WHERE user_id = 6`))
	require.Zero(t, count(t, db, `SELECT COUNT(*) FROM claudex_share_user_blocks WHERE user_id = 6`))
	done, err := s.deleteBlock(ctx, 6)
	require.NoError(t, err)
	require.False(t, done)
}

// TestIntegrationHTTP runs the handlers on the real store end to end.
func TestIntegrationHTTP(t *testing.T) {
	db := freshDB(t)
	f := newFixture(t, fixtureOptions{db: db})
	f.userID = 7
	f.enable(func(s *Settings) { s.PublicBaseURL = "https://share.example.com" })
	dto := f.create("conv")
	require.Equal(t, "https://share.example.com"+dto.Path, dto.URL)
	w := f.serve(http.MethodGet, dto.Path, "")
	require.Equal(t, http.StatusOK, w.Code)
	require.Contains(t, w.Body.String(), "Make a page")
	require.Equal(t, http.StatusOK, f.serveForm(dto.Path+"/report", "reason=privacy&detail=my+address"))
	var reports paged[Report]
	f.do(http.MethodGet, "/api/v1/admin/claudex/sharing/reports", "").into(t, &reports)
	require.Len(t, reports.Items, 1)
	require.Equal(t, "my address", reports.Items[0].Detail)
	require.Equal(t, "https://share.example.com"+dto.Path, reports.Items[0].ShareURL)
	require.Equal(t, http.StatusOK, f.do(http.MethodDelete, "/api/v1/claudex/shares/"+itoa64(dto.ID), "").Status)
	require.Equal(t, http.StatusNotFound, f.serve(http.MethodGet, dto.Path, "").Code)
}

func TestIntegrationStoreInvites(t *testing.T) {
	ctx := context.Background()
	db := freshDB(t)
	s := &sqlStore{db: db}

	in := upIn(1, "src-inv", itNow, 5)
	in.InvitedOnly = true
	a, created, err := s.upsert(ctx, in)
	require.NoError(t, err)
	require.True(t, created)
	require.True(t, a.InvitedOnly)
	// A refresh keeps the access it was made with.
	again, _, err := s.upsert(ctx, upIn(1, "src-inv", itNow.Add(time.Minute), 5))
	require.NoError(t, err)
	require.True(t, again.InvitedOnly)

	added, err := s.addInvite(ctx, a.ID, "user2@example.com", itNow)
	require.NoError(t, err)
	require.True(t, added)
	added, err = s.addInvite(ctx, a.ID, "user2@example.com", itNow)
	require.NoError(t, err)
	require.False(t, added, "the same address is one invite")
	_, err = s.addInvite(ctx, a.ID, "outside@example.org", itNow.Add(time.Second))
	require.NoError(t, err)
	list, err := s.invites(ctx, a.ID)
	require.NoError(t, err)
	require.Equal(t, []string{"user2@example.com", "outside@example.org"}, list)

	ok, err := s.invited(ctx, a.ID, "user2@example.com")
	require.NoError(t, err)
	require.True(t, ok)
	ok, err = s.invited(ctx, a.ID, "user3@example.com")
	require.NoError(t, err)
	require.False(t, ok)

	shared, err := s.sharedWith(ctx, "user2@example.com", itNow)
	require.NoError(t, err)
	require.Len(t, shared, 1)
	require.Equal(t, "user1@example.com", shared[0].OwnerEmail)
	require.Equal(t, a.Token, shared[0].Token)

	// The owner may switch access; nobody else can.
	other, err := s.setInvitedOnly(ctx, 2, a.ID, false, itNow)
	require.NoError(t, err)
	require.Nil(t, other)
	pub, err := s.setInvitedOnly(ctx, 1, a.ID, false, itNow)
	require.NoError(t, err)
	require.False(t, pub.InvitedOnly)

	removed, err := s.removeInvite(ctx, a.ID, "user2@example.com")
	require.NoError(t, err)
	require.True(t, removed)
	shared, err = s.sharedWith(ctx, "user2@example.com", itNow)
	require.NoError(t, err)
	require.Empty(t, shared)

	// A revoked share is gone from the invitee's list, and its invites with it.
	_, err = s.addInvite(ctx, a.ID, "user2@example.com", itNow)
	require.NoError(t, err)
	done, err := s.revoke(ctx, 1, a.ID, itNow)
	require.NoError(t, err)
	require.True(t, done)
	shared, err = s.sharedWith(ctx, "user2@example.com", itNow)
	require.NoError(t, err)
	require.Empty(t, shared)
}
