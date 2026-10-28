package feedback

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// memSettingRepo is an in-memory service.SettingRepository.
type memSettingRepo struct {
	mu     sync.Mutex
	values map[string]string
	getErr error
}

func newMemSettingRepo() *memSettingRepo { return &memSettingRepo{values: map[string]string{}} }

func (r *memSettingRepo) Get(ctx context.Context, key string) (*service.Setting, error) {
	v, err := r.GetValue(ctx, key)
	if err != nil {
		return nil, err
	}
	return &service.Setting{Key: key, Value: v}, nil
}

func (r *memSettingRepo) GetValue(_ context.Context, key string) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.getErr != nil {
		return "", r.getErr
	}
	v, ok := r.values[key]
	if !ok {
		return "", service.ErrSettingNotFound
	}
	return v, nil
}

func (r *memSettingRepo) Set(_ context.Context, key, value string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.values[key] = value
	return nil
}

func (r *memSettingRepo) GetMultiple(context.Context, []string) (map[string]string, error) {
	return nil, errors.New("not implemented")
}
func (r *memSettingRepo) SetMultiple(context.Context, map[string]string) error {
	return errors.New("not implemented")
}
func (r *memSettingRepo) GetAll(context.Context) (map[string]string, error) {
	return nil, errors.New("not implemented")
}
func (r *memSettingRepo) Delete(context.Context, string) error { return errors.New("not implemented") }

// memStore mirrors sqlStore's semantics in memory (idempotent uuids per user,
// rolling 24-hour caps, newest first) so the handlers can be tested without a
// database. The SQL itself is covered by the integration tests.
type memStore struct {
	mu          sync.Mutex
	now         func() time.Time
	diagnostics []Diagnostic
	feedback    []Feedback
	nextID      int64
	lastDiagF   diagnosticsFilter
	lastFeedF   feedbackFilter
	purges      []purgeCall
	failWith    error
}

type purgeCall struct {
	table  string
	cutoff time.Time
}

func newMemStore(now func() time.Time) *memStore { return &memStore{now: now} }

func (s *memStore) countSince(userID int64, table string) (int, time.Time) {
	since := s.now().Add(-capWindow)
	n := 0
	var oldest time.Time
	visit := func(uid int64, at time.Time) {
		if uid == userID && at.After(since) {
			n++
			if oldest.IsZero() || at.Before(oldest) {
				oldest = at
			}
		}
	}
	if table == tableDiagnostics {
		for _, d := range s.diagnostics {
			visit(d.UserID, d.CreatedAt)
		}
	} else {
		for _, f := range s.feedback {
			visit(f.UserID, f.CreatedAt)
		}
	}
	return n, oldest
}

func (s *memStore) insertDiagnostics(_ context.Context, userID int64, rows []diagnosticRow, dailyCap int) (insertResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var res insertResult
	if s.failWith != nil {
		return res, s.failWith
	}
	used, oldest := s.countSince(userID, tableDiagnostics)
	remaining := dailyCap - used
	for _, r := range rows {
		exists := false
		for _, d := range s.diagnostics {
			if d.UserID == userID && d.ReportUUID == r.ReportUUID {
				exists = true
			}
		}
		switch {
		case exists:
			res.Duplicates++
		case remaining <= 0:
			res.Dropped++
		default:
			ctx, _ := json.Marshal(r.Context)
			s.nextID++
			s.diagnostics = append(s.diagnostics, Diagnostic{
				ID: s.nextID, ReportUUID: r.ReportUUID, UserID: userID, DeviceID: r.DeviceID, Kind: r.Kind, Code: r.Code,
				Message: r.Message, RequestID: r.RequestID, Model: r.Model, AppVersion: r.AppVersion,
				CodexVersion: r.CodexVersion, Platform: r.Platform, Arch: r.Arch, OSVersion: r.OSVersion,
				Context: ctx, OccurredAt: r.OccurredAt, CreatedAt: s.now(),
			})
			res.Accepted++
			remaining--
		}
	}
	if res.Dropped > 0 {
		if oldest.IsZero() {
			oldest = s.now()
		}
		res.RetryAfter = oldest.Add(capWindow).Sub(s.now())
	}
	return res, nil
}

func (s *memStore) insertFeedback(_ context.Context, userID int64, row feedbackRow, dailyCap int) (insertResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var res insertResult
	if s.failWith != nil {
		return res, s.failWith
	}
	for _, f := range s.feedback {
		if f.UserID == userID && f.FeedbackUUID == row.FeedbackUUID {
			res.Duplicates = 1
			return res, nil
		}
	}
	used, oldest := s.countSince(userID, tableFeedback)
	if used >= dailyCap {
		res.Dropped = 1
		res.RetryAfter = oldest.Add(capWindow).Sub(s.now())
		return res, nil
	}
	s.nextID++
	s.feedback = append(s.feedback, Feedback{
		ID: s.nextID, FeedbackUUID: row.FeedbackUUID, UserID: userID, Rating: row.Rating, Categories: row.Categories,
		Comment: row.Comment, Model: row.Model, RequestID: row.RequestID, HasExcerpt: row.ConversationExcerpt != nil,
		ConversationExcerpt: row.ConversationExcerpt, AppVersion: row.AppVersion, Platform: row.Platform, CreatedAt: s.now(),
	})
	res.Accepted = 1
	return res, nil
}

func (s *memStore) listDiagnostics(_ context.Context, f diagnosticsFilter) ([]Diagnostic, int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastDiagF = f
	if s.failWith != nil {
		return nil, 0, s.failWith
	}
	out := []Diagnostic{}
	for i := len(s.diagnostics) - 1; i >= 0; i-- {
		d := s.diagnostics[i]
		if (f.UserID == 0 || d.UserID == f.UserID) && (f.Kind == "" || d.Kind == f.Kind) && (f.Code == "" || d.Code == f.Code) {
			out = append(out, d)
		}
	}
	return out, int64(len(out)), nil
}

func (s *memStore) getDiagnostic(_ context.Context, id int64) (*Diagnostic, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, d := range s.diagnostics {
		if d.ID == id {
			d := d
			return &d, nil
		}
	}
	return nil, nil
}

func (s *memStore) deleteDiagnostic(_ context.Context, id int64) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, d := range s.diagnostics {
		if d.ID == id {
			s.diagnostics = append(s.diagnostics[:i], s.diagnostics[i+1:]...)
			return true, nil
		}
	}
	return false, nil
}

func (s *memStore) listFeedback(_ context.Context, f feedbackFilter) ([]Feedback, int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastFeedF = f
	out := []Feedback{}
	for i := len(s.feedback) - 1; i >= 0; i-- {
		item := s.feedback[i]
		if (f.UserID == 0 || item.UserID == f.UserID) && (f.Rating == "" || item.Rating == f.Rating) {
			item.ConversationExcerpt = nil // lists never read the excerpt
			out = append(out, item)
		}
	}
	return out, int64(len(out)), nil
}

func (s *memStore) getFeedback(_ context.Context, id int64) (*Feedback, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, f := range s.feedback {
		if f.ID == id {
			f := f
			return &f, nil
		}
	}
	return nil, nil
}

func (s *memStore) deleteFeedback(_ context.Context, id int64) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, f := range s.feedback {
		if f.ID == id {
			s.feedback = append(s.feedback[:i], s.feedback[i+1:]...)
			return true, nil
		}
	}
	return false, nil
}

func (s *memStore) purge(_ context.Context, table string, cutoff time.Time, batch int) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.purges = append(s.purges, purgeCall{table: table, cutoff: cutoff})
	var n int64
	if table == tableDiagnostics {
		kept := s.diagnostics[:0]
		for _, d := range s.diagnostics {
			if d.CreatedAt.Before(cutoff) && n < int64(batch) {
				n++
				continue
			}
			kept = append(kept, d)
		}
		s.diagnostics = kept
	} else {
		kept := s.feedback[:0]
		for _, f := range s.feedback {
			if f.CreatedAt.Before(cutoff) && n < int64(batch) {
				n++
				continue
			}
			kept = append(kept, f)
		}
		s.feedback = kept
	}
	return n, nil
}

// fakeDevices is a core.DeviceDirectory.
type fakeDevices struct{ byRaw map[string]*core.DeviceRef }

func (f fakeDevices) LookupByAPIKey(context.Context, int64) (*core.DeviceRef, bool) {
	return nil, false
}
func (f fakeDevices) LookupByDeviceID(_ context.Context, _ int64, raw string) (*core.DeviceRef, bool) {
	d, ok := f.byRaw[raw]
	return d, ok
}

var testNow = time.Date(2026, 9, 26, 2, 30, 0, 0, time.UTC)

// fixture is a component on in-memory storage behind a router that mimics
// the module's user and admin groups.
type fixture struct {
	t      *testing.T
	c      *Component
	repo   *memSettingRepo
	store  *memStore
	router *gin.Engine
	userID int64
	clock  time.Time
}

type fixtureOptions struct {
	audit  middleware.AuditLogMiddleware
	stepUp gin.HandlerFunc
	env    func(*core.Env)
	// db runs the component on a real database (integration tests) instead
	// of the in-memory store; f.store is then nil.
	db *sql.DB
}

func newFixture(t *testing.T, opts ...fixtureOptions) *fixture {
	t.Helper()
	gin.SetMode(gin.TestMode)
	var o fixtureOptions
	if len(opts) > 0 {
		o = opts[0]
	}
	f := &fixture{t: t, repo: newMemSettingRepo(), userID: 7, clock: testNow}
	env := &core.Env{Deps: core.Deps{SettingRepo: f.repo, DB: o.db}, Now: func() time.Time { return f.clock }}
	if o.env != nil {
		o.env(env)
	}
	f.c = New(env)
	if o.db == nil {
		f.store = newMemStore(env.Now)
		f.c.store = f.store
	}

	r := gin.New()
	auth := func(c *gin.Context) {
		c.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: f.userID})
		c.Next()
	}
	audit := gin.HandlerFunc(func(c *gin.Context) { c.Next() })
	if o.audit != nil {
		audit = gin.HandlerFunc(o.audit)
	}
	stepUp := o.stepUp
	if stepUp == nil {
		stepUp = func(c *gin.Context) { c.Next() }
	}
	user := r.Group("/api/v1/claudex", auth, core.ValidateClientHeaders(), audit)
	f.c.RegisterUserRoutes(user)
	admin := r.Group("/api/v1/admin", auth, audit)
	f.c.RegisterAdminRoutes(admin.Group("/claudex"), stepUp)
	f.router = r
	return f
}

// enable stores settings through the component (like the console PUT).
func (f *fixture) enable(mutate func(*Settings)) {
	f.t.Helper()
	s := defaultSettings()
	s.Diagnostics.Enabled = true
	s.Feedback.Enabled = true
	if mutate != nil {
		mutate(&s)
	}
	_, err := f.c.setting.Set(context.Background(), s)
	require.NoError(f.t, err)
}

type result struct {
	Status int
	Header http.Header
	Code   int               `json:"code"`
	Reason string            `json:"reason"`
	Meta   map[string]string `json:"metadata"`
	Data   json.RawMessage   `json:"data"`
	Raw    string
}

func (f *fixture) do(method, path, body string, headers ...string) result {
	f.t.Helper()
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, rd)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	w := httptest.NewRecorder()
	f.router.ServeHTTP(w, req)
	res := result{Status: w.Code, Header: w.Header(), Raw: w.Body.String()}
	if w.Body.Len() > 0 {
		require.NoError(f.t, json.Unmarshal(w.Body.Bytes(), &res), w.Body.String())
	}
	return res
}

func (r result) into(t *testing.T, v any) {
	t.Helper()
	require.NoError(t, json.Unmarshal(r.Data, v), string(r.Data))
}

func sortedKeys(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
