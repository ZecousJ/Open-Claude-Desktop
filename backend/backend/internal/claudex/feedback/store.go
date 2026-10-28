package feedback

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Diagnostic is one stored diagnostic report (admin API).
type Diagnostic struct {
	ID           int64           `json:"id"`
	ReportUUID   string          `json:"report_uuid"`
	UserID       int64           `json:"user_id"`
	UserEmail    string          `json:"user_email"`
	DeviceID     *int64          `json:"device_id"`
	Kind         string          `json:"kind"`
	Code         string          `json:"code"`
	Message      string          `json:"message"`
	RequestID    string          `json:"request_id"`
	Model        string          `json:"model"`
	AppVersion   string          `json:"app_version"`
	CodexVersion string          `json:"codex_version"`
	Platform     string          `json:"platform"`
	Arch         string          `json:"arch"`
	OSVersion    string          `json:"os_version"`
	Context      json.RawMessage `json:"context"`
	OccurredAt   time.Time       `json:"occurred_at"`
	CreatedAt    time.Time       `json:"created_at"`
}

// Feedback is one stored reply feedback (admin API). ConversationExcerpt is
// only filled on the detail view; lists carry HasExcerpt.
type Feedback struct {
	ID                  int64     `json:"id"`
	FeedbackUUID        string    `json:"feedback_uuid"`
	UserID              int64     `json:"user_id"`
	UserEmail           string    `json:"user_email"`
	Rating              string    `json:"rating"`
	Categories          []string  `json:"categories"`
	Comment             string    `json:"comment"`
	Model               string    `json:"model"`
	RequestID           string    `json:"request_id"`
	HasExcerpt          bool      `json:"has_excerpt"`
	ConversationExcerpt *string   `json:"conversation_excerpt,omitempty"`
	AppVersion          string    `json:"app_version"`
	Platform            string    `json:"platform"`
	CreatedAt           time.Time `json:"created_at"`
}

// diagnosticRow is a sanitized report ready to insert.
type diagnosticRow struct {
	ReportUUID   string
	DeviceID     *int64
	Kind         string
	Code         string
	Message      string
	RequestID    string
	Model        string
	AppVersion   string
	CodexVersion string
	Platform     string
	Arch         string
	OSVersion    string
	Context      map[string]any
	OccurredAt   time.Time
}

// feedbackRow is a sanitized reply feedback ready to insert.
type feedbackRow struct {
	FeedbackUUID        string
	Rating              string
	Categories          []string
	Comment             string
	Model               string
	RequestID           string
	ConversationExcerpt *string
	AppVersion          string
	Platform            string
}

// insertResult counts the outcome of an intake request. Dropped reports were
// new but over the user's daily cap; RetryAfter is then the time until the
// oldest counted report leaves the rolling 24-hour window.
type insertResult struct {
	Accepted   int
	Duplicates int
	Dropped    int
	RetryAfter time.Duration
}

type diagnosticsFilter struct {
	UserID     int64
	Code       string
	Kind       string
	AppVersion string
	From, To   *time.Time
	Page, Size int
}

type feedbackFilter struct {
	UserID     int64
	Rating     string
	From, To   *time.Time
	Page, Size int
}

// store is the persistence of the component (SQL in production, in memory in
// unit tests).
type store interface {
	insertDiagnostics(ctx context.Context, userID int64, rows []diagnosticRow, dailyCap int) (insertResult, error)
	insertFeedback(ctx context.Context, userID int64, row feedbackRow, dailyCap int) (insertResult, error)
	listDiagnostics(ctx context.Context, f diagnosticsFilter) ([]Diagnostic, int64, error)
	getDiagnostic(ctx context.Context, id int64) (*Diagnostic, error)
	deleteDiagnostic(ctx context.Context, id int64) (bool, error)
	listFeedback(ctx context.Context, f feedbackFilter) ([]Feedback, int64, error)
	getFeedback(ctx context.Context, id int64) (*Feedback, error)
	deleteFeedback(ctx context.Context, id int64) (bool, error)
	// purge deletes up to batch rows of table created before cutoff.
	purge(ctx context.Context, table string, cutoff time.Time, batch int) (int64, error)
}

// capWindow is the rolling window of the per-user daily caps.
const capWindow = 24 * time.Hour

var errNoDatabase = errors.New("claudex feedback: database unavailable")

const (
	tableDiagnostics = "claudex_diagnostics"
	tableFeedback    = "claudex_feedback"
)

// sqlStore keeps the reports in claudex_diagnostics and claudex_feedback.
type sqlStore struct{ db *sql.DB }

// lockUser serializes intake per user and table inside tx, so concurrent
// batches cannot overshoot the daily cap.
func lockUser(ctx context.Context, tx *sql.Tx, table string, userID int64) error {
	_, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
		table+":"+strconv.FormatInt(userID, 10))
	return err
}

// usedToday counts the user's rows of the last 24 hours and returns the
// oldest one's time (zero when none).
func usedToday(ctx context.Context, tx *sql.Tx, table string, userID int64) (int, time.Time, error) {
	var n int
	var oldest sql.NullTime
	err := tx.QueryRowContext(ctx, `SELECT COUNT(*), MIN(created_at) FROM `+table+
		` WHERE user_id = $1 AND created_at > NOW() - INTERVAL '24 hours'`, userID).Scan(&n, &oldest)
	if err != nil {
		return 0, time.Time{}, err
	}
	return n, oldest.Time, nil
}

func retryAfter(oldest time.Time) time.Duration {
	if oldest.IsZero() {
		return time.Minute
	}
	d := time.Until(oldest.Add(capWindow))
	if d < time.Second {
		d = time.Second
	}
	return d
}

func (s *sqlStore) insertDiagnostics(ctx context.Context, userID int64, rows []diagnosticRow, dailyCap int) (res insertResult, err error) {
	if s == nil || s.db == nil {
		return res, errNoDatabase
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return res, err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()
	if err = lockUser(ctx, tx, tableDiagnostics, userID); err != nil {
		return res, err
	}
	used, oldest, err := usedToday(ctx, tx, tableDiagnostics, userID)
	if err != nil {
		return res, err
	}
	remaining := dailyCap - used
	for _, r := range rows {
		if remaining <= 0 {
			var exists bool
			if err = tx.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM claudex_diagnostics WHERE user_id = $1 AND report_uuid = $2::uuid)`,
				userID, r.ReportUUID).Scan(&exists); err != nil {
				return res, err
			}
			if exists {
				res.Duplicates++
			} else {
				res.Dropped++
			}
			continue
		}
		ctxJSON, merr := json.Marshal(r.Context)
		if merr != nil || r.Context == nil {
			ctxJSON = []byte("{}")
		}
		var result sql.Result
		result, err = tx.ExecContext(ctx, `INSERT INTO claudex_diagnostics
  (report_uuid, user_id, device_id, kind, code, message, request_id, model, app_version, codex_version,
   platform, arch, os_version, context, occurred_at)
VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15)
ON CONFLICT (user_id, report_uuid) DO NOTHING`,
			r.ReportUUID, userID, nullInt64(r.DeviceID), r.Kind, r.Code, r.Message, r.RequestID, r.Model, r.AppVersion,
			r.CodexVersion, r.Platform, r.Arch, r.OSVersion, string(ctxJSON), r.OccurredAt.UTC())
		if err != nil {
			return res, err
		}
		n, rerr := result.RowsAffected()
		if rerr != nil {
			err = rerr
			return res, err
		}
		if n == 0 {
			res.Duplicates++
			continue
		}
		res.Accepted++
		remaining--
		if oldest.IsZero() {
			oldest = time.Now()
		}
	}
	if res.Dropped > 0 {
		res.RetryAfter = retryAfter(oldest)
	}
	err = tx.Commit()
	return res, err
}

func (s *sqlStore) insertFeedback(ctx context.Context, userID int64, row feedbackRow, dailyCap int) (res insertResult, err error) {
	if s == nil || s.db == nil {
		return res, errNoDatabase
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return res, err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()
	if err = lockUser(ctx, tx, tableFeedback, userID); err != nil {
		return res, err
	}
	var exists bool
	if err = tx.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM claudex_feedback WHERE user_id = $1 AND feedback_uuid = $2::uuid UNION ALL SELECT 1 FROM claudex_feedback_withdrawals WHERE user_id = $1 AND feedback_uuid = $2::uuid)`,
		userID, row.FeedbackUUID).Scan(&exists); err != nil {
		return res, err
	}
	if exists {
		res.Duplicates = 1
		err = tx.Commit()
		return res, err
	}
	used, oldest, err := usedToday(ctx, tx, tableFeedback, userID)
	if err != nil {
		return res, err
	}
	if used >= dailyCap {
		res.Dropped = 1
		res.RetryAfter = retryAfter(oldest)
		err = tx.Commit()
		return res, err
	}
	categories := row.Categories
	if categories == nil {
		categories = []string{}
	}
	catJSON, err := json.Marshal(categories)
	if err != nil {
		return res, err
	}
	var excerpt sql.NullString
	if row.ConversationExcerpt != nil {
		excerpt = sql.NullString{String: *row.ConversationExcerpt, Valid: true}
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO claudex_feedback
  (feedback_uuid, user_id, rating, categories, comment, model, request_id, conversation_excerpt, app_version, platform)
VALUES ($1::uuid, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10)`,
		row.FeedbackUUID, userID, row.Rating, string(catJSON), row.Comment, row.Model, row.RequestID, excerpt,
		row.AppVersion, row.Platform); err != nil {
		return res, err
	}
	res.Accepted = 1
	err = tx.Commit()
	return res, err
}

func nullInt64(v *int64) any {
	if v == nil {
		return nil
	}
	return *v
}

// where builds "WHERE a AND b" with numbered parameters.
type where struct {
	parts []string
	args  []any
}

func (w *where) add(cond string, arg any) {
	w.args = append(w.args, arg)
	w.parts = append(w.parts, strings.ReplaceAll(cond, "?", "$"+strconv.Itoa(len(w.args))))
}

func (w *where) String() string {
	if len(w.parts) == 0 {
		return ""
	}
	return " WHERE " + strings.Join(w.parts, " AND ")
}

func (w *where) timeRange(column string, from, to *time.Time) {
	if from != nil {
		w.add(column+" >= ?", from.UTC())
	}
	if to != nil {
		w.add(column+" < ?", to.UTC())
	}
}

const diagnosticColumns = `id, report_uuid::text, user_id, device_id, kind, code, message, request_id, model, app_version,
  codex_version, platform, arch, os_version, context::text, occurred_at, created_at`

func scanDiagnostic(row interface{ Scan(...any) error }) (Diagnostic, error) {
	var d Diagnostic
	var device sql.NullInt64
	var ctxText string
	err := row.Scan(&d.ID, &d.ReportUUID, &d.UserID, &device, &d.Kind, &d.Code, &d.Message, &d.RequestID, &d.Model,
		&d.AppVersion, &d.CodexVersion, &d.Platform, &d.Arch, &d.OSVersion, &ctxText, &d.OccurredAt, &d.CreatedAt)
	if err != nil {
		return d, err
	}
	if device.Valid {
		v := device.Int64
		d.DeviceID = &v
	}
	if json.Valid([]byte(ctxText)) {
		d.Context = json.RawMessage(ctxText)
	} else {
		d.Context = json.RawMessage("{}")
	}
	d.OccurredAt = d.OccurredAt.UTC()
	d.CreatedAt = d.CreatedAt.UTC()
	return d, nil
}

func (s *sqlStore) listDiagnostics(ctx context.Context, f diagnosticsFilter) ([]Diagnostic, int64, error) {
	if s == nil || s.db == nil {
		return nil, 0, errNoDatabase
	}
	var w where
	if f.UserID > 0 {
		w.add("user_id = ?", f.UserID)
	}
	if f.Code != "" {
		w.add("code = ?", f.Code)
	}
	if f.Kind != "" {
		w.add("kind = ?", f.Kind)
	}
	if f.AppVersion != "" {
		w.add("app_version = ?", f.AppVersion)
	}
	w.timeRange("created_at", f.From, f.To)
	var total int64
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM claudex_diagnostics`+w.String(), w.args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	args := append(append([]any{}, w.args...), f.Size, (f.Page-1)*f.Size)
	rows, err := s.db.QueryContext(ctx, `SELECT `+diagnosticColumns+` FROM claudex_diagnostics`+w.String()+
		fmt.Sprintf(` ORDER BY created_at DESC, id DESC LIMIT $%d OFFSET $%d`, len(args)-1, len(args)), args...)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = rows.Close() }()
	items := []Diagnostic{}
	for rows.Next() {
		d, err := scanDiagnostic(rows)
		if err != nil {
			return nil, 0, err
		}
		items = append(items, d)
	}
	return items, total, rows.Err()
}

func (s *sqlStore) getDiagnostic(ctx context.Context, id int64) (*Diagnostic, error) {
	if s == nil || s.db == nil {
		return nil, errNoDatabase
	}
	d, err := scanDiagnostic(s.db.QueryRowContext(ctx, `SELECT `+diagnosticColumns+` FROM claudex_diagnostics WHERE id = $1`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &d, nil
}

func (s *sqlStore) deleteDiagnostic(ctx context.Context, id int64) (bool, error) {
	return s.deleteByID(ctx, `DELETE FROM claudex_diagnostics WHERE id = $1`, id)
}

func (s *sqlStore) deleteFeedback(ctx context.Context, id int64) (bool, error) {
	return s.deleteByID(ctx, `DELETE FROM claudex_feedback WHERE id = $1`, id)
}

func (s *sqlStore) deleteByID(ctx context.Context, query string, id int64) (bool, error) {
	if s == nil || s.db == nil {
		return false, errNoDatabase
	}
	res, err := s.db.ExecContext(ctx, query, id)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

// feedbackColumns: the excerpt itself is read only by getFeedback.
const feedbackColumns = `id, feedback_uuid::text, user_id, rating, categories::text, comment, model, request_id,
  conversation_excerpt IS NOT NULL, app_version, platform, created_at`

func scanFeedback(row interface{ Scan(...any) error }, extra ...any) (Feedback, error) {
	var f Feedback
	var catText string
	dest := append([]any{&f.ID, &f.FeedbackUUID, &f.UserID, &f.Rating, &catText, &f.Comment, &f.Model, &f.RequestID,
		&f.HasExcerpt, &f.AppVersion, &f.Platform, &f.CreatedAt}, extra...)
	if err := row.Scan(dest...); err != nil {
		return f, err
	}
	if err := json.Unmarshal([]byte(catText), &f.Categories); err != nil || f.Categories == nil {
		f.Categories = []string{}
	}
	f.CreatedAt = f.CreatedAt.UTC()
	return f, nil
}

func (s *sqlStore) listFeedback(ctx context.Context, f feedbackFilter) ([]Feedback, int64, error) {
	if s == nil || s.db == nil {
		return nil, 0, errNoDatabase
	}
	var w where
	if f.UserID > 0 {
		w.add("user_id = ?", f.UserID)
	}
	if f.Rating != "" {
		w.add("rating = ?", f.Rating)
	}
	w.timeRange("created_at", f.From, f.To)
	var total int64
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM claudex_feedback`+w.String(), w.args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	args := append(append([]any{}, w.args...), f.Size, (f.Page-1)*f.Size)
	rows, err := s.db.QueryContext(ctx, `SELECT `+feedbackColumns+` FROM claudex_feedback`+w.String()+
		fmt.Sprintf(` ORDER BY created_at DESC, id DESC LIMIT $%d OFFSET $%d`, len(args)-1, len(args)), args...)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = rows.Close() }()
	items := []Feedback{}
	for rows.Next() {
		item, err := scanFeedback(rows)
		if err != nil {
			return nil, 0, err
		}
		items = append(items, item)
	}
	return items, total, rows.Err()
}

func (s *sqlStore) getFeedback(ctx context.Context, id int64) (*Feedback, error) {
	if s == nil || s.db == nil {
		return nil, errNoDatabase
	}
	var excerpt sql.NullString
	f, err := scanFeedback(s.db.QueryRowContext(ctx, `SELECT `+feedbackColumns+`, conversation_excerpt FROM claudex_feedback WHERE id = $1`, id), &excerpt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if excerpt.Valid {
		v := excerpt.String
		f.ConversationExcerpt = &v
	}
	return &f, nil
}

func (s *sqlStore) purge(ctx context.Context, table string, cutoff time.Time, batch int) (int64, error) {
	if s == nil || s.db == nil {
		return 0, errNoDatabase
	}
	if table != tableDiagnostics && table != tableFeedback {
		return 0, fmt.Errorf("claudex feedback: unknown table %q", table)
	}
	res, err := s.db.ExecContext(ctx, `DELETE FROM `+table+` WHERE id IN (SELECT id FROM `+table+
		` WHERE created_at < $1 ORDER BY created_at LIMIT $2)`, cutoff.UTC(), batch)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
