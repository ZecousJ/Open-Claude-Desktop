package memory

import (
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// testKey is a fixed 32-byte hex key (test only).
const testKey = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"

func keyConfig(configured bool) *config.Config {
	cfg := &config.Config{}
	cfg.Totp.EncryptionKey = testKey
	cfg.Totp.EncryptionKeyConfigured = configured
	return cfg
}

type memScope struct {
	doc   *docRow
	edits []editRow
}

// memStore mirrors sqlStore's semantics in memory so the handlers can be
// tested without a database; the SQL is covered by the integration tests.
type memStore struct {
	mu       sync.Mutex
	now      func() time.Time
	prefsBy  map[int64]*prefsRow
	scopes   map[int64]map[string]*memScope
	users    map[int64]bool
	nextEdit int64
	failWith error
}

func newMemStore(now func() time.Time) *memStore {
	return &memStore{now: now, prefsBy: map[int64]*prefsRow{}, scopes: map[int64]map[string]*memScope{},
		users: map[int64]bool{7: true, 8: true}}
}

func (s *memStore) scope(userID int64, scope string, create bool) *memScope {
	m := s.scopes[userID]
	if m == nil {
		if !create {
			return nil
		}
		m = map[string]*memScope{}
		s.scopes[userID] = m
	}
	sc := m[scope]
	if sc == nil && create {
		sc = &memScope{}
		m[scope] = sc
	}
	return sc
}

func (s *memStore) cleanup(userID int64) {
	for name, sc := range s.scopes[userID] {
		if sc.doc == nil && len(sc.edits) == 0 {
			delete(s.scopes[userID], name)
		}
	}
}

func (s *memStore) roomFor(userID int64, scope string, max int) error {
	if sc := s.scope(userID, scope, false); sc != nil {
		return nil
	}
	if len(s.scopes[userID]) >= max {
		return errScopeLimit
	}
	return nil
}

func (s *memStore) prefs(_ context.Context, userID int64) (*prefsRow, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failWith != nil {
		return nil, s.failWith
	}
	if p := s.prefsBy[userID]; p != nil {
		cp := *p
		return &cp, nil
	}
	return nil, nil
}

func (s *memStore) setPrefs(_ context.Context, userID int64, search, generate bool) (prefsRow, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := prefsRow{SearchChats: search, Generate: generate, UpdatedAt: s.now()}
	s.prefsBy[userID] = &p
	return p, nil
}

func (s *memStore) docs(_ context.Context, userID int64, scope string) ([]docRow, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failWith != nil {
		return nil, s.failWith
	}
	out := []docRow{}
	for name, sc := range s.scopes[userID] {
		if sc.doc != nil && (scope == "" || name == scope) {
			out = append(out, *sc.doc)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Scope < out[j].Scope })
	return out, nil
}

func (s *memStore) edits(_ context.Context, userID int64, scope string) ([]editRow, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []editRow{}
	for name, sc := range s.scopes[userID] {
		if scope == "" || name == scope {
			out = append(out, sc.edits...)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Scope != out[j].Scope {
			return out[i].Scope < out[j].Scope
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

func (s *memStore) revisions(_ context.Context, userID int64) (map[string]int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failWith != nil {
		return nil, s.failWith
	}
	out := map[string]int64{}
	for name, sc := range s.scopes[userID] {
		if sc.doc != nil {
			out[name] = sc.doc.Revision
		}
	}
	return out, nil
}

func (s *memStore) saveDoc(_ context.Context, userID int64, w docWrite) (docRow, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var current int64
	sc := s.scope(userID, w.Scope, false)
	if sc != nil && sc.doc != nil {
		current = sc.doc.Revision
	}
	if current != w.BaseRevision {
		return docRow{}, &conflictError{Current: current}
	}
	if current == 0 {
		if err := s.roomFor(userID, w.Scope, w.MaxScopes); err != nil {
			return docRow{}, err
		}
		sc = s.scope(userID, w.Scope, true)
		sc.doc = &docRow{Scope: w.Scope, CreatedAt: s.now()}
	}
	d := sc.doc
	d.ContentEnc, d.ContentBytes, d.Source, d.Revision, d.UpdatedAt = w.ContentEnc, w.ContentBytes, w.Source, current+1, s.now()
	if w.Source == SourceGenerated {
		t := s.now()
		d.GeneratedAt = &t
	}
	if w.EditsUpto != nil {
		kept := sc.edits[:0]
		for _, e := range sc.edits {
			if e.ID > *w.EditsUpto {
				kept = append(kept, e)
			}
		}
		sc.edits = kept
	}
	return *d, nil
}

func (s *memStore) deleteScope(_ context.Context, userID int64, scope string) (int64, int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sc := s.scope(userID, scope, false)
	if sc == nil {
		return 0, 0, nil
	}
	var docs int64
	if sc.doc != nil {
		docs = 1
	}
	edits := int64(len(sc.edits))
	delete(s.scopes[userID], scope)
	return docs, edits, nil
}

func (s *memStore) deleteAll(_ context.Context, userID int64) (int64, int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var docs, edits int64
	for _, sc := range s.scopes[userID] {
		if sc.doc != nil {
			docs++
		}
		edits += int64(len(sc.edits))
	}
	delete(s.scopes, userID)
	return docs, edits, nil
}

func (s *memStore) addEdit(_ context.Context, userID int64, w editWrite) (editRow, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.roomFor(userID, w.Scope, w.MaxScopes); err != nil {
		return editRow{}, err
	}
	sc := s.scope(userID, w.Scope, true)
	if len(sc.edits) >= w.MaxPerScope {
		s.cleanup(userID)
		return editRow{}, errEditLimit
	}
	s.nextEdit++
	e := editRow{ID: s.nextEdit, Scope: w.Scope, TextEnc: w.TextEnc, TextBytes: w.TextBytes, DeviceID: w.DeviceID, CreatedAt: s.now()}
	sc.edits = append(sc.edits, e)
	return e, nil
}

func (s *memStore) deleteEdit(_ context.Context, userID, id int64) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, sc := range s.scopes[userID] {
		for i, e := range sc.edits {
			if e.ID == id {
				sc.edits = append(sc.edits[:i], sc.edits[i+1:]...)
				s.cleanup(userID)
				return true, nil
			}
		}
	}
	return false, nil
}

func (s *memStore) stats(context.Context) (Stats, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var st Stats
	for _, p := range s.prefsBy {
		if p.SearchChats || p.Generate {
			st.UsersOptedIn++
		}
	}
	for _, m := range s.scopes {
		if len(m) > 0 {
			st.UsersWithMemory++
		}
		for _, sc := range m {
			if sc.doc != nil {
				st.Documents++
				st.TotalBytes += int64(sc.doc.ContentBytes)
			}
			for _, e := range sc.edits {
				st.Edits++
				st.TotalBytes += int64(e.TextBytes)
			}
		}
	}
	return st, nil
}

func (s *memStore) userExists(_ context.Context, userID int64) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.users[userID], nil
}

func (s *memStore) scopeMeta(_ context.Context, userID int64) ([]ScopeMeta, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []ScopeMeta{}
	for name, sc := range s.scopes[userID] {
		m := ScopeMeta{Scope: name, Edits: len(sc.edits)}
		for _, e := range sc.edits {
			m.EditBytes += e.TextBytes
		}
		if d := sc.doc; d != nil {
			src, updated := d.Source, d.UpdatedAt
			m.HasDocument, m.ContentBytes, m.Revision, m.Source, m.GeneratedAt, m.UpdatedAt = true, d.ContentBytes, d.Revision, &src, d.GeneratedAt, &updated
		}
		out = append(out, m)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Scope < out[j].Scope })
	return out, nil
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

// fixture is a component on in-memory storage (or a real database) behind a
// router that mimics the module's user and admin groups.
type fixture struct {
	t      *testing.T
	c      *Component
	store  *memStore
	router *gin.Engine
	userID int64
	clock  time.Time
	pol    Policy
	polErr error
	calls  int
}

type fixtureOptions struct {
	// keyMissing: the server key was generated at start-up (not configured).
	keyMissing bool
	stepUp     gin.HandlerFunc
	env        func(*core.Env)
	db         *sql.DB
}

func newFixture(t *testing.T, opts ...fixtureOptions) *fixture {
	t.Helper()
	gin.SetMode(gin.TestMode)
	var o fixtureOptions
	if len(opts) > 0 {
		o = opts[0]
	}
	f := &fixture{t: t, userID: 7, clock: testNow, pol: defaultPolicy()}
	env := &core.Env{Deps: core.Deps{DB: o.db, Config: keyConfig(!o.keyMissing)}, Now: func() time.Time { return f.clock }}
	if o.env != nil {
		o.env(env)
	}
	f.c = New(env)
	f.c.policy = func(context.Context, int64, *core.PlanRef, string) (Policy, error) {
		f.calls++
		return f.pol, f.polErr
	}
	if o.db == nil {
		f.store = newMemStore(env.Now)
		f.c.store = f.store
	}

	r := gin.New()
	auth := func(c *gin.Context) {
		c.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: f.userID})
		c.Next()
	}
	stepUp := o.stepUp
	if stepUp == nil {
		stepUp = func(c *gin.Context) { c.Next() }
	}
	f.c.RegisterUserRoutes(r.Group("/api/v1/claudex", auth, core.ValidateClientHeaders()))
	f.c.RegisterAdminRoutes(r.Group("/api/v1/admin", auth).Group("/claudex"), stepUp)
	f.router = r
	return f
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

func (f *fixture) memory() MemoryView {
	f.t.Helper()
	r := f.do(http.MethodGet, "/api/v1/claudex/memory", "")
	require.Equal(f.t, http.StatusOK, r.Status, r.Raw)
	var v MemoryView
	r.into(f.t, &v)
	return v
}

func keysOf(raw json.RawMessage, t *testing.T) []string {
	t.Helper()
	var m map[string]any
	require.NoError(t, json.Unmarshal(raw, &m))
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
