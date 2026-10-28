package ghconn

import (
	"encoding/json"
	"net/http"
	"strconv"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestAwaitsReviewIsAnOpenRequestNobodyHasAnsweredYet(t *testing.T) {
	require.True(t, awaitsReview("open", "review_required"))
	require.True(t, awaitsReview("open", ""))
	require.False(t, awaitsReview("open", "approved"))
	require.False(t, awaitsReview("open", "changes_requested"))
	for _, state := range []string{"draft", "queued", "merged", "closed"} {
		require.False(t, awaitsReview(state, "review_required"), state)
	}
}

func TestPullStatesAnswerSeveralRequestsAndLeaveOutTheOnesGitHubDoesNotKnow(t *testing.T) {
	h, f := newWorkHarness(t)
	post := func(body string) (int, PullStatesResult) {
		w, env := h.do(t, http.MethodPost, "/api/v1/claudex/web/github/pull/states", body, 7)
		var out PullStatesResult
		if w.Code == http.StatusOK {
			require.NoError(t, json.Unmarshal(env.Data, &out))
		}
		return w.Code, out
	}

	f.repo = openPullRepo()
	setPull(f.repo, "reviewDecision", "REVIEW_REQUIRED")
	code, out := post(`{"pulls":[{"repo":"octo/hello","number":7},{"repo":"octo/hello","number":8},{"repo":"Octo/Hello","number":7}]}`)
	require.Equal(t, http.StatusOK, code)
	// Number 8 does not exist; the repeated request is asked once.
	require.Equal(t, []PullState{{Repository: "octo/hello", Number: 7, State: "open", Review: "review_required", AwaitsReview: true}}, out.States)
	require.Len(t, f.graphql, 2)
	require.Equal(t, pullBriefQuery, f.graphql[0]["_query"])

	f.repo = openPullRepo()
	_, out = post(`{"pulls":[{"repo":"octo/hello","number":7}]}`)
	require.Equal(t, "approved", out.States[0].Review)
	require.False(t, out.States[0].AwaitsReview)

	f.repo = openPullRepo()
	setPull(f.repo, "isDraft", true)
	setPull(f.repo, "reviewDecision", nil)
	_, out = post(`{"pulls":[{"repo":"octo/hello","number":7}]}`)
	require.Equal(t, PullState{Repository: "octo/hello", Number: 7, State: "draft"}, out.States[0])

	// An empty list is an empty answer, not an error.
	code, out = post(`{"pulls":[]}`)
	require.Equal(t, http.StatusOK, code)
	require.Empty(t, out.States)
}

func TestPullStatesRefuseBadInput(t *testing.T) {
	h, _ := newWorkHarness(t)
	for _, body := range []string{
		`{"pulls":[{"repo":"octo","number":7}]}`,
		`{"pulls":[{"repo":"octo/hello","number":0}]}`,
		`{"pulls":[{"repo":"../x/y","number":1}]}`,
		`not json`,
	} {
		w, _ := h.do(t, http.MethodPost, "/api/v1/claudex/web/github/pull/states", body, 7)
		require.Equal(t, http.StatusBadRequest, w.Code, body)
	}
	many := `{"pulls":[`
	for i := 1; i <= maxPullStates+1; i++ {
		if i > 1 {
			many += ","
		}
		many += `{"repo":"octo/hello","number":` + strconv.Itoa(i) + `}`
	}
	many += `]}`
	w, _ := h.do(t, http.MethodPost, "/api/v1/claudex/web/github/pull/states", many, 7)
	require.Equal(t, http.StatusBadRequest, w.Code)

	// Signed out.
	w, _ = h.do(t, http.MethodPost, "/api/v1/claudex/web/github/pull/states", `{"pulls":[]}`, 0)
	require.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestPullStatesNeedAGitHubConnection(t *testing.T) {
	h := newHarness(t)
	h.configure(t)
	w, _ := h.do(t, http.MethodPost, "/api/v1/claudex/web/github/pull/states", `{"pulls":[{"repo":"octo/hello","number":7}]}`, 8)
	require.Equal(t, http.StatusConflict, w.Code)
}
