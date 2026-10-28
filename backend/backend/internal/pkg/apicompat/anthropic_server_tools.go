package apicompat

import (
	"encoding/json"
	"strings"
	"unicode/utf8"
)

// CLAUDEX: Claude's server-side tools in Responses terms (owner,
// 2026-10-02: a Claude reply that searched showed no search). Claude runs
// web search and web fetch on Anthropic's side and streams a server_tool_use
// block (the query) followed by a *_tool_result block (the pages); text that
// relies on them carries citations. OpenAI's hosted search is a
// web_search_call item and url_citation annotations, which is what Codex and
// Claudex's source observer read, so the bridge turns one into the other:
//
//	server_tool_use web_search + web_search_tool_result → web_search_call, action "search" with the query and the result pages
//	server_tool_use web_fetch  + web_fetch_tool_result  → web_search_call, action "open_page" with the URL
//	text citations (web_search_result_location)          → url_citation annotations over the block's text
//
// Other server tools (code execution…) have no Responses item Codex shows;
// their blocks are passed over instead of leaking into function calls.

// serverToolAction is the web_search_call action a server tool call
// becomes; ok is false for a server tool without a Responses counterpart.
func serverToolAction(name, input string) (*WebSearchAction, bool) {
	var in struct {
		Query string `json:"query"`
		URL   string `json:"url"`
	}
	_ = json.Unmarshal([]byte(strings.TrimSpace(input)), &in)
	switch name {
	case "web_search":
		return &WebSearchAction{Type: "search", Query: in.Query}, true
	case "web_fetch":
		return &WebSearchAction{Type: "open_page", URL: in.URL}, true
	}
	return nil, false
}

// isServerToolResult tells a server tool's result block (web_search_tool_result,
// web_fetch_tool_result, code_execution_tool_result…) from a client tool_result.
func isServerToolResult(blockType string) bool {
	return blockType != "tool_result" && strings.HasSuffix(blockType, "_tool_result")
}

// serverToolResultSources reads the pages a result block names; failed is
// true for an error result (web_search_tool_result_error and the like).
func serverToolResultSources(block AnthropicContentBlock) (sources []WebSearchSource, failed bool) {
	raw := []byte(strings.TrimSpace(string(block.Content)))
	if len(raw) == 0 {
		return nil, false
	}
	if raw[0] == '[' {
		var results []AnthropicWebSearchResult
		if err := json.Unmarshal(raw, &results); err != nil {
			return nil, false
		}
		seen := map[string]bool{}
		for _, r := range results {
			url := strings.TrimSpace(r.URL)
			if url == "" || seen[url] {
				continue
			}
			seen[url] = true
			sources = append(sources, WebSearchSource{Type: "url", URL: url, Title: strings.TrimSpace(r.Title)})
		}
		return sources, false
	}
	var one struct {
		Type    string `json:"type"`
		URL     string `json:"url"`
		Content struct {
			Title string `json:"title"`
		} `json:"content"`
	}
	if err := json.Unmarshal(raw, &one); err != nil {
		return nil, false
	}
	if strings.HasSuffix(one.Type, "_error") {
		return nil, true
	}
	if url := strings.TrimSpace(one.URL); url != "" {
		sources = append(sources, WebSearchSource{Type: "url", URL: url, Title: strings.TrimSpace(one.Content.Title)})
	}
	return sources, false
}

// citationAnnotations are the url_citations of a text block: each cited page
// once, spanning the block's whole text (Claude cites by block).
func citationAnnotations(text string, cites []AnthropicCitation) []ResponsesAnnotation {
	if len(cites) == 0 || text == "" {
		return nil
	}
	end := utf8.RuneCountInString(text)
	seen := map[string]bool{}
	var out []ResponsesAnnotation
	for _, c := range cites {
		url := strings.TrimSpace(c.URL)
		if url == "" || seen[url] {
			continue
		}
		seen[url] = true
		out = append(out, ResponsesAnnotation{Type: "url_citation", URL: url, Title: strings.TrimSpace(c.Title), StartIndex: 0, EndIndex: end})
	}
	return out
}
