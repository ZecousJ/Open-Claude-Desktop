package announce

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sort"
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
	mu    sync.Mutex
	next  int64
	rows  map[int64]*row
	reads map[int64]map[int64]string
	mails []mailRow
}

func newMemStore() *memStore {
	return &memStore{rows: map[int64]*row{}, reads: map[int64]map[int64]string{}}
}

func (m *memStore) copyOf(r *row) *row {
	out := *r
	out.Reads = int64(len(m.reads[r.ID]))
	return &out
}

func (m *memStore) create(_ context.Context, in Content, by int64, now time.Time) (*row, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.next++
	r := &row{ID: m.next, Title: in.Title, Badge: in.Badge, BodyHTML: in.BodyHTML, BodyFormat: in.BodyFormat, ImageURL: in.ImageURL,
		PrimaryLabel: in.PrimaryLabel, PrimaryURL: in.PrimaryURL, DismissLabel: in.DismissLabel,
		Status: StatusDraft, CreatedBy: by, CreatedAt: now, UpdatedAt: now}
	m.rows[r.ID] = r
	return m.copyOf(r), nil
}

func (m *memStore) update(_ context.Context, id int64, in Content, reset bool, now time.Time) (*row, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.rows[id]
	if r == nil {
		return nil, nil
	}
	r.Title, r.Badge, r.BodyHTML, r.BodyFormat, r.ImageURL = in.Title, in.Badge, in.BodyHTML, in.BodyFormat, in.ImageURL
	r.PrimaryLabel, r.PrimaryURL, r.DismissLabel, r.UpdatedAt = in.PrimaryLabel, in.PrimaryURL, in.DismissLabel, now
	if reset {
		delete(m.reads, id)
	}
	return m.copyOf(r), nil
}

func (m *memStore) get(_ context.Context, id int64) (*row, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if r := m.rows[id]; r != nil {
		return m.copyOf(r), nil
	}
	return nil, nil
}

func (m *memStore) list(context.Context) ([]row, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []row
	for _, r := range m.rows {
		out = append(out, *m.copyOf(r))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID > out[j].ID })
	return out, nil
}

func (m *memStore) publish(_ context.Context, id int64, now, until time.Time) (*row, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.rows[id]
	if r == nil {
		return nil, nil
	}
	r.Status, r.PublishedAt, r.ExpiresAt, r.UpdatedAt = StatusPublished, &now, &until, now
	return m.copyOf(r), nil
}

func (m *memStore) withdraw(_ context.Context, id int64, now time.Time) (*row, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.rows[id]
	if r == nil {
		return nil, nil
	}
	r.Status, r.UpdatedAt = StatusWithdrawn, now
	return m.copyOf(r), nil
}

func (m *memStore) remove(_ context.Context, id int64) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.rows[id]
	delete(m.rows, id)
	delete(m.reads, id)
	return ok, nil
}

func (m *memStore) live(r *row, now time.Time) bool {
	return r.Status == StatusPublished && r.PublishedAt != nil && !r.PublishedAt.After(now) &&
		r.ExpiresAt != nil && r.ExpiresAt.After(now)
}

func (m *memStore) pending(_ context.Context, userID int64, now time.Time) ([]row, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []row
	for _, r := range m.rows {
		if _, read := m.reads[r.ID][userID]; m.live(r, now) && !read {
			out = append(out, *r)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func (m *memStore) markRead(_ context.Context, id, userID int64, action string, now time.Time) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.rows[id]
	if r == nil || r.Status != StatusPublished || r.ExpiresAt == nil || !r.ExpiresAt.After(now) {
		return false, nil
	}
	if m.reads[id] == nil {
		m.reads[id] = map[int64]string{}
	}
	if _, done := m.reads[id][userID]; !done {
		m.reads[id][userID] = action
	}
	return true, nil
}

func (m *memStore) createMail(_ context.Context, subject, body string, n int, _ int64, now time.Time) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	id := int64(len(m.mails) + 1)
	m.mails = append(m.mails, mailRow{ID: id, Subject: subject, BodyHTML: body, Recipients: n, Status: "sending", CreatedAt: now})
	return id, nil
}

func (m *memStore) mailProgress(_ context.Context, id int64, sent, failed int, done bool, now time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	mail := &m.mails[id-1]
	mail.Sent, mail.Failed = sent, failed
	if done {
		mail.Status, mail.FinishedAt = "done", &now
	}
	return nil
}

func (m *memStore) listMails(context.Context, int) ([]mailRow, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := append([]mailRow{}, m.mails...)
	sort.Slice(out, func(i, j int) bool { return out[i].ID > out[j].ID })
	return out, nil
}

type fixture struct {
	t      *testing.T
	c      *Component
	store  *memStore
	r      *gin.Engine
	userID int64
	now    time.Time
	sent   chan string
}

func newFixture(t *testing.T) *fixture {
	gin.SetMode(gin.TestMode)
	f := &fixture{t: t, store: newMemStore(), userID: 1, now: time.Date(2026, 9, 30, 8, 0, 0, 0, time.UTC),
		sent: make(chan string, 100)}
	f.c = New(&core.Env{Now: func() time.Time { return f.now }})
	f.c.store = f.store
	f.c.pause = 0
	f.c.mailer = func(_ context.Context, to, subject, _ string) error {
		f.sent <- to + " " + subject
		return nil
	}
	f.c.emails = func(_ context.Context, ids []int64) map[int64]string {
		out := map[int64]string{}
		for _, id := range ids {
			if id < 100 {
				out[id] = "User" + itoa(id) + "@Example.com"
			}
		}
		return out
	}
	f.r = gin.New()
	auth := func(c *gin.Context) {
		c.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: f.userID})
		c.Next()
	}
	f.c.RegisterUserRoutes(f.r.Group("/api/v1/claudex", auth))
	f.c.RegisterAdminRoutes(f.r.Group("/api/v1/admin/claudex", auth), func(c *gin.Context) { c.Next() })
	return f
}

func itoa(n int64) string {
	return strings.TrimSpace(strings.Replace(string(rune('0'+n%10)), "", "", 0))
}

type result struct {
	Status int
	Code   int             `json:"code"`
	Data   json.RawMessage `json:"data"`
	Reason string          `json:"reason"`
	Raw    string
}

func (f *fixture) do(method, path, body string) result {
	f.t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	f.r.ServeHTTP(w, req)
	res := result{Status: w.Code, Raw: w.Body.String()}
	if w.Body.Len() > 0 {
		require.NoError(f.t, json.Unmarshal(w.Body.Bytes(), &res), w.Body.String())
	}
	return res
}

func (r result) into(t *testing.T, v any) {
	t.Helper()
	require.NoError(t, json.Unmarshal(r.Data, v), string(r.Data))
}

func (f *fixture) pending() []UserDTO {
	f.t.Helper()
	res := f.do(http.MethodGet, "/api/v1/claudex/announcements/pending", "")
	require.Equal(f.t, http.StatusOK, res.Status, res.Raw)
	var out struct {
		Items []UserDTO `json:"items"`
	}
	res.into(f.t, &out)
	return out.Items
}

func (f *fixture) create(body string) AdminDTO {
	f.t.Helper()
	res := f.do(http.MethodPost, "/api/v1/admin/claudex/announcements", body)
	require.Equal(f.t, http.StatusCreated, res.Status, res.Raw)
	var dto AdminDTO
	res.into(f.t, &dto)
	return dto
}

const sample = `{"title":"Get to finished work sooner","badge":"New","body_html":"<p>Hi</p>",
	"primary_label":"Try it","primary_url":"https://example.com/try","dismiss_label":"Not now"}`

func TestAnnouncementShowsOnceUntilItExpires(t *testing.T) {
	f := newFixture(t)
	a := f.create(sample)
	require.Equal(t, StatusDraft, a.Status)
	require.Empty(t, f.pending(), "a draft is shown to nobody")

	res := f.do(http.MethodPost, "/api/v1/admin/claudex/announcements/1/publish", `{"duration_hours":168}`)
	require.Equal(t, http.StatusOK, res.Status, res.Raw)
	res.into(t, &a)
	require.Equal(t, StatusPublished, a.Status)
	require.Equal(t, f.now.Add(168*time.Hour), *a.ExpiresAt)

	got := f.pending()
	require.Len(t, got, 1)
	require.Equal(t, "New", got[0].Badge)
	require.Equal(t, "<p>Hi</p>", got[0].BodyHTML)

	// Closing it (any button) is final for this person only.
	res = f.do(http.MethodPost, "/api/v1/claudex/announcements/1/read", `{"action":"dismiss"}`)
	require.Equal(t, http.StatusOK, res.Status, res.Raw)
	require.Empty(t, f.pending())
	f.userID = 2
	require.Len(t, f.pending(), 1)

	// A week later it is gone for everyone, read or not.
	f.now = f.now.Add(168 * time.Hour)
	require.Empty(t, f.pending())
	res = f.do(http.MethodGet, "/api/v1/admin/claudex/announcements/1", "")
	res.into(t, &a)
	require.Equal(t, StatusExpired, a.Status)
	require.EqualValues(t, 1, a.Reads)
	// Closing an expired one records nothing.
	res = f.do(http.MethodPost, "/api/v1/claudex/announcements/1/read", `{}`)
	var rec struct {
		Recorded bool `json:"recorded"`
	}
	res.into(t, &rec)
	require.False(t, rec.Recorded)
}

func TestWithdrawEditAndPublishAgain(t *testing.T) {
	f := newFixture(t)
	f.create(sample)
	f.do(http.MethodPost, "/api/v1/admin/claudex/announcements/1/publish", `{"duration_hours":24}`)
	f.do(http.MethodPost, "/api/v1/claudex/announcements/1/read", `{"action":"primary"}`)

	// Withdrawn: nobody sees it.
	res := f.do(http.MethodPost, "/api/v1/admin/claudex/announcements/1/withdraw", "")
	require.Equal(t, http.StatusOK, res.Status, res.Raw)
	f.userID = 2
	require.Empty(t, f.pending())

	// Edited while withdrawn, then published again: people who closed it
	// stay done unless the edit shows it again to everyone.
	res = f.do(http.MethodPut, "/api/v1/admin/claudex/announcements/1",
		`{"title":"Updated","body_html":"<p>New text</p>"}`)
	require.Equal(t, http.StatusOK, res.Status, res.Raw)
	f.do(http.MethodPost, "/api/v1/admin/claudex/announcements/1/publish", `{"duration_hours":24}`)
	require.Len(t, f.pending(), 1)
	require.Equal(t, "Updated", f.pending()[0].Title)
	f.userID = 1
	require.Empty(t, f.pending())

	res = f.do(http.MethodPut, "/api/v1/admin/claudex/announcements/1",
		`{"title":"Updated again","reset_reads":true}`)
	require.Equal(t, http.StatusOK, res.Status, res.Raw)
	require.Len(t, f.pending(), 1)

	res = f.do(http.MethodDelete, "/api/v1/admin/claudex/announcements/1", "")
	require.Equal(t, http.StatusOK, res.Status, res.Raw)
	require.Empty(t, f.pending())
	require.Equal(t, http.StatusNotFound, f.do(http.MethodGet, "/api/v1/admin/claudex/announcements/1", "").Status)
}

func TestContentIsChecked(t *testing.T) {
	f := newFixture(t)
	for body, field := range map[string]string{
		`{}`: "title",
		`{"title":"x","image_url":"javascript:alert(1)"}`:                        "image_url",
		`{"title":"x","primary_url":"ftp://example.com"}`:                        "primary_url",
		`{"title":"x","primary_url":"https://example.com"}`:                      "primary_label",
		`{"title":"` + strings.Repeat("a", 201) + `"}`:                           "title",
		`{"title":"x","body_html":"` + strings.Repeat("a", maxBodyHTML+1) + `"}`: "body_html",
	} {
		res := f.do(http.MethodPost, "/api/v1/admin/claudex/announcements", body)
		require.Equal(t, http.StatusBadRequest, res.Status, field)
		require.Contains(t, res.Raw, `"field":"`+field+`"`, res.Raw)
	}
	a := f.create(`{"body_html":"<style>p{color:red}</style><p>Only HTML</p>","body_format":"html"}`)
	require.Equal(t, "", a.Title)
	require.Equal(t, "html", a.BodyFormat)
	// The default is the template's plain text.
	require.Equal(t, "text", f.create(`{"title":"Plain","body_html":"Line one\nLine two"}`).BodyFormat)
	res0 := f.do(http.MethodPost, "/api/v1/admin/claudex/announcements", `{"title":"x","body_format":"markdown"}`)
	require.Equal(t, http.StatusBadRequest, res0.Status)
	require.Contains(t, res0.Raw, `"field":"body_format"`)
	for _, hours := range []string{`{}`, `{"duration_hours":0}`, `{"duration_hours":9000}`} {
		res := f.do(http.MethodPost, "/api/v1/admin/claudex/announcements/1/publish", hours)
		require.Equal(t, http.StatusBadRequest, res.Status, hours)
	}
	res := f.do(http.MethodPost, "/api/v1/claudex/announcements/1/read", `{"action":"explode"}`)
	require.Equal(t, http.StatusBadRequest, res.Status)
}

func TestMailGoesToChosenPeople(t *testing.T) {
	f := newFixture(t)
	res := f.do(http.MethodPost, "/api/v1/admin/claudex/announcement-mails",
		`{"subject":"Maintenance","body_html":"<p>Tonight</p>","user_ids":[3,4,3,500]}`)
	require.Equal(t, http.StatusOK, res.Status, res.Raw)
	var out struct {
		Recipients int `json:"recipients"`
	}
	res.into(t, &out)
	require.Equal(t, 2, out.Recipients, "duplicates and people without an address are left out")
	got := []string{<-f.sent, <-f.sent}
	sort.Strings(got)
	require.Equal(t, []string{"user3@example.com Maintenance", "user4@example.com Maintenance"}, got)
	require.Eventually(t, func() bool {
		mails, _ := f.store.listMails(context.Background(), 10)
		return len(mails) == 1 && mails[0].Status == "done" && mails[0].Sent == 2
	}, 2*time.Second, 10*time.Millisecond)

	for body, field := range map[string]string{
		`{"body_html":"<p>x</p>","user_ids":[3]}`:                  "subject",
		`{"subject":"a\nb","body_html":"<p>x</p>","user_ids":[3]}`: "subject",
		`{"subject":"x","user_ids":[3]}`:                           "body_html",
		`{"subject":"x","body_html":"<p>x</p>"}`:                   "user_ids",
		`{"subject":"x","body_html":"<p>x</p>","user_ids":[500]}`:  "user_ids",
	} {
		res := f.do(http.MethodPost, "/api/v1/admin/claudex/announcement-mails", body)
		require.Equal(t, http.StatusBadRequest, res.Status, body)
		require.Contains(t, res.Raw, `"field":"`+field+`"`, res.Raw)
	}

	// Without SMTP nothing is sent.
	f.c.mailer = nil
	res = f.do(http.MethodPost, "/api/v1/admin/claudex/announcement-mails",
		`{"subject":"x","body_html":"<p>x</p>","user_ids":[3]}`)
	require.Equal(t, http.StatusConflict, res.Status, res.Raw)
}
