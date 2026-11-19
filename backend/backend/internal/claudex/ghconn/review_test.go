package ghconn

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

type reviewRoundTrip func(*http.Request) (*http.Response, error)

func TestReviewAutoFixUsesAccountGraphQLConnection(t *testing.T) {
	client := &http.Client{Transport: reviewRoundTrip(func(req *http.Request) (*http.Response, error) {
		require.Equal(t, "/graphql", req.URL.Path)
		require.Equal(t, "Bearer user-token", req.Header.Get("Authorization"))
		payload, err := io.ReadAll(req.Body)
		require.NoError(t, err)
		require.Contains(t, string(payload), "viewerDidAuthor")
		require.Contains(t, string(payload), "statusCheckRollup")
		body := `{"data":{"repository":{"pullRequest":{"state":"OPEN","headRefOid":"abc"}}}}`
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body))}, nil
	})}
	component := &Component{gh: newClient("https://github.com", "https://api.github.com", client)}
	out, err := component.serveAutoFixFacts(context.Background(), 7, "user-token", "octo", "repo", 3)
	require.NoError(t, err)
	require.Equal(t, "OPEN", out.(map[string]any)["pullRequest"].(map[string]any)["state"])
	_, err = component.serveAutoFixFacts(context.Background(), 7, "user-token", "octo", "repo", 0)
	require.Error(t, err)
}

func (transport reviewRoundTrip) RoundTrip(req *http.Request) (*http.Response, error) {
	return transport(req)
}

func TestReviewChecksBoundToPullRequest(t *testing.T) {
	calls := []string{}
	client := &http.Client{Transport: reviewRoundTrip(func(req *http.Request) (*http.Response, error) {
		require.Equal(t, "Bearer user-token", req.Header.Get("Authorization"))
		calls = append(calls, req.Method+" "+req.URL.Path)
		body := `{}`
		switch {
		case strings.HasSuffix(req.URL.Path, "/pulls/3"):
			body = `{"head":{"sha":"` + strings.Repeat("a", 40) + `"}}`
		case strings.Contains(req.URL.Path, "/commits/"):
			body = `{"check_runs":[{"id":12}]}`
		case strings.HasSuffix(req.URL.Path, "/annotations"):
			body = `[{"path":"src/a.ts","start_line":2,"message":"bad"}]`
		}
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body))}, nil
	})}
	component := &Component{gh: newClient("https://github.com", "https://api.github.com", client)}
	out, err := component.serveReview(context.Background(), 7, "user-token", "/repos/octo/repo", apiRequest{Action: "pr.annotations", Number: 3, CheckRunID: 12})
	require.NoError(t, err)
	require.Len(t, out.(map[string]any)["annotations"], 1)
	_, err = component.serveReview(context.Background(), 7, "user-token", "/repos/octo/repo", apiRequest{Action: "pr.rerun", Number: 3, CheckRunID: 99})
	require.Error(t, err)
	for _, call := range calls {
		require.NotContains(t, call, "/99/rerequest")
	}
	_, err = component.serveReview(context.Background(), 7, "user-token", "/repos/octo/repo", apiRequest{Action: "pr.rerun", Number: 3, CheckRunID: 12})
	require.NoError(t, err)
	require.Equal(t, "POST /repos/octo/repo/check-runs/12/rerequest", calls[len(calls)-1])
}

func TestReviewRejectsInvalidWrites(t *testing.T) {
	component := &Component{}
	for _, request := range []apiRequest{
		{Action: "pr.files"},
		{Action: "pr.review", Number: 3, Event: "REQUEST_CHANGES"},
		{Action: "pr.reply", Number: 3, Body: "x"},
		{Action: "pr.comment", Number: 3, CommitSHA: strings.Repeat("a", 40), Path: "src/a.ts", Line: 1, StartLine: 2, Body: "x"},
	} {
		_, err := component.serveReview(context.Background(), 7, "token", "/repos/octo/repo", request)
		require.Error(t, err)
	}
}

func TestReviewThreadsAndMutationBinding(t *testing.T) {
	calls := 0
	client := &http.Client{Transport: reviewRoundTrip(func(req *http.Request) (*http.Response, error) {
		calls++
		require.Equal(t, "/graphql", req.URL.Path)
		body := `{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[{"id":"PRRT_one","path":"a.ts","line":2,"viewerCanReply":true,"viewerCanResolve":true,"comments":{"nodes":[{"id":"comment","databaseId":4,"body":"Fix this","url":"https://github.com/octo/repo/pull/3#discussion","author":{"login":"octo"}}]}}]}}}}}`
		if calls == 3 {
			body = `{"data":{"resolveReviewThread":{"thread":{"isResolved":true}}}}`
		}
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body))}, nil
	})}
	component := &Component{gh: newClient("https://github.com", "https://api.github.com", client)}
	out, err := component.serveReview(context.Background(), 7, "token", "/repos/octo/repo", apiRequest{Action: "pr.threads", Number: 3})
	require.NoError(t, err)
	threads := out.(map[string]any)["threads"].([]map[string]any)
	require.Equal(t, "PRRT_one", threads[0]["id"])
	_, err = component.serveReview(context.Background(), 7, "token", "/repos/octo/repo", apiRequest{Action: "pr.resolve", Number: 3, ThreadID: "PRRT_one"})
	require.NoError(t, err)
	require.Equal(t, 3, calls)
	_, err = component.serveReview(context.Background(), 7, "token", "/repos/octo/repo", apiRequest{Action: "pr.resolve", Number: 3, ThreadID: "PRRT_other"})
	require.Error(t, err)
	require.Equal(t, 4, calls)
}
