package ghconn

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestHostedBranchExistenceDistinguishesMissingFromInaccessible(t *testing.T) {
	h := newHarness(t)
	h.connect(t, 7)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, http.MethodGet, r.Method)
		require.Contains(t, r.Header.Get("Authorization"), "Bearer gho_")
		switch r.URL.EscapedPath() {
		case "/repos/octo/repo-1/branches/feature%2Fwork":
			_, _ = w.Write([]byte(`{"name":"feature/work"}`))
		case "/repos/octo/repo-1":
			_, _ = w.Write([]byte(`{"full_name":"octo/repo-1","name":"repo-1","owner":{"login":"octo"}}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)
	h.c.gh.apiBase = server.URL
	read := func(repo, branch string) (any, error) {
		body, err := json.Marshal(map[string]string{
			"url": h.gh.srv.URL + "/" + repo, "action": "repository.branchExists", "branch": branch,
		})
		require.NoError(t, err)
		return h.c.serveAPI(context.Background(), 7, body)
	}
	present, err := read("octo/repo-1", "feature/work")
	require.NoError(t, err)
	require.Equal(t, map[string]bool{"exists": true}, present)
	missing, err := read("octo/repo-1", "gone")
	require.NoError(t, err)
	require.Equal(t, map[string]bool{"exists": false}, missing)
	_, err = read("octo/private", "feature/work")
	require.Equal(t, ReasonNoAccess, reasonOf(err))
}

func TestHostedPullStatusReadsChecksWithoutReviewComments(t *testing.T) {
	h := newHarness(t)
	h.connect(t, 7)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, http.MethodPost, r.Method)
		require.Equal(t, "/graphql", r.URL.Path)
		require.Contains(t, r.Header.Get("Authorization"), "Bearer gho_")
		var input struct {
			Query     string
			Variables map[string]any
		}
		require.NoError(t, json.NewDecoder(r.Body).Decode(&input))
		require.Equal(t, map[string]any{
			"owner": "octo", "name": "repo-1", "number": float64(21), "ci": true, "review": true,
		}, input.Variables)
		require.Contains(t, input.Query, "... on StatusContext")
		require.NotContains(t, input.Query, "reviewThreads")
		_, _ = w.Write([]byte(`{"data":{"repository":{"pullRequest":{"headRefOid":"head","reviewDecision":"APPROVED"}}}}`))
	}))
	t.Cleanup(server.Close)
	h.c.gh.apiBase = server.URL
	body, err := json.Marshal(map[string]any{
		"url": h.gh.srv.URL + "/octo/repo-1", "action": "pr.hostedStatus", "number": 21,
		"includeCiStatus": true, "includeReviewDecision": true,
	})
	require.NoError(t, err)
	reply, err := h.c.serveAPI(context.Background(), 7, body)
	require.NoError(t, err)
	require.JSONEq(t, `{"headRefOid":"head","reviewDecision":"APPROVED"}`, string(reply.(json.RawMessage)))
}
