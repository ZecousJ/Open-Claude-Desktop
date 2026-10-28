package ghconn

// Claudex: which sessions are ready for review. The live claude.ai session
// list puts a finished session in "Ready for review" when a pull request it
// made is open, not a draft and still waits for a reviewer (shared-18 `xt`
// counts `awaitsReview`); the phones list Code sessions without GitHub in
// their hands, so one call here answers many pull requests at once with that
// verdict, read with the user's own connection.

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"

	"github.com/gin-gonic/gin"
)

// RoutePullStates answers the review state of several pull requests (POST,
// JSON body).
const RoutePullStates = "/web/github/pull/states"

const (
	// maxPullStates is how many pull requests one call may ask about; a
	// phone lists at most this many sessions that made one.
	maxPullStates = 40
	// pullStateReaders is how many are read from GitHub at the same time.
	pullStateReaders = 4
)

// pullBriefQuery is the part of pullQuery the review verdict needs.
const pullBriefQuery = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { number state isDraft merged reviewDecision isInMergeQueue }
  }
}`

type pullStatesRequest struct {
	Pulls []struct {
		Repo   string `json:"repo"`
		Number int    `json:"number"`
	} `json:"pulls"`
}

// PullState is one pull request's review verdict.
type PullState struct {
	Repository string `json:"repository"`
	Number     int    `json:"number"`
	// State is open, draft, queued, merged or closed.
	State string `json:"state"`
	// Review is approved, changes_requested or review_required (empty: the
	// repository does not require reviews).
	Review string `json:"review,omitempty"`
	// AwaitsReview: open, not a draft or queued, and neither approved nor
	// sent back with changes requested.
	AwaitsReview bool `json:"awaits_review"`
}

// PullStatesResult is the answer of POST .../web/github/pull/states; a pull
// request GitHub could not answer for is left out.
type PullStatesResult struct {
	States []PullState `json:"states"`
}

// awaitsReview is the verdict from a pull request's state and review.
func awaitsReview(state, review string) bool {
	return state == "open" && review != "approved" && review != "changes_requested"
}

func (c *client) readPullBrief(ctx context.Context, token string, ref RepoRef, number int) (PullState, error) {
	var data struct {
		Repository *struct {
			PullRequest *wirePull `json:"pullRequest"`
		} `json:"repository"`
	}
	vars := map[string]any{"owner": ref.Owner, "name": ref.Name, "number": number}
	if err := c.graphql(ctx, token, pullBriefQuery, vars, &data); err != nil {
		return PullState{}, err
	}
	if data.Repository == nil || data.Repository.PullRequest == nil {
		return PullState{}, errNotFound
	}
	w := data.Repository.PullRequest
	state := pullFrom(ref, wirePullRepo{PullRequest: w}).State
	review := ""
	if w.ReviewDecision != nil {
		review = strings.ToLower(*w.ReviewDecision)
	}
	return PullState{Repository: ref.FullName(), Number: number, State: state, Review: review, AwaitsReview: awaitsReview(state, review)}, nil
}

// postPullStates reads the pull requests it is given, a few at a time. A
// missing connection is an error as for the other reads; one request that
// cannot be read (gone, private, rate limited) is just not in the answer.
func (c *Component) postPullStates(g *gin.Context) {
	uid, ok := c.userID(g)
	if !ok {
		return
	}
	var req pullStatesRequest
	if err := g.ShouldBindJSON(&req); err != nil || len(req.Pulls) > maxPullStates {
		response.ErrorFrom(g, infraerrors.BadRequest(ReasonBadRepo, "pulls must be a list of up to 40 pull requests"))
		return
	}
	type target struct {
		ref    RepoRef
		number int
	}
	seen := map[string]bool{}
	var targets []target
	for _, p := range req.Pulls {
		parts := strings.Split(p.Repo, "/")
		if len(parts) != 2 || !validOwner(parts[0]) || !validName(parts[1]) || p.Number < 1 || p.Number > 999_999_999 {
			response.ErrorFrom(g, infraerrors.BadRequest(ReasonBadRepo, "each pull request needs repo as owner/name and a number"))
			return
		}
		ref := RepoRef{Owner: parts[0], Name: parts[1]}
		key := strings.ToLower(ref.FullName()) + "#" + strconv.Itoa(p.Number)
		if seen[key] {
			continue
		}
		seen[key] = true
		targets = append(targets, target{ref, p.Number})
	}
	ctx, cancel := context.WithTimeout(g.Request.Context(), 25*time.Second)
	defer cancel()
	token, err := c.accessToken(ctx, uid)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	results := make([]*PullState, len(targets))
	var (
		wg      sync.WaitGroup
		slots   = make(chan struct{}, pullStateReaders)
		revoked atomic.Bool
	)
	for i, t := range targets {
		wg.Add(1)
		slots <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-slots }()
			state, err := c.gh.readPullBrief(ctx, token, t.ref, t.number)
			if err != nil {
				// A token GitHub refuses is the whole call's problem.
				if errors.Is(err, errRevoked) {
					revoked.Store(true)
				}
				return
			}
			results[i] = &state
		}()
	}
	wg.Wait()
	if revoked.Load() {
		response.ErrorFrom(g, c.mapUpstream(ctx, uid, errRevoked))
		return
	}
	out := PullStatesResult{States: []PullState{}}
	for _, r := range results {
		if r != nil {
			out.States = append(out.States, *r)
		}
	}
	g.Header("Cache-Control", "no-store")
	response.Success(g, out)
}
