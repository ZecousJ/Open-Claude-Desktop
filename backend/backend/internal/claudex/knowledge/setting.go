package knowledge

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
)

// SettingKey stores the knowledge bases (admin GET/PUT /api/v1/admin/claudex/knowledge).
const SettingKey = "claudex_knowledge"

// HuanerTech is the knowledge base ZecousAI offered: Hiwonder's product
// manuals, course materials and source code, served by its RAG MCP server.
const HuanerTech = "huaner-tech"

const (
	maxBases       = 8
	maxNameLen     = 60
	maxDescLen     = 200
	maxURLLen      = 2000
	maxAPIKeyLen   = 512
	defaultMCPAddr = "http://127.0.0.1:8765/mcp"
)

var baseID = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)

// Setting is the stored value of claudex_knowledge.
//
//	{"bases":[{"id":"huaner-tech","name":"幻尔科技知识库","description":"…",
//	  "mcp_url":"http://127.0.0.1:8765/mcp","api_key":"…","enabled":true}]}
type Setting struct {
	Bases []Base `json:"bases"`
}

// Base is one knowledge base: an MCP server (streamable HTTP) the service
// relays to, with the key it needs. The key never leaves the service.
type Base struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	MCPURL      string `json:"mcp_url"`
	APIKey      string `json:"api_key"`
	Enabled     bool   `json:"enabled"`
}

func defaults() Setting { return Setting{} }

// defaultBases is what an unset setting holds: Hiwonder's base, off until
// the administrator gives its key and turns it on.
func defaultBases() []Base {
	return []Base{{
		ID:          HuanerTech,
		Name:        "幻尔科技知识库",
		Description: "幻尔科技的产品手册、课程资料和产品源码",
		MCPURL:      defaultMCPAddr,
	}}
}

func normalize(s *Setting) {
	if s.Bases == nil {
		s.Bases = defaultBases()
	}
	for i := range s.Bases {
		b := &s.Bases[i]
		b.ID = strings.TrimSpace(b.ID)
		b.Name = strings.TrimSpace(b.Name)
		b.Description = strings.TrimSpace(b.Description)
		b.MCPURL = strings.TrimSpace(b.MCPURL)
		b.APIKey = strings.TrimSpace(b.APIKey)
	}
}

func invalid(field, rule, message string) error {
	return core.InvalidSetting("CLAUDEX_KNOWLEDGE_INVALID", field, rule, message)
}

func validate(s *Setting) error {
	if len(s.Bases) > maxBases {
		return invalid("bases", "max_items", fmt.Sprintf("At most %d knowledge bases.", maxBases))
	}
	seen := map[string]bool{}
	for i, b := range s.Bases {
		field := fmt.Sprintf("bases[%d]", i)
		if !baseID.MatchString(b.ID) {
			return invalid(field+".id", "pattern", "The id is lowercase letters, digits and dashes.")
		}
		if seen[b.ID] {
			return invalid(field+".id", "unique", "Each knowledge base needs its own id.")
		}
		seen[b.ID] = true
		if n := utf8.RuneCountInString(b.Name); n == 0 || n > maxNameLen {
			return invalid(field+".name", "length", "The name is 1 to 60 characters.")
		}
		if utf8.RuneCountInString(b.Description) > maxDescLen {
			return invalid(field+".description", "length", "The description is at most 200 characters.")
		}
		if err := checkURL(b.MCPURL); err != nil {
			return invalid(field+".mcp_url", "url", err.Error())
		}
		if len(b.APIKey) > maxAPIKeyLen {
			return invalid(field+".api_key", "length", "The key is at most 512 characters.")
		}
	}
	return nil
}

func checkURL(raw string) error {
	if raw == "" || len(raw) > maxURLLen {
		return fmt.Errorf("The MCP address is required (at most %d characters).", maxURLLen)
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
		return fmt.Errorf("The MCP address must be an http(s) URL without a password.")
	}
	return nil
}

// find returns the enabled base with this id.
func (s Setting) find(id string) (Base, bool) {
	for _, b := range s.Bases {
		if b.ID == id && b.Enabled {
			return b, true
		}
	}
	return Base{}, false
}
