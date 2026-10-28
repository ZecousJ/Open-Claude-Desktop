//go:build unit

package handler

// CLAUDEX: tests for the H14 usage-rule check on every Responses WebSocket
// turn (owner decision 8: the rules cannot be bypassed over a long-lived
// WebSocket).

import (
	"context"
	"errors"
	"slices"
	"sync"
	"testing"

	claudexhook "github.com/Wei-Shaw/sub2api/internal/claudex/hook"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/stretchr/testify/require"
)

// installOpusRule refuses every turn that may be served as claude-opus-4 and
// records the candidates each check saw.
func installOpusRule(t *testing.T) func() [][]string {
	t.Helper()
	t.Cleanup(claudexhook.Reset)
	var mu sync.Mutex
	var seen [][]string
	claudexhook.Install(claudexhook.Hooks{PrecheckTurn: func(_ context.Context, userID, apiKeyID int64, groupID *int64, models []string) error {
		require.Equal(t, int64(1701), userID)
		require.Equal(t, int64(1801), apiKeyID)
		require.NotNil(t, groupID)
		mu.Lock()
		seen = append(seen, append([]string(nil), models...))
		mu.Unlock()
		if slices.Contains(models, "claude-opus-4") {
			return errors.New("CLAUDEX_USAGE_LIMIT_EXCEEDED: You've reached the Opus limit.")
		}
		return nil
	}})
	return func() [][]string {
		mu.Lock()
		defer mu.Unlock()
		return append([][]string(nil), seen...)
	}
}

func TestClaudexUsageRulesCheckTheFirstWebSocketTurn(t *testing.T) {
	for _, mode := range []string{service.OpenAIWSIngressModePassthrough, service.OpenAIWSIngressModeDedicated} {
		t.Run(mode, func(t *testing.T) {
			seen := installOpusRule(t)
			// The first "model" is harmless; a duplicate key names the limited
			// model, which a last-value JSON decoder would bind.
			runOpenAIResponsesWebSocketUsageLogCase(t, openAIResponsesWSUsageLogCase{
				firstPayload:            `{"type":"response.create","model":"gpt-5.4","model":"claude-opus-4","stream":false}`,
				ingressMode:             mode,
				firstFrameCloseExpected: true,
				closeReason:             "CLAUDEX_USAGE_LIMIT_EXCEEDED",
			})
			require.Len(t, seen(), 1)
			require.Contains(t, seen()[0], "gpt-5.4")
			require.Contains(t, seen()[0], "claude-opus-4")
		})
	}
}

func TestClaudexUsageRulesCheckEveryLaterWebSocketTurn(t *testing.T) {
	for _, mode := range []string{service.OpenAIWSIngressModePassthrough, service.OpenAIWSIngressModeDedicated} {
		t.Run(mode, func(t *testing.T) {
			seen := installOpusRule(t)
			runOpenAIResponsesWebSocketUsageLogCase(t, openAIResponsesWSUsageLogCase{
				firstPayload:            `{"type":"response.create","model":"gpt-5.4","stream":false}`,
				secondPayload:           `{"type":"response.create","model":"claude-opus-4","stream":false}`,
				ingressMode:             mode,
				secondTurnCloseExpected: true,
				closeReason:             "CLAUDEX_USAGE_LIMIT_EXCEEDED",
			})
			got := seen()
			require.Len(t, got, 2, "the first and the second turn were both checked")
			require.Equal(t, []string{"gpt-5.4"}, got[0])
			require.Contains(t, got[1], "claude-opus-4")
		})
	}
}

func TestClaudexWebSocketTurnFailsClosedWhenTheCheckPanics(t *testing.T) {
	t.Cleanup(claudexhook.Reset)
	claudexhook.Install(claudexhook.Hooks{PrecheckTurn: func(context.Context, int64, int64, *int64, []string) error {
		panic("usage store down")
	}})
	runOpenAIResponsesWebSocketUsageLogCase(t, openAIResponsesWSUsageLogCase{
		firstPayload:            `{"type":"response.create","model":"gpt-5.4","stream":false}`,
		ingressMode:             service.OpenAIWSIngressModePassthrough,
		firstFrameCloseExpected: true,
		closeReason:             "CLAUDEX_USAGE_CHECK_FAILED",
	})
}
