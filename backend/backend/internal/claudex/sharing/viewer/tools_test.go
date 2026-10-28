package viewer

import (
	"encoding/xml"
	"io"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestArtifactToolDocuments(t *testing.T) {
	html := ToolDocument("<!DOCTYPE html><html><script>window.mcp.callTool('server','tool')</script></html>", LanguageHTML)
	require.True(t, strings.HasPrefix(html, "<!DOCTYPE html><script>"))
	require.Less(t, strings.Index(html, "const mcp"), strings.Index(html, "window.mcp.callTool"))
	svg := ToolDocument(`<svg xmlns="http://www.w3.org/2000/svg" data-label="a > b"><script>window.mcp.listTools()</script></svg>`, LanguageSVG)
	require.Contains(t, svg, "<![CDATA[")
	decoder := xml.NewDecoder(strings.NewReader(svg))
	for {
		_, err := decoder.Token()
		if err == io.EOF {
			break
		}
		require.NoError(t, err)
	}
	require.Equal(t, "<svg/>", ToolDocument("<svg/>", LanguageSVG))
	require.Equal(t, "plain", ToolDocument("plain", LanguageCode))
}

func TestArtifactToolHostPreservesFrameIsolation(t *testing.T) {
	rec := httptest.NewRecorder()
	require.NoError(t, Render(rec, "public", Snapshot{Kind: KindArtifact, Title: "Tools", Artifacts: []Artifact{{Language: LanguageHTML, Content: "<p>Tool</p>"}}}, time.Now(), Options{ArtifactURL: "https://content.example/s/public/a/0", FrameSource: "https://content.example"}))
	policy := rec.Header().Get("Content-Security-Policy")
	require.Contains(t, policy, "connect-src 'self'")
	require.Contains(t, policy, "frame-src https://content.example")
	require.Contains(t, rec.Body.String(), "data-artifact-tools")
	require.Contains(t, rec.Body.String(), "auth/refresh")
	require.Contains(t, rec.Body.String(), `sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"`)
	require.NotContains(t, rec.Body.String(), "allow-same-origin")
}
