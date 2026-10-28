package gatewayhook

import (
	"net/http"
	"strings"

	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
)

// nonBillableRoutes lists the gateway routes (method + route template) that
// never consume usage: token counting, usage and billing introspection, model
// lists, and reads, cancellations or deletions of image, video and Seedance
// tasks. Everything else, of any method, is billable, including the
// Responses WebSocket and realtime upgrades; a route added upstream is
// billable until it is listed here.
var nonBillableRoutes = map[string]bool{}

func init() {
	add := func(method string, paths ...string) {
		for _, p := range paths {
			nonBillableRoutes[method+" "+p] = true
		}
	}
	for _, prefix := range []string{"/v1", "", "/antigravity/v1"} {
		add(http.MethodPost, prefix+"/messages/count_tokens")
		add(http.MethodGet, prefix+"/models", prefix+"/models/:model")
	}
	add(http.MethodGet, "/v1/usage", "/v1/sub2api/billing", "/antigravity/v1/usage", "/antigravity/models")
	add(http.MethodGet, "/backend-api/codex/models")
	for _, prefix := range []string{"/v1beta", "/antigravity/v1beta"} {
		add(http.MethodGet, prefix+"/models", prefix+"/models/:model")
	}
	// Async image tasks and batches.
	for _, prefix := range []string{"/v1", ""} {
		add(http.MethodGet, prefix+"/images/tasks/:task_id")
	}
	add(http.MethodGet,
		"/v1/images/batches", "/v1/images/batches/models", "/v1/images/batches/:id",
		"/v1/images/batches/:id/items", "/v1/images/batches/:id/items/:custom_id/content",
		"/v1/images/batches/:id/download")
	add(http.MethodPost, "/v1/images/batches/:id/cancel")
	add(http.MethodDelete, "/v1/images/batches/:id", "/v1/images/batches/:id/outputs")
	// Video task status and content.
	for _, prefix := range []string{"/v1", ""} {
		add(http.MethodGet,
			prefix+"/videos/:request_id", prefix+"/videos/:request_id/content",
			prefix+"/videos/generations/:request_id", prefix+"/videos/generations/:request_id/content",
			prefix+"/videos/edits/:request_id", prefix+"/videos/edits/:request_id/content",
			prefix+"/videos/extensions/:request_id", prefix+"/videos/extensions/:request_id/content")
	}
	// Seedance content-generation task status and cancellation.
	for _, prefix := range []string{"/api/v3", "/v3", "/v1", ""} {
		add(http.MethodGet, prefix+"/contents/generations/tasks/:task_id")
		add(http.MethodDelete, prefix+"/contents/generations/tasks/:task_id")
	}
}

// IsBillableRequest reports whether the usage rules (B5) must check this
// request. Non-billable: the routes in nonBillableRoutes, the Responses
// input_tokens subpath, and the Gemini countTokens action.
func IsBillableRequest(c *gin.Context) bool {
	if c == nil || c.Request == nil {
		return true
	}
	route := c.FullPath()
	if nonBillableRoutes[c.Request.Method+" "+route] {
		return false
	}
	if c.Request.Method == http.MethodPost && strings.HasSuffix(route, "/responses/*subpath") &&
		service.IsOpenAIResponsesInputTokensRequestPath(c) {
		return false
	}
	if c.Request.Method == http.MethodPost && strings.HasSuffix(route, "/models/*modelAction") {
		action := strings.TrimSpace(c.Param("modelAction"))
		if idx := strings.LastIndex(action, ":"); idx >= 0 && strings.EqualFold(action[idx+1:], "countTokens") {
			return false
		}
	}
	return true
}
