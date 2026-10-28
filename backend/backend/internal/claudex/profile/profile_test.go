package profile

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

type memStore struct{ rows map[int64]Row }

func (m *memStore) get(_ context.Context, id int64) (*Row, error) {
	r, ok := m.rows[id]
	if !ok {
		return nil, nil
	}
	return &r, nil
}

func (m *memStore) save(_ context.Context, row Row) error {
	if old, ok := m.rows[row.UserID]; ok {
		row.CreatedAt = old.CreatedAt
	}
	m.rows[row.UserID] = row
	return nil
}

var today = time.Date(2026, 10, 12, 9, 0, 0, 0, time.UTC)

type deletingAdmin struct {
	service.AdminService
	deletedID int64
}

func (a *deletingAdmin) GetUser(_ context.Context, id int64) (*service.User, error) {
	if id == 1 {
		return &service.User{ID: 1, Role: service.RoleAdmin}, nil
	}
	return &service.User{ID: id, Role: "user"}, nil
}

func (a *deletingAdmin) DeleteUser(_ context.Context, id int64) error {
	a.deletedID = id
	return nil
}

func TestDeleteAccountUsesSessionSubject(t *testing.T) {
	f := newFixture(t)
	admin := &deletingAdmin{}
	f.c.env.Admin = admin
	r := f.do(t, http.MethodDelete, "/api/v1/claudex/account", `{"user_id":999}`)
	require.Equal(t, http.StatusOK, r.status)
	require.Equal(t, int64(7), admin.deletedID)
	f.userID = 0
	r = f.do(t, http.MethodDelete, "/api/v1/claudex/account", "")
	require.Equal(t, http.StatusUnauthorized, r.status)
	// An administrator is told why, and nothing is deleted.
	admin.deletedID = 0
	f.userID = 1
	r = f.do(t, http.MethodDelete, "/api/v1/claudex/account", "")
	require.Equal(t, http.StatusForbidden, r.status)
	require.Equal(t, int64(0), admin.deletedID)
}

type fixture struct {
	c        *Component
	store    *memStore
	engine   *gin.Engine
	userID   int64
	username string
	renamed  string
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	gin.SetMode(gin.TestMode)
	f := &fixture{store: &memStore{rows: map[int64]Row{}}, userID: 7, username: "ada"}
	f.c = &Component{
		env:   &core.Env{Now: func() time.Time { return today }},
		store: f.store,
		username: func(context.Context, int64) (string, error) {
			return f.username, nil
		},
		setUsername: func(_ context.Context, _ int64, name string) error {
			if f.username == "" {
				f.username, f.renamed = name, name
			}
			return nil
		},
	}
	f.engine = gin.New()
	user := f.engine.Group("/api/v1/claudex", func(c *gin.Context) {
		c.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: f.userID})
	})
	f.c.RegisterUserRoutes(user)
	f.c.RegisterAdminRoutes(f.engine.Group("/api/v1/admin/claudex"), nil)
	return f
}

type answer struct {
	status int
	code   int
	data   json.RawMessage
	reason string
	msg    string
}

func (f *fixture) do(t *testing.T, method, path, body string) answer {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	rec := httptest.NewRecorder()
	f.engine.ServeHTTP(rec, req)
	var env struct {
		Code    int             `json:"code"`
		Data    json.RawMessage `json:"data"`
		Reason  string          `json:"reason"`
		Message string          `json:"message"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &env), rec.Body.String())
	return answer{rec.Code, env.Code, env.Data, env.Reason, env.Message}
}

func TestAgeCountsWholeYears(t *testing.T) {
	birth := time.Date(2008, 10, 12, 0, 0, 0, 0, time.UTC)
	require.Equal(t, 18, Age(birth, today))
	require.Equal(t, 17, Age(birth.AddDate(0, 0, 1), today))
	require.Equal(t, 17, Age(time.Date(2008, 11, 1, 0, 0, 0, 0, time.UTC), today))
}

func TestParseBirthdateBounds(t *testing.T) {
	for _, bad := range []string{"", "2026-10-13", "1899-12-31", "2001-02-30", "12/01/2000", "2000-1-1"} {
		_, ok := ParseBirthdate(bad, today)
		require.False(t, ok, bad)
	}
	for _, good := range []string{"1900-01-01", "2026-10-12", " 1990-05-17 "} {
		_, ok := ParseBirthdate(good, today)
		require.True(t, ok, good)
	}
}

func TestCleanName(t *testing.T) {
	name, ok := CleanName("  Ada Lovelace ")
	require.True(t, ok)
	require.Equal(t, "Ada Lovelace", name)
	for _, bad := range []string{"", "   ", "a\x00b", strings.Repeat("名", 101)} {
		_, ok := CleanName(bad)
		require.False(t, ok, bad)
	}
	_, ok = CleanName(strings.Repeat("名", 100))
	require.True(t, ok)
}

func TestGetBeforeTheStepPrefillsTheUsername(t *testing.T) {
	f := newFixture(t)
	r := f.do(t, http.MethodGet, "/api/v1/claudex/account-profile", "")
	require.Equal(t, http.StatusOK, r.status)
	require.JSONEq(t, `{"display_name":"ada","birthdate":"","terms_version":"","terms_accepted_at":null,
		"current_terms_version":"`+CurrentTermsVersion+`","minimum_age":18,"complete":false}`, string(r.data))
}

func TestPutSavesTheStep(t *testing.T) {
	f := newFixture(t)
	f.username = ""
	r := f.do(t, http.MethodPut, "/api/v1/claudex/account-profile",
		`{"display_name":" Ada ","birthdate":"1990-05-17","accept_terms_version":"`+CurrentTermsVersion+`"}`)
	require.Equal(t, http.StatusOK, r.status, r.msg)
	var got DTO
	require.NoError(t, json.Unmarshal(r.data, &got))
	require.True(t, got.Complete)
	require.Equal(t, "Ada", got.DisplayName)
	require.Equal(t, "1990-05-17", got.Birthdate)
	require.Equal(t, CurrentTermsVersion, got.TermsVersion)
	require.NotNil(t, got.TermsAcceptedAt)
	// An empty username is filled, as the original fills full_name.
	require.Equal(t, "Ada", f.renamed)

	r = f.do(t, http.MethodGet, "/api/v1/claudex/account-profile", "")
	require.NoError(t, json.Unmarshal(r.data, &got))
	require.True(t, got.Complete)

	// The console reads it.
	r = f.do(t, http.MethodGet, "/api/v1/admin/claudex/account-profiles/7", "")
	require.Equal(t, http.StatusOK, r.status)
	require.Contains(t, string(r.data), `"birthdate":"1990-05-17"`)
	r = f.do(t, http.MethodGet, "/api/v1/admin/claudex/account-profiles/8", "")
	require.JSONEq(t, `{"profile":null}`, string(r.data))
	r = f.do(t, http.MethodGet, "/api/v1/admin/claudex/account-profiles/x", "")
	require.Equal(t, http.StatusBadRequest, r.status)
}

func TestPutRefusals(t *testing.T) {
	f := newFixture(t)
	v := CurrentTermsVersion
	cases := []struct {
		body, reason string
		status       int
	}{
		{`{"display_name":"  ","birthdate":"1990-05-17","accept_terms_version":"` + v + `"}`, "CLAUDEX_PROFILE_NAME", 400},
		{`{"display_name":"Ada","birthdate":"","accept_terms_version":"` + v + `"}`, "CLAUDEX_PROFILE_BIRTHDATE", 400},
		{`{"display_name":"Ada","birthdate":"2027-01-01","accept_terms_version":"` + v + `"}`, "CLAUDEX_PROFILE_BIRTHDATE", 400},
		{`{"display_name":"Ada","birthdate":"2008-10-13","accept_terms_version":"` + v + `"}`, "CLAUDEX_PROFILE_UNDERAGE", 403},
		{`{"display_name":"Ada","birthdate":"1990-05-17","accept_terms_version":""}`, "CLAUDEX_PROFILE_TERMS", 400},
		{`{"display_name":"Ada","birthdate":"1990-05-17","accept_terms_version":"2020-01-01"}`, "CLAUDEX_PROFILE_TERMS", 400},
		{`[]`, "CLAUDEX_PROFILE_BODY", 400},
	}
	for _, c := range cases {
		r := f.do(t, http.MethodPut, "/api/v1/claudex/account-profile", c.body)
		require.Equal(t, c.status, r.status, c.body)
		require.Equal(t, c.reason, r.reason, c.body)
	}
	require.Empty(t, f.store.rows, "nothing is written on a refusal")
}

func TestNewTermsAskAgainAndKeepTheBirthday(t *testing.T) {
	f := newFixture(t)
	accepted := today.AddDate(0, -3, 0)
	f.store.rows[7] = Row{UserID: 7, DisplayName: "Ada", Birthdate: time.Date(1990, 5, 17, 0, 0, 0, 0, time.UTC),
		TermsVersion: "2026-01-01", TermsAcceptedAt: accepted}
	r := f.do(t, http.MethodGet, "/api/v1/claudex/account-profile", "")
	var got DTO
	require.NoError(t, json.Unmarshal(r.data, &got))
	require.False(t, got.Complete)
	require.Equal(t, "1990-05-17", got.Birthdate)

	// The birthday on record stands; the body need not carry one.
	r = f.do(t, http.MethodPut, "/api/v1/claudex/account-profile",
		`{"display_name":"Ada L.","birthdate":"2015-01-01","accept_terms_version":"`+CurrentTermsVersion+`"}`)
	require.Equal(t, http.StatusOK, r.status, r.msg)
	require.NoError(t, json.Unmarshal(r.data, &got))
	require.True(t, got.Complete)
	require.Equal(t, "1990-05-17", got.Birthdate)
	require.Equal(t, today, f.store.rows[7].TermsAcceptedAt)

	// Accepting the same version again keeps the first acceptance time.
	r = f.do(t, http.MethodPut, "/api/v1/claudex/account-profile",
		`{"display_name":"Ada","accept_terms_version":"`+CurrentTermsVersion+`"}`)
	require.Equal(t, http.StatusOK, r.status, r.msg)
	require.Equal(t, today, f.store.rows[7].TermsAcceptedAt)
}

func TestWithoutADatabaseTheStepIsSkipped(t *testing.T) {
	f := newFixture(t)
	f.c.store = nil
	r := f.do(t, http.MethodGet, "/api/v1/claudex/account-profile", "")
	require.Contains(t, string(r.data), `"complete":true`)
	r = f.do(t, http.MethodPut, "/api/v1/claudex/account-profile", `{}`)
	require.Equal(t, http.StatusServiceUnavailable, r.status)
}

func TestTheStepCanBeHeldBack(t *testing.T) {
	t.Setenv("CLAUDEX_PROFILE_STEP", "off")
	f := newFixture(t)
	r := f.do(t, http.MethodGet, "/api/v1/claudex/account-profile", "")
	require.Equal(t, http.StatusOK, r.status)
	require.Contains(t, string(r.data), `"complete":true`)
}
