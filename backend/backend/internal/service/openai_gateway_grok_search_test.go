//go:build unit

package service

// CLAUDEX: R45a regression tests. The desktop client's Research and web
// search go through the grok Responses pass-through unchanged (design R45
// 2.5): the built-in web_search and x_search tools, the include entries that
// ask xAI for sources, and the sources, citations and annotations of the
// answer must survive the gateway in both directions.

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
	"github.com/tidwall/gjson"
)

const grokSearchRequest = `{
	"model":"grok",
	"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"What happened today?"}]}],
	"tools":[
		{"type":"function","name":"shell","parameters":{"type":"object","properties":{}}},
		{"type":"web_search","external_web_access":true},
		{"type":"x_search"}
	],
	"include":["reasoning.encrypted_content","web_search_call.action.sources","x_search_call.action.sources"],
	"stream":%s
}`

func grokSearchBody(stream bool) []byte {
	s := "false"
	if stream {
		s = "true"
	}
	return []byte(strings.Replace(grokSearchRequest, "%s", s, 1))
}

func grokToolTypes(t *testing.T, body []byte) []string {
	t.Helper()
	var out []string
	for _, tool := range gjson.GetBytes(body, "tools").Array() {
		out = append(out, tool.Get("type").String())
	}
	return out
}

func grokIncludes(body []byte) []string {
	var out []string
	for _, v := range gjson.GetBytes(body, "include").Array() {
		out = append(out, v.String())
	}
	return out
}

func TestPatchGrokResponsesBodyKeepsSearchToolsAndSourceIncludes(t *testing.T) {
	patched, err := patchGrokResponsesBody(grokSearchBody(false), "grok-4.3")
	require.NoError(t, err)

	require.Equal(t, []string{"function", "web_search", "x_search"}, grokToolTypes(t, patched))
	require.Contains(t, grokIncludes(patched), "web_search_call.action.sources")
	require.Contains(t, grokIncludes(patched), "x_search_call.action.sources")
	// xAI rejects the OpenAI-only flag; everything else of the tool stays.
	require.NotContains(t, string(patched), "external_web_access")
	require.Equal(t, "grok-4.3", gjson.GetBytes(patched, "model").String())
}

func TestPatchGrokResponsesBodyPromotesSearchToolsFromTheAdditionalToolsCarrier(t *testing.T) {
	body := []byte(`{
		"model":"grok",
		"input":[
			{"type":"additional_tools","tools":[{"type":"web_search"},{"type":"x_search"}]},
			{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}
		],
		"tools":[{"type":"function","name":"shell","parameters":{"type":"object","properties":{}}}],
		"include":["web_search_call.action.sources"]
	}`)
	patched, _, err := patchGrokResponsesBodyWithClientTools(body, "grok-4.3")
	require.NoError(t, err)
	types := grokToolTypes(t, patched)
	require.Contains(t, types, "web_search")
	require.Contains(t, types, "x_search")
	require.NotContains(t, string(patched), `"additional_tools"`, "xAI rejects the carrier itself")
	require.Equal(t, []string{"web_search_call.action.sources"}, grokIncludes(patched))
}

func TestPatchGrokResponsesBodyDropsOnlyUnsupportedSearchTools(t *testing.T) {
	// web_search_preview is OpenAI-only; xAI would reject it, so the
	// pass-through drops it while keeping web_search and x_search.
	body := []byte(`{"model":"grok","input":"hi","tools":[{"type":"web_search_preview"},{"type":"web_search"},{"type":"x_search"}]}`)
	patched, err := patchGrokResponsesBody(body, "grok-4.3")
	require.NoError(t, err)
	require.Equal(t, []string{"web_search", "x_search"}, grokToolTypes(t, patched))
}

func newGrokSearchService(t *testing.T, id int64, resp *http.Response) (*OpenAIGatewayService, *httpUpstreamRecorder, *Account) {
	t.Helper()
	account := healthyGrokOAuthGatewayTestAccount(id, "access-token")
	repo := &mockAccountRepoForPlatform{accountsByID: map[int64]*Account{account.ID: account}}
	upstream := &httpUpstreamRecorder{resp: resp}
	return &OpenAIGatewayService{
		httpUpstream:      upstream,
		grokTokenProvider: NewGrokTokenProvider(repo, nil),
		accountRepo:       repo,
	}, upstream, account
}

func TestForwardGrokResponsesPassesSearchSourcesAndCitationsThrough(t *testing.T) {
	gin.SetMode(gin.TestMode)
	body := grokSearchBody(false)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/responses", bytes.NewReader(body))
	c.Request.Header.Set("Content-Type", "application/json")

	upstreamBody := `{
		"id":"resp_grok_search","object":"response","model":"grok-4.3","status":"completed",
		"output":[
			{"type":"web_search_call","id":"ws_1","status":"completed",
			 "action":{"type":"search","query":"news today","sources":[{"type":"url","url":"https://example.com/a"}]}},
			{"type":"x_search_call","id":"xs_1","status":"completed",
			 "action":{"type":"search","query":"news","sources":[{"type":"url","url":"https://x.com/example/status/1"}]}},
			{"type":"message","id":"msg_1","role":"assistant","status":"completed","content":[
				{"type":"output_text","text":"Something happened [[1]](https://example.com/a).",
				 "annotations":[{"type":"url_citation","url":"https://example.com/a","title":"A","start_index":20,"end_index":49}]}
			]}
		],
		"citations":["https://example.com/a","https://x.com/example/status/1"],
		"usage":{"input_tokens":12,"output_tokens":7}
	}`
	svc, upstream, account := newGrokSearchService(t, 9951, &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(upstreamBody)),
	})

	result, err := svc.forwardGrokResponses(context.Background(), c, account, body, "grok", false, time.Now())
	require.NoError(t, err)
	require.NotNil(t, result)
	require.Equal(t, 2, result.SearchCount, "one web and one X search are billed")

	// Upstream got both search tools and the source includes.
	sent := upstream.lastBody
	require.Equal(t, []string{"function", "web_search", "x_search"}, grokToolTypes(t, sent))
	require.Contains(t, grokIncludes(sent), "web_search_call.action.sources")
	require.Contains(t, grokIncludes(sent), "x_search_call.action.sources")

	// The client gets the sources, the annotations and the citations.
	out := recorder.Body.Bytes()
	require.Equal(t, "web_search_call", gjson.GetBytes(out, "output.0.type").String())
	require.Equal(t, "https://example.com/a", gjson.GetBytes(out, "output.0.action.sources.0.url").String())
	require.Equal(t, "x_search_call", gjson.GetBytes(out, "output.1.type").String())
	require.Equal(t, "https://x.com/example/status/1", gjson.GetBytes(out, "output.1.action.sources.0.url").String())
	ann := gjson.GetBytes(out, "output.2.content.0.annotations.0")
	require.Equal(t, "url_citation", ann.Get("type").String())
	require.Equal(t, "https://example.com/a", ann.Get("url").String())
	require.Equal(t, int64(20), ann.Get("start_index").Int())
	require.Equal(t, int64(49), ann.Get("end_index").Int())
	require.Equal(t, "https://x.com/example/status/1", gjson.GetBytes(out, "citations.1").String())
}

func TestForwardGrokResponsesStreamsSearchSourcesAndCitations(t *testing.T) {
	gin.SetMode(gin.TestMode)
	body := grokSearchBody(true)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/responses", bytes.NewReader(body))
	c.Request.Header.Set("Content-Type", "application/json")

	events := []string{
		`{"type":"response.created","response":{"id":"resp_s","status":"in_progress","output":[]}}`,
		`{"type":"response.output_item.done","output_index":0,"item":{"type":"web_search_call","id":"ws_1","status":"completed","action":{"type":"search","query":"q","sources":[{"type":"url","url":"https://example.com/a"}]}}}`,
		`{"type":"response.output_item.done","output_index":1,"item":{"type":"x_search_call","id":"xs_1","status":"completed","action":{"type":"search","query":"q","sources":[{"type":"url","url":"https://x.com/e/status/2"}]}}}`,
		`{"type":"response.output_text.delta","output_index":2,"content_index":0,"delta":"Answer [[1]](https://example.com/a)"}`,
		`{"type":"response.output_text.annotation.added","output_index":2,"content_index":0,"annotation_index":0,"annotation":{"type":"url_citation","url":"https://example.com/a","start_index":7,"end_index":35}}`,
		`{"type":"response.completed","response":{"id":"resp_s","status":"completed","citations":["https://example.com/a"],"output":[` +
			`{"type":"web_search_call","id":"ws_1","status":"completed"},{"type":"x_search_call","id":"xs_1","status":"completed"}],` +
			`"usage":{"input_tokens":3,"output_tokens":2}}}`,
	}
	var sse strings.Builder
	for _, e := range events {
		sse.WriteString("data: " + e + "\n\n")
	}
	svc, upstream, account := newGrokSearchService(t, 9952, &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
		Body:       io.NopCloser(strings.NewReader(sse.String())),
	})

	result, err := svc.forwardGrokResponses(context.Background(), c, account, body, "grok", true, time.Now())
	require.NoError(t, err)
	require.NotNil(t, result)
	require.Equal(t, 2, result.SearchCount, "item.done and response.completed count each search once")
	require.Equal(t, []string{"function", "web_search", "x_search"}, grokToolTypes(t, upstream.lastBody))

	out := recorder.Body.String()
	require.Contains(t, out, `"sources":[{"type":"url","url":"https://example.com/a"}]`)
	require.Contains(t, out, `"type":"x_search_call"`)
	require.Contains(t, out, `https://x.com/e/status/2`)
	require.Contains(t, out, `"type":"response.output_text.annotation.added"`)
	require.Contains(t, out, `"annotation":{"type":"url_citation","url":"https://example.com/a","start_index":7,"end_index":35}`)
	require.Contains(t, out, `"citations":["https://example.com/a"]`)
}
