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
		target := runTarget("send", send(`{"conversationId":"c-1","mode":"`+mode+`"}`))
		require.Equal(t, "c-1", target.conversation)
		require.Equal(t, want, target.mode, mode)
	}
	// A new Code session has no conversation id yet.
	target := runTarget("send", send(`{"mode":"code","text":"hi"}`))
	require.Equal(t, "", target.conversation)
	require.Equal(t, webusage.ModeCode, target.mode)
	target = runTarget("send", send(`{"mode":"code","clientRequestId":"004208A9-83CB-49C8-9026-4E0FCE94F53A"}`))
	require.Equal(t, "004208a9-83cb-49c8-9026-4e0fce94f53a", target.conversation)
	require.Equal(t, webusage.ModeCode, target.mode)
	require.True(t, target.nativeSend)
}
