package gatewayhook

import (
	"log/slog"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// PreAuth runs for one gateway route before API-key authentication (H6,
// inside BodyLimits). It may rewrite the request, for example turn a
// one-time web ticket into the credentials the API-key middleware reads, so
// every later check and the billing run exactly as for any other key.
// Returning true means it wrote a response and the request must stop.
type PreAuth func(c *gin.Context) (abort bool)

// RegisterPreAuth sets the PreAuth step of one gateway route template
// (c.FullPath(), e.g. "/v1/audio/realtime/transcriptions"); a later call for
// the same path replaces it.
func RegisterPreAuth(path string, step PreAuth) {
	path = strings.TrimSpace(path)
	if path == "" || step == nil {
		return
	}
	update(func(r *registry) { r.preAuth[path] = step })
}

// runPreAuth runs the route's PreAuth step (if any) and continues the chain
// unless it aborted. A panicking step, or one that asks to stop without an
// answer, fails closed with 500.
func runPreAuth(c *gin.Context, reg *registry) {
	step, ok := reg.preAuth[c.FullPath()]
	if !ok {
		c.Next()
		return
	}
	if runPreAuthStep(c, step) {
		if !c.IsAborted() {
			c.AbortWithStatus(http.StatusInternalServerError)
		}
		return
	}
	c.Next()
}

func runPreAuthStep(c *gin.Context, step PreAuth) (abort bool) {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("claudex gateway: pre-auth step panicked", "path", c.FullPath(), "panic", r)
			abort = true
		}
	}()
	return step(c)
}
