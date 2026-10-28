package accountguard

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"
)

const probeTimeout = 60 * time.Second

// target is what a probe needs of an account.
type target struct {
	id       int64
	platform string
	baseURL  string
	apiKey   string
	models   []string // the account's model mapping keys
}

// probeModel picks a small chat model the account serves; "" when it serves
// none (an image-only account is not probed).
func probeModel(platform string, models []string) string {
	chat := make([]string, 0, len(models))
	for _, m := range models {
		l := strings.ToLower(m)
		if strings.Contains(l, "image") || strings.Contains(l, "video") || strings.Contains(l, "imagine") {
			continue
		}
		chat = append(chat, m)
	}
	sort.Strings(chat)
	prefer := map[string][]string{
		"openai":    {"gpt-6-astra", "gpt-6-sol", "gpt-6.1-sol", "gpt-5.5"},
		"anthropic": {"claude-haiku-4-5", "claude-sonnet-4-6", "claude-sonnet-5", "claude-sonnet-5-5"},
		"grok":      {"grok-4.5", "grok-4.6", "grok-4.7"},
	}[platform]
	for _, p := range prefer {
		for _, m := range chat {
			if m == p || strings.HasPrefix(m, p+"-") {
				return m
			}
		}
	}
	if len(chat) > 0 {
		return chat[0]
	}
	return ""
}

// endpoint joins a base URL and an API path, whether or not the base ends in /v1.
func endpoint(base, path string) string {
	base = strings.TrimRight(strings.TrimSpace(base), "/")
	if strings.HasSuffix(base, "/v1") {
		return base + path
	}
	return base + "/v1" + path
}

// probe asks the account for a one-word reply with its own key, straight to
// its upstream; nil when a real reply came back.
func probe(ctx context.Context, client *http.Client, t target) error {
	model := probeModel(t.platform, t.models)
	if model == "" {
		return errNoModel
	}
	if strings.TrimSpace(t.baseURL) == "" || strings.TrimSpace(t.apiKey) == "" {
		return errors.New("no base URL or key")
	}
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	started := time.Now()
	var err error
	switch t.platform {
	case "openai":
		err = probeResponses(ctx, client, t, model)
	case "anthropic":
		err = probeMessages(ctx, client, t, model)
	default:
		err = probeChat(ctx, client, t, model)
	}
	return slowAnswer(err, time.Since(started))
}

// slowAnswer turns an answer that took longer than slowProbe into a failure.
func slowAnswer(err error, took time.Duration) error {
	if err == nil && took > slowProbe {
		return fmt.Errorf("answered, but slowly: %s", took.Round(time.Second))
	}
	return err
}

var errNoModel = errors.New("no chat model to probe")

const probePrompt = "Reply with the single word OK."

func probeResponses(ctx context.Context, client *http.Client, t target, model string) error {
	body, _ := json.Marshal(map[string]any{
		"model": model, "stream": true, "store": false,
		"input": []any{map[string]any{"type": "message", "role": "user",
			"content": []any{map[string]any{"type": "input_text", "text": probePrompt}}}},
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint(t.baseURL, "/responses"), bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+t.apiKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	// Some relays only serve the Codex client.
	req.Header.Set("User-Agent", "codex_cli_rs/0.144.1 (Mac OS 15.0; arm64) iTerm.app")
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		return statusError(res)
	}
	return readResponsesStream(res.Body)
}

// readResponsesStream succeeds on output text or a completed response and
// fails on a failed one, an error event or a stream that ends with neither.
func readResponsesStream(r io.Reader) error {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 64<<10), 4<<20)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		var ev struct {
			Type     string `json:"type"`
			Message  string `json:"message"`
			Response struct {
				Error *struct {
					Message string `json:"message"`
				} `json:"error"`
			} `json:"response"`
		}
		if json.Unmarshal([]byte(data), &ev) != nil {
			continue
		}
		switch ev.Type {
		case "response.output_text.delta", "response.completed":
			return nil
		case "response.failed", "error":
			msg := ev.Message
			if ev.Response.Error != nil && ev.Response.Error.Message != "" {
				msg = ev.Response.Error.Message
			}
			return fmt.Errorf("upstream: %s", clip(msg, 200))
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	return errors.New("stream ended without a reply")
}

func probeMessages(ctx context.Context, client *http.Client, t target, model string) error {
	body, _ := json.Marshal(map[string]any{
		"model": model, "max_tokens": 16,
		"messages": []any{map[string]any{"role": "user", "content": probePrompt}},
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint(t.baseURL, "/messages"), bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("x-api-key", t.apiKey)
	req.Header.Set("Authorization", "Bearer "+t.apiKey)
	req.Header.Set("anthropic-version", "2023-06-01")
	req.Header.Set("Content-Type", "application/json")
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		return statusError(res)
	}
	var out struct {
		Content []json.RawMessage `json:"content"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&out); err != nil {
		return err
	}
	if len(out.Content) == 0 {
		return errors.New("empty reply")
	}
	return nil
}

func probeChat(ctx context.Context, client *http.Client, t target, model string) error {
	body, _ := json.Marshal(map[string]any{
		"model": model, "max_tokens": 16,
		"messages": []any{map[string]any{"role": "user", "content": probePrompt}},
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint(t.baseURL, "/chat/completions"), bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+t.apiKey)
	req.Header.Set("Content-Type", "application/json")
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		return statusError(res)
	}
	var out struct {
		Choices []json.RawMessage `json:"choices"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&out); err != nil {
		return err
	}
	if len(out.Choices) == 0 {
		return errors.New("empty reply")
	}
	return nil
}

func statusError(res *http.Response) error {
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 2048))
	return fmt.Errorf("HTTP %d: %s", res.StatusCode, clip(strings.TrimSpace(string(raw)), 200))
}

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
