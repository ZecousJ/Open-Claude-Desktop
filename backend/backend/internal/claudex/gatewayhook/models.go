package gatewayhook

import (
	"io"
	"net/http"
	"strings"

	"github.com/Wei-Shaw/sub2api/internal/pkg/httputil"
	"github.com/Wei-Shaw/sub2api/internal/pkg/requestmodel"

	"github.com/gin-gonic/gin"
)

const ctxKeyRequestModels = "claudex.gateway.request_models"

// RequestModels returns every model name the request may be served as, the
// same candidates the upstream model allowlist checks: the route parameters
// model / modelAction (Gemini native routes, ":action" removed), then every
// "model" of the body (all duplicate keys and case variants, JSON or
// multipart, session.model for Live routes), then the "model" query parameter
// (Grok realtime). Names are deduplicated exactly (case kept). WebSocket
// upgrades have no body; their turns are checked through claudexhook
// (H14). The body is read within the gateway body limit and put back for the
// handlers; the result is cached on the request.
func RequestModels(c *gin.Context) []string {
	if c == nil {
		return nil
	}
	if v, ok := c.Get(ctxKeyRequestModels); ok {
		if models, ok := v.([]string); ok {
			return models
		}
	}
	models := collectRequestModels(c)
	c.Set(ctxKeyRequestModels, models)
	return models
}

func collectRequestModels(c *gin.Context) []string {
	var out []string
	seen := map[string]bool{}
	add := func(values ...string) {
		for _, v := range values {
			v = strings.TrimSpace(v)
			if v == "" || seen[v] {
				continue
			}
			seen[v] = true
			out = append(out, v)
		}
	}
	add(modelFromParams(c))
	if c.Request != nil {
		switch c.Request.Method {
		case http.MethodPost, http.MethodPut, http.MethodPatch:
			add(modelsFromBody(c)...)
		}
		if len(out) == 0 {
			add(c.Query("model"))
		}
	}
	return out
}

func modelFromParams(c *gin.Context) string {
	if model := strings.TrimSpace(c.Param("model")); model != "" {
		return model
	}
	modelAction := strings.TrimPrefix(strings.TrimSpace(c.Param("modelAction")), "/")
	if modelAction == "" {
		return ""
	}
	if idx := strings.LastIndex(modelAction, ":"); idx >= 0 {
		return strings.TrimSpace(modelAction[:idx])
	}
	return modelAction
}

// modelsFromBody reads the body like the allowlist middleware does
// (decompressed, put back as a pre-read body so later readers get the same
// bytes). When reading fails (for example over the body limit) the error is
// kept on the request so the handler reports it as it would have.
func modelsFromBody(c *gin.Context) []string {
	if c.Request.Body == nil || c.Request.Body == http.NoBody {
		return nil
	}
	body, err := httputil.ReadRequestBodyWithPrealloc(c.Request)
	if err != nil {
		c.Request.Body = errorBody{err: err}
		return nil
	}
	requestmodel.ResetRequestBody(c.Request, body)
	return requestmodel.FromBodyCandidates(c.FullPath(), c.GetHeader("Content-Type"), body)
}

// errorBody replays a body read error to the next reader.
type errorBody struct{ err error }

func (b errorBody) Read([]byte) (int, error) { return 0, b.err }
func (b errorBody) Close() error             { return nil }

var _ io.ReadCloser = errorBody{}
