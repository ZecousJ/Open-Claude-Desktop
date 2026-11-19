package productfeedback

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestSQLClaimCommitBeforeDispatchAuthority(t *testing.T) {
	db, m, e := sqlmock.New()
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	now := time.Now()
	m.ExpectBegin()
	m.ExpectExec("SELECT pg_advisory_xact_lock").WithArgs("claudex.product-feedback:7").WillReturnResult(sqlmock.NewResult(0, 1))
	m.ExpectQuery("SELECT feedback_id").WithArgs(int64(7), "request").WillReturnError(sql.ErrNoRows)
	m.ExpectQuery("SELECT count").WithArgs(int64(7), now.Add(-time.Hour)).WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
	m.ExpectExec("INSERT INTO claudex_product_feedback_receipts").WithArgs(int64(7), "request", "feedback", "hash", now).WillReturnResult(sqlmock.NewResult(0, 1))
	m.ExpectCommit()
	r, fresh, e := (&sqlStore{db: db}).Claim(context.Background(), 7, "request", "hash", "feedback", now)
	if e != nil || !fresh || r.Status != "sending" {
		t.Fatal(r, fresh, e)
	}
	if e = m.ExpectationsWereMet(); e != nil {
		t.Fatal(e)
	}
}
func TestSQLExistingReceiptNeverClaimsAgain(t *testing.T) {
	db, m, e := sqlmock.New()
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	m.ExpectBegin()
	m.ExpectExec("SELECT pg_advisory_xact_lock").WillReturnResult(sqlmock.NewResult(0, 1))
	m.ExpectQuery("SELECT feedback_id").WithArgs(int64(7), "request").WillReturnRows(sqlmock.NewRows([]string{"feedback_id", "payload_hash", "status"}).AddRow("original", "hash", "sending"))
	m.ExpectCommit()
	r, fresh, e := (&sqlStore{db: db}).Claim(context.Background(), 7, "request", "hash", "replacement", time.Now())
	if e != nil || fresh || r.ID != "original" {
		t.Fatal(r, fresh, e)
	}
	if e = m.ExpectationsWereMet(); e != nil {
		t.Fatal(e)
	}
}
func TestSQLCommitFailureGrantsNoSend(t *testing.T) {
	db, m, e := sqlmock.New()
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	m.ExpectBegin()
	m.ExpectExec("SELECT pg_advisory_xact_lock").WillReturnResult(sqlmock.NewResult(0, 1))
	m.ExpectQuery("SELECT feedback_id").WillReturnError(sql.ErrNoRows)
	m.ExpectQuery("SELECT count").WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
	m.ExpectExec("INSERT INTO claudex_product_feedback_receipts").WillReturnResult(sqlmock.NewResult(0, 1))
	m.ExpectCommit().WillReturnError(errUnavailable)
	if _, fresh, e := (&sqlStore{db: db}).Claim(context.Background(), 7, "request", "hash", "feedback", time.Now()); e == nil || fresh {
		t.Fatal(fresh, e)
	}
	if e = m.ExpectationsWereMet(); e != nil {
		t.Fatal(e)
	}
}

func TestSQLLookupIsOwnerScopedReadOnly(t *testing.T) {
	db, m, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	m.ExpectQuery("SELECT feedback_id.*WHERE user_id=\\$1 AND request_id=\\$2").WithArgs(int64(17), "one").WillReturnRows(sqlmock.NewRows([]string{"feedback_id", "payload_hash", "status"}).AddRow("original", "hash", "unknown"))
	r, found, err := (&sqlStore{db: db}).Lookup(context.Background(), 17, "one")
	if err != nil || !found || r.ID != "original" || r.Status != "unknown" {
		t.Fatal(r, found, err)
	}
	if err = m.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
func TestSQLLookupMissAndFailureAreDistinct(t *testing.T) {
	db, m, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	m.ExpectQuery("SELECT feedback_id").WithArgs(int64(18), "one").WillReturnError(sql.ErrNoRows)
	if _, found, err := (&sqlStore{db: db}).Lookup(context.Background(), 18, "one"); err != nil || found {
		t.Fatal(found, err)
	}
	m.ExpectQuery("SELECT feedback_id").WithArgs(int64(17), "one").WillReturnError(errUnavailable)
	if _, found, err := (&sqlStore{db: db}).Lookup(context.Background(), 17, "one"); err == nil || found {
		t.Fatal(found, err)
	}
	if err = m.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
