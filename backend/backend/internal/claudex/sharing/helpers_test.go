package sharing

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

// fakeUsers is the part of service.UserRepository the component uses.
type fakeUsers struct {
	service.UserRepository
	emails map[int64]string
}

func (f fakeUsers) GetByEmail(_ context.Context, email string) (*service.User, error) {
	for id, e := range f.emails {
		if e == email {
			return &service.User{ID: id, Email: e}, nil
		}
	}
	return nil, service.ErrUserNotFound
}

func (f fakeUsers) GetByIDIncludeDeleted(_ context.Context, id int64) (*service.User, error) {
	if e, ok := f.emails[id]; ok {
		return &service.User{ID: id, Email: e}, nil
	}
	return nil, service.ErrUserNotFound
}

// memStore mirrors sqlStore's semantics in memory so the handlers can be
// tested without a database; the SQL is covered by the integration tests.
type memStore struct {
	editRequests map[int64]map[string]EditAccessRequest
	mu           sync.Mutex
	shares       []*shareRow
	contents     map[int64][]byte
	reports      []*Report
	// reportIPs: report id -> visitor hash (ip_hash)
	reportIPs map[int64]string
	blocks    map[int64]*Block
	// users: id -> deleted
	users    map[int64]bool
	nextID   int64
	failWith error
	// inviteList: share id -> invited addresses in order
	inviteList map[int64][]string
	roles      map[int64]map[string]string
	// userEmails: owner id -> address (sharedWith)
	userEmails map[int64]string
	// embedLists: share id -> allowed embed domains
	embedLists map[int64][]string
}

func newMemStore() *memStore {
	return &memStore{contents: map[int64][]byte{}, blocks: map[int64]*Block{}, reportIPs: map[int64]string{},
		inviteList: map[int64][]string{}, userEmails: map[int64]string{7: "u7@example.com", 8: "u8@example.com"},
		users: map[int64]bool{1: false, 7: false, 8: false, 9: false}, embedLists: map[int64][]string{}}
}

func (s *memStore) find(id int64) *shareRow {
	for _, r := range s.shares {
		if r.ID == id {
			return r
		}
	}
	return nil
}

func copyRow(r *shareRow) *shareRow {
	c := *r
	return &c
}

func (s *memStore) upsert(_ context.Context, in upsertInput) (*shareRow, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failWith != nil {
		return nil, false, s.failWith
	}
	for _, r := range s.shares {
		if r.UserID == in.UserID && r.Kind == in.Kind && r.SourceKey == in.SourceKey && r.Status != StatusRevoked {
			if r.expired(in.Now) {
				s.revokeLocked(r, in.Now)
				break
			}
			if r.Status == StatusDisabled {
				return nil, false, ErrShareDisabled
			}
			r.Title, r.ContentBytes, r.SnapshotAt, r.UpdatedAt = in.Title, int64(len(in.Body)), in.Now, in.Now
			s.contents[r.ID] = append([]byte(nil), in.Body...)
			return copyRow(r), false, nil
		}
	}
	live := 0
	for _, r := range s.shares {
		if r.UserID == in.UserID && r.Status != StatusRevoked && !r.expired(in.Now) {
			live++
		}
	}
	if live >= in.MaxActive {
		return nil, false, ErrQuota
	}
	token, err := in.NewToken()
	if err != nil {
		return nil, false, err
	}
	s.nextID++
	r := &shareRow{ID: s.nextID, Token: token, UserID: in.UserID, Kind: in.Kind, SourceKey: in.SourceKey, Title: in.Title,
		Status: StatusActive, ContentBytes: int64(len(in.Body)), CreatedAt: in.Now, SnapshotAt: in.Now, UpdatedAt: in.Now,
		ExpiresAt: in.ExpiresAt, InvitedOnly: in.InvitedOnly}
	s.shares = append(s.shares, r)
	s.contents[r.ID] = append([]byte(nil), in.Body...)
	return copyRow(r), true, nil
}

func (s *memStore) revokeLocked(r *shareRow, now time.Time) {
	r.Status = StatusRevoked
	t := now
	r.RevokedAt = &t
	r.UpdatedAt = now
	delete(s.contents, r.ID)
}

func (s *memStore) updateSnapshot(_ context.Context, userID, id int64, title string, body []byte, now time.Time) (*shareRow, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.find(id)
	if r == nil || r.UserID != userID || r.Status == StatusRevoked || r.expired(now) {
		return nil, ErrShareNotFound
	}
	if r.Status == StatusDisabled {
		return nil, ErrShareDisabled
	}
	r.Title, r.ContentBytes, r.SnapshotAt, r.UpdatedAt = title, int64(len(body)), now, now
	s.contents[id] = append([]byte(nil), body...)
	return copyRow(r), nil
}

func (s *memStore) editArtifact(_ context.Context, userID int64, email string, id int64, permission string, edit func(*Snapshot) error, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.find(id)
	if r == nil || r.Kind != KindArtifact || r.Status != StatusActive || r.expired(now) {
		return ErrShareNotFound
	}
	allowed := r.UserID == userID
	for _, invited := range s.inviteList[id] {
		allowed = allowed || (invited == email && artifactRoleAllows(s.roleOf(id, email), permission))
	}
	if !allowed {
		return ErrShareNotFound
	}
	var snapshot Snapshot
	if err := json.Unmarshal(s.contents[id], &snapshot); err != nil {
		return err
	}
	if err := edit(&snapshot); err != nil {
		return err
	}
	body, err := json.Marshal(snapshot)
	if err != nil {
		return err
	}
	s.contents[id] = body
	r.ContentBytes, r.SnapshotAt, r.UpdatedAt = int64(len(body)), now, now
	return nil
}

func (s *memStore) getLive(_ context.Context, userID, id int64) (*shareRow, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failWith != nil {
		return nil, s.failWith
	}
	r := s.find(id)
	if r == nil || r.Status == StatusRevoked || (userID > 0 && r.UserID != userID) {
		return nil, nil
	}
	return copyRow(r), nil
}

func page[T any](items []T, page, size int) []T {
	from := (page - 1) * size
	if from >= len(items) {
		return []T{}
	}
	to := from + size
	if to > len(items) {
		to = len(items)
	}
	return items[from:to]
}

func (s *memStore) sorted(keep func(*shareRow) bool) []shareRow {
	var out []shareRow
	for _, r := range s.shares {
		if keep(r) {
			out = append(out, *r)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if !out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].CreatedAt.After(out[j].CreatedAt)
		}
		return out[i].ID > out[j].ID
	})
	return out
}

func (s *memStore) listUser(_ context.Context, userID int64, kind Kind, sourceKey string, now time.Time, p, size int) ([]shareRow, int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failWith != nil {
		return nil, 0, s.failWith
	}
	all := s.sorted(func(r *shareRow) bool {
		return r.UserID == userID && r.Status != StatusRevoked && !r.expired(now) &&
			(kind == "" || r.Kind == kind) && (sourceKey == "" || r.SourceKey == sourceKey)
	})
	return page(all, p, size), int64(len(all)), nil
}

func (s *memStore) revoke(_ context.Context, userID, id int64, now time.Time) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.find(id)
	if r == nil || r.Status == StatusRevoked || (userID > 0 && r.UserID != userID) {
		return false, nil
	}
	s.revokeLocked(r, now)
	return true, nil
}

func (s *memStore) byToken(_ context.Context, token string) (*shareRow, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failWith != nil {
		return nil, s.failWith
	}
	for _, r := range s.shares {
		if r.Token == token {
			c := copyRow(r)
			deleted, known := s.users[r.UserID]
			c.AuthorGone = !known || deleted
			return c, nil
		}
	}
	return nil, nil
}

func (s *memStore) content(_ context.Context, id int64) (*Snapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	body, ok := s.contents[id]
	if !ok {
		return nil, nil
	}
	var snap Snapshot
	if err := json.Unmarshal(body, &snap); err != nil {
		return nil, err
	}
	return &snap, nil
}

func (s *memStore) countView(_ context.Context, id int64, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r := s.find(id); r != nil {
		r.ViewCount++
		t := now
		r.LastViewedAt = &t
	}
	return nil
}

func (s *memStore) openReports(id int64) int64 {
	var n int64
	for _, rep := range s.reports {
		if rep.ShareID == id && rep.Status == reportOpen {
			n++
		}
	}
	return n
}

func (s *memStore) adminList(_ context.Context, f adminFilter) ([]shareRow, int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	all := s.sorted(func(r *shareRow) bool {
		if f.Status != "" && r.Status != f.Status {
			return false
		}
		if f.Status == "" && r.Status == StatusRevoked {
			return false
		}
		return (f.Kind == "" || r.Kind == f.Kind) && (f.UserID == 0 || r.UserID == f.UserID) &&
			(f.Query == "" || strings.Contains(strings.ToLower(r.Title), strings.ToLower(f.Query)))
	})
	for i := range all {
		all[i].OpenReports = s.openReports(all[i].ID)
	}
	return page(all, f.Page, f.Size), int64(len(all)), nil
}

func (s *memStore) setDisabled(_ context.Context, id int64, disabled bool, reason string, by int64, now time.Time) (*shareRow, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.find(id)
	if r == nil || r.Status == StatusRevoked {
		return nil, nil
	}
	if disabled {
		b, t := by, now
		r.Status, r.DisabledReason, r.DisabledBy, r.DisabledAt = StatusDisabled, reason, &b, &t
	} else {
		r.Status, r.DisabledReason, r.DisabledBy, r.DisabledAt = StatusActive, "", nil, nil
	}
	r.UpdatedAt = now
	return copyRow(r), nil
}

func (s *memStore) disableAllOf(_ context.Context, userID int64, reason string, by int64, now time.Time) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var n int64
	for _, r := range s.shares {
		if r.UserID == userID && r.Status == StatusActive {
			b, t := by, now
			r.Status, r.DisabledReason, r.DisabledBy, r.DisabledAt, r.UpdatedAt = StatusDisabled, reason, &b, &t, now
			n++
		}
	}
	return n, nil
}

func (s *memStore) insertReport(_ context.Context, shareID int64, in reportInput, ipHash string, now time.Time) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if ipHash != "" {
		for _, rep := range s.reports {
			if rep.ShareID == shareID && s.reportIPs[rep.ID] == ipHash {
				return false, nil
			}
		}
	}
	r := s.find(shareID)
	s.nextID++
	rep := &Report{ID: s.nextID, ShareID: shareID, ShareTitle: r.Title, ShareKind: r.Kind, ShareStatus: r.Status,
		ShareUserID: r.UserID, Reason: in.Reason, Detail: in.Detail, Status: reportOpen, CreatedAt: now,
		Category: in.Category, ReporterName: in.ReporterName, ReporterEmail: in.ReporterEmail,
		ReporterUserID: in.ReporterUserID, OptOutOfTraining: in.OptOutOfTraining}
	s.reports = append(s.reports, rep)
	s.reportIPs[rep.ID] = ipHash
	return true, nil
}

func (s *memStore) reportOut(rep *Report) Report {
	out := *rep
	if r := s.find(rep.ShareID); r != nil {
		out.shareToken, out.ShareStatus, out.ShareTitle = r.Token, r.Status, r.Title
	}
	return out
}

func (s *memStore) listReports(_ context.Context, f reportFilter) ([]Report, int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var all []Report
	for i := len(s.reports) - 1; i >= 0; i-- {
		rep := s.reports[i]
		if (f.Status == "" || rep.Status == f.Status) && (f.ShareID == 0 || rep.ShareID == f.ShareID) {
			all = append(all, s.reportOut(rep))
		}
	}
	return page(all, f.Page, f.Size), int64(len(all)), nil
}

func (s *memStore) resolveReport(_ context.Context, id int64, status string, alsoShare bool, by int64, now time.Time) (*Report, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var target *Report
	for _, rep := range s.reports {
		if rep.ID == id {
			target = rep
		}
	}
	if target == nil {
		return nil, nil
	}
	set := func(rep *Report) {
		b, t := by, now
		rep.Status, rep.ResolvedBy, rep.ResolvedAt = status, &b, &t
	}
	set(target)
	if alsoShare {
		for _, rep := range s.reports {
			if rep.ShareID == target.ShareID && rep.Status == reportOpen {
				set(rep)
			}
		}
	}
	out := s.reportOut(target)
	return &out, nil
}

func (s *memStore) isBlocked(_ context.Context, userID int64) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failWith != nil {
		return false, s.failWith
	}
	_, ok := s.blocks[userID]
	return ok, nil
}

func (s *memStore) listBlocks(_ context.Context, p, size int) ([]Block, int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var all []Block
	for _, b := range s.blocks {
		all = append(all, *b)
	}
	sort.Slice(all, func(i, j int) bool { return all[i].UserID > all[j].UserID })
	return page(all, p, size), int64(len(all)), nil
}

func (s *memStore) putBlock(_ context.Context, userID int64, reason string, by int64, now time.Time) (*Block, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if deleted, ok := s.users[userID]; !ok || deleted {
		return nil, false, nil
	}
	b, exists := s.blocks[userID]
	if !exists {
		admin := by
		b = &Block{UserID: userID, CreatedBy: &admin, CreatedAt: now}
		s.blocks[userID] = b
	}
	b.Reason = reason
	out := *b
	return &out, true, nil
}

func (s *memStore) deleteBlock(_ context.Context, userID int64) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.blocks[userID]
	delete(s.blocks, userID)
	return ok, nil
}

func (s *memStore) purge(now time.Time, batch int, match func(*shareRow) bool) int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	var n int64
	for _, r := range s.shares {
		if int(n) >= batch {
			break
		}
		if r.Status != StatusRevoked && match(r) {
			s.revokeLocked(r, now)
			n++
		}
	}
	return n
}

func (s *memStore) purgeExpired(_ context.Context, now time.Time, batch int) (int64, error) {
	return s.purge(now, batch, func(r *shareRow) bool { return r.expired(now) }), nil
}

func (s *memStore) purgeDeletedAuthors(_ context.Context, now time.Time, batch int) (int64, error) {
	return s.purge(now, batch, func(r *shareRow) bool {
		deleted, known := s.users[r.UserID]
		return !known || deleted
	}), nil
}

func (s *memStore) setInvitedOnly(_ context.Context, userID, id int64, on bool, now time.Time) (*shareRow, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.find(id)
	if r == nil || r.UserID != userID || r.Status == StatusRevoked {
		return nil, nil
	}
	r.InvitedOnly, r.UpdatedAt = on, now
	return copyRow(r), nil
}

func (s *memStore) addInvite(_ context.Context, id int64, email string, _ time.Time, roles ...string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(roles) > 0 && roles[0] != "" {
		if s.roles == nil {
			s.roles = map[int64]map[string]string{}
		}
		if s.roles[id] == nil {
			s.roles[id] = map[string]string{}
		}
		s.roles[id][email] = roles[0]
	}
	for _, e := range s.inviteList[id] {
		if e == email {
			return false, nil
		}
	}
	s.inviteList[id] = append(s.inviteList[id], email)
	return true, nil
}

func (s *memStore) roleOf(id int64, email string) string {
	if role := s.roles[id][email]; role != "" {
		return role
	}
	return "edit"
}

func (s *memStore) inviteRoles(_ context.Context, id int64) (map[string]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	roles := map[string]string{}
	for _, email := range s.inviteList[id] {
		roles[email] = s.roleOf(id, email)
	}
	return roles, nil
}

func (s *memStore) removeInvite(_ context.Context, id int64, email string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	list := s.inviteList[id]
	for i, e := range list {
		if e == email {
			s.inviteList[id] = append(append([]string{}, list[:i]...), list[i+1:]...)
			return true, nil
		}
	}
	return false, nil
}

func (s *memStore) invites(_ context.Context, id int64) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string{}, s.inviteList[id]...), nil
}

func (s *memStore) invited(_ context.Context, id int64, email string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, e := range s.inviteList[id] {
		if e == email {
			return true, nil
		}
	}
	return false, nil
}

func (s *memStore) sharedWith(_ context.Context, email string, now time.Time) ([]sharedRow, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []sharedRow
	for _, r := range s.shares {
		if r.Status != StatusActive || r.expired(now) {
			continue
		}
		for _, e := range s.inviteList[r.ID] {
			if e == email {
				out = append(out, sharedRow{shareRow: *r, OwnerEmail: s.userEmails[r.UserID]})
			}
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].SnapshotAt.After(out[j].SnapshotAt) })
	return out, nil
}

var testNow = time.Date(2026, 9, 26, 2, 30, 0, 0, time.UTC)

// fixture is a component behind a router that mimics the module's page,
// public, user and admin groups.
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
	stepUp gin.HandlerFunc
	env    func(*core.Env)
	// db runs the component on a real database (integration tests).
	db *sql.DB
	// noDB leaves the component without storage.
	noDB bool
}

func newFixture(t *testing.T, opts ...fixtureOptions) *fixture {
	t.Helper()
	gin.SetMode(gin.TestMode)
	var o fixtureOptions
	if len(opts) > 0 {
		o = opts[0]
	}
	f := &fixture{t: t, repo: newMemSettingRepo(), userID: 7, clock: testNow}
	env := &core.Env{
		Deps: core.Deps{SettingRepo: f.repo, DB: o.db, UserRepo: fakeUsers{emails: map[int64]string{7: "u7@example.com", 8: "u8@example.com"}}},
		Now:  func() time.Time { return f.clock },
	}
	if o.env != nil {
		o.env(env)
	}
	f.c = New(env)
	if o.db == nil && !o.noDB {
		f.store = newMemStore()
		f.c.store = f.store
		f.c.embeds = f.store
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
	f.c.RegisterPageRoutes(r.Group("/s"))
	f.c.RegisterPublicRoutes(r.Group("/api/v1/claudex"))
	f.c.RegisterUserRoutes(r.Group("/api/v1/claudex", auth, core.ValidateClientHeaders()))
	f.c.RegisterAdminRoutes(r.Group("/api/v1/admin", auth).Group("/claudex"), stepUp)
	f.router = r
	return f
}

// enable stores settings through the component (like the console PUT).
func (f *fixture) enable(mutate func(*Settings)) {
	f.t.Helper()
	s := defaultSettings()
	s.Enabled = true
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

func (f *fixture) serve(method, path, body string, headers ...string) *httptest.ResponseRecorder {
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
		if strings.EqualFold(headers[i], "Host") {
			req.Host = headers[i+1]
			continue
		}
		req.Header.Set(headers[i], headers[i+1])
	}
	w := httptest.NewRecorder()
	f.router.ServeHTTP(w, req)
	return w
}

// do calls a JSON route.
func (f *fixture) do(method, path, body string, headers ...string) result {
	f.t.Helper()
	w := f.serve(method, path, body, headers...)
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

type paged[T any] struct {
	Items []T   `json:"items"`
	Total int64 `json:"total"`
}

// conversationBody is a valid POST /shares body.
func conversationBody(sourceKey, title string) string {
	return `{"kind":"conversation","source_key":"` + sourceKey + `","title":"` + title + `","snapshot":{"mode":"chat",` +
		`"messages":[{"role":"user","text":"Make a page"},{"role":"assistant","text":"Here it is","activity":["Ran a command"],"artifacts":[0]}],` +
		`"artifacts":[{"title":"Page","language":"html","content":"<p>hi</p><script>parent.x=1</script>"}]}}`
}

func artifactBody(sourceKey string) string {
	return `{"kind":"artifact","source_key":"` + sourceKey + `","title":"Chart","snapshot":{"artifacts":[{"title":"Chart","language":"svg","content":"<svg xmlns='http://www.w3.org/2000/svg'></svg>"}]}}`
}

// create shares a conversation and returns the DTO.
func (f *fixture) create(sourceKey string) ShareDTO {
	f.t.Helper()
	res := f.do(http.MethodPost, "/api/v1/claudex/shares", conversationBody(sourceKey, "My chat"))
	require.Contains(f.t, []int{http.StatusOK, http.StatusCreated}, res.Status, res.Raw)
	var dto ShareDTO
	res.into(f.t, &dto)
	return dto
}
