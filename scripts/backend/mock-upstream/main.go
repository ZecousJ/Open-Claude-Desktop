// mock-upstream: a tiny OpenAI-compatible upstream for the Claudex / Sub2API dev stack.
//
// It never talks to any real provider. Every answer is synthetic and deterministic.
//
// Endpoints (each also served without the /v1 prefix):
//
//	GET  /health
//	GET  /v1/models
//	POST /v1/chat/completions   (stream=false | stream=true SSE, usage chunk when stream_options.include_usage)
//	POST /v1/responses          (stream=false | stream=true SSE with response.* events, usage in response.completed)
//	GET  /pricing/model_prices_and_context_window.json|.sha256  (no auth; serves MOCK_PRICING_FILE so
//	     Sub2API's pricing remote-sync can be pointed here instead of raw.githubusercontent.com)
//
// Behaviour knobs (environment):
//
//	PORT                 listen port (default 8090)
//	MOCK_API_KEY         if set, the Bearer token / x-api-key must equal it, else 401
//	MOCK_STREAM_DELAY_MS delay between SSE deltas (default 15)
//	MOCK_STREAM_USAGE    "auto" (default, OpenAI semantics) | "always" (chat stream always ends with a usage chunk)
//	MOCK_PRICING_FILE    JSON file served under /pricing/ (default /data/model_prices_and_context_window.json)
//
// Magic models for failure testing: a model name containing "error-429", "error-500",
// "error-401" or "slow" triggers the matching failure / a 3s delay.
package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

var (
	apiKey      = os.Getenv("MOCK_API_KEY")
	streamDelay = envInt("MOCK_STREAM_DELAY_MS", 15)
	streamUsage = envStr("MOCK_STREAM_USAGE", "auto")
	reqCounter  atomic.Int64
	models      = []string{"gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-4o-mini", "mock-echo"}
)

func envStr(k, d string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return d
}

func envInt(k string, d int) int {
	if v, err := strconv.Atoi(os.Getenv(k)); err == nil && v >= 0 {
		return v
	}
	return d
}

func randID(prefix string) string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return prefix + hex.EncodeToString(b)
}

// approxTokens is a cheap deterministic token estimate (~4 chars per token, min 1).
func approxTokens(s string) int {
	n := (len([]rune(s)) + 3) / 4
	if n < 1 {
		n = 1
	}
	return n
}

// contentText flattens OpenAI "content" (string or array of parts) to text.
func contentText(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case []any:
		var sb strings.Builder
		for _, p := range t {
			if m, ok := p.(map[string]any); ok {
				for _, k := range []string{"text", "input_text", "output_text"} {
					if s, ok := m[k].(string); ok {
						sb.WriteString(s)
						sb.WriteString(" ")
					}
				}
			}
		}
		return strings.TrimSpace(sb.String())
	case map[string]any:
		if s, ok := t["text"].(string); ok {
			return s
		}
	}
	return ""
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func oaiError(w http.ResponseWriter, status int, typ, code, msg string) {
	writeJSON(w, status, map[string]any{"error": map[string]any{"message": msg, "type": typ, "code": code, "param": nil}})
}

// checkAuth validates the synthetic credential. Returns false (and writes 401) on failure.
func checkAuth(w http.ResponseWriter, r *http.Request) bool {
	tok := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	if tok == "" {
		tok = strings.TrimSpace(r.Header.Get("x-api-key"))
	}
	if tok == "" || (apiKey != "" && tok != apiKey) {
		oaiError(w, http.StatusUnauthorized, "invalid_request_error", "invalid_api_key", "mock-upstream: missing or invalid API key")
		return false
	}
	return true
}

// magic handles failure-injection model names. Returns true if it already answered.
func magic(w http.ResponseWriter, model string) bool {
	switch {
	case strings.Contains(model, "error-429"):
		w.Header().Set("Retry-After", "1")
		oaiError(w, http.StatusTooManyRequests, "rate_limit_error", "rate_limit_exceeded", "mock-upstream: synthetic rate limit")
		return true
	case strings.Contains(model, "error-500"):
		oaiError(w, http.StatusInternalServerError, "server_error", "internal_error", "mock-upstream: synthetic server error")
		return true
	case strings.Contains(model, "error-401"):
		oaiError(w, http.StatusUnauthorized, "invalid_request_error", "invalid_api_key", "mock-upstream: synthetic auth failure")
		return true
	case strings.Contains(model, "slow"):
		time.Sleep(3 * time.Second)
	}
	return false
}

func replyFor(model, prompt string) string {
	p := strings.Join(strings.Fields(prompt), " ")
	if r := []rune(p); len(r) > 60 {
		p = string(r[:60]) + "..."
	}
	return fmt.Sprintf("This is a synthetic reply from mock-upstream (model %s). You said: %s", model, p)
}

// words splits text into stream deltas that concatenate back to the original.
func words(s string) []string {
	var out []string
	for i, w := range strings.Split(s, " ") {
		if i > 0 {
			w = " " + w
		}
		out = append(out, w)
	}
	return out
}

type sse struct {
	w http.ResponseWriter
	f http.Flusher
}

func newSSE(w http.ResponseWriter) *sse {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	f, _ := w.(http.Flusher)
	return &sse{w: w, f: f}
}

func (s *sse) send(event string, v any) {
	b, _ := json.Marshal(v)
	if event != "" {
		fmt.Fprintf(s.w, "event: %s\n", event)
	}
	fmt.Fprintf(s.w, "data: %s\n\n", b)
	if s.f != nil {
		s.f.Flush()
	}
}

func (s *sse) done() {
	fmt.Fprint(s.w, "data: [DONE]\n\n")
	if s.f != nil {
		s.f.Flush()
	}
}

func sleepDelta() {
	if streamDelay > 0 {
		time.Sleep(time.Duration(streamDelay) * time.Millisecond)
	}
}

func readBody(w http.ResponseWriter, r *http.Request) (map[string]any, bool) {
	b, err := io.ReadAll(io.LimitReader(r.Body, 32<<20))
	if err != nil {
		oaiError(w, http.StatusBadRequest, "invalid_request_error", "bad_body", "mock-upstream: cannot read body")
		return nil, false
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		oaiError(w, http.StatusBadRequest, "invalid_request_error", "invalid_json", "mock-upstream: body is not JSON")
		return nil, false
	}
	return m, true
}

func handleModels(w http.ResponseWriter, r *http.Request) {
	if !checkAuth(w, r) {
		return
	}
	data := make([]map[string]any, 0, len(models))
	for _, m := range models {
		data = append(data, map[string]any{"id": m, "object": "model", "created": 1767225600, "owned_by": "mock-upstream"})
	}
	writeJSON(w, http.StatusOK, map[string]any{"object": "list", "data": data})
}

func handleChat(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		oaiError(w, http.StatusMethodNotAllowed, "invalid_request_error", "method_not_allowed", "use POST")
		return
	}
	if !checkAuth(w, r) {
		return
	}
	body, ok := readBody(w, r)
	if !ok {
		return
	}
	model, _ := body["model"].(string)
	if model == "" {
		model = "gpt-4o-mini"
	}
	if magic(w, model) {
		logReq(r, model, false, 0, 0, "magic")
		return
	}
	var all, last strings.Builder
	if msgs, ok := body["messages"].([]any); ok {
		for _, m := range msgs {
			mm, _ := m.(map[string]any)
			t := contentText(mm["content"])
			all.WriteString(t)
			all.WriteString("\n")
			if role, _ := mm["role"].(string); role == "user" {
				last.Reset()
				last.WriteString(t)
			}
		}
	}
	reply := replyFor(model, last.String())
	pt, ct := approxTokens(all.String())+8, approxTokens(reply)
	usage := map[string]any{
		"prompt_tokens": pt, "completion_tokens": ct, "total_tokens": pt + ct,
		"prompt_tokens_details":     map[string]any{"cached_tokens": 0, "audio_tokens": 0},
		"completion_tokens_details": map[string]any{"reasoning_tokens": 0, "audio_tokens": 0},
	}
	id := randID("chatcmpl-mock")
	created := time.Now().Unix()
	stream, _ := body["stream"].(bool)
	logReq(r, model, stream, pt, ct, "ok")
	if !stream {
		writeJSON(w, http.StatusOK, map[string]any{
			"id": id, "object": "chat.completion", "created": created, "model": model,
			"system_fingerprint": "fp_mock",
			"choices": []any{map[string]any{
				"index": 0, "finish_reason": "stop", "logprobs": nil,
				"message": map[string]any{"role": "assistant", "content": reply, "refusal": nil},
			}},
			"usage": usage,
		})
		return
	}
	includeUsage := streamUsage == "always"
	if so, ok := body["stream_options"].(map[string]any); ok {
		if v, ok := so["include_usage"].(bool); ok && v {
			includeUsage = true
		}
	}
	s := newSSE(w)
	chunk := func(delta map[string]any, finish any) map[string]any {
		c := map[string]any{
			"id": id, "object": "chat.completion.chunk", "created": created, "model": model,
			"system_fingerprint": "fp_mock",
			"choices":            []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finish, "logprobs": nil}},
		}
		if includeUsage {
			c["usage"] = nil
		}
		return c
	}
	s.send("", chunk(map[string]any{"role": "assistant", "content": ""}, nil))
	for _, p := range words(reply) {
		sleepDelta()
		s.send("", chunk(map[string]any{"content": p}, nil))
	}
	s.send("", chunk(map[string]any{}, "stop"))
	if includeUsage {
		s.send("", map[string]any{
			"id": id, "object": "chat.completion.chunk", "created": created, "model": model,
			"system_fingerprint": "fp_mock", "choices": []any{}, "usage": usage,
		})
	}
	s.done()
}

func handleResponses(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		oaiError(w, http.StatusMethodNotAllowed, "invalid_request_error", "method_not_allowed", "use POST")
		return
	}
	if !checkAuth(w, r) {
		return
	}
	body, ok := readBody(w, r)
	if !ok {
		return
	}
	model, _ := body["model"].(string)
	if model == "" {
		model = "gpt-5.5"
	}
	if magic(w, model) {
		logReq(r, model, false, 0, 0, "magic")
		return
	}
	var all, last strings.Builder
	if ins, ok := body["instructions"].(string); ok {
		all.WriteString(ins + "\n")
	}
	switch in := body["input"].(type) {
	case string:
		all.WriteString(in)
		last.WriteString(in)
	case []any:
		for _, it := range in {
			m, _ := it.(map[string]any)
			t := contentText(m["content"])
			all.WriteString(t + "\n")
			if role, _ := m["role"].(string); role == "user" || role == "" {
				last.Reset()
				last.WriteString(t)
			}
		}
	}
	reply := replyFor(model, last.String())
	it, ot := approxTokens(all.String())+8, approxTokens(reply)
	usage := map[string]any{
		"input_tokens": it, "output_tokens": ot, "total_tokens": it + ot,
		"input_tokens_details":  map[string]any{"cached_tokens": 0},
		"output_tokens_details": map[string]any{"reasoning_tokens": 0},
	}
	respID, msgID := randID("resp_mock"), randID("msg_mock")
	created := time.Now().Unix()
	textPart := map[string]any{"type": "output_text", "text": reply, "annotations": []any{}, "logprobs": []any{}}
	msgItem := map[string]any{"type": "message", "id": msgID, "status": "completed", "role": "assistant", "content": []any{textPart}}
	resp := func(status string, output []any, u any) map[string]any {
		return map[string]any{
			"id": respID, "object": "response", "created_at": created, "status": status,
			"model": model, "output": output, "usage": u, "error": nil, "incomplete_details": nil,
			"instructions": body["instructions"], "parallel_tool_calls": true, "tool_choice": "auto",
			"tools": []any{}, "store": false, "metadata": map[string]any{},
		}
	}
	stream, _ := body["stream"].(bool)
	logReq(r, model, stream, it, ot, "ok")
	if !stream {
		writeJSON(w, http.StatusOK, resp("completed", []any{msgItem}, usage))
		return
	}
	s := newSSE(w)
	seq := 0
	ev := func(typ string, fields map[string]any) {
		fields["type"] = typ
		fields["sequence_number"] = seq
		seq++
		s.send(typ, fields)
	}
	ev("response.created", map[string]any{"response": resp("in_progress", []any{}, nil)})
	ev("response.in_progress", map[string]any{"response": resp("in_progress", []any{}, nil)})
	ev("response.output_item.added", map[string]any{"output_index": 0,
		"item": map[string]any{"type": "message", "id": msgID, "status": "in_progress", "role": "assistant", "content": []any{}}})
	ev("response.content_part.added", map[string]any{"item_id": msgID, "output_index": 0, "content_index": 0,
		"part": map[string]any{"type": "output_text", "text": "", "annotations": []any{}}})
	for _, p := range words(reply) {
		sleepDelta()
		ev("response.output_text.delta", map[string]any{"item_id": msgID, "output_index": 0, "content_index": 0, "delta": p, "logprobs": []any{}})
	}
	ev("response.output_text.done", map[string]any{"item_id": msgID, "output_index": 0, "content_index": 0, "text": reply, "logprobs": []any{}})
	ev("response.content_part.done", map[string]any{"item_id": msgID, "output_index": 0, "content_index": 0, "part": textPart})
	ev("response.output_item.done", map[string]any{"output_index": 0, "item": msgItem})
	ev("response.completed", map[string]any{"response": resp("completed", []any{msgItem}, usage)})
}

func logReq(r *http.Request, model string, stream bool, in, out int, outcome string) {
	n := reqCounter.Add(1)
	ua := r.Header.Get("User-Agent")
	if len(ua) > 60 {
		ua = ua[:60]
	}
	log.Printf(`{"n":%d,"method":%q,"path":%q,"model":%q,"stream":%t,"input_tokens":%d,"output_tokens":%d,"outcome":%q,"ua":%q}`,
		n, r.Method, r.URL.Path, model, stream, in, out, outcome, ua)
}

func handlePricing(w http.ResponseWriter, r *http.Request) {
	b, err := os.ReadFile(envStr("MOCK_PRICING_FILE", "/data/model_prices_and_context_window.json"))
	if err != nil {
		oaiError(w, http.StatusNotFound, "invalid_request_error", "not_found", "mock-upstream: no pricing file mounted")
		return
	}
	if strings.HasSuffix(r.URL.Path, ".sha256") {
		sum := sha256.Sum256(b)
		w.Header().Set("Content-Type", "text/plain")
		fmt.Fprintf(w, "%s  model_prices_and_context_window.json\n", hex.EncodeToString(sum[:]))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(b)
}

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "service": "mock-upstream", "requests": reqCounter.Load()})
	})
	for _, prefix := range []string{"/v1", ""} {
		mux.HandleFunc(prefix+"/models", handleModels)
		mux.HandleFunc(prefix+"/chat/completions", handleChat)
		mux.HandleFunc(prefix+"/responses", handleResponses)
	}
	mux.HandleFunc("/pricing/", handlePricing)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		log.Printf(`{"method":%q,"path":%q,"outcome":"404"}`, r.Method, r.URL.Path)
		oaiError(w, http.StatusNotFound, "invalid_request_error", "not_found", "mock-upstream: unknown route "+r.URL.Path)
	})
	addr := ":" + envStr("PORT", "8090")
	log.Printf("mock-upstream listening on %s (auth=%v, stream_delay_ms=%d, stream_usage=%s)", addr, apiKey != "", streamDelay, streamUsage)
	srv := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	log.Fatal(srv.ListenAndServe())
}
