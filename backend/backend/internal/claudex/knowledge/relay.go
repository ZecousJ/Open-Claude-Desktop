package knowledge

import (
	"context"
	"io"
	"net/http"

	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
)

// Request and response headers the MCP streamable HTTP transport uses; the
// rest (the account's key, X-Claudex-*, cookies) stays here.
var (
	forwardRequest  = []string{"Content-Type", "Accept", "Mcp-Session-Id", "Mcp-Protocol-Version", "Last-Event-Id"}
	forwardResponse = []string{"Content-Type", "Mcp-Session-Id", "Mcp-Protocol-Version", "Cache-Control"}
)

func relayError(g *gin.Context, status int, code, message string) {
	g.AbortWithStatusJSON(status, gin.H{"error": gin.H{"code": code, "message": message}})
}

// relay serves /v1/claudex/knowledge/:base/mcp for an authenticated key: the
// MCP request goes to the base's server with the base's own key, and the
// answer (JSON or an event stream) comes back as it is written.
func (c *Component) relay(g *gin.Context, apiKey *service.APIKey) {
	if apiKey == nil {
		relayError(g, http.StatusUnauthorized, "UNAUTHORIZED", "An API key is required.")
		return
	}
	switch g.Request.Method {
	case http.MethodPost, http.MethodGet, http.MethodDelete:
	default:
		relayError(g, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Use POST, GET or DELETE.")
		return
	}
	base, ok := c.setting.Cached(g.Request.Context()).find(g.Param("base"))
	if !ok {
		relayError(g, http.StatusNotFound, "KNOWLEDGE_NOT_FOUND", "This knowledge base is not offered.")
		return
	}
	if !c.allow(apiKey.UserID) {
		relayError(g, http.StatusTooManyRequests, "KNOWLEDGE_RATE_LIMITED", "Too many knowledge-base requests; try again in a minute.")
		return
	}
	ctx, cancel := context.WithTimeout(g.Request.Context(), relayTimeout)
	defer cancel()
	var body io.Reader
	if g.Request.Method == http.MethodPost {
		body = http.MaxBytesReader(g.Writer, g.Request.Body, maxRequestBody)
	}
	req, err := http.NewRequestWithContext(ctx, g.Request.Method, base.MCPURL, body)
	if err != nil {
		relayError(g, http.StatusBadGateway, "KNOWLEDGE_UNAVAILABLE", "The knowledge base can't be reached.")
		return
	}
	for _, h := range forwardRequest {
		if v := g.GetHeader(h); v != "" {
			req.Header.Set(h, v)
		}
	}
	if base.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+base.APIKey)
	}
	res, err := c.client.Do(req)
	if err != nil {
		relayError(g, http.StatusBadGateway, "KNOWLEDGE_UNAVAILABLE", "The knowledge base can't be reached.")
		return
	}
	defer func() { _ = res.Body.Close() }()
	for _, h := range forwardResponse {
		if v := res.Header.Get(h); v != "" {
			g.Header(h, v)
		}
	}
	g.Status(res.StatusCode)
	flusher, _ := g.Writer.(http.Flusher)
	buf := make([]byte, 32<<10)
	for {
		n, readErr := res.Body.Read(buf)
		if n > 0 {
			if _, err := g.Writer.Write(buf[:n]); err != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if readErr != nil {
			return
		}
	}
}
