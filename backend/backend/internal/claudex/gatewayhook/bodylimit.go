package gatewayhook

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

type bodyLimit struct {
	code  string
	limit func() int64
}

// RegisterBodyLimit sets a request body limit for one gateway route template
// (c.FullPath(), e.g. "/v1/audio/transcriptions"). The limit function is read
// on every request, so it may follow a setting; a value <= 0 disables the
// check. Oversized requests get 413 with code CLAUDEX_REQUEST_TOO_LARGE.
func RegisterBodyLimit(path string, limit func() int64) {
	RegisterBodyLimitCode(path, "CLAUDEX_REQUEST_TOO_LARGE", limit)
}

// RegisterBodyLimitCode is RegisterBodyLimit with the error code of the 413
// answer (B7 uses CLAUDEX_AUDIO_TOO_LARGE).
func RegisterBodyLimitCode(path, code string, limit func() int64) {
	path = strings.TrimSpace(path)
	if path == "" || limit == nil {
		return
	}
	if strings.TrimSpace(code) == "" {
		code = "CLAUDEX_REQUEST_TOO_LARGE"
	}
	update(func(r *registry) { r.bodyLimits[path] = bodyLimit{code: code, limit: limit} })
}

// BodyLimits is the H6 middleware that enforces the registered limits before
// API-key authentication and before any middleware reads the body: a declared
// Content-Length over the limit is refused at once with 413 (OpenAI error
// format), otherwise the body is wrapped in http.MaxBytesReader so a longer
// body fails when it is read. Routes without a registered limit pass through.
// It then runs the route's PreAuth step, if one is registered (preauth.go).
func BodyLimits() gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request == nil {
			c.Next()
			return
		}
		reg := snapshot()
		entry, ok := reg.bodyLimits[c.FullPath()]
		if !ok {
			runPreAuth(c, reg)
			return
		}
		limit := entry.limit()
		if limit <= 0 {
			runPreAuth(c, reg)
			return
		}
		if c.Request.ContentLength > limit {
			c.AbortWithStatusJSON(http.StatusRequestEntityTooLarge, gin.H{"error": gin.H{
				"type":    "invalid_request_error",
				"code":    entry.code,
				"message": "Request body is too large",
			}})
			return
		}
		if c.Request.Body != nil && c.Request.Body != http.NoBody {
			c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, limit)
		}
		runPreAuth(c, reg)
	}
}
