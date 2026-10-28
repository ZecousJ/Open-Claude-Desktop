package viewer

import (
	"encoding/xml"
	"strings"
)

// ToolDocument adds only the credential-free parent messaging API. The opaque
// artifact frame cannot reach the authenticated RPC endpoint itself.
func ToolDocument(content, language string) string {
	script := mustRead("templates/tool-api.js")
	if language == LanguageHTML {
		prefix := ""
		if strings.HasPrefix(strings.ToLower(strings.TrimSpace(content)), "<!doctype") {
			if end := strings.Index(content, ">"); end >= 0 {
				prefix, content = content[:end+1], content[end+1:]
			}
		}
		return prefix + "<script>" + script + "</script>" + content
	}
	if language == LanguageSVG {
		decoder := xml.NewDecoder(strings.NewReader(content))
		for {
			token, err := decoder.Token()
			if err != nil {
				break
			}
			if start, ok := token.(xml.StartElement); ok {
				end := int(decoder.InputOffset())
				if start.Name.Local == "svg" && !strings.HasSuffix(content[:end], "/>") {
					return content[:end] + "<script><![CDATA[" + script + "]]></script>" + content[end:]
				}
				break
			}
		}
	}
	return content
}
