package ghconn

// Claudex: the pull request of a Code session's branch row and the changes
// the row makes to it (live claude.ai bundle, 2026-10-12): merge, auto-merge
// on and off, ready for review and back to draft. One GraphQL read answers
// what the row shows (the lifecycle, the review decision, conflicts, the
// merge queue, the head commit's checks, and what a merge may do); a merge
// is REST's PUT .../merge with the head commit the person saw, the others
// are GitHub's GraphQL mutations. All with the user's own connection; the
// token never leaves the service.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"

	"github.com/gin-gonic/gin"
)

// RoutePullAction changes a pull request (POST, JSON body).
const RoutePullAction = "/web/github/pull/action"

const pullQuery = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    viewerPermission
    autoMergeAllowed
    mergeCommitAllowed
    squashMergeAllowed
    rebaseMergeAllowed
    viewerDefaultMergeMethod
    pullRequest(number: $number) {
      id number url title body state isDraft merged
      mergeable mergeStateStatus reviewDecision
      isInMergeQueue isMergeQueueEnabled
      additions deletions baseRefName headRefName headRefOid
      autoMergeRequest { enabledAt }
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { status conclusion }
        ... on StatusContext { state }
      } } } } } }
    }
  }
}`

// CheckCounts is each check of the head commit counted by state.
type CheckCounts struct {
	Passed  int `json:"passed"`
	Failed  int `json:"failed"`
	Pending int `json:"pending"`
	Skipped int `json:"skipped"`
}

// PullRequest is the state of a pull request for the session's branch row.
type PullRequest struct {
	Number     int    `json:"number"`
	URL        string `json:"url"`
	Repository string `json:"repository"`
	Title      string `json:"title"`
	Body       string `json:"body"`
	// State is open, draft, queued, merged or closed.
	State string `json:"state"`
	// Checks is passed, failed, pending, skipped or none.
	Checks      string       `json:"checks"`
	CheckCounts *CheckCounts `json:"check_counts,omitempty"`
	BaseRef     string       `json:"base_ref"`
	HeadRef     string       `json:"head_ref"`
	HeadSHA     string       `json:"head_sha,omitempty"`
	// Review is approved, changes_requested or review_required.
	Review      string `json:"review,omitempty"`
	Conflicting bool   `json:"conflicting"`
	// MergeState is GitHub's mergeStateStatus in lower case.
	MergeState       string `json:"merge_state,omitempty"`
	AutoMerge        bool   `json:"auto_merge"`
	MergeQueue       bool   `json:"merge_queue"`
	AutoMergeAllowed bool   `json:"auto_merge_allowed"`
	// MergeMethod is the method a merge uses: merge, squash or rebase.
	MergeMethod string `json:"merge_method"`
	CanMerge    bool   `json:"can_merge"`
	Additions   int    `json:"additions"`
	Deletions   int    `json:"deletions"`
}

type checkContext struct {
	Typename   string `json:"__typename"`
	Status     string `json:"status"`
	Conclusion string `json:"conclusion"`
	State      string `json:"state"`
}

type wirePull struct {
	ID                  string  `json:"id"`
	Number              int     `json:"number"`
	URL                 string  `json:"url"`
	Title               string  `json:"title"`
	Body                string  `json:"body"`
	State               string  `json:"state"`
	IsDraft             bool    `json:"isDraft"`
	Merged              bool    `json:"merged"`
	Mergeable           string  `json:"mergeable"`
	MergeStateStatus    string  `json:"mergeStateStatus"`
	ReviewDecision      *string `json:"reviewDecision"`
	IsInMergeQueue      bool    `json:"isInMergeQueue"`
	IsMergeQueueEnabled bool    `json:"isMergeQueueEnabled"`
	Additions           int     `json:"additions"`
	Deletions           int     `json:"deletions"`
	BaseRefName         string  `json:"baseRefName"`
	HeadRefName         string  `json:"headRefName"`
	HeadRefOid          string  `json:"headRefOid"`
	AutoMergeRequest    *struct {
		EnabledAt string `json:"enabledAt"`
	} `json:"autoMergeRequest"`
	Commits struct {
		Nodes []struct {
			Commit struct {
				StatusCheckRollup *struct {
					Contexts struct {
						Nodes []checkContext `json:"nodes"`
					} `json:"contexts"`
				} `json:"statusCheckRollup"`
			} `json:"commit"`
		} `json:"nodes"`
	} `json:"commits"`
}

type wirePullRepo struct {
	ViewerPermission         string    `json:"viewerPermission"`
	AutoMergeAllowed         bool      `json:"autoMergeAllowed"`
	MergeCommitAllowed       bool      `json:"mergeCommitAllowed"`
	SquashMergeAllowed       bool      `json:"squashMergeAllowed"`
	RebaseMergeAllowed       bool      `json:"rebaseMergeAllowed"`
	ViewerDefaultMergeMethod string    `json:"viewerDefaultMergeMethod"`
	PullRequest              *wirePull `json:"pullRequest"`
}

// graphqlAddress is GitHub's GraphQL endpoint beside the REST base:
// api.github.com/graphql, or /api/graphql on GitHub Enterprise.
func (c *client) graphqlAddress() string {
	if strings.HasSuffix(c.apiBase, "/api/v3") {
		return strings.TrimSuffix(c.apiBase, "/v3") + "/graphql"
	}
	return c.apiBase + "/graphql"
}

// graphql runs one query or mutation. GitHub answers 200 with errors for a
// refusal: NOT_FOUND is errNotFound, anything else errRefused with its words.
func (c *client) graphql(ctx context.Context, token, query string, vars map[string]any, out any) error {
	var resp struct {
		Data   json.RawMessage `json:"data"`
		Errors []struct {
			Type    string `json:"type"`
			Message string `json:"message"`
		} `json:"errors"`
	}
	payload := map[string]any{"query": query, "variables": vars}
	if err := c.sendTo(ctx, token, http.MethodPost, c.graphqlAddress(), payload, &resp); err != nil {
		return err
	}
	if len(resp.Errors) > 0 {
		if resp.Errors[0].Type == "NOT_FOUND" {
			return errNotFound
		}
		return errRefused{message: truncate(resp.Errors[0].Message, 500)}
	}
	if out != nil && len(resp.Data) > 0 {
		if err := json.Unmarshal(resp.Data, out); err != nil {
			return errUpstream{status: http.StatusOK}
		}
	}
	return nil
}

// readPull reads the pull request and its repository's merge settings.
func (c *client) readPull(ctx context.Context, token string, ref RepoRef, number int) (wirePullRepo, error) {
	var data struct {
		Repository *wirePullRepo `json:"repository"`
	}
	vars := map[string]any{"owner": ref.Owner, "name": ref.Name, "number": number}
	if err := c.graphql(ctx, token, pullQuery, vars, &data); err != nil {
		return wirePullRepo{}, err
	}
	if data.Repository == nil || data.Repository.PullRequest == nil {
		return wirePullRepo{}, errNotFound
	}
	return *data.Repository, nil
}

var failedConclusions = map[string]bool{
	"failure": true, "timed_out": true, "cancelled": true, "action_required": true,
	"startup_failure": true, "stale": true, "error": true,
}

// countChecks counts check runs by status and conclusion, and commit
// statuses by state.
func countChecks(nodes []checkContext) CheckCounts {
	var n CheckCounts
	for _, c := range nodes {
		if c.Typename == "StatusContext" {
			switch strings.ToLower(c.State) {
			case "success":
				n.Passed++
			case "pending", "expected":
				n.Pending++
			default:
				n.Failed++
			}
			continue
		}
		conclusion := strings.ToLower(c.Conclusion)
		switch {
		case !strings.EqualFold(c.Status, "completed"):
			n.Pending++
		case failedConclusions[conclusion]:
			n.Failed++
		case conclusion == "skipped":
			n.Skipped++
		default:
			n.Passed++
		}
	}
	return n
}

// checksOf is the CI dot: failing beats running beats passed; checks that
// were all skipped read as skipped; none at all is none.
func checksOf(n CheckCounts) string {
	switch {
	case n.Failed > 0:
		return "failed"
	case n.Pending > 0:
		return "pending"
	case n.Passed > 0:
		return "passed"
	case n.Skipped > 0:
		return "skipped"
	}
	return "none"
}

// mergeMethodOf is the account's default method when the repository
// allows it, else squash, merge, rebase in that order.
func mergeMethodOf(r wirePullRepo) string {
	allowed := map[string]bool{"squash": r.SquashMergeAllowed, "merge": r.MergeCommitAllowed, "rebase": r.RebaseMergeAllowed}
	if m := strings.ToLower(r.ViewerDefaultMergeMethod); allowed[m] {
		return m
	}
	for _, m := range []string{"squash", "merge", "rebase"} {
		if allowed[m] {
			return m
		}
	}
	return "squash"
}

// pullFrom is the branch row's pull request from the GraphQL answer.
func pullFrom(ref RepoRef, r wirePullRepo) PullRequest {
	w := r.PullRequest
	state := "open"
	switch {
	case w.Merged || w.State == "MERGED":
		state = "merged"
	case w.State == "CLOSED":
		state = "closed"
	case w.IsInMergeQueue:
		state = "queued"
	case w.IsDraft:
		state = "draft"
	}
	out := PullRequest{
		Number: w.Number, URL: w.URL, Repository: ref.FullName(), Title: w.Title, Body: w.Body,
		State: state, Checks: "none", BaseRef: w.BaseRefName, HeadRef: w.HeadRefName,
		MergeState:       strings.ToLower(w.MergeStateStatus),
		Conflicting:      w.Mergeable == "CONFLICTING" || strings.EqualFold(w.MergeStateStatus, "dirty"),
		AutoMerge:        w.AutoMergeRequest != nil,
		MergeQueue:       w.IsMergeQueueEnabled,
		AutoMergeAllowed: r.AutoMergeAllowed,
		MergeMethod:      mergeMethodOf(r),
		CanMerge:         r.ViewerPermission == "ADMIN" || r.ViewerPermission == "MAINTAIN" || r.ViewerPermission == "WRITE",
		Additions:        w.Additions,
		Deletions:        w.Deletions,
	}
	if commitSHA.MatchString(w.HeadRefOid) {
		out.HeadSHA = w.HeadRefOid
	}
	if w.ReviewDecision != nil {
		out.Review = strings.ToLower(*w.ReviewDecision)
	}
	// A request that is no longer open has no running checks to show.
	if state != "merged" && state != "closed" && len(w.Commits.Nodes) > 0 {
		var counts CheckCounts
		if rollup := w.Commits.Nodes[0].Commit.StatusCheckRollup; rollup != nil {
			counts = countChecks(rollup.Contexts.Nodes)
		}
		out.CheckCounts = &counts
		out.Checks = checksOf(counts)
	}
	return out
}

// getPull answers a pull request's state, reviews and checks.
func (c *Component) getPull(g *gin.Context) {
	uid, ok := c.userID(g)
	if !ok {
		return
	}
	ref, ok := repoParam(g)
	if !ok {
		return
	}
	number, ok := numberParam(g)
	if !ok {
		return
	}
	ctx := g.Request.Context()
	token, err := c.accessToken(ctx, uid)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	repo, err := c.gh.readPull(ctx, token, ref, number)
	if err != nil {
		response.ErrorFrom(g, c.mapUpstream(ctx, uid, err))
		return
	}
	response.Success(g, pullFrom(ref, repo))
}

// pullActionRequest is the body of POST .../web/github/pull/action.
type pullActionRequest struct {
	Repo        string `json:"repo"`
	Number      int    `json:"number"`
	Action      string `json:"action"`
	HeadSHA     string `json:"head_sha"`
	MergeMethod string `json:"merge_method"`
}

// PullActionResult is the answer of a change: ok, or why GitHub refused.
type PullActionResult struct {
	OK     bool   `json:"ok"`
	Queued bool   `json:"queued,omitempty"`
	Reason string `json:"reason,omitempty"`
	Detail string `json:"detail,omitempty"`
}

// actionReasons name GitHub's refusals by their words, in the order the
// window checks them (shared/pull-request-status.ts).
var actionReasons = []struct {
	reason  string
	pattern *regexp.Regexp
}{
	{"rate_limited", regexp.MustCompile(`(?i)rate limit|abuse detection`)},
	{"pr_closed", regexp.MustCompile(`(?i)is already merged|Pull request is closed`)},
	{"repo_disallows_auto_merge", regexp.MustCompile(`(?i)auto[- ]?merge is not allowed for this repository|Check that "Allow auto-merge" is enabled`)},
	{"already_mergeable", regexp.MustCompile(`(?i)clean status|unstable status`)},
	{"merge_method_not_allowed", regexp.MustCompile(`(?i)merge method .*not allowed`)},
	{"no_branch_protection", regexp.MustCompile(`(?i)protected branch rules not configured|does not have required protected branch rules`)},
	{"stacked_pr", regexp.MustCompile(`(?i)stacked pull request`)},
	{"no_permission", regexp.MustCompile(`(?i)does not have the correct permissions to execute|not authorized for this protected branch|Resource not accessible|must have (push|write|admin) access`)},
	{"workflow_scope", regexp.MustCompile("(?i)without `?workflow`? scope")},
	{"head_moved", regexp.MustCompile(`(?i)Head branch was modified|head commit .* does not match`)},
	{"not_found", regexp.MustCompile(`(?i)Pull request (#\d+ )?not found|Could not resolve to a`)},
	{"already_in_state", regexp.MustCompile(`(?i)already enabled|already disabled|Auto merge is not enabled|may not currently be enabled|is already "ready for review"|already a draft`)},
}

func actionReason(message string) string {
	for _, r := range actionReasons {
		if r.pattern.MatchString(message) {
			return r.reason
		}
	}
	return "unknown"
}

const (
	enableAutoMerge  = `mutation($id: ID!, $method: PullRequestMergeMethod!) { enablePullRequestAutoMerge(input: {pullRequestId: $id, mergeMethod: $method}) { clientMutationId } }`
	disableAutoMerge = `mutation($id: ID!) { disablePullRequestAutoMerge(input: {pullRequestId: $id}) { clientMutationId } }`
	markReady        = `mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { clientMutationId } }`
	convertToDraft   = `mutation($id: ID!) { convertPullRequestToDraft(input: {pullRequestId: $id}) { clientMutationId } }`
)

// changePull makes one change on GitHub.
func (c *client) changePull(ctx context.Context, token string, ref RepoRef, req pullActionRequest) (PullActionResult, error) {
	method := req.MergeMethod
	if method != "merge" && method != "rebase" {
		method = "squash"
	}
	if req.Action == "merge" {
		body := map[string]any{"merge_method": method}
		if req.HeadSHA != "" {
			body["sha"] = req.HeadSHA
		}
		var out struct {
			Merged bool `json:"merged"`
		}
		path := repoPath(ref) + "/pulls/" + strconv.Itoa(req.Number) + "/merge"
		if err := c.send(ctx, token, http.MethodPut, path, body, &out); err != nil {
			return PullActionResult{}, err
		}
		return PullActionResult{OK: true}, nil
	}
	repo, err := c.readPull(ctx, token, ref, req.Number)
	if err != nil {
		return PullActionResult{}, err
	}
	vars := map[string]any{"id": repo.PullRequest.ID}
	var mutation string
	switch req.Action {
	case "autoMergeOn":
		mutation = enableAutoMerge
		vars["method"] = strings.ToUpper(method)
	case "autoMergeOff":
		mutation = disableAutoMerge
	case "ready":
		mutation = markReady
	case "draft":
		mutation = convertToDraft
	}
	if err := c.graphql(ctx, token, mutation, vars, nil); err != nil {
		return PullActionResult{}, err
	}
	return PullActionResult{OK: true}, nil
}

var pullActionNames = map[string]bool{"merge": true, "autoMergeOn": true, "autoMergeOff": true, "ready": true, "draft": true}

// postPullAction changes a pull request from the branch row. GitHub's
// refusals answer 200 with the reason; a missing connection or a request
// this account can't see is an error as for the reads.
func (c *Component) postPullAction(g *gin.Context) {
	uid, ok := c.userID(g)
	if !ok {
		return
	}
	var req pullActionRequest
	if err := g.ShouldBindJSON(&req); err != nil || !pullActionNames[req.Action] ||
		req.Number < 1 || req.Number > 999_999_999 || (req.HeadSHA != "" && !commitSHA.MatchString(req.HeadSHA)) {
		response.ErrorFrom(g, infraerrors.BadRequest(ReasonBadRepo, "The pull request change is not valid."))
		return
	}
	parts := strings.Split(req.Repo, "/")
	if len(parts) != 2 || !validOwner(parts[0]) || !validName(parts[1]) {
		response.ErrorFrom(g, infraerrors.BadRequest(ReasonBadRepo, "repo must be owner/name"))
		return
	}
	ref := RepoRef{Owner: parts[0], Name: parts[1]}
	ctx := g.Request.Context()
	token, err := c.accessToken(ctx, uid)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	out, err := c.gh.changePull(ctx, token, ref, req)
	var refused errRefused
	var upstream errUpstream
	switch {
	case err == nil:
		response.Success(g, out)
	case asRefused(err, &refused):
		reason := actionReason(refused.message)
		res := PullActionResult{Reason: reason}
		if reason == "unknown" {
			res.Detail = truncate(refused.message, 200)
		}
		response.Success(g, res)
	case errors.As(err, &upstream) && upstream.status == 0:
		response.Success(g, PullActionResult{Reason: "network"})
	default:
		response.ErrorFrom(g, c.mapUpstream(ctx, uid, err))
	}
}
