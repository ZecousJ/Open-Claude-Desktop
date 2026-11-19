package handler

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
)

var codexSelectedPageName = regexp.MustCompile(`^codex_apps_selected_page_part_[1-9][0-9]*_of_[1-9][0-9]*$`)

// Codex supplies page context without a model tool call. Keep it as untrusted
// context instead of forwarding an unpaired tool result to a Responses relay.
func normalizeCodexPageContext(body []byte) ([]byte, bool) {
	if !bytes.Contains(body, []byte("codex_apps_")) {
		return body, false
	}
	normalized := body
	changed := false
	for i, item := range gjson.GetBytes(body, "input").Array() {
		if item.Get("type").String() != "function_call_output" || item.Get("namespace").String() != "agent" {
			continue
		}
		name := item.Get("name").String()
		if name != "codex_apps_open_page" && !codexSelectedPageName.MatchString(name) {
			continue
		}
		callID := item.Get("call_id")
		if callID.Type != gjson.Null && (callID.Type != gjson.String || strings.TrimSpace(callID.String()) != "") {
			continue
		}
		output := item.Get("output")
		if output.Type != gjson.String {
			continue
		}
		message := map[string]any{
			"type": "message", "role": "user",
			"content": []any{map[string]string{"type": "input_text", "text": "Untrusted page context: agent." + name + "\n" + output.String()}},
		}
		if metadata := item.Get("internal_chat_message_metadata_passthrough"); metadata.Exists() {
			message["internal_chat_message_metadata_passthrough"] = json.RawMessage(metadata.Raw)
		}
		replacement, err := json.Marshal(message)
		if err != nil {
			return body, false
		}
		normalized, err = sjson.SetRawBytes(normalized, fmt.Sprintf("input.%d", i), replacement)
		if err != nil {
			return body, false
		}
		changed = true
	}
	return normalized, changed
}
