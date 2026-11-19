package catalog

import (
	"database/sql"
	"net/http"
	"strings"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

const maxPluginOrganizationRows = 200

type pluginOrganization struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Role string `json:"role"`
}

type organizationMarketplace struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	DisplayName string `json:"display_name"`
}

func (c *Component) registerPluginOrganizationRoutes(g *gin.RouterGroup) {
	g.GET("/plugin-organizations", c.listPluginOrganizations)
	g.GET("/plugin-organizations/:id/marketplaces", c.listOrganizationMarketplaces)
	g.GET("/plugin-organization-catalog", c.listOrganizationPlugins)
	g.GET("/plugin-organization-catalog/:id/authorization", c.authorizeOrganizationPlugin)
	g.GET("/plugin-organization-catalog/:id/packages/:digest", c.readOrganizationPluginPackage)
}

func pluginOrganizationActor(g *gin.Context) (int64, bool) {
	g.Header("Cache-Control", "no-store")
	userID, ok := core.Subject(g)
	if !ok {
		response.Unauthorized(g, "Sign in to continue.")
	}
	return userID, ok
}

func (c *Component) listPluginOrganizations(g *gin.Context) {
	userID, ok := pluginOrganizationActor(g)
	if !ok {
		return
	}
	if c.env.DB == nil {
		pluginOrganizationUnavailable(g)
		return
	}
	rows, err := c.env.DB.QueryContext(g.Request.Context(), `
		SELECT o.id, o.name, m.role
		FROM claudex_plugin_organization_members m
		JOIN claudex_plugin_organizations o ON o.id = m.organization_id
		JOIN users u ON u.id = m.user_id AND u.deleted_at IS NULL
		WHERE m.user_id = $1
		ORDER BY o.name, o.id
		LIMIT $2`, userID, maxPluginOrganizationRows+1)
	if err != nil {
		pluginOrganizationUnavailable(g)
		return
	}
	defer rows.Close()

	organizations := make([]pluginOrganization, 0)
	for rows.Next() {
		var organization pluginOrganization
		if rows.Scan(&organization.ID, &organization.Name, &organization.Role) != nil {
			pluginOrganizationUnavailable(g)
			return
		}
		organizations = append(organizations, organization)
	}
	if rows.Err() != nil || len(organizations) > maxPluginOrganizationRows {
		pluginOrganizationUnavailable(g)
		return
	}
	response.Success(g, organizations)
}

func (c *Component) listOrganizationMarketplaces(g *gin.Context) {
	userID, ok := pluginOrganizationActor(g)
	if !ok {
		return
	}
	rawID := g.Param("id")
	id, err := uuid.Parse(rawID)
	if err != nil || !strings.EqualFold(rawID, id.String()) {
		pluginOrganizationNotFound(g)
		return
	}
	if c.env.DB == nil {
		pluginOrganizationUnavailable(g)
		return
	}
	rows, err := c.env.DB.QueryContext(g.Request.Context(), `
		SELECT p.id, p.name, p.display_name
		FROM claudex_plugin_organization_members m
		JOIN users u ON u.id = m.user_id AND u.deleted_at IS NULL
		LEFT JOIN claudex_plugin_organization_marketplaces p ON p.organization_id = m.organization_id
		WHERE m.organization_id = $1 AND m.user_id = $2
		ORDER BY p.name, p.id
		LIMIT $3`, id, userID, maxPluginOrganizationRows+1)
	if err != nil {
		pluginOrganizationUnavailable(g)
		return
	}
	defer rows.Close()

	authorized := false
	marketplaces := make([]organizationMarketplace, 0)
	for rows.Next() {
		var marketID, name, displayName sql.NullString
		if rows.Scan(&marketID, &name, &displayName) != nil {
			pluginOrganizationUnavailable(g)
			return
		}
		authorized = true
		if marketID.Valid {
			marketplaces = append(marketplaces, organizationMarketplace{
				ID: marketID.String, Name: name.String, DisplayName: displayName.String,
			})
		}
	}
	if rows.Err() != nil || len(marketplaces) > maxPluginOrganizationRows {
		pluginOrganizationUnavailable(g)
		return
	}
	if !authorized {
		pluginOrganizationNotFound(g)
		return
	}
	response.Success(g, marketplaces)
}

func pluginOrganizationUnavailable(g *gin.Context) {
	response.Error(g, http.StatusServiceUnavailable, "Organization marketplaces are unavailable.")
}

func pluginOrganizationNotFound(g *gin.Context) {
	response.ErrorFrom(g, infraerrors.NotFound("CLAUDEX_PLUGIN_ORGANIZATION_NOT_FOUND", "Organization not found."))
}
