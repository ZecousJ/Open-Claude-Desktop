package sharing

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"

	"github.com/stretchr/testify/require"
)

type sentMail struct{ to, subject, body string }

// inviteFixture is a sharing fixture whose invitation mail is recorded, with
// user 8 as a second signed-in person.
func inviteFixture(t *testing.T) (*fixture, func() []sentMail) {
	f := newFixture(t, fixtureOptions{env: func(e *core.Env) {}})
	f.enable(nil)
	var mu sync.Mutex
	var sent []sentMail
	done := make(chan struct{}, 8)
	f.c.mailer = func(_ context.Context, to, subject, body string) error {
		mu.Lock()
		sent = append(sent, sentMail{to, subject, body})
		mu.Unlock()
		done <- struct{}{}
		return nil
	}
	return f, func() []sentMail {
		select {
		case <-done:
		default:
		}
		mu.Lock()
		defer mu.Unlock()
		return append([]sentMail{}, sent...)
	}
}

func inviteBody(email string) string { return `{"email":"` + email + `"}` }

func TestNormalizeEmail(t *testing.T) {
	for raw, want := range map[string]string{
		" Ann@Example.COM ":     "ann@example.com",
		"a.b+c@sub.example.org": "a.b+c@sub.example.org",
	} {
		got, ok := normalizeEmail(raw)
		require.True(t, ok, raw)
		require.Equal(t, want, got)
	}
	for _, bad := range []string{"", "no-at", "a@b", "a@b.", "Ann <ann@example.com>", "a b@example.com",
		"a@example.com,b@example.com", strings.Repeat("a", 260) + "@example.com"} {
		_, ok := normalizeEmail(bad)
		require.False(t, ok, bad)
	}
}

func TestInviteFlowSharesWithOnlyInvitedPeople(t *testing.T) {
	f, mails := inviteFixture(t)
	res := f.do(http.MethodPost, "/api/v1/claudex/shares",
		strings.Replace(conversationBody("conv-inv", "Plan"), `"kind"`, `"access":"invited","kind"`, 1))
	require.Equal(t, http.StatusCreated, res.Status, res.Raw)
	var dto ShareDTO
	res.into(t, &dto)
	require.True(t, dto.InvitedOnly)
	require.Empty(t, dto.Invites)
	token := strings.TrimPrefix(dto.Path, PathPrefix+"/")

	// No public page for an invited-only share.
	require.Equal(t, http.StatusNotFound, f.serve(http.MethodGet, "/s/"+token, "").Code)

	res = f.do(http.MethodPost, "/api/v1/claudex/shares/"+itoa64(dto.ID)+"/invites", inviteBody("U8@Example.com"),
		"Host", "claudex.example.test")
	require.Equal(t, http.StatusOK, res.Status, res.Raw)
	var out struct {
		Share ShareDTO `json:"share"`
		Added bool     `json:"added"`
	}
	res.into(t, &out)
	require.True(t, out.Added)
	require.Equal(t, []string{"u8@example.com"}, out.Share.Invites)

	// The address is told once, with a link into the web app.
	require.Eventually(t, func() bool { return len(mails()) == 1 }, 2e9, 10e6)
	sent := mails()[0]
	require.Equal(t, "u8@example.com", sent.to)
	require.Contains(t, sent.subject, "u7@example.com shared a chat with you")
	require.Contains(t, sent.body, "https://claudex.example.test"+AppSharePath+"/"+token)
	require.Contains(t, sent.body, "“Plan”")

	// Inviting again neither duplicates nor mails again.
	res = f.do(http.MethodPost, "/api/v1/claudex/shares/"+itoa64(dto.ID)+"/invites", inviteBody("u8@example.com"))
	res.into(t, &out)
	require.False(t, out.Added)
	require.Len(t, out.Share.Invites, 1)
	require.Len(t, mails(), 1)

	// The invited person lists and reads it; someone else cannot.
	f.userID = 8
	res = f.do(http.MethodGet, "/api/v1/claudex/sharing/shared-with-me", "")
	var list []SharedDTO
	res.into(t, &list)
	require.Len(t, list, 1)
	require.Equal(t, "Plan", list[0].Title)
	require.Equal(t, "u7@example.com", list[0].Owner)
	res = f.do(http.MethodGet, "/api/v1/claudex/sharing/shared-with-me/"+token, "")
	require.Equal(t, http.StatusOK, res.Status, res.Raw)
	var content SharedContentDTO
	res.into(t, &content)
	require.Len(t, content.Snapshot.Messages, 2)

	f.userID = 9
	res = f.do(http.MethodGet, "/api/v1/claudex/sharing/shared-with-me/"+token, "")
	require.Equal(t, http.StatusNotFound, res.Status)
	res = f.do(http.MethodGet, "/api/v1/claudex/sharing/shared-with-me", "")
	res.into(t, &list)
	require.Empty(t, list)

	// The owner removes the invite: the person loses access.
	f.userID = 7
	res = f.do(http.MethodDelete, "/api/v1/claudex/shares/"+itoa64(dto.ID)+"/invites?email=u8@example.com", "")
	require.Equal(t, http.StatusOK, res.Status)
	f.userID = 8
	require.Equal(t, http.StatusNotFound,
		f.do(http.MethodGet, "/api/v1/claudex/sharing/shared-with-me/"+token, "").Status)
}

func TestAccessSwitchesBetweenLinkAndInvited(t *testing.T) {
	f, _ := inviteFixture(t)
	dto := f.create("conv-sw")
	require.False(t, dto.InvitedOnly)
	token := strings.TrimPrefix(dto.Path, PathPrefix+"/")
	require.Equal(t, http.StatusOK, f.serve(http.MethodGet, "/s/"+token, "").Code)

	res := f.do(http.MethodPut, "/api/v1/claudex/shares/"+itoa64(dto.ID)+"/access", `{"access":"invited"}`)
	require.Equal(t, http.StatusOK, res.Status, res.Raw)
	var got ShareDTO
	res.into(t, &got)
	require.True(t, got.InvitedOnly)
	require.Equal(t, http.StatusNotFound, f.serve(http.MethodGet, "/s/"+token, "").Code, "the public link dies")

	res = f.do(http.MethodPut, "/api/v1/claudex/shares/"+itoa64(dto.ID)+"/access", `{"access":"link"}`)
	require.Equal(t, http.StatusOK, res.Status)
	require.Equal(t, http.StatusOK, f.serve(http.MethodGet, "/s/"+token, "").Code, "the same link works again")

	res = f.do(http.MethodPut, "/api/v1/claudex/shares/"+itoa64(dto.ID)+"/access", `{"access":"everyone"}`)
	require.Equal(t, http.StatusBadRequest, res.Status)
	require.Equal(t, "CLAUDEX_SHARE_ACCESS_INVALID", res.Reason)
}

func TestArtifactInvitedAccess(t *testing.T) {
	f, _ := inviteFixture(t)
	res := f.do(http.MethodPost, "/api/v1/claudex/shares",
		strings.Replace(artifactBody("artifact-private"), `"kind"`, `"access":"invited","kind"`, 1))
	require.Equal(t, http.StatusCreated, res.Status, res.Raw)
	var dto ShareDTO
	res.into(t, &dto)
	require.True(t, dto.InvitedOnly)
	token := strings.TrimPrefix(dto.Path, PathPrefix+"/")
	require.Equal(t, http.StatusNotFound, f.serve(http.MethodGet, "/s/"+token, "").Code)
	res = f.do(http.MethodPost, "/api/v1/claudex/shares/"+itoa64(dto.ID)+"/invites", inviteBody("u8@example.com"))
	require.Equal(t, http.StatusOK, res.Status, res.Raw)
	f.userID = 8
	res = f.do(http.MethodGet, "/api/v1/claudex/sharing/shared-with-me/"+token, "")
	require.Equal(t, http.StatusOK, res.Status, res.Raw)
	f.userID = 7
	res = f.do(http.MethodPut, "/api/v1/claudex/shares/"+itoa64(dto.ID)+"/access", `{"access":"link"}`)
	require.Equal(t, http.StatusOK, res.Status, res.Raw)
	res.into(t, &dto)
	require.False(t, dto.InvitedOnly)
	require.Equal(t, http.StatusOK, f.serve(http.MethodGet, "/s/"+token, "").Code)
}

func TestInviteRefusals(t *testing.T) {
	f, _ := inviteFixture(t)
	dto := f.create("conv-ref")
	path := "/api/v1/claudex/shares/" + itoa64(dto.ID) + "/invites"

	res := f.do(http.MethodPost, path, inviteBody("not an address"))
	require.Equal(t, http.StatusBadRequest, res.Status)
	require.Equal(t, "CLAUDEX_SHARE_INVITE_INVALID", res.Reason)

	res = f.do(http.MethodPost, path, inviteBody("U7@example.com"))
	require.Equal(t, http.StatusBadRequest, res.Status)
	require.Equal(t, "CLAUDEX_SHARE_INVITE_SELF", res.Reason)

	// Only the owner invites.
	f.userID = 8
	res = f.do(http.MethodPost, path, inviteBody("x@example.com"))
	require.Equal(t, http.StatusNotFound, res.Status)

	// A limit per share.
	f.userID = 7
	for i := 0; i < maxInvitesPerShare; i++ {
		require.Equal(t, http.StatusOK, f.do(http.MethodPost, path, inviteBody("p"+itoa64(int64(i))+"@example.com")).Status)
	}
	res = f.do(http.MethodPost, path, inviteBody("one-more@example.com"))
	require.Equal(t, http.StatusConflict, res.Status)
	require.Equal(t, "CLAUDEX_SHARE_INVITE_LIMIT", res.Reason)

	// Sharing off: no new invitations.
	f.enable(func(s *Settings) { s.Enabled = false })
	res = f.do(http.MethodPost, path, inviteBody("later@example.com"))
	require.Equal(t, http.StatusForbidden, res.Status)
}

// The app's Report chat (live claude.ai report form, 2026-10-12): someone
// who can read the share reports it with a category, optional name, e-mail
// and notes, and "Opt out of training on this report"; the administrator's
// queue carries all of it.
func TestInvitedPersonReportsTheChat(t *testing.T) {
	f, _ := inviteFixture(t)
	res := f.do(http.MethodPost, "/api/v1/claudex/shares",
		strings.Replace(conversationBody("conv-rep", "Plan"), `"kind"`, `"access":"invited","kind"`, 1))
	require.Equal(t, http.StatusCreated, res.Status, res.Raw)
	var dto ShareDTO
	res.into(t, &dto)
	token := strings.TrimPrefix(dto.Path, PathPrefix+"/")
	res = f.do(http.MethodPost, "/api/v1/claudex/shares/"+itoa64(dto.ID)+"/invites", inviteBody("u8@example.com"))
	require.Equal(t, http.StatusOK, res.Status, res.Raw)
	read := "/api/v1/claudex/sharing/shared-with-me/" + token
	path := read + "/report"

	f.userID = 8
	var content SharedContentDTO
	f.do(http.MethodGet, read, "").into(t, &content)
	require.True(t, content.Reportable)

	require.Equal(t, "CLAUDEX_SHARE_REPORT_INVALID",
		f.do(http.MethodPost, path, `{"category":"copyright_infringement"}`).Reason,
		"the form does not take copyright reports")
	require.Equal(t, "CLAUDEX_SHARE_REPORT_INVALID", f.do(http.MethodPost, path, `{}`).Reason)
	res = f.do(http.MethodPost, path, `{"category":"VIOLATION_OF_TERMS","notes":" spam ","reporter_name":"Ann",`+
		`"reporter_email":"ann@example.com","opt_out_of_training":true}`)
	require.Equal(t, http.StatusOK, res.Status, res.Raw)
	require.Equal(t, http.StatusOK, f.do(http.MethodPost, path, `{"category":"fraud"}`).Status,
		"a second report of the same share that day is accepted")
	require.Len(t, f.store.reports, 1, "and not stored again")
	rep := f.store.reports[0]
	require.Equal(t, "other", rep.Reason)
	require.Equal(t, "violation_of_terms", rep.Category)
	require.Equal(t, "spam", rep.Detail)
	require.Equal(t, "Ann", rep.ReporterName)
	require.Equal(t, "ann@example.com", rep.ReporterEmail)
	require.EqualValues(t, 8, *rep.ReporterUserID)
	require.True(t, rep.OptOutOfTraining)

	var reports paged[Report]
	f.do(http.MethodGet, "/api/v1/admin/claudex/sharing/reports", "").into(t, &reports)
	require.Len(t, reports.Items, 1)
	require.True(t, reports.Items[0].OptOutOfTraining)
	require.Equal(t, "violation_of_terms", reports.Items[0].Category)

	// Without the switch the report may be used (the live default is off).
	f.userID = 7
	require.Equal(t, http.StatusOK, f.do(http.MethodPost, path, `{"category":"fraud"}`).Status)
	require.Len(t, f.store.reports, 2)
	require.False(t, f.store.reports[1].OptOutOfTraining)
	require.Equal(t, "illegal", f.store.reports[1].Reason)

	// Someone not invited cannot report it, nor anyone when reports are off.
	f.userID = 9
	require.Equal(t, http.StatusNotFound, f.do(http.MethodPost, path, `{"category":"fraud"}`).Status)
	f.userID = 8
	f.enable(func(s *Settings) { s.AllowReports = false })
	require.Equal(t, http.StatusNotFound, f.do(http.MethodPost, path, `{"category":"fraud"}`).Status)
	f.do(http.MethodGet, read, "").into(t, &content)
	require.False(t, content.Reportable)
}
