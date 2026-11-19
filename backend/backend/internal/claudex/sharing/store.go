package sharing

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"
)

// shareRow is one row of claudex_shares.
type shareRow struct {
	ID             int64
	Token          string
	UserID         int64
	Kind           Kind
	SourceKey      string
	Title          string
	Status         Status
	DisabledReason string
	DisabledBy     *int64
	DisabledAt     *time.Time
	ContentBytes   int64
	ViewCount      int64
	CreatedAt      time.Time
	SnapshotAt     time.Time
	UpdatedAt      time.Time
	ExpiresAt      *time.Time
	RevokedAt      *time.Time
	LastViewedAt   *time.Time
	// InvitedOnly: the share has no public page; only invited people read it.
	InvitedOnly bool
	// AuthorGone is true when the author's account was deleted (upstream
	// users are soft-deleted, so the foreign key does not fire).
	AuthorGone bool
	// OpenReports counts the open reports (admin list only).
	OpenReports int64
}

// expired reports whether the share's expiry passed at now.
func (r *shareRow) expired(now time.Time) bool {
	return r.ExpiresAt != nil && !now.Before(*r.ExpiresAt)
}

// Report is one abuse report (admin API).
type Report struct {
	ID          int64  `json:"id"`
	ShareID     int64  `json:"share_id"`
	ShareTitle  string `json:"share_title"`
	ShareKind   Kind   `json:"share_kind"`
	ShareStatus Status `json:"share_status"`
	ShareUserID int64  `json:"share_user_id"`
	SharePath   string `json:"share_path"`
	ShareURL    string `json:"share_url"`
	shareToken  string
	Reason      string     `json:"reason"`
	Detail      string     `json:"detail"`
	Status      string     `json:"status"`
	CreatedAt   time.Time  `json:"created_at"`
	ResolvedAt  *time.Time `json:"resolved_at"`
	ResolvedBy  *int64     `json:"resolved_by"`
	// From the app's Report chat dialog (empty or false from the public
	// page): the live report form's category, the reporter's optional name
	// and e-mail, the signed-in account that sent it, and "Opt out of
	// training on this report".
	Category         string `json:"category"`
	ReporterName     string `json:"reporter_name"`
	ReporterEmail    string `json:"reporter_email"`
	ReporterUserID   *int64 `json:"reporter_user_id"`
	OptOutOfTraining bool   `json:"opt_out_of_training"`
}

// reportInput is one report to store. The public page sends the reason and
// the detail; the app's Report chat dialog the rest too.
type reportInput struct {
	Reason           string
	Detail           string
	Category         string
	ReporterName     string
	ReporterEmail    string
	ReporterUserID   *int64
	OptOutOfTraining bool
}

// Block is a user an administrator stopped from sharing (admin API).
type Block struct {
	UserID    int64     `json:"user_id"`
	UserEmail string    `json:"user_email"`
	Reason    string    `json:"reason"`
	CreatedBy *int64    `json:"created_by"`
	CreatedAt time.Time `json:"created_at"`
}

// Report reasons and statuses.
var reportReasons = map[string]bool{"illegal": true, "harmful": true, "privacy": true, "spam": true, "other": true}

const (
	reportOpen      = "open"
	reportResolved  = "resolved"
	reportDismissed = "dismissed"
)

// upsertInput creates a share or refreshes the live share of the same source.
type upsertInput struct {
	UserID    int64
	Kind      Kind
	SourceKey string
	Title     string
	Body      []byte
	Now       time.Time
	ExpiresAt *time.Time // for a new share
	// InvitedOnly applies to a new share only; a refresh keeps the access.
	InvitedOnly bool
	MaxActive   int
	NewToken    func() (string, error)
}

type adminFilter struct {
	Status Status
	Kind   Kind
	UserID int64
	Query  string
	Page   int
	Size   int
}

type reportFilter struct {
	Status  string
	ShareID int64
	Page    int
	Size    int
}

// store is the persistence of the component (SQL in production, in memory
// in unit tests). Errors ErrShareDisabled and ErrQuota come back as is.
type store interface {
	editAccess(ctx context.Context, id int64, email, decision string, now time.Time) (string, error)
	editAccessRequests(ctx context.Context, id int64) ([]EditAccessRequest, error)
	editArtifact(ctx context.Context, userID int64, email string, id int64, permission string, edit func(*Snapshot) error, now time.Time) error
	upsert(ctx context.Context, in upsertInput) (row *shareRow, created bool, err error)
	updateSnapshot(ctx context.Context, userID, id int64, title string, body []byte, now time.Time) (*shareRow, error)
	// getLive returns a share that is not revoked (and, when userID > 0,
	// belongs to that user); nil when there is none.
	getLive(ctx context.Context, userID, id int64) (*shareRow, error)
	listUser(ctx context.Context, userID int64, kind Kind, sourceKey string, now time.Time, page, size int) ([]shareRow, int64, error)
	// revoke marks a share revoked and deletes its content (userID 0 = any
	// owner). false when there was no live share.
	revoke(ctx context.Context, userID, id int64, now time.Time) (bool, error)
	byToken(ctx context.Context, token string) (*shareRow, error)
	content(ctx context.Context, id int64) (*Snapshot, error)
	countView(ctx context.Context, id int64, now time.Time) error

	adminList(ctx context.Context, f adminFilter) ([]shareRow, int64, error)
	setDisabled(ctx context.Context, id int64, disabled bool, reason string, by int64, now time.Time) (*shareRow, error)
	disableAllOf(ctx context.Context, userID int64, reason string, by int64, now time.Time) (int64, error)

	insertReport(ctx context.Context, shareID int64, in reportInput, ipHash string, now time.Time) (bool, error)
	listReports(ctx context.Context, f reportFilter) ([]Report, int64, error)
	// resolveReport sets a report's status; with alsoShare it resolves every
	// open report of the same share too (after a takedown).
	resolveReport(ctx context.Context, id int64, status string, alsoShare bool, by int64, now time.Time) (*Report, error)

	isBlocked(ctx context.Context, userID int64) (bool, error)
	listBlocks(ctx context.Context, page, size int) ([]Block, int64, error)
	// putBlock returns false when the user does not exist.
	putBlock(ctx context.Context, userID int64, reason string, by int64, now time.Time) (*Block, bool, error)
	deleteBlock(ctx context.Context, userID int64) (bool, error)

	// purgeExpired revokes up to batch expired shares; purgeDeletedAuthors
	// revokes up to batch shares of deleted users.
	purgeExpired(ctx context.Context, now time.Time, batch int) (int64, error)
	purgeDeletedAuthors(ctx context.Context, now time.Time, batch int) (int64, error)

	// Invited people (claudex_share_invites).
	//
	// setInvitedOnly switches a live share of the user between the public link
	// and invited people only; nil when there is no such share.
	setInvitedOnly(ctx context.Context, userID, id int64, on bool, now time.Time) (*shareRow, error)
	// addInvite records an address (lower-case); false when it was there.
	addInvite(ctx context.Context, id int64, email string, now time.Time, roles ...string) (bool, error)
	inviteRoles(ctx context.Context, id int64) (map[string]string, error)
	removeInvite(ctx context.Context, id int64, email string) (bool, error)
	invites(ctx context.Context, id int64) ([]string, error)
	// invited reports whether the address is invited to the share.
	invited(ctx context.Context, id int64, email string) (bool, error)
	// sharedWith lists the live shares an address is invited to, newest first.
	sharedWith(ctx context.Context, email string, now time.Time) ([]sharedRow, error)
}

func (s *sqlStore) editArtifact(ctx context.Context, userID int64, email string, id int64, permission string, edit func(*Snapshot) error, now time.Time) (err error) {
	if err = s.ok(); err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer rollbackOnError(tx, &err)
	row, err := scanShare(tx.QueryRowContext(ctx, `SELECT `+shareColumns+` FROM claudex_shares s WHERE s.id = $1 FOR UPDATE`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return ErrShareNotFound
	}
	if err != nil {
		return err
	}
	if row.Kind != KindArtifact || row.Status != StatusActive || row.expired(now) {
		return ErrShareNotFound
	}
	if row.UserID != userID {
		var role string
		if err = tx.QueryRowContext(ctx, `SELECT role FROM claudex_share_invites WHERE share_id = $1 AND email = $2 FOR UPDATE`, id, email).Scan(&role); errors.Is(err, sql.ErrNoRows) {
			return ErrShareNotFound
		} else if err != nil {
			return err
		}
		if !artifactRoleAllows(role, permission) {
			return ErrShareNotFound
		}
	}
	var body []byte
	if err = tx.QueryRowContext(ctx, `SELECT body FROM claudex_share_contents WHERE share_id = $1`, id).Scan(&body); err != nil {
		return err
	}
	var snapshot Snapshot
	if err = json.Unmarshal(body, &snapshot); err != nil {
		return err
	}
	if err = edit(&snapshot); err != nil {
		return err
	}
	if body, err = json.Marshal(snapshot); err != nil {
		return err
	}
	if _, err = updateTx(ctx, tx, id, row.Title, body, now); err != nil {
		return err
	}
	return tx.Commit()
}

// sharedRow is a share as its invitee sees it in the list.
type sharedRow struct {
	shareRow
	OwnerEmail string
}

var errNoDatabase = errors.New("claudex sharing: database unavailable")

// sqlStore keeps shares in claudex_shares and the related tables.
type sqlStore struct{ db *sql.DB }

const shareColumns = `s.id, s.token, s.user_id, s.kind, s.source_key, s.title, s.status, s.disabled_reason,
  s.disabled_by, s.disabled_at, s.content_bytes, s.view_count, s.created_at, s.snapshot_at, s.updated_at,
  s.expires_at, s.revoked_at, s.last_viewed_at, s.invited_only`

type rowScanner interface{ Scan(dest ...any) error }

func scanShare(sc rowScanner, extra ...any) (*shareRow, error) {
	var r shareRow
	var kind, status string
	var disabledBy sql.NullInt64
	var disabledAt, expiresAt, revokedAt, lastViewed sql.NullTime
	dest := []any{&r.ID, &r.Token, &r.UserID, &kind, &r.SourceKey, &r.Title, &status, &r.DisabledReason,
		&disabledBy, &disabledAt, &r.ContentBytes, &r.ViewCount, &r.CreatedAt, &r.SnapshotAt, &r.UpdatedAt,
		&expiresAt, &revokedAt, &lastViewed, &r.InvitedOnly}
	if err := sc.Scan(append(dest, extra...)...); err != nil {
		return nil, err
	}
	r.Kind, r.Status = Kind(kind), Status(status)
	if disabledBy.Valid {
		v := disabledBy.Int64
		r.DisabledBy = &v
	}
	r.DisabledAt = timePtr(disabledAt)
	r.ExpiresAt = timePtr(expiresAt)
	r.RevokedAt = timePtr(revokedAt)
	r.LastViewedAt = timePtr(lastViewed)
	return &r, nil
}

func timePtr(t sql.NullTime) *time.Time {
	if !t.Valid {
		return nil
	}
	v := t.Time.UTC()
	return &v
}

func (s *sqlStore) ok() error {
	if s == nil || s.db == nil {
		return errNoDatabase
	}
	return nil
}

func rollbackOnError(tx *sql.Tx, err *error) {
	if *err != nil {
		_ = tx.Rollback()
	}
}

func (s *sqlStore) upsert(ctx context.Context, in upsertInput) (row *shareRow, created bool, err error) {
	if err = s.ok(); err != nil {
		return nil, false, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, false, err
	}
	defer rollbackOnError(tx, &err)
	// Serialize per user so two requests cannot both pass the quota check
	// or race on the live-source unique index.
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
		"claudex_shares:"+strconv.FormatInt(in.UserID, 10)); err != nil {
		return nil, false, err
	}
	existing, err := scanShare(tx.QueryRowContext(ctx, `SELECT `+shareColumns+` FROM claudex_shares s
WHERE s.user_id = $1 AND s.kind = $2 AND s.source_key = $3 AND s.status <> 'revoked' FOR UPDATE`,
		in.UserID, string(in.Kind), in.SourceKey))
	switch {
	case errors.Is(err, sql.ErrNoRows):
		existing, err = nil, nil
	case err != nil:
		return nil, false, err
	}
	if existing != nil && existing.expired(in.Now) {
		// An expired share the cleanup job has not reached yet: retire it so
		// sharing again makes a new link.
		if err = revokeTx(ctx, tx, existing.ID, in.Now); err != nil {
			return nil, false, err
		}
		existing = nil
	}
	if existing != nil {
		if existing.Status == StatusDisabled {
			err = ErrShareDisabled
			return nil, false, err
		}
		row, err = updateTx(ctx, tx, existing.ID, in.Title, in.Body, in.Now)
		if err != nil {
			return nil, false, err
		}
		err = tx.Commit()
		return row, false, err
	}

	var live int
	if err = tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM claudex_shares
WHERE user_id = $1 AND status <> 'revoked' AND (expires_at IS NULL OR expires_at > $2)`, in.UserID, in.Now).Scan(&live); err != nil {
		return nil, false, err
	}
	if live >= in.MaxActive {
		err = ErrQuota
		return nil, false, err
	}
	token, err := in.NewToken()
	if err != nil {
		return nil, false, err
	}
	var id int64
	if err = tx.QueryRowContext(ctx, `INSERT INTO claudex_shares
  (token, user_id, kind, source_key, title, status, content_bytes, created_at, snapshot_at, updated_at, expires_at, invited_only)
VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $7, $7, $8, $9) RETURNING id`,
		token, in.UserID, string(in.Kind), in.SourceKey, in.Title, len(in.Body), in.Now, in.ExpiresAt, in.InvitedOnly).Scan(&id); err != nil {
		return nil, false, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO claudex_share_contents (share_id, schema, body) VALUES ($1, $2, $3::jsonb)`,
		id, SnapshotSchema, string(in.Body)); err != nil {
		return nil, false, err
	}
	row, err = scanShare(tx.QueryRowContext(ctx, `SELECT `+shareColumns+` FROM claudex_shares s WHERE s.id = $1`, id))
	if err != nil {
		return nil, false, err
	}
	err = tx.Commit()
	return row, true, err
}

func updateTx(ctx context.Context, tx *sql.Tx, id int64, title string, body []byte, now time.Time) (*shareRow, error) {
	if _, err := tx.ExecContext(ctx, `INSERT INTO claudex_share_contents (share_id, schema, body) VALUES ($1, $2, $3::jsonb)
ON CONFLICT (share_id) DO UPDATE SET schema = EXCLUDED.schema, body = EXCLUDED.body`, id, SnapshotSchema, string(body)); err != nil {
		return nil, err
	}
	return scanShare(tx.QueryRowContext(ctx, `UPDATE claudex_shares s SET title = $2, content_bytes = $3, snapshot_at = $4, updated_at = $4
WHERE s.id = $1 RETURNING `+shareColumns, id, title, len(body), now))
}

func revokeTx(ctx context.Context, tx *sql.Tx, id int64, now time.Time) error {
	if _, err := tx.ExecContext(ctx, `UPDATE claudex_shares SET status = 'revoked', revoked_at = $2, updated_at = $2 WHERE id = $1`, id, now); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `DELETE FROM claudex_share_contents WHERE share_id = $1`, id)
	return err
}

func (s *sqlStore) updateSnapshot(ctx context.Context, userID, id int64, title string, body []byte, now time.Time) (row *shareRow, err error) {
	if err = s.ok(); err != nil {
		return nil, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer rollbackOnError(tx, &err)
	existing, err := scanShare(tx.QueryRowContext(ctx, `SELECT `+shareColumns+` FROM claudex_shares s
WHERE s.id = $1 AND s.user_id = $2 AND s.status <> 'revoked' FOR UPDATE`, id, userID))
	if errors.Is(err, sql.ErrNoRows) || (err == nil && existing.expired(now)) {
		err = ErrShareNotFound
		return nil, err
	}
	if err != nil {
		return nil, err
	}
	if existing.Status == StatusDisabled {
		err = ErrShareDisabled
		return nil, err
	}
	if row, err = updateTx(ctx, tx, id, title, body, now); err != nil {
		return nil, err
	}
	err = tx.Commit()
	return row, err
}

func (s *sqlStore) getLive(ctx context.Context, userID, id int64) (*shareRow, error) {
	if err := s.ok(); err != nil {
		return nil, err
	}
	q := `SELECT ` + shareColumns + ` FROM claudex_shares s WHERE s.id = $1 AND s.status <> 'revoked'`
	args := []any{id}
	if userID > 0 {
		q += ` AND s.user_id = $2`
		args = append(args, userID)
	}
	row, err := scanShare(s.db.QueryRowContext(ctx, q, args...))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return row, err
}

func (s *sqlStore) listUser(ctx context.Context, userID int64, kind Kind, sourceKey string, now time.Time, page, size int) ([]shareRow, int64, error) {
	if err := s.ok(); err != nil {
		return nil, 0, err
	}
	where := `s.user_id = $1 AND s.status <> 'revoked' AND (s.expires_at IS NULL OR s.expires_at > $2)`
	args := []any{userID, now}
	if kind != "" {
		args = append(args, string(kind))
		where += ` AND s.kind = $` + strconv.Itoa(len(args))
	}
	if sourceKey != "" {
		args = append(args, sourceKey)
		where += ` AND s.source_key = $` + strconv.Itoa(len(args))
	}
	return s.pagedShares(ctx, where, args, "", page, size)
}

func (s *sqlStore) pagedShares(ctx context.Context, where string, args []any, extraCols string, page, size int) ([]shareRow, int64, error) {
	var total int64
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM claudex_shares s WHERE `+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	n := len(args)
	q := `SELECT ` + shareColumns + extraCols + ` FROM claudex_shares s WHERE ` + where +
		` ORDER BY s.created_at DESC, s.id DESC LIMIT $` + strconv.Itoa(n+1) + ` OFFSET $` + strconv.Itoa(n+2)
	rows, err := s.db.QueryContext(ctx, q, append(args, size, (page-1)*size)...)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = rows.Close() }()
	out := []shareRow{}
	for rows.Next() {
		var open int64
		var extra []any
		if extraCols != "" {
			extra = []any{&open}
		}
		r, err := scanShare(rows, extra...)
		if err != nil {
			return nil, 0, err
		}
		r.OpenReports = open
		out = append(out, *r)
	}
	return out, total, rows.Err()
}

func (s *sqlStore) revoke(ctx context.Context, userID, id int64, now time.Time) (done bool, err error) {
	if err = s.ok(); err != nil {
		return false, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer rollbackOnError(tx, &err)
	q := `SELECT id FROM claudex_shares WHERE id = $1 AND status <> 'revoked'`
	args := []any{id}
	if userID > 0 {
		q += ` AND user_id = $2`
		args = append(args, userID)
	}
	var got int64
	err = tx.QueryRowContext(ctx, q+` FOR UPDATE`, args...).Scan(&got)
	if errors.Is(err, sql.ErrNoRows) {
		err = tx.Commit()
		return false, err
	}
	if err != nil {
		return false, err
	}
	if err = revokeTx(ctx, tx, id, now); err != nil {
		return false, err
	}
	err = tx.Commit()
	return err == nil, err
}

func (s *sqlStore) byToken(ctx context.Context, token string) (*shareRow, error) {
	if err := s.ok(); err != nil {
		return nil, err
	}
	var gone bool
	row, err := scanShare(s.db.QueryRowContext(ctx, `SELECT `+shareColumns+`,
  NOT EXISTS (SELECT 1 FROM users u WHERE u.id = s.user_id AND u.deleted_at IS NULL)
FROM claudex_shares s WHERE s.token = $1`, token), &gone)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	row.AuthorGone = gone
	return row, nil
}

func (s *sqlStore) content(ctx context.Context, id int64) (*Snapshot, error) {
	if err := s.ok(); err != nil {
		return nil, err
	}
	var body []byte
	err := s.db.QueryRowContext(ctx, `SELECT body FROM claudex_share_contents WHERE share_id = $1`, id).Scan(&body)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var snap Snapshot
	if err := json.Unmarshal(body, &snap); err != nil {
		return nil, err
	}
	return &snap, nil
}

func (s *sqlStore) countView(ctx context.Context, id int64, now time.Time) error {
	if err := s.ok(); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `UPDATE claudex_shares SET view_count = view_count + 1, last_viewed_at = $2 WHERE id = $1`, id, now)
	return err
}

func (s *sqlStore) adminList(ctx context.Context, f adminFilter) ([]shareRow, int64, error) {
	if err := s.ok(); err != nil {
		return nil, 0, err
	}
	where := `TRUE`
	var args []any
	if f.Status != "" {
		args = append(args, string(f.Status))
		where += ` AND s.status = $` + strconv.Itoa(len(args))
	} else {
		where += ` AND s.status <> 'revoked'`
	}
	if f.Kind != "" {
		args = append(args, string(f.Kind))
		where += ` AND s.kind = $` + strconv.Itoa(len(args))
	}
	if f.UserID > 0 {
		args = append(args, f.UserID)
		where += ` AND s.user_id = $` + strconv.Itoa(len(args))
	}
	if f.Query != "" {
		args = append(args, "%"+escapeLike(f.Query)+"%")
		where += ` AND s.title ILIKE $` + strconv.Itoa(len(args)) + ` ESCAPE '\'`
	}
	return s.pagedShares(ctx, where, args,
		`, (SELECT COUNT(*) FROM claudex_share_reports r WHERE r.share_id = s.id AND r.status = 'open')`, f.Page, f.Size)
}

func escapeLike(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}

func (s *sqlStore) setDisabled(ctx context.Context, id int64, disabled bool, reason string, by int64, now time.Time) (*shareRow, error) {
	if err := s.ok(); err != nil {
		return nil, err
	}
	var row *shareRow
	var err error
	if disabled {
		row, err = scanShare(s.db.QueryRowContext(ctx, `UPDATE claudex_shares s
SET status = 'disabled', disabled_reason = $2, disabled_by = $3, disabled_at = $4, updated_at = $4
WHERE s.id = $1 AND s.status <> 'revoked' RETURNING `+shareColumns, id, reason, by, now))
	} else {
		row, err = scanShare(s.db.QueryRowContext(ctx, `UPDATE claudex_shares s
SET status = 'active', disabled_reason = '', disabled_by = NULL, disabled_at = NULL, updated_at = $2
WHERE s.id = $1 AND s.status <> 'revoked' RETURNING `+shareColumns, id, now))
	}
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return row, err
}

func (s *sqlStore) disableAllOf(ctx context.Context, userID int64, reason string, by int64, now time.Time) (int64, error) {
	if err := s.ok(); err != nil {
		return 0, err
	}
	res, err := s.db.ExecContext(ctx, `UPDATE claudex_shares
SET status = 'disabled', disabled_reason = $2, disabled_by = $3, disabled_at = $4, updated_at = $4
WHERE user_id = $1 AND status = 'active'`, userID, reason, by, now)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (s *sqlStore) insertReport(ctx context.Context, shareID int64, in reportInput, ipHash string, now time.Time) (bool, error) {
	if err := s.ok(); err != nil {
		return false, err
	}
	var reporter any
	if in.ReporterUserID != nil {
		reporter = *in.ReporterUserID
	}
	// One report per share and visitor address per day (ip_hash changes
	// every day); duplicates are accepted silently.
	res, err := s.db.ExecContext(ctx, `INSERT INTO claudex_share_reports (share_id, reason, detail, ip_hash, created_at,
  category, reporter_name, reporter_email, reporter_user_id, opt_out_of_training)
SELECT $1::bigint, $2::varchar, $3::varchar, $4::varchar, $5::timestamptz, $6::varchar, $7::varchar, $8::varchar, $9::bigint, $10::boolean
WHERE $4::varchar = '' OR NOT EXISTS (SELECT 1 FROM claudex_share_reports WHERE share_id = $1::bigint AND ip_hash = $4::varchar)`,
		shareID, in.Reason, in.Detail, ipHash, now, in.Category, in.ReporterName, in.ReporterEmail, reporter, in.OptOutOfTraining)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

const reportColumns = `r.id, r.share_id, s.title, s.kind, s.status, s.user_id, s.token, r.reason, r.detail, r.status,
  r.created_at, r.resolved_at, r.resolved_by, r.category, r.reporter_name, r.reporter_email, r.reporter_user_id,
  r.opt_out_of_training`

func scanReport(sc rowScanner) (*Report, error) {
	var r Report
	var kind, status string
	var resolvedAt sql.NullTime
	var resolvedBy, reporter sql.NullInt64
	if err := sc.Scan(&r.ID, &r.ShareID, &r.ShareTitle, &kind, &status, &r.ShareUserID, &r.shareToken, &r.Reason, &r.Detail, &r.Status,
		&r.CreatedAt, &resolvedAt, &resolvedBy, &r.Category, &r.ReporterName, &r.ReporterEmail, &reporter,
		&r.OptOutOfTraining); err != nil {
		return nil, err
	}
	if reporter.Valid {
		v := reporter.Int64
		r.ReporterUserID = &v
	}
	r.ShareKind, r.ShareStatus = Kind(kind), Status(status)
	r.ResolvedAt = timePtr(resolvedAt)
	if resolvedBy.Valid {
		v := resolvedBy.Int64
		r.ResolvedBy = &v
	}
	return &r, nil
}

func (s *sqlStore) listReports(ctx context.Context, f reportFilter) ([]Report, int64, error) {
	if err := s.ok(); err != nil {
		return nil, 0, err
	}
	where := `TRUE`
	var args []any
	if f.Status != "" {
		args = append(args, f.Status)
		where += ` AND r.status = $` + strconv.Itoa(len(args))
	}
	if f.ShareID > 0 {
		args = append(args, f.ShareID)
		where += ` AND r.share_id = $` + strconv.Itoa(len(args))
	}
	from := ` FROM claudex_share_reports r JOIN claudex_shares s ON s.id = r.share_id WHERE ` + where
	var total int64
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*)`+from, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	n := len(args)
	rows, err := s.db.QueryContext(ctx, `SELECT `+reportColumns+from+
		` ORDER BY r.created_at DESC, r.id DESC LIMIT $`+strconv.Itoa(n+1)+` OFFSET $`+strconv.Itoa(n+2),
		append(args, f.Size, (f.Page-1)*f.Size)...)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = rows.Close() }()
	out := []Report{}
	for rows.Next() {
		r, err := scanReport(rows)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, *r)
	}
	return out, total, rows.Err()
}

func (s *sqlStore) resolveReport(ctx context.Context, id int64, status string, alsoShare bool, by int64, now time.Time) (*Report, error) {
	if err := s.ok(); err != nil {
		return nil, err
	}
	var shareID int64
	err := s.db.QueryRowContext(ctx, `UPDATE claudex_share_reports SET status = $2, resolved_at = $3, resolved_by = $4
WHERE id = $1 RETURNING share_id`, id, status, now, by).Scan(&shareID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if alsoShare {
		if _, err := s.db.ExecContext(ctx, `UPDATE claudex_share_reports SET status = $2, resolved_at = $3, resolved_by = $4
WHERE share_id = $1 AND status = 'open'`, shareID, status, now, by); err != nil {
			return nil, err
		}
	}
	return scanReport(s.db.QueryRowContext(ctx, `SELECT `+reportColumns+
		` FROM claudex_share_reports r JOIN claudex_shares s ON s.id = r.share_id WHERE r.id = $1`, id))
}

func (s *sqlStore) isBlocked(ctx context.Context, userID int64) (bool, error) {
	if err := s.ok(); err != nil {
		return false, err
	}
	var blocked bool
	err := s.db.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM claudex_share_user_blocks WHERE user_id = $1)`, userID).Scan(&blocked)
	return blocked, err
}

func scanBlock(sc rowScanner) (*Block, error) {
	var b Block
	var by sql.NullInt64
	if err := sc.Scan(&b.UserID, &b.Reason, &by, &b.CreatedAt); err != nil {
		return nil, err
	}
	if by.Valid {
		v := by.Int64
		b.CreatedBy = &v
	}
	return &b, nil
}

func (s *sqlStore) listBlocks(ctx context.Context, page, size int) ([]Block, int64, error) {
	if err := s.ok(); err != nil {
		return nil, 0, err
	}
	var total int64
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM claudex_share_user_blocks`).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT user_id, reason, created_by, created_at FROM claudex_share_user_blocks
ORDER BY created_at DESC, user_id DESC LIMIT $1 OFFSET $2`, size, (page-1)*size)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = rows.Close() }()
	out := []Block{}
	for rows.Next() {
		b, err := scanBlock(rows)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, *b)
	}
	return out, total, rows.Err()
}

func (s *sqlStore) putBlock(ctx context.Context, userID int64, reason string, by int64, now time.Time) (*Block, bool, error) {
	if err := s.ok(); err != nil {
		return nil, false, err
	}
	b, err := scanBlock(s.db.QueryRowContext(ctx, `INSERT INTO claudex_share_user_blocks (user_id, reason, created_by, created_at)
SELECT $1::bigint, $2::varchar, $3::bigint, $4::timestamptz
WHERE EXISTS (SELECT 1 FROM users WHERE id = $1::bigint AND deleted_at IS NULL)
ON CONFLICT (user_id) DO UPDATE SET reason = EXCLUDED.reason
RETURNING user_id, reason, created_by, created_at`, userID, reason, by, now))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return b, true, nil
}

func (s *sqlStore) deleteBlock(ctx context.Context, userID int64) (bool, error) {
	if err := s.ok(); err != nil {
		return false, err
	}
	res, err := s.db.ExecContext(ctx, `DELETE FROM claudex_share_user_blocks WHERE user_id = $1`, userID)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

func (s *sqlStore) purgeWhere(ctx context.Context, cond string, now time.Time, batch int) (n int64, err error) {
	if err = s.ok(); err != nil {
		return 0, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer rollbackOnError(tx, &err)
	rows, err := tx.QueryContext(ctx, `SELECT s.id FROM claudex_shares s WHERE s.status <> 'revoked' AND `+cond+`
ORDER BY s.id LIMIT $2 FOR UPDATE SKIP LOCKED`, now, batch)
	if err != nil {
		return 0, err
	}
	var ids []int64
	for rows.Next() {
		var id int64
		if err = rows.Scan(&id); err != nil {
			_ = rows.Close()
			return 0, err
		}
		ids = append(ids, id)
	}
	_ = rows.Close()
	if err = rows.Err(); err != nil {
		return 0, err
	}
	for _, id := range ids {
		if err = revokeTx(ctx, tx, id, now); err != nil {
			return 0, err
		}
	}
	err = tx.Commit()
	return int64(len(ids)), err
}

func (s *sqlStore) purgeExpired(ctx context.Context, now time.Time, batch int) (int64, error) {
	return s.purgeWhere(ctx, `s.expires_at IS NOT NULL AND s.expires_at <= $1`, now, batch)
}

func (s *sqlStore) purgeDeletedAuthors(ctx context.Context, now time.Time, batch int) (int64, error) {
	// purgeWhere always binds now as $1; this condition does not need it.
	return s.purgeWhere(ctx, `$1::timestamptz IS NOT NULL AND NOT EXISTS
  (SELECT 1 FROM users u WHERE u.id = s.user_id AND u.deleted_at IS NULL)`, now, batch)
}

func (s *sqlStore) setInvitedOnly(ctx context.Context, userID, id int64, on bool, now time.Time) (*shareRow, error) {
	if err := s.ok(); err != nil {
		return nil, err
	}
	row, err := scanShare(s.db.QueryRowContext(ctx, `UPDATE claudex_shares s SET invited_only = $3, updated_at = $4
WHERE s.id = $1 AND s.user_id = $2 AND s.status <> 'revoked' RETURNING `+shareColumns, id, userID, on, now))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return row, err
}

func (s *sqlStore) addInvite(ctx context.Context, id int64, email string, now time.Time, roles ...string) (added bool, err error) {
	if err := s.ok(); err != nil {
		return false, err
	}
	role := "edit"
	if len(roles) > 0 && roles[0] != "" {
		role = roles[0]
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer rollbackOnError(tx, &err)
	var locked int64
	if err = tx.QueryRowContext(ctx, `SELECT id FROM claudex_shares WHERE id=$1 FOR UPDATE`, id).Scan(&locked); err != nil {
		return false, err
	}
	res, err := tx.ExecContext(ctx, `INSERT INTO claudex_share_invites (share_id, email, created_at, role) VALUES ($1, $2, $3, $4)
ON CONFLICT (share_id, email) DO NOTHING`, id, email, now, role)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	if n == 0 && len(roles) > 0 && roles[0] != "" {
		if _, err = tx.ExecContext(ctx, `UPDATE claudex_share_invites SET role=$3 WHERE share_id=$1 AND email=$2`, id, email, role); err != nil {
			return false, err
		}
	}
	return n > 0, tx.Commit()
}

func artifactRoleAllows(role, permission string) bool {
	return role == "edit" || (role == "comment" && permission == "comment")
}

func (s *sqlStore) inviteRoles(ctx context.Context, id int64) (map[string]string, error) {
	if err := s.ok(); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT email, role FROM claudex_share_invites WHERE share_id=$1`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	roles := map[string]string{}
	for rows.Next() {
		var email, role string
		if err := rows.Scan(&email, &role); err != nil {
			return nil, err
		}
		roles[email] = role
	}
	return roles, rows.Err()
}

func (s *sqlStore) removeInvite(ctx context.Context, id int64, email string) (removed bool, err error) {
	if err := s.ok(); err != nil {
		return false, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer rollbackOnError(tx, &err)
	var locked int64
	if err = tx.QueryRowContext(ctx, `SELECT id FROM claudex_shares WHERE id = $1 FOR UPDATE`, id).Scan(&locked); err != nil {
		return false, err
	}
	res, err := tx.ExecContext(ctx, `DELETE FROM claudex_share_invites WHERE share_id = $1 AND email = $2`, id, email)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n > 0, tx.Commit()
}

func (s *sqlStore) invites(ctx context.Context, id int64) ([]string, error) {
	if err := s.ok(); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT email FROM claudex_share_invites WHERE share_id = $1 ORDER BY created_at, email`, id)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []string{}
	for rows.Next() {
		var email string
		if err := rows.Scan(&email); err != nil {
			return nil, err
		}
		out = append(out, email)
	}
	return out, rows.Err()
}

func (s *sqlStore) invited(ctx context.Context, id int64, email string) (bool, error) {
	if err := s.ok(); err != nil {
		return false, err
	}
	var one int
	err := s.db.QueryRowContext(ctx, `SELECT 1 FROM claudex_share_invites WHERE share_id = $1 AND email = $2`, id, email).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func (s *sqlStore) sharedWith(ctx context.Context, email string, now time.Time) ([]sharedRow, error) {
	if err := s.ok(); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT `+shareColumns+`, u.email
FROM claudex_shares s
JOIN claudex_share_invites i ON i.share_id = s.id AND i.email = $1
JOIN users u ON u.id = s.user_id AND u.deleted_at IS NULL
WHERE s.status = 'active' AND (s.expires_at IS NULL OR s.expires_at > $2)
ORDER BY s.snapshot_at DESC, s.id DESC LIMIT 200`, email, now)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []sharedRow{}
	for rows.Next() {
		var owner string
		r, err := scanShare(rows, &owner)
		if err != nil {
			return nil, err
		}
		out = append(out, sharedRow{shareRow: *r, OwnerEmail: owner})
	}
	return out, rows.Err()
}
