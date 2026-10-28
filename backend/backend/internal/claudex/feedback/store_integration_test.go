//go:build integration

package feedback

import (
	"context"
	"database/sql"
	"encoding/json"
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

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"
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
		tcpostgres.WithDatabase("claudex_feedback_test"),
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

func applyFeedbackMigration(t *testing.T, db *sql.DB) {
	t.Helper()
	raw, err := fs.ReadFile(migrations.FS, "claudex_0040_feedback.sql")
	require.NoError(t, err)
	_, err = db.ExecContext(context.Background(), string(raw))
	require.NoError(t, err)
	raw, err = fs.ReadFile(migrations.FS, "claudex_0163_feedback_withdrawals.sql")
	require.NoError(t, err)
	_, err = db.ExecContext(context.Background(), string(raw))
	require.NoError(t, err)
}

// freshDB creates an empty database with a minimal users table (and
// claudex_devices when withDevices, standing in for B4's migration), then
// applies claudex_0040_feedback.sql from the embedded migrations.
func freshDB(t *testing.T, withDevices bool) *sql.DB {
	t.Helper()
	pgOnce.Do(startPostgres)
	require.NoError(t, pgErr)
	admin := openDB(t, pgDSN)
	name := fmt.Sprintf("feedback_%d", pgSeq.Add(1))
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
	applyFeedbackMigration(t, db)
	_, err = db.Exec(`INSERT INTO users (email) SELECT 'user' || g || '@example.com' FROM generate_series(1, 5) AS g`)
	require.NoError(t, err)
	return db
}

func count(t *testing.T, db *sql.DB, query string, args ...any) int {
	t.Helper()
	var n int
	require.NoError(t, db.QueryRow(query, args...).Scan(&n))
	return n
}

func uuidN(prefix string, i int) string { return fmt.Sprintf("%s-0000-4000-8000-%012d", prefix, i) }

func TestIntegrationMigration(t *testing.T) {
	// Without claudex_devices (B4 not merged yet) the migration still applies,
	// and applying it again changes nothing.
	db := freshDB(t, false)
	applyFeedbackMigration(t, db)
	require.Zero(t, count(t, db, `SELECT COUNT(*) FROM pg_constraint WHERE conname = 'fk_claudex_diagnostics_device'`))

	// With claudex_devices (B4's migration runs first) the device link is a
	// foreign key that clears itself when the device row goes away.
	db = freshDB(t, true)
	applyFeedbackMigration(t, db)
	require.Equal(t, 1, count(t, db, `SELECT COUNT(*) FROM pg_constraint WHERE conname = 'fk_claudex_diagnostics_device'`))
	_, err := db.Exec(`INSERT INTO claudex_devices (id, user_id) VALUES (51, 1)`)
	require.NoError(t, err)
	s := &sqlStore{db: db}
	dev := int64(51)
	res, err := s.insertDiagnostics(context.Background(), 1, []diagnosticRow{{ReportUUID: uuidN("8a0f0000", 1), DeviceID: &dev, Kind: "crash", OccurredAt: time.Now()}}, 10)
	require.NoError(t, err)
	require.Equal(t, 1, res.Accepted)
	missing := int64(52)
	_, err = s.insertDiagnostics(context.Background(), 1, []diagnosticRow{{ReportUUID: uuidN("8a0f0000", 2), DeviceID: &missing, Kind: "crash", OccurredAt: time.Now()}}, 10)
	require.Error(t, err, "an unknown device id violates the foreign key")
	_, err = db.Exec(`DELETE FROM claudex_devices WHERE id = 51`)
	require.NoError(t, err)
	require.Equal(t, 1, count(t, db, `SELECT COUNT(*) FROM claudex_diagnostics WHERE device_id IS NULL`))

	// Rows go with their user; ratings are checked by the table.
	_, err = s.insertFeedback(context.Background(), 1, feedbackRow{FeedbackUUID: uuidN("c1d20000", 1), Rating: "up"}, 10)
	require.NoError(t, err)
	_, err = db.Exec(`INSERT INTO claudex_feedback (feedback_uuid, user_id, rating) VALUES (gen_random_uuid(), 1, 'meh')`)
	require.Error(t, err)
	_, err = db.Exec(`DELETE FROM users WHERE id = 1`)
	require.NoError(t, err)
	require.Zero(t, count(t, db, `SELECT COUNT(*) FROM claudex_diagnostics`))
	require.Zero(t, count(t, db, `SELECT COUNT(*) FROM claudex_feedback`))
}

func TestIntegrationIdempotencyAndDailyCaps(t *testing.T) {
	db := freshDB(t, false)
	s := &sqlStore{db: db}
	ctx := context.Background()
	row := func(i int) diagnosticRow {
		return diagnosticRow{ReportUUID: uuidN("8a0f0000", i), Kind: "turn_error", Code: "E", Message: "m",
			Context: map[string]any{"surface": "code", "http_status": json.Number("429")}, OccurredAt: time.Now()}
	}

	res, err := s.insertDiagnostics(ctx, 1, []diagnosticRow{row(1), row(2), row(1)}, 3)
	require.NoError(t, err)
	require.Equal(t, insertResult{Accepted: 2, Duplicates: 1}, res)
	res, err = s.insertDiagnostics(ctx, 1, []diagnosticRow{row(3), row(4), row(5)}, 3)
	require.NoError(t, err)
	require.Equal(t, 1, res.Accepted)
	require.Equal(t, 2, res.Dropped)
	require.Greater(t, res.RetryAfter, 23*time.Hour)
	require.LessOrEqual(t, res.RetryAfter, 24*time.Hour)
	// At the cap, a retry of stored reports is still recognised as a duplicate.
	res, err = s.insertDiagnostics(ctx, 1, []diagnosticRow{row(1), row(9)}, 3)
	require.NoError(t, err)
	require.Equal(t, 0, res.Accepted)
	require.Equal(t, 1, res.Duplicates)
	require.Equal(t, 1, res.Dropped)
	// Report ids and caps are per user.
	res, err = s.insertDiagnostics(ctx, 2, []diagnosticRow{row(1)}, 3)
	require.NoError(t, err)
	require.Equal(t, 1, res.Accepted)
	require.Equal(t, 3, count(t, db, `SELECT COUNT(*) FROM claudex_diagnostics WHERE user_id = 1`))
	// Rows older than 24 hours no longer count.
	_, err = db.Exec(`UPDATE claudex_diagnostics SET created_at = NOW() - INTERVAL '25 hours' WHERE user_id = 1`)
	require.NoError(t, err)
	res, err = s.insertDiagnostics(ctx, 1, []diagnosticRow{row(6)}, 3)
	require.NoError(t, err)
	require.Equal(t, 1, res.Accepted)
	var ctxText string
	require.NoError(t, db.QueryRow(`SELECT context::text FROM claudex_diagnostics WHERE report_uuid = $1::uuid AND user_id = 1`, uuidN("8a0f0000", 6)).Scan(&ctxText))
	require.JSONEq(t, `{"surface":"code","http_status":429}`, ctxText)

	fb := func(i int) feedbackRow {
		return feedbackRow{FeedbackUUID: uuidN("c1d20000", i), Rating: "down", Categories: []string{"inaccurate"}}
	}
	res, err = s.insertFeedback(ctx, 1, fb(1), 1)
	require.NoError(t, err)
	require.Equal(t, insertResult{Accepted: 1}, res)
	res, err = s.insertFeedback(ctx, 1, fb(1), 1)
	require.NoError(t, err)
	require.Equal(t, insertResult{Duplicates: 1}, res)
	res, err = s.insertFeedback(ctx, 1, fb(2), 1)
	require.NoError(t, err)
	require.Equal(t, 1, res.Dropped)
	require.Greater(t, res.RetryAfter, 23*time.Hour)
	require.Equal(t, 1, count(t, db, `SELECT COUNT(*) FROM claudex_feedback`))
}

// Concurrent batches of one user never overshoot the cap.
func TestIntegrationConcurrentCaps(t *testing.T) {
	db := freshDB(t, false)
	s := &sqlStore{db: db}
	var wg sync.WaitGroup
	var accepted, dropped, fbAccepted, fbDropped atomic.Int64
	start := make(chan struct{})
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			res, err := s.insertDiagnostics(context.Background(), 3,
				[]diagnosticRow{{ReportUUID: uuidN("8a0f0000", i), Kind: "crash", OccurredAt: time.Now()}}, 5)
			if err == nil {
				accepted.Add(int64(res.Accepted))
				dropped.Add(int64(res.Dropped))
			} else {
				t.Error(err)
			}
			res, err = s.insertFeedback(context.Background(), 3, feedbackRow{FeedbackUUID: uuidN("c1d20000", i), Rating: "up"}, 5)
			if err == nil {
				fbAccepted.Add(int64(res.Accepted))
				fbDropped.Add(int64(res.Dropped))
			} else {
				t.Error(err)
			}
		}(i)
	}
	close(start)
	wg.Wait()
	require.Equal(t, int64(5), accepted.Load())
	require.Equal(t, int64(7), dropped.Load())
	require.Equal(t, int64(5), fbAccepted.Load())
	require.Equal(t, int64(7), fbDropped.Load())
	require.Equal(t, 5, count(t, db, `SELECT COUNT(*) FROM claudex_diagnostics`))
	require.Equal(t, 5, count(t, db, `SELECT COUNT(*) FROM claudex_feedback`))
}

func TestIntegrationAdminQueries(t *testing.T) {
	db := freshDB(t, false)
	s := &sqlStore{db: db}
	ctx := context.Background()
	base := time.Date(2026, 9, 20, 12, 0, 0, 0, time.UTC)
	insert := func(user int64, i int, kind, code, version string, at time.Time) {
		_, err := s.insertDiagnostics(ctx, user, []diagnosticRow{{ReportUUID: uuidN("8a0f0000", i), Kind: kind, Code: code,
			AppVersion: version, RequestID: fmt.Sprintf("req_%d", i), Context: map[string]any{"surface": "code"}, OccurredAt: at}}, 100)
		require.NoError(t, err)
		_, err = db.Exec(`UPDATE claudex_diagnostics SET created_at = $1 WHERE user_id = $2 AND report_uuid = $3::uuid`, at, user, uuidN("8a0f0000", i))
		require.NoError(t, err)
	}
	insert(1, 1, "crash", "E1", "1.3.2", base)
	insert(1, 2, "gateway_refusal", "USAGE_LIMIT_EXCEEDED", "1.3.2", base.Add(time.Hour))
	insert(1, 3, "gateway_refusal", "USAGE_LIMIT_EXCEEDED", "1.4.0", base.Add(2*time.Hour))
	insert(2, 4, "gateway_refusal", "USAGE_LIMIT_EXCEEDED", "1.4.0", base.Add(3*time.Hour))
	insert(2, 5, "update_failed", "E2", "1.4.0", base.Add(24*time.Hour))

	list := func(f diagnosticsFilter) ([]string, int64) {
		if f.Page == 0 {
			f.Page, f.Size = 1, 20
		}
		items, total, err := s.listDiagnostics(ctx, f)
		require.NoError(t, err)
		ids := []string{}
		for _, it := range items {
			ids = append(ids, it.RequestID)
		}
		return ids, total
	}
	ids, total := list(diagnosticsFilter{})
	require.Equal(t, []string{"req_5", "req_4", "req_3", "req_2", "req_1"}, ids, "newest first")
	require.Equal(t, int64(5), total)
	ids, _ = list(diagnosticsFilter{UserID: 1})
	require.Equal(t, []string{"req_3", "req_2", "req_1"}, ids)
	ids, _ = list(diagnosticsFilter{Code: "USAGE_LIMIT_EXCEEDED", AppVersion: "1.4.0"})
	require.Equal(t, []string{"req_4", "req_3"}, ids)
	ids, _ = list(diagnosticsFilter{Kind: "crash"})
	require.Equal(t, []string{"req_1"}, ids)
	from, to := base.Add(time.Hour), base.Add(3*time.Hour)
	ids, _ = list(diagnosticsFilter{From: &from, To: &to})
	require.Equal(t, []string{"req_3", "req_2"}, ids, "from inclusive, to exclusive")
	ids, total = list(diagnosticsFilter{Page: 2, Size: 2})
	require.Equal(t, []string{"req_3", "req_2"}, ids)
	require.Equal(t, int64(5), total)

	items, _, err := s.listDiagnostics(ctx, diagnosticsFilter{Kind: "crash", Page: 1, Size: 1})
	require.NoError(t, err)
	d, err := s.getDiagnostic(ctx, items[0].ID)
	require.NoError(t, err)
	require.Equal(t, uuidN("8a0f0000", 1), d.ReportUUID)
	require.Equal(t, int64(1), d.UserID)
	require.Nil(t, d.DeviceID)
	require.JSONEq(t, `{"surface":"code"}`, string(d.Context))
	require.Equal(t, base, d.OccurredAt)
	require.Equal(t, base, d.CreatedAt)
	deleted, err := s.deleteDiagnostic(ctx, d.ID)
	require.NoError(t, err)
	require.True(t, deleted)
	deleted, err = s.deleteDiagnostic(ctx, d.ID)
	require.NoError(t, err)
	require.False(t, deleted)
	d, err = s.getDiagnostic(ctx, d.ID)
	require.NoError(t, err)
	require.Nil(t, d)

	excerpt := "User: hi\nAssistant: hello"
	for i, r := range []feedbackRow{
		{FeedbackUUID: uuidN("c1d20000", 1), Rating: "down", Categories: []string{"inaccurate", "not_helpful"}, Comment: "wrong", ConversationExcerpt: &excerpt},
		{FeedbackUUID: uuidN("c1d20000", 2), Rating: "up"},
	} {
		_, err := s.insertFeedback(ctx, int64(i+1), r, 100)
		require.NoError(t, err)
	}
	fbs, total, err := s.listFeedback(ctx, feedbackFilter{Page: 1, Size: 20})
	require.NoError(t, err)
	require.Equal(t, int64(2), total)
	require.Len(t, fbs, 2)
	fbs, _, err = s.listFeedback(ctx, feedbackFilter{Rating: "down", Page: 1, Size: 20})
	require.NoError(t, err)
	require.Len(t, fbs, 1)
	require.True(t, fbs[0].HasExcerpt)
	require.Nil(t, fbs[0].ConversationExcerpt, "lists never read the excerpt")
	require.Equal(t, []string{"inaccurate", "not_helpful"}, fbs[0].Categories)
	got, err := s.getFeedback(ctx, fbs[0].ID)
	require.NoError(t, err)
	require.Equal(t, excerpt, *got.ConversationExcerpt)
	fbs, _, err = s.listFeedback(ctx, feedbackFilter{UserID: 2, Page: 1, Size: 20})
	require.NoError(t, err)
	require.Len(t, fbs, 1)
	require.False(t, fbs[0].HasExcerpt)
	require.Equal(t, []string{}, fbs[0].Categories)
	got, err = s.getFeedback(ctx, fbs[0].ID)
	require.NoError(t, err)
	require.Nil(t, got.ConversationExcerpt)
	deleted, err = s.deleteFeedback(ctx, got.ID)
	require.NoError(t, err)
	require.True(t, deleted)
	got, err = s.getFeedback(ctx, got.ID)
	require.NoError(t, err)
	require.Nil(t, got)
}

// TestIntegrationRetentionCleanup: the hourly job deletes rows older than the
// retention periods, in batches, and keeps the rest.
func TestIntegrationRetentionCleanup(t *testing.T) {
	db := freshDB(t, false)
	f := newFixture(t, fixtureOptions{db: db})
	f.clock = time.Now().UTC()
	f.enable(func(s *Settings) { s.Diagnostics.RetentionDays = 30; s.Feedback.RetentionDays = 180 })
	_, err := db.Exec(`INSERT INTO claudex_diagnostics (report_uuid, user_id, kind, occurred_at, created_at)
		SELECT gen_random_uuid(), 1 + g % 3, 'crash', NOW(), NOW() - INTERVAL '31 days' FROM generate_series(1, 2500) AS g`)
	require.NoError(t, err)
	_, err = db.Exec(`INSERT INTO claudex_diagnostics (report_uuid, user_id, kind, occurred_at, created_at)
		SELECT gen_random_uuid(), 1, 'crash', NOW(), NOW() - INTERVAL '29 days' FROM generate_series(1, 3)`)
	require.NoError(t, err)
	_, err = db.Exec(`INSERT INTO claudex_feedback (feedback_uuid, user_id, rating, created_at) VALUES
		(gen_random_uuid(), 1, 'up', NOW() - INTERVAL '181 days'),
		(gen_random_uuid(), 2, 'down', NOW() - INTERVAL '200 days'),
		(gen_random_uuid(), 2, 'down', NOW() - INTERVAL '179 days')`)
	require.NoError(t, err)

	diagnostics, feedback, err := f.c.PurgeExpired(context.Background())
	require.NoError(t, err)
	require.Equal(t, int64(2500), diagnostics)
	require.Equal(t, int64(2), feedback)
	require.Equal(t, 3, count(t, db, `SELECT COUNT(*) FROM claudex_diagnostics`))
	require.Equal(t, 1, count(t, db, `SELECT COUNT(*) FROM claudex_feedback`))
	require.Zero(t, count(t, db, `SELECT COUNT(*) FROM claudex_diagnostics WHERE created_at < NOW() - INTERVAL '30 days'`))

	// A shorter retention takes effect on the next run.
	f.enable(func(s *Settings) { s.Diagnostics.RetentionDays = 7; s.Feedback.RetentionDays = 1 })
	diagnostics, feedback, err = f.c.PurgeExpired(context.Background())
	require.NoError(t, err)
	require.Equal(t, int64(3), diagnostics)
	require.Equal(t, int64(1), feedback)
}

// emailUsers is a service.UserRepository answering GetByIDIncludeDeleted
// from the test database.
type emailUsers struct {
	service.UserRepository
	db *sql.DB
}

func (u emailUsers) GetByIDIncludeDeleted(ctx context.Context, id int64) (*service.User, error) {
	var email string
	if err := u.db.QueryRowContext(ctx, `SELECT email FROM users WHERE id = $1`, id).Scan(&email); err != nil {
		return nil, err
	}
	return &service.User{ID: id, Email: email}, nil
}

// TestIntegrationEndToEnd runs the handlers on the real tables behind the
// real audit middleware: off by default, then enabled by the administrator;
// reports are stored redacted, excerpts dropped unless allowed, the report
// text never reaches the audit log, and the console can list, open and
// delete.
func TestIntegrationEndToEnd(t *testing.T) {
	db := freshDB(t, false)
	repo := &auditCapture{}
	audit := service.NewAuditLogService(repo, nil)
	audit.Start()
	f := newFixture(t, fixtureOptions{db: db, audit: middleware.NewAuditLogMiddleware(audit), env: func(env *core.Env) {
		env.UserRepo = emailUsers{db: db}
	}})
	f.clock = time.Now().UTC()
	f.userID = 2

	diag := diagBody("true", report(uuidA, "gateway_refusal", `"code":"USAGE_LIMIT_EXCEEDED","message":"upstream secret","context":{"reason":"RULE_LIMIT","prompt":"secret"}`),
		report(uuidB, "turn_error", `"message":"failed for secret-owner@example.com with sk-secretkey","request_id":"req_9"`))
	fb := `{"consent":true,"id":"` + uuidC + `","rating":"down","comment":"secret comment by bob@example.com","conversation_excerpt":"secret prompt"}`

	res := f.do(http.MethodPost, "/api/v1/claudex/diagnostics", diag)
	require.Equal(t, http.StatusNotFound, res.Status)
	require.Equal(t, "CLAUDEX_FEEDBACK_DISABLED", res.Reason)
	res = f.do(http.MethodPost, "/api/v1/claudex/feedback", fb)
	require.Equal(t, "CLAUDEX_FEEDBACK_DISABLED", res.Reason)
	require.Zero(t, count(t, db, `SELECT COUNT(*) FROM claudex_diagnostics`))
	require.Zero(t, count(t, db, `SELECT COUNT(*) FROM claudex_feedback`))

	res = f.do(http.MethodPut, "/api/v1/admin/claudex/feedback-settings", `{"diagnostics":{"enabled":true},"feedback":{"enabled":true}}`)
	require.Equal(t, http.StatusOK, res.Status, res.Raw)

	res = f.do(http.MethodPost, "/api/v1/claudex/diagnostics", diag, core.HeaderPlatform, "darwin", core.HeaderVersion, "1.3.2")
	require.Equal(t, http.StatusOK, res.Status, res.Raw)
	require.JSONEq(t, `{"accepted":2,"duplicates":0,"dropped":0}`, string(res.Data))
	res = f.do(http.MethodPost, "/api/v1/claudex/diagnostics", diag)
	require.JSONEq(t, `{"accepted":0,"duplicates":2,"dropped":0}`, string(res.Data))
	res = f.do(http.MethodPost, "/api/v1/claudex/feedback", fb)
	require.Equal(t, http.StatusOK, res.Status, res.Raw)
	require.JSONEq(t, `{"accepted":true,"duplicate":false,"excerpt_dropped":true}`, string(res.Data))

	var message, contextText, platform, version string
	require.NoError(t, db.QueryRow(`SELECT message, context::text, platform, app_version FROM claudex_diagnostics WHERE kind = 'gateway_refusal'`).
		Scan(&message, &contextText, &platform, &version))
	require.Empty(t, message)
	require.JSONEq(t, `{"reason":"RULE_LIMIT"}`, contextText)
	require.Equal(t, "darwin", platform)
	require.Equal(t, "1.3.2", version)
	require.NoError(t, db.QueryRow(`SELECT message FROM claudex_diagnostics WHERE kind = 'turn_error'`).Scan(&message))
	require.Equal(t, "failed for [email] with sk-[redacted]", message)
	var comment string
	var excerpt sql.NullString
	require.NoError(t, db.QueryRow(`SELECT comment, conversation_excerpt FROM claudex_feedback`).Scan(&comment, &excerpt))
	require.Equal(t, "secret comment by [email]", comment)
	require.False(t, excerpt.Valid, "the excerpt was dropped")

	// The console.
	res = f.do(http.MethodGet, "/api/v1/admin/claudex/diagnostics?user_id=2&kind=turn_error", "")
	require.Equal(t, http.StatusOK, res.Status, res.Raw)
	var page struct {
		Items []Diagnostic `json:"items"`
		Total int64        `json:"total"`
	}
	res.into(t, &page)
	require.Equal(t, int64(1), page.Total)
	require.Equal(t, "user2@example.com", page.Items[0].UserEmail)
	require.Equal(t, "req_9", page.Items[0].RequestID)
	res = f.do(http.MethodGet, fmt.Sprintf("/api/v1/admin/claudex/diagnostics/%d", page.Items[0].ID), "")
	require.Equal(t, http.StatusOK, res.Status)
	var fbPage struct {
		Items []Feedback `json:"items"`
	}
	res = f.do(http.MethodGet, "/api/v1/admin/claudex/feedback?rating=down", "")
	res.into(t, &fbPage)
	require.Len(t, fbPage.Items, 1)
	require.Equal(t, "user2@example.com", fbPage.Items[0].UserEmail)
	res = f.do(http.MethodGet, fmt.Sprintf("/api/v1/admin/claudex/feedback/%d", fbPage.Items[0].ID), "")
	require.Equal(t, http.StatusOK, res.Status)
	require.Contains(t, string(res.Data), `"conversation_excerpt":null`)
	res = f.do(http.MethodDelete, fmt.Sprintf("/api/v1/admin/claudex/feedback/%d", fbPage.Items[0].ID), "")
	require.Equal(t, http.StatusOK, res.Status)
	require.Zero(t, count(t, db, `SELECT COUNT(*) FROM claudex_feedback`))

	// Allowing excerpts keeps the next one.
	res = f.do(http.MethodPut, "/api/v1/admin/claudex/feedback-settings", `{"feedback":{"allow_conversation_excerpt":true}}`)
	require.Equal(t, http.StatusOK, res.Status)
	res = f.do(http.MethodPost, "/api/v1/claudex/feedback", strings.Replace(fb, uuidC, uuidA, 1))
	require.JSONEq(t, `{"accepted":true,"duplicate":false,"excerpt_dropped":false}`, string(res.Data))
	require.NoError(t, db.QueryRow(`SELECT conversation_excerpt FROM claudex_feedback`).Scan(&excerpt))
	require.Equal(t, "secret prompt", excerpt.String)

	audit.Stop()
	repo.mu.Lock()
	defer repo.mu.Unlock()
	require.NotEmpty(t, repo.entries)
	for _, e := range repo.entries {
		require.False(t, strings.HasPrefix(e.Path, "/api/v1/claudex/"), "intake requests leave no audit entry: %s", e.Path)
		require.NotContains(t, e.RequestBody, "secret", "%s %s", e.Method, e.Path)
	}
}
