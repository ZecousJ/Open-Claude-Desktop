package release

import (
	"context"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
)

// AdminView is the answer of GET/PUT /api/v1/admin/claudex/release: the
// stored setting as is, plus when it was last written (null if never).
type AdminView struct {
	Setting
	UpdatedAt *time.Time `json:"updated_at"`
}

// RegisterAdminRoutes implements core.AdminRouter under /api/v1/admin/claudex
// (admin auth, panel rate limit, audit log, AdminComplianceGuard). Changing
// download links is high risk, so PUT is behind step-up.
func (c *Component) RegisterAdminRoutes(g *gin.RouterGroup, stepUp gin.HandlerFunc) {
	g.GET("/release", c.adminGet)
	g.PUT("/release", stepUp, c.adminPut)
}

// GET /api/v1/admin/claudex/release
func (c *Component) adminGet(g *gin.Context) {
	view, err := c.adminView(g.Request.Context())
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	response.Success(g, view)
}

// PUT /api/v1/admin/claudex/release: the body is the whole setting (it
// replaces the stored one).
func (c *Component) adminPut(g *gin.Context) {
	body, err := io.ReadAll(http.MaxBytesReader(g.Writer, g.Request.Body, maxBodyBytes))
	if err != nil {
		response.ErrorFrom(g, invalid("body", "max_size", "The request body is too large."))
		return
	}
	next, err := decodeSetting(body)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	if _, err := c.setting.Set(g.Request.Context(), next); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	view, err := c.adminView(g.Request.Context())
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	response.Success(g, view)
}

// adminView reads the setting from the database (not the 60 s cache) and
// the row's update time.
func (c *Component) adminView(ctx context.Context) (AdminView, error) {
	s, err := c.setting.Get(ctx)
	if err != nil {
		return AdminView{}, err
	}
	view := AdminView{Setting: s}
	if c.env != nil && c.env.SettingRepo != nil {
		row, err := c.env.SettingRepo.Get(ctx, SettingKey)
		switch {
		case err == nil && row != nil && !row.UpdatedAt.IsZero():
			t := row.UpdatedAt.UTC()
			view.UpdatedAt = &t
		case err != nil && !errors.Is(err, service.ErrSettingNotFound):
			return AdminView{}, err
		}
	}
	return view, nil
}
