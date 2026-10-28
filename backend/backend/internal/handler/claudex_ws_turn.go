package handler

// CLAUDEX: file added by the Claudex fork (see backend/CLAUDEX_CHANGES.md).
//
// H14: the usage rules (B5) check every turn of a Responses WebSocket. The
// handshake passed the API-key guards (H5b) without a model; each
// response.create frame names the model(s) of its turn, so the rules are
// checked again for the first frame and every later turn, before an account
// is picked and anything is forwarded (owner decision 8).

import (
	"context"
	"strings"

	claudexhook "github.com/Wei-Shaw/sub2api/internal/claudex/hook"
	"github.com/Wei-Shaw/sub2api/internal/pkg/requestmodel"
	"github.com/Wei-Shaw/sub2api/internal/service"
)

// claudexPrecheckWSTurn returns the usage-rule refusal for one turn (the
// connection is then closed with the error text), or nil. model is the turn's
// effective model; every "model" of the frame (duplicate keys, case variants,
// session.model) is checked too.
func claudexPrecheckWSTurn(ctx context.Context, userID int64, apiKey *service.APIKey, model string, payload []byte) error {
	if apiKey == nil {
		return nil
	}
	models := make([]string, 0, 4)
	seen := map[string]bool{}
	for _, m := range append([]string{model}, requestmodel.FromBodyCandidates("", "application/json", payload)...) {
		m = strings.TrimSpace(m)
		if m != "" && !seen[m] {
			seen[m] = true
			models = append(models, m)
		}
	}
	return claudexhook.PrecheckTurn(ctx, userID, apiKey.ID, apiKey.GroupID, models)
}
