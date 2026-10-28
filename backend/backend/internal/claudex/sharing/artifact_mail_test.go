package sharing

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"
)

type memMailPrefs struct {
	mu    sync.Mutex
	prefs map[int64]artifactMailPatch
}

func (m *memMailPrefs) getMailPrefs(_ context.Context, userID int64) (ArtifactMailPreferences, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	p := m.prefs[userID]
	out := defaultMailPrefs()
	if p.Mentions != nil {
		out.Mentions = *p.Mentions
	}
	out.Comments = out.Mentions
	if p.Comments != nil {
		out.Comments = *p.Comments
	}
	if p.Shares != nil {
		out.Shares = *p.Shares
	}
	return out, nil
}

func (m *memMailPrefs) putMailPrefs(ctx context.Context, userID int64, patch artifactMailPatch) (ArtifactMailPreferences, error) {
	m.mu.Lock()
	p := m.prefs[userID]
	if patch.Mentions != nil {
		p.Mentions = patch.Mentions
	}
	if patch.Comments != nil {
		p.Comments = patch.Comments
	}
	if patch.Shares != nil {
		p.Shares = patch.Shares
	}
	m.prefs[userID] = p
	m.mu.Unlock()
	return m.getMailPrefs(ctx, userID)
}

// mailFixture: users 7 (owner), 8 and 9, recorded mail, preferences in memory.
func mailFixture(t *testing.T) (*fixture, func() []sentMail) {
	f, mails := inviteFixture(t)
	f.c.env.UserRepo = fakeUsers{emails: map[int64]string{7: "u7@example.com", 8: "u8@example.com", 9: "u9@example.com"}}
	f.c.mailPrefs = &memMailPrefs{prefs: map[int64]artifactMailPatch{}}
	return f, mails
}

func TestArtifactMailPreferencesDefaultOnAndCommentsFollowMentions(t *testing.T) {
	f, _ := mailFixture(t)
	path := "/api/v1/claudex/sharing/mail-preferences"
	var prefs ArtifactMailPreferences
	f.do(http.MethodGet, path, "").into(t, &prefs)
	require.Equal(t, ArtifactMailPreferences{Mentions: true, Comments: true, Shares: true}, prefs)
	f.do(http.MethodPatch, path, `{"mentions":false}`).into(t, &prefs)
	require.Equal(t, ArtifactMailPreferences{Mentions: false, Comments: false, Shares: true}, prefs)
	f.do(http.MethodPatch, path, `{"comments":true,"shares":false}`).into(t, &prefs)
	require.Equal(t, ArtifactMailPreferences{Mentions: false, Comments: true, Shares: false}, prefs)
}

func TestArtifactCommentMailsOwnerMentionsAndThread(t *testing.T) {
	f, mails := mailFixture(t)
	res := f.do(http.MethodPost, "/api/v1/claudex/shares", artifactBody("mail"))
	var share ShareDTO
	res.into(t, &share)
	invites := "/api/v1/claudex/shares/" + itoa64(share.ID) + "/invites"
	for _, who := range []string{"u8@example.com", "u9@example.com"} {
		res = f.do(http.MethodPost, invites, `{"email":"`+who+`","role":"comment","notify":false}`)
		require.Equal(t, http.StatusOK, res.Status, res.Raw)
	}
	read := "/api/v1/claudex/sharing/shared-with-me/" + strings.TrimPrefix(share.Path, PathPrefix+"/") + "/artifact"
	f.userID = 8
	require.Equal(t, http.StatusOK, f.do(http.MethodPut, read, `{"comment":"Looks good, @u9@example.com?"}`).Status)
	require.Eventually(t, func() bool { return len(mails()) == 2 }, 2e9, 10e6)
	got := map[string]string{}
	for _, m := range mails() {
		got[m.to] = m.subject
	}
	require.Contains(t, got["u7@example.com"], "New comment on")
	require.Contains(t, got["u9@example.com"], "mentioned you")
	// u9 answers: u8 is in the thread; the owner turned comments off.
	f.userID = 7
	f.do(http.MethodPatch, "/api/v1/claudex/sharing/mail-preferences", `{"comments":false}`)
	f.userID = 9
	require.Equal(t, http.StatusOK, f.do(http.MethodPut, read, `{"comment":"Agreed"}`).Status)
	require.Eventually(t, func() bool { return len(mails()) == 3 }, 2e9, 10e6)
	last := mails()[2]
	require.Equal(t, "u8@example.com", last.to)
	require.Contains(t, last.subject, "replied")
	require.Contains(t, last.body, "Agreed")
}

func TestArtifactInviteMailFollowsSharesPreference(t *testing.T) {
	f, mails := mailFixture(t)
	prefs, ok := f.c.mailPrefs.(*memMailPrefs)
	require.True(t, ok)
	prefs.prefs[8] = artifactMailPatch{Shares: ptrBool(false)}
	res := f.do(http.MethodPost, "/api/v1/claudex/shares", artifactBody("quiet"))
	var share ShareDTO
	res.into(t, &share)
	invites := "/api/v1/claudex/shares/" + itoa64(share.ID) + "/invites"
	res = f.do(http.MethodPost, invites, inviteBody("u8@example.com"))
	require.Equal(t, http.StatusOK, res.Status, res.Raw)
	require.Contains(t, res.Raw, `"mailed":false`)
	res = f.do(http.MethodPost, invites, inviteBody("u9@example.com"))
	require.Eventually(t, func() bool { return len(mails()) == 1 }, 2e9, 10e6)
	require.Equal(t, "u9@example.com", mails()[0].to)
}

func TestCommentRecipientsOnlyReadersOnceNeverTheAuthor(t *testing.T) {
	got := commentRecipients("a@x.io", "o@x.io", []string{"a@x.io", "b@x.io"},
		[]SnapshotComment{{Author: "b@x.io"}, {Author: "a@x.io"}}, "hi @b@x.io and @stranger@x.io @o@x.io")
	require.Equal(t, map[string]string{"b@x.io": "mention", "o@x.io": "mention"}, got)
}

func ptrBool(v bool) *bool { return &v }
