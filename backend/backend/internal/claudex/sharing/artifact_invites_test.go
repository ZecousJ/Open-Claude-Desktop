package sharing

import (
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestArtifactInviteRolesEnforcedAndChanged(t *testing.T) {
	f, _ := inviteFixture(t)
	res := f.do(http.MethodPost, "/api/v1/claudex/shares", artifactBody("roles"))
	var share ShareDTO
	res.into(t, &share)
	invites := "/api/v1/claudex/shares/" + itoa64(share.ID) + "/invites"
	read := "/api/v1/claudex/sharing/shared-with-me/" + strings.TrimPrefix(share.Path, PathPrefix+"/")
	for _, role := range []string{"view", "comment", "edit", "view"} {
		f.userID = 7
		res = f.do(http.MethodPost, invites, fmt.Sprintf(`{"email":"u8@example.com","role":%q,"notify":false}`, role))
		require.Equal(t, http.StatusOK, res.Status, res.Raw)
		var result struct {
			Share ShareDTO `json:"share"`
		}
		res.into(t, &result)
		require.Equal(t, role, result.Share.InviteRoles["u8@example.com"])
		f.userID = 8
		res = f.do(http.MethodGet, read, "")
		var content SharedContentDTO
		res.into(t, &content)
		require.Equal(t, role == "edit", content.CanEdit)
		require.Equal(t, role != "view", content.CanComment)
		require.False(t, content.CanRequestEdit)
		for _, patch := range []string{`{"comment":"Review this"}`, `{"content":"<svg/>"}`, `{"content":"<svg/>","comment":"Mixed"}`} {
			allowed := role == "edit" || (role == "comment" && !strings.Contains(patch, `"content"`))
			status := http.StatusNotFound
			if allowed {
				status = http.StatusOK
			}
			require.Equal(t, status, f.do(http.MethodPut, read+"/artifact", patch).Status, role+patch)
		}
		res = f.do(http.MethodPost, read+"/artifact-access", `{}`)
		if role == "edit" {
			require.Contains(t, res.Raw, "already_granted")
		} else {
			require.Contains(t, res.Raw, "unavailable")
		}
	}
}

func TestArtifactInvitesReadEditCommentAndRevoke(t *testing.T) {
	f, mails := inviteFixture(t)
	res := f.do(http.MethodPost, "/api/v1/claudex/shares", artifactBody("invited-artifact"))
	require.Equal(t, http.StatusCreated, res.Status, res.Raw)
	var share ShareDTO
	res.into(t, &share)
	token := strings.TrimPrefix(share.Path, PathPrefix+"/")
	invites := "/api/v1/claudex/shares/" + itoa64(share.ID) + "/invites"
	res = f.do(http.MethodPost, invites, inviteBody("u8@example.com"))
	require.Equal(t, http.StatusOK, res.Status, res.Raw)
	require.Eventually(t, func() bool { return len(mails()) == 1 }, 2e9, 10e6)
	require.Contains(t, mails()[0].subject, "shared an artifact")
	read := "/api/v1/claudex/sharing/shared-with-me/" + token
	f.userID = 9
	require.Equal(t, http.StatusNotFound, f.do(http.MethodPut, read+"/artifact", `{"content":"<svg/>"}`).Status)
	f.userID = 8
	res = f.do(http.MethodGet, read, "")
	require.Equal(t, http.StatusOK, res.Status, res.Raw)
	res = f.do(http.MethodPut, read+"/artifact", `{"content":"<svg><text>Edited</text></svg>","comment":"Please review"}`)
	require.Equal(t, http.StatusOK, res.Status, res.Raw)
	res = f.do(http.MethodGet, read, "")
	var content SharedContentDTO
	res.into(t, &content)
	require.Contains(t, content.Snapshot.Artifacts[0].Content, "Edited")
	require.Equal(t, []SnapshotComment{{Author: "u8@example.com", Text: "Please review"}}, content.Snapshot.Comments)
	page := f.serve(http.MethodGet, "/s/"+token, "")
	require.Equal(t, http.StatusOK, page.Code)
	require.Contains(t, page.Body.String(), "data-install-artifact")
	require.NotContains(t, page.Body.String(), "Please review")
	f.userID = 7
	require.Equal(t, http.StatusOK, f.do(http.MethodDelete, invites+"?email=u8@example.com", "").Status)
	f.userID = 8
	require.Equal(t, http.StatusNotFound, f.do(http.MethodPut, read+"/artifact", `{"comment":"No longer allowed"}`).Status)
}

func TestArtifactInviteMailKeepsUserContentUnchanged(t *testing.T) {
	subject, body := inviteMail("chat-owner@example.com", "chat and 对话", "https://chat.example/shared/chat-token", inviteRequest{}, KindArtifact)
	require.Equal(t, "chat-owner@example.com shared an artifact with you", subject)
	require.Contains(t, body, "chat and 对话")
	require.Contains(t, body, "https://chat.example/shared/chat-token")
	require.Contains(t, body, "Open the artifact")
}
