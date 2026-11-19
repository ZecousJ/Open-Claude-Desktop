package webhost

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"

	"github.com/coder/websocket"
	"github.com/stretchr/testify/require"
)

type wireChunk struct {
	T            string `json:"t"`
	Offset       int    `json:"offset"`
	TotalBytes   int    `json:"totalBytes"`
	DecodedBytes int    `json:"decodedBytes"`
	Encoding     string `json:"encoding"`
	Data         []byte `json:"data"`
}

func writeJSONFrame(t *testing.T, conn *websocket.Conn, frame any) {
	t.Helper()
	data, err := json.Marshal(frame)
	require.NoError(t, err)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	require.NoError(t, conn.Write(ctx, websocket.MessageText, data))
}

func writeRunnerChunks(t *testing.T, conn *websocket.Conn, encoded []byte, decodedBytes int, encoding string) {
	t.Helper()
	for offset := 0; offset < len(encoded); {
		end := min(offset+(1<<20), len(encoded))
		writeJSONFrame(t, conn, wireChunk{"chunk", offset, len(encoded), decodedBytes, encoding, encoded[offset:end]})
		offset = end
	}
}

func runnerGzip(t *testing.T, data []byte) []byte {
	t.Helper()
	var compressed bytes.Buffer
	w, err := gzip.NewWriterLevel(&compressed, gzip.BestSpeed)
	require.NoError(t, err)
	_, err = w.Write(data)
	require.NoError(t, err)
	require.NoError(t, w.Close())
	return compressed.Bytes()
}

func TestRunnerChunkedEventAndSnapshotKeepOrder(t *testing.T) {
	h := newHost(t)
	h.c.heartbeat = 10 * time.Second
	fr, err := h.dialRunner(localToken, defaultMethods, func(f webproto.GoFrame) (any, *webproto.RPCError, bool) {
		if f.Method == "snapshot" {
			return nil, nil, false
		}
		return echoCalls(f)
	})
	require.NoError(t, err)
	status, _ := h.rpc(userA, "listThings")
	require.Equal(t, http.StatusOK, status)

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	const tabID = "tab-a-000001"
	tab, _, err := websocket.Dial(ctx, h.wsURL(webproto.PathEvents), &websocket.DialOptions{
		Subprotocols: []string{webproto.EventsSubprotocol, webproto.TicketSubprotocolPrefix + h.ticket(userA, tabID)},
	})
	require.NoError(t, err)
	defer tab.CloseNow()
	tab.SetReadLimit(32 << 20)
	writeJSONFrame(t, tab, map[string]any{"t": "hello", "v": 1, "tabId": tabID})
	readTab := func() webproto.ServerFrame {
		t.Helper()
		_, raw, err := tab.Read(ctx)
		require.NoError(t, err)
		var frame webproto.ServerFrame
		require.NoError(t, json.Unmarshal(raw, &frame))
		return frame
	}
	ready := readTab()
	require.Equal(t, "ready", ready.T)
	require.NotNil(t, ready.Seq)
	baseSeq := *ready.Seq

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.srv.URL+webproto.PathRPC+"snapshot", strings.NewReader(`{"args":[]}`))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+tokenOf(userA))
	req.Header.Set(webproto.HeaderTab, tabID)
	type reply struct {
		response *http.Response
		err      error
	}
	response := make(chan reply, 1)
	go func() {
		res, err := http.DefaultClient.Do(req)
		response <- reply{res, err}
	}()
	var callID string
	waitFor(t, "snapshot call", func() bool {
		for _, call := range fr.framesOf("call") {
			if call.Method == "snapshot" {
				callID = call.ID
				return true
			}
		}
		return false
	})

	const payloadBytes = 25 << 20
	large := strings.Repeat("x", payloadBytes)
	event := json.RawMessage(`{"type":"large","payload":"` + large + `"}`)
	eventFrame, err := json.Marshal(map[string]any{"t": "event", "userId": userA, "event": event})
	require.NoError(t, err)
	_, err = webproto.DecodeRunnerFrame(eventFrame)
	require.ErrorIs(t, err, webproto.ErrProtocol)
	fr.event(userA, map[string]any{"type": "before"})
	writeRunnerChunks(t, fr.conn, eventFrame, len(eventFrame), "identity")
	fr.event(userA, map[string]any{"type": "between"})

	snapshot := json.RawMessage(`{"conversations":[{"id":"c","payload":"` + large + `"}]}`)
	resultFrame, err := json.Marshal(map[string]any{"t": "result", "id": callID, "ok": true, "value": snapshot})
	require.NoError(t, err)
	compressed := runnerGzip(t, resultFrame)
	writeRunnerChunks(t, fr.conn, compressed, len(resultFrame), "gzip")
	fr.event(userA, map[string]any{"type": "after"})

	for i, want := range []json.RawMessage{json.RawMessage(`{"type":"before"}`), event, json.RawMessage(`{"type":"between"}`), json.RawMessage(`{"type":"after"}`)} {
		got := readTab()
		require.Equal(t, "event", got.T)
		require.NotNil(t, got.Seq)
		require.Equal(t, baseSeq+int64(i)+1, *got.Seq)
		require.True(t, bytes.Equal(want, got.Event), "event %d differs", i)
	}

	out := <-response
	require.NoError(t, out.err)
	defer out.response.Body.Close()
	require.Equal(t, http.StatusOK, out.response.StatusCode)
	require.Equal(t, strconv.FormatInt(baseSeq+3, 10), out.response.Header.Get(webproto.EventSeqHeader))
	body, err := io.ReadAll(out.response.Body)
	require.NoError(t, err)
	var rpc webproto.RPCResponse
	require.NoError(t, json.Unmarshal(body, &rpc))
	require.True(t, rpc.OK)
	require.True(t, bytes.Equal(snapshot, rpc.Value), "snapshot payload differs")
}

func TestRunnerRejectsInvalidChunkTransfers(t *testing.T) {
	const event = `{"t":"event","userId":101,"event":{"type":"chunk"}}`
	data := []byte(event)
	first := wireChunk{"chunk", 0, len(data), len(data), "identity", data[:1]}
	last := wireChunk{"chunk", 1, len(data), len(data), "identity", data[1:]}
	nested, err := json.Marshal(wireChunk{"chunk", 0, len(data), len(data), "identity", data})
	require.NoError(t, err)
	whole := func(payload []byte) wireChunk {
		return wireChunk{"chunk", 0, len(payload), len(payload), "identity", payload}
	}

	for _, tc := range []struct {
		name   string
		frames []any
	}{
		{"starts after zero", []any{last}},
		{"missing offset", []any{json.RawMessage(`{"t":"chunk","totalBytes":1,"decodedBytes":1,"encoding":"identity","data":"eA=="}`)}},
		{"data is an array", []any{json.RawMessage(`{"t":"chunk","offset":0,"totalBytes":2,"decodedBytes":2,"encoding":"identity","data":[123,125]}`)}},
		{"wrong offset", []any{first, first}},
		{"different total", []any{first, wireChunk{"chunk", 1, len(data) + 1, len(data) + 1, "identity", data[1:]}}},
		{"different encoding", []any{first, wireChunk{"chunk", 1, len(data), len(data), "gzip", data[1:]}}},
		{"different decoded size", []any{
			wireChunk{"chunk", 0, len(data), 100, "gzip", data[:1]},
			wireChunk{"chunk", 1, len(data), 101, "gzip", data[1:]},
		}},
		{"interleaved event", []any{first, json.RawMessage(event)}},
		{"nested chunk", []any{whole(nested)}},
		{"unknown inner frame", []any{whole([]byte(`{"t":"bad"}`))}},
		{"malformed event", []any{whole([]byte(`{"t":"event"}`))}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHost(t)
			fr := h.runner()
			status, _ := h.rpc(userA, "listThings")
			require.Equal(t, http.StatusOK, status)
			before := h.c.hubs.lastSeq(userA)
			for _, frame := range tc.frames {
				writeJSONFrame(t, fr.conn, frame)
			}
			requireRunnerProtocolClose(t, fr)
			require.Equal(t, before, h.c.hubs.lastSeq(userA))
		})
	}
}

func TestRunnerRejectsGzipPastDecodedLimit(t *testing.T) {
	h := newHost(t)
	fr := h.runner()
	var compressed bytes.Buffer
	w, err := gzip.NewWriterLevel(&compressed, gzip.BestSpeed)
	require.NoError(t, err)
	event := []byte(`{"t":"event","userId":101,"event":{"type":"oversized"}}`)
	_, err = w.Write(event)
	require.NoError(t, err)
	block := bytes.Repeat([]byte{' '}, 1<<20)
	remaining := (64 << 20) + 1 - len(event)
	for remaining > 0 {
		written, err := w.Write(block[:min(remaining, len(block))])
		require.NoError(t, err)
		remaining -= written
	}
	require.NoError(t, w.Close())
	writeRunnerChunks(t, fr.conn, compressed.Bytes(), 64<<20, "gzip")
	requireRunnerProtocolClose(t, fr)
}

func TestRunnerDropsPartialChunkOnDisconnect(t *testing.T) {
	h := newHost(t)
	fr := h.runner()
	status, _ := h.rpc(userA, "listThings")
	require.Equal(t, http.StatusOK, status)
	tab := h.openTab(userA, "tab-a-000001", nil)
	ready := tab.ready()

	data := []byte(`{"t":"event","userId":101,"event":{"type":"after reconnect"}}`)
	writeJSONFrame(t, fr.conn, wireChunk{"chunk", 0, len(data), len(data), "identity", data[:5]})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	require.NoError(t, fr.conn.Ping(ctx))
	require.NoError(t, fr.conn.CloseNow())
	waitFor(t, "runner disconnect", func() bool { return h.c.reg.get(LocalRunnerID) == nil })
	require.Equal(t, *ready.Seq, h.c.hubs.lastSeq(userA))

	again := h.runner()
	writeRunnerChunks(t, again.conn, data, len(data), "identity")
	waitFor(t, "events after reconnect", func() bool { return len(tab.of("event")) >= 2 })
	events := tab.of("event")
	require.Len(t, events, 2)
	require.Equal(t, *ready.Seq+1, *events[0].Seq)
	require.JSONEq(t, `{"type":"resync"}`, string(events[0].Event))
	require.Equal(t, *ready.Seq+2, *events[1].Seq)
	require.JSONEq(t, `{"type":"after reconnect"}`, string(events[1].Event))
}

func TestRunnerRejectsChunkBeforeHello(t *testing.T) {
	h := newHost(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, h.wsURL(webproto.PathRunnerLink), &websocket.DialOptions{
		HTTPHeader:   http.Header{"Authorization": []string{"Bearer " + localToken}},
		Subprotocols: []string{webproto.RunnerLinkSubprotocol},
	})
	require.NoError(t, err)
	defer conn.CloseNow()

	writeJSONFrame(t, conn, wireChunk{"chunk", 0, 2, 2, "identity", []byte("{}")})
	_, _, err = conn.Read(ctx)
	require.Equal(t, websocket.StatusCode(webproto.CloseProtocolError), websocket.CloseStatus(err))
}

func requireRunnerProtocolClose(t *testing.T, fr *fakeRunner) {
	t.Helper()
	select {
	case <-fr.closed:
		require.Equal(t, websocket.StatusCode(webproto.CloseProtocolError), fr.code)
	case <-time.After(5 * time.Second):
		t.Fatal("runner link stayed open")
	}
}
