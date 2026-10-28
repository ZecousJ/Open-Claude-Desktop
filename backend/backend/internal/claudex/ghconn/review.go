package ghconn

import (
	"context"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
)

var reviewSHA = regexp.MustCompile(`^[a-fA-F0-9]{40,64}$`)
var reviewNodeID = regexp.MustCompile(`^[A-Za-z0-9_=-]{4,200}$`)

func (c *Component) serveAutoFixFacts(ctx context.Context, userID int64, token, owner, name string, number int) (any, error) {
	if number <= 0 {
		return nil, infraerrors.BadRequest(ReasonBadRepo, "The GitHub request is not valid.")
	}
	const query = `query($owner: String!, $name: String!, $number: Int!) {
 repository(owner: $owner, name: $name) { pullRequest(number: $number) {
 state headRefOid
 commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
 __typename ... on CheckRun { name conclusion } ... on StatusContext { context state }
 } } } } } }
 reviewThreads(first: 100) { nodes { isResolved comments(last: 20) { nodes {
 databaseId viewerDidAuthor body path line originalLine author { login }
 } } } }
 } } }`
	var response struct {
		Data struct {
			Repository struct {
				PullRequest map[string]any `json:"pullRequest"`
			} `json:"repository"`
		} `json:"data"`
		Errors []any `json:"errors"`
	}
	if err := c.gh.send(ctx, token, http.MethodPost, "/graphql", map[string]any{"query": query, "variables": map[string]any{"owner": owner, "name": name, "number": number}}, &response); err != nil {
		return nil, c.mapUpstream(ctx, userID, err)
	}
	if len(response.Errors) > 0 {
		return nil, errUnavailable
	}
	return map[string]any{"pullRequest": response.Data.Repository.PullRequest}, nil
}

const reviewThreadsQuery = `query($owner: String!, $name: String!, $number: Int!) {
 repository(owner: $owner, name: $name) { pullRequest(number: $number) {
 reviewThreads(first: 100) { nodes {
 id isResolved isOutdated path line startLine viewerCanReply viewerCanResolve
 comments(first: 50) { nodes { id databaseId body url diffHunk author { login avatarUrl } } }
 } } } } }`

func (c *Component) serveReviewThreads(ctx context.Context, userID int64, token, base string, req apiRequest) (any, error) {
	parts := strings.Split(strings.TrimPrefix(base, "/repos/"), "/")
	if len(parts) != 2 {
		return nil, infraerrors.BadRequest(ReasonBadRepo, "The GitHub request is not valid.")
	}
	var response struct {
		Data struct {
			Repository struct {
				PullRequest struct {
					ReviewThreads struct {
						Nodes []struct {
							ID               string `json:"id"`
							IsResolved       bool   `json:"isResolved"`
							IsOutdated       bool   `json:"isOutdated"`
							Path             string `json:"path"`
							Line             *int   `json:"line"`
							StartLine        *int   `json:"startLine"`
							ViewerCanReply   bool   `json:"viewerCanReply"`
							ViewerCanResolve bool   `json:"viewerCanResolve"`
							Comments         struct {
								Nodes []struct {
									ID         string `json:"id"`
									DatabaseID int    `json:"databaseId"`
									Body       string `json:"body"`
									URL        string `json:"url"`
									DiffHunk   string `json:"diffHunk"`
									Author     struct {
										Login     string `json:"login"`
										AvatarURL string `json:"avatarUrl"`
									} `json:"author"`
								} `json:"nodes"`
							} `json:"comments"`
						} `json:"nodes"`
					} `json:"reviewThreads"`
				} `json:"pullRequest"`
			} `json:"repository"`
		} `json:"data"`
		Errors []any `json:"errors"`
	}
	if err := c.gh.send(ctx, token, http.MethodPost, "/graphql", map[string]any{"query": reviewThreadsQuery, "variables": map[string]any{"owner": parts[0], "name": parts[1], "number": req.Number}}, &response); err != nil {
		return nil, c.mapUpstream(ctx, userID, err)
	}
	if len(response.Errors) > 0 {
		return nil, errUnavailable
	}
	threads := []map[string]any{}
	found := false
	for _, thread := range response.Data.Repository.PullRequest.ReviewThreads.Nodes {
		if thread.ID == req.ThreadID {
			found = true
		}
		comments := []map[string]any{}
		for _, comment := range thread.Comments.Nodes {
			comments = append(comments, map[string]any{"id": comment.ID, "databaseId": comment.DatabaseID, "body": comment.Body, "url": comment.URL, "diffHunk": comment.DiffHunk, "author": comment.Author.Login, "avatarUrl": comment.Author.AvatarURL})
		}
		if len(comments) == 0 {
			continue
		}
		row := map[string]any{"id": thread.ID, "resolved": thread.IsResolved, "outdated": thread.IsOutdated || thread.Line == nil, "path": thread.Path, "viewerCanReply": thread.ViewerCanReply, "viewerCanResolve": thread.ViewerCanResolve, "comments": comments}
		if thread.Line != nil {
			row["line"] = *thread.Line
		}
		if thread.StartLine != nil {
			row["startLine"] = *thread.StartLine
		}
		threads = append(threads, row)
	}
	if req.Action == "pr.threads" {
		return map[string]any{"threads": threads}, nil
	}
	if !found || !reviewNodeID.MatchString(req.ThreadID) || (req.Action == "pr.threadReply" && strings.TrimSpace(req.Body) == "") {
		return nil, infraerrors.BadRequest(ReasonBadRepo, "The GitHub request is not valid.")
	}
	query := `mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { isResolved } } }`
	variables := map[string]any{"id": req.ThreadID}
	if req.Action == "pr.threadReply" {
		query = `mutation($id: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) { comment { id } } }`
		variables["body"] = req.Body
	}
	var result struct {
		Errors []any `json:"errors"`
	}
	if err := c.gh.send(ctx, token, http.MethodPost, "/graphql", map[string]any{"query": query, "variables": variables}, &result); err != nil {
		return nil, c.mapUpstream(ctx, userID, err)
	}
	if len(result.Errors) > 0 {
		return nil, errUnavailable
	}
	return map[string]any{}, nil
}

// The runner uses the account's connection; GitHub credentials stay here.
func (c *Component) serveReview(ctx context.Context, userID int64, token, base string, req apiRequest) (any, error) {
	invalid := func() (any, error) {
		return nil, infraerrors.BadRequest(ReasonBadRepo, "The GitHub request is not valid.")
	}
	if req.Number <= 0 {
		return invalid()
	}
	if req.Action == "pr.threads" || req.Action == "pr.resolve" || req.Action == "pr.threadReply" {
		return c.serveReviewThreads(ctx, userID, token, base, req)
	}
	pull := base + "/pulls/" + strconv.Itoa(req.Number)
	readRows := func(endpoint string) ([]map[string]any, error) {
		var rows []map[string]any
		for page := 1; page <= 100; page++ {
			var batch []map[string]any
			if err := c.gh.get(ctx, token, endpoint, url.Values{"per_page": {"100"}, "page": {strconv.Itoa(page)}}, &batch); err != nil {
				return nil, c.mapUpstream(ctx, userID, err)
			}
			rows = append(rows, batch...)
			if len(batch) < 100 {
				if rows == nil {
					rows = []map[string]any{}
				}
				return rows, nil
			}
		}
		return nil, infraerrors.BadRequest(ReasonBadRepo, "The GitHub response is too large.")
	}
	readChecks := func() ([]map[string]any, error) {
		var pr struct {
			Head struct {
				SHA string `json:"sha"`
			} `json:"head"`
		}
		if err := c.gh.get(ctx, token, pull, nil, &pr); err != nil {
			return nil, c.mapUpstream(ctx, userID, err)
		}
		if !reviewSHA.MatchString(pr.Head.SHA) {
			return nil, infraerrors.BadRequest(ReasonBadRepo, "Invalid pull request head.")
		}
		checks := []map[string]any{}
		for page := 1; page <= 100; page++ {
			var response struct {
				CheckRuns []map[string]any `json:"check_runs"`
			}
			if err := c.gh.get(ctx, token, base+"/commits/"+pr.Head.SHA+"/check-runs", url.Values{"per_page": {"100"}, "page": {strconv.Itoa(page)}}, &response); err != nil {
				return nil, c.mapUpstream(ctx, userID, err)
			}
			checks = append(checks, response.CheckRuns...)
			if len(response.CheckRuns) < 100 {
				return checks, nil
			}
		}
		return nil, infraerrors.BadRequest(ReasonBadRepo, "The GitHub response is too large.")
	}
	var endpoint string
	var payload map[string]any
	switch req.Action {
	case "pr.files", "pr.timeline", "pr.comments":
		key := strings.TrimPrefix(req.Action, "pr.")
		endpoint = pull + "/" + key
		if key == "timeline" {
			endpoint = base + "/issues/" + strconv.Itoa(req.Number) + "/timeline"
		}
		rows, err := readRows(endpoint)
		return map[string]any{key: rows}, err
	case "pr.checks", "pr.annotations", "pr.rerun":
		checks, err := readChecks()
		if err != nil {
			return nil, err
		}
		if req.Action == "pr.checks" {
			return map[string]any{"checks": checks}, nil
		}
		found := false
		for _, check := range checks {
			if value, ok := check["id"].(float64); ok && req.CheckRunID > 0 && value == float64(req.CheckRunID) {
				found = true
			}
		}
		if !found {
			return nil, infraerrors.BadRequest(ReasonBadRepo, "Check is not part of this PR.")
		}
		endpoint = base + "/check-runs/" + strconv.Itoa(req.CheckRunID)
		if req.Action == "pr.annotations" {
			rows, err := readRows(endpoint + "/annotations")
			return map[string]any{"annotations": rows}, err
		}
		endpoint += "/rerequest"
	case "pr.comment":
		if !reviewSHA.MatchString(req.CommitSHA) || req.Path == "" || len(req.Path) > 4096 || req.Line <= 0 || req.StartLine < 0 || req.StartLine > req.Line || strings.TrimSpace(req.Body) == "" {
			return invalid()
		}
		if req.Side == "" {
			req.Side = "RIGHT"
		}
		if req.Side != "RIGHT" && req.Side != "LEFT" {
			return invalid()
		}
		endpoint = pull + "/comments"
		payload = map[string]any{"commit_id": req.CommitSHA, "path": req.Path, "line": req.Line, "body": req.Body, "side": req.Side}
		if req.StartLine > 0 {
			payload["start_line"] = req.StartLine
			payload["start_side"] = req.Side
		}
	case "pr.reply":
		if req.CommentID <= 0 || strings.TrimSpace(req.Body) == "" {
			return invalid()
		}
		endpoint = pull + "/comments/" + strconv.Itoa(req.CommentID) + "/replies"
		payload = map[string]any{"body": req.Body}
	case "pr.review":
		if req.Event != "COMMENT" && req.Event != "APPROVE" && req.Event != "REQUEST_CHANGES" {
			return invalid()
		}
		if req.Event != "APPROVE" && strings.TrimSpace(req.Body) == "" {
			return invalid()
		}
		endpoint = pull + "/reviews"
		payload = map[string]any{"event": req.Event}
		if req.Body != "" {
			payload["body"] = req.Body
		}
	default:
		return invalid()
	}
	var out map[string]any
	if err := c.gh.send(ctx, token, http.MethodPost, endpoint, payload, &out); err != nil {
		return nil, c.mapUpstream(ctx, userID, err)
	}
	return map[string]any{}, nil
}
