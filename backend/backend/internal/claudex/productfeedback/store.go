package productfeedback

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
	"time"
)

type sqlStore struct{ db *sql.DB }

func (s *sqlStore) Lookup(ctx context.Context, userID int64, requestID string) (receipt, bool, error) {
	if s.db == nil {
		return receipt{}, false, errUnavailable
	}
	var r receipt
	err := s.db.QueryRowContext(ctx, `SELECT feedback_id::text, payload_hash, status FROM claudex_product_feedback_receipts WHERE user_id=$1 AND request_id=$2`, userID, requestID).Scan(&r.ID, &r.Hash, &r.Status)
	if errors.Is(err, sql.ErrNoRows) {
		return receipt{}, false, nil
	}
	if err != nil {
		return receipt{}, false, errUnavailable
	}
	return r, true, nil
}

func (s *sqlStore) Claim(ctx context.Context, userID int64, requestID, hash, id string, now time.Time) (receipt, bool, error) {
	if s.db == nil {
		return receipt{}, false, errUnavailable
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return receipt{}, false, errUnavailable
	}
	defer tx.Rollback()
	// One lock per authenticated account across server instances. A hash
	// collision only serializes unrelated callers; it cannot merge receipts.
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, "claudex.product-feedback:"+strconv.FormatInt(userID, 10)); err != nil {
		return receipt{}, false, errUnavailable
	}
	var r receipt
	err = tx.QueryRowContext(ctx, `SELECT feedback_id::text, payload_hash, status FROM claudex_product_feedback_receipts WHERE user_id=$1 AND request_id=$2`, userID, requestID).Scan(&r.ID, &r.Hash, &r.Status)
	if err == nil {
		if err = tx.Commit(); err != nil {
			return receipt{}, false, errUnavailable
		}
		return r, false, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return receipt{}, false, errUnavailable
	}
	var n int
	if err = tx.QueryRowContext(ctx, `SELECT count(*) FROM claudex_product_feedback_receipts WHERE user_id=$1 AND created_at > $2`, userID, now.Add(-time.Hour)).Scan(&n); err != nil {
		return receipt{}, false, errUnavailable
	}
	if n >= perHour {
		return receipt{}, false, errLimited
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO claudex_product_feedback_receipts (user_id,request_id,feedback_id,payload_hash,status,created_at) VALUES ($1,$2,$3,$4,'sending',$5)`, userID, requestID, id, hash, now)
	if err != nil {
		return receipt{}, false, errUnavailable
	}
	// No SMTP operation may start unless COMMIT is known successful.
	if err = tx.Commit(); err != nil {
		return receipt{}, false, errUnavailable
	}
	return receipt{ID: id, Hash: hash, Status: "sending"}, true, nil
}
func (s *sqlStore) Finish(ctx context.Context, userID int64, requestID, status string) error {
	if s.db == nil || (status != "sent" && status != "unknown") {
		return errUnavailable
	}
	result, err := s.db.ExecContext(ctx, `UPDATE claudex_product_feedback_receipts SET status=$3 WHERE user_id=$1 AND request_id=$2 AND status='sending'`, userID, requestID, status)
	if err != nil {
		return errUnavailable
	}
	n, err := result.RowsAffected()
	if err != nil || n != 1 {
		return errUnavailable
	}
	return nil
}

func (s *sqlStore) Release(ctx context.Context, userID int64, requestID, feedbackID string) error {
	if s.db == nil {
		return errUnavailable
	}
	result, err := s.db.ExecContext(ctx, `DELETE FROM claudex_product_feedback_receipts WHERE user_id=$1 AND request_id=$2 AND feedback_id=$3 AND status='sending'`, userID, requestID, feedbackID)
	if err != nil {
		return errUnavailable
	}
	n, err := result.RowsAffected()
	if err != nil || n != 1 {
		return errUnavailable
	}
	return nil
}
