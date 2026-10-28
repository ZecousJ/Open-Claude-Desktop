package service

import (
	"io"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestMonitorStreamTextPutsAStreamedReplyTogether(t *testing.T) {
	chat := strings.Join([]string{
		`data: {"id":"c1","choices":[{"delta":{"role":"assistant"}}]}`,
		`data: {"id":"c1","choices":[{"delta":{"content":"the answer "}}]}`,
		`data: {"id":"c1","choices":[{"delta":{"content":"is 42"}}]}`,
		"data: [DONE]", "",
	}, "\n")
	require.True(t, looksLikeMonitorSSE([]byte(chat)))
	text, failure := monitorStreamText(MonitorProviderOpenAI, MonitorAPIModeChatCompletions, []byte(chat))
	require.Empty(t, failure)
	require.Equal(t, "the answer is 42", text)

	responses := strings.Join([]string{
		"event: response.created", `data: {"type":"response.created"}`, "",
		`data: {"type":"response.output_text.delta","delta":"42"}`, "",
		`data: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"42"}]}]}}`, "",
	}, "\n")
	text, failure = monitorStreamText(MonitorProviderOpenAI, MonitorAPIModeResponses, []byte(responses))
	require.Empty(t, failure)
	require.Equal(t, "42", text)

	anthropic := strings.Join([]string{
		"event: message_start", `data: {"type":"message_start"}`, "",
		"event: content_block_delta", `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"4"}}`, "",
		"event: content_block_delta", `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"2"}}`, "",
		"event: message_stop", `data: {"type":"message_stop"}`, "",
	}, "\n")
	text, failure = monitorStreamText(MonitorProviderAnthropic, "", []byte(anthropic))
	require.Empty(t, failure)
	require.Equal(t, "42", text)

	// A relay that pings, then fails inside the 200.
	failed := strings.Join([]string{
		"event: ping", `data: {"type":"ping"}`, "",
		"event: response.failed",
		`data: {"type":"response.failed","response":{"status":"failed","error":{"message":"Ticket gateway: ticket_unavailable"}}}`, "",
	}, "\n")
	_, failure = monitorStreamText(MonitorProviderOpenAI, MonitorAPIModeResponses, []byte(failed))
	require.Equal(t, "Ticket gateway: ticket_unavailable", failure)

	// One JSON document is not a stream.
	require.False(t, looksLikeMonitorSSE([]byte(`{"choices":[{"message":{"content":"42"}}]}`)))
}

// A relay that never closes the connection after message_stop must not hold
// the probe: the read ends at the terminal event.
func TestReadMonitorSSEStopsAtTheTerminalEvent(t *testing.T) {
	pr, pw := io.Pipe()
	go func() {
		_, _ = io.WriteString(pw, "event: message_start\ndata: {\"type\":\"message_start\"}\n\n")
		_, _ = io.WriteString(pw, "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"42\"}}\n\n")
		_, _ = io.WriteString(pw, "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
		// The connection stays open; the probe must be done already.
		time.Sleep(3 * time.Second)
		_ = pw.Close()
	}()
	done := make(chan []byte, 1)
	go func() {
		body, err := readMonitorSSE(pr, monitorResponseMaxBytes)
		require.NoError(t, err)
		done <- body
	}()
	select {
	case body := <-done:
		text, failure := monitorStreamText(MonitorProviderAnthropic, "", body)
		require.Empty(t, failure)
		require.Equal(t, "42", text)
	case <-time.After(2 * time.Second):
		t.Fatal("the read waited for EOF instead of stopping at message_stop")
	}
	_ = pr.Close()

	// Chat Completions ends with [DONE]; Responses with response.completed.
	chat, err := readMonitorSSE(strings.NewReader("data: {\"choices\":[{\"delta\":{\"content\":\"42\"}}]}\n\ndata: [DONE]\n\nignored tail\n"), monitorResponseMaxBytes)
	require.NoError(t, err)
	require.NotContains(t, string(chat), "ignored tail")
	responses, err := readMonitorSSE(strings.NewReader("data: {\"type\":\"response.output_text.delta\",\"delta\":\"42\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{}}\n\nignored tail\n"), monitorResponseMaxBytes)
	require.NoError(t, err)
	require.NotContains(t, string(responses), "ignored tail")
}
