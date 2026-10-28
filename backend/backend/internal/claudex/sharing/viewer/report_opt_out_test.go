package viewer

import (
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The Report form ends with the live claude.ai report form's "Opt out of
// training on this report" (2026-10-12): a checkbox drawn as a switch, off
// until the visitor turns it on, with the note under it.
func TestReportFormOptOut(t *testing.T) {
	src := &fakeSource{opts: Options{AllowReports: true}}
	r := newRouter(src)
	body := get(r, "/s/"+tokA).Body.String()
	assert.Contains(t, body, `<input id="report-opt-out" type="checkbox" role="switch" name="opt_out_of_training" value="on" aria-describedby="report-opt-out-note">`)
	assert.Contains(t, body, "Opt out of training on this report")
	assert.Contains(t, body, "Reports help the administrator of Claudex keep this service safe")
	assert.Less(t, strings.Index(body, "report-opt-out"), strings.Index(body, `type="submit">Report<`))

	post := func(form url.Values) {
		rec := do(r, http.MethodPost, "/s/"+tokA+"/report", "", strings.NewReader(form.Encode()),
			map[string]string{"Content-Type": "application/x-www-form-urlencoded"})
		require.Equal(t, http.StatusOK, rec.Code)
	}
	post(url.Values{"reason": {"spam"}, "opt_out_of_training": {"on"}})
	post(url.Values{"reason": {"spam"}})
	require.Len(t, src.reports, 2)
	assert.True(t, src.reports[0].OptOutOfTraining)
	assert.False(t, src.reports[1].OptOutOfTraining, "an unchecked box sends nothing")

	assert.True(t, switchOn("ON"))
	assert.False(t, switchOn("0"))
}

// The form takes the live report form's categories with name, e-mail and
// notes; the four it sends elsewhere are refused.
func TestReportFormCategories(t *testing.T) {
	src := &fakeSource{opts: Options{AllowReports: true}}
	r := newRouter(src)
	post := func(form url.Values) int {
		return do(r, http.MethodPost, "/s/"+tokA+"/report", "", strings.NewReader(form.Encode()),
			map[string]string{"Content-Type": "application/x-www-form-urlencoded"}).Code
	}
	require.Equal(t, http.StatusOK, post(url.Values{
		"category": {"Fraud"}, "notes": {" scam "}, "reporter_name": {"Ann"}, "reporter_email": {"ann@example.com"},
	}))
	require.Len(t, src.reports, 1)
	assert.Equal(t, Report{Reason: "illegal", Category: "fraud", Detail: "scam", ReporterName: "Ann", ReporterEmail: "ann@example.com"}, src.reports[0])
	assert.Equal(t, http.StatusBadRequest, post(url.Values{"category": {"copyright_infringement"}}))
	assert.Equal(t, http.StatusBadRequest, post(url.Values{"category": {"nonsense"}}))
	assert.Len(t, src.reports, 1)
}
