package accountguard

import (
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func at(now time.Time, ago time.Duration, failed bool) event {
	return event{at: now.Add(-ago), failed: failed}
}

func TestDecide(t *testing.T) {
	now := time.Now()
	// Three failures in a row.
	v := decide([]event{at(now, 3*time.Minute, false), at(now, 2*time.Minute, true), at(now, time.Minute, true), at(now, 10*time.Second, true)}, now)
	require.True(t, v.trip)
	require.Equal(t, 3, v.consecutive)
	// A success after two failures resets the run.
	v = decide([]event{at(now, 3*time.Minute, true), at(now, 2*time.Minute, true), at(now, time.Minute, false)}, now)
	require.False(t, v.trip)
	// More than half of six.
	v = decide([]event{
		at(now, 9*time.Minute, true), at(now, 8*time.Minute, false), at(now, 7*time.Minute, true),
		at(now, 6*time.Minute, true), at(now, 5*time.Minute, true), at(now, 4*time.Minute, false), at(now, time.Minute, false),
	}, now)
	require.True(t, v.trip, "%+v", v)
	// Half of six is not more than half.
	v = decide([]event{
		at(now, 6*time.Minute, true), at(now, 5*time.Minute, false), at(now, 4*time.Minute, true),
		at(now, 3*time.Minute, false), at(now, 2*time.Minute, true), at(now, time.Minute, false),
	}, now)
	require.False(t, v.trip)
	// Older than the window does not count.
	v = decide([]event{at(now, 30*time.Minute, true), at(now, 20*time.Minute, true), at(now, 15*time.Minute, true)}, now)
	require.False(t, v.trip)
	require.Zero(t, v.total)
}

func TestNextGap(t *testing.T) {
	require.Equal(t, 2*time.Minute, nextGap(time.Minute))
	require.Equal(t, time.Hour, nextGap(40*time.Minute))
	require.Equal(t, degradedFirstProbe, nextGap(0))
}

func TestProbeModelAndEndpoint(t *testing.T) {
	require.Equal(t, "gpt-6-astra", probeModel("openai", []string{"gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol"}))
	require.Equal(t, "", probeModel("openai", []string{"gpt-image-2", "gpt-image-2.5"}))
	require.Equal(t, "claude-haiku-4-5-20251001", probeModel("anthropic", []string{"claude-opus-5", "claude-haiku-4-5-20251001"}))
	require.Equal(t, "grok-4.5", probeModel("grok", []string{"grok-imagine-image-2.0", "grok-4.7", "grok-4.5"}))
	require.Equal(t, "https://gptpro.live/v1/responses", endpoint("https://gptpro.live/v1", "/responses"))
	require.Equal(t, "https://api.aijws.com/v1/messages", endpoint("https://api.aijws.com/", "/messages"))
}

func TestReadResponsesStream(t *testing.T) {
	ok := "event: response.created\ndata: {\"type\":\"response.created\"}\n\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"OK\"}\n\n"
	require.NoError(t, readResponsesStream(strings.NewReader(ok)))
	// A relay that pings, waits for an account of its pool, then fails.
	failed := strings.Join([]string{
		"event: ping", `data: {"type":"ping"}`, "", ": waiting for an available account", "", "",
		"event: response.failed",
		`data: {"type":"response.failed","response":{"status":"failed","error":{"code":"ticket_unavailable","message":"Ticket gateway: ticket_unavailable"}}}`, "",
	}, "\n")
	err := readResponsesStream(strings.NewReader(failed))
	require.ErrorContains(t, err, "ticket_unavailable")
	require.Error(t, readResponsesStream(strings.NewReader("data: {\"type\":\"response.created\"}\n\n")))
}

func TestSlowAnswer(t *testing.T) {
	require.NoError(t, slowAnswer(nil, 3*time.Second))
	require.ErrorContains(t, slowAnswer(nil, 12*time.Second), "slowly")
	require.Error(t, slowAnswer(errNoModel, time.Second))
}
