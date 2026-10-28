package sharing

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"

	"github.com/alicebob/miniredis/v2"
	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
)

// memArtifactReports keeps artifact reports in memory.
type memArtifactReports struct {
	mu       sync.Mutex
	reports  []*ArtifactReportContent
	hashes   map[int64]string
	nextID   int64
	failWith error
}

func newMemArtifactReports() *memArtifactReports {
	return &memArtifactReports{hashes: map[int64]string{}}
}

func (s *memArtifactReports) insertArtifactReport(_ context.Context, in artifactReportInput, now time.Time) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failWith != nil {
		return false, s.failWith
	}
	for _, r := range s.reports {
		if in.IdentityHash != "" && r.UserID == in.UserID && s.hashes[r.ID] == in.IdentityHash && r.CreatedAt.After(now.Add(-24*time.Hour)) {
			return false, nil
		}
	}
	s.nextID++
	r := &ArtifactReportContent{ArtifactReport: ArtifactReport{
		ID: s.nextID, UserID: in.UserID, Title: in.Title, Language: in.Language, ContentBytes: in.ContentBytes,
		ContentTruncated: in.ContentTruncated, Reason: in.Reason, Category: in.Category, Notes: in.Notes,
		ReporterName: in.ReporterName, ReporterEmail: in.ReporterEmail, OptOutOfTraining: in.OptOutOfTraining,
		Status: reportOpen, CreatedAt: now,
	}, Content: in.Content}
	s.reports = append(s.reports, r)
	s.hashes[r.ID] = in.IdentityHash
	return true, nil
}

func (s *memArtifactReports) listArtifactReports(_ context.Context, f reportFilter) ([]ArtifactReport, int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	all := []ArtifactReport{}
	for i := len(s.reports) - 1; i >= 0; i-- {
		if f.Status == "" || s.reports[i].Status == f.Status {
			all = append(all, s.reports[i].ArtifactReport)
		}
	}
	return page(all, f.Page, f.Size), int64(len(all)), nil
}

func (s *memArtifactReports) artifactReport(_ context.Context, id int64) (*ArtifactReportContent, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range s.reports {
		if r.ID == id {
			out := *r
			return &out, nil
		}
	}
	return nil, nil
}

func (s *memArtifactReports) resolveArtifactReport(_ context.Context, id int64, status string, by int64, now time.Time) (*ArtifactReport, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range s.reports {
		if r.ID == id {
			b, t := by, now
			r.Status, r.ResolvedBy, r.ResolvedAt = status, &b, &t
			out := r.ArtifactReport
			return &out, nil
		}
	}
	return nil, nil
}

const artifactReportsPath = "/api/v1/claudex/sharing/artifact-reports"

func artifactReportBody(t *testing.T, fields map[string]any) string {
	t.Helper()
	body := map[string]any{
		"category": "violation_of_terms", "identity": "conv-1:page.html", "title": "Page",
		"language": "html", "content": "<p>hi</p>",
	}
	for k, v := range fields {
		body[k] = v
	}
	raw, err := json.Marshal(body)
	require.NoError(t, err)
	return string(raw)
}

// The app's Report artifact (live claude.ai bundle, 2026-10-12: the artifact
// viewer's report form, without the training opt-out): the report reaches
// the administrator's queue with a copy of the artifact, whether or not
// sharing is on, and follows Allow reports.
func TestArtifactReports(t *testing.T) {
	f := newFixture(t)
	mem := newMemArtifactReports()
	f.c.artifactReports = mem

	var st StatusDTO
	f.do(http.MethodGet, "/api/v1/claudex/sharing/status", "").into(t, &st)
	require.False(t, st.Enabled, "sharing is off")
	require.True(t, st.ArtifactReports, "reports are on by default and need no sharing")

	res := f.do(http.MethodPost, artifactReportsPath, artifactReportBody(t, map[string]any{
		"category": "VIOLATION_OF_TERMS", "notes": " spam ", "reporter_name": "Ann", "reporter_email": "ann@example.com",
	}))
	require.Equal(t, http.StatusOK, res.Status, res.Raw)
	require.Len(t, mem.reports, 1)
	rep := mem.reports[0]
	require.EqualValues(t, 7, rep.UserID)
	require.Equal(t, "violation_of_terms", rep.Category)
	require.Equal(t, "other", rep.Reason)
	require.Equal(t, "spam", rep.Notes)
	require.Equal(t, "Ann", rep.ReporterName)
	require.Equal(t, "ann@example.com", rep.ReporterEmail)
	require.False(t, rep.OptOutOfTraining, "the viewer's form has no opt-out")
	require.Equal(t, "Page", rep.Title)
	require.Equal(t, "html", rep.Language)
	require.Equal(t, "<p>hi</p>", rep.Content)
	require.EqualValues(t, 9, rep.ContentBytes)
	require.False(t, rep.ContentTruncated)
	require.Len(t, mem.hashes[rep.ID], 64)
	require.NotContains(t, mem.hashes[rep.ID], "conv-1", "the identity is only kept as a hash")

	// The same artifact again that day: accepted, not stored again.
	require.Equal(t, http.StatusOK, f.do(http.MethodPost, artifactReportsPath, artifactReportBody(t, nil)).Status)
	require.Len(t, mem.reports, 1)
	// Another account may report it.
	f.userID = 8
	require.Equal(t, http.StatusOK, f.do(http.MethodPost, artifactReportsPath, artifactReportBody(t, nil)).Status)
	require.Len(t, mem.reports, 2)
	f.userID = 7

	// Refused input.
	for _, fields := range []map[string]any{
		{"category": "copyright_infringement"}, // the form does not take it
		{"category": "nope"},
		{"identity": ""},
		{"language": strings.Repeat("x", 40)},
	} {
		res := f.do(http.MethodPost, artifactReportsPath, artifactReportBody(t, fields))
		require.Equal(t, http.StatusBadRequest, res.Status, fields)
		require.Equal(t, "CLAUDEX_SHARE_REPORT_INVALID", res.Reason, fields)
	}
	require.Equal(t, "CLAUDEX_SHARE_REPORT_INVALID", f.do(http.MethodPost, artifactReportsPath, `{`).Reason)

	// A long artifact keeps its first 512 KiB, cut on a character boundary;
	// the app may say it sent only the start.
	long := strings.Repeat("é", maxArtifactReportContentBytes) // two bytes each
	res = f.do(http.MethodPost, artifactReportsPath, artifactReportBody(t, map[string]any{"identity": "long", "content": long}))
	require.Equal(t, http.StatusOK, res.Status, res.Raw)
	kept := mem.reports[2]
	require.True(t, kept.ContentTruncated)
	require.LessOrEqual(t, len(kept.Content), maxArtifactReportContentBytes)
	require.True(t, utf8.ValidString(kept.Content))
	require.EqualValues(t, len(long), kept.ContentBytes)
	res = f.do(http.MethodPost, artifactReportsPath, artifactReportBody(t, map[string]any{"identity": "start", "content_bytes": 99999}))
	require.Equal(t, http.StatusOK, res.Status, res.Raw)
	require.True(t, mem.reports[3].ContentTruncated)
	require.EqualValues(t, 99999, mem.reports[3].ContentBytes)

	// Admin queue: newest first, without copies; one with its copy; resolve.
	var list paged[ArtifactReport]
	f.do(http.MethodGet, "/api/v1/admin/claudex/sharing/artifact-reports?status=open", "").into(t, &list)
	require.EqualValues(t, 4, list.Total)
	require.Equal(t, "u7@example.com", list.Items[len(list.Items)-1].UserEmail)
	require.NotContains(t, f.do(http.MethodGet, "/api/v1/admin/claudex/sharing/artifact-reports", "").Raw, "<p>hi</p>")
	require.Equal(t, "CLAUDEX_SHARE_FILTER_INVALID", f.do(http.MethodGet, "/api/v1/admin/claudex/sharing/artifact-reports?status=x", "").Reason)
	id := itoa64(rep.ID)
	var one ArtifactReportContent
	f.do(http.MethodGet, "/api/v1/admin/claudex/sharing/artifact-reports/"+id, "").into(t, &one)
	require.Equal(t, "<p>hi</p>", one.Content)
	require.Equal(t, "u7@example.com", one.UserEmail)
	require.Equal(t, http.StatusNotFound, f.do(http.MethodGet, "/api/v1/admin/claudex/sharing/artifact-reports/999", "").Status)

	require.Equal(t, "CLAUDEX_SHARE_REPORT_INVALID",
		f.do(http.MethodPost, "/api/v1/admin/claudex/sharing/artifact-reports/"+id+"/resolve", `{"action":"disable"}`).Reason,
		"there is nothing on the service to take down")
	res = f.do(http.MethodPost, "/api/v1/admin/claudex/sharing/artifact-reports/"+id+"/resolve", `{"action":"resolve"}`)
	require.Equal(t, http.StatusOK, res.Status, res.Raw)
	var done ArtifactReport
	res.into(t, &done)
	require.Equal(t, reportResolved, done.Status)
	require.NotNil(t, done.ResolvedBy)
	f.do(http.MethodGet, "/api/v1/admin/claudex/sharing/artifact-reports?status=open", "").into(t, &list)
	require.EqualValues(t, 3, list.Total)
	require.Equal(t, http.StatusNotFound,
		f.do(http.MethodPost, "/api/v1/admin/claudex/sharing/artifact-reports/999/resolve", `{"action":"dismiss"}`).Status)

	// Reports off: refused, and the status says so.
	f.enable(func(s *Settings) { s.Enabled = false; s.AllowReports = false })
	f.do(http.MethodGet, "/api/v1/claudex/sharing/status", "").into(t, &st)
	require.False(t, st.ArtifactReports)
	res = f.do(http.MethodPost, artifactReportsPath, artifactReportBody(t, map[string]any{"identity": "off"}))
	require.Equal(t, http.StatusNotFound, res.Status)
	require.Equal(t, "CLAUDEX_REPORTS_OFF", res.Reason)
}

func TestArtifactReportsRateLimitAndStorage(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	f := newFixture(t, fixtureOptions{env: func(e *core.Env) { e.Redis = rdb }})
	mem := newMemArtifactReports()
	f.c.artifactReports = mem
	limited := false
	for i := 0; i < artifactReportsPerUserPerHour+2; i++ {
		res := f.do(http.MethodPost, artifactReportsPath, artifactReportBody(t, map[string]any{"identity": "a" + itoa64(int64(i))}))
		if res.Status == http.StatusTooManyRequests {
			limited = true
		}
	}
	require.True(t, limited)
	require.Len(t, mem.reports, artifactReportsPerUserPerHour)

	mr.FlushAll()
	mem.failWith = context.DeadlineExceeded
	require.Equal(t, http.StatusInternalServerError,
		f.do(http.MethodPost, artifactReportsPath, artifactReportBody(t, map[string]any{"identity": "b"})).Status)

	// No database: nothing can keep a report.
	g := newFixture(t, fixtureOptions{noDB: true})
	var st StatusDTO
	g.do(http.MethodGet, "/api/v1/claudex/sharing/status", "").into(t, &st)
	require.False(t, st.ArtifactReports)
	res := g.do(http.MethodPost, artifactReportsPath, artifactReportBody(t, nil))
	require.Equal(t, http.StatusServiceUnavailable, res.Status)
	require.Equal(t, "CLAUDEX_SHARING_UNAVAILABLE", res.Reason)
	var list paged[ArtifactReport]
	g.do(http.MethodGet, "/api/v1/admin/claudex/sharing/artifact-reports", "").into(t, &list)
	require.Empty(t, list.Items)
}

func TestArtifactReportResolveNeedsStepUp(t *testing.T) {
	calls := 0
	f := newFixture(t, fixtureOptions{stepUp: func(c *gin.Context) {
		calls++
		c.AbortWithStatus(http.StatusForbidden)
	}})
	f.c.artifactReports = newMemArtifactReports()
	require.Equal(t, http.StatusForbidden, f.serve(http.MethodPost, "/api/v1/admin/claudex/sharing/artifact-reports/1/resolve", `{}`).Code)
	require.Equal(t, 1, calls)
	require.Equal(t, http.StatusOK, f.serve(http.MethodGet, "/api/v1/admin/claudex/sharing/artifact-reports", "").Code)
}

// The public page's Report form has the live form's "Opt out of training on
// this report" switch (a checkbox, off by default), and the choice is kept.
func TestPageReportOptOut(t *testing.T) {
	f := newFixture(t)
	f.enable(nil)
	dto := f.create("conv")
	body := f.serve(http.MethodGet, dto.Path, "").Body.String()
	require.Contains(t, body, `name="opt_out_of_training"`)
	require.Contains(t, body, `role="switch"`)
	require.NotContains(t, body, `name="opt_out_of_training" value="on" checked`, "off until the visitor turns it on")
	require.Contains(t, body, "Opt out of training on this report")

	require.Equal(t, http.StatusOK, f.serveForm(dto.Path+"/report", "reason=spam&opt_out_of_training=on"))
	require.Len(t, f.store.reports, 1)
	require.True(t, f.store.reports[0].OptOutOfTraining)

	g := newFixture(t)
	g.enable(nil)
	other := g.create("conv")
	require.Equal(t, http.StatusOK, g.serveForm(other.Path+"/report", "reason=spam"))
	require.False(t, g.store.reports[0].OptOutOfTraining, "an unchecked box sends nothing")

	require.True(t, formSwitchOn(" On "))
	require.False(t, formSwitchOn(""))
	require.False(t, formSwitchOn("off"))
}
