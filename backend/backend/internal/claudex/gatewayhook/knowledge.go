package gatewayhook

import (
	"net/http"
	"sync/atomic"

	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
)

// KnowledgeRelay serves the knowledge-base MCP route for an authenticated
// key (internal/claudex/knowledge).
type KnowledgeRelay func(c *gin.Context, apiKey *service.APIKey)

var knowledgeRelay atomic.Pointer[KnowledgeRelay]

// KnowledgeRoute is the gateway route of the knowledge-base MCP relay; it is
// not billed (a search draws no model usage).
const KnowledgeRoute = "/v1/claudex/knowledge/:base/mcp"

// RegisterKnowledgeRelay installs the relay (the knowledge component's
// constructor; Reset removes it).
func RegisterKnowledgeRelay(f KnowledgeRelay) { knowledgeRelay.Store(&f) }

// ServeKnowledge answers the knowledge route: the relay, or 404 when no
// knowledge component is installed.
func ServeKnowledge(c *gin.Context, apiKey *service.APIKey) {
	if f := knowledgeRelay.Load(); f != nil && *f != nil {
		(*f)(c, apiKey)
		return
	}
	c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": gin.H{"code": "KNOWLEDGE_NOT_FOUND", "message": "Knowledge bases are not offered."}})
}
