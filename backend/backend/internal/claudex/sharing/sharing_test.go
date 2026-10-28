package sharing

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"

	"github.com/alicebob/miniredis/v2"
	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
)

func TestComponentContract(t *testing.T) {
	c := New(&core.Env{})
	require.Equal(t, core.NameSharing, c.Name())
	require.Equal(t, []string{"claudex_sharing"}, c.SettingKeys())
	require.NotNil(t, New(nil))
	New(nil).Start(context.Background()) // no database: no job, no panic
	require.False(t, New(&core.Env{}).hasDB())
}

func TestDefaultsShareNothing(t *testing.T) {
	s := defaultSettings()
	normalizeSettings(&s)
	require.False(t, s.Enabled, "owner default: sharing is off")
	require.Zero(t, s.DefaultTTLDays, "owner default: links never expire")
	require.True(t, s.AllowReports)
	require.NoError(t, validateSettings(&s))

	f := newFixture(t)
	res := f.do(http.MethodGet, "/api/v1/claudex/sharing/status", "")
	require.Equal(t, http.StatusOK, res.Status)
	var st StatusDTO
	res.into(t, &st)
	require.False(t, st.Enabled)
	require.False(t, st.Conversations)
	require.False(t, st.Artifacts)

	res = f.do(http.MethodPost, "/api/v1/claudex/shares", conversationBody("conv-1", "x"))
	require.Equal(t, http.StatusForbidden, res.Status)
	require.Equal(t, "CLAUDEX_SHARING_DISABLED", res.Reason)
}

func TestNoDatabase(t *testing.T) {
	f := newFixture(t, fixtureOptions{noDB: true})
	f.enable(nil)
	var st StatusDTO
	f.do(http.MethodGet, "/api/v1/claudex/sharing/status", "").into(t, &st)
	require.False(t, st.Enabled, "no storage: no sharing")
	res := f.do(http.MethodPost, "/api/v1/claudex/shares", conversationBody("c", "t"))
	require.Equal(t, http.StatusServiceUnavailable, res.Status)
	require.Equal(t, "CLAUDEX_SHARING_UNAVAILABLE", res.Reason)
	require.Equal(t, http.StatusOK, f.do(http.MethodGet, "/api/v1/claudex/shares", "").Status)
	require.Equal(t, http.StatusNotFound, f.serve(http.MethodGet, "/s/"+strings.Repeat("a", 43), "").Code)
}

func TestCreateUpdateListRevoke(t *testing.T) {
	f := newFixture(t)
	f.enable(func(s *Settings) { s.PublicBaseURL = "https://share.example.com/base/" })

	res := f.do(http.MethodPost, "/api/v1/claudex/shares", conversationBody("conv-1", `  My   chat\n`))
	require.Equal(t, http.StatusCreated, res.Status, res.Raw)
	var dto ShareDTO
	res.into(t, &dto)
	require.Equal(t, KindConversation, dto.Kind)
	require.Equal(t, "My chat", dto.Title)
	require.Equal(t, StatusActive, dto.Status)
	require.True(t, ValidToken(strings.TrimPrefix(dto.Path, "/s/")), dto.Path)
	require.Equal(t, "https://share.example.com/base"+dto.Path, dto.URL)
	require.Len(t, dto.SourceKey, 64, "the raw client id is never stored")
	require.NotContains(t, dto.SourceKey, "conv-1")
	require.Nil(t, dto.ExpiresAt)

	// Sharing the same conversation again refreshes the snapshot, same link.
	f.clock = f.clock.Add(time.Hour)
	res = f.do(http.MethodPost, "/api/v1/claudex/shares", conversationBody("conv-1", "Renamed"))
	require.Equal(t, http.StatusOK, res.Status, res.Raw)
	var again ShareDTO
	res.into(t, &again)
	require.Equal(t, dto.ID, again.ID)
	require.Equal(t, dto.Path, again.Path)
	require.Equal(t, "Renamed", again.Title)
	require.True(t, again.SnapshotAt.After(dto.SnapshotAt))

	// A client that hashes its ids itself finds the same share.
	var list paged[ShareDTO]
	f.do(http.MethodGet, "/api/v1/claudex/shares?source_key=conv-1", "").into(t, &list)
	require.Len(t, list.Items, 1)
	f.do(http.MethodGet, "/api/v1/claudex/shares?source_key="+strings.ToUpper(dto.SourceKey), "").into(t, &list)
	require.Len(t, list.Items, 1)
	f.do(http.MethodGet, "/api/v1/claudex/shares?kind=artifact", "").into(t, &list)
	require.Empty(t, list.Items)
	require.Equal(t, "CLAUDEX_SHARE_FILTER_INVALID", f.do(http.MethodGet, "/api/v1/claudex/shares?kind=x", "").Reason)

	// PUT refreshes, keeps the kind.
	id := itoa64(dto.ID)
	res = f.do(http.MethodPut, "/api/v1/claudex/shares/"+id,
		`{"snapshot":{"messages":[{"role":"user","text":"only a prompt"}]}}`)
	require.Equal(t, http.StatusOK, res.Status, res.Raw)
	var put ShareDTO
	res.into(t, &put)
	require.Equal(t, "Renamed", put.Title, "an update without a title keeps it")
	res = f.do(http.MethodPut, "/api/v1/claudex/shares/"+id, artifactBody("x"))
	require.Equal(t, "CLAUDEX_SHARE_INVALID", res.Reason)

	// Another user sees nothing.
	f.userID = 8
	require.Equal(t, http.StatusNotFound, f.do(http.MethodGet, "/api/v1/claudex/shares/"+id, "").Status)
	require.Equal(t, http.StatusNotFound, f.do(http.MethodPut, "/api/v1/claudex/shares/"+id, conversationBody("a", "b")).Status)
	var del struct {
		Revoked bool `json:"revoked"`
	}
	f.do(http.MethodDelete, "/api/v1/claudex/shares/"+id, "").into(t, &del)
	require.False(t, del.Revoked)
	f.userID = 7

	f.do(http.MethodDelete, "/api/v1/claudex/shares/"+id, "").into(t, &del)
	require.True(t, del.Revoked)
	f.do(http.MethodDelete, "/api/v1/claudex/shares/"+id, "").into(t, &del)
	require.False(t, del.Revoked, "idempotent")
	require.Equal(t, http.StatusNotFound, f.serve(http.MethodGet, dto.Path, "").Code, "a revoked link dies at once")

	// Sharing again after revoking makes a new link; the old token stays dead.
	res = f.do(http.MethodPost, "/api/v1/claudex/shares", conversationBody("conv-1", "Again"))
	require.Equal(t, http.StatusCreated, res.Status)
	var fresh ShareDTO
	res.into(t, &fresh)
	require.NotEqual(t, dto.Path, fresh.Path)
}

func TestSwitchesAndBlocks(t *testing.T) {
	f := newFixture(t)
	f.enable(func(s *Settings) { s.Artifacts = false })
	var st StatusDTO
	f.do(http.MethodGet, "/api/v1/claudex/sharing/status", "").into(t, &st)
	require.True(t, st.Enabled)
	require.True(t, st.Conversations)
	require.False(t, st.Artifacts)
	require.Equal(t, "CLAUDEX_SHARING_KIND_DISABLED", f.do(http.MethodPost, "/api/v1/claudex/shares", artifactBody("a")).Reason)
	dto := f.create("conv")

	// The administrator blocks the user.
	require.Equal(t, http.StatusOK, f.do(http.MethodPut, "/api/v1/admin/claudex/sharing/blocks/7", `{"reason":"spam"}`).Status)
	f.do(http.MethodGet, "/api/v1/claudex/sharing/status", "").into(t, &st)
	require.True(t, st.Blocked)
	require.False(t, st.Conversations)
	require.Equal(t, "CLAUDEX_SHARING_USER_BLOCKED", f.do(http.MethodPost, "/api/v1/claudex/shares", conversationBody("c2", "t")).Reason)
	require.Equal(t, "CLAUDEX_SHARING_USER_BLOCKED",
		f.do(http.MethodPut, "/api/v1/claudex/shares/"+itoa64(dto.ID), conversationBody("conv", "t")).Reason)
	// Existing shares stay online until the administrator takes them down.
	require.Equal(t, http.StatusOK, f.serve(http.MethodGet, dto.Path, "").Code)
	// Users can still list and delete while blocked or while sharing is off.
	require.Equal(t, http.StatusOK, f.do(http.MethodGet, "/api/v1/claudex/shares", "").Status)

	require.Equal(t, http.StatusNotFound, f.do(http.MethodPut, "/api/v1/admin/claudex/sharing/blocks/99", `{}`).Status)
	var blocks paged[Block]
	f.do(http.MethodGet, "/api/v1/admin/claudex/sharing/blocks", "").into(t, &blocks)
	require.Len(t, blocks.Items, 1)
	require.Equal(t, "u7@example.com", blocks.Items[0].UserEmail)
	require.Equal(t, "spam", blocks.Items[0].Reason)
	require.Equal(t, http.StatusOK, f.do(http.MethodDelete, "/api/v1/admin/claudex/sharing/blocks/7", "").Status)
	f.do(http.MethodGet, "/api/v1/claudex/sharing/status", "").into(t, &st)
	require.False(t, st.Blocked)

	// Master switch off: pages vanish, data is kept.
	f.enable(func(s *Settings) { s.Enabled = false })
	require.Equal(t, http.StatusNotFound, f.serve(http.MethodGet, dto.Path, "").Code)
	require.Len(t, f.store.shares, 1)
	f.enable(nil)
	require.Equal(t, http.StatusOK, f.serve(http.MethodGet, dto.Path, "").Code)
	// The kind switch hides existing pages of that kind too.
	f.enable(func(s *Settings) { s.Conversations = false })
	require.Equal(t, http.StatusNotFound, f.serve(http.MethodGet, dto.Path, "").Code)
}

func TestQuotaAndExpiry(t *testing.T) {
	f := newFixture(t)
	f.enable(func(s *Settings) { s.MaxActivePerUser = 2; s.DefaultTTLDays = 1 })
	a := f.create("a")
	require.NotNil(t, a.ExpiresAt)
	require.Equal(t, f.clock.Add(24*time.Hour), a.ExpiresAt.UTC())
	f.create("b")
	res := f.do(http.MethodPost, "/api/v1/claudex/shares", conversationBody("c", "t"))
	require.Equal(t, http.StatusConflict, res.Status)
	require.Equal(t, "CLAUDEX_SHARE_QUOTA", res.Reason)
	// Refreshing an existing source is not a new share.
	require.Equal(t, http.StatusOK, f.do(http.MethodPost, "/api/v1/claudex/shares", conversationBody("a", "t")).Status)

	f.clock = f.clock.Add(25 * time.Hour)
	require.Equal(t, http.StatusNotFound, f.serve(http.MethodGet, a.Path, "").Code, "expired")
	var list paged[ShareDTO]
	f.do(http.MethodGet, "/api/v1/claudex/shares", "").into(t, &list)
	require.Empty(t, list.Items)
	// Expired shares no longer count, and sharing the source again gives a new link.
	res = f.do(http.MethodPost, "/api/v1/claudex/shares", conversationBody("a", "t"))
	require.Equal(t, http.StatusCreated, res.Status)
	var again ShareDTO
	res.into(t, &again)
	require.NotEqual(t, a.Path, again.Path)

	expired, orphaned, err := f.c.Cleanup(context.Background())
	require.NoError(t, err)
	require.EqualValues(t, 1, expired, "b expired; a was already retired")
	require.Zero(t, orphaned)
}

func TestSnapshotLimitsOverHTTP(t *testing.T) {
	f := newFixture(t)
	f.enable(func(s *Settings) { s.MaxSnapshotBytes = minSnapshotBytes; s.MaxArtifactBytes = minArtifactBytes })
	big := strings.Repeat("x", int(minArtifactBytes)+1)
	body := `{"kind":"artifact","source_key":"k","snapshot":{"artifacts":[{"language":"html","content":"` + big + `"}]}}`
	res := f.do(http.MethodPost, "/api/v1/claudex/shares", body)
	require.Equal(t, http.StatusRequestEntityTooLarge, res.Status)
	require.Equal(t, "CLAUDEX_SHARE_TOO_LARGE", res.Reason)
	require.Equal(t, "snapshot.artifacts[0].content", res.Meta["field"])

	huge := strings.Repeat("y", int(minSnapshotBytes+requestOverheadBytes)+10)
	res = f.do(http.MethodPost, "/api/v1/claudex/shares", `{"kind":"conversation","source_key":"k","snapshot":{"messages":[{"role":"user","text":"`+huge+`"}]}}`)
	require.Equal(t, http.StatusRequestEntityTooLarge, res.Status)

	for _, bad := range []string{
		`{"kind":"other","source_key":"k","snapshot":{}}`,
		`{"kind":"conversation","source_key":"","snapshot":{"messages":[{"role":"user","text":"a"}]}}`,
		`{"kind":"conversation","source_key":"k","snapshot":{"messages":[{"role":"system","text":"a"}]}}`,
		`{"kind":"conversation","source_key":"k"}`,
		`not json`,
	} {
		res := f.do(http.MethodPost, "/api/v1/claudex/shares", bad)
		require.Equal(t, http.StatusBadRequest, res.Status, bad)
		require.Equal(t, "CLAUDEX_SHARE_INVALID", res.Reason, bad)
	}
}

func TestPublicPage(t *testing.T) {
	f := newFixture(t)
	f.enable(nil)
	dto := f.create("conv")
	w := f.serve(http.MethodGet, dto.Path, "")
	require.Equal(t, http.StatusOK, w.Code)
	require.Equal(t, "noindex, nofollow, noarchive", w.Header().Get("X-Robots-Tag"))
	require.Equal(t, "no-store", w.Header().Get("Cache-Control"))
	require.Equal(t, "no-referrer", w.Header().Get("Referrer-Policy"))
	require.Equal(t, "DENY", w.Header().Get("X-Frame-Options"))
	csp := w.Header().Get("Content-Security-Policy")
	require.Contains(t, csp, "default-src 'none'")
	require.Contains(t, csp, "frame-src 'self'")
	require.NotContains(t, csp, "script-src", "the page runs no script")
	body := w.Body.String()
	require.Contains(t, body, "Make a page")
	require.Contains(t, body, "Ran a command")
	require.Contains(t, body, `sandbox="allow-scripts"`)
	require.NotContains(t, body, "<script>parent.x=1</script>", "artifact HTML never lands in the page")
	require.Contains(t, body, dto.Path+"/a/0")
	require.Contains(t, body, `action="`+dto.Path+`/report"`)

	w = f.serve(http.MethodGet, dto.Path+"/a/0", "")
	require.Equal(t, http.StatusOK, w.Code)
	require.True(t, strings.HasPrefix(w.Header().Get("Content-Security-Policy"), "sandbox allow-scripts"))
	require.Contains(t, w.Header().Get("Content-Security-Policy"), "connect-src 'none'")
	require.Contains(t, w.Header().Get("Content-Security-Policy"), "frame-ancestors 'self'")
	require.Empty(t, w.Header().Get("X-Frame-Options"))
	require.Equal(t, "text/html; charset=utf-8", w.Header().Get("Content-Type"))
	require.Contains(t, w.Body.String(), "<script>parent.x=1</script>")

	w = f.serve(http.MethodGet, dto.Path+"/raw/0", "")
	require.Equal(t, http.StatusOK, w.Code)
	require.Equal(t, "text/plain; charset=utf-8", w.Header().Get("Content-Type"))
	require.Equal(t, `attachment; filename=Page.html`, w.Header().Get("Content-Disposition"))

	for _, p := range []string{dto.Path + "/a/1", dto.Path + "/a/01", dto.Path + "/a/-1", dto.Path + "/raw/x",
		"/s/short", "/s/" + strings.Repeat("a", 43), "/s/_assets/mermaid.min.js", "/s/_assets/../x"} {
		require.Equal(t, http.StatusNotFound, f.serve(http.MethodGet, p, "").Code, p)
	}

	// Taken down by the administrator: 410 on every page of it.
	require.Equal(t, http.StatusOK, f.do(http.MethodPost, "/api/v1/admin/claudex/sharing/shares/"+itoa64(dto.ID)+"/disable", `{"reason":"policy"}`).Status)
	w = f.serve(http.MethodGet, dto.Path, "")
	require.Equal(t, http.StatusGone, w.Code)
	require.Contains(t, w.Body.String(), "removed by the administrator")
	require.Equal(t, http.StatusGone, f.serve(http.MethodGet, dto.Path+"/a/0", "").Code)
	var mine ShareDTO
	f.do(http.MethodGet, "/api/v1/claudex/shares/"+itoa64(dto.ID), "").into(t, &mine)
	require.Equal(t, StatusDisabled, mine.Status)
	require.Equal(t, "policy", mine.DisabledReason)
	res := f.do(http.MethodPost, "/api/v1/claudex/shares", conversationBody("conv", "t"))
	require.Equal(t, "CLAUDEX_SHARE_DISABLED", res.Reason, "a taken-down share cannot be republished in place")
	require.Equal(t, http.StatusOK, f.do(http.MethodPost, "/api/v1/admin/claudex/sharing/shares/"+itoa64(dto.ID)+"/enable", "").Status)
	require.Equal(t, http.StatusOK, f.serve(http.MethodGet, dto.Path, "").Code)

	// The author's account was deleted: the page is gone before cleanup runs.
	f.store.users[7] = true
	require.Equal(t, http.StatusNotFound, f.serve(http.MethodGet, dto.Path, "").Code)
	_, orphaned, err := f.c.Cleanup(context.Background())
	require.NoError(t, err)
	require.EqualValues(t, 1, orphaned)
	require.Empty(t, f.store.contents)
}

func TestContentHostSeparation(t *testing.T) {
	f := newFixture(t)
	f.enable(func(s *Settings) {
		s.PublicBaseURL = "https://claudex.example.com"
		s.ContentBaseURL = "https://usercontent.example.com"
	})
	dto := f.create("conv")
	require.Equal(t, "https://claudex.example.com"+dto.Path, dto.URL)

	w := f.serve(http.MethodGet, dto.Path, "", "Host", "claudex.example.com")
	require.Equal(t, http.StatusOK, w.Code)
	require.Contains(t, w.Header().Get("Content-Security-Policy"), "frame-src https://usercontent.example.com")
	require.Contains(t, w.Body.String(), "https://usercontent.example.com"+dto.Path+"/a/0")

	// Pages never answer on the content host, documents only there.
	require.Equal(t, http.StatusNotFound, f.serve(http.MethodGet, dto.Path, "", "Host", "usercontent.example.com:443").Code)
	require.Equal(t, http.StatusNotFound, f.serve(http.MethodGet, dto.Path+"/a/0", "", "Host", "claudex.example.com").Code)
	w = f.serve(http.MethodGet, dto.Path+"/a/0", "", "Host", "USERCONTENT.example.com")
	require.Equal(t, http.StatusOK, w.Code)
	require.Contains(t, w.Header().Get("Content-Security-Policy"), "frame-ancestors https://claudex.example.com")
	require.Equal(t, http.StatusNotFound, f.serve(http.MethodPost, dto.Path+"/report", "reason=spam", "Host", "usercontent.example.com").Code)
}

func TestReportsAndModeration(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	f := newFixture(t, fixtureOptions{env: func(e *core.Env) { e.Redis = rdb }})
	f.enable(nil)
	dto := f.create("conv")
	token := strings.TrimPrefix(dto.Path, "/s/")

	// Views: at most one per visitor and hour.
	f.serve(http.MethodGet, dto.Path, "", "X-Real-IP", "203.0.113.5")
	f.serve(http.MethodGet, dto.Path, "", "X-Real-IP", "203.0.113.5")
	require.EqualValues(t, 1, f.store.shares[0].ViewCount)

	form := func(body string) int { return f.serveForm(dto.Path+"/report", body) }
	require.Equal(t, http.StatusBadRequest, form("reason=nope"))
	require.Equal(t, http.StatusOK, form("reason=spam&detail=buy+now"))
	require.Equal(t, http.StatusOK, form("reason=harmful"), "duplicates are accepted silently")
	require.Len(t, f.store.reports, 1)

	res := f.do(http.MethodPost, "/api/v1/claudex/shared/"+token+"/reports", `{"reason":"other","detail":"x"}`)
	require.Equal(t, http.StatusNoContent, res.Status)
	require.Equal(t, "CLAUDEX_SHARE_REPORT_INVALID", f.do(http.MethodPost, "/api/v1/claudex/shared/"+token+"/reports", `{"reason":"bad"}`).Reason)
	require.Equal(t, http.StatusNotFound, f.do(http.MethodPost, "/api/v1/claudex/shared/"+strings.Repeat("b", 43)+"/reports", `{"reason":"spam"}`).Status)

	// Rate limit: 10 reports an hour per visitor.
	limited := false
	for i := 0; i < 12; i++ {
		if f.do(http.MethodPost, "/api/v1/claudex/shared/"+token+"/reports", `{"reason":"spam"}`).Status == http.StatusTooManyRequests {
			limited = true
		}
	}
	require.True(t, limited)

	// Admin queue: list, open report count, resolve by takedown.
	var shares paged[AdminShareDTO]
	f.do(http.MethodGet, "/api/v1/admin/claudex/sharing/shares", "").into(t, &shares)
	require.Len(t, shares.Items, 1)
	require.EqualValues(t, 2, shares.Items[0].OpenReports)
	require.Equal(t, "u7@example.com", shares.Items[0].UserEmail)
	require.EqualValues(t, 1, shares.Items[0].ViewCount)

	var reports paged[Report]
	f.do(http.MethodGet, "/api/v1/admin/claudex/sharing/reports?status=open", "").into(t, &reports)
	require.Len(t, reports.Items, 2)
	spam := reports.Items[1] // newest first: the form report came first
	require.Equal(t, "spam", spam.Reason)
	require.Equal(t, "buy now", spam.Detail)
	require.Equal(t, dto.Path, spam.SharePath)
	rid := itoa64(spam.ID)
	require.Equal(t, "CLAUDEX_SHARE_REPORT_INVALID", f.do(http.MethodPost, "/api/v1/admin/claudex/sharing/reports/"+rid+"/resolve", `{"action":"x"}`).Reason)
	res = f.do(http.MethodPost, "/api/v1/admin/claudex/sharing/reports/"+rid+"/resolve", `{"action":"disable","reason":"spam"}`)
	require.Equal(t, http.StatusOK, res.Status, res.Raw)
	var rep Report
	res.into(t, &rep)
	require.Equal(t, reportResolved, rep.Status)
	require.Equal(t, StatusDisabled, rep.ShareStatus)
	require.Equal(t, http.StatusGone, f.serve(http.MethodGet, dto.Path, "").Code)
	require.Equal(t, http.StatusNotFound, f.do(http.MethodPost, "/api/v1/admin/claudex/sharing/reports/999/resolve", `{"action":"dismiss"}`).Status)

	// Reports off: the form and the JSON endpoint answer 404.
	f.enable(func(s *Settings) { s.AllowReports = false })
	require.Equal(t, http.StatusNotFound, f.do(http.MethodPost, "/api/v1/claudex/shared/"+token+"/reports", `{"reason":"spam"}`).Status)
}

func (f *fixture) serveForm(path, body string) int {
	f.t.Helper()
	w := f.serve(http.MethodPost, path, body, "Content-Type", "application/x-www-form-urlencoded", "X-Real-IP", "198.51.100.7")
	return w.Code
}

func TestAdminShareManagement(t *testing.T) {
	f := newFixture(t)
	f.enable(nil)
	a := f.create("a")
	f.userID = 8
	b := f.create("b")
	f.userID = 7

	var list paged[AdminShareDTO]
	f.do(http.MethodGet, "/api/v1/admin/claudex/sharing/shares?user_id=8", "").into(t, &list)
	require.Len(t, list.Items, 1)
	require.Equal(t, b.ID, list.Items[0].ID)
	f.do(http.MethodGet, "/api/v1/admin/claudex/sharing/shares?q=my", "").into(t, &list)
	require.Len(t, list.Items, 2)
	require.Equal(t, "CLAUDEX_SHARE_FILTER_INVALID", f.do(http.MethodGet, "/api/v1/admin/claudex/sharing/shares?status=x", "").Reason)

	var content struct {
		Snapshot Snapshot `json:"snapshot"`
	}
	f.do(http.MethodGet, "/api/v1/admin/claudex/sharing/shares/"+itoa64(a.ID)+"/content", "").into(t, &content)
	require.Equal(t, "Make a page", content.Snapshot.Messages[0].Text)
	var preview struct {
		URL  string `json:"url"`
		Path string `json:"path"`
	}
	f.do(http.MethodGet, "/api/v1/admin/claudex/sharing/shares/"+itoa64(a.ID)+"/preview", "").into(t, &preview)
	require.Equal(t, a.Path, preview.Path)
	require.Empty(t, preview.URL, "no public base configured")

	var n struct {
		Disabled int64 `json:"disabled"`
	}
	f.do(http.MethodPost, "/api/v1/admin/claudex/sharing/users/8/disable-all", `{"reason":"abuse"}`).into(t, &n)
	require.EqualValues(t, 1, n.Disabled)
	require.Equal(t, http.StatusGone, f.serve(http.MethodGet, b.Path, "").Code)
	require.Equal(t, http.StatusOK, f.serve(http.MethodGet, a.Path, "").Code)

	require.Equal(t, http.StatusOK, f.do(http.MethodDelete, "/api/v1/admin/claudex/sharing/shares/"+itoa64(a.ID), "").Status)
	require.Equal(t, http.StatusNotFound, f.do(http.MethodDelete, "/api/v1/admin/claudex/sharing/shares/"+itoa64(a.ID), "").Status)
	require.Equal(t, http.StatusNotFound, f.serve(http.MethodGet, a.Path, "").Code)
	require.Equal(t, http.StatusNotFound, f.do(http.MethodGet, "/api/v1/admin/claudex/sharing/shares/"+itoa64(a.ID)+"/content", "").Status)
	f.do(http.MethodGet, "/api/v1/admin/claudex/sharing/shares?status=revoked", "").into(t, &list)
	require.Len(t, list.Items, 1)
}

func TestAdminWritesNeedStepUp(t *testing.T) {
	calls := 0
	f := newFixture(t, fixtureOptions{stepUp: func(c *gin.Context) {
		calls++
		c.AbortWithStatus(http.StatusForbidden)
	}})
	for _, r := range []struct{ method, path string }{
		{http.MethodPut, "/api/v1/admin/claudex/sharing/settings"},
		{http.MethodPost, "/api/v1/admin/claudex/sharing/shares/1/disable"},
		{http.MethodPost, "/api/v1/admin/claudex/sharing/shares/1/enable"},
		{http.MethodDelete, "/api/v1/admin/claudex/sharing/shares/1"},
		{http.MethodPost, "/api/v1/admin/claudex/sharing/reports/1/resolve"},
		{http.MethodPut, "/api/v1/admin/claudex/sharing/blocks/7"},
		{http.MethodDelete, "/api/v1/admin/claudex/sharing/blocks/7"},
		{http.MethodPost, "/api/v1/admin/claudex/sharing/users/7/disable-all"},
	} {
		require.Equal(t, http.StatusForbidden, f.serve(r.method, r.path, `{}`).Code, r.path)
	}
	require.Equal(t, 8, calls)
	require.Equal(t, http.StatusOK, f.serve(http.MethodGet, "/api/v1/admin/claudex/sharing/settings", "").Code)
}

func TestAdminSettings(t *testing.T) {
	f := newFixture(t)
	var dto AdminSettingsDTO
	f.do(http.MethodGet, "/api/v1/admin/claudex/sharing/settings", "").into(t, &dto)
	require.False(t, dto.Settings.Enabled)
	require.Equal(t, BaseSourceNone, dto.Effective.PublicBaseURLSource)
	require.True(t, dto.Effective.StorageAvailable)

	res := f.do(http.MethodPut, "/api/v1/admin/claudex/sharing/settings", `{"enabled":true,"public_base_url":"https://s.example.com/","default_ttl_days":30}`)
	require.Equal(t, http.StatusOK, res.Status, res.Raw)
	res.into(t, &dto)
	require.True(t, dto.Settings.Enabled)
	require.Equal(t, "https://s.example.com", dto.Settings.PublicBaseURL)
	require.Equal(t, "https://s.example.com", dto.Effective.PublicBaseURL)
	require.Equal(t, BaseSourceSetting, dto.Effective.PublicBaseURLSource)
	require.True(t, dto.Settings.Conversations, "fields left out keep their values")

	for body, field := range map[string]string{
		`{"public_base_url":"http://s.example.com"}`:                        "public_base_url",
		`{"public_base_url":"https://s.example.com/?a=1"}`:                  "public_base_url",
		`{"public_base_url":"https://u:p@s.example.com"}`:                   "public_base_url",
		`{"content_base_url":"https://s.example.com"}`:                      "content_base_url",
		`{"public_base_url":"","content_base_url":"https://c.example.com"}`: "content_base_url",
		`{"usage_policy_url":"javascript:alert(1)"}`:                        "usage_policy_url",
		`{"max_snapshot_bytes":1}`:                                          "max_snapshot_bytes",
		`{"max_artifact_bytes":99999999}`:                                   "max_artifact_bytes",
		`{"default_ttl_days":-1}`:                                           "default_ttl_days",
		`{"max_active_per_user":0}`:                                         "max_active_per_user",
		`{"unknown":1}`:                                                     "body",
	} {
		res := f.do(http.MethodPut, "/api/v1/admin/claudex/sharing/settings", body)
		require.Equal(t, http.StatusBadRequest, res.Status, body)
		require.Equal(t, "CLAUDEX_SETTING_INVALID", res.Reason, body)
		require.Equal(t, field, res.Meta["field"], body)
	}
	// Loopback http is fine for development.
	require.Equal(t, http.StatusOK, f.do(http.MethodPut, "/api/v1/admin/claudex/sharing/settings", `{"public_base_url":"http://127.0.0.1:18080"}`).Status)
}

func TestPublicBaseFallsBackWithoutHardCoding(t *testing.T) {
	f := newFixture(t)
	f.enable(nil)
	dto := f.create("a")
	require.Empty(t, dto.URL, "no public base: the client joins the path to its server address")
	require.Equal(t, sharePath(strings.TrimPrefix(dto.Path, "/s/")), dto.Path)

	// Changing the base changes every link at once (links are never stored).
	f.enable(func(s *Settings) { s.PublicBaseURL = "https://new.example.com" })
	var got ShareDTO
	f.do(http.MethodGet, "/api/v1/claudex/shares/"+itoa64(dto.ID), "").into(t, &got)
	require.Equal(t, "https://new.example.com"+dto.Path, got.URL)

	require.Equal(t, "https://a.example.com/x", frontendBase(" https://a.example.com/x/ "))
	require.Equal(t, "http://10.0.0.2:8080", frontendBase("http://10.0.0.2:8080"))
	require.Empty(t, frontendBase("ftp://a.example.com"))
	require.Empty(t, frontendBase("https://a.example.com/?q=1"))
	require.Empty(t, frontendBase("relative/path"))
}

func TestUsagePolicyFallback(t *testing.T) {
	f := newFixture(t)
	f.enable(func(s *Settings) { s.PublicBaseURL = "https://s.example.com" })
	var st StatusDTO
	f.do(http.MethodGet, "/api/v1/claudex/sharing/status", "").into(t, &st)
	require.Empty(t, st.UsagePolicyURL, "no policy anywhere: the dialog shows the sentence without a link")

	require.NoError(t, f.repo.Set(context.Background(), upstreamKeyLegalDocuments,
		`[{"id":"terms","content_md":"x"},{"id":"usage-policy","title":"Usage","content_md":"Be nice."}]`))
	f.c.upstream.loadedAt = time.Time{}
	f.do(http.MethodGet, "/api/v1/claudex/sharing/status", "").into(t, &st)
	require.Equal(t, "https://s.example.com/legal/usage-policy", st.UsagePolicyURL)
	require.Equal(t, "/legal/usage-policy", st.UsagePolicyPath)

	f.enable(func(s *Settings) { s.UsagePolicyURL = "https://policy.example.com/usage" })
	f.do(http.MethodGet, "/api/v1/claudex/sharing/status", "").into(t, &st)
	require.Equal(t, "https://policy.example.com/usage", st.UsagePolicyURL)
	require.Empty(t, st.UsagePolicyPath)

	require.False(t, hasUsagePolicyDocument(`[{"id":"usage-policy","content_md":"  "}]`))
	require.False(t, hasUsagePolicyDocument(`not json`))
}

func TestSiteName(t *testing.T) {
	f := newFixture(t)
	require.Equal(t, "Claudex", f.c.siteName(context.Background()))
	require.NoError(t, f.repo.Set(context.Background(), upstreamKeySiteName, "Sub2API"))
	f.c.upstream.loadedAt = time.Time{}
	require.Equal(t, "Claudex", f.c.siteName(context.Background()), "the upstream default is not a name")
	require.NoError(t, f.repo.Set(context.Background(), upstreamKeySiteName, "Acme AI"))
	require.Equal(t, "Claudex", f.c.siteName(context.Background()), "cached for a minute")
	f.clock = f.clock.Add(2 * time.Minute)
	require.Equal(t, "Acme AI", f.c.siteName(context.Background()))
}

// fakeRenderer records what the component hands to a registered renderer.
type fakeRenderer struct {
	page     *PageView
	artifact *ArtifactView
	notice   *NoticeView
	status   int
}

func (r *fakeRenderer) Page(w http.ResponseWriter, v *PageView) error {
	r.page = v
	w.WriteHeader(http.StatusOK)
	return nil
}
func (r *fakeRenderer) Artifact(w http.ResponseWriter, v *ArtifactView) error {
	r.artifact = v
	w.WriteHeader(http.StatusOK)
	return nil
}
func (r *fakeRenderer) Notice(w http.ResponseWriter, status int, v *NoticeView) error {
	r.notice, r.status = v, status
	w.WriteHeader(status)
	return nil
}
func (r *fakeRenderer) Asset(w http.ResponseWriter, _ *http.Request, path string) bool {
	if path != "mermaid.min.js" {
		return false
	}
	w.WriteHeader(http.StatusOK)
	return true
}

func TestRegisteredRenderer(t *testing.T) {
	fr := &fakeRenderer{}
	RegisterRenderer(fr)
	t.Cleanup(func() { RegisterRenderer(nil) })
	f := newFixture(t)
	f.enable(func(s *Settings) {
		s.PublicBaseURL = "https://p.example.com"
		s.ContentBaseURL = "https://c.example.com"
	})
	dto := f.create("a")

	w := f.serve(http.MethodGet, dto.Path, "", "Host", "p.example.com")
	require.Equal(t, http.StatusOK, w.Code)
	require.Equal(t, "no-store", w.Header().Get("Cache-Control"), "shared headers are set before the renderer runs")
	require.NotNil(t, fr.page)
	require.Equal(t, "My chat", fr.page.Title)
	require.Equal(t, "Claudex", fr.page.SiteName)
	require.Equal(t, []string{"https://c.example.com" + dto.Path + "/a/0"}, fr.page.ArtifactURLs)
	require.Equal(t, []string{dto.Path + "/raw/0"}, fr.page.RawURLs)
	require.Equal(t, "https://c.example.com", fr.page.FrameSource)
	require.Equal(t, dto.Path+"/report", fr.page.ReportURL)
	require.Equal(t, ReportReasonOrder, fr.page.ReportReasons)
	require.Len(t, fr.page.Snapshot.Messages, 2)

	require.Equal(t, http.StatusOK, f.serve(http.MethodGet, dto.Path+"/a/0", "", "Host", "c.example.com").Code)
	require.Equal(t, "https://p.example.com", fr.artifact.FrameAncestors)
	require.Equal(t, "/s/_assets/", fr.artifact.AssetBase)
	require.Equal(t, "html", fr.artifact.Artifact.Language)

	require.Equal(t, http.StatusOK, f.serve(http.MethodGet, "/s/_assets/mermaid.min.js", "").Code)
	require.Equal(t, http.StatusNotFound, f.serve(http.MethodGet, "/s/_assets/other.js", "").Code)
	require.Equal(t, NoticeNotFound, fr.notice.Kind)

	require.Equal(t, http.StatusNotFound, f.serve(http.MethodGet, "/s/"+strings.Repeat("z", 43), "", "Host", "p.example.com").Code)
	require.Equal(t, NoticeNotFound, fr.notice.Kind)
	require.Equal(t, http.StatusNotFound, fr.status)
}

func TestNilBodiesDoNotPanic(t *testing.T) {
	f := newFixture(t)
	f.enable(nil)
	dto := f.create("a")
	for _, r := range []struct{ method, path string }{
		{http.MethodPost, "/api/v1/claudex/shares"},
		{http.MethodPut, "/api/v1/claudex/shares/" + itoa64(dto.ID)},
		{http.MethodPost, dto.Path + "/report"},
		{http.MethodPost, "/api/v1/claudex/shared/" + strings.TrimPrefix(dto.Path, "/s/") + "/reports"},
		{http.MethodPut, "/api/v1/admin/claudex/sharing/settings"},
		{http.MethodPost, "/api/v1/admin/claudex/sharing/shares/" + itoa64(dto.ID) + "/disable"},
		{http.MethodPost, "/api/v1/admin/claudex/sharing/reports/1/resolve"},
	} {
		req := httptest.NewRequest(r.method, r.path, nil)
		req.Body = nil
		w := httptest.NewRecorder()
		require.NotPanics(t, func() { f.router.ServeHTTP(w, req) }, r.path)
		require.Less(t, w.Code, 500, r.path)
	}
}

func TestTokens(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 2000; i++ {
		tok, err := newToken()
		require.NoError(t, err)
		require.Len(t, tok, 43)
		require.True(t, ValidToken(tok))
		require.NotContains(t, "_-", tok[:1], "never overlaps /s/_assets")
		require.False(t, seen[tok])
		seen[tok] = true
	}
	require.False(t, ValidToken("_"+strings.Repeat("a", 42)))
	require.False(t, ValidToken(strings.Repeat("a", 42)))
	require.False(t, ValidToken(strings.Repeat("a", 42)+"/"))
}
