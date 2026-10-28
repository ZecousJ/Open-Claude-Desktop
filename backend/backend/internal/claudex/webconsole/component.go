// Package webconsole is the B1 component for the public setting
// web_console_admin_only (design 2.2), stored under
// claudex_web_console_admin_only:
//
//   - public GET /api/v1/claudex/web-console → {"admin_only":true};
//   - admin GET/PUT /api/v1/admin/claudex/web-console (PUT behind step-up).
//
// The setting only drives the console's front-end router (K0): the JSON API
// is never blocked by it. A missing or unreadable value means true.
package webconsole

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
)

// SettingKey stores web_console_admin_only (the core.JSONSetting prefix rule
// makes it claudex_…; the public name stays web_console_admin_only).
const SettingKey = "claudex_web_console_admin_only"

// Setting is the stored value.
type Setting struct {
	AdminOnly bool `json:"admin_only"`
}

// defaults: the web console is for administrators only.
func defaults() Setting { return Setting{AdminOnly: true} }

// PublicView is the answer of GET /api/v1/claudex/web-console.
type PublicView struct {
	AdminOnly bool `json:"admin_only"`
}

// AdminView is the answer of GET/PUT /api/v1/admin/claudex/web-console.
// backend_mode_enabled is the upstream Backend mode (read only here): when it
// is on, regular users cannot sign in to the desktop app either.
type AdminView struct {
	AdminOnly          bool `json:"admin_only"`
	BackendModeEnabled bool `json:"backend_mode_enabled"`
}

// Component is the B1 web console component.
type Component struct {
	env     *core.Env
	setting *core.JSONSetting[Setting]
}

// New builds the component. It does not touch its dependencies or env.Peers.
func New(env *core.Env) *Component {
	var repo service.SettingRepository
	if env != nil {
		repo = env.SettingRepo
	}
	return &Component{env: env, setting: core.NewJSONSetting(repo, SettingKey, defaults)}
}

// Name implements core.Feature.
func (c *Component) Name() string { return core.NameWebConsole }

// SettingKeys implements core.SettingsOwner.
func (c *Component) SettingKeys() []string { return []string{c.setting.Key()} }

// RegisterPublicRoutes implements core.PublicRouter (per-IP panel rate
// limit, X-Claudex-* header validation, no authentication).
func (c *Component) RegisterPublicRoutes(g *gin.RouterGroup) {
	g.GET("/web-console", c.public)
}

// RegisterAdminRoutes implements core.AdminRouter (admin auth, panel rate
// limit, audit log, AdminComplianceGuard). PUT is behind step-up: opening the
// console to every user is a policy change.
func (c *Component) RegisterAdminRoutes(g *gin.RouterGroup, stepUp gin.HandlerFunc) {
	g.GET("/web-console", c.adminGet)
	g.PUT("/web-console", stepUp, c.adminPut)
}

// GET /api/v1/claudex/web-console (public).
func (c *Component) public(g *gin.Context) {
	s := c.setting.Cached(g.Request.Context())
	g.Header("Cache-Control", "public, max-age=60")
	// The public group answers 400 to malformed X-Claudex-* headers, so the
	// answer depends on them like /claudex/release does.
	g.Header("Vary", "X-Claudex-Platform, X-Claudex-Arch, X-Claudex-Version")
	response.Success(g, PublicView(s))
}

// GET /api/v1/admin/claudex/web-console
func (c *Component) adminGet(g *gin.Context) {
	s, err := c.setting.Get(g.Request.Context())
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	response.Success(g, c.adminView(g, s))
}

// adminInput is the PUT body. backend_mode_enabled is accepted so a client
// can send back what GET returned, but it is read only here (the upstream
// settings page owns Backend mode).
type adminInput struct {
	AdminOnly          *bool           `json:"admin_only"`
	BackendModeEnabled json.RawMessage `json:"backend_mode_enabled"`
}

// maxBodyBytes bounds the PUT body.
const maxBodyBytes = 16 << 10

// PUT /api/v1/admin/claudex/web-console {"admin_only":false}
func (c *Component) adminPut(g *gin.Context) {
	body, err := io.ReadAll(http.MaxBytesReader(g.Writer, g.Request.Body, maxBodyBytes))
	if err != nil {
		response.ErrorFrom(g, invalid("body", "max_size", "The request body is too large."))
		return
	}
	var in adminInput
	if err := decodeStrict(body, &in); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	if in.AdminOnly == nil {
		response.ErrorFrom(g, invalid("admin_only", "required", "Set admin_only to true or false."))
		return
	}
	saved, err := c.setting.Set(g.Request.Context(), Setting{AdminOnly: *in.AdminOnly})
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	response.Success(g, c.adminView(g, saved))
}

func (c *Component) adminView(g *gin.Context, s Setting) AdminView {
	view := AdminView{AdminOnly: s.AdminOnly}
	if c.env != nil && c.env.SettingService != nil {
		view.BackendModeEnabled = c.env.SettingService.IsBackendModeEnabled(g.Request.Context())
	}
	return view
}

func invalid(field, rule, message string) error {
	return core.InvalidSetting("", field, rule, message)
}

// decodeStrict decodes one JSON object and refuses unknown keys.
func decodeStrict(data []byte, v any) error {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return invalid("body", "json_object", "Send the setting as a JSON object.")
	}
	dec := json.NewDecoder(bytes.NewReader(trimmed))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		var typeErr *json.UnmarshalTypeError
		if errors.As(err, &typeErr) && typeErr.Field != "" {
			return invalid(typeErr.Field, "type", "The value of "+typeErr.Field+" has the wrong type.")
		}
		const prefix = "json: unknown field "
		if msg := err.Error(); strings.HasPrefix(msg, prefix) {
			if name, uerr := strconv.Unquote(strings.TrimPrefix(msg, prefix)); uerr == nil && len(name) <= 64 {
				return invalid(name, "unknown_field", "Unknown setting "+strconv.Quote(name)+".")
			}
			return invalid("body", "unknown_field", "The request has an unknown setting.")
		}
		return invalid("body", "json", "The request body is not valid JSON.")
	}
	if err := dec.Decode(&json.RawMessage{}); !errors.Is(err, io.EOF) {
		return invalid("body", "json", "The request body must hold one JSON object.")
	}
	return nil
}

var (
	_ core.Feature       = (*Component)(nil)
	_ core.SettingsOwner = (*Component)(nil)
	_ core.PublicRouter  = (*Component)(nil)
	_ core.AdminRouter   = (*Component)(nil)
)
