package knowledge

import (
	"encoding/json"
	"io"
	"net/http"

	"github.com/Wei-Shaw/sub2api/internal/pkg/response"

	"github.com/gin-gonic/gin"
)

// AdminBase is a base as the console sees it: the key only as whether one
// is set.
type AdminBase struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	MCPURL      string `json:"mcp_url"`
	APIKeySet   bool   `json:"api_key_set"`
	Enabled     bool   `json:"enabled"`
}

// adminPutBase is a base in PUT: an empty api_key keeps the stored one,
// clear_api_key removes it.
type adminPutBase struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	MCPURL      string `json:"mcp_url"`
	APIKey      string `json:"api_key"`
	ClearAPIKey bool   `json:"clear_api_key"`
	Enabled     bool   `json:"enabled"`
}

// RegisterAdminRoutes implements core.AdminRouter; PUT holds a secret, so
// it is behind step-up.
func (c *Component) RegisterAdminRoutes(g *gin.RouterGroup, stepUp gin.HandlerFunc) {
	g.GET("/knowledge", c.adminGet)
	g.PUT("/knowledge", stepUp, c.adminPut)
}

func adminView(s Setting) gin.H {
	bases := make([]AdminBase, 0, len(s.Bases))
	for _, b := range s.Bases {
		bases = append(bases, AdminBase{ID: b.ID, Name: b.Name, Description: b.Description, MCPURL: b.MCPURL, APIKeySet: b.APIKey != "", Enabled: b.Enabled})
	}
	return gin.H{"bases": bases}
}

func (c *Component) adminGet(g *gin.Context) {
	s, err := c.setting.Get(g.Request.Context())
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	response.Success(g, adminView(s))
}

func (c *Component) adminPut(g *gin.Context) {
	raw, err := io.ReadAll(io.LimitReader(g.Request.Body, 64<<10))
	if err != nil {
		response.BadRequest(g, "Unreadable body.")
		return
	}
	var in struct {
		Bases []adminPutBase `json:"bases"`
	}
	if err := json.Unmarshal(raw, &in); err != nil || in.Bases == nil {
		response.BadRequest(g, `Send {"bases":[…]}.`)
		return
	}
	current, err := c.setting.Get(g.Request.Context())
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	stored := map[string]string{}
	for _, b := range current.Bases {
		stored[b.ID] = b.APIKey
	}
	next := Setting{Bases: make([]Base, 0, len(in.Bases))}
	for _, b := range in.Bases {
		key := b.APIKey
		if key == "" && !b.ClearAPIKey {
			key = stored[b.ID]
		}
		next.Bases = append(next.Bases, Base{ID: b.ID, Name: b.Name, Description: b.Description, MCPURL: b.MCPURL, APIKey: key, Enabled: b.Enabled})
	}
	saved, err := c.setting.Set(g.Request.Context(), next)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	c.mu.Lock()
	c.probes = map[string]probe{}
	c.mu.Unlock()
	g.Status(http.StatusOK)
	response.Success(g, adminView(saved))
}
