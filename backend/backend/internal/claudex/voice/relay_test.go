package voice

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	coderws "github.com/coder/websocket"
	"github.com/stretchr/testify/require"
)

// fakeUpstream is a scripted realtime transcription service.
type fakeUpstream struct {
	srv    *httptest.Server
	mu     sync.Mutex
	frames []frame
	auth   string
}

type frame struct {
	typ  coderws.MessageType
	data []byte
}

func (u *fakeUpstream) record(typ coderws.MessageType, data []byte) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.frames = append(u.frames, frame{typ, append([]byte(nil), data...)})
}

func (u *fakeUpstream) snapshot() []frame {
	u.mu.Lock()
	defer u.mu.Unlock()
	return append([]frame(nil), u.frames...)
}

func (u *fakeUpstream) audioBytes() int {
	n := 0
	for _, f := range u.snapshot() {
		if f.typ == coderws.MessageBinary {
			n += len(f.data)
		}
	}
	return n
}

func (u *fakeUpstream) texts() []map[string]any {
	var out []map[string]any
	for _, f := range u.snapshot() {
		if f.typ == coderws.MessageText {
			var m map[string]any
			_ = json.Unmarshal(f.data, &m)
			out = append(out, m)
		}
	}
	return out
}

// newFakeUpstream serves one script per connection. The script gets the
// accepted connection; frames it reads through read are recorded.
func newFakeUpstream(t *testing.T, script func(ctx context.Context, c *coderws.Conn, read func() (coderws.MessageType, []byte, error))) *fakeUpstream {
	t.Helper()
	u := &fakeUpstream{}
	u.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u.mu.Lock()
		u.auth = r.Header.Get("Authorization")
		u.mu.Unlock()
		if r.Header.Get("Authorization") != "Bearer sk-upstream-test" {
			http.Error(w, `{"error":"invalid key sk-upstream-test"}`, http.StatusUnauthorized)
			return
		}
		c, err := coderws.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer func() { _ = c.CloseNow() }()
		read := func() (coderws.MessageType, []byte, error) {
			typ, data, err := c.Read(r.Context())
			if err == nil {
				u.record(typ, data)
			}
			return typ, data, err
		}
		script(r.Context(), c, read)
	}))
	t.Cleanup(u.srv.Close)
	return u
}

func (u *fakeUpstream) url() string { return "ws" + strings.TrimPrefix(u.srv.URL, "http") }

// transcriber answers a finish with a final result and done, then closes.
func transcriber(ctx context.Context, c *coderws.Conn, read func() (coderws.MessageType, []byte, error)) {
	for {
		typ, data, err := read()
		if err != nil {
			return
		}
		if typ != coderws.MessageText {
			continue
		}
		var m map[string]any
		_ = json.Unmarshal(data, &m)
		switch m["type"] {
		case "start":
			id, _ := m["requestId"].(string)
			_ = c.Write(ctx, coderws.MessageText, []byte(`{"type":"started","requestId":"`+id+`"}`))
		case "finish":
			_ = c.Write(ctx, coderws.MessageText, []byte(`{"type":"final","text":"hello world"}`))
			_ = c.Write(ctx, coderws.MessageText, []byte(`{"type":"done"}`))
			_ = c.Close(coderws.StatusNormalClosure, "")
			return
		}
	}
}

// startRelay serves the relay against upstream and dials it as the client.
func startRelay(t *testing.T, upstream *fakeUpstream, lim Limits) (*coderws.Conn, <-chan RelayResult) {
	t.Helper()
	results := make(chan RelayResult, 1)
	relaySrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		up, err := DialUpstream(r.Context(), Upstream{URL: upstream.url(), APIKey: "sk-upstream-test"})
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		client, err := coderws.Accept(w, r, nil)
		if err != nil {
			return
		}
		client.SetReadLimit(ClientReadLimit)
		defer func() { _ = client.CloseNow() }()
		results <- Relay(r.Context(), client, up, lim)
	}))
	t.Cleanup(relaySrv.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client, _, err := coderws.Dial(ctx, "ws"+strings.TrimPrefix(relaySrv.URL, "http"), nil)
	require.NoError(t, err)
	t.Cleanup(func() { _ = client.CloseNow() })
	return client, results
}

func send(t *testing.T, c *coderws.Conn, typ coderws.MessageType, data string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	require.NoError(t, c.Write(ctx, typ, []byte(data)))
}

// readAll reads client frames until the relay closes the connection.
func readAll(t *testing.T, c *coderws.Conn) ([]map[string]any, coderws.CloseError) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var out []map[string]any
	for {
		_, data, err := c.Read(ctx)
		if err != nil {
			var ce coderws.CloseError
			require.True(t, errors.As(err, &ce), "the relay closes with a close frame: %v", err)
			return out, ce
		}
		var m map[string]any
		require.NoError(t, json.Unmarshal(data, &m))
		out = append(out, m)
	}
}

func waitResult(t *testing.T, ch <-chan RelayResult) RelayResult {
	t.Helper()
	select {
	case r := <-ch:
		return r
	case <-time.After(5 * time.Second):
		t.Fatal("the relay did not end")
		return RelayResult{}
	}
}

func types(frames []map[string]any) []string {
	out := make([]string, 0, len(frames))
	for _, f := range frames {
		s, _ := f["type"].(string)
		if s == "error" {
			code, _ := f["code"].(string)
			s += ":" + code
		}
		out = append(out, s)
	}
	return out
}

// requireFrames checks a transcriber session: "started" and the relay's own
// frames in any order (they race), then "final" and "done".
func requireFrames(t *testing.T, frames []map[string]any, own ...string) {
	t.Helper()
	got := types(frames)
	require.GreaterOrEqual(t, len(got), 2, got)
	require.Equal(t, []string{"final", "done"}, got[len(got)-2:], got)
	require.ElementsMatch(t, append([]string{"started"}, own...), got[:len(got)-2], got)
}

var roomy = Limits{MaxBytes: 1 << 20, MaxDuration: 5 * time.Second, IdleTimeout: 2 * time.Second}

const startMessage = `{"type":"start","requestId":"req_asr_001","audio":{"format":"pcm_s16le","sampleRate":16000,"channels":1},` +
	`"vad":{"enabled":true,"threshold":0.2,"prefixPaddingMs":300,"silenceDurationMs":800},"model":"x","api_key":"leak"}`

func TestRelayForwardsASessionAndCountsTheAudio(t *testing.T) {
	up := newFakeUpstream(t, transcriber)
	client, results := startRelay(t, up, roomy)
	send(t, client, coderws.MessageText, startMessage)
	chunk := strings.Repeat("\x01\x02", 1600) // 100 ms
	for i := 0; i < 3; i++ {
		send(t, client, coderws.MessageBinary, chunk)
	}
	send(t, client, coderws.MessageText, `{"type":"finish","requestId":"whatever"}`)
	frames, closed := readAll(t, client)
	require.Equal(t, []string{"started", "final", "done"}, types(frames))
	require.Equal(t, "hello world", frames[1]["text"])
	require.Equal(t, coderws.StatusNormalClosure, closed.Code)

	res := waitResult(t, results)
	require.Equal(t, "req_asr_001", res.RequestID)
	require.Equal(t, int64(9600), res.AudioBytes)
	require.InDelta(t, 0.3, res.Seconds(), 1e-9)
	require.Equal(t, EndFinished, res.EndReason)
	require.True(t, res.Billable())
	require.False(t, res.UpstreamRejected)

	require.Equal(t, 9600, up.audioBytes())
	texts := up.texts()
	require.Len(t, texts, 2)
	start, _ := json.Marshal(texts[0])
	require.JSONEq(t, `{"type":"start","requestId":"req_asr_001","audio":{"format":"pcm_s16le","sampleRate":16000,"channels":1},
		"vad":{"enabled":true,"threshold":0.2,"prefixPaddingMs":300,"silenceDurationMs":800}}`, string(start),
		"unknown start fields are dropped")
	require.Equal(t, map[string]any{"type": "finish", "requestId": "req_asr_001"}, texts[1])
	require.Equal(t, "Bearer sk-upstream-test", up.auth)
}

func TestRelayPassesAnUpstreamRejectionAndDoesNotBillIt(t *testing.T) {
	up := newFakeUpstream(t, func(ctx context.Context, c *coderws.Conn, read func() (coderws.MessageType, []byte, error)) {
		_, _, _ = read()
		_ = c.Write(ctx, coderws.MessageText, []byte(`{"type":"error","requestId":"r","code":"MODEL_NOT_FOUND","message":"Bidirectional streaming speech model is unavailable."}`))
		_ = c.Close(coderws.StatusInvalidFramePayloadData, "MODEL_NOT_FOUND")
	})
	client, results := startRelay(t, up, roomy)
	send(t, client, coderws.MessageText, `{"type":"start"}`)
	frames, closed := readAll(t, client)
	require.Equal(t, []string{"error:MODEL_NOT_FOUND"}, types(frames))
	require.Equal(t, coderws.StatusInvalidFramePayloadData, closed.Code)
	require.Equal(t, "MODEL_NOT_FOUND", closed.Reason)

	res := waitResult(t, results)
	require.True(t, res.UpstreamRejected)
	require.Equal(t, "MODEL_NOT_FOUND", res.UpstreamErrorCode)
	require.Equal(t, EndUpstreamClosed, res.EndReason)
	require.False(t, res.Billable())
	require.True(t, strings.HasPrefix(res.RequestID, "req_"), "a missing requestId is generated: %q", res.RequestID)
}

func TestRelayStopsAudioAtTheByteLimit(t *testing.T) {
	up := newFakeUpstream(t, transcriber)
	client, results := startRelay(t, up, Limits{MaxBytes: 5000, MaxDuration: 5 * time.Second, IdleTimeout: 2 * time.Second})
	send(t, client, coderws.MessageText, `{"type":"start","requestId":"r1"}`)
	send(t, client, coderws.MessageBinary, strings.Repeat("a", 3200))
	send(t, client, coderws.MessageBinary, strings.Repeat("b", 3200))
	frames, closed := readAll(t, client)
	requireFrames(t, frames, "error:CLAUDEX_AUDIO_TOO_LARGE")
	require.Equal(t, coderws.StatusNormalClosure, closed.Code)

	res := waitResult(t, results)
	require.Equal(t, int64(5000), res.AudioBytes)
	require.Equal(t, EndMaxBytes, res.EndReason)
	require.Equal(t, 5000, up.audioBytes(), "the chunk that crossed the limit is cut")
	texts := up.texts()
	require.Equal(t, "finish", texts[len(texts)-1]["type"])
}

func TestRelayFinishesAtTheTimeLimit(t *testing.T) {
	up := newFakeUpstream(t, transcriber)
	client, results := startRelay(t, up, Limits{MaxBytes: 1 << 20, MaxDuration: 300 * time.Millisecond, IdleTimeout: 2 * time.Second})
	send(t, client, coderws.MessageText, `{"type":"start","requestId":"r1"}`)
	stop := make(chan struct{})
	go func() {
		for {
			select {
			case <-stop:
				return
			case <-time.After(50 * time.Millisecond):
				ctx, cancel := context.WithTimeout(context.Background(), time.Second)
				err := client.Write(ctx, coderws.MessageBinary, make([]byte, 1600))
				cancel()
				if err != nil {
					return
				}
			}
		}
	}()
	frames, _ := readAll(t, client)
	close(stop)
	requireFrames(t, frames, "error:CLAUDEX_AUDIO_TOO_LONG")
	res := waitResult(t, results)
	require.Equal(t, EndMaxDuration, res.EndReason)
	require.Greater(t, res.AudioBytes, int64(0))
	require.Equal(t, int64(up.audioBytes()), res.AudioBytes, "audio after the limit is dropped")
}

func TestRelayRefusesABadStart(t *testing.T) {
	for _, tc := range []struct {
		name string
		typ  coderws.MessageType
		msg  string
		code string
	}{
		{"binary first", coderws.MessageBinary, "\x00\x00", CodeBadStart},
		{"not a start", coderws.MessageText, `{"type":"finish"}`, CodeBadStart},
		{"not json", coderws.MessageText, `start`, CodeBadStart},
		{"sample rate", coderws.MessageText, `{"type":"start","audio":{"format":"pcm_s16le","sampleRate":44100,"channels":1}}`, CodeUnsupportedFormat},
		{"opus", coderws.MessageText, `{"type":"start","audio":{"format":"opus"}}`, CodeUnsupportedFormat},
		{"stereo", coderws.MessageText, `{"type":"start","audio":{"channels":2}}`, CodeUnsupportedFormat},
		{"request id", coderws.MessageText, `{"type":"start","requestId":"has space"}`, CodeBadStart},
		{"vad range", coderws.MessageText, `{"type":"start","vad":{"threshold":2}}`, CodeBadStart},
		{"vad type", coderws.MessageText, `{"type":"start","vad":true}`, CodeBadStart},
		{"language", coderws.MessageText, `{"type":"start","language":"en; drop"}`, CodeBadStart},
	} {
		t.Run(tc.name, func(t *testing.T) {
			up := newFakeUpstream(t, transcriber)
			client, results := startRelay(t, up, roomy)
			send(t, client, tc.typ, tc.msg)
			frames, closed := readAll(t, client)
			require.Equal(t, []string{"error:" + tc.code}, types(frames))
			require.Equal(t, coderws.StatusPolicyViolation, closed.Code)
			res := waitResult(t, results)
			require.Equal(t, EndBadStart, res.EndReason)
			require.False(t, res.Billable())
			require.Empty(t, up.snapshot(), "nothing reaches the upstream")
		})
	}
}

func TestRelayIgnoresUnknownTextFramesMidSession(t *testing.T) {
	up := newFakeUpstream(t, transcriber)
	client, results := startRelay(t, up, roomy)
	send(t, client, coderws.MessageText, `{"type":"start","requestId":"r1","language":"zh-CN"}`)
	send(t, client, coderws.MessageText, `{"type":"abort"}`)
	send(t, client, coderws.MessageBinary, "abcd")
	send(t, client, coderws.MessageText, `{"type":"finish"}`)
	frames, _ := readAll(t, client)
	requireFrames(t, frames, "error:CLAUDEX_AUDIO_BAD_FRAME")
	res := waitResult(t, results)
	require.Equal(t, int64(4), res.AudioBytes)
	texts := up.texts()
	require.Equal(t, "zh-CN", texts[0]["language"])
	require.Len(t, texts, 2, "the unknown frame is not forwarded")
}

func TestRelayClosesAnIdleSession(t *testing.T) {
	up := newFakeUpstream(t, func(ctx context.Context, c *coderws.Conn, read func() (coderws.MessageType, []byte, error)) {
		for {
			if _, _, err := read(); err != nil {
				return
			}
		}
	})
	client, results := startRelay(t, up, Limits{MaxBytes: 1 << 20, MaxDuration: 5 * time.Second, IdleTimeout: 200 * time.Millisecond})
	send(t, client, coderws.MessageText, `{"type":"start"}`)
	frames, closed := readAll(t, client)
	require.Equal(t, []string{"error:" + CodeIdleTimeout}, types(frames))
	require.Equal(t, coderws.StatusPolicyViolation, closed.Code)
	require.Equal(t, CodeIdleTimeout, closed.Reason)
	require.Equal(t, EndIdle, waitResult(t, results).EndReason)
}

func TestRelayTimesOutWithoutAStart(t *testing.T) {
	up := newFakeUpstream(t, transcriber)
	_, results := startRelay(t, up, Limits{MaxBytes: 1 << 20, MaxDuration: 5 * time.Second, IdleTimeout: 200 * time.Millisecond})
	res := waitResult(t, results)
	require.Equal(t, EndIdle, res.EndReason)
	require.Empty(t, up.snapshot())
}

func TestRelayEndsWhenTheClientLeaves(t *testing.T) {
	upstreamClosed := make(chan coderws.StatusCode, 1)
	up := newFakeUpstream(t, func(ctx context.Context, c *coderws.Conn, read func() (coderws.MessageType, []byte, error)) {
		for {
			if _, _, err := read(); err != nil {
				upstreamClosed <- coderws.CloseStatus(err)
				return
			}
		}
	})
	client, results := startRelay(t, up, roomy)
	send(t, client, coderws.MessageText, `{"type":"start"}`)
	send(t, client, coderws.MessageBinary, strings.Repeat("x", 3200))
	require.Eventually(t, func() bool { return up.audioBytes() == 3200 }, 2*time.Second, 10*time.Millisecond)
	require.NoError(t, client.Close(coderws.StatusNormalClosure, ""))
	res := waitResult(t, results)
	require.Equal(t, EndClientClosed, res.EndReason)
	require.Equal(t, int64(3200), res.AudioBytes)
	require.True(t, res.Billable(), "audio that reached the upstream is billed")
	select {
	case code := <-upstreamClosed:
		require.Equal(t, coderws.StatusNormalClosure, code)
	case <-time.After(3 * time.Second):
		t.Fatal("the upstream was not closed")
	}
}

func TestRelayReportsABrokenUpstream(t *testing.T) {
	up := newFakeUpstream(t, func(ctx context.Context, c *coderws.Conn, read func() (coderws.MessageType, []byte, error)) {
		_, _, _ = read()
		_ = c.CloseNow() // no close frame
	})
	client, results := startRelay(t, up, roomy)
	send(t, client, coderws.MessageText, `{"type":"start"}`)
	frames, closed := readAll(t, client)
	require.Equal(t, []string{"error:" + CodeUpstreamFailed}, types(frames))
	require.Equal(t, coderws.StatusInternalError, closed.Code)
	require.Equal(t, EndUpstreamFailed, waitResult(t, results).EndReason)
}

func TestDialUpstreamNeverLeaksTheKey(t *testing.T) {
	up := newFakeUpstream(t, transcriber)
	_, err := DialUpstream(context.Background(), Upstream{URL: up.url(), APIKey: "sk-wrong-key"})
	var de *DialError
	require.ErrorAs(t, err, &de)
	require.Equal(t, http.StatusUnauthorized, de.StatusCode)
	require.NotContains(t, err.Error(), "sk-")
	require.Equal(t, "Bearer sk-wrong-key", up.auth)

	_, err = DialUpstream(context.Background(), Upstream{URL: "ws://127.0.0.1:1/x", APIKey: "sk-wrong-key"})
	require.ErrorAs(t, err, &de)
	require.Zero(t, de.StatusCode)
	require.NotContains(t, err.Error(), "sk-wrong-key")
}

func TestClientCloseFor(t *testing.T) {
	code, reason := clientCloseFor(coderws.StatusAbnormalClosure, "")
	require.Equal(t, coderws.StatusInternalError, code)
	require.Equal(t, CodeUpstreamFailed, reason)
	code, _ = clientCloseFor(coderws.StatusNoStatusRcvd, "")
	require.Equal(t, coderws.StatusInternalError, code)
	code, reason = clientCloseFor(4001, strings.Repeat("é", 100))
	require.Equal(t, coderws.StatusCode(4001), code)
	require.LessOrEqual(t, len(reason), 120)
	require.True(t, strings.HasPrefix(strings.Repeat("é", 100), reason))
}
