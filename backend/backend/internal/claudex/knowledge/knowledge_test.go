package knowledge

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/gatewayhook"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

type memRepo struct {
	mu   sync.Mutex
	rows map[string]string
}

func (r *memRepo) Get(_ context.Context, key string) (*service.Setting, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	v, ok := r.rows[key]
	if !ok {
		return nil, service.ErrSettingNotFound
	}
	return &service.Setting{Key: key, Value: v}, nil
}
func (r *memRepo) GetValue(ctx context.Context, key string) (string, error) {
	s, err := r.Get(ctx, key)
	if err != nil {
		return "", err
	}
	return s.Value, nil
}
func (r *memRepo) Set(_ context.Context, key, value string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.rows[key] = value
	return nil
}
func (r *memRepo) GetMultiple(context.Context, []string) (map[string]string, error) {
	return nil, errors.New("not used")
}
func (r *memRepo) SetMultiple(context.Context, map[string]string) error {
	return errors.New("not used")
}
func (r *memRepo) GetAll(context.Context) (map[string]string, error) {
	return nil, errors.New("not used")
}
func (r *memRepo) Delete(context.Context, string) error { return errors.New("not used") }

func newComponent(t *testing.T, stored string) (*Component, *memRepo) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	repo := &memRepo{rows: map[string]string{}}
	if stored != "" {
		repo.rows[SettingKey] = stored
	}
	return New(&core.Env{Deps: core.Deps{SettingRepo: repo}}), repo
}

func TestDefaultsOfferHiwonderOff(t *testing.T) {
	c, _ := newComponent(t, "")
	s := c.setting.Cached(context.Background())
	require.Len(t, s.Bases, 1)
	require.Equal(t, HuanerTech, s.Bases[0].ID)
	require.False(t, s.Bases[0].Enabled)
	require.Empty(t, c.Public(context.Background()), "a disabled base is not listed")
	_, ok := s.find(HuanerTech)
	require.False(t, ok)
}

func TestValidate(t *testing.T) {
	ok := Setting{Bases: []Base{{ID: "huaner-tech", Name: "幻尔", MCPURL: "http://127.0.0.1:8765/mcp"}}}
	require.NoError(t, validate(&ok))
	for _, bad := range []Base{
		{ID: "Bad ID", Name: "x", MCPURL: "http://a/mcp"},
		{ID: "a", Name: "", MCPURL: "http://a/mcp"},
		{ID: "a", Name: "x", MCPURL: "ftp://a/mcp"},
		{ID: "a", Name: "x", MCPURL: "http://user:pw@a/mcp"},
	} {
		s := Setting{Bases: []Base{bad}}
		require.Error(t, validate(&s), "%+v", bad)
	}
	dup := Setting{Bases: []Base{ok.Bases[0], ok.Bases[0]}}
	require.Error(t, validate(&dup))
}

// The relay sends the base's own key, never the account's, keeps the MCP
// session header both ways and streams the answer.
func TestRelaySwapsTheKey(t *testing.T) {
	var seen http.Header
	var seenBody string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Header.Clone()
		b, _ := io.ReadAll(r.Body)
		seenBody = string(b)
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Mcp-Session-Id", "s-1")
		_, _ = io.WriteString(w, "data: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n\n")
	}))
	defer upstream.Close()
	raw, _ := json.Marshal(Setting{Bases: []Base{{ID: HuanerTech, Name: "幻尔", MCPURL: upstream.URL, APIKey: "rag-secret", Enabled: true}}})
	c, _ := newComponent(t, string(raw))

	r := gin.New()
	r.POST(gatewayhook.KnowledgeRoute, func(g *gin.Context) {
		gatewayhook.ServeKnowledge(g, &service.APIKey{ID: 1, UserID: 7})
	})
	req := httptest.NewRequest(http.MethodPost, "/v1/claudex/knowledge/huaner-tech/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
	req.Header.Set("Authorization", "Bearer sk-account")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Mcp-Session-Id", "s-1")
	req.Header.Set("X-Claudex-Device-Id", "dev")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusOK, w.Code)
	require.Equal(t, "Bearer rag-secret", seen.Get("Authorization"))
	require.Equal(t, "s-1", seen.Get("Mcp-Session-Id"))
	require.Empty(t, seen.Get("X-Claudex-Device-Id"))
	require.Contains(t, seenBody, "tools/list")
	require.Equal(t, "s-1", w.Header().Get("Mcp-Session-Id"))
	require.Contains(t, w.Body.String(), `"result"`)
	_ = c

	// A base that is off, or unknown: 404.
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/v1/claudex/knowledge/other/mcp", strings.NewReader("{}")))
	require.Equal(t, http.StatusNotFound, w.Code)
}

func TestRelayRateLimit(t *testing.T) {
	c, _ := newComponent(t, "")
	for i := 0; i < ratePerMinute; i++ {
		require.True(t, c.allow(9))
	}
	require.False(t, c.allow(9))
	require.True(t, c.allow(10), "each account counts alone")
}

func TestPublicProbesTheServer(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer k" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"jsonrpc":"2.0","id":1,"result":{}}`)
	}))
	defer up.Close()
	raw, _ := json.Marshal(Setting{Bases: []Base{
		{ID: "up", Name: "Up", MCPURL: up.URL, APIKey: "k", Enabled: true},
		{ID: "down", Name: "Down", MCPURL: "http://127.0.0.1:1/mcp", Enabled: true},
	}})
	c, _ := newComponent(t, string(raw))
	got := c.Public(context.Background())
	require.Len(t, got, 2)
	require.True(t, got[0].Available)
	require.False(t, got[1].Available)
}

func TestAdminKeepsAndClearsTheKey(t *testing.T) {
	raw, _ := json.Marshal(Setting{Bases: []Base{{ID: HuanerTech, Name: "幻尔", MCPURL: "http://127.0.0.1:8765/mcp", APIKey: "old", Enabled: true}}})
	c, repo := newComponent(t, string(raw))
	r := gin.New()
	c.RegisterAdminRoutes(r.Group("/admin"), func(g *gin.Context) {})

	get := httptest.NewRecorder()
	r.ServeHTTP(get, httptest.NewRequest(http.MethodGet, "/admin/knowledge", nil))
	require.Contains(t, get.Body.String(), `"api_key_set":true`)
	require.NotContains(t, get.Body.String(), "old")

	put := func(body string) {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodPut, "/admin/knowledge", strings.NewReader(body)))
		require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	}
	put(`{"bases":[{"id":"huaner-tech","name":"幻尔科技知识库","mcp_url":"http://127.0.0.1:8765/mcp","enabled":true}]}`)
	require.Contains(t, repo.rows[SettingKey], `"api_key":"old"`, "an empty key keeps the stored one")
	put(`{"bases":[{"id":"huaner-tech","name":"幻尔科技知识库","mcp_url":"http://127.0.0.1:8765/mcp","clear_api_key":true,"enabled":true}]}`)
	require.Contains(t, repo.rows[SettingKey], `"api_key":""`)
}
