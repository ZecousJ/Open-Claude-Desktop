package ghconn

import (
	"context"
	"encoding/json"
	"net/http"

	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
)

func (c *Component) serveHostedPullStatus(ctx context.Context, userID int64, token, owner, name string, req apiRequest) (any, error) {
	if req.Number <= 0 {
		return nil, infraerrors.BadRequest(ReasonBadRepo, "Name a pull request number.")
	}
	const query = `query($owner: String!, $name: String!, $number: Int!, $ci: Boolean!, $review: Boolean!) {
 repository(owner: $owner, name: $name) { pullRequest(number: $number) {
 headRefOid
 reviewDecision @include(if: $review)
 autoMergeRequest { enabledAt }
 commits(last: 1) @include(if: $ci) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
 __typename
 ... on CheckRun { name status conclusion }
 ... on StatusContext { context state }
 } } } } } }
 } }
}`
	var answer struct {
		Data struct {
			Repository struct {
				PullRequest json.RawMessage `json:"pullRequest"`
			} `json:"repository"`
		} `json:"data"`
		Errors []json.RawMessage `json:"errors"`
	}
	variables := map[string]any{
		"owner": owner, "name": name, "number": req.Number,
		"ci": req.IncludeCIStatus, "review": req.IncludeReviewDecision,
	}
	if err := c.gh.send(ctx, token, http.MethodPost, "/graphql", map[string]any{
		"query": query, "variables": variables,
	}, &answer); err != nil {
		return nil, c.mapUpstream(ctx, userID, err)
	}
	if len(answer.Errors) > 0 || len(answer.Data.Repository.PullRequest) == 0 {
		return nil, errUnavailable
	}
	return answer.Data.Repository.PullRequest, nil
}
