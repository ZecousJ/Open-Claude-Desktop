package memory

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
	"time"
)

// prefsRow is a user's stored switches.
type prefsRow struct {
	SearchChats bool
	Generate    bool
	UpdatedAt   time.Time
}

// docRow is one stored memory document (content still sealed).
type docRow struct {
	Scope        string
	ContentEnc   string
	ContentBytes int
	Revision     int64
	Source       string
	GeneratedAt  *time.Time
	UpdatedAt    time.Time
	CreatedAt    time.Time
}

// editRow is one stored memory edit (text still sealed).
type editRow struct {
	ID        int64
	Scope     string
	TextEnc   string
	TextBytes int
	DeviceID  *int64
	CreatedAt time.Time
}

// docWrite is a document write with optimistic concurrency: BaseRevision 0
// creates the document, any other value must equal the stored revision.
// EditsUpto (generated writes only) deletes the scope's edits with an id up
// to it, in the same transaction: the synthesis folded them in.
type docWrite struct {
	Scope        string
	ContentEnc   string
	ContentBytes int
	Source       string
	BaseRevision int64
	EditsUpto    *int64
	MaxScopes    int
}

// editWrite is a new memory edit.
type editWrite struct {
	Scope       string
	TextEnc     string
	TextBytes   int
	DeviceID    *int64
	MaxPerScope int
	MaxScopes   int
}

// ScopeMeta is the administrator's view of one scope: sizes and times, never
// the text.
type ScopeMeta struct {
	Scope        string     `json:"scope"`
	HasDocument  bool       `json:"has_document"`
	ContentBytes int        `json:"content_bytes"`
	Revision     int64      `json:"revision"`
	Source       *string    `json:"source"`
	GeneratedAt  *time.Time `json:"generated_at"`
	UpdatedAt    *time.Time `json:"updated_at"`
	Edits        int        `json:"edits"`
	EditBytes    int        `json:"edit_bytes"`
}

// Stats is GET /api/v1/admin/claudex/memory/stats (without the key flag,
// which the handler adds).
type Stats struct {
	// UsersOptedIn counts users who turned at least one switch on
	// themselves (users on a default_on policy without a stored choice are
	// not counted).
	UsersOptedIn    int64 `json:"users_opted_in"`
	UsersWithMemory int64 `json:"users_with_memory"`
	Documents       int64 `json:"documents"`
	Edits           int64 `json:"edits"`
	TotalBytes      int64 `json:"total_bytes"`
}

var (
	errNoDatabase = errors.New("claudex memory: database unavailable")
	errScopeLimit = errors.New("claudex memory: too many scopes")
	errEditLimit  = errors.New("claudex memory: too many edits")
)

// conflictError is a stale base revision; Current is the stored revision (0
// when there is no document).
type conflictError struct{ Current int64 }

func (e *conflictError) Error() string {
	return "claudex memory: revision conflict (current " + strconv.FormatInt(e.Current, 10) + ")"
}

// store is the persistence of the component (SQL in production, in memory in
// unit tests).
type store interface {
	prefs(ctx context.Context, userID int64) (*prefsRow, error)
	setPrefs(ctx context.Context, userID int64, searchChats, generate bool) (prefsRow, error)
	// docs lists the user's documents, of one scope when scope is not "".
	docs(ctx context.Context, userID int64, scope string) ([]docRow, error)
	// edits lists the user's edits (oldest first), of one scope when scope is
	// not "".
	edits(ctx context.Context, userID int64, scope string) ([]editRow, error)
	// revisions maps each scope with a document to its revision.
	revisions(ctx context.Context, userID int64) (map[string]int64, error)
	// saveDoc returns *conflictError or errScopeLimit.
	saveDoc(ctx context.Context, userID int64, w docWrite) (docRow, error)
	// deleteScope deletes the document and the edits of one scope.
	deleteScope(ctx context.Context, userID int64, scope string) (docs, edits int64, err error)
	// deleteAll deletes every document and edit of the user (prefs stay).
	deleteAll(ctx context.Context, userID int64) (docs, edits int64, err error)
	// addEdit returns errEditLimit or errScopeLimit.
	addEdit(ctx context.Context, userID int64, w editWrite) (editRow, error)
	deleteEdit(ctx context.Context, userID, id int64) (bool, error)
	stats(ctx context.Context) (Stats, error)
	userExists(ctx context.Context, userID int64) (bool, error)
	// scopeMeta lists the user's scopes (documents and edits) without text.
	scopeMeta(ctx context.Context, userID int64) ([]ScopeMeta, error)
}

// sqlStore keeps memory in claudex_memory_prefs, claudex_memory_docs and
// claudex_memory_edits.
type sqlStore struct{ db *sql.DB }

func (s *sqlStore) ready() error {
	if s == nil || s.db == nil {
		return errNoDatabase
	}
	return nil
}

func (s *sqlStore) prefs(ctx context.Context, userID int64) (*prefsRow, error) {
	if err := s.ready(); err != nil {
		return nil, err
	}
	var p prefsRow
	err := s.db.QueryRowContext(ctx, `SELECT search_chats, generate, updated_at FROM claudex_memory_prefs WHERE user_id = $1`, userID).
		Scan(&p.SearchChats, &p.Generate, &p.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &p, nil
}

func (s *sqlStore) setPrefs(ctx context.Context, userID int64, searchChats, generate bool) (prefsRow, error) {
	if err := s.ready(); err != nil {
		return prefsRow{}, err
	}
	p := prefsRow{}
	err := s.db.QueryRowContext(ctx, `
		INSERT INTO claudex_memory_prefs (user_id, search_chats, generate, updated_at) VALUES ($1, $2, $3, NOW())
		ON CONFLICT (user_id) DO UPDATE SET search_chats = EXCLUDED.search_chats, generate = EXCLUDED.generate, updated_at = NOW()
		RETURNING search_chats, generate, updated_at`, userID, searchChats, generate).
		Scan(&p.SearchChats, &p.Generate, &p.UpdatedAt)
	return p, err
}

const docColumns = `scope, content_enc, content_bytes, revision, source, generated_at, updated_at, created_at`

type scanner interface{ Scan(dest ...any) error }

func scanDoc(r scanner) (docRow, error) {
	var d docRow
	var generated sql.NullTime
	if err := r.Scan(&d.Scope, &d.ContentEnc, &d.ContentBytes, &d.Revision, &d.Source, &generated, &d.UpdatedAt, &d.CreatedAt); err != nil {
		return d, err
	}
	if generated.Valid {
		t := generated.Time
		d.GeneratedAt = &t
	}
	return d, nil
}

func (s *sqlStore) docs(ctx context.Context, userID int64, scope string) ([]docRow, error) {
	if err := s.ready(); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT `+docColumns+` FROM claudex_memory_docs
		WHERE user_id = $1 AND ($2 = '' OR scope = $2) ORDER BY scope`, userID, scope)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []docRow{}
	for rows.Next() {
		d, err := scanDoc(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func (s *sqlStore) edits(ctx context.Context, userID int64, scope string) ([]editRow, error) {
	if err := s.ready(); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id, scope, text_enc, text_bytes, device_id, created_at FROM claudex_memory_edits
		WHERE user_id = $1 AND ($2 = '' OR scope = $2) ORDER BY scope, id`, userID, scope)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []editRow{}
	for rows.Next() {
		var e editRow
		var device sql.NullInt64
		if err := rows.Scan(&e.ID, &e.Scope, &e.TextEnc, &e.TextBytes, &device, &e.CreatedAt); err != nil {
			return nil, err
		}
		if device.Valid {
			v := device.Int64
			e.DeviceID = &v
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func (s *sqlStore) revisions(ctx context.Context, userID int64) (map[string]int64, error) {
	if err := s.ready(); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT scope, revision FROM claudex_memory_docs WHERE user_id = $1`, userID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := map[string]int64{}
	for rows.Next() {
		var scope string
		var rev int64
		if err := rows.Scan(&scope, &rev); err != nil {
			return nil, err
		}
		out[scope] = rev
	}
	return out, rows.Err()
}

// withUserLock runs fn in a transaction holding the user's memory lock, so
// revision checks and the scope and edit counts cannot race.
func (s *sqlStore) withUserLock(ctx context.Context, userID int64, fn func(tx *sql.Tx) error) (err error) {
	if err := s.ready(); err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
		"claudex_memory:"+strconv.FormatInt(userID, 10)); err != nil {
		return err
	}
	if err = fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}

// otherScopes counts the user's scopes (documents or edits) other than scope.
func otherScopes(ctx context.Context, tx *sql.Tx, userID int64, scope string) (int, error) {
	var n int
	err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM (
		SELECT scope FROM claudex_memory_docs WHERE user_id = $1 AND scope <> $2
		UNION SELECT scope FROM claudex_memory_edits WHERE user_id = $1 AND scope <> $2) s`, userID, scope).Scan(&n)
	return n, err
}

// hasScope reports whether the user already has a document or edit in scope.
func hasScope(ctx context.Context, tx *sql.Tx, userID int64, scope string) (bool, error) {
	var ok bool
	err := tx.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM claudex_memory_docs WHERE user_id = $1 AND scope = $2)
		OR EXISTS (SELECT 1 FROM claudex_memory_edits WHERE user_id = $1 AND scope = $2)`, userID, scope).Scan(&ok)
	return ok, err
}

func checkScopeRoom(ctx context.Context, tx *sql.Tx, userID int64, scope string, maxScopes int) error {
	exists, err := hasScope(ctx, tx, userID, scope)
	if err != nil || exists {
		return err
	}
	n, err := otherScopes(ctx, tx, userID, scope)
	if err != nil {
		return err
	}
	if n >= maxScopes {
		return errScopeLimit
	}
	return nil
}

func (s *sqlStore) saveDoc(ctx context.Context, userID int64, w docWrite) (docRow, error) {
	var saved docRow
	err := s.withUserLock(ctx, userID, func(tx *sql.Tx) error {
		var current int64
		err := tx.QueryRowContext(ctx, `SELECT revision FROM claudex_memory_docs WHERE user_id = $1 AND scope = $2`, userID, w.Scope).Scan(&current)
		switch {
		case errors.Is(err, sql.ErrNoRows):
			current = 0
		case err != nil:
			return err
		}
		if current != w.BaseRevision {
			return &conflictError{Current: current}
		}
		generated := w.Source == SourceGenerated
		if current == 0 {
			if err := checkScopeRoom(ctx, tx, userID, w.Scope, w.MaxScopes); err != nil {
				return err
			}
			saved, err = scanDoc(tx.QueryRowContext(ctx, `
				INSERT INTO claudex_memory_docs (user_id, scope, content_enc, content_bytes, revision, source, generated_at, updated_at, created_at)
				VALUES ($1, $2, $3, $4, 1, $5, CASE WHEN $6 THEN NOW() END, NOW(), NOW())
				RETURNING `+docColumns, userID, w.Scope, w.ContentEnc, w.ContentBytes, w.Source, generated))
		} else {
			saved, err = scanDoc(tx.QueryRowContext(ctx, `
				UPDATE claudex_memory_docs SET content_enc = $3, content_bytes = $4, revision = revision + 1, source = $5,
					generated_at = CASE WHEN $6 THEN NOW() ELSE generated_at END, updated_at = NOW()
				WHERE user_id = $1 AND scope = $2
				RETURNING `+docColumns, userID, w.Scope, w.ContentEnc, w.ContentBytes, w.Source, generated))
		}
		if err != nil {
			return err
		}
		if w.EditsUpto != nil {
			if _, err := tx.ExecContext(ctx, `DELETE FROM claudex_memory_edits WHERE user_id = $1 AND scope = $2 AND id <= $3`,
				userID, w.Scope, *w.EditsUpto); err != nil {
				return err
			}
		}
		return nil
	})
	return saved, err
}

func (s *sqlStore) deleteScope(ctx context.Context, userID int64, scope string) (docs, edits int64, err error) {
	err = s.withUserLock(ctx, userID, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `DELETE FROM claudex_memory_docs WHERE user_id = $1 AND scope = $2`, userID, scope)
		if err != nil {
			return err
		}
		docs, _ = res.RowsAffected()
		res, err = tx.ExecContext(ctx, `DELETE FROM claudex_memory_edits WHERE user_id = $1 AND scope = $2`, userID, scope)
		if err != nil {
			return err
		}
		edits, _ = res.RowsAffected()
		return nil
	})
	return docs, edits, err
}

func (s *sqlStore) deleteAll(ctx context.Context, userID int64) (docs, edits int64, err error) {
	err = s.withUserLock(ctx, userID, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `DELETE FROM claudex_memory_docs WHERE user_id = $1`, userID)
		if err != nil {
			return err
		}
		docs, _ = res.RowsAffected()
		res, err = tx.ExecContext(ctx, `DELETE FROM claudex_memory_edits WHERE user_id = $1`, userID)
		if err != nil {
			return err
		}
		edits, _ = res.RowsAffected()
		return nil
	})
	return docs, edits, err
}

func (s *sqlStore) addEdit(ctx context.Context, userID int64, w editWrite) (editRow, error) {
	var saved editRow
	err := s.withUserLock(ctx, userID, func(tx *sql.Tx) error {
		if err := checkScopeRoom(ctx, tx, userID, w.Scope, w.MaxScopes); err != nil {
			return err
		}
		var n int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM claudex_memory_edits WHERE user_id = $1 AND scope = $2`,
			userID, w.Scope).Scan(&n); err != nil {
			return err
		}
		if n >= w.MaxPerScope {
			return errEditLimit
		}
		saved = editRow{Scope: w.Scope, TextEnc: w.TextEnc, TextBytes: w.TextBytes, DeviceID: w.DeviceID}
		return tx.QueryRowContext(ctx, `
			INSERT INTO claudex_memory_edits (user_id, scope, text_enc, text_bytes, device_id, created_at)
			VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING id, created_at`,
			userID, w.Scope, w.TextEnc, w.TextBytes, w.DeviceID).Scan(&saved.ID, &saved.CreatedAt)
	})
	return saved, err
}

func (s *sqlStore) deleteEdit(ctx context.Context, userID, id int64) (bool, error) {
	if err := s.ready(); err != nil {
		return false, err
	}
	res, err := s.db.ExecContext(ctx, `DELETE FROM claudex_memory_edits WHERE user_id = $1 AND id = $2`, userID, id)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

func (s *sqlStore) stats(ctx context.Context) (Stats, error) {
	var st Stats
	if err := s.ready(); err != nil {
		return st, err
	}
	err := s.db.QueryRowContext(ctx, `SELECT
		(SELECT COUNT(*) FROM claudex_memory_prefs WHERE search_chats OR generate),
		(SELECT COUNT(*) FROM (SELECT user_id FROM claudex_memory_docs UNION SELECT user_id FROM claudex_memory_edits) u),
		(SELECT COUNT(*) FROM claudex_memory_docs),
		(SELECT COUNT(*) FROM claudex_memory_edits),
		(SELECT COALESCE(SUM(content_bytes), 0) FROM claudex_memory_docs) + (SELECT COALESCE(SUM(text_bytes), 0) FROM claudex_memory_edits)`).
		Scan(&st.UsersOptedIn, &st.UsersWithMemory, &st.Documents, &st.Edits, &st.TotalBytes)
	return st, err
}

func (s *sqlStore) userExists(ctx context.Context, userID int64) (bool, error) {
	if err := s.ready(); err != nil {
		return false, err
	}
	var ok bool
	err := s.db.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM users WHERE id = $1)`, userID).Scan(&ok)
	return ok, err
}

func (s *sqlStore) scopeMeta(ctx context.Context, userID int64) ([]ScopeMeta, error) {
	if err := s.ready(); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `
		WITH e AS (
			SELECT scope, COUNT(*) AS n, COALESCE(SUM(text_bytes), 0) AS bytes
			FROM claudex_memory_edits WHERE user_id = $1 GROUP BY scope
		), d AS (
			SELECT scope, content_bytes, revision, source, generated_at, updated_at
			FROM claudex_memory_docs WHERE user_id = $1
		)
		SELECT COALESCE(d.scope, e.scope), d.scope IS NOT NULL, COALESCE(d.content_bytes, 0), COALESCE(d.revision, 0),
			d.source, d.generated_at, d.updated_at, COALESCE(e.n, 0), COALESCE(e.bytes, 0)
		FROM d FULL OUTER JOIN e ON d.scope = e.scope
		ORDER BY 1`, userID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []ScopeMeta{}
	for rows.Next() {
		var m ScopeMeta
		var source sql.NullString
		var generated, updated sql.NullTime
		if err := rows.Scan(&m.Scope, &m.HasDocument, &m.ContentBytes, &m.Revision, &source, &generated, &updated, &m.Edits, &m.EditBytes); err != nil {
			return nil, err
		}
		if source.Valid {
			v := source.String
			m.Source = &v
		}
		if generated.Valid {
			v := generated.Time
			m.GeneratedAt = &v
		}
		if updated.Valid {
			v := updated.Time
			m.UpdatedAt = &v
		}
		out = append(out, m)
	}
	return out, rows.Err()
}
