package webstore

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"

	"github.com/Wei-Shaw/sub2api/internal/claudex/sharing"
)

// fullConversation is a stored conversation joined with its turns, in the
// shape of shared/types.ts Conversation (turns in the live transcript,
// saved branches with their own turns), like joinConversation in
// shared/web-protocol.ts.
type fullConversation struct {
	fields   map[string]json.RawMessage
	live     []json.RawMessage
	branches map[string][]json.RawMessage
}

// loadConversation reads one conversation of the user with every turn.
func (c *Component) loadConversation(ctx context.Context, userID int64, id string) (*fullConversation, error) {
	row, err := c.store.getConversation(ctx, userID, id)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, notFound("conversation")
	}
	var doc struct {
		Conversation map[string]json.RawMessage `json:"conversation"`
	}
	if err := json.Unmarshal(row.Doc, &doc); err != nil || doc.Conversation == nil {
		return nil, failed(err)
	}
	out := &fullConversation{fields: doc.Conversation, branches: map[string][]json.RawMessage{}}
	cursor := ""
	for {
		turns, next, err := c.store.listTurns(ctx, userID, id, cursor)
		if err != nil {
			return nil, err
		}
		for _, raw := range turns {
			var t struct {
				BranchID *string         `json:"branchId"`
				Turn     json.RawMessage `json:"turn"`
			}
			if err := json.Unmarshal(raw, &t); err != nil {
				return nil, failed(err)
			}
			if t.BranchID == nil {
				out.live = append(out.live, t.Turn)
			} else {
				out.branches[*t.BranchID] = append(out.branches[*t.BranchID], t.Turn)
			}
		}
		if next == "" {
			return out, nil
		}
		cursor = next
	}
}

// JSON is the conversation with its turns (rows come ordered by ordinal).
func (f *fullConversation) JSON() (json.RawMessage, error) {
	fields := make(map[string]json.RawMessage, len(f.fields)+1)
	for k, v := range f.fields {
		fields[k] = v
	}
	live := f.live
	if live == nil {
		live = []json.RawMessage{}
	}
	turns, err := json.Marshal(live)
	if err != nil {
		return nil, err
	}
	fields["turns"] = turns
	if raw, ok := fields["savedBranches"]; ok {
		var branches []map[string]json.RawMessage
		if err := json.Unmarshal(raw, &branches); err == nil {
			for _, b := range branches {
				var id string
				_ = json.Unmarshal(b["id"], &id)
				bt := f.branches[id]
				if bt == nil {
					bt = []json.RawMessage{}
				}
				b["turns"], _ = json.Marshal(bt)
			}
			if fields["savedBranches"], err = json.Marshal(branches); err != nil {
				return nil, err
			}
		}
	}
	return json.Marshal(fields)
}

func (f *fullConversation) str(key string) string {
	var s string
	_ = json.Unmarshal(f.fields[key], &s)
	return s
}

// ShareSnapshot builds the R1 snapshot of one of the user's conversations
// from the stored rows (the live transcript: prompts, reply text and a
// one-line summary of the tool activity, never commands or their output).
// The caller publishes it through the sharing component, which applies the
// sharing switches, the limits and the per-user block.
func (c *Component) ShareSnapshot(ctx context.Context, userID int64, conversationID string) (*sharing.Snapshot, error) {
	if !docID.MatchString(conversationID) {
		return nil, notFound("conversation")
	}
	conv, err := c.loadConversation(ctx, userID, conversationID)
	if err != nil {
		return nil, err
	}
	snap := &sharing.Snapshot{
		Kind:       sharing.KindConversation,
		Title:      conv.str("title"),
		Mode:       conv.str("mode"),
		ModelLabel: conv.str("model"),
	}
	for _, raw := range conv.live {
		var t struct {
			Prompt string `json:"prompt"`
			Items  []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"items"`
		}
		if json.Unmarshal(raw, &t) != nil {
			continue
		}
		if strings.TrimSpace(t.Prompt) != "" {
			snap.Messages = append(snap.Messages, sharing.SnapshotMessage{Role: "user", Text: t.Prompt})
		}
		var reply []string
		counts := map[string]int{}
		for _, it := range t.Items {
			switch it.Type {
			case "agentMessage":
				if strings.TrimSpace(it.Text) != "" {
					reply = append(reply, it.Text)
				}
			case "commandExecution", "fileChange", "webSearch", "mcpToolCall":
				counts[it.Type]++
			}
		}
		if len(reply) == 0 && len(counts) == 0 {
			continue
		}
		snap.Messages = append(snap.Messages, sharing.SnapshotMessage{
			Role: "assistant", Text: strings.Join(reply, "\n\n"), Activity: activityLines(counts),
		})
	}
	return snap, nil
}

func activityLines(counts map[string]int) []string {
	var out []string
	plural := func(n int, one, many string) string {
		if n == 1 {
			return one
		}
		return strings.Replace(many, "N", strconv.Itoa(n), 1)
	}
	if n := counts["commandExecution"]; n > 0 {
		out = append(out, plural(n, "Ran a command", "Ran N commands"))
	}
	if n := counts["fileChange"]; n > 0 {
		out = append(out, plural(n, "Edited a file", "Edited files N times"))
	}
	if n := counts["webSearch"]; n > 0 {
		out = append(out, plural(n, "Searched the web", "Searched the web N times"))
	}
	if n := counts["mcpToolCall"]; n > 0 {
		out = append(out, plural(n, "Used a tool", "Used tools N times"))
	}
	return out
}
