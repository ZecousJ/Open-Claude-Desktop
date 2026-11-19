//go:build unit

package zmigrate

import (
	"context"
	"errors"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/stretchr/testify/require"
)

type fakeRemote struct {
	answer Answer
	err    error
	emails []string
}

func (f *fakeRemote) Quote(context.Context, string) (Answer, error) { return f.answer, f.err }

func (f *fakeRemote) Confirm(_ context.Context, email string, _ int64) (Answer, error) {
	f.emails = append(f.emails, email)
	return f.answer, f.err
}

type migrationUserRepo struct {
	service.UserRepository
	email string
}

func (r migrationUserRepo) GetByID(_ context.Context, id int64) (*service.User, error) {
	return &service.User{ID: id, Email: r.email}, nil
}

func newComponent(t *testing.T, remote Remote) (*Component, sqlmock.Sqlmock) {
	t.Helper()
	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	c := &Component{
		env: &core.Env{Deps: core.Deps{
			DB:       db,
			UserRepo: migrationUserRepo{email: " new@example.com "},
		}},
		remote: remote,
	}
	return c, mock
}

func TestValuationValidatesAmountAndBreakdown(t *testing.T) {
	for _, tc := range []struct {
		name  string
		parts [3]string
		want  Status
	}{
		{"zero", [3]string{"0.00", "0.00", "0.00"}, Status{State: "pending"}},
		{"rounding", [3]string{"1.205", "0.6875", "0.52"}, Status{State: "pending", AmountUSD: 1.21, BalanceUSD: 0.69, SubscriptionUSD: 0.52}},
		{"invalid total", [3]string{"NaN", "1", "0"}, Status{}},
		{"missing breakdown", [3]string{"1.00", "1.00", ""}, Status{}},
		{"negative component", [3]string{"1.00", "2.00", "-1.00"}, Status{}},
		{"inconsistent total", [3]string{"1.00", "0.10", "0.80"}, Status{}},
		{"numeric overflow", [3]string{"1000000000000", "1000000000000", "0"}, Status{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := Answer{TotalCNY: tc.parts[0], BalanceCNY: tc.parts[1], SubscriptionCNY: tc.parts[2]}
			got, err := a.valuation("pending")
			if tc.want.State == "" {
				require.Error(t, err)
			} else {
				require.NoError(t, err)
			}
			require.Equal(t, tc.want, got)
		})
	}
}

func TestConfirmAlreadyCreditedReturnsRecordedStatus(t *testing.T) {
	remote := &fakeRemote{}
	c, mock := newComponent(t, remote)
	mock.ExpectQuery("SELECT state, email, amount_usd, detail FROM claudex_zecous_migrations").
		WithArgs(int64(7)).WillReturnRows(sqlmock.NewRows([]string{"state", "email", "amount_usd", "detail"}).
		AddRow("credited", "a@example.com", 50.5, `{"total_cny":"50.50","balance_cny":"40.50","subscription_cny":"10.00"}`))
	status, err := c.confirm(context.Background(), 7)
	require.NoError(t, err)
	require.Equal(t, Status{State: "done", AmountUSD: 50.5, BalanceUSD: 40.5, SubscriptionUSD: 10}, status)
	require.Empty(t, remote.emails)
	require.NoError(t, mock.ExpectationsWereMet())
}

func TestConfirmRetryUsesStoredEmail(t *testing.T) {
	remote := &fakeRemote{err: errors.New("remote unavailable")}
	c, mock := newComponent(t, remote)
	mock.ExpectQuery("SELECT state, email, amount_usd, detail FROM claudex_zecous_migrations").
		WithArgs(int64(7)).WillReturnRows(sqlmock.NewRows([]string{"state", "email", "amount_usd", "detail"}).
		AddRow("confirming", "old@example.com", 0, "{}"))
	_, err := c.confirm(context.Background(), 7)
	require.ErrorIs(t, err, errUnavailable)
	require.Equal(t, []string{"old@example.com"}, remote.emails)
	require.NoError(t, mock.ExpectationsWereMet())
}

func TestConfirmReassignedHistoricalEmailCannotMove(t *testing.T) {
	remote := &fakeRemote{}
	c, mock := newComponent(t, remote)
	columns := []string{"state", "email", "amount_usd", "detail"}
	mock.ExpectQuery("SELECT state, email, amount_usd, detail FROM claudex_zecous_migrations").
		WithArgs(int64(7)).WillReturnRows(sqlmock.NewRows(columns))
	mock.ExpectExec("INSERT INTO claudex_zecous_migrations").
		WithArgs(int64(7), "new@example.com").WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectQuery("SELECT state, email, amount_usd, detail FROM claudex_zecous_migrations").
		WithArgs(int64(7)).WillReturnRows(sqlmock.NewRows(columns))
	_, err := c.confirm(context.Background(), 7)
	require.ErrorIs(t, err, errNothing)
	require.Empty(t, remote.emails)
	require.NoError(t, mock.ExpectationsWereMet())
}

func TestConfirmRefusesMoveRecordedForAnotherUser(t *testing.T) {
	remote := &fakeRemote{answer: Answer{OK: true, Found: true, Migrated: true, ClaudexUserID: "8"}}
	c, mock := newComponent(t, remote)
	mock.ExpectQuery("SELECT state, email, amount_usd, detail FROM claudex_zecous_migrations").
		WithArgs(int64(7)).WillReturnRows(sqlmock.NewRows([]string{"state", "email", "amount_usd", "detail"}).
		AddRow("confirming", "old@example.com", 0, "{}"))
	mock.ExpectExec("DELETE FROM claudex_zecous_migrations").
		WithArgs(int64(7), "old@example.com").WillReturnResult(sqlmock.NewResult(0, 1))
	_, err := c.confirm(context.Background(), 7)
	require.ErrorIs(t, err, errNothing)
	require.NoError(t, mock.ExpectationsWereMet())
}

func TestNotReadyWithoutTarget(t *testing.T) {
	require.False(t, (&Component{}).ready())
}
