package catalog

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"strconv"
	"strings"

	"github.com/lib/pq"
)

// Scope filter of the admin list.
const (
	scopeAll    = iota // every row
	scopeGlobal        // group_id IS NULL
	scopeGroup         // group_id = GroupID
)

// listFilter selects the rows of GET /admin/claudex/models.
type listFilter struct {
	Scope    int
	GroupID  int64
	Query    string // substring of model_id or display_name (case-insensitive)
	Page     int
	PageSize int
}

// metaStore persists claudex_model_meta. The SQL implementation is sqlStore;
// unit tests use an in-memory fake with the same rules.
type metaStore interface {
	// Scope returns the global rows and, for groupID > 0, the rows of that
	// group unless the group was deleted.
	Scope(ctx context.Context, groupID int64) ([]Row, error)
	List(ctx context.Context, f listFilter) ([]Row, int64, error)
	Get(ctx context.Context, id int64) (*Row, error)
	// Create inserts a row; with IsDefault it clears the other default of the
	// same scope in the same transaction.
	Create(ctx context.Context, in Input, createdBy *int64) (*Row, error)
	// Update replaces the mutable fields of a row (model_id and group_id never
	// change); with IsDefault it clears the other default of the scope.
	Update(ctx context.Context, id int64, in Input) (*Row, error)
	Delete(ctx context.Context, id int64) error
}

// dbFunc returns the shared connection pool (core.Deps.DB), read at call
// time because components are built before their dependencies are used.
type dbFunc func() *sql.DB

type sqlStore struct{ db dbFunc }

var errNoDB = errors.New("claudex catalog: database is not configured")

func (s sqlStore) conn() (*sql.DB, error) {
	if s.db == nil {
		return nil, errNoDB
	}
	db := s.db()
	if db == nil {
		return nil, errNoDB
	}
	return db, nil
}

// rowColumns reads a row with its group (upstream groups are soft-deleted:
// a group row whose group is gone has group_deleted = true).
const rowColumns = `m.id, m.model_id, m.group_id, COALESCE(g.name, ''),
	(m.group_id IS NOT NULL AND g.id IS NULL),
	m.display_name, m.description, m.badges, m.sort_order, m.hidden, m.is_default,
	m.supported_efforts, m.default_effort, m.context_window, m.auto_compact_tokens,
	m.fast_tier, m.usage_hint, m.created_by, m.created_at, m.updated_at, m.minimum_desktop_version`

const rowFrom = ` FROM claudex_model_meta m
	LEFT JOIN groups g ON g.id = m.group_id AND g.deleted_at IS NULL`

type scanner interface{ Scan(dest ...any) error }

func scanRow(sc scanner) (*Row, error) {
	var (
		r                          Row
		groupID, createdBy         sql.NullInt64
		badges, efforts            []byte
		contextWindow, autoCompact sql.NullInt64
		fast                       sql.NullBool
	)
	if err := sc.Scan(&r.ID, &r.ModelID, &groupID, &r.GroupName, &r.GroupDeleted,
		&r.DisplayName, &r.Description, &badges, &r.SortOrder, &r.Hidden, &r.IsDefault,
		&efforts, &r.DefaultEffort, &contextWindow, &autoCompact,
		&fast, &r.UsageHint, &createdBy, &r.CreatedAt, &r.UpdatedAt, &r.MinimumDesktopVersion); err != nil {
		return nil, err
	}
	if groupID.Valid {
		v := groupID.Int64
		r.GroupID = &v
	}
	if createdBy.Valid {
		v := createdBy.Int64
		r.CreatedBy = &v
	}
	if contextWindow.Valid {
		v := int(contextWindow.Int64)
		r.ContextWindow = &v
	}
	if autoCompact.Valid {
		v := int(autoCompact.Int64)
		r.AutoCompactTokens = &v
	}
	if fast.Valid {
		v := fast.Bool
		r.FastTier = &v
	}
	r.Badges = []string{}
	if len(badges) > 0 {
		if err := json.Unmarshal(badges, &r.Badges); err != nil || r.Badges == nil {
			r.Badges = []string{}
		}
	}
	if len(efforts) > 0 && string(efforts) != "null" {
		if err := json.Unmarshal(efforts, &r.SupportedEfforts); err != nil {
			r.SupportedEfforts = nil
		} else if r.SupportedEfforts == nil {
			r.SupportedEfforts = []string{}
		}
	}
	r.CreatedAt = r.CreatedAt.UTC()
	r.UpdatedAt = r.UpdatedAt.UTC()
	return &r, nil
}

func scanRows(rows *sql.Rows) ([]Row, error) {
	defer func() { _ = rows.Close() }()
	var out []Row
	for rows.Next() {
		r, err := scanRow(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *r)
	}
	return out, rows.Err()
}

func (s sqlStore) Scope(ctx context.Context, groupID int64) ([]Row, error) {
	db, err := s.conn()
	if err != nil {
		return nil, err
	}
	rows, err := db.QueryContext(ctx, `SELECT `+rowColumns+rowFrom+`
		WHERE m.group_id IS NULL OR (m.group_id = $1 AND g.id IS NOT NULL)
		ORDER BY m.sort_order, m.model_id, m.id`, groupID)
	if err != nil {
		return nil, err
	}
	return scanRows(rows)
}

// searchText makes a search term safe to send: PostgreSQL rejects NUL and
// invalid UTF-8 in a text parameter, which would turn a mistyped search
// into a 500.
func searchText(q string) string {
	return strings.TrimSpace(strings.ToValidUTF8(strings.ReplaceAll(q, "\x00", ""), ""))
}

// likePattern escapes q for ILIKE ... ESCAPE '\'.
func likePattern(q string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return "%" + r.Replace(q) + "%"
}

func (s sqlStore) List(ctx context.Context, f listFilter) ([]Row, int64, error) {
	db, err := s.conn()
	if err != nil {
		return nil, 0, err
	}
	var (
		where []string
		args  []any
	)
	switch f.Scope {
	case scopeGlobal:
		where = append(where, "m.group_id IS NULL")
	case scopeGroup:
		args = append(args, f.GroupID)
		where = append(where, "m.group_id = $"+strconv.Itoa(len(args)))
	}
	if q := searchText(f.Query); q != "" {
		args = append(args, likePattern(q))
		n := "$" + strconv.Itoa(len(args))
		where = append(where, "(m.model_id ILIKE "+n+` ESCAPE '\' OR m.display_name ILIKE `+n+` ESCAPE '\')`)
	}
	cond := ""
	if len(where) > 0 {
		cond = " WHERE " + strings.Join(where, " AND ")
	}
	var total int64
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM claudex_model_meta m`+cond, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	pageArgs := append(append([]any(nil), args...), f.PageSize, (f.Page-1)*f.PageSize)
	rows, err := db.QueryContext(ctx, `SELECT `+rowColumns+rowFrom+cond+`
		ORDER BY m.group_id NULLS FIRST, m.sort_order, m.model_id, m.id
		LIMIT $`+strconv.Itoa(len(args)+1)+` OFFSET $`+strconv.Itoa(len(args)+2), pageArgs...)
	if err != nil {
		return nil, 0, err
	}
	out, err := scanRows(rows)
	if err != nil {
		return nil, 0, err
	}
	if out == nil {
		out = []Row{}
	}
	return out, total, nil
}

func (s sqlStore) Get(ctx context.Context, id int64) (*Row, error) {
	db, err := s.conn()
	if err != nil {
		return nil, err
	}
	r, err := scanRow(db.QueryRowContext(ctx, `SELECT `+rowColumns+rowFrom+` WHERE m.id = $1`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return r, err
}

// scopeLockKey is the transaction advisory lock of one scope (global = 0):
// writes of the same scope run one after the other, so switching the default
// never races on the one-default index.
func scopeLockKey(groupID *int64) int64 {
	var scope int64
	if groupID != nil {
		scope = *groupID
	}
	h := fnv.New64a()
	_, _ = fmt.Fprintf(h, "claudex_model_meta:%d", scope)
	return int64(h.Sum64()) // any 64-bit value works as an advisory lock key
}

func scopeValue(groupID *int64) int64 {
	if groupID == nil {
		return 0
	}
	return *groupID
}

type writeValues struct {
	badges, efforts []byte
}

func encode(in Input) (writeValues, error) {
	var w writeValues
	badges := in.Badges
	if badges == nil {
		badges = []string{}
	}
	var err error
	if w.badges, err = json.Marshal(badges); err != nil {
		return w, err
	}
	if in.SupportedEfforts != nil {
		if w.efforts, err = json.Marshal(in.SupportedEfforts); err != nil {
			return w, err
		}
	}
	return w, nil
}

func nullableJSON(b []byte) any {
	if b == nil {
		return nil
	}
	return string(b)
}

func nullableInt(v *int) any {
	if v == nil {
		return nil
	}
	return *v
}

func nullableBool(v *bool) any {
	if v == nil {
		return nil
	}
	return *v
}

func nullableInt64(v *int64) any {
	if v == nil {
		return nil
	}
	return *v
}

// withTx runs fn in a transaction holding the scope lock of groupID and, when
// setDefault, clears the other default of the scope first (except keepID).
func (s sqlStore) withTx(ctx context.Context, groupID *int64, setDefault bool, keepID int64, fn func(tx *sql.Tx) error) error {
	db, err := s.conn()
	if err != nil {
		return err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock($1)`, scopeLockKey(groupID)); err != nil {
		return err
	}
	if setDefault {
		if _, err := tx.ExecContext(ctx, `UPDATE claudex_model_meta SET is_default = FALSE, updated_at = NOW()
			WHERE COALESCE(group_id, 0) = $1 AND is_default AND id <> $2`, scopeValue(groupID), keepID); err != nil {
			return err
		}
	}
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}

func (s sqlStore) Create(ctx context.Context, in Input, createdBy *int64) (*Row, error) {
	w, err := encode(in)
	if err != nil {
		return nil, err
	}
	var id int64
	err = s.withTx(ctx, in.GroupID, in.IsDefault, 0, func(tx *sql.Tx) error {
		return tx.QueryRowContext(ctx, `INSERT INTO claudex_model_meta
			(model_id, group_id, display_name, description, badges, sort_order, hidden, is_default,
			 supported_efforts, default_effort, context_window, auto_compact_tokens, fast_tier, usage_hint, created_by, minimum_desktop_version)
			VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15, $16)
			RETURNING id`,
			in.ModelID, nullableInt64(in.GroupID), in.DisplayName, in.Description, string(w.badges), in.SortOrder,
			in.Hidden, in.IsDefault, nullableJSON(w.efforts), in.DefaultEffort, nullableInt(in.ContextWindow),
			nullableInt(in.AutoCompactTokens), nullableBool(in.FastTier), in.UsageHint, nullableInt64(createdBy), in.MinimumDesktopVersion,
		).Scan(&id)
	})
	if err != nil {
		return nil, mapWriteError(err)
	}
	return s.Get(ctx, id)
}

func (s sqlStore) Update(ctx context.Context, id int64, in Input) (*Row, error) {
	db, err := s.conn()
	if err != nil {
		return nil, err
	}
	// group_id never changes, so it can be read before taking the scope lock
	// (taking the lock first keeps the lock order scope -> row everywhere).
	var groupID sql.NullInt64
	if err := db.QueryRowContext(ctx, `SELECT group_id FROM claudex_model_meta WHERE id = $1`, id).Scan(&groupID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	var scope *int64
	if groupID.Valid {
		v := groupID.Int64
		scope = &v
	}
	w, err := encode(in)
	if err != nil {
		return nil, err
	}
	err = s.withTx(ctx, scope, in.IsDefault, id, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `UPDATE claudex_model_meta SET
			display_name = $2, description = $3, badges = $4::jsonb, sort_order = $5, hidden = $6, is_default = $7,
			supported_efforts = $8::jsonb, default_effort = $9, context_window = $10, auto_compact_tokens = $11,
			fast_tier = $12, usage_hint = $13, minimum_desktop_version = $14, updated_at = NOW()
			WHERE id = $1`,
			id, in.DisplayName, in.Description, string(w.badges), in.SortOrder, in.Hidden, in.IsDefault,
			nullableJSON(w.efforts), in.DefaultEffort, nullableInt(in.ContextWindow), nullableInt(in.AutoCompactTokens),
			nullableBool(in.FastTier), in.UsageHint, in.MinimumDesktopVersion)
		if err != nil {
			return err
		}
		if n, err := res.RowsAffected(); err == nil && n == 0 {
			return ErrNotFound
		}
		return nil
	})
	if err != nil {
		return nil, mapWriteError(err)
	}
	return s.Get(ctx, id)
}

func (s sqlStore) Delete(ctx context.Context, id int64) error {
	db, err := s.conn()
	if err != nil {
		return err
	}
	res, err := db.ExecContext(ctx, `DELETE FROM claudex_model_meta WHERE id = $1`, id)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// mapWriteError turns constraint violations into the catalog errors.
func mapWriteError(err error) error {
	var pqErr *pq.Error
	if !errors.As(err, &pqErr) {
		return err
	}
	switch pqErr.Code {
	case "23505": // unique_violation
		if pqErr.Constraint == "uq_claudex_model_meta_default" {
			return ErrDefaultConflict
		}
		return ErrConflict.WithMetadata(map[string]string{"field": "model_id"})
	case "23503": // foreign_key_violation
		if strings.Contains(pqErr.Constraint, "group") {
			return ErrGroupNotFound
		}
	case "23514", "22001": // check_violation, string_data_right_truncation
		return invalid("body", "constraint", "A value is out of range")
	}
	return err
}
