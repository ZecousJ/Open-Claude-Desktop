package usage

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/lib/pq"
)

// counterRow is the current window of one (rule, user) pair.
type counterRow struct {
	RuleID       int64
	UserID       int64
	UserEmail    *string
	WindowStart  time.Time
	WindowEnd    time.Time
	UsedUSD      float64
	RequestCount int64
	UpdatedAt    time.Time
}

// usageAddition is one billed request to add to the counters of some rules.
type usageAddition struct {
	UserID  int64
	At      time.Time
	CostUSD float64
	RuleIDs []int64
}

// store is the persistence of the usage rules. sqlStore is the only
// production implementation; tests use fakes to count queries.
type store interface {
	// enabledRules returns every enabled rule whose group still exists (or
	// that applies to every group).
	enabledRules(ctx context.Context) ([]activeRule, error)
	// counters returns the counter rows of a user for the given rules (one
	// query, primary-key lookups).
	counters(ctx context.Context, userID int64, ruleIDs []int64) (map[int64]counterRow, error)
	// accumulate adds one billed request to the counters of the rules, opening
	// a new window where the previous one ended (one statement).
	accumulate(ctx context.Context, add usageAddition) error

	listRules(ctx context.Context, groupID *int64) ([]Rule, error)
	getRule(ctx context.Context, id int64) (*Rule, error)
	createRule(ctx context.Context, f ruleFields, createdBy *int64) (int64, error)
	updateRule(ctx context.Context, id int64, f ruleFields) error
	deleteRule(ctx context.Context, id int64) error
	listCounters(ctx context.Context, ruleID int64, userID *int64, limit, offset int) ([]counterRow, int64, error)
	resetCounter(ctx context.Context, ruleID, userID int64) error
	groupExists(ctx context.Context, id int64) (bool, error)
}

var errNoDB = errors.New("claudex usage: no database")

// sqlStore keeps the rules in claudex_usage_rules and claudex_usage_counters
// (migrations/claudex_0030_usage_rules.sql) on the shared *sql.DB (lib/pq:
// every parameter carries an explicit cast, arrays go through pq.Array).
type sqlStore struct {
	db func() *sql.DB
}

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

const selectEnabledRules = `
SELECT r.id, r.group_id, r.kind, r.label, r.model_patterns, r.window_seconds, r.limit_usd, r.show_in_client, r.sort_order
FROM claudex_usage_rules r
WHERE r.enabled
  AND (r.group_id IS NULL OR EXISTS (SELECT 1 FROM groups g WHERE g.id = r.group_id AND g.deleted_at IS NULL))
ORDER BY r.sort_order, r.id`

func (s sqlStore) enabledRules(ctx context.Context) ([]activeRule, error) {
	db, err := s.conn()
	if err != nil {
		return nil, err
	}
	rows, err := db.QueryContext(ctx, selectEnabledRules)
	if err != nil {
		return nil, fmt.Errorf("load usage rules: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []activeRule
	for rows.Next() {
		var r activeRule
		var group sql.NullInt64
		var patterns []byte
		if err := rows.Scan(&r.ID, &group, &r.Kind, &r.Label, &patterns, &r.WindowSeconds, &r.LimitUSD, &r.ShowInClient, &r.SortOrder); err != nil {
			return nil, fmt.Errorf("scan usage rule: %w", err)
		}
		if group.Valid {
			g := group.Int64
			r.GroupID = &g
		}
		r.Patterns = decodePatterns(patterns)
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("load usage rules: %w", err)
	}
	return out, nil
}

// selectCounters is the precheck query of design 2.6.
const selectCounters = `SELECT rule_id, window_start, window_end, used_usd, request_count FROM claudex_usage_counters WHERE user_id = $1::bigint AND rule_id = ANY($2::bigint[])`

func (s sqlStore) counters(ctx context.Context, userID int64, ruleIDs []int64) (map[int64]counterRow, error) {
	db, err := s.conn()
	if err != nil {
		return nil, err
	}
	rows, err := db.QueryContext(ctx, selectCounters, userID, pq.Array(ruleIDs))
	if err != nil {
		return nil, fmt.Errorf("read usage counters: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := make(map[int64]counterRow, len(ruleIDs))
	for rows.Next() {
		row := counterRow{UserID: userID}
		if err := rows.Scan(&row.RuleID, &row.WindowStart, &row.WindowEnd, &row.UsedUSD, &row.RequestCount); err != nil {
			return nil, fmt.Errorf("scan usage counter: %w", err)
		}
		out[row.RuleID] = row
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read usage counters: %w", err)
	}
	return out, nil
}

// upsertCounters is the UPSERT of design 2.6 for every matching rule in one
// statement: $2 is the billing time, $3 the billed cost (0 still counts the
// request) and the window length comes from the rule row, so a changed
// window_seconds applies from the next window on and a rule deleted or
// disabled meanwhile is skipped. Column references in SET read the old row,
// so every CASE compares against the stored window. A window whose end is at
// or before the billing time is replaced by a new one starting then. Rows are
// written in rule id order, so concurrent statements for one user lock the
// counter rows in the same order and cannot deadlock.
const upsertCounters = `
INSERT INTO claudex_usage_counters AS c (rule_id, user_id, window_start, window_end, used_usd, request_count, updated_at)
SELECT r.id, $1::bigint, $2::timestamptz, $2::timestamptz + make_interval(secs => r.window_seconds::double precision), $3::numeric, 1, NOW()
FROM claudex_usage_rules r
WHERE r.id = ANY($4::bigint[]) AND r.enabled
ORDER BY r.id
ON CONFLICT (rule_id, user_id) DO UPDATE SET
  window_start  = CASE WHEN c.window_end <= EXCLUDED.window_start THEN EXCLUDED.window_start ELSE c.window_start END,
  window_end    = CASE WHEN c.window_end <= EXCLUDED.window_start THEN EXCLUDED.window_end ELSE c.window_end END,
  used_usd      = CASE WHEN c.window_end <= EXCLUDED.window_start THEN EXCLUDED.used_usd ELSE c.used_usd + EXCLUDED.used_usd END,
  request_count = CASE WHEN c.window_end <= EXCLUDED.window_start THEN 1 ELSE c.request_count + 1 END,
  updated_at    = NOW()`

func (s sqlStore) accumulate(ctx context.Context, add usageAddition) error {
	db, err := s.conn()
	if err != nil {
		return err
	}
	if len(add.RuleIDs) == 0 {
		return nil
	}
	if _, err := db.ExecContext(ctx, upsertCounters, add.UserID, add.At.UTC(), add.CostUSD, pq.Array(add.RuleIDs)); err != nil {
		return fmt.Errorf("add usage to counters: %w", err)
	}
	return nil
}

const selectRules = `
SELECT r.id, r.group_id, g.name, (r.group_id IS NOT NULL AND g.id IS NULL), r.kind, r.label, r.model_patterns,
       r.window_seconds, r.limit_usd, r.enabled, r.show_in_client, r.sort_order, r.created_by, r.created_at, r.updated_at
FROM claudex_usage_rules r
LEFT JOIN groups g ON g.id = r.group_id AND g.deleted_at IS NULL`

func (s sqlStore) listRules(ctx context.Context, groupID *int64) ([]Rule, error) {
	db, err := s.conn()
	if err != nil {
		return nil, err
	}
	rows, err := db.QueryContext(ctx, selectRules+`
WHERE ($1::bigint IS NULL OR r.group_id = $1::bigint)
ORDER BY r.group_id NULLS FIRST, r.sort_order, r.id`, nullInt64(groupID))
	if err != nil {
		return nil, fmt.Errorf("list usage rules: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := []Rule{}
	for rows.Next() {
		r, err := scanRule(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list usage rules: %w", err)
	}
	return out, nil
}

func (s sqlStore) getRule(ctx context.Context, id int64) (*Rule, error) {
	db, err := s.conn()
	if err != nil {
		return nil, err
	}
	r, err := scanRule(db.QueryRowContext(ctx, selectRules+` WHERE r.id = $1::bigint`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrRuleNotFound
	}
	return r, err
}

type rowScanner interface{ Scan(dest ...any) error }

func scanRule(row rowScanner) (*Rule, error) {
	var r Rule
	var group, createdBy sql.NullInt64
	var groupName sql.NullString
	var patterns []byte
	if err := row.Scan(&r.ID, &group, &groupName, &r.GroupDeleted, &r.Kind, &r.Label, &patterns,
		&r.WindowSeconds, &r.LimitUSD, &r.Enabled, &r.ShowInClient, &r.SortOrder, &createdBy, &r.CreatedAt, &r.UpdatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		return nil, fmt.Errorf("scan usage rule: %w", err)
	}
	if group.Valid {
		g := group.Int64
		r.GroupID = &g
	}
	if groupName.Valid {
		n := groupName.String
		r.GroupName = &n
	}
	if createdBy.Valid {
		u := createdBy.Int64
		r.CreatedBy = &u
	}
	r.ModelPatterns = decodePatterns(patterns)
	r.LimitUSD = roundUSD(r.LimitUSD)
	r.CreatedAt = r.CreatedAt.UTC()
	r.UpdatedAt = r.UpdatedAt.UTC()
	return &r, nil
}

func (s sqlStore) createRule(ctx context.Context, f ruleFields, createdBy *int64) (int64, error) {
	db, err := s.conn()
	if err != nil {
		return 0, err
	}
	patterns, err := json.Marshal(f.ModelPatterns)
	if err != nil {
		return 0, err
	}
	var id int64
	err = db.QueryRowContext(ctx, `
INSERT INTO claudex_usage_rules (group_id, kind, label, model_patterns, window_seconds, limit_usd, enabled, show_in_client, sort_order, created_by)
VALUES ($1::bigint, $2::text, $3::text, $4::jsonb, $5::int, $6::numeric, $7::boolean, $8::boolean, $9::int, $10::bigint)
RETURNING id`,
		nullInt64(f.GroupID), f.Kind, f.Label, string(patterns), f.WindowSeconds, f.LimitUSD, f.Enabled, f.ShowInClient, f.SortOrder, nullInt64(createdBy),
	).Scan(&id)
	if err != nil {
		return 0, mapWriteError(fmt.Errorf("create usage rule: %w", err))
	}
	return id, nil
}

func (s sqlStore) updateRule(ctx context.Context, id int64, f ruleFields) error {
	db, err := s.conn()
	if err != nil {
		return err
	}
	patterns, err := json.Marshal(f.ModelPatterns)
	if err != nil {
		return err
	}
	res, err := db.ExecContext(ctx, `
UPDATE claudex_usage_rules SET group_id = $2::bigint, kind = $3::text, label = $4::text, model_patterns = $5::jsonb,
  window_seconds = $6::int, limit_usd = $7::numeric, enabled = $8::boolean, show_in_client = $9::boolean, sort_order = $10::int,
  updated_at = NOW()
WHERE id = $1::bigint`,
		id, nullInt64(f.GroupID), f.Kind, f.Label, string(patterns), f.WindowSeconds, f.LimitUSD, f.Enabled, f.ShowInClient, f.SortOrder)
	if err != nil {
		return mapWriteError(fmt.Errorf("update usage rule: %w", err))
	}
	if n, err := res.RowsAffected(); err == nil && n == 0 {
		return ErrRuleNotFound
	}
	return nil
}

func (s sqlStore) deleteRule(ctx context.Context, id int64) error {
	db, err := s.conn()
	if err != nil {
		return err
	}
	res, err := db.ExecContext(ctx, `DELETE FROM claudex_usage_rules WHERE id = $1::bigint`, id)
	if err != nil {
		return fmt.Errorf("delete usage rule: %w", err)
	}
	if n, err := res.RowsAffected(); err == nil && n == 0 {
		return ErrRuleNotFound
	}
	return nil
}

func (s sqlStore) listCounters(ctx context.Context, ruleID int64, userID *int64, limit, offset int) ([]counterRow, int64, error) {
	db, err := s.conn()
	if err != nil {
		return nil, 0, err
	}
	var total int64
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM claudex_usage_counters WHERE rule_id = $1::bigint AND ($2::bigint IS NULL OR user_id = $2::bigint)`,
		ruleID, nullInt64(userID)).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count usage counters: %w", err)
	}
	rows, err := db.QueryContext(ctx, `
SELECT c.user_id, u.email, c.window_start, c.window_end, c.used_usd, c.request_count, c.updated_at
FROM claudex_usage_counters c
LEFT JOIN users u ON u.id = c.user_id AND u.deleted_at IS NULL
WHERE c.rule_id = $1::bigint AND ($2::bigint IS NULL OR c.user_id = $2::bigint)
ORDER BY c.updated_at DESC, c.user_id
LIMIT $3::int OFFSET $4::int`, ruleID, nullInt64(userID), limit, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("list usage counters: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := []counterRow{}
	for rows.Next() {
		row := counterRow{RuleID: ruleID}
		var email sql.NullString
		if err := rows.Scan(&row.UserID, &email, &row.WindowStart, &row.WindowEnd, &row.UsedUSD, &row.RequestCount, &row.UpdatedAt); err != nil {
			return nil, 0, fmt.Errorf("scan usage counter: %w", err)
		}
		if email.Valid {
			e := email.String
			row.UserEmail = &e
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("list usage counters: %w", err)
	}
	return out, total, nil
}

func (s sqlStore) resetCounter(ctx context.Context, ruleID, userID int64) error {
	db, err := s.conn()
	if err != nil {
		return err
	}
	if _, err := db.ExecContext(ctx, `DELETE FROM claudex_usage_counters WHERE rule_id = $1::bigint AND user_id = $2::bigint`, ruleID, userID); err != nil {
		return fmt.Errorf("reset usage counter: %w", err)
	}
	return nil
}

func (s sqlStore) groupExists(ctx context.Context, id int64) (bool, error) {
	db, err := s.conn()
	if err != nil {
		return false, err
	}
	var ok bool
	if err := db.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM groups WHERE id = $1::bigint AND deleted_at IS NULL)`, id).Scan(&ok); err != nil {
		return false, fmt.Errorf("look up group: %w", err)
	}
	return ok, nil
}

func nullInt64(v *int64) sql.NullInt64 {
	if v == nil {
		return sql.NullInt64{}
	}
	return sql.NullInt64{Int64: *v, Valid: true}
}

func decodePatterns(raw []byte) []string {
	var patterns []string
	if len(raw) == 0 || json.Unmarshal(raw, &patterns) != nil || len(patterns) == 0 {
		return []string{"*"}
	}
	return patterns
}

// mapWriteError turns the foreign-key violation of a group deleted between
// the check and the write into CLAUDEX_GROUP_NOT_FOUND.
func mapWriteError(err error) error {
	var pqErr *pq.Error
	if errors.As(err, &pqErr) && pqErr.Code == "23503" && strings.Contains(pqErr.Constraint, "group") {
		return ErrGroupMissing
	}
	return err
}

// isPermanent reports errors a retry can never fix (the user row is gone).
func isPermanent(err error) bool {
	var pqErr *pq.Error
	return errors.As(err, &pqErr) && pqErr.Code == "23503"
}
