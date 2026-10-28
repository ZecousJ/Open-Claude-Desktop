package sharing

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func (s *memStore) embedDomains(_ context.Context, shareID int64) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failWith != nil {
		return nil, s.failWith
	}
	return append([]string{}, s.embedLists[shareID]...), nil
}

func (s *memStore) putEmbedDomains(_ context.Context, shareID int64, domains []string, _ time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failWith != nil {
		return s.failWith
	}
	s.embedLists[shareID] = append([]string{}, domains...)
	return nil
}

func (f *fixture) createArtifact(sourceKey string) ShareDTO {
	f.t.Helper()
	res := f.do(http.MethodPost, "/api/v1/claudex/shares", artifactBody(sourceKey))
	require.Contains(f.t, []int{http.StatusOK, http.StatusCreated}, res.Status, res.Raw)
	var dto ShareDTO
	res.into(f.t, &dto)
	return dto
}

func TestEmbedDomainCheck(t *testing.T) {
	for _, ok := range []string{"www.example.com", "*.example.com", "a-b.example.co", "x.io"} {
		require.True(t, ValidEmbedDomain(ok), ok)
	}
	for _, bad := range []string{"example", "http://example.com", "-a.example.com", "*example.com", "a..b.com", "ex ample.com", "example.c", "*.*.example.com", strings.Repeat("a", 250) + ".com"} {
		require.False(t, ValidEmbedDomain(bad), bad)
	}
	out, invalid := normalizeEmbedDomains([]string{" WWW.Example.com ", "", "www.example.com", "nope", "*.blog.io"})
	require.Equal(t, []string{"www.example.com", "*.blog.io"}, out)
	require.Equal(t, []string{"nope"}, invalid)
	require.Equal(t, "*", frameAncestors(nil))
	require.Equal(t, "www.example.com *.blog.io", frameAncestors(out))
}

// Get embed code: the owner reads and writes the allowed domains of a
// published artifact, and /s/<token>/embed serves the artifact with
// frame-ancestors set from them.
func TestArtifactEmbed(t *testing.T) {
	f := newFixture(t)
	f.enable(func(s *Settings) { s.PublicBaseURL = "https://claudex.example.com" })
	var st StatusDTO
	f.do(http.MethodGet, "/api/v1/claudex/sharing/status", "").into(t, &st)
	require.True(t, st.ArtifactEmbeds)

	dto := f.createArtifact("art")
	route := "/api/v1/claudex/shares/" + itoa64(dto.ID) + "/embed"
	var embed EmbedDTO
	f.do(http.MethodGet, route, "").into(t, &embed)
	require.Equal(t, EmbedDTO{Domains: []string{}, URL: "https://claudex.example.com" + dto.Path + "/embed", Path: dto.Path + "/embed"}, embed)

	// Any site may embed it while the list is empty.
	w := f.serve(http.MethodGet, dto.Path+"/embed", "")
	require.Equal(t, http.StatusOK, w.Code)
	require.True(t, strings.HasSuffix(w.Header().Get("Content-Security-Policy"), "frame-ancestors *"), w.Header().Get("Content-Security-Policy"))
	require.Contains(t, w.Header().Get("Content-Security-Policy"), "sandbox")
	require.Empty(t, w.Header().Get("X-Frame-Options"))
	require.Contains(t, w.Body.String(), "<svg")

	// An invalid domain stores nothing.
	res := f.do(http.MethodPut, route, `{"domains":["www.example.com","bad domain"]}`)
	require.Equal(t, http.StatusBadRequest, res.Status)
	require.Equal(t, "CLAUDEX_EMBED_DOMAINS_INVALID", res.Reason)
	require.Equal(t, "bad domain", res.Meta["domain"])
	require.Empty(t, f.store.embedLists[dto.ID])

	f.do(http.MethodPut, route, `{"domains":["WWW.example.com","*.blog.io","www.example.com"]}`).into(t, &embed)
	require.Equal(t, []string{"www.example.com", "*.blog.io"}, embed.Domains)
	w = f.serve(http.MethodGet, dto.Path+"/embed", "")
	require.True(t, strings.HasSuffix(w.Header().Get("Content-Security-Policy"), "frame-ancestors www.example.com *.blog.io"))

	// Too many domains.
	many := make([]string, maxEmbedDomains+1)
	for i := range many {
		many[i] = `"d` + itoa64(int64(i)) + `.example.com"`
	}
	require.Equal(t, http.StatusBadRequest, f.do(http.MethodPut, route, `{"domains":[`+strings.Join(many, ",")+`]}`).Status)

	// Someone else's share, a conversation share and a stopped share have none.
	f.userID = 8
	require.Equal(t, http.StatusNotFound, f.do(http.MethodGet, route, "").Status)
	f.userID = 7
	conv := f.create("conv")
	require.Equal(t, http.StatusNotFound, f.do(http.MethodGet, "/api/v1/claudex/shares/"+itoa64(conv.ID)+"/embed", "").Status)
	require.Equal(t, http.StatusNotFound, f.serve(http.MethodGet, conv.Path+"/embed", "").Code)
	require.Equal(t, http.StatusOK, f.serve(http.MethodDelete, "/api/v1/claudex/shares/"+itoa64(dto.ID), "").Code)
	require.Equal(t, http.StatusNotFound, f.serve(http.MethodGet, dto.Path+"/embed", "").Code)
	require.Equal(t, http.StatusNotFound, f.do(http.MethodGet, route, "").Status)
}

// With a content host the frame is served there only, and its link points
// there.
func TestArtifactEmbedOnContentHost(t *testing.T) {
	f := newFixture(t)
	f.enable(func(s *Settings) {
		s.PublicBaseURL = "https://claudex.example.com"
		s.ContentBaseURL = "https://usercontent.example.com"
	})
	dto := f.createArtifact("art")
	var embed EmbedDTO
	f.do(http.MethodGet, "/api/v1/claudex/shares/"+itoa64(dto.ID)+"/embed", "").into(t, &embed)
	require.Equal(t, "https://usercontent.example.com"+dto.Path+"/embed", embed.URL)
	require.Equal(t, http.StatusNotFound, f.serve(http.MethodGet, dto.Path+"/embed", "", "Host", "claudex.example.com").Code)
	require.Equal(t, http.StatusOK, f.serve(http.MethodGet, dto.Path+"/embed", "", "Host", "usercontent.example.com").Code)
}

// The page's Report form is the live report form: the 13 categories, name,
// e-mail and notes; the four categories it sends elsewhere are refused, and
// a form posted before the categories (reason, detail) is still taken.
func TestPageReportFormCategories(t *testing.T) {
	f := newFixture(t)
	f.enable(nil)
	dto := f.create("conv")
	body := f.serve(http.MethodGet, dto.Path, "").Body.String()
	require.Contains(t, body, "Why are you reporting this?")
	require.Contains(t, body, `<option value="" selected disabled>Select report reason</option>`)
	for _, c := range ReportCategoryOrder {
		require.Contains(t, body, ">"+c.Label+"</option>")
	}
	require.Len(t, ReportCategoryOrder, 13)
	require.Contains(t, body, `<option value="copyright_infringement" data-elsewhere>`)
	require.Contains(t, body, `name="reporter_name"`)
	require.Contains(t, body, `name="reporter_email"`)
	require.Contains(t, body, `name="notes"`)
	require.Contains(t, body, `type="submit">Report<`)
	for _, c := range ReportCategoryOrder {
		_, takes := reportCategories[c.Value]
		require.Equal(t, c.Takes, takes, c.Value)
	}

	require.Equal(t, http.StatusOK, f.serveForm(dto.Path+"/report",
		"category=defamation&notes=lies&reporter_name=Ann&reporter_email=ann%40example.com"))
	require.Len(t, f.store.reports, 1)
	r := f.store.reports[0]
	require.Equal(t, "illegal", r.Reason)
	require.Equal(t, "defamation", r.Category)
	require.Equal(t, "lies", r.Detail)
	require.Equal(t, "Ann", r.ReporterName)
	require.Equal(t, "ann@example.com", r.ReporterEmail)

	require.Equal(t, http.StatusBadRequest, f.serveForm(dto.Path+"/report", "category=court_order"))
	require.Equal(t, http.StatusBadRequest, f.serveForm(dto.Path+"/report", "category=nonsense&reason=spam"))
	require.Len(t, f.store.reports, 1)
}
