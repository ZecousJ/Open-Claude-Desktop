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

const RouteCodePreview = "/web/code-preview"

var codePreviewToken = regexp.MustCompile(`^([1-9][0-9]{0,15})-([0-9a-f]{32})$`)

type codePreviewRequest struct {
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Headers map[string]string `json:"headers"`
	Body    []byte            `json:"body"`
}

type codePreviewResponse struct {
	Status  int                        `json:"status"`
	Headers map[string]json.RawMessage `json:"headers"`
	Body    []byte                     `json:"body"`
}

func (c *Component) codePreview(g *gin.Context) {
	g.Header("Cache-Control", "no-store")
	match := codePreviewToken.FindStringSubmatch(g.GetHeader("X-Claude-Code-Preview"))
	if match == nil {
		g.Status(http.StatusNotFound)
		return
	}
	var request codePreviewRequest
	g.Request.Body = http.MaxBytesReader(g.Writer, g.Request.Body, 110_000)
	if err := json.NewDecoder(g.Request.Body).Decode(&request); err != nil || len(request.Body) > 64*1024 {
		g.Status(http.StatusBadRequest)
		return
	}
	owner, _ := strconv.ParseInt(match[1], 10, 64)
	ctx, cancel := context.WithTimeout(g.Request.Context(), 23*time.Second)
	defer cancel()
	if _, _, _, ok := c.admit(ctx, owner); !ok {
		g.Status(http.StatusNotFound)
		return
	}
	runner := c.reg.current(ctx, owner)
	if runner == nil || !runner.methods["officialUiRead"] {
		g.Status(http.StatusNotFound)
		return
	}
	if !c.gate.enter(owner) {
		g.Status(http.StatusTooManyRequests)
		return
	}
	defer c.gate.leave(owner)
	user := webproto.LinkUser{ID: owner, AccessToken: "preview"}
	token, _ := json.Marshal(match[2])
	res, err := runner.call(ctx, user, "officialCodePreviewLease", []json.RawMessage{token}, 3*time.Second)
	var session webproto.LinkWebSession
	if err != nil || res.OK == nil || !*res.OK || json.Unmarshal(res.Value, &session) != nil ||
		!c.currentCodePreviewSession(ctx, owner, session) {
		g.Status(http.StatusNotFound)
		return
	}
	if request.Body == nil {
		request.Body = []byte{}
	}
	arg, _ := json.Marshal(request)
	res, err = runner.call(ctx, user, "officialCodePreviewRequest", []json.RawMessage{token, arg}, 19*time.Second)
	var answer codePreviewResponse
	if err != nil || res.OK == nil || !*res.OK || json.Unmarshal(res.Value, &answer) != nil ||
		answer.Status < 200 || answer.Status > 599 || len(answer.Body) > 4*1024*1024 {
		g.Status(http.StatusBadGateway)
		return
	}
	if !c.currentCodePreviewSession(ctx, owner, session) {
		g.Status(http.StatusNotFound)
		return
	}
	g.JSON(http.StatusOK, answer)
}

func (c *Component) currentCodePreviewSession(ctx context.Context, owner int64, session webproto.LinkWebSession) bool {
	if session.ID == "" {
		return false
	}
	var issuedAt time.Time
	if session.IssuedAt != 0 {
		issuedAt = time.Unix(session.IssuedAt, 0)
	}
	for _, feature := range c.env.Components {
		if sessions, ok := feature.(documentPreviewSessions); ok && sessions.CheckWebCaller(ctx, owner, session.ID, issuedAt) == nil {
			return true
		}
	}
	return false
}
