package ghconn

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"
)

// workGitHub serves work.go and pulls.go; it replaces the harness's GitHub
// after the connection was made, so the stored token is the one it sees.
type workGitHub struct {
	mu      sync.Mutex
	queries []string
	// repo is the GraphQL repository the pull request read answers (nil:
	// GitHub's NOT_FOUND); graphql records each query's variables, and
	// refuse makes the next mutation or merge fail with that message.
	repo    map[string]any
	graphql []map[string]any
	merges  []map[string]any
	refuse  string
}

func (f *workGitHub) install(t *testing.T, h *harness) {
	t.Helper()
	mux := http.NewServeMux()
	authed := func(fn http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer gho_") {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			fn(w, r)
		}
	}
	reply := func(w http.ResponseWriter, v any) { _ = json.NewEncoder(w).Encode(v) }
	issue := func(n int, title, state string, pull bool) map[string]any {
		m := map[string]any{
			"number": n, "title": title, "state": state,
			"html_url":           "https://github.com/octo/hello/issues/" + strconv.Itoa(n),
			"labels":             []map[string]any{{"name": "bug"}},
			"user":               map[string]any{"login": "octo"},
			"author_association": "OWNER",
			"body":               "Steps to reproduce",
		}
		if pull {
			m["pull_request"] = map[string]any{"url": "x"}
		}
		return m
	}
	mux.HandleFunc("/search/issues", authed(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.queries = append(f.queries, r.URL.Query().Get("q"))
		f.mu.Unlock()
		reply(w, map[string]any{"items": []map[string]any{
			issue(12, "Crash on start", "open", false),
			issue(13, "A pull request", "open", true),
			issue(14, "Slow list", "open", false),
		}})
	}))
	mux.HandleFunc("/repos/octo/hello/issues/12", authed(func(w http.ResponseWriter, r *http.Request) {
		reply(w, issue(12, "Crash on start", "open", false))
	}))
	mux.HandleFunc("/repos/octo/hello/issues/13", authed(func(w http.ResponseWriter, r *http.Request) {
		reply(w, issue(13, "A pull request", "open", true))
	}))
	mux.HandleFunc("/repos/octo/hello/issues/15", authed(func(w http.ResponseWriter, r *http.Request) {
		reply(w, issue(15, "Closed one", "closed", false))
	}))
	mux.HandleFunc("/graphql", authed(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Query     string         `json:"query"`
			Variables map[string]any `json:"variables"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.mu.Lock()
		defer f.mu.Unlock()
		body.Variables["_query"] = body.Query
		f.graphql = append(f.graphql, body.Variables)
		if strings.HasPrefix(strings.TrimSpace(body.Query), "mutation") {
			if f.refuse != "" {
				reply(w, map[string]any{"errors": []map[string]any{{"type": "UNPROCESSABLE", "message": f.refuse}}})
				return
			}
			reply(w, map[string]any{"data": map[string]any{}})
			return
		}
		if f.repo == nil || body.Variables["number"] != float64(7) {
			reply(w, map[string]any{"data": map[string]any{"repository": nil}, "errors": []map[string]any{{"type": "NOT_FOUND", "message": "Could not resolve to a PullRequest"}}})
			return
		}
		reply(w, map[string]any{"data": map[string]any{"repository": f.repo}})
	}))
	mux.HandleFunc("/repos/octo/hello/pulls/7/merge", authed(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.mu.Lock()
		defer f.mu.Unlock()
		f.merges = append(f.merges, body)
		if f.refuse != "" {
			w.WriteHeader(http.StatusConflict)
			reply(w, map[string]any{"message": f.refuse})
			return
		}
		reply(w, map[string]any{"merged": true})
	}))
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	h.c.gh = newClient(srv.URL, srv.URL, srv.Client())
}

func newWorkHarness(t *testing.T) (*harness, *workGitHub) {
	t.Helper()
	h := newHarness(t)
	h.connect(t, 7)
	f := &workGitHub{}
	f.install(t, h)
	return h, f
}

func TestIssuesListWhatInvolvesThePersonUntilTheyType(t *testing.T) {
	h, f := newWorkHarness(t)
	w, env := h.do(t, http.MethodGet, "/api/v1/claudex/web/github/issues?repo=octo/hello", "", 7)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var page IssuesPage
	require.NoError(t, json.Unmarshal(env.Data, &page))
	// The pull request the search returned is not an issue.
	require.Len(t, page.Items, 2)
	require.Equal(t, 12, page.Items[0].Number)
	require.Equal(t, "octo/hello", page.Items[0].Repository)
	require.Equal(t, []string{"bug"}, page.Items[0].Labels)
	require.Equal(t, "repo:octo/hello is:issue is:open involves:@me", f.queries[0])

	_, env = h.do(t, http.MethodGet, "/api/v1/claudex/web/github/issues?repo=octo/hello&query="+url.QueryEscape("  slow\nlist "), "", 7)
	require.NoError(t, json.Unmarshal(env.Data, &page))
	require.Equal(t, "repo:octo/hello is:issue is:open slow list", f.queries[1])
}

func TestIssuesFindANumberAndNeverListItTwice(t *testing.T) {
	h, _ := newWorkHarness(t)
	var page IssuesPage
	_, env := h.do(t, http.MethodGet, "/api/v1/claudex/web/github/issues?repo=octo/hello&query="+url.QueryEscape("#12"), "", 7)
	require.NoError(t, json.Unmarshal(env.Data, &page))
	numbers := []int{}
	for _, it := range page.Items {
		numbers = append(numbers, it.Number)
	}
	require.Equal(t, []int{12, 14}, numbers)

	// A pull request's number, a closed issue and an unknown number add nothing.
	for _, q := range []string{"13", "15", "999"} {
		_, env = h.do(t, http.MethodGet, "/api/v1/claudex/web/github/issues?repo=octo/hello&query="+q, "", 7)
		require.NoError(t, json.Unmarshal(env.Data, &page))
		numbers = numbers[:0]
		for _, it := range page.Items {
			numbers = append(numbers, it.Number)
		}
		require.Equal(t, []int{12, 14}, numbers, q)
	}
}

func TestIssuesRefuseBadInput(t *testing.T) {
	h, _ := newWorkHarness(t)
	for _, path := range []string{
		"/api/v1/claudex/web/github/issues",
		"/api/v1/claudex/web/github/issues?repo=octo",
		"/api/v1/claudex/web/github/issues?repo=octo/hello&query=" + strings.Repeat("a", maxIssueQuery+1),
		"/api/v1/claudex/web/github/issue?repo=octo/hello",
		"/api/v1/claudex/web/github/issue?repo=octo/hello&number=0",
		"/api/v1/claudex/web/github/pull?repo=octo/hello&number=abc",
	} {
		w, env := h.do(t, http.MethodGet, path, "", 7)
		require.Equal(t, http.StatusBadRequest, w.Code, path)
		require.Equal(t, ReasonBadRepo, env.Reason, path)
	}
	// Someone who has not connected GitHub is told so.
	w, env := h.do(t, http.MethodGet, "/api/v1/claudex/web/github/issues?repo=octo/hello", "", 8)
	require.Equal(t, http.StatusConflict, w.Code)
	require.Equal(t, ReasonNotConnected, env.Reason)
}

func TestIssueDetailCarriesItsText(t *testing.T) {
	h, _ := newWorkHarness(t)
	w, env := h.do(t, http.MethodGet, "/api/v1/claudex/web/github/issue?repo=octo/hello&number=12", "", 7)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var d IssueDetail
	require.NoError(t, json.Unmarshal(env.Data, &d))
	require.Equal(t, 12, d.Number)
	require.Equal(t, "Steps to reproduce", d.Body)
	require.Equal(t, "octo", d.Author)
	require.Equal(t, "OWNER", d.AuthorAssociation)
	require.Contains(t, w.Body.String(), `"author_association":"OWNER"`)

	// A pull request is not an issue; an unknown number is a 404.
	w, env = h.do(t, http.MethodGet, "/api/v1/claudex/web/github/issue?repo=octo/hello&number=13", "", 7)
	require.Equal(t, http.StatusNotFound, w.Code)
	require.Equal(t, ReasonNoAccess, env.Reason)
	w, _ = h.do(t, http.MethodGet, "/api/v1/claudex/web/github/issue?repo=octo/hello&number=404", "", 7)
	require.Equal(t, http.StatusNotFound, w.Code)
}

// openPullRepo is GraphQL's answer for an open, approved pull request whose
// one check passed.
func openPullRepo() map[string]any {
	return map[string]any{
		"viewerPermission": "WRITE", "autoMergeAllowed": true,
		"mergeCommitAllowed": true, "squashMergeAllowed": true, "rebaseMergeAllowed": false, "viewerDefaultMergeMethod": "REBASE",
		"pullRequest": map[string]any{
			"id": "PR_kw7", "number": 7, "url": "https://github.com/octo/hello/pull/7", "title": "Add a thing",
			"state": "OPEN", "isDraft": false, "merged": false,
			"mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN", "reviewDecision": "APPROVED",
			"isInMergeQueue": false, "isMergeQueueEnabled": false,
			"additions": 12, "deletions": 3, "baseRefName": "main", "headRefName": "feature",
			"headRefOid": "0123456789abcdef", "autoMergeRequest": nil,
			"commits": map[string]any{"nodes": []map[string]any{{"commit": map[string]any{
				"statusCheckRollup": map[string]any{"contexts": map[string]any{"nodes": []map[string]any{
					{"__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SUCCESS"},
				}}},
			}}}},
		},
	}
}

func setPull(repo map[string]any, key string, value any) {
	repo["pullRequest"].(map[string]any)[key] = value
}

func TestPullRequestStateReviewsAndChecks(t *testing.T) {
	h, f := newWorkHarness(t)
	get := func() PullRequest {
		w, env := h.do(t, http.MethodGet, "/api/v1/claudex/web/github/pull?repo=octo/hello&number=7", "", 7)
		require.Equal(t, http.StatusOK, w.Code, w.Body.String())
		var pr PullRequest
		require.NoError(t, json.Unmarshal(env.Data, &pr))
		return pr
	}

	f.repo = openPullRepo()
	require.Equal(t, PullRequest{
		Number: 7, URL: "https://github.com/octo/hello/pull/7", Repository: "octo/hello", Title: "Add a thing",
		State: "open", Checks: "passed", CheckCounts: &CheckCounts{Passed: 1},
		BaseRef: "main", HeadRef: "feature", HeadSHA: "0123456789abcdef",
		Review: "approved", MergeState: "clean", AutoMergeAllowed: true,
		// The account prefers rebase, which the repository doesn't allow.
		MergeMethod: "squash", CanMerge: true, Additions: 12, Deletions: 3,
	}, get())
	require.Equal(t, map[string]any{"owner": "octo", "name": "hello", "number": float64(7), "_query": pullQuery}, f.graphql[0])

	f.repo = openPullRepo()
	setPull(f.repo, "commits", map[string]any{"nodes": []map[string]any{{"commit": map[string]any{
		"statusCheckRollup": map[string]any{"contexts": map[string]any{"nodes": []map[string]any{
			{"__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SUCCESS"},
			{"__typename": "CheckRun", "status": "IN_PROGRESS"},
			{"__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SKIPPED"},
			{"__typename": "StatusContext", "state": "FAILURE"},
		}}},
	}}}})
	pr := get()
	require.Equal(t, "failed", pr.Checks)
	require.Equal(t, &CheckCounts{Passed: 1, Failed: 1, Pending: 1, Skipped: 1}, pr.CheckCounts)

	f.repo = openPullRepo()
	setPull(f.repo, "isDraft", true)
	require.Equal(t, "draft", get().State)
	f.repo = openPullRepo()
	setPull(f.repo, "isInMergeQueue", true)
	require.Equal(t, "queued", get().State)
	f.repo = openPullRepo()
	setPull(f.repo, "mergeable", "CONFLICTING")
	setPull(f.repo, "reviewDecision", "CHANGES_REQUESTED")
	setPull(f.repo, "autoMergeRequest", map[string]any{"enabledAt": "2026-10-12T00:00:00Z"})
	pr = get()
	require.True(t, pr.Conflicting)
	require.True(t, pr.AutoMerge)
	require.Equal(t, "changes_requested", pr.Review)

	// Merged and closed requests are final: their checks no longer show.
	f.repo = openPullRepo()
	setPull(f.repo, "state", "MERGED")
	setPull(f.repo, "merged", true)
	pr = get()
	require.Equal(t, "merged", pr.State)
	require.Equal(t, "none", pr.Checks)
	require.Nil(t, pr.CheckCounts)
	f.repo = openPullRepo()
	setPull(f.repo, "state", "CLOSED")
	require.Equal(t, "closed", get().State)

	// A request this account cannot see is a 404.
	w, _ := h.do(t, http.MethodGet, "/api/v1/claudex/web/github/pull?repo=octo/hello&number=8", "", 7)
	require.Equal(t, http.StatusNotFound, w.Code)
}

func TestPullRequestChanges(t *testing.T) {
	h, f := newWorkHarness(t)
	f.repo = openPullRepo()
	post := func(body string) PullActionResult {
		w, env := h.do(t, http.MethodPost, "/api/v1/claudex/web/github/pull/action", body, 7)
		require.Equal(t, http.StatusOK, w.Code, w.Body.String())
		var out PullActionResult
		require.NoError(t, json.Unmarshal(env.Data, &out))
		return out
	}

	// A merge names the head commit the person saw and the method.
	require.Equal(t, PullActionResult{OK: true},
		post(`{"repo":"octo/hello","number":7,"action":"merge","head_sha":"0123456789abcdef","merge_method":"merge"}`))
	require.Equal(t, []map[string]any{{"merge_method": "merge", "sha": "0123456789abcdef"}}, f.merges)

	// The others are GraphQL mutations on the request's node.
	for action, mutation := range map[string]string{
		"autoMergeOn": "enablePullRequestAutoMerge", "autoMergeOff": "disablePullRequestAutoMerge",
		"ready": "markPullRequestReadyForReview", "draft": "convertPullRequestToDraft",
	} {
		f.graphql = nil
		require.Equal(t, PullActionResult{OK: true}, post(`{"repo":"octo/hello","number":7,"action":"`+action+`"}`), action)
		require.Len(t, f.graphql, 2, action)
		last := f.graphql[1]
		require.Contains(t, last["_query"], mutation, action)
		require.Equal(t, "PR_kw7", last["id"], action)
		if action == "autoMergeOn" {
			require.Equal(t, "SQUASH", last["method"])
		}
	}

	// GitHub's refusals come back with the reason the window words.
	f.refuse = "Pull request Auto merge is not allowed for this repository"
	require.Equal(t, PullActionResult{Reason: "repo_disallows_auto_merge"},
		post(`{"repo":"octo/hello","number":7,"action":"autoMergeOn"}`))
	f.refuse = "Head branch was modified. Review and try the merge again."
	require.Equal(t, PullActionResult{Reason: "head_moved"},
		post(`{"repo":"octo/hello","number":7,"action":"merge","head_sha":"0123456789abcdef"}`))
	f.refuse = "Something else entirely"
	require.Equal(t, PullActionResult{Reason: "unknown", Detail: "Something else entirely"},
		post(`{"repo":"octo/hello","number":7,"action":"ready"}`))
	f.refuse = ""

	// Bad input never reaches GitHub; an unknown request is a 404.
	for _, body := range []string{
		`{"repo":"octo/hello","number":7,"action":"close"}`,
		`{"repo":"octo","number":7,"action":"merge"}`,
		`{"repo":"octo/hello","number":0,"action":"merge"}`,
		`{"repo":"octo/hello","number":7,"action":"merge","head_sha":"not-a-sha"}`,
	} {
		w, env := h.do(t, http.MethodPost, "/api/v1/claudex/web/github/pull/action", body, 7)
		require.Equal(t, http.StatusBadRequest, w.Code, body)
		require.Equal(t, ReasonBadRepo, env.Reason, body)
	}
	w, _ := h.do(t, http.MethodPost, "/api/v1/claudex/web/github/pull/action", `{"repo":"octo/hello","number":8,"action":"ready"}`, 7)
	require.Equal(t, http.StatusNotFound, w.Code)
}

func TestCountChecksAndMergeMethod(t *testing.T) {
	require.Equal(t, "none", checksOf(countChecks(nil)))
	require.Equal(t, "skipped", checksOf(countChecks([]checkContext{{Typename: "CheckRun", Status: "COMPLETED", Conclusion: "SKIPPED"}})))
	require.Equal(t, "pending", checksOf(countChecks([]checkContext{
		{Typename: "CheckRun", Status: "COMPLETED", Conclusion: "SUCCESS"},
		{Typename: "StatusContext", State: "PENDING"},
	})))
	require.Equal(t, "failed", checksOf(countChecks([]checkContext{
		{Typename: "CheckRun", Status: "COMPLETED", Conclusion: "TIMED_OUT"},
		{Typename: "CheckRun", Status: "QUEUED"},
	})))
	require.Equal(t, "merge", mergeMethodOf(wirePullRepo{MergeCommitAllowed: true, ViewerDefaultMergeMethod: "MERGE"}))
	require.Equal(t, "rebase", mergeMethodOf(wirePullRepo{RebaseMergeAllowed: true}))
	require.Equal(t, "https://ghe.example/api/graphql", (&client{apiBase: "https://ghe.example/api/v3"}).graphqlAddress())
	require.Equal(t, "https://api.github.com/graphql", (&client{apiBase: "https://api.github.com"}).graphqlAddress())
}

func TestIssueSearchQuery(t *testing.T) {
	ref := RepoRef{Owner: "octo", Name: "hello"}
	require.Equal(t, "repo:octo/hello is:issue is:open involves:@me", issueSearchQuery(ref, ""))
	require.Equal(t, "repo:octo/hello is:issue is:open crash", issueSearchQuery(ref, "crash"))
	require.Equal(t, "a b", cleanQuery("  a \n\t b "))
}
