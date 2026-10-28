package ghconn

import (
	"context"
	"encoding/json"
	"net/url"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestChatRepositoryReadEndpoint(t *testing.T) {
	endpoint, query, err := repositoryReadEndpoint("/repos/octo/repo", apiRequest{Action: "repository.tree", Branch: "feature/work"})
	require.NoError(t, err)
	require.Equal(t, "/repos/octo/repo/git/trees/feature%2Fwork", endpoint)
	require.Equal(t, url.Values{"recursive": {"1"}}, query)
	endpoint, query, err = repositoryReadEndpoint("/repos/octo/repo", apiRequest{Action: "repository.file", Branch: "feature/work", Path: "src/a #?.ts"})
	require.NoError(t, err)
	require.Equal(t, "/repos/octo/repo/contents/src/a%20%23%3F.ts", endpoint)
	require.Equal(t, url.Values{"ref": {"feature/work"}}, query)
	for _, name := range []string{"", "/etc/passwd", "../secret", "src/../../secret", "src//file", "src/./file", "src\\file", "src/file\x00", "src/file\t"} {
		_, _, err := repositoryReadEndpoint("/repos/octo/repo", apiRequest{Action: "repository.file", Branch: "main", Path: name})
		require.Error(t, err, name)
	}
	for _, branch := range []string{"", "-main", "../main", "main\n", "main?"} {
		_, _, err := repositoryReadEndpoint("/repos/octo/repo", apiRequest{Action: "repository.tree", Branch: branch})
		require.Error(t, err, branch)
	}
}

// pr.get gives a session's runner a pull request's state and branch
// (Conversation.pullRequests), and nothing the model could misuse.
func TestPullRequestStateForTheSession(t *testing.T) {
	h := newHarness(t)
	h.connect(t, 7)
	body, err := json.Marshal(map[string]any{"url": h.gh.srv.URL + "/octo/repo-1", "action": "pr.get", "number": 5})
	require.NoError(t, err)
	out, err := h.c.serveAPI(context.Background(), 7, body)
	require.NoError(t, err)
	got := out.(map[string]any)
	require.Equal(t, "closed", got["state"])
	require.Equal(t, true, got["merged"])
	require.Equal(t, "feature/x", got["head_ref"])
	require.Equal(t, "https://github.com/octo/repo-1/pull/5", got["html_url"])
	require.EqualValues(t, 5, got["number"])

	// A number is required.
	body, _ = json.Marshal(map[string]any{"url": h.gh.srv.URL + "/octo/repo-1", "action": "pr.get"})
	_, err = h.c.serveAPI(context.Background(), 7, body)
	require.Error(t, err)
	require.Equal(t, ReasonBadRepo, reasonOf(err))
}

// A list of sessions reads the state of its pull requests in one request.
