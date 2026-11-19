package productfeedback

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/mail"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type Component struct {
	env       *core.Env
	processor processor
}

func New(env *core.Env) *Component {
	c := &Component{env: env}
	s := &sqlStore{}
	if env != nil {
		s.db = env.DB
	}
	c.processor = processor{store: s, prepare: c.prepare, newID: uuid.NewString, now: time.Now}
	if env != nil && env.Now != nil {
		c.processor.now = env.Now
	}
	return c
}
func (c *Component) Name() string                          { return "product-feedback" }
func (c *Component) RegisterUserRoutes(g *gin.RouterGroup) { g.POST("/product-feedback", c.post) }
func (c *Component) prepare(ctx context.Context) (sendMail, error) {
	if c.env == nil || c.env.Email == nil {
		return nil, errUnavailable
	}
	cfg, err := c.env.Email.GetSMTPConfig(ctx)
	if err != nil || cfg == nil || strings.TrimSpace(cfg.Host) == "" || cfg.Port < 1 || cfg.Port > 65535 || strings.ContainsAny(cfg.From, "\r\n") {
		return nil, errUnavailable
	}
	if _, err := mail.ParseAddress(cfg.From); err != nil {
		return nil, errUnavailable
	}
	// Freeze the same checked config. Never read credentials in the renderer.
	return func(ctx context.Context, to, subject, body string) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return c.env.Email.SendEmailWithConfig(cfg, to, subject, body)
	}, nil
}

var versionPattern = regexp.MustCompile(`^[A-Za-z0-9.+_-]{1,64}$`)

func (c *Component) post(g *gin.Context) {
	middleware.SkipAudit(g)
	g.Header("Cache-Control", "no-store")
	userID, ok := core.Subject(g)
	if !ok {
		response.ErrorWithDetails(g, 401, "Sign in first.", "UNAUTHORIZED", nil)
		return
	}
	var in request
	g.Request.Body = http.MaxBytesReader(g.Writer, g.Request.Body, 32768)
	decoder := json.NewDecoder(g.Request.Body)
	decoder.DisallowUnknownFields()
	err := decoder.Decode(&in)
	var extra any
	if err != nil || decoder.Decode(&extra) != io.EOF || strings.TrimSpace(in.Text) == "" || !utf8.ValidString(in.Text) || utf8.RuneCountInString(in.Text) > 4096 || !versionPattern.MatchString(in.AppVersion) || !core.ValidDeviceID(in.RequestID) || in.RequestID == "00000000-0000-0000-0000-000000000000" {
		response.ErrorWithDetails(g, 400, "Invalid product feedback request.", "BAD_REQUEST", nil)
		return
	}
	normalize(&in)
	r, err := c.processor.submit(g.Request.Context(), userID, in)
	switch {
	case err == nil:
		response.Success(g, gin.H{"feedback_id": r.ID, "status": "sent"})
	case errors.Is(err, errConflict):
		response.ErrorWithDetails(g, 409, "This request ID was already used for different feedback.", "PRODUCT_FEEDBACK_CONFLICT", nil)
	case errors.Is(err, errLimited):
		g.Header("Retry-After", "3600")
		response.ErrorWithDetails(g, 429, "Too many feedback submissions. Try later.", "PRODUCT_FEEDBACK_RATE_LIMITED", nil)
	case errors.Is(err, errUnknown):
		// Do not return raw SMTP errors or claim that the mail definitely failed.
		response.ErrorWithDetails(g, 409, "Delivery could not be confirmed. Do not resend automatically.", "PRODUCT_FEEDBACK_DELIVERY_UNKNOWN", map[string]string{"feedback_id": r.ID, "status": "unknown"})
	default:
		response.ErrorWithDetails(g, 503, "Product feedback mail is unavailable.", "PRODUCT_FEEDBACK_UNAVAILABLE", nil)
	}
}

var _ core.Feature = (*Component)(nil)
var _ core.UserRouter = (*Component)(nil)
