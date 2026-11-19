package webhost

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
	"github.com/gin-gonic/gin"
)

const verifyDocumentPreviewTokenMethod = "verifyDocumentPreviewToken"

var documentPreviewTokenPattern = regexp.MustCompile(`^([1-9][0-9]{0,15})\.([0-9a-f]{64})$`)

type documentPreviewSessions interface {
	CheckWebCaller(context.Context, int64, string, time.Time) error
}

// The separate viewer host sends only the conversion credential. Keep the
// converter outside the runner link so document and PDF sizes are independent
// of the link's frame limit.
func (c *Component) verifyDocumentPreviewToken(g *gin.Context) {
	g.Header("Cache-Control", "no-store")
	token := documentPreviewTokenPattern.FindStringSubmatch(g.GetHeader("X-Convert-Pdf-Token"))
	if token == nil {
		g.Status(http.StatusUnauthorized)
		return
	}
	owner, _ := strconv.ParseInt(token[1], 10, 64)
	ctx := g.Request.Context()
	runner := c.reg.current(ctx, owner)
	if runner == nil || !runner.methods["officialUiRead"] || !c.gate.enter(owner) {
		g.Status(http.StatusUnauthorized)
		return
	}
	defer c.gate.leave(owner)
	arg, _ := json.Marshal(token[2])
	result, err := runner.call(ctx, webproto.LinkUser{ID: owner, AccessToken: "preview"}, verifyDocumentPreviewTokenMethod, []json.RawMessage{arg}, 3*time.Second)
	var session webproto.LinkWebSession
	if err != nil || result.OK == nil || !*result.OK || json.Unmarshal(result.Value, &session) != nil || session.ID == "" {
		g.Status(http.StatusUnauthorized)
		return
	}
	if c.backends().BackendMode(ctx) {
		user, err := c.backends().LookupUser(ctx, owner)
		if err != nil || !user.Admin {
			g.Status(http.StatusUnauthorized)
			return
		}
	}
	var issuedAt time.Time
	if session.IssuedAt != 0 {
		issuedAt = time.Unix(session.IssuedAt, 0)
	}
	for _, feature := range c.env.Components {
		if sessions, ok := feature.(documentPreviewSessions); ok && sessions.CheckWebCaller(ctx, owner, session.ID, issuedAt) == nil {
			g.Status(http.StatusNoContent)
			return
		}
	}
	g.Status(http.StatusUnauthorized)
}
