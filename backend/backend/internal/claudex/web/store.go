package web

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// Reasons a web session ended (claudex_web_sessions.revoked_reason).
const (
	RevokedLogout    = "logout"
	RevokedUser      = "user"
	RevokedAdmin     = "admin"
	RevokedRevokeAll = "revoke_all"
	RevokedCap       = "cap"
)

// Session is one row of claudex_web_sessions.
type Session struct {
	ID            int64      `json:"id"`
	UserID        int64      `json:"-"`
	FamilyID      string     `json:"-"`
	UserAgent     string     `json:"user_agent"`
	IP            string     `json:"ip"`
	CreatedAt     time.Time  `json:"created_at"`
	LastSeenAt    time.Time  `json:"last_seen_at"`
	ExpiresAt     time.Time  `json:"expires_at"`
	RevokedAt     *time.Time `json:"revoked_at,omitempty"`
	RevokedReason string     `json:"revoked_reason,omitempty"`
}

// active reports whether the session can still be refreshed.
func (s *Session) active(now time.Time) bool {
	return s != nil && s.RevokedAt == nil && now.Before(s.ExpiresAt)
}

var errNoSession = errors.New("claudex web: session not found")

const sessionColumns = `id, user_id, family_id, user_agent, ip, created_at, last_seen_at, expires_at, revoked_at, revoked_reason`

type rowScanner interface{ Scan(dest ...any) error }

func scanSession(r rowScanner) (*Session, error) {
	var s Session
	var revoked sql.NullTime
	if err := r.Scan(&s.ID, &s.UserID, &s.FamilyID, &s.UserAgent, &s.IP, &s.CreatedAt, &s.LastSeenAt, &s.ExpiresAt, &revoked, &s.RevokedReason); err != nil {
		return nil, err
	}
	if revoked.Valid {
		t := revoked.Time
		s.RevokedAt = &t
	}
	return &s, nil
}

// store is the SQL side of the web sessions (Claudex table only).
type store struct {
	db *sql.DB
}

// lockUser serializes the session writes of one user (cap enforcement).
func lockUser(ctx context.Context, tx *sql.Tx, userID int64) error {
	if _, err := tx.ExecContext(ctx, `SET LOCAL lock_timeout = '15s'`); err != nil {
		return fmt.Errorf("set lock timeout: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('claudex_web_user:' || $1::text, 0))`, userID); err != nil {
		return fmt.Errorf("lock web sessions of user %d: %w", userID, err)
	}
	return nil
}

// markFamiliesRevoked records families in claudex_revoked_sessions so the JWT
// guard (H9b) refuses their access tokens right away.
func markFamiliesRevoked(ctx context.Context, tx *sql.Tx, userID int64, families []string, now, until time.Time) error {
	for _, f := range families {
		if f == "" {
			continue
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO claudex_revoked_sessions (session_family_id, user_id, revoked_at, expires_at) VALUES ($1, $2, $3, $4)
ON CONFLICT (session_family_id) DO UPDATE SET expires_at = GREATEST(claudex_revoked_sessions.expires_at, EXCLUDED.expires_at)`,
			f, userID, now, until); err != nil {
			return fmt.Errorf("record revoked web session: %w", err)
		}
	}
	return nil
}

// create inserts a session and ends the oldest active ones past maxActive. It
// returns the new row and the families it ended.
func (s *store) create(ctx context.Context, sess Session, maxActive int, now, revokedUntil time.Time) (*Session, []string, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, nil, fmt.Errorf("claudex web: begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := lockUser(ctx, tx, sess.UserID); err != nil {
		return nil, nil, err
	}
	row := tx.QueryRowContext(ctx, `INSERT INTO claudex_web_sessions (user_id, family_id, user_agent, ip, created_at, last_seen_at, expires_at)
VALUES ($1, $2, $3, $4, $5, $5, $6) RETURNING `+sessionColumns,
		sess.UserID, sess.FamilyID, sess.UserAgent, sess.IP, now, sess.ExpiresAt)
	created, err := scanSession(row)
	if err != nil {
		return nil, nil, fmt.Errorf("claudex web: insert session: %w", err)
	}
	if maxActive < 1 {
		maxActive = 1
	}
	// Expired rows do not count: they can no longer be refreshed.
	rows, err := tx.QueryContext(ctx, `UPDATE claudex_web_sessions SET revoked_at = $3, revoked_reason = 'cap'
WHERE id IN (
  SELECT id FROM claudex_web_sessions
  WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > $3
  ORDER BY created_at DESC, id DESC OFFSET $2
) RETURNING family_id`, sess.UserID, maxActive, now)
	if err != nil {
		return nil, nil, fmt.Errorf("claudex web: enforce session cap: %w", err)
	}
	families, err := scanFamilies(rows)
	if err != nil {
		return nil, nil, err
	}
	if err := markFamiliesRevoked(ctx, tx, sess.UserID, families, now, revokedUntil); err != nil {
		return nil, nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, nil, fmt.Errorf("claudex web: commit: %w", err)
	}
	return created, families, nil
}

func scanFamilies(rows *sql.Rows) ([]string, error) {
	defer func() { _ = rows.Close() }()
	var out []string
	for rows.Next() {
		var f string
		if err := rows.Scan(&f); err != nil {
			return nil, fmt.Errorf("claudex web: scan family: %w", err)
		}
		out = append(out, f)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("claudex web: read families: %w", err)
	}
	return out, nil
}

func (s *store) byFamily(ctx context.Context, family string) (*Session, error) {
	sess, err := scanSession(s.db.QueryRowContext(ctx, `SELECT `+sessionColumns+` FROM claudex_web_sessions WHERE family_id = $1`, family))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errNoSession
	}
	if err != nil {
		return nil, fmt.Errorf("claudex web: read session: %w", err)
	}
	return sess, nil
}

// touch records a refresh (still active rows only). ok is false when the
// session ended meanwhile.
func (s *store) touch(ctx context.Context, id int64, now, expiresAt time.Time, ip, ua string) (bool, error) {
	res, err := s.db.ExecContext(ctx, `UPDATE claudex_web_sessions SET last_seen_at = $2, expires_at = $3, ip = $4, user_agent = $5
WHERE id = $1 AND revoked_at IS NULL`, id, now, expiresAt, ip, ua)
	if err != nil {
		return false, fmt.Errorf("claudex web: touch session: %w", err)
	}
	n, _ := res.RowsAffected()
	return n == 1, nil
}

// revoke ends one session: by family (userID 0: any user) or by row id of a
// user. It returns the ended session, errNoSession when none matched.
// Revoking an ended session is not an error (the row is returned as is).
func (s *store) revoke(ctx context.Context, userID, id int64, family, reason string, now, revokedUntil time.Time) (*Session, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("claudex web: begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var row *sql.Row
	switch {
	case family != "":
		row = tx.QueryRowContext(ctx, `SELECT `+sessionColumns+` FROM claudex_web_sessions WHERE family_id = $1 AND ($2::bigint = 0 OR user_id = $2::bigint) FOR UPDATE`, family, userID)
	case id > 0 && userID > 0:
		row = tx.QueryRowContext(ctx, `SELECT `+sessionColumns+` FROM claudex_web_sessions WHERE id = $1 AND user_id = $2 FOR UPDATE`, id, userID)
	default:
		return nil, errNoSession
	}
	sess, err := scanSession(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errNoSession
	}
	if err != nil {
		return nil, fmt.Errorf("claudex web: read session: %w", err)
	}
	if sess.RevokedAt != nil {
		return sess, nil
	}
	if _, err := tx.ExecContext(ctx, `UPDATE claudex_web_sessions SET revoked_at = $2, revoked_reason = $3 WHERE id = $1`, sess.ID, now, reason); err != nil {
		return nil, fmt.Errorf("claudex web: revoke session: %w", err)
	}
	if err := markFamiliesRevoked(ctx, tx, sess.UserID, []string{sess.FamilyID}, now, revokedUntil); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("claudex web: commit: %w", err)
	}
	t := now
	sess.RevokedAt, sess.RevokedReason = &t, reason
	return sess, nil
}

// revokeAll ends every active session of a user and returns their families.
func (s *store) revokeAll(ctx context.Context, userID int64, reason string, now, revokedUntil time.Time) ([]string, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("claudex web: begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := lockUser(ctx, tx, userID); err != nil {
		return nil, err
	}
	rows, err := tx.QueryContext(ctx, `UPDATE claudex_web_sessions SET revoked_at = $2, revoked_reason = $3
WHERE user_id = $1 AND revoked_at IS NULL RETURNING family_id`, userID, now, reason)
	if err != nil {
		return nil, fmt.Errorf("claudex web: revoke sessions: %w", err)
	}
	families, err := scanFamilies(rows)
	if err != nil {
		return nil, err
	}
	if err := markFamiliesRevoked(ctx, tx, userID, families, now, revokedUntil); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("claudex web: commit: %w", err)
	}
	return families, nil
}

// maxListed bounds a session list (the cap is at most 50 active sessions).
const maxListed = 100

// listActive returns the user's active sessions, newest first.
func (s *store) listActive(ctx context.Context, userID int64, now time.Time) ([]Session, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+sessionColumns+` FROM claudex_web_sessions
WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > $2 ORDER BY created_at DESC, id DESC LIMIT $3`, userID, now, maxListed)
	if err != nil {
		return nil, fmt.Errorf("claudex web: list sessions: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := []Session{}
	for rows.Next() {
		sess, err := scanSession(rows)
		if err != nil {
			return nil, fmt.Errorf("claudex web: scan session: %w", err)
		}
		out = append(out, *sess)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("claudex web: list sessions: %w", err)
	}
	return out, nil
}

// cleanup drops rows that expired or ended more than keep ago.
func (s *store) cleanup(ctx context.Context, now time.Time, keep time.Duration) (int64, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM claudex_web_sessions
WHERE expires_at < $1 OR (revoked_at IS NOT NULL AND revoked_at < $1)`, now.Add(-keep))
	if err != nil {
		return 0, fmt.Errorf("claudex web: cleanup: %w", err)
	}
	n, _ := res.RowsAffected()
	return n, nil
}
