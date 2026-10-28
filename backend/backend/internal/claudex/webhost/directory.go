package webhost

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// RunnerRecord is a runner token row (claudex_web_runners).
type RunnerRecord struct {
	ID          int64             `json:"id"`
	Name        string            `json:"name"`
	CreatedAt   time.Time         `json:"created_at"`
	CreatedBy   int64             `json:"created_by,omitempty"`
	RevokedAt   *time.Time        `json:"revoked_at"`
	DisabledAt  *time.Time        `json:"disabled_at"`
	LastSeenAt  *time.Time        `json:"last_seen_at"`
	LastVersion string            `json:"last_version"`
	Labels      map[string]string `json:"labels"`
}

// LinkID is the runner id the link uses for a stored runner.
func (r RunnerRecord) LinkID() string { return "r" + strconv.FormatInt(r.ID, 10) }

// LocalRunnerID is the id of the runner that authenticates with the local
// token (DC6 single mode).
const LocalRunnerID = "local"

// ErrNoRunner is returned for an unknown or revoked runner token or id.
var ErrNoRunner = errors.New("webhost: no such runner")

// RunnerDirectory stores runner tokens (hashes only) and which runner serves
// which user (the assignment survives a server restart, so a runner's
// writes for a user it already serves keep working).
type RunnerDirectory interface {
	Authenticate(ctx context.Context, tokenHash string) (RunnerRecord, error)
	Seen(ctx context.Context, id int64, version string, labels map[string]string) error
	List(ctx context.Context) ([]RunnerRecord, error)
	Create(ctx context.Context, name string, createdBy int64, tokenHash string) (RunnerRecord, error)
	Revoke(ctx context.Context, id int64) (RunnerRecord, error)
	// Update renames and/or switches a runner off or on (nil leaves a field
	// alone). An unknown or revoked runner is ErrNoRunner.
	Update(ctx context.Context, id int64, name *string, disabled *bool) (RunnerRecord, error)
	// Assignment returns the runner id serving the user, "" for none.
	Assignment(ctx context.Context, userID int64) (string, error)
	Assign(ctx context.Context, userID int64, runnerID string) error
}

// Runner tokens: "cxr_" + 32 random bytes (base64url). Only the SHA-256 is
// stored; the token is shown once when it is created.
const runnerTokenPrefix = "cxr_"

func newRunnerToken() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return runnerTokenPrefix + base64.RawURLEncoding.EncodeToString(b[:]), nil
}

func hashRunnerToken(token string) string {
	sum := sha256.Sum256([]byte("claudex-runner-token\n" + token))
	return hex.EncodeToString(sum[:])
}

// cleanLabels keeps at most 16 short printable labels.
func cleanLabels(in map[string]string) map[string]string {
	out := map[string]string{}
	keys := make([]string, 0, len(in))
	for k := range in {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if len(out) >= 16 {
			break
		}
		k2, v := printable(k, 32), printable(in[k], 64)
		if k2 != "" {
			out[k2] = v
		}
	}
	return out
}

func printable(s string, max int) string {
	s = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, strings.TrimSpace(s))
	if len(s) > max {
		s = s[:max]
		for len(s) > 0 && s[len(s)-1]&0xC0 == 0x80 {
			s = s[:len(s)-1]
		}
	}
	return s
}

// ---------------------------------------------------------------------------
// PostgreSQL (migrations/claudex_0090_runners.sql)

type sqlDirectory struct{ db *sql.DB }

const runnerColumns = `id, name, created_at, COALESCE(created_by, 0), revoked_at, disabled_at, last_seen_at, last_version, labels`

func scanRunner(sc interface{ Scan(...any) error }) (RunnerRecord, error) {
	var r RunnerRecord
	var revoked, disabled, seen sql.NullTime
	var labels []byte
	if err := sc.Scan(&r.ID, &r.Name, &r.CreatedAt, &r.CreatedBy, &revoked, &disabled, &seen, &r.LastVersion, &labels); err != nil {
		return r, err
	}
	if revoked.Valid {
		t := revoked.Time
		r.RevokedAt = &t
	}
	if disabled.Valid {
		t := disabled.Time
		r.DisabledAt = &t
	}
	if seen.Valid {
		t := seen.Time
		r.LastSeenAt = &t
	}
	r.Labels = map[string]string{}
	_ = json.Unmarshal(labels, &r.Labels)
	return r, nil
}

func (d *sqlDirectory) Authenticate(ctx context.Context, tokenHash string) (RunnerRecord, error) {
	r, err := scanRunner(d.db.QueryRowContext(ctx, `SELECT `+runnerColumns+` FROM claudex_web_runners
WHERE token_hash = $1 AND revoked_at IS NULL AND disabled_at IS NULL`, tokenHash))
	if errors.Is(err, sql.ErrNoRows) {
		return RunnerRecord{}, ErrNoRunner
	}
	return r, err
}

func (d *sqlDirectory) Seen(ctx context.Context, id int64, version string, labels map[string]string) error {
	raw, err := json.Marshal(cleanLabels(labels))
	if err != nil {
		return err
	}
	_, err = d.db.ExecContext(ctx, `UPDATE claudex_web_runners SET last_seen_at = NOW(), last_version = $2, labels = $3::jsonb WHERE id = $1`,
		id, printable(version, 64), string(raw))
	return err
}

func (d *sqlDirectory) List(ctx context.Context) ([]RunnerRecord, error) {
	rows, err := d.db.QueryContext(ctx, `SELECT `+runnerColumns+` FROM claudex_web_runners ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []RunnerRecord{}
	for rows.Next() {
		r, err := scanRunner(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (d *sqlDirectory) Create(ctx context.Context, name string, createdBy int64, tokenHash string) (RunnerRecord, error) {
	var by any
	if createdBy > 0 {
		by = createdBy
	}
	return scanRunner(d.db.QueryRowContext(ctx, `INSERT INTO claudex_web_runners (name, token_hash, created_by)
VALUES ($1, $2, $3) RETURNING `+runnerColumns, name, tokenHash, by))
}

func (d *sqlDirectory) Revoke(ctx context.Context, id int64) (RunnerRecord, error) {
	r, err := scanRunner(d.db.QueryRowContext(ctx, `UPDATE claudex_web_runners SET revoked_at = COALESCE(revoked_at, NOW())
WHERE id = $1 RETURNING `+runnerColumns, id))
	if errors.Is(err, sql.ErrNoRows) {
		return RunnerRecord{}, ErrNoRunner
	}
	return r, err
}

func (d *sqlDirectory) Update(ctx context.Context, id int64, name *string, disabled *bool) (RunnerRecord, error) {
	r, err := scanRunner(d.db.QueryRowContext(ctx, `UPDATE claudex_web_runners SET
  name = COALESCE($2, name),
  disabled_at = CASE WHEN $3::boolean IS NULL THEN disabled_at WHEN $3 THEN COALESCE(disabled_at, NOW()) ELSE NULL END
WHERE id = $1 AND revoked_at IS NULL RETURNING `+runnerColumns, id, name, disabled))
	if errors.Is(err, sql.ErrNoRows) {
		return RunnerRecord{}, ErrNoRunner
	}
	return r, err
}

func (d *sqlDirectory) Assignment(ctx context.Context, userID int64) (string, error) {
	var id string
	err := d.db.QueryRowContext(ctx, `SELECT runner_id FROM claudex_web_runner_users WHERE user_id = $1`, userID).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return id, err
}

func (d *sqlDirectory) Assign(ctx context.Context, userID int64, runnerID string) error {
	_, err := d.db.ExecContext(ctx, `INSERT INTO claudex_web_runner_users (user_id, runner_id, assigned_at) VALUES ($1, $2, NOW())
ON CONFLICT (user_id) DO UPDATE SET runner_id = EXCLUDED.runner_id, assigned_at = NOW()`, userID, runnerID)
	return err
}

// ---------------------------------------------------------------------------
// In memory (no database: tests, tools)

type memoryDirectory struct {
	mu      sync.Mutex
	next    int64
	runners map[int64]*memoryRunner
	assign  map[int64]string
}

type memoryRunner struct {
	rec  RunnerRecord
	hash string
}

func newMemoryDirectory() *memoryDirectory {
	return &memoryDirectory{runners: map[int64]*memoryRunner{}, assign: map[int64]string{}}
}

func (d *memoryDirectory) Authenticate(_ context.Context, tokenHash string) (RunnerRecord, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, r := range d.runners {
		if r.hash == tokenHash && r.rec.RevokedAt == nil && r.rec.DisabledAt == nil {
			return r.rec, nil
		}
	}
	return RunnerRecord{}, ErrNoRunner
}

func (d *memoryDirectory) Seen(_ context.Context, id int64, version string, labels map[string]string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if r := d.runners[id]; r != nil {
		now := time.Now()
		r.rec.LastSeenAt, r.rec.LastVersion, r.rec.Labels = &now, printable(version, 64), cleanLabels(labels)
	}
	return nil
}

func (d *memoryDirectory) List(context.Context) ([]RunnerRecord, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := make([]RunnerRecord, 0, len(d.runners))
	for _, r := range d.runners {
		out = append(out, r.rec)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func (d *memoryDirectory) Create(_ context.Context, name string, createdBy int64, tokenHash string) (RunnerRecord, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.next++
	rec := RunnerRecord{ID: d.next, Name: name, CreatedAt: time.Now(), CreatedBy: createdBy, Labels: map[string]string{}}
	d.runners[rec.ID] = &memoryRunner{rec: rec, hash: tokenHash}
	return rec, nil
}

func (d *memoryDirectory) Revoke(_ context.Context, id int64) (RunnerRecord, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	r := d.runners[id]
	if r == nil {
		return RunnerRecord{}, ErrNoRunner
	}
	if r.rec.RevokedAt == nil {
		now := time.Now()
		r.rec.RevokedAt = &now
	}
	return r.rec, nil
}

func (d *memoryDirectory) Update(_ context.Context, id int64, name *string, disabled *bool) (RunnerRecord, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	r := d.runners[id]
	if r == nil || r.rec.RevokedAt != nil {
		return RunnerRecord{}, ErrNoRunner
	}
	if name != nil {
		r.rec.Name = *name
	}
	if disabled != nil {
		if !*disabled {
			r.rec.DisabledAt = nil
		} else if r.rec.DisabledAt == nil {
			now := time.Now()
			r.rec.DisabledAt = &now
		}
	}
	return r.rec, nil
}

func (d *memoryDirectory) Assignment(_ context.Context, userID int64) (string, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.assign[userID], nil
}

func (d *memoryDirectory) Assign(_ context.Context, userID int64, runnerID string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.assign[userID] = runnerID
	return nil
}
