package memory

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
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
	mu        sync.Mutex
	now       func() time.Time
	prefsBy   map[int64]*prefsRow
	scopes    map[int64]map[string]*memScope
	users     map[int64]bool
	nextEdit  int64
	failWith  error
	versions  map[int64]map[string]int64
	resets    map[int64]map[string]int64
	melangeBy map[int64]melangeRow
}

func newMemStore(now func() time.Time) *memStore {
	return &memStore{versions: map[int64]map[string]int64{}, resets: map[int64]map[string]int64{}, now: now, prefsBy: map[int64]*prefsRow{}, scopes: map[int64]map[string]*memScope{},
		users: map[int64]bool{7: true, 8: true}, melangeBy: map[int64]melangeRow{}}
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

func (s *memStore) setPrefs(_ context.Context, userID int64, w prefsWrite) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.applyPrefs(userID, w)
	return nil
}

func (s *memStore) applyPrefs(userID int64, w prefsWrite) {
	p := prefsRow{SearchChats: w.DefaultOn, Generate: w.DefaultOn}
	if existing := s.prefsBy[userID]; existing != nil {
		p = *existing
	}
	if w.SearchChats != nil {
		p.SearchChats = *w.SearchChats
	}
	if w.Generate != nil {
		p.Generate = *w.Generate
	}
	p.UpdatedAt = s.now()
	s.prefsBy[userID] = &p
}

func (s *memStore) melange(_ context.Context, userID int64) (melangeRow, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.melangeBy[userID], s.failWith
}

func (s *memStore) saveMelange(_ context.Context, userID int64, w melangeWrite) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failWith != nil {
		return 0, s.failWith
	}
	row := s.melangeBy[userID]
	if row.Revision != w.BaseRevision {
		return 0, &conflictError{Current: row.Revision}
	}
	row.Revision++
	row.StateEnc = sql.NullString{String: w.StateEnc, Valid: true}
	s.melangeBy[userID] = row
	if w.Prefs.Generate != nil {
		s.applyPrefs(userID, w.Prefs)
	}
	return row.Revision, nil
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
	if prefs := s.prefsBy[userID]; w.RequireGenerate && prefs != nil && !prefs.Generate {
		return docRow{}, disabledFor("generate")
	}
	if w.BaseControlsVersion != nil {
		if err := s.checkControls(userID, w.Scope, *w.BaseControlsVersion); err != nil {
			return docRow{}, err
		}
	}
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
		s.bump(userID, w.Scope, false)
	}
	return *d, nil
}

func (s *memStore) deleteScope(_ context.Context, userID int64, scope string) (int64, int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.bump(userID, scope, true)
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
	s.bump(userID, "", true)
	row := s.melangeBy[userID]
	if row.StateEnc.Valid {
		docs++
	}
	s.melangeBy[userID] = melangeRow{Revision: row.Revision + 1}
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
	s.bump(userID, w.Scope, false)
	return e, nil
}

func (s *memStore) deleteEdit(_ context.Context, userID, id int64) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, sc := range s.scopes[userID] {
		for i, e := range sc.edits {
			if e.ID == id {
				sc.edits = append(sc.edits[:i], sc.edits[i+1:]...)
				s.bump(userID, e.Scope, false)
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

func (s *memStore) bump(user int64, scope string, reset bool) {
	if s.versions[user] == nil {
		s.versions[user] = map[string]int64{}
		s.resets[user] = map[string]int64{}
	}
	s.versions[user][scope]++
	if reset {
		s.resets[user][scope]++
	}
}
func (s *memStore) version(user int64, scope string) string {
	return fmt.Sprintf("v1:%d:%d:%d", s.versions[user][""], s.resets[user][scope], s.versions[user][scope])
}
func (s *memStore) checkControls(user int64, scope, base string) error {
	current := s.version(user, scope)
	if base == current {
		return nil
	}
	a, b := strings.Split(base, ":"), strings.Split(current, ":")
	return &controlsConflictError{Reset: len(a) != 4 || a[0] != "v1" || a[1] != b[1] || a[2] != b[2]}
}
func (s *memStore) snapshot(_ context.Context, user int64, scope string) (memoryRows, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failWith != nil {
		return memoryRows{}, s.failWith
	}
	out := memoryRows{Docs: []docRow{}, Edits: []editRow{}, Versions: map[string]string{}, EmptyVersion: fmt.Sprintf("v1:%d:0:0", s.versions[user][""])}
	for name := range s.versions[user] {
		if name != "" {
			out.Versions[name] = s.version(user, name)
		}
	}
	for name, sc := range s.scopes[user] {
		if scope != "" && scope != name {
			continue
		}
		if sc.doc != nil {
			out.Docs = append(out.Docs, *sc.doc)
		}
		out.Edits = append(out.Edits, sc.edits...)
	}
	sort.Slice(out.Docs, func(i, j int) bool { return out.Docs[i].Scope < out.Docs[j].Scope })
	sort.Slice(out.Edits, func(i, j int) bool {
		if out.Edits[i].Scope != out.Edits[j].Scope {
			return out.Edits[i].Scope < out.Edits[j].Scope
		}
		return out.Edits[i].ID < out.Edits[j].ID
	})
	return out, nil
}
func (s *memStore) replaceControls(_ context.Context, user int64, scope string, edits []editWrite, base string) ([]editRow, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failWith != nil {
		return nil, "", s.failWith
	}
	if err := s.checkControls(user, scope, base); err != nil {
		return nil, "", err
	}
	if len(edits) > MaxEditsPerScope {
		return nil, "", errEditLimit
	}
	if len(edits) > 0 {
		if err := s.roomFor(user, scope, MaxScopes); err != nil {
			return nil, "", err
		}
	}
	out := []editRow{}
	for _, e := range edits {
		s.nextEdit++
		out = append(out, editRow{ID: s.nextEdit, Scope: scope, TextEnc: e.TextEnc, TextBytes: e.TextBytes, DeviceID: e.DeviceID, CreatedAt: s.now()})
	}
	s.scope(user, scope, true).edits = out
	s.bump(user, scope, false)
	s.cleanup(user)
	return out, s.version(user, scope), nil
}
