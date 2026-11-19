package ghconn

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestRepositoryCompareUsesAccountToken(t *testing.T) {
	h := newHarness(t)
	h.connect(t, 7)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, http.MethodGet, r.Method)
		require.Equal(t, "/repos/octo/repo-1/compare/main...feature/work", r.URL.Path)
		require.Contains(t, r.Header.Get("Authorization"), "Bearer gho_")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ahead_by": 1, "merge_base_commit": map[string]any{"sha": "base"},
			"files": []map[string]any{{"filename": "file.txt", "patch": "@@ -1 +1 @@\n-old\n+new"}},
		})
	}))
	t.Cleanup(server.Close)
	h.c.gh.apiBase = server.URL
	body, _ := json.Marshal(map[string]any{"url": h.gh.srv.URL + "/octo/repo-1", "action": "repository.compare", "base": "main", "head": "feature/work"})
	answer, err := h.c.serveAPI(context.Background(), 7, body)
	require.NoError(t, err)
	require.EqualValues(t, 1, answer.(map[string]any)["ahead_by"])
	bad, _ := json.Marshal(map[string]any{"url": h.gh.srv.URL + "/octo/repo-1", "action": "repository.compare", "base": "../bad", "head": "feature"})
	_, err = h.c.serveAPI(context.Background(), 7, bad)
	require.Error(t, err)
	_, err = h.c.serveAPI(context.Background(), 8, body)
	require.Error(t, err)
}

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

func TestFindPullRequestBySessionOutputBranch(t *testing.T) {
	h := newHarness(t)
	h.connect(t, 7)
	open := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, http.MethodGet, r.Method)
		require.Equal(t, "/repos/octo/repo-1/pulls", r.URL.Path)
		state := r.URL.Query().Get("state")
		require.Contains(t, []string{"all", "open"}, state)
		require.Equal(t, url.Values{"head": {"octo:claude/feature"}, "state": {state}, "sort": {"created"}, "direction": {"desc"}, "per_page": {"1"}}, r.URL.Query())
		require.Contains(t, r.Header.Get("Authorization"), "Bearer gho_")
		var rows = []map[string]any{}
		if state == "all" {
			rows = append(rows, map[string]any{"number": 12, "state": "closed"})
		} else if open {
			rows = append(rows, map[string]any{"number": 9, "state": "open"})
		}
		_ = json.NewEncoder(w).Encode(rows)
	}))
	t.Cleanup(server.Close)
	h.c.gh.apiBase = server.URL
	body, err := json.Marshal(map[string]any{"url": h.gh.srv.URL + "/octo/repo-1", "action": "pr.byHead", "head": "claude/feature"})
	require.NoError(t, err)
	answer, err := h.c.serveAPI(context.Background(), 7, body)
	require.NoError(t, err)
	require.Equal(t, map[string]int{"number": 12}, answer)
	open = true
	answer, err = h.c.serveAPI(context.Background(), 7, body)
	require.NoError(t, err)
	require.Equal(t, map[string]int{"number": 9}, answer)
}

func TestHostedCreatePullRequestUsesExactForkHeadAndCommitSubject(t *testing.T) {
	h := newHarness(t)
	h.connect(t, 7)
	created := false
	repo := func(name string) map[string]any { return map[string]any{"full_name": name} }
	pull := func(number int, source, base string) map[string]any {
		return map[string]any{
			"number": number, "title": "Tighten validation", "state": "open", "draft": true,
			"html_url": "https://github.com/octo/upstream/pull/" + strconv.Itoa(number),
			"head":     map[string]any{"ref": "claude/feature", "repo": repo(source)},
			"base":     map[string]any{"ref": base, "repo": repo("octo/upstream")},
		}
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Contains(t, r.Header.Get("Authorization"), "Bearer gho_")
		switch r.Method + " " + r.URL.Path {
		case "GET /repos/octo/fork":
			require.NoError(t, json.NewEncoder(w).Encode(map[string]any{
				"parent": repo("octo/upstream"), "source": repo("original/upstream"),
			}))
		case "GET /repos/octo/upstream/pulls":
			require.Equal(t, url.Values{
				"head": {"octo:claude/feature"}, "base": {"release"}, "state": {"open"}, "per_page": {"100"},
			}, r.URL.Query())
			rows := []map[string]any{pull(7, "octo/other", "release"), pull(10, "octo/fork", "main")}
			if created {
				rows = append(rows, pull(21, "octo/fork", "release"))
			}
			require.NoError(t, json.NewEncoder(w).Encode(rows))
		case "GET /repos/octo/fork/commits/claude/feature":
			require.NoError(t, json.NewEncoder(w).Encode(map[string]any{
				"commit": map[string]any{"message": "Tighten validation\n\nMore details"},
			}))
		case "POST /repos/octo/upstream/pulls":
			require.False(t, created)
			created = true
			var payload map[string]any
			require.NoError(t, json.NewDecoder(r.Body).Decode(&payload))
			require.Equal(t, map[string]any{
				"title": "Tighten validation", "body": "Source: Code session",
				"head": "octo:claude/feature", "head_repo": "fork", "base": "release", "draft": true,
			}, payload)
			require.NoError(t, json.NewEncoder(w).Encode(pull(21, "octo/fork", "release")))
		default:
			t.Errorf("Unexpected request %s %s", r.Method, r.URL)
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	h.c.gh.apiBase = server.URL
	run := func(body map[string]any) any {
		raw, err := json.Marshal(body)
		require.NoError(t, err)
		answer, err := h.c.serveAPI(context.Background(), 7, raw)
		require.NoError(t, err)
		return answer
	}
	require.Equal(t, []string{"octo/upstream", "original/upstream"}, run(map[string]any{
		"url": h.gh.srv.URL + "/octo/fork", "action": "repository.forkBases",
	}))
	args := map[string]any{
		"url": h.gh.srv.URL + "/octo/upstream", "action": "pr.byHead",
		"head": "claude/feature", "headRepository": "octo/fork", "base": "release",
	}
	require.Equal(t, map[string]any{"pull_request": nil}, run(args))
	args["action"], args["body"], args["draft"] = "pr.create", "Source: Code session", true
	answer := run(args).(map[string]any)
	require.Equal(t, "octo/fork", answer["head_repository"])
	require.Equal(t, "release", answer["base_ref"])
	args["action"] = "pr.byHead"
	require.Equal(t, map[string]any{"pull_request": answer}, run(args))
}

// A list of sessions reads the state of its pull requests in one request.
