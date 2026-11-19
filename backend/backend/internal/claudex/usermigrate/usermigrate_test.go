package usermigrate

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/stretchr/testify/require"
)

const (
	hashPasslib  = "$bcrypt-sha256$v=2,t=2b,r=4$g.KXyKrsnYGb4dyhquY11e$vQZL03xE38FkuJqXiDwqw3DjVW9JjNy"
	hashWerkzeug = "pbkdf2:sha256:1000$bwIAYKGbSgQQsupq$625ad9f533557de84af07b881de4dbb259f7e9d43bfffb4b9720628cf91f0d72"
	hashBcrypt   = "$2b$04$D7il.1HCzPugQNs5PCa6PO7BTKDYjyzZlJPYFn9o.Eq2/.BTiU6eK"
)

type credit struct {
	userID int64
	amount float64
	notes  string
}

type fakeStore struct {
	users      map[string]*service.User
	nextID     int64
	credits    []credit
	creates    int
	updates    []service.UserUpdateFields
	failCredit error
}

func newFakeStore() *fakeStore { return &fakeStore{users: map[string]*service.User{}, nextID: 100} }

func (f *fakeStore) GetUserByEmail(_ context.Context, email string) (*service.User, error) {
	if u, ok := f.users[strings.ToLower(email)]; ok {
		cp := *u
		return &cp, nil
	}
	return nil, service.ErrUserNotFound
}

func (f *fakeStore) UsersWithUsername(_ context.Context, username string) ([]service.User, error) {
	var out []service.User
	for _, u := range f.users {
		if u.Username == username {
			out = append(out, *u)
		}
	}
	return out, nil
}

func (f *fakeStore) CreateUser(_ context.Context, u *service.User) error {
	if _, ok := f.users[u.Email]; ok {
		return service.ErrEmailExists
	}
	f.nextID++
	u.ID = f.nextID
	cp := *u
	f.users[u.Email] = &cp
	f.creates++
	return nil
}

func (f *fakeStore) UpdateUser(_ context.Context, u *service.User, fields service.UserUpdateFields) error {
	f.updates = append(f.updates, fields)
	cur := f.users[u.Email]
	if fields.Username {
		cur.Username = u.Username
	}
	if fields.Notes {
		cur.Notes = u.Notes
	}
	if fields.Status {
		cur.Status = u.Status
	}
	if fields.PasswordHash {
		cur.PasswordHash = u.PasswordHash
	}
	return nil
}

func (f *fakeStore) MigrationCredited(_ context.Context, userID int64) (bool, error) {
	for _, c := range f.credits {
		if c.userID == userID && strings.HasPrefix(c.notes, Marker) {
			return true, nil
		}
	}
	return false, nil
}

func (f *fakeStore) CreditBalance(_ context.Context, userID int64, amount float64, notes string) error {
	if f.failCredit != nil {
		return f.failCredit
	}
	f.credits = append(f.credits, credit{userID, amount, notes})
	for _, u := range f.users {
		if u.ID == userID {
			u.Balance += amount
		}
	}
	return nil
}

func boolp(b bool) *bool { return &b }

const sample = `[
 {"id":"6f0c-uuid-1","email":" Alice@Example.com ","username":"alice","display_name":"Alice L","password_hash":"` + hashPasslib + `","is_active":true,"created_at":"2026-05-01T10:00:00+00:00","credit_cny":12.5,"note":"paid Pro"},
 {"id":"6f0c-uuid-2","email":"bob@example.com","username":"bob","display_name":null,"password_hash":"` + hashWerkzeug + `","is_active":false,"created_at":"2026-03-02 08:00:00","credit_cny":0,"note":""}
]`

func TestParseRecords(t *testing.T) {
	recs, err := ParseRecords(strings.NewReader(sample))
	require.NoError(t, err)
	require.Len(t, recs, 2)
	require.Equal(t, "6f0c-uuid-1", recs[0].LegacyID())
	require.False(t, *recs[1].IsActive)

	recs, err = ParseRecords(strings.NewReader(`[{"old_id":17,"email":"a@b.co","password_hash":"x"}]`))
	require.NoError(t, err)
	require.Equal(t, "17", recs[0].LegacyID())

	_, err = ParseRecords(strings.NewReader(`[{"email":"a@b.co","pasword_hash":"typo"}]`))
	require.Error(t, err, "unknown fields are rejected so a typo cannot silently drop data")
}

func TestRunCreatesUsersAndCreditsOnce(t *testing.T) {
	recs, err := ParseRecords(strings.NewReader(sample))
	require.NoError(t, err)
	store := newFakeStore()
	opts := Options{Concurrency: 3, RPMLimit: 7}

	rep, err := Run(context.Background(), store, recs, opts)
	require.NoError(t, err)
	require.Equal(t, 2, rep.Summary.Created)
	require.Equal(t, 1, rep.Summary.Credited)
	require.InDelta(t, 12.5, rep.Summary.CreditedTotal, 1e-9)
	require.False(t, rep.Failed())

	alice := store.users["alice@example.com"]
	require.NotNil(t, alice)
	require.Equal(t, hashPasslib, alice.PasswordHash, "legacy hash stored as is")
	require.Equal(t, service.StatusActive, alice.Status)
	require.Equal(t, service.RoleUser, alice.Role)
	require.Equal(t, 3, alice.Concurrency)
	require.Equal(t, 7, alice.RPMLimit)
	require.Equal(t, "alice", alice.Username)
	require.True(t, strings.HasPrefix(alice.Notes, Marker))
	require.Contains(t, alice.Notes, "old_id=6f0c-uuid-1")
	require.Contains(t, alice.Notes, `display_name="Alice L"`)
	require.Contains(t, alice.Notes, "\npaid Pro")
	require.InDelta(t, 12.5, alice.Balance, 1e-9)
	require.Len(t, store.credits, 1)
	require.Contains(t, store.credits[0].notes, "credit_cny=12.5")

	bob := store.users["bob@example.com"]
	require.Equal(t, service.StatusDisabled, bob.Status)
	require.Equal(t, hashWerkzeug, bob.PasswordHash)

	require.Equal(t, "6f0c-uuid-1", rep.Items[0].OldID)
	require.Equal(t, alice.ID, rep.Items[0].NewID)
	require.Equal(t, CreditApplied, rep.Items[0].CreditAction)

	// Second run: nothing changes, nothing credited twice.
	rep2, err := Run(context.Background(), store, recs, opts)
	require.NoError(t, err)
	require.Equal(t, 2, rep2.Summary.Skipped)
	require.Equal(t, 0, rep2.Summary.Credited)
	require.Equal(t, CreditAlready, rep2.Items[0].CreditAction)
	require.Equal(t, alice.ID, rep2.Items[0].NewID)
	require.Len(t, store.credits, 1)
	require.Equal(t, 2, store.creates)
}

func TestRunDryRunWritesNothing(t *testing.T) {
	recs, err := ParseRecords(strings.NewReader(sample))
	require.NoError(t, err)
	store := newFakeStore()
	rep, err := Run(context.Background(), store, recs, Options{DryRun: true})
	require.NoError(t, err)
	require.True(t, rep.DryRun)
	require.Equal(t, ActionWouldCreate, rep.Items[0].Action)
	require.Equal(t, CreditWouldApply, rep.Items[0].CreditAction)
	require.Equal(t, 1, rep.Summary.Credited)
	require.Empty(t, store.users)
	require.Empty(t, store.credits)
}

func TestRunConflictsWithForeignUser(t *testing.T) {
	store := newFakeStore()
	store.users["alice@example.com"] = &service.User{ID: 5, Email: "alice@example.com", Username: "someone", PasswordHash: hashBcrypt, Status: service.StatusActive}
	store.users["carol@example.com"] = &service.User{ID: 6, Email: "carol@example.com", Username: "bob", PasswordHash: hashBcrypt}
	recs, err := ParseRecords(strings.NewReader(sample))
	require.NoError(t, err)

	rep, err := Run(context.Background(), store, recs, Options{UpdateExisting: true})
	require.NoError(t, err)
	require.Equal(t, ActionConflict, rep.Items[0].Action)
	require.Equal(t, int64(5), rep.Items[0].NewID)
	require.Contains(t, rep.Items[0].Conflict, "not created by this import")
	require.Equal(t, "someone", store.users["alice@example.com"].Username, "foreign user untouched")
	require.Empty(t, store.credits, "no credit for a conflicting e-mail")

	// bob is created, with a warning about the username already used by carol.
	require.Equal(t, ActionCreated, rep.Items[1].Action)
	require.Len(t, rep.Items[1].Warnings, 1)
	require.Contains(t, rep.Items[1].Warnings[0], `username "bob" is already used by user 6`)
	require.Equal(t, 1, rep.Summary.Conflicts)
}

func TestRunDuplicateAndInvalidRecords(t *testing.T) {
	recs := []Record{
		{Email: "a@example.com", Username: "same", PasswordHash: hashPasslib},
		{Email: "A@example.com", Username: "other", PasswordHash: hashPasslib},
		{Email: "b@example.com", Username: "Same", PasswordHash: hashPasslib},
		{Email: "not-an-email", PasswordHash: hashPasslib},
		{Email: "c@example.com", PasswordHash: "md5$abc"},
		{Email: "d@example.com", PasswordHash: hashPasslib, CreditCNY: -1},
		{Email: "e@example.com"},
	}
	store := newFakeStore()
	rep, err := Run(context.Background(), store, recs, Options{})
	require.NoError(t, err)
	require.Equal(t, ActionCreated, rep.Items[0].Action)
	require.Equal(t, ActionConflict, rep.Items[1].Action)
	require.Contains(t, rep.Items[1].Conflict, "duplicate e-mail")
	require.Equal(t, ActionCreated, rep.Items[2].Action)
	require.NotEmpty(t, rep.Items[2].Warnings, "case-insensitive username repeat in file")
	for _, i := range []int{3, 4, 5, 6} {
		require.Equal(t, ActionInvalid, rep.Items[i].Action, i)
	}
	require.Equal(t, 4, rep.Summary.Invalid)
	require.Equal(t, 2, store.creates)
}

func TestRunUpdateExistingKeepsUpgradedPassword(t *testing.T) {
	store := newFakeStore()
	recs := []Record{{OldID: "1", Email: "a@example.com", Username: "a", PasswordHash: hashPasslib, CreditCNY: 3}}
	_, err := Run(context.Background(), store, recs, Options{})
	require.NoError(t, err)

	// The user signs in (hash upgraded to bcrypt); the export is fixed and re-run.
	store.users["a@example.com"].PasswordHash = hashBcrypt
	recs[0].Username = "a-renamed"
	recs[0].IsActive = boolp(false)
	recs[0].PasswordHash = hashWerkzeug
	recs[0].CreditCNY = 9 // changed credit is not applied twice

	dry, err := Run(context.Background(), store, recs, Options{UpdateExisting: true, DryRun: true})
	require.NoError(t, err)
	require.Equal(t, ActionWouldUpdate, dry.Items[0].Action)
	require.Empty(t, store.updates)

	rep, err := Run(context.Background(), store, recs, Options{UpdateExisting: true})
	require.NoError(t, err)
	require.Equal(t, ActionUpdated, rep.Items[0].Action)
	require.Equal(t, CreditAlready, rep.Items[0].CreditAction)
	u := store.users["a@example.com"]
	require.Equal(t, "a-renamed", u.Username)
	require.Equal(t, service.StatusDisabled, u.Status)
	require.Equal(t, hashBcrypt, u.PasswordHash)
	require.Len(t, store.updates, 1)
	require.False(t, store.updates[0].PasswordHash)
	require.NotEmpty(t, rep.Items[0].Warnings)
	require.Len(t, store.credits, 1)
}

func TestRunResumesMissingCredit(t *testing.T) {
	store := newFakeStore()
	store.failCredit = errors.New("db down")
	recs := []Record{{Email: "a@example.com", PasswordHash: hashPasslib, CreditCNY: 4}}
	rep, err := Run(context.Background(), store, recs, Options{BalancePerCNY: 0.5})
	require.NoError(t, err)
	require.True(t, rep.Failed())
	require.Equal(t, ActionError, rep.Items[0].Action)
	require.NotZero(t, rep.Items[0].NewID)

	store.failCredit = nil
	rep, err = Run(context.Background(), store, recs, Options{BalancePerCNY: 0.5})
	require.NoError(t, err)
	require.Equal(t, ActionSkipped, rep.Items[0].Action)
	require.Equal(t, CreditApplied, rep.Items[0].CreditAction)
	require.Len(t, store.credits, 1)
	require.InDelta(t, 2.0, store.credits[0].amount, 1e-9)
	require.Contains(t, store.credits[0].notes, "balance_per_cny=0.5")
}

func TestRunRejectsBadRate(t *testing.T) {
	_, err := Run(context.Background(), newFakeStore(), nil, Options{BalancePerCNY: -1})
	require.Error(t, err)
}
