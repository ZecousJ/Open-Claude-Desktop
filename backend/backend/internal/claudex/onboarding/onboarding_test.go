package onboarding

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// memStore is the store in memory, with the SQL store's rules.
type memStore struct {
	mu   sync.Mutex
	rows map[int64]*row
}

func (m *memStore) start(_ context.Context, userID int64, now time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.rows[userID] == nil {
		m.rows[userID] = &row{UserID: userID, StartedAt: now, UpdatedAt: now}
	}
	return nil
}

func (m *memStore) get(_ context.Context, userID int64) (*row, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if r := m.rows[userID]; r != nil {
		out := *r
		return &out, nil
	}
	return nil, nil
}

func (m *memStore) save(_ context.Context, userID int64, a Answers, finish bool, now time.Time) (*row, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.rows[userID]
	if r == nil {
		done := now
		r = &row{UserID: userID, StartedAt: now, FinishedAt: &done}
		m.rows[userID] = r
	}
	r.Answers = a
	r.Answers.ConnectedTools = splitTools(joinTools(a.ConnectedTools))
	if finish && r.FinishedAt == nil {
		done := now
		r.FinishedAt = &done
	}
	r.UpdatedAt = now
	out := *r
	return &out, nil
}

type fixture struct {
	t      *testing.T
	c      *Component
	store  *memStore
	r      *gin.Engine
	userID int64
}

func newFixture(t *testing.T) *fixture {
	gin.SetMode(gin.TestMode)
	f := &fixture{t: t, store: &memStore{rows: map[int64]*row{}}, userID: 7}
	now := time.Date(2026, 10, 12, 9, 0, 0, 0, time.UTC)
	f.c = &Component{env: &core.Env{Now: func() time.Time { return now }}, store: f.store}
	f.r = gin.New()
	auth := func(c *gin.Context) {
		c.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: f.userID})
		c.Next()
	}
	f.c.RegisterUserRoutes(f.r.Group("/api/v1/claudex", auth))
	f.c.RegisterAdminRoutes(f.r.Group("/api/v1/admin/claudex", auth), nil)
	return f
}

func (f *fixture) do(method, path, body string) (int, json.RawMessage, string) {
	f.t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	f.r.ServeHTTP(w, req)
	var env struct {
		Data   json.RawMessage `json:"data"`
		Reason string          `json:"reason"`
	}
	require.NoError(f.t, json.Unmarshal(w.Body.Bytes(), &env), w.Body.String())
	return w.Code, env.Data, w.Body.String()
}

func (f *fixture) mine() UserDTO {
	f.t.Helper()
	code, data, raw := f.do(http.MethodGet, "/api/v1/claudex/onboarding", "")
	require.Equal(f.t, http.StatusOK, code, raw)
	var out UserDTO
	require.NoError(f.t, json.Unmarshal(data, &out))
	return out
}

func TestOnlyNewAccountsArePending(t *testing.T) {
	f := newFixture(t)
	// An account made before onboarding has no row: never asked.
	require.False(t, f.mine().Pending)

	require.NoError(t, f.c.OnSignup(context.Background(), 7))
	require.True(t, f.mine().Pending)
	// The hook is idempotent.
	require.NoError(t, f.c.OnSignup(context.Background(), 7))
	require.True(t, f.mine().Pending)
}

func TestAnswersAreSavedAndFinishEndsIt(t *testing.T) {
	f := newFixture(t)
	require.NoError(t, f.c.OnSignup(context.Background(), 7))

	code, _, raw := f.do(http.MethodPut, "/api/v1/claudex/onboarding", `{"work_function":"SoftwareEngineer"}`)
	require.Equal(t, http.StatusOK, code, raw)
	code, _, raw = f.do(http.MethodPut, "/api/v1/claudex/onboarding",
		`{"hear_about":"social_media","hear_about_platform":"other","hear_about_other":"  a\nforum  "}`)
	require.Equal(t, http.StatusOK, code, raw)
	code, _, raw = f.do(http.MethodPut, "/api/v1/claudex/onboarding",
		`{"connected_tools":["Linear","Linear"," Notion "],"code_setup":"desktop"}`)
	require.Equal(t, http.StatusOK, code, raw)

	got := f.mine()
	require.True(t, got.Pending)
	require.Equal(t, Answers{
		WorkFunction: "SoftwareEngineer", HearAbout: "social_media", HearAboutPlatform: "other",
		HearAboutOther: "a forum", CodeSetup: "desktop", ConnectedTools: []string{"Linear", "Notion"},
		ScienceFields: []string{},
	}, got.Answers)

	code, _, raw = f.do(http.MethodPut, "/api/v1/claudex/onboarding", `{"first_task":"swe_review_pr","finished":true}`)
	require.Equal(t, http.StatusOK, code, raw)
	got = f.mine()
	require.False(t, got.Pending)
	require.Equal(t, "swe_review_pr", got.Answers.FirstTask)
	require.Equal(t, "SoftwareEngineer", got.Answers.WorkFunction, "earlier answers stay")

	// The Settings work type keeps the stored one current; it never reopens.
	code, _, raw = f.do(http.MethodPut, "/api/v1/claudex/onboarding", `{"work_function":"Design"}`)
	require.Equal(t, http.StatusOK, code, raw)
	got = f.mine()
	require.False(t, got.Pending)
	require.Equal(t, "Design", got.Answers.WorkFunction)
}

func TestAnOldAccountsWorkTypeIsNeverPending(t *testing.T) {
	f := newFixture(t)
	code, _, raw := f.do(http.MethodPut, "/api/v1/claudex/onboarding", `{"work_function":"Founder"}`)
	require.Equal(t, http.StatusOK, code, raw)
	got := f.mine()
	require.False(t, got.Pending)
	require.Equal(t, "Founder", got.Answers.WorkFunction)
}

func TestInvalidAnswersAreRefused(t *testing.T) {
	f := newFixture(t)
	require.NoError(t, f.c.OnSignup(context.Background(), 7))
	for _, body := range []string{
		`{"work_function":"engineering"}`,
		`{"hear_about":"radio"}`,
		`{"hear_about":"social_media","hear_about_platform":"myspace"}`,
		`{"code_setup":"terminal"}`,
		`{"first_task":"Drop table"}`,
		`{"science_fields":["alchemy"]}`,
		`not json`,
	} {
		code, _, raw := f.do(http.MethodPut, "/api/v1/claudex/onboarding", body)
		require.Equal(t, http.StatusBadRequest, code, body+" "+raw)
	}
	require.True(t, f.mine().Pending)
	require.Equal(t, "", f.mine().Answers.WorkFunction)
}

func TestOtherTextOnlyWithOther(t *testing.T) {
	f := newFixture(t)
	require.NoError(t, f.c.OnSignup(context.Background(), 7))
	code, _, raw := f.do(http.MethodPut, "/api/v1/claudex/onboarding",
		`{"hear_about":"podcast","hear_about_platform":"reddit","hear_about_other":"x"}`)
	require.Equal(t, http.StatusOK, code, raw)
	got := f.mine().Answers
	require.Equal(t, "podcast", got.HearAbout)
	require.Empty(t, got.HearAboutPlatform)
	require.Empty(t, got.HearAboutOther)
}

func TestAdminReadsAUsersAnswers(t *testing.T) {
	f := newFixture(t)
	code, data, raw := f.do(http.MethodGet, "/api/v1/admin/claudex/onboarding/users/9", "")
	require.Equal(t, http.StatusOK, code, raw)
	var out AdminDTO
	require.NoError(t, json.Unmarshal(data, &out))
	require.False(t, out.Found)

	require.NoError(t, f.c.OnSignup(context.Background(), 9))
	f.userID = 9
	f.do(http.MethodPut, "/api/v1/claudex/onboarding", `{"work_function":"Writer","finished":true}`)
	code, data, raw = f.do(http.MethodGet, "/api/v1/admin/claudex/onboarding/users/9", "")
	require.Equal(t, http.StatusOK, code, raw)
	require.NoError(t, json.Unmarshal(data, &out))
	require.True(t, out.Found)
	require.Equal(t, "Writer", out.Answers.WorkFunction)
	require.NotNil(t, out.FinishedAt)

	code, _, _ = f.do(http.MethodGet, "/api/v1/admin/claudex/onboarding/users/abc", "")
	require.Equal(t, http.StatusBadRequest, code)
}

func TestWithoutADatabase(t *testing.T) {
	c := New(&core.Env{})
	require.NoError(t, c.OnSignup(context.Background(), 1))
	f := newFixture(t)
	f.c = c
	f.r = gin.New()
	auth := func(g *gin.Context) {
		g.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: 1})
		g.Next()
	}
	c.RegisterUserRoutes(f.r.Group("/api/v1/claudex", auth))
	require.False(t, f.mine().Pending)
	code, _, _ := f.do(http.MethodPut, "/api/v1/claudex/onboarding", `{"work_function":"Writer"}`)
	require.Equal(t, http.StatusServiceUnavailable, code)
}

func TestScienceFieldsAreSaved(t *testing.T) {
	f := newFixture(t)
	require.NoError(t, f.c.OnSignup(context.Background(), 7))
	code, _, raw := f.do(http.MethodPut, "/api/v1/claudex/onboarding",
		`{"work_function":"Scientist","science_fields":["physics","biology","physics"]}`)
	require.Equal(t, http.StatusOK, code, raw)
	require.Equal(t, []string{"physics", "biology"}, f.mine().Answers.ScienceFields)
	code, _, raw = f.do(http.MethodPut, "/api/v1/claudex/onboarding", `{"science_fields":[]}`)
	require.Equal(t, http.StatusOK, code, raw)
	require.Equal(t, []string{}, f.mine().Answers.ScienceFields)
}
