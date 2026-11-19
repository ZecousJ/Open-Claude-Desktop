// Package usermigrate imports users exported from the ZecousAI service into
// the Sub2API fork (package ZMIG, command cmd/claudex-import-users).
//
// Each record is matched by e-mail, so running the same file again is safe:
//   - a new e-mail creates a user that keeps the legacy password hash as is
//     (internal/claudex/legacypw verifies it and the first sign-in rehashes it);
//   - an e-mail that belongs to a user created by an earlier import run is
//     skipped, or refreshed with Options.UpdateExisting;
//   - an e-mail that belongs to any other user is a conflict and is never touched.
//
// credit_cny is added to the balance through the admin balance adjustment path
// (a balance-history record of type admin_balance whose notes start with
// Marker). The credit is applied once per user: a later run first looks for
// that record, which also finishes a run that stopped between the two writes.
package usermigrate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/mail"
	"strconv"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/legacypw"
	"github.com/Wei-Shaw/sub2api/internal/service"
)

// Marker starts the notes of every imported user and of every migration
// balance-history record.
const Marker = "[claudex-migration zecousai]"

const (
	maxUsernameRunes = 100 // users.username
	maxEmailLen      = 255 // users.email
	maxHashLen       = 255 // users.password_hash
)

// Record is one entry of the export file (a JSON array of these).
type Record struct {
	OldID        FlexString `json:"id"`
	OldIDAlt     FlexString `json:"old_id"`
	Email        string     `json:"email"`
	Username     string     `json:"username"`
	DisplayName  string     `json:"display_name"`
	PasswordHash string     `json:"password_hash"`
	IsActive     *bool      `json:"is_active"`
	CreatedAt    string     `json:"created_at"`
	CreditCNY    float64    `json:"credit_cny"`
	Note         string     `json:"note"`
}

// LegacyID returns the old service's id ("id", or "old_id").
func (r Record) LegacyID() string {
	if s := strings.TrimSpace(string(r.OldID)); s != "" {
		return s
	}
	return strings.TrimSpace(string(r.OldIDAlt))
}

// FlexString accepts a JSON string or number (UUIDs and integer ids).
type FlexString string

func (f *FlexString) UnmarshalJSON(b []byte) error {
	if string(b) == "null" {
		*f = ""
		return nil
	}
	var s string
	if err := json.Unmarshal(b, &s); err == nil {
		*f = FlexString(s)
		return nil
	}
	var n json.Number
	if err := json.Unmarshal(b, &n); err != nil {
		return fmt.Errorf("id must be a string or a number")
	}
	*f = FlexString(n.String())
	return nil
}

// ParseRecords reads a JSON array of records.
func ParseRecords(r io.Reader) ([]Record, error) {
	dec := json.NewDecoder(r)
	dec.DisallowUnknownFields()
	var records []Record
	if err := dec.Decode(&records); err != nil {
		return nil, fmt.Errorf("parse import file: %w", err)
	}
	return records, nil
}

// Store is what the importer needs from the fork. The command wires it to the
// user repository, the redeem-code (balance history) repository and
// AdminService.UpdateUserBalance; tests use a fake.
type Store interface {
	// GetUserByEmail returns service.ErrUserNotFound when there is no user.
	GetUserByEmail(ctx context.Context, email string) (*service.User, error)
	// UsersWithUsername returns users whose username equals username exactly.
	UsersWithUsername(ctx context.Context, username string) ([]service.User, error)
	CreateUser(ctx context.Context, user *service.User) error
	UpdateUser(ctx context.Context, user *service.User, fields service.UserUpdateFields) error
	// MigrationCredited reports whether the user already has a balance-history
	// record written by this importer.
	MigrationCredited(ctx context.Context, userID int64) (bool, error)
	// CreditBalance adds amount through the audited admin adjustment path.
	CreditBalance(ctx context.Context, userID int64, amount float64, notes string) error
}

// Options control an import run.
type Options struct {
	DryRun bool
	// UpdateExisting refreshes users created by an earlier run (username,
	// notes, status, and the password hash while it is still the legacy one).
	UpdateExisting bool
	// BalancePerCNY converts credit_cny into balance units (default 1).
	BalancePerCNY float64
	// Concurrency and RPMLimit of new users (the fork's defaults for new users).
	Concurrency int
	RPMLimit    int
	Now         func() time.Time
}

// Actions reported per record.
const (
	ActionCreated     = "created"
	ActionWouldCreate = "would_create"
	ActionUpdated     = "updated"
	ActionWouldUpdate = "would_update"
	ActionSkipped     = "skipped" // already imported, nothing to change
	ActionConflict    = "conflict"
	ActionInvalid     = "invalid"
	ActionError       = "error"

	CreditApplied    = "applied"
	CreditWouldApply = "would_apply"
	CreditAlready    = "already_applied"
	CreditNone       = "none"
)

// Item is the outcome for one record; OldID → NewID is the id mapping.
type Item struct {
	Index        int      `json:"index"`
	OldID        string   `json:"old_id,omitempty"`
	Email        string   `json:"email"`
	NewID        int64    `json:"new_id,omitempty"`
	Action       string   `json:"action"`
	Status       string   `json:"status,omitempty"`
	HashScheme   string   `json:"hash_scheme,omitempty"`
	CreditCNY    float64  `json:"credit_cny,omitempty"`
	CreditAmount float64  `json:"credit_amount,omitempty"`
	CreditAction string   `json:"credit_action"`
	Conflict     string   `json:"conflict,omitempty"`
	Warnings     []string `json:"warnings,omitempty"`
	Error        string   `json:"error,omitempty"`
}

// Summary counts the items by outcome.
type Summary struct {
	Total         int     `json:"total"`
	Created       int     `json:"created"`
	Updated       int     `json:"updated"`
	Skipped       int     `json:"skipped"`
	Conflicts     int     `json:"conflicts"`
	Invalid       int     `json:"invalid"`
	Errors        int     `json:"errors"`
	Credited      int     `json:"credited"`
	CreditedTotal float64 `json:"credited_total"`
	Warnings      int     `json:"warnings"`
}

// Report is the result of a run.
type Report struct {
	DryRun        bool      `json:"dry_run"`
	StartedAt     time.Time `json:"started_at"`
	BalancePerCNY float64   `json:"balance_per_cny"`
	Summary       Summary   `json:"summary"`
	Items         []Item    `json:"items"`
}

// Failed reports whether any record ended in an error (not a conflict).
func (r *Report) Failed() bool { return r.Summary.Errors > 0 }

// Run imports records. Per-record problems are reported in the items; the
// returned error is only for a problem that stops the whole run.
func Run(ctx context.Context, store Store, records []Record, opts Options) (*Report, error) {
	if store == nil {
		return nil, errors.New("usermigrate: nil store")
	}
	if opts.BalancePerCNY == 0 {
		opts.BalancePerCNY = 1
	}
	if opts.BalancePerCNY < 0 || math.IsNaN(opts.BalancePerCNY) || math.IsInf(opts.BalancePerCNY, 0) {
		return nil, fmt.Errorf("usermigrate: invalid balance-per-cny %v", opts.BalancePerCNY)
	}
	now := time.Now
	if opts.Now != nil {
		now = opts.Now
	}
	rep := &Report{DryRun: opts.DryRun, StartedAt: now().UTC(), BalancePerCNY: opts.BalancePerCNY}

	seenEmail := map[string]int{}
	seenUsername := map[string]int{}
	for i, rec := range records {
		if err := ctx.Err(); err != nil {
			return rep, err
		}
		item := importOne(ctx, store, i, rec, opts, seenEmail, seenUsername)
		rep.Items = append(rep.Items, item)
		rep.Summary.add(item)
	}
	rep.Summary.CreditedTotal = round8(rep.Summary.CreditedTotal)
	return rep, nil
}

func (s *Summary) add(it Item) {
	s.Total++
	switch it.Action {
	case ActionCreated, ActionWouldCreate:
		s.Created++
	case ActionUpdated, ActionWouldUpdate:
		s.Updated++
	case ActionSkipped:
		s.Skipped++
	case ActionConflict:
		s.Conflicts++
	case ActionInvalid:
		s.Invalid++
	case ActionError:
		s.Errors++
	}
	if it.CreditAction == CreditApplied || it.CreditAction == CreditWouldApply {
		s.Credited++
		s.CreditedTotal += it.CreditAmount
	}
	s.Warnings += len(it.Warnings)
}

type prepared struct {
	email, username, hash, status, notes string
	credit                               float64
}

func importOne(ctx context.Context, store Store, index int, rec Record, opts Options, seenEmail, seenUsername map[string]int) Item {
	item := Item{Index: index, OldID: rec.LegacyID(), CreditAction: CreditNone}
	p, err := prepare(rec, opts, &item)
	if err != nil {
		item.Action = ActionInvalid
		item.Error = err.Error()
		return item
	}
	item.Email = p.email
	item.Status = p.status
	item.CreditCNY = rec.CreditCNY
	item.CreditAmount = p.credit

	if first, dup := seenEmail[p.email]; dup {
		item.Action = ActionConflict
		item.Conflict = fmt.Sprintf("duplicate e-mail in the import file (first at index %d); record skipped", first)
		return item
	}
	seenEmail[p.email] = index
	if p.username != "" {
		key := strings.ToLower(p.username)
		if first, dup := seenUsername[key]; dup {
			item.Warnings = append(item.Warnings, fmt.Sprintf("username %q repeats index %d of the import file (Sub2API usernames are not unique; sign-in is by e-mail)", p.username, first))
		} else {
			seenUsername[key] = index
		}
	}

	existing, err := store.GetUserByEmail(ctx, p.email)
	switch {
	case err == nil && existing != nil:
		return handleExisting(ctx, store, item, p, existing, opts)
	case err != nil && !errors.Is(err, service.ErrUserNotFound):
		item.Action = ActionError
		item.Error = "look up e-mail: " + err.Error()
		return item
	}

	if p.username != "" {
		clashes, err := store.UsersWithUsername(ctx, p.username)
		if err != nil {
			item.Warnings = append(item.Warnings, "username clash check failed: "+err.Error())
		}
		for _, u := range clashes {
			item.Warnings = append(item.Warnings, fmt.Sprintf("username %q is already used by user %d (%s)", p.username, u.ID, u.Email))
		}
	}

	if opts.DryRun {
		item.Action = ActionWouldCreate
		if p.credit > 0 {
			item.CreditAction = CreditWouldApply
		}
		return item
	}
	user := &service.User{
		Email:        p.email,
		Username:     p.username,
		Notes:        p.notes,
		PasswordHash: p.hash,
		Role:         service.RoleUser,
		Status:       p.status,
		Concurrency:  opts.Concurrency,
		RPMLimit:     opts.RPMLimit,
		SignupSource: "email",
	}
	if err := store.CreateUser(ctx, user); err != nil {
		if errors.Is(err, service.ErrEmailExists) {
			item.Action = ActionConflict
			item.Conflict = "e-mail already registered (normalized e-mail match)"
			return item
		}
		item.Action = ActionError
		item.Error = "create user: " + err.Error()
		return item
	}
	item.NewID = user.ID
	item.Action = ActionCreated
	applyCredit(ctx, store, &item, p, user.ID, opts.BalancePerCNY, false)
	return item
}

func handleExisting(ctx context.Context, store Store, item Item, p prepared, existing *service.User, opts Options) Item {
	item.NewID = existing.ID
	if !strings.HasPrefix(existing.Notes, Marker) {
		item.Action = ActionConflict
		item.Conflict = fmt.Sprintf("e-mail belongs to existing user %d that was not created by this import; left unchanged, no credit", existing.ID)
		return item
	}

	item.Action = ActionSkipped
	if opts.UpdateExisting {
		fields := service.UserUpdateFields{}
		updated := *existing
		if existing.Username != p.username {
			updated.Username, fields.Username = p.username, true
		}
		if existing.Notes != p.notes {
			updated.Notes, fields.Notes = p.notes, true
		}
		if existing.Status != p.status {
			updated.Status, fields.Status = p.status, true
		}
		// Never replace a password the user already set or upgraded by signing in.
		if legacypw.IsLegacy(existing.PasswordHash) && existing.PasswordHash != p.hash {
			updated.PasswordHash, fields.PasswordHash = p.hash, true
		} else if !legacypw.IsLegacy(existing.PasswordHash) && existing.PasswordHash != p.hash {
			item.Warnings = append(item.Warnings, "password hash left unchanged: the user has already signed in or changed the password")
		}
		if !fields.IsEmpty() {
			if opts.DryRun {
				item.Action = ActionWouldUpdate
			} else if err := store.UpdateUser(ctx, &updated, fields); err != nil {
				item.Action = ActionError
				item.Error = "update user: " + err.Error()
				return item
			} else {
				item.Action = ActionUpdated
			}
		}
	}
	applyCredit(ctx, store, &item, p, existing.ID, opts.BalancePerCNY, opts.DryRun)
	return item
}

func applyCredit(ctx context.Context, store Store, item *Item, p prepared, userID int64, rate float64, dryRun bool) {
	if p.credit <= 0 {
		return
	}
	done, err := store.MigrationCredited(ctx, userID)
	if err != nil {
		item.Action = ActionError
		item.Error = "check migration credit: " + err.Error()
		return
	}
	if done {
		item.CreditAction = CreditAlready
		return
	}
	if dryRun {
		item.CreditAction = CreditWouldApply
		return
	}
	notes := fmt.Sprintf("%s credit_cny=%s balance_per_cny=%s", Marker, formatFloat(item.CreditCNY), formatFloat(rate))
	if item.OldID != "" {
		notes += " old_id=" + item.OldID
	}
	if err := store.CreditBalance(ctx, userID, p.credit, notes); err != nil {
		item.Action = ActionError
		item.Error = "credit balance: " + err.Error()
		return
	}
	item.CreditAction = CreditApplied
}

func prepare(rec Record, opts Options, item *Item) (prepared, error) {
	var p prepared
	email := strings.ToLower(strings.TrimSpace(rec.Email))
	item.Email = email
	if email == "" {
		return p, errors.New("missing email")
	}
	if len(email) > maxEmailLen {
		return p, errors.New("email longer than 255 characters")
	}
	if addr, err := mail.ParseAddress(email); err != nil || addr.Address != email {
		return p, errors.New("invalid email")
	}
	p.email = email

	p.hash = strings.TrimSpace(rec.PasswordHash)
	if p.hash == "" {
		return p, errors.New("missing password_hash")
	}
	if len(p.hash) > maxHashLen {
		return p, errors.New("password_hash longer than 255 characters")
	}
	scheme := legacypw.Detect(p.hash)
	if scheme == legacypw.SchemeUnknown {
		return p, errors.New("unsupported password_hash format")
	}
	item.HashScheme = string(scheme)

	if math.IsNaN(rec.CreditCNY) || math.IsInf(rec.CreditCNY, 0) || rec.CreditCNY < 0 {
		return p, errors.New("credit_cny must be a non-negative number")
	}
	p.credit = round8(rec.CreditCNY * opts.BalancePerCNY)

	p.status = service.StatusActive
	if rec.IsActive != nil && !*rec.IsActive {
		p.status = service.StatusDisabled
	}

	username := strings.TrimSpace(rec.Username)
	display := strings.TrimSpace(rec.DisplayName)
	if username == "" {
		username = display
	}
	if r := []rune(username); len(r) > maxUsernameRunes {
		username = string(r[:maxUsernameRunes])
		item.Warnings = append(item.Warnings, "username truncated to 100 characters")
	}
	p.username = username

	var meta []string
	if id := rec.LegacyID(); id != "" {
		meta = append(meta, "old_id="+id)
	}
	if created := strings.TrimSpace(rec.CreatedAt); created != "" {
		if _, err := parseTime(created); err != nil {
			item.Warnings = append(item.Warnings, "created_at is not an ISO-8601 time; kept as text in notes")
		}
		meta = append(meta, "created_at="+created)
	}
	if display != "" && display != username {
		meta = append(meta, "display_name="+strconv.Quote(display))
	}
	notes := Marker
	if len(meta) > 0 {
		notes += " " + strings.Join(meta, " ")
	}
	if n := strings.TrimSpace(rec.Note); n != "" {
		notes += "\n" + n
	}
	p.notes = notes
	return p, nil
}

func parseTime(s string) (time.Time, error) {
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05.999999", "2006-01-02 15:04:05.999999-07:00", "2006-01-02 15:04:05.999999", "2006-01-02"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t, nil
		}
	}
	return time.Time{}, errors.New("unrecognised time")
}

func round8(v float64) float64 { return math.Round(v*1e8) / 1e8 }

func formatFloat(v float64) string { return strconv.FormatFloat(v, 'f', -1, 64) }
