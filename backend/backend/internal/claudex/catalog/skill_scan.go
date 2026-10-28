package catalog

import (
	"bytes"
	"net/http"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/gin-gonic/gin"
)

var unsafeSkillContent = []*regexp.Regexp{
	regexp.MustCompile(`EICAR-STANDARD-ANTIVIRUS-TEST-FILE`),
	regexp.MustCompile(`(?i)(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b`),
	regexp.MustCompile(`(?i)(bash|sh)\s+-i\s+[^\n]*/dev/tcp/`),
	regexp.MustCompile(`(?i)(ignore|disregard)\s+(all\s+)?(previous|system|developer)\s+(instructions|prompts)`),
	regexp.MustCompile(`(?i)(curl|wget|fetch)\b[^\n]*(\.ssh/id_|\.aws/credentials|\.codex/auth\.json)`),
}

var skillScanName = regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`)

func skillContentSafe(name string, content []byte) bool {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".exe", ".dll", ".dylib", ".so", ".com", ".scr":
		return false
	}
	if bytes.HasPrefix(content, []byte{0x7f, 'E', 'L', 'F'}) || bytes.HasPrefix(content, []byte("MZ")) {
		return false
	}
	for _, pattern := range unsafeSkillContent {
		if pattern.Match(content) {
			return false
		}
	}
	return true
}

// (live claude.ai bundle, 2026-10-14, c08f249ae-BgWp6G39: content_scan)
func (c *Component) scanSkill(g *gin.Context) {
	if _, ok := core.Subject(g); !ok {
		response.Error(g, 401, "Unauthorized")
		return
	}
	var body struct {
		Name  string `json:"name"`
		Files []struct {
			Path string `json:"path"`
			Data []byte `json:"data"`
		} `json:"files"`
	}
	g.Request.Body = http.MaxBytesReader(g.Writer, g.Request.Body, 30*1024*1024)
	if g.ShouldBindJSON(&body) != nil || len(body.Files) == 0 || len(body.Files) > 500 || !skillScanName.MatchString(body.Name) {
		response.Error(g, 400, "Failed to submit. You can try again.")
		return
	}
	total := 0
	for _, file := range body.Files {
		total += len(file.Data)
		if total > 20*1024*1024 || len(file.Path) > 4096 {
			response.Error(g, 413, "Skills can be up to 500 files and 20 MB.")
			return
		}
		if !skillContentSafe(file.Path, file.Data) {
			response.Error(g, 400, body.Name+" can’t be added because it didn’t pass the security scan")
			return
		}
	}
	response.Success(g, map[string]bool{"passed": true})
}
