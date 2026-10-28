// Package profile keeps the account step after sign-up (owner, 2026-10-12),
// after the original's "Let's create your account" (live claude.ai bundle,
// 2026-10-12): the name Claudex calls the person, their birthday with the
// age gate, and their acceptance of the Claudex Terms of Service.
//
// An account whose accepted terms are not CurrentTermsVersion (every account
// before the step existed, and everyone after a new version) sees the step
// before the app; once a birthday is on record it is not asked again.
//
// Routes:
//   - user:  GET /api/v1/claudex/account-profile,
//     PUT /api/v1/claudex/account-profile {display_name, birthdate, accept_terms_version}
//   - admin: GET /api/v1/admin/claudex/account-profiles/:user_id (the user
//     detail in the console)
//
// The PUT body (a birthday) never reaches the audit log (routes.go
// privateBodyRoutes).
package profile

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
)

// CurrentTermsVersion names the Claudex Terms of Service in force
// (docs/legal/terms.en.md "Last updated"). Changing it asks everyone to
// accept again.
const CurrentTermsVersion = "2026-10-12"

// MinimumAge is the original's minimum age (live claude.ai bundle,
// 2026-10-12: onboarding_age_verification defaults to 18).
const MinimumAge = 18

// maxNameRunes caps display_name (the column is VARCHAR(100)).
const maxNameRunes = 100

// earliestBirthdate is the original's lower bound for the birthday field
// (live claude.ai bundle, 2026-10-12: "1900-01-01").
var earliestBirthdate = time.Date(1900, 1, 1, 0, 0, 0, 0, time.UTC)

const dateLayout = "2006-01-02"

// The original's sentences (live claude.ai bundle, 2026-10-12): the apps
// check the same things first and show these under the fields.
var (
	errSignIn      = infraerrors.Unauthorized("UNAUTHORIZED", "Sign in first.")
	errName        = infraerrors.BadRequest("CLAUDEX_PROFILE_NAME", "Enter your name to continue")
	errBirthdate   = infraerrors.BadRequest("CLAUDEX_PROFILE_BIRTHDATE", "Enter a valid date")
	errUnderage    = infraerrors.Forbidden("CLAUDEX_PROFILE_UNDERAGE", "You cannot create an account")
	errAdminDelete = infraerrors.Forbidden("CLAUDEX_ACCOUNT_ADMIN", "An administrator account can't be deleted here.")
	errTerms       = infraerrors.BadRequest("CLAUDEX_PROFILE_TERMS", "Agree to the terms to continue")
	errBody        = infraerrors.BadRequest("CLAUDEX_PROFILE_BODY", "The request must be a JSON object.")
	errUnavailable = infraerrors.ServiceUnavailable("CLAUDEX_PROFILE_UNAVAILABLE", "Your account details can't be saved right now. Try again later.")
	errUser        = infraerrors.BadRequest("CLAUDEX_PROFILE_USER", "Invalid user id.")
)

// Row is one claudex_account_profiles row.
type Row struct {
	UserID          int64
	DisplayName     string
	Birthdate       time.Time
	TermsVersion    string
	TermsAcceptedAt time.Time
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

// DTO is what the apps and the console read.
type DTO struct {
	DisplayName         string  `json:"display_name"`
	Birthdate           string  `json:"birthdate"`
	TermsVersion        string  `json:"terms_version"`
	TermsAcceptedAt     *string `json:"terms_accepted_at"`
	CurrentTermsVersion string  `json:"current_terms_version"`
	MinimumAge          int     `json:"minimum_age"`
	Complete            bool    `json:"complete"`
	UpdatedAt           *string `json:"updated_at,omitempty"`
}

type store interface {
	get(ctx context.Context, userID int64) (*Row, error)
	save(ctx context.Context, row Row) error
}

// Component is the sign-up profile component.
type Component struct {
	env   *core.Env
	store store
	// username reads the account's Sub2API username (the prefilled name);
	// setUsername fills it when it is empty, as the original fills
	// full_name from the step's name. Nil when the service has no user
	// repository (tests).
	username    func(ctx context.Context, userID int64) (string, error)
	setUsername func(ctx context.Context, userID int64, name string) error
}

// New builds the component. It must not call its dependencies here.
func New(env *core.Env) *Component {
	c := &Component{env: env}
	var db *sql.DB
	if env != nil {
		db = env.DB
		if repo := env.UserRepo; repo != nil {
			c.username = func(ctx context.Context, userID int64) (string, error) {
				u, err := repo.GetByID(ctx, userID)
				if err != nil || u == nil {
					return "", err
				}
				return u.Username, nil
			}
			c.setUsername = func(ctx context.Context, userID int64, name string) error {
				u, err := repo.GetByID(ctx, userID)
				if err != nil || u == nil || strings.TrimSpace(u.Username) != "" {
					return err
				}
				u.Username = name
				return repo.Update(ctx, u, service.UserUpdateFields{Username: true})
			}
		}
	}
	if db != nil {
		c.store = &sqlStore{db: db}
	}
	return c
}

// Name implements core.Feature.
func (c *Component) Name() string { return core.NameAccountProfile }

// RegisterUserRoutes implements core.UserRouter.
func (c *Component) RegisterUserRoutes(g *gin.RouterGroup) {
	g.GET("/account-profile", c.getProfile)
	g.PUT("/account-profile", c.putProfile)
	g.DELETE("/account", c.deleteAccount)
}

// Session-authorized deletion (live claude.ai bundle, 2026-10-14, c71860c77-nwdfnuRh).
func (c *Component) deleteAccount(g *gin.Context) {
	userID, ok := core.Subject(g)
	if !ok {
		response.ErrorFrom(g, errSignIn)
		return
	}
	if c.env == nil || c.env.Admin == nil {
		response.ErrorFrom(g, errUnavailable)
		return
	}
	// The service refuses to delete an administrator; say so instead of a
	// generic failure.
	if user, err := c.env.Admin.GetUser(g.Request.Context(), userID); err == nil && user != nil && user.IsAdmin() {
		response.ErrorFrom(g, errAdminDelete)
		return
	}
	if err := c.env.Admin.DeleteUser(g.Request.Context(), userID); err != nil {
		response.ErrorFrom(g, errUnavailable.WithCause(err))
		return
	}
	g.Header("Cache-Control", "no-store")
	response.Success(g, gin.H{})
}

// RegisterAdminRoutes implements core.AdminRouter: reading needs no step-up.
func (c *Component) RegisterAdminRoutes(g *gin.RouterGroup, _ gin.HandlerFunc) {
	g.GET("/account-profiles/:user_id", c.getAdminProfile)
}

func (c *Component) now() time.Time {
	if c.env != nil && c.env.Now != nil {
		return c.env.Now()
	}
	return time.Now()
}

// Age is the number of whole years from birth to on (both read as dates).
func Age(birth, on time.Time) int {
	years := on.Year() - birth.Year()
	if on.Month() < birth.Month() || (on.Month() == birth.Month() && on.Day() < birth.Day()) {
		years--
	}
	return years
}

// CleanName trims the name and checks it: 1–100 characters, no control
// characters. ok is false for anything else.
func CleanName(raw string) (string, bool) {
	name := strings.TrimSpace(raw)
	if name == "" || !utf8.ValidString(name) || utf8.RuneCountInString(name) > maxNameRunes {
		return "", false
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return "", false
		}
	}
	return name, true
}

// ParseBirthdate reads YYYY-MM-DD between 1900-01-01 and today.
func ParseBirthdate(raw string, today time.Time) (time.Time, bool) {
	d, err := time.Parse(dateLayout, strings.TrimSpace(raw))
	if err != nil {
		return time.Time{}, false
	}
	y, m, day := today.Date()
	end := time.Date(y, m, day, 0, 0, 0, 0, time.UTC)
	if d.Before(earliestBirthdate) || d.After(end) {
		return time.Time{}, false
	}
	return d, true
}

func dto(row *Row, fallbackName string) DTO {
	out := DTO{
		DisplayName:         strings.TrimSpace(fallbackName),
		CurrentTermsVersion: CurrentTermsVersion,
		MinimumAge:          MinimumAge,
	}
	if row == nil {
		return out
	}
	out.DisplayName = row.DisplayName
	if !row.Birthdate.IsZero() {
		out.Birthdate = row.Birthdate.Format(dateLayout)
	}
	out.TermsVersion = row.TermsVersion
	if !row.TermsAcceptedAt.IsZero() {
		at := row.TermsAcceptedAt.UTC().Format(time.RFC3339)
		out.TermsAcceptedAt = &at
	}
	if !row.UpdatedAt.IsZero() {
		at := row.UpdatedAt.UTC().Format(time.RFC3339)
		out.UpdatedAt = &at
	}
	out.Complete = row.DisplayName != "" && out.Birthdate != "" && row.TermsVersion == CurrentTermsVersion
	return out
}

func (c *Component) fallbackName(ctx context.Context, userID int64) string {
	if c.username == nil {
		return ""
	}
	name, err := c.username(ctx, userID)
	if err != nil {
		return ""
	}
	if clean, ok := CleanName(name); ok {
		return clean
	}
	return ""
}

// GET /api/v1/claudex/account-profile
func (c *Component) getProfile(g *gin.Context) {
	userID, ok := core.Subject(g)
	if !ok {
		response.ErrorFrom(g, errSignIn)
		return
	}
	g.Header("Cache-Control", "no-store")
	// CLAUDEX_PROFILE_STEP=off holds the step back (owner review of the
	// terms, 2026-10-12): every account counts as complete.
	if c.store == nil || strings.EqualFold(os.Getenv("CLAUDEX_PROFILE_STEP"), "off") {
		// Nowhere to keep the step, or it is held back: the apps go straight in.
		response.Success(g, DTO{CurrentTermsVersion: CurrentTermsVersion, MinimumAge: MinimumAge, Complete: true})
		return
	}
	ctx := g.Request.Context()
	row, err := c.store.get(ctx, userID)
	if err != nil {
		response.ErrorFrom(g, errUnavailable.WithCause(err))
		return
	}
	fallback := ""
	if row == nil {
		fallback = c.fallbackName(ctx, userID)
	}
	response.Success(g, dto(row, fallback))
}

type putBody struct {
	DisplayName        string `json:"display_name"`
	Birthdate          string `json:"birthdate"`
	AcceptTermsVersion string `json:"accept_terms_version"`
}

// validate checks a PUT against the row on record and returns the row to
// write. A birthday already on record is kept: the body's is not needed.
func validate(body putBody, existing *Row, userID int64, now time.Time) (Row, error) {
	name, ok := CleanName(body.DisplayName)
	if !ok {
		return Row{}, errName
	}
	var birth time.Time
	if existing != nil && !existing.Birthdate.IsZero() {
		birth = existing.Birthdate
	} else {
		d, ok := ParseBirthdate(body.Birthdate, now.UTC())
		if !ok {
			return Row{}, errBirthdate
		}
		if Age(d, now.UTC()) < MinimumAge {
			return Row{}, errUnderage
		}
		birth = d
	}
	if strings.TrimSpace(body.AcceptTermsVersion) != CurrentTermsVersion {
		return Row{}, errTerms
	}
	row := Row{
		UserID:          userID,
		DisplayName:     name,
		Birthdate:       birth,
		TermsVersion:    CurrentTermsVersion,
		TermsAcceptedAt: now,
		UpdatedAt:       now,
	}
	// Accepting the same version again keeps the first acceptance time.
	if existing != nil && existing.TermsVersion == CurrentTermsVersion && !existing.TermsAcceptedAt.IsZero() {
		row.TermsAcceptedAt = existing.TermsAcceptedAt
	}
	return row, nil
}

// PUT /api/v1/claudex/account-profile
func (c *Component) putProfile(g *gin.Context) {
	userID, ok := core.Subject(g)
	if !ok {
		response.ErrorFrom(g, errSignIn)
		return
	}
	if c.store == nil {
		response.ErrorFrom(g, errUnavailable)
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(g.Writer, g.Request.Body, 4096))
	var body putBody
	if err != nil || json.Unmarshal(raw, &body) != nil {
		response.ErrorFrom(g, errBody)
		return
	}
	ctx := g.Request.Context()
	existing, err := c.store.get(ctx, userID)
	if err != nil {
		response.ErrorFrom(g, errUnavailable.WithCause(err))
		return
	}
	row, err := validate(body, existing, userID, c.now())
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	if err := c.store.save(ctx, row); err != nil {
		response.ErrorFrom(g, errUnavailable.WithCause(err))
		return
	}
	if c.setUsername != nil {
		// A courtesy, like the original's full_name: the step is saved either way.
		_ = c.setUsername(ctx, userID, row.DisplayName)
	}
	saved, err := c.store.get(ctx, userID)
	if err != nil || saved == nil {
		saved = &row
	}
	response.Success(g, dto(saved, ""))
}

// GET /api/v1/admin/claudex/account-profiles/:user_id
func (c *Component) getAdminProfile(g *gin.Context) {
	userID, err := strconv.ParseInt(g.Param("user_id"), 10, 64)
	if err != nil || userID <= 0 {
		response.ErrorFrom(g, errUser)
		return
	}
	if c.store == nil {
		response.Success(g, gin.H{"profile": nil})
		return
	}
	row, err := c.store.get(g.Request.Context(), userID)
	if err != nil {
		response.ErrorFrom(g, errUnavailable.WithCause(err))
		return
	}
	if row == nil {
		response.Success(g, gin.H{"profile": nil})
		return
	}
	out := dto(row, "")
	response.Success(g, gin.H{"profile": out})
}

type sqlStore struct{ db *sql.DB }

func (s *sqlStore) get(ctx context.Context, userID int64) (*Row, error) {
	row := Row{UserID: userID}
	err := s.db.QueryRowContext(ctx, `SELECT display_name, birthdate, terms_version, terms_accepted_at, created_at, updated_at
		FROM claudex_account_profiles WHERE user_id = $1`, userID).
		Scan(&row.DisplayName, &row.Birthdate, &row.TermsVersion, &row.TermsAcceptedAt, &row.CreatedAt, &row.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (s *sqlStore) save(ctx context.Context, row Row) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO claudex_account_profiles
		(user_id, display_name, birthdate, terms_version, terms_accepted_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (user_id) DO UPDATE SET
			display_name = EXCLUDED.display_name,
			birthdate = EXCLUDED.birthdate,
			terms_version = EXCLUDED.terms_version,
			terms_accepted_at = EXCLUDED.terms_accepted_at,
			updated_at = EXCLUDED.updated_at`,
		row.UserID, row.DisplayName, row.Birthdate.Format(dateLayout), row.TermsVersion, row.TermsAcceptedAt, row.UpdatedAt)
	return err
}
