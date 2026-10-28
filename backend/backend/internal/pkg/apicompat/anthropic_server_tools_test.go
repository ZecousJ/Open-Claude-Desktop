package apicompat

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
)

// CLAUDEX: Claude's server-side search reaches Responses clients as OpenAI's
// hosted search does: a web_search_call item with its query and pages, and
// url_citation annotations on the text that relies on them.

func anthropicEvents(t *testing.T, lines ...string) []*AnthropicStreamEvent {
	t.Helper()
	out := make([]*AnthropicStreamEvent, 0, len(lines))
	for _, line := range lines {
		var evt AnthropicStreamEvent
		require.NoError(t, json.Unmarshal([]byte(line), &evt), line)
		out = append(out, &evt)
	}
	return out
}

func TestClaudeWebSearchStreamsAsWebSearchCall(t *testing.T) {
	state := NewAnthropicEventToResponsesState()
	var events []ResponsesStreamEvent
	for _, evt := range anthropicEvents(t,
		`{"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-5-5","usage":{"input_tokens":10}}}`,
		`{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
		`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Let me look."}}`,
		`{"type":"content_block_stop","index":0}`,
		`{"type":"content_block_start","index":1,"content_block":{"type":"server_tool_use","id":"srvtoolu_1","name":"web_search","input":{}}}`,
		`{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"query\": \"codex lead"}}`,
		`{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":" openai\"}"}}`,
		`{"type":"content_block_stop","index":1}`,
		`{"type":"content_block_start","index":2,"content_block":{"type":"web_search_tool_result","tool_use_id":"srvtoolu_1","content":[{"type":"web_search_result","url":"https://example.com/a","title":"A","encrypted_content":"x"},{"type":"web_search_result","url":"https://example.com/b","title":"B","encrypted_content":"y"}]}}`,
		`{"type":"content_block_stop","index":2}`,
		`{"type":"content_block_start","index":3,"content_block":{"type":"text","text":"","citations":[]}}`,
		`{"type":"content_block_delta","index":3,"delta":{"type":"citations_delta","citation":{"type":"web_search_result_location","url":"https://example.com/a","title":"A","cited_text":"..."}}}`,
		`{"type":"content_block_delta","index":3,"delta":{"type":"text_delta","text":"He leads Codex."}}`,
		`{"type":"content_block_stop","index":3}`,
		`{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":20}}`,
		`{"type":"message_stop"}`,
	) {
		events = append(events, AnthropicEventToResponsesEvents(evt, state)...)
	}

	var search *ResponsesOutput
	var types []string
	for _, e := range events {
		types = append(types, e.Type)
		if e.Type == "response.output_item.done" && e.Item != nil && e.Item.Type == "web_search_call" {
			search = e.Item
		}
		require.NotEqual(t, "response.function_call_arguments.delta", e.Type, "the query is not a function call")
	}
	require.NotNil(t, search, "a web_search_call item")
	require.Equal(t, "srvtoolu_1", search.ID)
	require.Equal(t, "completed", search.Status)
	require.Equal(t, "search", search.Action.Type)
	require.Equal(t, "codex lead openai", search.Action.Query)
	require.Equal(t, []WebSearchSource{{Type: "url", URL: "https://example.com/a", Title: "A"}, {Type: "url", URL: "https://example.com/b", Title: "B"}}, search.Action.Sources)
	require.Contains(t, types, "response.web_search_call.searching")
	require.Contains(t, types, "response.web_search_call.completed")

	// The text after the search carries its citation.
	final := events[len(events)-1]
	require.Equal(t, "response.completed", final.Type)
	var cited *ResponsesContentPart
	for _, out := range final.Response.Output {
		for i := range out.Content {
			if len(out.Content[i].Annotations) > 0 {
				cited = &out.Content[i]
			}
		}
	}
	require.NotNil(t, cited)
	require.Equal(t, "He leads Codex.", cited.Text)
	require.Equal(t, []ResponsesAnnotation{{Type: "url_citation", URL: "https://example.com/a", Title: "A", StartIndex: 0, EndIndex: 15}}, cited.Annotations)
	// Output order: the opening text, the search, the cited answer.
	require.Equal(t, []string{"message", "web_search_call", "message"}, outputTypes(final.Response.Output))
}

func outputTypes(outputs []ResponsesOutput) []string {
	out := make([]string, 0, len(outputs))
	for _, o := range outputs {
		out = append(out, o.Type)
	}
	return out
}

func TestClaudeServerToolsWithoutCounterpartLeaveNoTrace(t *testing.T) {
	state := NewAnthropicEventToResponsesState()
	var events []ResponsesStreamEvent
	for _, evt := range anthropicEvents(t,
		`{"type":"message_start","message":{"id":"msg_2","model":"claude-sonnet-5-5"}}`,
		`{"type":"content_block_start","index":0,"content_block":{"type":"server_tool_use","id":"srvtoolu_9","name":"code_execution","input":{}}}`,
		`{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"code\":\"print(1)\"}"}}`,
		`{"type":"content_block_stop","index":0}`,
		`{"type":"content_block_start","index":1,"content_block":{"type":"code_execution_tool_result","tool_use_id":"srvtoolu_9","content":{"type":"code_execution_result","stdout":"1"}}}`,
		`{"type":"content_block_stop","index":1}`,
		`{"type":"content_block_start","index":2,"content_block":{"type":"text","text":""}}`,
		`{"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"1"}}`,
		`{"type":"content_block_stop","index":2}`,
		`{"type":"message_stop"}`,
	) {
		events = append(events, AnthropicEventToResponsesEvents(evt, state)...)
	}
	for _, e := range events {
		require.NotEqual(t, "response.function_call_arguments.delta", e.Type)
	}
	final := events[len(events)-1]
	require.Equal(t, []string{"message"}, outputTypes(final.Response.Output))
}

func TestClaudeWebSearchNonStreaming(t *testing.T) {
	var resp AnthropicResponse
	require.NoError(t, json.Unmarshal([]byte(`{"id":"msg_3","model":"claude-sonnet-5-5","content":[
		{"type":"server_tool_use","id":"srvtoolu_2","name":"web_search","input":{"query":"weather"}},
		{"type":"web_search_tool_result","tool_use_id":"srvtoolu_2","content":[{"type":"web_search_result","url":"https://w.example","title":"W"}]},
		{"type":"server_tool_use","id":"srvtoolu_3","name":"web_fetch","input":{"url":"https://w.example/today"}},
		{"type":"web_fetch_tool_result","tool_use_id":"srvtoolu_3","content":{"type":"web_fetch_result","url":"https://w.example/today","content":{"type":"document","title":"Today"}}},
		{"type":"text","text":"Sunny.","citations":[{"type":"web_search_result_location","url":"https://w.example","title":"W"}]}
	],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}`), &resp))
	out := AnthropicToResponsesResponse(&resp)
	require.Equal(t, []string{"web_search_call", "web_search_call", "message"}, outputTypes(out.Output))
	require.Equal(t, &WebSearchAction{Type: "search", Query: "weather", Sources: []WebSearchSource{{Type: "url", URL: "https://w.example", Title: "W"}}}, out.Output[0].Action)
	require.Equal(t, "open_page", out.Output[1].Action.Type)
	require.Equal(t, "https://w.example/today", out.Output[1].Action.URL)
	require.Equal(t, "url_citation", out.Output[2].Content[0].Annotations[0].Type)

	// An error result marks the search failed.
	require.NoError(t, json.Unmarshal([]byte(`{"id":"msg_4","model":"claude-sonnet-5-5","content":[
		{"type":"server_tool_use","id":"srvtoolu_5","name":"web_search","input":{"query":"x"}},
		{"type":"web_search_tool_result","tool_use_id":"srvtoolu_5","content":{"type":"web_search_tool_result_error","error_code":"max_uses_exceeded"}},
		{"type":"text","text":"Sorry."}
	]}`), &resp))
	out = AnthropicToResponsesResponse(&resp)
	require.Equal(t, "failed", out.Output[0].Status)
}

// Claude may start several searches before any result (parallel searches):
// each keeps its own query and its own pages.
func TestClaudeParallelWebSearches(t *testing.T) {
	state := NewAnthropicEventToResponsesState()
	var events []ResponsesStreamEvent
	for _, evt := range anthropicEvents(t,
		`{"type":"message_start","message":{"id":"msg_5","model":"claude-sonnet-5-5"}}`,
		`{"type":"content_block_start","index":0,"content_block":{"type":"text","text":"","citations":[]}}`,
		`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Searching."}}`,
		`{"type":"content_block_stop","index":0}`,
		`{"type":"content_block_start","index":1,"content_block":{"type":"server_tool_use","id":"srvtoolu_a","name":"web_search","input":{}}}`,
		`{"type":"content_block_start","index":2,"content_block":{"type":"server_tool_use","id":"srvtoolu_b","name":"web_search","input":{}}}`,
		`{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"query\":\"first\"}"}}`,
		`{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"query\":\"second\"}"}}`,
		`{"type":"content_block_stop","index":1}`,
		`{"type":"content_block_stop","index":2}`,
		`{"type":"content_block_start","index":3,"content_block":{"type":"web_search_tool_result","tool_use_id":"srvtoolu_a","content":[{"type":"web_search_result","url":"https://a.example","title":"A"}]}}`,
		`{"type":"content_block_stop","index":3}`,
		`{"type":"content_block_start","index":4,"content_block":{"type":"web_search_tool_result","tool_use_id":"srvtoolu_b","content":[{"type":"web_search_result","url":"https://b.example","title":"B"}]}}`,
		`{"type":"content_block_stop","index":4}`,
		`{"type":"content_block_start","index":5,"content_block":{"type":"text","text":""}}`,
		`{"type":"content_block_delta","index":5,"delta":{"type":"text_delta","text":"Done."}}`,
		`{"type":"content_block_stop","index":5}`,
		`{"type":"message_stop"}`,
	) {
		events = append(events, AnthropicEventToResponsesEvents(evt, state)...)
	}
	done := map[string]*ResponsesOutput{}
	indexes := map[string]int{}
	for _, e := range events {
		if e.Type == "response.output_item.done" && e.Item.Type == "web_search_call" {
			done[e.Item.ID] = e.Item
			indexes[e.Item.ID] = e.OutputIndex
		}
	}
	require.Equal(t, "first", done["srvtoolu_a"].Action.Query)
	require.Equal(t, "https://a.example", done["srvtoolu_a"].Action.Sources[0].URL)
	require.Equal(t, "second", done["srvtoolu_b"].Action.Query)
	require.Equal(t, "https://b.example", done["srvtoolu_b"].Action.Sources[0].URL)
	require.Equal(t, 1, indexes["srvtoolu_a"])
	require.Equal(t, 2, indexes["srvtoolu_b"])
	final := events[len(events)-1]
	require.Equal(t, []string{"message", "web_search_call", "web_search_call", "message"}, outputTypes(final.Response.Output))
}

// The streamed wire form keeps what the search found: the item's action, the
// progress events' output slot and the text's citations.
func TestClaudeWebSearchWireKeepsActionAndCitations(t *testing.T) {
	done, err := json.Marshal(ResponsesStreamEvent{Type: "response.output_item.done", OutputIndex: 0, Item: &ResponsesOutput{
		Type: "web_search_call", ID: "srvtoolu_1", Status: "completed",
		Action: &WebSearchAction{Type: "search", Query: "q", Sources: []WebSearchSource{{Type: "url", URL: "https://a.example", Title: "A"}}},
	}})
	require.NoError(t, err)
	require.JSONEq(t, `{"type":"response.output_item.done","sequence_number":0,"output_index":0,"item":{"type":"web_search_call","id":"srvtoolu_1","status":"completed","action":{"type":"search","query":"q","sources":[{"type":"url","url":"https://a.example","title":"A"}]}}}`, string(done))

	progress, err := json.Marshal(ResponsesStreamEvent{Type: "response.web_search_call.searching", ItemID: "srvtoolu_1"})
	require.NoError(t, err)
	require.JSONEq(t, `{"type":"response.web_search_call.searching","sequence_number":0,"output_index":0,"item_id":"srvtoolu_1"}`, string(progress))

	cite := []ResponsesAnnotation{{Type: "url_citation", URL: "https://a.example", Title: "A", EndIndex: 3}}
	part, err := json.Marshal(ResponsesStreamEvent{Type: "response.content_part.done", ItemID: "m", Part: &ResponsesContentPart{Type: "output_text", Text: "abc", Annotations: cite}})
	require.NoError(t, err)
	require.Contains(t, string(part), `"annotations":[{"type":"url_citation","url":"https://a.example","title":"A","start_index":0,"end_index":3}]`)
	msg, err := json.Marshal(ResponsesStreamEvent{Type: "response.output_item.done", Item: &ResponsesOutput{Type: "message", ID: "m", Content: []ResponsesContentPart{{Type: "output_text", Text: "abc", Annotations: cite}}}})
	require.NoError(t, err)
	require.Contains(t, string(msg), `"annotations":[{"type":"url_citation"`)
}
