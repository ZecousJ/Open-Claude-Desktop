package webhost

import (
	"encoding/json"
	"testing"

	webusage "github.com/Wei-Shaw/sub2api/internal/claudex/web/usage"
	"github.com/stretchr/testify/require"
)

// A Code turn takes a run slot in Code mode: it counts against the same
// per-user and server limits (claudex_web_usage) as Chat and Cowork.
func TestRunTargetReadsTheMode(t *testing.T) {
	send := func(in string) []json.RawMessage { return []json.RawMessage{json.RawMessage(in)} }
	for mode, want := range map[string]string{
		"code": webusage.ModeCode, "cowork": webusage.ModeCowork, "chat": webusage.ModeChat, "other": webusage.ModeChat, "": webusage.ModeChat,
	} {
		conv, got := runTarget("send", send(`{"conversationId":"c-1","mode":"`+mode+`"}`))
		require.Equal(t, "c-1", conv)
		require.Equal(t, want, got, mode)
	}
	// A new Code session has no conversation id yet.
	conv, mode := runTarget("send", send(`{"mode":"code","text":"hi"}`))
	require.Equal(t, "", conv)
	require.Equal(t, webusage.ModeCode, mode)
}
