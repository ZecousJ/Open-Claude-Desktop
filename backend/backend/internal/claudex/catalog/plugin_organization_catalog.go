package catalog

import (
	"crypto/sha256"
	"encoding/hex"

	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/gin-gonic/gin"
)

const maxOrganizationPluginRows = 1000

type organizationPlugin struct {
	ID                     string `json:"id"`
	MarketplaceID          string `json:"marketplace_id"`
	MarketplaceDisplayName string `json:"marketplace_display_name"`
	Name                   string `json:"name"`
	DisplayName            string `json:"display_name"`
	Description            string `json:"description"`
	Version                string `json:"version"`
	InstallationPreference string `json:"installation_preference"`
	PackageAvailable       bool   `json:"package_available"`
}

func (c *Component) listOrganizationPlugins(g *gin.Context) {
	userID, ok := pluginOrganizationActor(g)
	if !ok {
		return
	}
	if c.env.DB == nil {
		pluginOrganizationUnavailable(g)
		return
	}
	rows, err := c.env.DB.QueryContext(g.Request.Context(), `
		SELECT p.id, p.display_name, r.name, r.display_name, r.description, r.version, r.installation_preference,
			EXISTS (SELECT 1 FROM claudex_plugin_organization_packages b
				WHERE b.marketplace_id = r.marketplace_id AND b.name = r.name AND b.commit_sha = r.commit_sha)
		FROM claudex_plugin_organization_members m
		JOIN users u ON u.id = m.user_id AND u.deleted_at IS NULL
		JOIN claudex_plugin_organization_marketplaces p ON p.organization_id = m.organization_id
		JOIN claudex_plugin_organization_catalog r ON r.marketplace_id = p.id
		WHERE m.user_id = $1 AND r.installation_preference <> 'not_available'
		ORDER BY r.display_name, p.id, r.name
		LIMIT $2`, userID, maxOrganizationPluginRows+1)
	if err != nil {
		pluginOrganizationUnavailable(g)
		return
	}
	defer rows.Close()

	plugins := make([]organizationPlugin, 0)
	for rows.Next() {
		var plugin organizationPlugin
		if rows.Scan(&plugin.MarketplaceID, &plugin.MarketplaceDisplayName, &plugin.Name, &plugin.DisplayName,
			&plugin.Description, &plugin.Version, &plugin.InstallationPreference, &plugin.PackageAvailable) != nil {
			pluginOrganizationUnavailable(g)
			return
		}
		id := sha256.Sum256([]byte("organization-plugin:" + plugin.MarketplaceID + "/" + plugin.Name))
		plugin.ID = "plugin_" + hex.EncodeToString(id[:12])
		plugins = append(plugins, plugin)
	}
	if rows.Err() != nil || len(plugins) > maxOrganizationPluginRows {
		pluginOrganizationUnavailable(g)
		return
	}
	response.Success(g, plugins)
}
