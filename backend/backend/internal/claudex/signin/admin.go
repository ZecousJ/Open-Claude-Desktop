package signin

import (
	"context"
	"io"
	"net/http"

	"github.com/Wei-Shaw/sub2api/internal/pkg/response"

	"github.com/gin-gonic/gin"
)

const maxAdminBodyBytes = 16 << 10

// AdminView answers GET/PUT /api/v1/admin/claudex/sign-in: the stored
// setting plus what makes the email code sign-in work.
type AdminView struct {
	Settings
	// SMTPConfigured: the upstream SMTP settings have a host.
	SMTPConfigured bool `json:"smtp_configured"`
	// BackendModeEnabled: upstream backend mode is on (no email codes).
	BackendModeEnabled bool `json:"backend_mode_enabled"`
	// EmailCodeLoginAvailable is what GET /api/v1/claudex/sign-in/options
	// answers as email_code_login.
	EmailCodeLoginAvailable bool `json:"email_code_login_available"`
}

func (c *Component) adminView(ctx context.Context, s Settings) AdminView {
	smtp := c.smtpConfigured(ctx)
	backend := c.backendMode(ctx)
	return AdminView{
		Settings:                s,
		SMTPConfigured:          smtp,
		BackendModeEnabled:      backend,
		EmailCodeLoginAvailable: s.EmailCodeLoginEnabled && smtp && !backend,
	}
}

// GET /api/v1/admin/claudex/sign-in
func (c *Component) adminGet(g *gin.Context) {
	ctx := g.Request.Context()
	s, err := c.setting.Get(ctx)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	response.Success(g, c.adminView(ctx, s))
}

// PUT /api/v1/admin/claudex/sign-in (step-up). Fields left out keep their
// values; unknown fields and invalid values answer 400
// CLAUDEX_SIGN_IN_INVALID (metadata field, rule).
func (c *Component) adminPut(g *gin.Context) {
	ctx := g.Request.Context()
	body, err := io.ReadAll(http.MaxBytesReader(g.Writer, g.Request.Body, maxAdminBodyBytes))
	if err != nil {
		response.ErrorFrom(g, invalid("body", "max_size", "The request body is too large."))
		return
	}
	upd, err := decodeUpdate(body)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	next, err := c.setting.Get(ctx)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	if upd.EmailCodeLoginEnabled != nil {
		next.EmailCodeLoginEnabled = *upd.EmailCodeLoginEnabled
	}
	if upd.PrivacyPolicyURL != nil {
		next.PrivacyPolicyURL = *upd.PrivacyPolicyURL
	}
	saved, err := c.setting.Set(ctx, next)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	c.options.Store(nil)
	response.Success(g, c.adminView(ctx, saved))
}
