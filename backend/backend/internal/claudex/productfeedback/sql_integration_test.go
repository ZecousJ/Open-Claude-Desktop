//go:build feedback_postgres_integration

package productfeedback

// Explicit local integration tests only. Default test runs exclude this file.
// Run only after the coordinator authorizes the named disposable PostgreSQL
// fixture. Never reads DATABASE_URL or accepts arbitrary DSNs / network hosts.
import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/lib/pq"
)

const integrationDatabase = "claudex_feedback_test"
const integrationMarker = "claudex-feedback-test-only-20261103"
const migrationSHA256 = "0dc552146aaeffaae185f899506f34ee3127df2cd0594dd616f8cf3071db49b9"

func privateOwnedPath(t *testing.T, path string, socket bool) {
	t.Helper()
	real, err := filepath.EvalSymlinks(path)
	if err != nil || real != path {
		t.Fatalf("Fixture path unavailable or indirect: %s", path)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(os.Getuid()) {
		t.Fatal("Fixture path not owned by current test user")
	}
	if socket {
		if info.Mode()&os.ModeSocket == 0 || info.Mode().Perm() != 0700 {
			t.Fatal("Expected the authorized Unix socket")
		}
	} else if !info.IsDir() || info.Mode().Perm() != 0700 {
		t.Fatal("Fixture directory must be private 0700")
	}
}

// Metadata is created by the coordinator only after the separately authorized
// disposable fixture starts. It is not an authorization mechanism on its own.
func fixtureDSN(t *testing.T) string {
	t.Helper()
	if os.Getenv("CLAUDEX_FEEDBACK_PG_INTEGRATION") != "1" {
		t.Skip("Explicit isolated PostgreSQL opt-in absent")
	}
	// Inspect environment names only; never log or use their values. lib/pq
	// otherwise inherits PG* settings before applying the explicit DSN.
	for _, entry := range os.Environ() {
		if at := strings.IndexByte(entry, '='); at >= 0 && strings.HasPrefix(entry[:at], "PG") {
			t.Fatal("PG-prefixed environment settings are prohibited; use the empty-environment runner")
		}
	}
	repo := os.Getenv("CLAUDEX_FEEDBACK_TEST_REPO_ROOT")
	if !filepath.IsAbs(repo) || filepath.Clean(repo) != repo {
		t.Fatal("An explicit canonical repository root is required")
	}
	real, err := filepath.EvalSymlinks(repo)
	if err != nil || real != repo {
		t.Fatal("Repository root must not be indirect")
	}
	_, sourceFile, _, sourceOK := runtime.Caller(0)
	if !sourceOK || !filepath.IsAbs(sourceFile) {
		t.Fatal("Current test source repository cannot be verified")
	}
	sourceRepo := ""
	for at := filepath.Dir(sourceFile); ; at = filepath.Dir(at) {
		_, gitErr := os.Stat(filepath.Join(at, ".git"))
		_, packageErr := os.Stat(filepath.Join(at, "package.json"))
		if gitErr == nil && packageErr == nil {
			sourceRepo = at
			break
		}
		if filepath.Dir(at) == at {
			break
		}
	}
	if sourceRepo == "" || sourceRepo != repo {
		t.Fatal("Fixture must belong to the current test source repository")
	}
	integrationRoot := filepath.Join(repo, ".runtime", "pg-fb-20261103")
	integrationSocket := filepath.Join(integrationRoot, "socket")
	if os.Getenv("CLAUDEX_FEEDBACK_TEST_PG_SOCKET") != integrationSocket {
		t.Fatal("Only the coordinator's exact disposable Unix socket is allowed")
	}
	privateOwnedPath(t, integrationRoot, false)
	privateOwnedPath(t, integrationSocket, false)
	metaPath := filepath.Join(integrationRoot, "feedback-test-fixture.json")
	metaReal, err := filepath.EvalSymlinks(metaPath)
	if err != nil || metaReal != metaPath {
		t.Fatal("Approved fixture metadata missing or indirect")
	}
	// Open one non-following descriptor and validate/read that same file, rather
	// than checking a path and then reopening a potentially different target.
	fd, err := syscall.Open(metaPath, syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		t.Fatal("Fixture metadata cannot be opened safely", err)
	}
	file := os.NewFile(uintptr(fd), metaPath)
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		t.Fatal(err)
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(os.Getuid()) || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 || info.Size() > 4096 {
		t.Fatal("Fixture metadata must be a private, owned, bounded regular file")
	}
	data, err := io.ReadAll(io.LimitReader(file, 4097))
	if err != nil || len(data) > 4096 {
		t.Fatal("Fixture metadata read failed or exceeded bound")
	}
	var meta struct {
		Version  int    `json:"version"`
		Purpose  string `json:"purpose"`
		Socket   string `json:"socket"`
		Port     int    `json:"port"`
		Database string `json:"database"`
		Role     string `json:"role"`
		OwnerUID uint32 `json:"owner_uid"`
		State    string `json:"state"`
	}
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&meta); err != nil {
		t.Fatal("Invalid fixture metadata", err)
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		t.Fatal("Extra fixture metadata JSON")
	}
	if meta.Version != 1 || meta.Purpose != "claudex-feedback-isolated-test" || meta.State != "ready" || meta.Socket != integrationSocket || meta.Port != 55482 || meta.Database != integrationDatabase || meta.Role != "agent" || meta.OwnerUID != uint32(os.Getuid()) {
		t.Fatal("Fixture metadata does not match the approved local scope")
	}
	privateOwnedPath(t, integrationSocket+"/.s.PGSQL.55482", true)
	host := "'" + strings.ReplaceAll(strings.ReplaceAll(integrationSocket, "\\", "\\\\"), "'", "\\'") + "'"
	return "host=" + host + " port=55482 user=agent password='' dbname=" + integrationDatabase + " sslmode=disable connect_timeout=3 application_name=claudex-feedback-inert-test options='-c statement_timeout=5000 -c lock_timeout=3000'"
}

type realFixture struct {
	db  *sql.DB
	dsn string
}

func realDB(t *testing.T) realFixture {
	t.Helper()
	base := fixtureDSN(t)
	admin, err := sql.Open("postgres", base)
	if err != nil {
		t.Fatal(err)
	}
	admin.SetMaxOpenConns(1)
	t.Cleanup(func() { admin.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var database, user, marker string
	var local bool
	err = admin.QueryRowContext(ctx, `SELECT current_database(),current_user,inet_server_addr() IS NULL,coalesce(shobj_description(oid,'pg_database'),'') FROM pg_database WHERE datname=current_database()`).Scan(&database, &user, &local, &marker)
	if err != nil {
		t.Fatal("Authorized test fixture is unavailable:", err)
	}
	if database != integrationDatabase || user != "agent" || !local || marker != integrationMarker {
		t.Fatal("Refusing non-fixture database, role, socket, or marker")
	}
	schema := "feedback_it_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err = admin.ExecContext(ctx, "CREATE SCHEMA "+pq.QuoteIdentifier(schema)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := admin.ExecContext(cleanup, "DROP SCHEMA "+pq.QuoteIdentifier(schema)+" CASCADE"); err != nil {
			t.Errorf("Own test schema cleanup: %v", err)
		}
	})
	dsn := base + " search_path=" + schema
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(8)
	t.Cleanup(func() { db.Close() })
	if _, err = db.ExecContext(ctx, "CREATE TABLE users(id BIGINT PRIMARY KEY); INSERT INTO users(id) VALUES(17),(18)"); err != nil {
		t.Fatal(err)
	}
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("Test source location unavailable")
	}
	migration, err := os.ReadFile(filepath.Join(filepath.Dir(file), "../../../migrations/claudex_0182_product_feedback.sql"))
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(migration)
	if hex.EncodeToString(sum[:]) != migrationSHA256 {
		t.Fatal("Migration changed; review before executing")
	}
	if _, err = db.ExecContext(ctx, string(migration)); err != nil {
		t.Fatal(err)
	}
	return realFixture{db, dsn}
}
func pgErrorCode(t *testing.T, err error, want string) {
	t.Helper()
	var pg *pq.Error
	if !errors.As(err, &pg) || string(pg.Code) != want {
		t.Fatalf("Wanted PostgreSQL %s, got %v", want, err)
	}
}
func realInput() request {
	return request{Text: "synthetic test text only", AppVersion: "1.2.3", RequestID: uuid.NewString()}
}
func realProcessor(db *sql.DB, send sendMail) *processor {
	return &processor{store: &sqlStore{db: db}, prepare: func(context.Context) (sendMail, error) { return send, nil }, newID: uuid.NewString, now: time.Now}
}

func TestPGMigrationConstraintsAndCascade(t *testing.T) {
	f := realDB(t)
	ctx := context.Background()
	req, id := uuid.NewString(), uuid.NewString()
	insert := `INSERT INTO claudex_product_feedback_receipts(user_id,request_id,feedback_id,payload_hash,status,created_at) VALUES($1,$2,$3,$4,$5,now())`
	if _, err := f.db.ExecContext(ctx, insert, 17, req, id, strings.Repeat("a", 64), "sending"); err != nil {
		t.Fatal(err)
	}
	_, err := f.db.ExecContext(ctx, insert, 17, req, uuid.NewString(), strings.Repeat("a", 64), "sent")
	pgErrorCode(t, err, "23505")
	_, err = f.db.ExecContext(ctx, insert, 18, uuid.NewString(), id, strings.Repeat("a", 64), "sent")
	pgErrorCode(t, err, "23505")
	_, err = f.db.ExecContext(ctx, insert, 999, uuid.NewString(), uuid.NewString(), strings.Repeat("a", 64), "sent")
	pgErrorCode(t, err, "23503")
	_, err = f.db.ExecContext(ctx, insert, 17, uuid.NewString(), uuid.NewString(), strings.Repeat("a", 64), "queued")
	pgErrorCode(t, err, "23514")
	if _, err = f.db.ExecContext(ctx, "DELETE FROM users WHERE id=17"); err != nil {
		t.Fatal(err)
	}
	var n int
	if err = f.db.QueryRowContext(ctx, "SELECT count(*) FROM claudex_product_feedback_receipts").Scan(&n); err != nil || n != 0 {
		t.Fatal(n, err)
	}
}
func TestPGClaimCommitsAndSurvivesConnectionReopen(t *testing.T) {
	f := realDB(t)
	ctx := context.Background()
	key, id := uuid.NewString(), uuid.NewString()
	s := &sqlStore{db: f.db}
	r, fresh, err := s.Claim(ctx, 17, key, strings.Repeat("a", 64), id, time.Now())
	if err != nil || !fresh || r.ID != id {
		t.Fatal(r, fresh, err)
	}
	if err = f.db.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := sql.Open("postgres", f.dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	s = &sqlStore{db: reopened}
	r, found, err := s.Lookup(ctx, 17, key)
	if err != nil || !found || r.ID != id || r.Status != "sending" || r.Hash != strings.Repeat("a", 64) {
		t.Fatal(r, found, err)
	}
	if _, found, err = s.Lookup(ctx, 18, key); err != nil || found {
		t.Fatal("cross-owner lookup", found, err)
	}
	if err = s.Finish(ctx, 17, key, "sent"); err != nil {
		t.Fatal(err)
	}
	r, fresh, err = s.Claim(ctx, 17, key, strings.Repeat("a", 64), uuid.NewString(), time.Now())
	if err != nil || fresh || r.ID != id || r.Status != "sent" || r.Hash != strings.Repeat("a", 64) {
		t.Fatal(r, fresh, err)
	}
}
func TestPGConcurrentClaimHasOneWinner(t *testing.T) {
	f := realDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	key := uuid.NewString()
	s := &sqlStore{db: f.db}
	start := make(chan struct{})
	type result struct {
		r     receipt
		fresh bool
		err   error
	}
	out := make(chan result, 8)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			r, fresh, err := s.Claim(ctx, 17, key, strings.Repeat("b", 64), uuid.NewString(), time.Now())
			out <- result{r, fresh, err}
		}()
	}
	close(start)
	wg.Wait()
	close(out)
	winners := 0
	id := ""
	for v := range out {
		if v.err != nil {
			t.Fatal(v.err)
		}
		if v.fresh {
			winners++
		}
		if id == "" {
			id = v.r.ID
		}
		if v.r.Hash != strings.Repeat("b", 64) {
			t.Fatal("changed payload hash")
		}
		if id != v.r.ID {
			t.Fatal("different receipt identities")
		}
	}
	if winners != 1 {
		t.Fatal("claim winners", winners)
	}
	var n int
	if err := f.db.QueryRowContext(ctx, "SELECT count(*) FROM claudex_product_feedback_receipts WHERE user_id=17 AND request_id=$1", key).Scan(&n); err != nil || n != 1 {
		t.Fatal(n, err)
	}
}
func TestPGQuotaDoesNotBlockReplayOrAnotherOwner(t *testing.T) {
	f := realDB(t)
	ctx := context.Background()
	s := &sqlStore{db: f.db}
	keys := []string{}
	now := time.Now()
	for i := 0; i < perHour; i++ {
		key := uuid.NewString()
		keys = append(keys, key)
		if _, fresh, err := s.Claim(ctx, 17, key, strings.Repeat("a", 64), uuid.NewString(), now); err != nil || !fresh {
			t.Fatal(fresh, err)
		}
	}
	if _, fresh, err := s.Claim(ctx, 17, uuid.NewString(), strings.Repeat("a", 64), uuid.NewString(), now); !errors.Is(err, errLimited) || fresh {
		t.Fatal(fresh, err)
	}
	if _, fresh, err := s.Claim(ctx, 17, keys[0], strings.Repeat("a", 64), uuid.NewString(), now); err != nil || fresh {
		t.Fatal(fresh, err)
	}
	if _, fresh, err := s.Claim(ctx, 18, keys[0], strings.Repeat("a", 64), uuid.NewString(), now); err != nil || !fresh {
		t.Fatal(fresh, err)
	}
}
func TestPGProcessorReplayAndConfigLossNeverDispatchTwice(t *testing.T) {
	for _, state := range []string{"sent", "unknown", "sending"} {
		t.Run(state, func(t *testing.T) {
			f := realDB(t)
			ctx := context.Background()
			in := realInput()
			var calls atomic.Int32
			p := realProcessor(f.db, func(_ context.Context, to, subject, body string) error {
				calls.Add(1)
				if to != Recipient || strings.Contains(body, "account") {
					t.Error("unexpected mail data")
				}
				if state == "unknown" {
					return errors.New("synthetic SMTP uncertainty")
				}
				return nil
			})
			if _, err := p.submit(ctx, 17, in); state != "unknown" && err != nil || state == "unknown" && !errors.Is(err, errUnknown) {
				t.Fatal(err)
			}
			if state == "sending" {
				if _, err := f.db.ExecContext(ctx, "UPDATE claudex_product_feedback_receipts SET status='sending' WHERE user_id=17 AND request_id=$1", in.RequestID); err != nil {
					t.Fatal(err)
				}
			}
			p.prepare = func(context.Context) (sendMail, error) {
				t.Fatal("replay consulted SMTP config")
				return nil, errUnavailable
			}
			r, err := p.submit(ctx, 17, in)
			if state == "sent" && err != nil || state != "sent" && !errors.Is(err, errUnknown) {
				t.Fatal(r, err)
			}
			changed := in
			changed.Text = "different synthetic text"
			if _, err = p.submit(ctx, 17, changed); !errors.Is(err, errConflict) {
				t.Fatal(err)
			}
			p.prepare = func(context.Context) (sendMail, error) { return nil, errUnavailable }
			if _, err = p.submit(ctx, 18, in); !errors.Is(err, errUnavailable) {
				t.Fatal(err)
			}
			if calls.Load() != 1 {
				t.Fatal("duplicate mock SMTP", calls.Load())
			}
			var n int
			if err = f.db.QueryRowContext(ctx, "SELECT count(*) FROM claudex_product_feedback_receipts").Scan(&n); err != nil || n != 1 {
				t.Fatal(n, err)
			}
		})
	}
}
func TestPGFreshUnavailableAndLookupFailureCannotClaim(t *testing.T) {
	f := realDB(t)
	ctx := context.Background()
	p := realProcessor(f.db, func(context.Context, string, string, string) error { t.Fatal("SMTP"); return nil })
	p.prepare = func(context.Context) (sendMail, error) { return nil, errUnavailable }
	if _, err := p.submit(ctx, 17, realInput()); !errors.Is(err, errUnavailable) {
		t.Fatal(err)
	}
	var n int
	if err := f.db.QueryRowContext(ctx, "SELECT count(*) FROM claudex_product_feedback_receipts").Scan(&n); err != nil || n != 0 {
		t.Fatal(n, err)
	}
	f.db.Close()
	p.prepare = func(context.Context) (sendMail, error) {
		t.Fatal("DB error reached config")
		return nil, fmt.Errorf("unexpected")
	}
	if _, err := p.submit(ctx, 17, realInput()); !errors.Is(err, errUnavailable) {
		t.Fatal(err)
	}
}
