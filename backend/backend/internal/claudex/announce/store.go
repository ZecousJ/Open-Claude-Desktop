package announce

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// store is the persistence the handlers use (sqlStore; a memory store in tests).
type store interface {
	create(ctx context.Context, in Content, by int64, now time.Time) (*row, error)
	// update changes the content; resetReads shows it again to everyone.
	update(ctx context.Context, id int64, in Content, resetReads bool, now time.Time) (*row, error)
	get(ctx context.Context, id int64) (*row, error)
	list(ctx context.Context) ([]row, error)
	publish(ctx context.Context, id int64, now, until time.Time) (*row, error)
	withdraw(ctx context.Context, id int64, now time.Time) (*row, error)
	remove(ctx context.Context, id int64) (bool, error)
	// pending lists the live announcements the user has not closed, oldest first.
	pending(ctx context.Context, userID int64, now time.Time) ([]row, error)
	// markRead records a close; false when the announcement is not live.
	markRead(ctx context.Context, id, userID int64, action string, now time.Time) (bool, error)

	createMail(ctx context.Context, subject, body string, recipients int, by int64, now time.Time) (int64, error)
	mailProgress(ctx context.Context, id int64, sent, failed int, done bool, now time.Time) error
	listMails(ctx context.Context, limit int) ([]mailRow, error)
}

type sqlStore struct{ db *sql.DB }

const columns = `a.id, a.title, a.badge, a.body_html, a.body_format, a.image_url, a.primary_label, a.primary_url,
	a.dismiss_label, a.status, a.published_at, a.expires_at, a.created_by, a.created_at, a.updated_at`

type scanner interface{ Scan(dest ...any) error }

func scanRow(s scanner, extra ...any) (*row, error) {
	var r row
	var published, expires sql.NullTime
	dest := []any{&r.ID, &r.Title, &r.Badge, &r.BodyHTML, &r.BodyFormat, &r.ImageURL, &r.PrimaryLabel, &r.PrimaryURL,
		&r.DismissLabel, &r.Status, &published, &expires, &r.CreatedBy, &r.CreatedAt, &r.UpdatedAt}
	if err := s.Scan(append(dest, extra...)...); err != nil {
		return nil, err
	}
	if published.Valid {
		t := published.Time
		r.PublishedAt = &t
	}
	if expires.Valid {
		t := expires.Time
		r.ExpiresAt = &t
	}
	return &r, nil
}

func (s *sqlStore) one(ctx context.Context, query string, args ...any) (*row, error) {
	r, err := scanRow(s.db.QueryRowContext(ctx, query, args...))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return r, err
}

func (s *sqlStore) create(ctx context.Context, in Content, by int64, now time.Time) (*row, error) {
	return s.one(ctx, `INSERT INTO claudex_announcements AS a
		(title, badge, body_html, body_format, image_url, primary_label, primary_url, dismiss_label, status, created_by, created_at, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft',$9,$10,$10) RETURNING `+columns,
		in.Title, in.Badge, in.BodyHTML, in.BodyFormat, in.ImageURL, in.PrimaryLabel, in.PrimaryURL, in.DismissLabel, by, now)
}

func (s *sqlStore) update(ctx context.Context, id int64, in Content, resetReads bool, now time.Time) (*row, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	r, err := scanRow(tx.QueryRowContext(ctx, `UPDATE claudex_announcements AS a SET title=$2, badge=$3,
		body_html=$4, body_format=$5, image_url=$6, primary_label=$7, primary_url=$8, dismiss_label=$9, updated_at=$10
		WHERE id=$1 RETURNING `+columns,
		id, in.Title, in.Badge, in.BodyHTML, in.BodyFormat, in.ImageURL, in.PrimaryLabel, in.PrimaryURL, in.DismissLabel, now))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if resetReads {
		if _, err := tx.ExecContext(ctx, `DELETE FROM claudex_announcement_reads WHERE announcement_id=$1`, id); err != nil {
			return nil, err
		}
	}
	return r, tx.Commit()
}

func (s *sqlStore) get(ctx context.Context, id int64) (*row, error) {
	var reads int64
	r, err := scanRow(s.db.QueryRowContext(ctx, `SELECT `+columns+`,
		(SELECT COUNT(*) FROM claudex_announcement_reads x WHERE x.announcement_id=a.id)
		FROM claudex_announcements a WHERE a.id=$1`, id), &reads)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	r.Reads = reads
	return r, nil
}

func (s *sqlStore) list(ctx context.Context) ([]row, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+columns+`,
		(SELECT COUNT(*) FROM claudex_announcement_reads x WHERE x.announcement_id=a.id)
		FROM claudex_announcements a ORDER BY a.updated_at DESC, a.id DESC LIMIT 500`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []row
	for rows.Next() {
		var reads int64
		r, err := scanRow(rows, &reads)
		if err != nil {
			return nil, err
		}
		r.Reads = reads
		out = append(out, *r)
	}
	return out, rows.Err()
}

func (s *sqlStore) publish(ctx context.Context, id int64, now, until time.Time) (*row, error) {
	return s.one(ctx, `UPDATE claudex_announcements AS a SET status='published', published_at=$2,
		expires_at=$3, updated_at=$2 WHERE id=$1 RETURNING `+columns, id, now, until)
}

func (s *sqlStore) withdraw(ctx context.Context, id int64, now time.Time) (*row, error) {
	return s.one(ctx, `UPDATE claudex_announcements AS a SET status='withdrawn', updated_at=$2
		WHERE id=$1 RETURNING `+columns, id, now)
}

func (s *sqlStore) remove(ctx context.Context, id int64) (bool, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM claudex_announcements WHERE id=$1`, id)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

func (s *sqlStore) pending(ctx context.Context, userID int64, now time.Time) ([]row, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+columns+` FROM claudex_announcements a
		WHERE a.status='published' AND a.published_at <= $2 AND a.expires_at > $2
		AND NOT EXISTS (SELECT 1 FROM claudex_announcement_reads x WHERE x.announcement_id=a.id AND x.user_id=$1)
		ORDER BY a.published_at ASC, a.id ASC LIMIT 20`, userID, now)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []row
	for rows.Next() {
		r, err := scanRow(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *r)
	}
	return out, rows.Err()
}

func (s *sqlStore) markRead(ctx context.Context, id, userID int64, action string, now time.Time) (bool, error) {
	res, err := s.db.ExecContext(ctx, `INSERT INTO claudex_announcement_reads (announcement_id, user_id, action, read_at)
		SELECT a.id, $2, $3, $4 FROM claudex_announcements a
		WHERE a.id=$1 AND a.status='published' AND a.expires_at > $4
		ON CONFLICT (announcement_id, user_id) DO NOTHING`, id, userID, action, now)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	if n > 0 {
		return true, nil
	}
	// Already read counts as done; only a missing or dead announcement is false.
	var live bool
	err = s.db.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM claudex_announcements
		WHERE id=$1 AND status='published' AND expires_at > $2)`, id, now).Scan(&live)
	return live, err
}

func (s *sqlStore) createMail(ctx context.Context, subject, body string, recipients int, by int64, now time.Time) (int64, error) {
	var id int64
	err := s.db.QueryRowContext(ctx, `INSERT INTO claudex_announcement_mails
		(subject, body_html, recipients, status, created_by, created_at) VALUES ($1,$2,$3,'sending',$4,$5) RETURNING id`,
		subject, body, recipients, by, now).Scan(&id)
	return id, err
}

func (s *sqlStore) mailProgress(ctx context.Context, id int64, sent, failed int, done bool, now time.Time) error {
	if done {
		_, err := s.db.ExecContext(ctx, `UPDATE claudex_announcement_mails SET sent=$2, failed=$3,
			status='done', finished_at=$4 WHERE id=$1`, id, sent, failed, now)
		return err
	}
	_, err := s.db.ExecContext(ctx, `UPDATE claudex_announcement_mails SET sent=$2, failed=$3 WHERE id=$1`, id, sent, failed)
	return err
}

func (s *sqlStore) listMails(ctx context.Context, limit int) ([]mailRow, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, subject, body_html, recipients, sent, failed, status,
		created_at, finished_at FROM claudex_announcement_mails ORDER BY id DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []mailRow
	for rows.Next() {
		var m mailRow
		var finished sql.NullTime
		if err := rows.Scan(&m.ID, &m.Subject, &m.BodyHTML, &m.Recipients, &m.Sent, &m.Failed, &m.Status,
			&m.CreatedAt, &finished); err != nil {
			return nil, err
		}
		if finished.Valid {
			t := finished.Time
			m.FinishedAt = &t
		}
		out = append(out, m)
	}
	return out, rows.Err()
}
