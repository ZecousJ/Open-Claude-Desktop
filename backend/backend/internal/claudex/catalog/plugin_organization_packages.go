package catalog

import (
	"database/sql"
	"errors"
	"net/http"
	"regexp"
	"strconv"

	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/gin-gonic/gin"
)

var (
	organizationPluginIDPattern = regexp.MustCompile(`^plugin_[a-f0-9]{24}$`)
	organizationPackageDigest   = regexp.MustCompile(`^[a-f0-9]{64}$`)
)

const authorizedOrganizationPackage = `
	FROM claudex_plugin_organization_members m
	JOIN users u ON u.id = m.user_id AND u.deleted_at IS NULL
	JOIN claudex_plugin_organization_marketplaces p ON p.organization_id = m.organization_id
	JOIN claudex_plugin_organization_catalog r ON r.marketplace_id = p.id
	JOIN claudex_plugin_organization_packages b ON b.marketplace_id = r.marketplace_id AND b.name = r.name AND b.commit_sha = r.commit_sha
	WHERE m.user_id = $1 AND r.installation_preference <> 'not_available'
	  AND ('plugin_' || left(encode(sha256(('organization-plugin:' || p.id::text || '/' || r.name)::bytea), 'hex'), 24)) = $2`

type organizationPluginGrant struct {
	ID                     string `json:"id"`
	OrganizationID         string `json:"organization_id"`
	MarketplaceID          string `json:"marketplace_id"`
	Name                   string `json:"name"`
	DisplayName            string `json:"display_name"`
	Description            string `json:"description"`
	Version                string `json:"version"`
	Digest                 string `json:"sha256"`
	InstallationPreference string `json:"installation_preference"`
}

func (c *Component) pluginPackageActor(g *gin.Context) (int64, string, bool) {
	userID, ok := pluginOrganizationActor(g)
	if !ok {
		return 0, "", false
	}
	id := g.Param("id")
	if !organizationPluginIDPattern.MatchString(id) {
		pluginOrganizationNotFound(g)
		return 0, "", false
	}
	if c.env.DB == nil {
		pluginOrganizationUnavailable(g)
		return 0, "", false
	}
	return userID, id, true
}

func (c *Component) authorizeOrganizationPlugin(g *gin.Context) {
	userID, id, ok := c.pluginPackageActor(g)
	if !ok {
		return
	}
	grant := organizationPluginGrant{ID: id}
	err := c.env.DB.QueryRowContext(g.Request.Context(), `
		SELECT p.organization_id, p.id, r.name, r.display_name, r.description, r.version, b.sha256, r.installation_preference`+
		authorizedOrganizationPackage, userID, id).Scan(&grant.OrganizationID, &grant.MarketplaceID, &grant.Name,
		&grant.DisplayName, &grant.Description, &grant.Version, &grant.Digest, &grant.InstallationPreference)
	if err != nil {
		organizationPackageReadError(g, err)
		return
	}
	response.Success(g, grant)
}

func (c *Component) readOrganizationPluginPackage(g *gin.Context) {
	userID, id, ok := c.pluginPackageActor(g)
	if !ok {
		return
	}
	digest := g.Param("digest")
	if !organizationPackageDigest.MatchString(digest) {
		pluginOrganizationNotFound(g)
		return
	}
	rows, err := c.env.DB.QueryContext(g.Request.Context(), `
		WITH authorized AS (SELECT b.archive`+authorizedOrganizationPackage+` AND b.sha256 = $3)
		SELECT octet_length(archive), substring(archive FROM piece.start FOR 262144)
		FROM authorized
		CROSS JOIN LATERAL generate_series(1, octet_length(archive), 262144) AS piece(start)
		ORDER BY piece.start`, userID, id, digest)
	if err != nil {
		organizationPackageReadError(g, err)
		return
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			organizationPackageReadError(g, err)
		} else {
			pluginOrganizationNotFound(g)
		}
		return
	}
	var size int
	var chunk []byte
	if err := rows.Scan(&size, &chunk); err != nil {
		organizationPackageReadError(g, err)
		return
	}
	g.Header("Content-Type", "application/zip")
	g.Header("Content-Length", strconv.Itoa(size))
	g.Status(http.StatusOK)
	for {
		if _, err := g.Writer.Write(chunk); err != nil || !rows.Next() {
			return
		}
		if rows.Scan(&size, &chunk) != nil {
			return
		}
	}
}

func organizationPackageReadError(g *gin.Context, err error) {
	if errors.Is(err, sql.ErrNoRows) {
		pluginOrganizationNotFound(g)
		return
	}
	pluginOrganizationUnavailable(g)
}
