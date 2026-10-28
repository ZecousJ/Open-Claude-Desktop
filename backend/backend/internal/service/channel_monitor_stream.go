package service

// CLAUDEX (owner, 2026-10-10): the channel monitors' probes are streamed
// like the users' requests, so the gateway's first-output failover moves a
// probe off a crawling account instead of reporting it; the status page then
// shows what users get. This file puts a streamed reply's text back together.

import (
	"bufio"
	"bytes"
	"io"
	"strings"

	"github.com/tidwall/gjson"
)

// readMonitorSSE reads a streamed reply up to its terminal event and the
// blank line after it, as a client would, and stops there: a relay may hold
// the connection open long after the reply (2026-10-10: 3-token replies
// "took" 20 to 125 s while the probe waited for EOF). At most limit bytes.
func readMonitorSSE(r io.Reader, limit int) ([]byte, error) {
	var out bytes.Buffer
	scanner := bufio.NewScanner(io.LimitReader(r, int64(limit)))
	scanner.Buffer(make([]byte, 64<<10), limit+1024)
	terminal := false
	for scanner.Scan() {
		line := scanner.Text()
		out.WriteString(line)
		out.WriteByte('\n')
		trimmed := strings.TrimSpace(line)
		switch {
		case trimmed == "" && terminal:
			return out.Bytes(), nil
		case strings.HasPrefix(trimmed, "event:"):
			if anthropicStreamEventIsTerminal(strings.TrimSpace(strings.TrimPrefix(trimmed, "event:")), "") {
				terminal = true
			}
		case strings.HasPrefix(trimmed, "data:"):
			data := strings.TrimSpace(strings.TrimPrefix(trimmed, "data:"))
			if data == "[DONE]" || anthropicStreamEventIsTerminal("", data) || openAIStreamEventTypeIsTerminal(gjson.Get(data, "type").String()) {
				terminal = true
			}
		}
	}
	return out.Bytes(), scanner.Err()
}

// looksLikeMonitorSSE reports whether a 2xx body is an event stream rather
// than one JSON document.
func looksLikeMonitorSSE(body []byte) bool {
	trimmed := bytes.TrimLeft(body, " \t\r\n")
	if len(trimmed) == 0 || trimmed[0] == '{' || trimmed[0] == '[' {
		return false
	}
	return bytes.HasPrefix(trimmed, []byte("data:")) || bytes.HasPrefix(trimmed, []byte("event:")) || bytes.HasPrefix(trimmed, []byte(":"))
}

// monitorStreamText collects the assistant text of a streamed reply, or the
// message of a failure event when the stream failed before finishing.
func monitorStreamText(provider, apiMode string, body []byte) (text, failure string) {
	var parts []string
	var completed []byte
	scanner := bufio.NewScanner(bytes.NewReader(body))
	scanner.Buffer(make([]byte, 64<<10), monitorResponseMaxBytes+1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" || data == "[DONE]" || !gjson.Valid(data) {
			continue
		}
		ev := gjson.Parse(data)
		if msg := monitorStreamFailure(ev); msg != "" {
			return "", msg
		}
		switch ev.Get("type").String() {
		case "response.output_text.delta": // Responses
			parts = append(parts, ev.Get("delta").String())
			continue
		case "response.completed":
			completed = []byte(ev.Get("response").Raw)
			continue
		case "content_block_delta": // Anthropic
			if ev.Get("delta.type").String() == "text_delta" {
				parts = append(parts, ev.Get("delta.text").String())
			}
			continue
		}
		// Chat Completions and the OpenAI-compatible providers.
		if delta := ev.Get("choices.0.delta.content"); delta.Exists() {
			parts = append(parts, delta.String())
		}
	}
	text = strings.Join(parts, "")
	if strings.TrimSpace(text) == "" && len(completed) > 0 {
		text = extractOpenAIResponsesText(completed)
	}
	_ = provider
	_ = apiMode
	return text, ""
}

// monitorStreamFailure is the message of a failure event, "" for any other.
func monitorStreamFailure(ev gjson.Result) string {
	switch ev.Get("type").String() {
	case "response.failed":
		return monitorFirstNonEmpty(ev.Get("response.error.message").String(), ev.Get("error.message").String(), "response failed")
	case "error":
		return monitorFirstNonEmpty(ev.Get("error.message").String(), ev.Get("message").String(), "stream error")
	}
	if msg := ev.Get("error.message").String(); msg != "" && !ev.Get("choices").Exists() && !ev.Get("delta").Exists() {
		return msg
	}
	return ""
}

func monitorFirstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
