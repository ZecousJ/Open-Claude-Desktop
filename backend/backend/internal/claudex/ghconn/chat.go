package ghconn

import (
	"encoding/json"
	"strings"

	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/gin-gonic/gin"
)

// Chat reads linked repositories on demand (live claude.ai bundle,
// 2026-10-14, c72f14f34-DDGz-5eN.js). The desktop never receives a token.
func (c *Component) readRepository(g *gin.Context) {
	uid, ok := c.userID(g)
	if !ok {
		return
	}
	var req struct {
		Repository string `json:"repository"`
		Branch     string `json:"branch"`
		Path       string `json:"path"`
	}
	if err := g.ShouldBindJSON(&req); err != nil {
		response.ErrorFrom(g, infraerrors.BadRequest(ReasonBadRepo, "The GitHub request is not valid."))
		return
	}
	parts := strings.Split(req.Repository, "/")
	if len(parts) != 2 || !validOwner(parts[0]) || !validName(parts[1]) {
		response.ErrorFrom(g, infraerrors.BadRequest(ReasonBadRepo, "The GitHub request is not valid."))
		return
	}
	action := "repository.tree"
	if req.Path != "" {
		action = "repository.file"
	}
	input := apiRequest{URL: c.webBaseURL() + "/" + req.Repository, Action: action, Branch: req.Branch, Path: req.Path}
	if _, _, err := repositoryReadEndpoint("", input); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	body, err := json.Marshal(input)
	if err != nil {
		response.ErrorFrom(g, errUnavailable)
		return
	}
	value, err := c.serveAPI(g.Request.Context(), uid, body)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	response.Success(g, value)
}
