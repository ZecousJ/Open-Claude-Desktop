// Package knowledge serves knowledge bases to the agents (owner, 2026-10-07:
// ZecousAI's Hiwonder knowledge base, offered to every account, off until a
// chat turns it on).
//
// A knowledge base is an MCP server (streamable HTTP) run elsewhere, here
// Hiwonder's RAG server reached through a tunnel on this host. The service
// relays the agents' MCP requests to it:
//
//   - setting claudex_knowledge (admin GET/PUT /api/v1/admin/claudex/knowledge,
//     PUT behind step-up); the MCP key is stored here and never shown back;
//   - public GET /api/v1/claudex/knowledge: the enabled bases and whether
//     their server answers (the apps' switch);
//   - the gateway route /v1/claudex/knowledge/:base/mcp (API-key auth, not
//     billed; internal/server/routes/gateway.go): the agent's MCP client talks
//     to it through the app's local gateway, which adds the account's key; the
//     relay swaps it for the base's own key.
package knowledge

import (
	"context"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/gatewayhook"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
)

const (
	probeTTL       = 30 * time.Second
	probeTimeout   = 4 * time.Second
	relayTimeout   = 120 * time.Second
	maxRequestBody = 1 << 20
	// Requests per account per minute (a search and a few reads per answer).
	ratePerMinute = 120
)

// Component is the knowledge-base component.
type Component struct {
	env     *core.Env
	setting *core.JSONSetting[Setting]
	client  *http.Client

	mu     sync.Mutex
	probes map[string]probe
	rates  map[int64]*window
}

type probe struct {
	ok bool
	at time.Time
}

type window struct {
	start time.Time
	count int
}

// New builds the component and installs the gateway relay.
func New(env *core.Env) *Component {
	var repo service.SettingRepository
	if env != nil {
		repo = env.SettingRepo
	}
	c := &Component{
		env:     env,
		setting: core.NewJSONSetting(repo, SettingKey, defaults, core.WithNormalize(normalize), core.WithValidate(validate)),
		client:  &http.Client{},
		probes:  map[string]probe{},
		rates:   map[int64]*window{},
	}
	gatewayhook.RegisterKnowledgeRelay(c.relay)
	return c
}

// Name implements core.Feature.
func (c *Component) Name() string { return core.NameKnowledge }

// SettingKeys implements core.SettingsOwner.
func (c *Component) SettingKeys() []string { return []string{c.setting.Key()} }

// PublicBase is one entry of GET /api/v1/claudex/knowledge.
type PublicBase struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Available   bool   `json:"available"`
}

// RegisterPublicRoutes implements core.PublicRouter.
func (c *Component) RegisterPublicRoutes(g *gin.RouterGroup) {
	g.GET("/knowledge", c.getPublic)
}

func (c *Component) getPublic(g *gin.Context) {
	g.Header("Cache-Control", "no-store")
	response.Success(g, gin.H{"bases": c.Public(g.Request.Context())})
}

// Public lists the enabled bases and whether each answers.
func (c *Component) Public(ctx context.Context) []PublicBase {
	out := []PublicBase{}
	for _, b := range c.setting.Cached(ctx).Bases {
		if !b.Enabled {
			continue
		}
		out = append(out, PublicBase{ID: b.ID, Name: b.Name, Description: b.Description, Available: c.available(ctx, b)})
	}
	return out
}

// available reports whether the base's MCP server answers an initialize,
// remembered for probeTTL.
func (c *Component) available(ctx context.Context, b Base) bool {
	key := b.ID + "\x00" + b.MCPURL
	c.mu.Lock()
	p, ok := c.probes[key]
	c.mu.Unlock()
	if ok && time.Since(p.at) < probeTTL {
		return p.ok
	}
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	body := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"claudex-probe","version":"1"}}}`
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, b.MCPURL, strings.NewReader(body))
	up := false
	if err == nil {
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		if b.APIKey != "" {
			req.Header.Set("Authorization", "Bearer "+b.APIKey)
		}
		if res, err := c.client.Do(req); err == nil {
			_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 64<<10))
			_ = res.Body.Close()
			up = res.StatusCode >= 200 && res.StatusCode < 300
		}
	}
	c.mu.Lock()
	c.probes[key] = probe{ok: up, at: time.Now()}
	c.mu.Unlock()
	return up
}

// allow counts one request of the account against ratePerMinute.
func (c *Component) allow(userID int64) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	w := c.rates[userID]
	if w == nil || now.Sub(w.start) >= time.Minute {
		if len(c.rates) > 10000 {
			c.rates = map[int64]*window{}
		}
		w = &window{start: now}
		c.rates[userID] = w
	}
	w.count++
	return w.count <= ratePerMinute
}

var (
	_ core.Feature       = (*Component)(nil)
	_ core.SettingsOwner = (*Component)(nil)
	_ core.PublicRouter  = (*Component)(nil)
	_ core.AdminRouter   = (*Component)(nil)
)
