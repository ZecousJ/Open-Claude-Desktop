package webhost

import "encoding/json"

func snapshotCatalogRequested(raw []json.RawMessage) bool {
	if len(raw) != 1 {
		return false
	}
	var args struct {
		ConversationHistory string `json:"conversationHistory"`
	}
	return json.Unmarshal(raw[0], &args) == nil && args.ConversationHistory == "on-demand"
}

type catalogTurn struct {
	ID          string          `json:"id"`
	CreatedAt   int64           `json:"createdAt"`
	Status      string          `json:"status"`
	Prompt      string          `json:"prompt"`
	Items       json.RawMessage `json:"items"`
	Attachments json.RawMessage `json:"attachments"`
}

func snapshotCatalog(src json.RawMessage) (json.RawMessage, error) {
	var snapshot map[string]json.RawMessage
	if err := json.Unmarshal(src, &snapshot); err != nil {
		return nil, err
	}
	raw, exists := snapshot["conversations"]
	if !exists {
		return src, nil
	}
	var conversations []map[string]json.RawMessage
	if err := json.Unmarshal(raw, &conversations); err != nil {
		return nil, err
	}
	for _, conversation := range conversations {
		var turns []catalogTurn
		if turnsJSON, present := conversation["turns"]; present {
			if err := json.Unmarshal(turnsJSON, &turns); err != nil {
				return nil, err
			}
		}
		if len(turns) == 0 && len(conversation["savedBranches"]) == 0 {
			continue
		}
		for i := range turns {
			turns[i].Prompt = ""
			turns[i].Items = json.RawMessage("[]")
			turns[i].Attachments = json.RawMessage("[]")
		}
		encoded, err := json.Marshal(turns)
		if err != nil {
			return nil, err
		}
		if len(turns) == 0 {
			encoded = []byte("[]")
		}
		conversation["turns"] = encoded
		delete(conversation, "savedBranches")
		conversation["slim"] = json.RawMessage("true")
	}
	encoded, err := json.Marshal(conversations)
	if err != nil {
		return nil, err
	}
	snapshot["conversations"] = encoded
	return json.Marshal(snapshot)
}
