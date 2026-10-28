package webproto

import (
	"bytes"
	"encoding/json"
)

// DocSchema is the version of the stored turn and conversation documents.
const DocSchema = 1

// Turn statuses (shared/types.ts Turn.status).
var turnStatuses = map[string]bool{"inProgress": true, "completed": true, "failed": true, "interrupted": true}

// Conversation modes (shared/types.ts Mode).
var conversationModes = map[string]bool{"chat": true, "cowork": true, "code": true}

// TurnDoc is one turn row (claudex_web_turns.doc). BranchID is nil for the
// live transcript and a savedBranches id for a saved branch's turns; Ordinal
// orders the turns of one branch from 0. Turn is kept as raw JSON so every
// field of shared/types.ts Turn and its items survives, including ones Go does
// not know.
type TurnDoc struct {
	Schema         int             `json:"schema"`
	ConversationID string          `json:"conversationId"`
	BranchID       *string         `json:"branchId"`
	TurnID         string          `json:"turnId"`
	Ordinal        int             `json:"ordinal"`
	Turn           json.RawMessage `json:"turn"`
}

// TurnHeader is what Go reads from a turn for columns and checks.
type TurnHeader struct {
	ID          string            `json:"id"`
	Prompt      *string           `json:"prompt"`
	Attachments []json.RawMessage `json:"attachments"`
	Items       []ItemHeader      `json:"items"`
	Status      string            `json:"status"`
	CreatedAt   *int64            `json:"createdAt"`
}

// ItemHeader is the part of a transcript item every item has.
type ItemHeader struct {
	ID   string `json:"id"`
	Type string `json:"type"`
}

// DecodeTurnDoc reads and validates a turn document: schema 1, ids, the
// turn's required fields, turn.id == turnId and the 4 MiB limit.
func DecodeTurnDoc(data []byte) (TurnDoc, TurnHeader, error) {
	var doc TurnDoc
	var head TurnHeader
	if len(data) > TurnDocBytes {
		return doc, head, fail("turn document is too large")
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return doc, head, fail("turn document: %v", err)
	}
	if doc.Schema != DocSchema {
		return doc, head, fail("unsupported turn document schema")
	}
	if !docIDPattern.MatchString(doc.ConversationID) || !docIDPattern.MatchString(doc.TurnID) {
		return doc, head, fail("conversationId and turnId must be ids")
	}
	if doc.BranchID != nil && !docIDPattern.MatchString(*doc.BranchID) {
		return doc, head, fail("branchId has the wrong shape")
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return doc, head, fail("turn document: %v", err)
	}
	if _, ok := fields["branchId"]; !ok {
		return doc, head, fail("branchId must be present (null for the live transcript)")
	}
	if doc.Ordinal < 0 {
		return doc, head, fail("ordinal must be ≥ 0")
	}
	trimmed := bytes.TrimSpace(doc.Turn)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return doc, head, fail("turn must be an object")
	}
	if err := json.Unmarshal(trimmed, &head); err != nil {
		return doc, head, fail("turn: %v", err)
	}
	switch {
	case !docIDPattern.MatchString(head.ID):
		return doc, head, fail("turn.id has the wrong shape")
	case head.ID != doc.TurnID:
		return doc, head, fail("turn.id must equal turnId")
	case head.Prompt == nil:
		return doc, head, fail("turn.prompt must be a string")
	case head.Attachments == nil:
		return doc, head, fail("turn.attachments must be an array")
	case head.Items == nil:
		return doc, head, fail("turn.items must be an array")
	case !turnStatuses[head.Status]:
		return doc, head, fail("turn.status is unknown")
	case head.CreatedAt == nil || *head.CreatedAt < 0:
		return doc, head, fail("turn.createdAt must be an integer ≥ 0")
	}
	for i, item := range head.Items {
		if item.ID == "" || item.Type == "" {
			return doc, head, fail("turn.items[%d] needs id and type", i)
		}
	}
	return doc, head, nil
}

// ConversationDoc is a conversation row (claudex_web_conversations.doc):
// the conversation without turns; saved branches without their turns.
// Conversation is kept raw; Meta holds the fields Go indexes.
type ConversationDoc struct {
	Schema       int             `json:"schema"`
	Conversation json.RawMessage `json:"conversation"`
}

// ConversationMeta is what Go reads from a conversation for its columns.
type ConversationMeta struct {
	ID            string            `json:"id"`
	Title         *string           `json:"title"`
	Mode          string            `json:"mode"`
	ProjectID     string            `json:"projectId,omitempty"`
	ProviderID    *string           `json:"providerId"`
	Model         *string           `json:"model"`
	Pinned        *bool             `json:"pinned"`
	Archived      *bool             `json:"archived"`
	SidebarRank   *float64          `json:"sidebarRank,omitempty"`
	CreatedAt     *int64            `json:"createdAt"`
	UpdatedAt     *int64            `json:"updatedAt"`
	Incognito     bool              `json:"incognito,omitempty"`
	Unread        bool              `json:"unread,omitempty"`
	Turns         json.RawMessage   `json:"turns,omitempty"`
	SavedBranches []json.RawMessage `json:"savedBranches,omitempty"`
}

// DecodeConversationDoc reads and validates a conversation document.
// Incognito conversations are never stored.
func DecodeConversationDoc(data []byte) (ConversationDoc, ConversationMeta, error) {
	var doc ConversationDoc
	var meta ConversationMeta
	if err := json.Unmarshal(data, &doc); err != nil {
		return doc, meta, fail("conversation document: %v", err)
	}
	if doc.Schema != DocSchema {
		return doc, meta, fail("unsupported conversation document schema")
	}
	trimmed := bytes.TrimSpace(doc.Conversation)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return doc, meta, fail("conversation must be an object")
	}
	if err := json.Unmarshal(trimmed, &meta); err != nil {
		return doc, meta, fail("conversation: %v", err)
	}
	switch {
	case meta.Turns != nil:
		return doc, meta, fail("conversation must not carry turns")
	case !docIDPattern.MatchString(meta.ID):
		return doc, meta, fail("conversation.id has the wrong shape")
	case meta.Title == nil || meta.ProviderID == nil || meta.Model == nil:
		return doc, meta, fail("conversation needs title, providerId and model")
	case !conversationModes[meta.Mode]:
		return doc, meta, fail("conversation.mode is unknown")
	case meta.Pinned == nil || meta.Archived == nil:
		return doc, meta, fail("conversation needs pinned and archived")
	case meta.CreatedAt == nil || meta.UpdatedAt == nil || *meta.CreatedAt < 0 || *meta.UpdatedAt < 0:
		return doc, meta, fail("conversation needs createdAt and updatedAt")
	case meta.Incognito:
		return doc, meta, fail("incognito conversations are never stored")
	}
	for i, raw := range meta.SavedBranches {
		var branch struct {
			ID    string          `json:"id"`
			Turns json.RawMessage `json:"turns"`
		}
		if err := json.Unmarshal(raw, &branch); err != nil || !docIDPattern.MatchString(branch.ID) {
			return doc, meta, fail("conversation.savedBranches[%d] needs an id", i)
		}
		if branch.Turns != nil {
			return doc, meta, fail("conversation.savedBranches[%d] must not carry turns", i)
		}
	}
	return doc, meta, nil
}
