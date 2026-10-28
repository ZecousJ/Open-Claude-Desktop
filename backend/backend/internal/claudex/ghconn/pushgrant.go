package ghconn

// Claudex: "Continue in cloud" on the desktop app (live claude.ai bundle,
// 2026-10-12: "Pushes {branch} to {repo}, then starts a cloud session on it").
// A local Code session's branch is pushed from the person's own computer
// with their GitHub connection, so the cloud session can clone it. The
// desktop's main process asks for a push credential the way a runner does
// ("github.push"): the same checks (a github.com repository the user's own
// token can push to) and the same short lease. The credential goes to the
// signed-in user's own app only; it reaches git through an askpass helper
// there and is dropped when the push ends (shared/git-lease.ts).

import (
	"encoding/json"
	"strings"
	"time"

	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"

	"github.com/gin-gonic/gin"
)

// RoutePushGrant is POST /api/v1/claudex/web/github/push-grant.
const RoutePushGrant = "/web/github/push-grant"

// pushGrantRequest is its body: the repository as "owner/name".
type pushGrantRequest struct {
	Repository string `json:"repository"`
}

func (c *Component) postPushGrant(g *gin.Context) {
	uid, ok := c.userID(g)
	if !ok {
		return
	}
	var req pushGrantRequest
	if err := g.ShouldBindJSON(&req); err != nil {
		response.ErrorFrom(g, infraerrors.BadRequest(ReasonBadRepo, "repository must be owner/name"))
		return
	}
	parts := strings.Split(req.Repository, "/")
	if len(parts) != 2 || !validOwner(parts[0]) || !validName(parts[1]) {
		response.ErrorFrom(g, infraerrors.BadRequest(ReasonBadRepo, "repository must be owner/name"))
		return
	}
	body, err := json.Marshal(cloneRequest{URL: c.webBaseURL() + "/" + parts[0] + "/" + parts[1]})
	if err != nil {
		response.ErrorFrom(g, errUnavailable)
		return
	}
	grant, err := c.servePush(g.Request.Context(), uid, body)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	response.Success(g, grant)
}

// registerPushGrant adds the route with its own rate limit (a person
// continues a session in the cloud now and then, not in a loop).
func (c *Component) registerPushGrant(g *gin.RouterGroup) {
	g.POST(RoutePushGrant, c.env.RateLimitPerUser("github-push-grant", 30, time.Minute), c.postPushGrant)
}
