package webhost

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"

	"github.com/coder/websocket"
	"github.com/stretchr/testify/require"
)

// fakeDevice is a desktop on the device link: it answers calls with
// answer and records them.
type fakeDevice struct {
	t      *testing.T
	conn   *websocket.Conn
	mu     sync.Mutex
	calls  []DeviceFrame
	answer func(DeviceFrame) (any, *webproto.RPCError)
	closed chan struct{}
	code   websocket.StatusCode
}

func (h *host) dialDevice(uid int64, id, name string, methods []string, answer func(DeviceFrame) (any, *webproto.RPCError)) (*fakeDevice, error) {
	h.t.Helper()
	return h.dialDeviceWithTicket(h.ticket(uid, id), id, name, methods, answer)
}

func (h *host) dialDeviceWithTicket(ticket, id, name string, methods []string, answer func(DeviceFrame) (any, *webproto.RPCError)) (*fakeDevice, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, h.wsURL("/api/v1/claudex"+RouteDeviceLink), &websocket.DialOptions{
		Subprotocols: []string{webproto.EventsSubprotocol, webproto.TicketSubprotocolPrefix + ticket},
	})
	if err != nil {
		return nil, err
	}
	conn.SetReadLimit(webproto.LinkFrameBytes)
	fd := &fakeDevice{t: h.t, conn: conn, answer: answer, closed: make(chan struct{})}
	fd.send(map[string]any{"t": "hello", "v": 1, "deviceId": id, "name": name, "platform": "darwin", "version": "0.0.9", "methods": methods})
	_, data, err := conn.Read(ctx)
	if err != nil {
		return nil, err
	}
	var welcome DeviceFrame
	if json.Unmarshal(data, &welcome) != nil || welcome.T != "welcome" {
		return nil, errors.New("no welcome: " + string(data))
	}
	go fd.loop()
	h.t.Cleanup(func() { _ = conn.CloseNow() })
	return fd, nil
}

func (fd *fakeDevice) send(frame any) {
	data, _ := json.Marshal(frame)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = fd.conn.Write(ctx, websocket.MessageText, data)
}

func (fd *fakeDevice) loop() {
	defer close(fd.closed)
	for {
		_, data, err := fd.conn.Read(context.Background())
		if err != nil {
			fd.mu.Lock()
			fd.code = websocket.CloseStatus(err)
			fd.mu.Unlock()
			return
		}
		var f DeviceFrame
		if json.Unmarshal(data, &f) != nil || f.T != "call" {
			continue
		}
		fd.mu.Lock()
		fd.calls = append(fd.calls, f)
		fd.mu.Unlock()
		value, rpcErr := fd.answer(f)
		ok := rpcErr == nil
		out := map[string]any{"t": "result", "id": f.ID, "ok": ok}
		if ok {
			out["value"] = value
		} else {
			out["error"] = rpcErr
		}
		fd.send(out)
	}
}

func (fd *fakeDevice) closeCode() websocket.StatusCode {
	fd.t.Helper()
	select {
	case <-fd.closed:
	case <-time.After(5 * time.Second):
		fd.t.Fatal("the device link stayed open")
	}
	fd.mu.Lock()
	defer fd.mu.Unlock()
	return fd.code
}

func echoDevice(f DeviceFrame) (any, *webproto.RPCError) {
	if f.Method == "fail" {
		return nil, &webproto.RPCError{Message: "That conversation is gone."}
	}
	return map[string]any{"method": f.Method, "args": f.Args}, nil
}

func (h *host) devices(uid int64) []DeviceInfo {
	h.t.Helper()
	status, res := h.do(uid, http.MethodGet, "/api/v1/claudex"+RouteDevices, "application/json", nil)
	require.Equal(h.t, http.StatusOK, status)
	require.True(h.t, res.OK)
	var out []DeviceInfo
	require.NoError(h.t, json.Unmarshal(res.Value, &out))
	return out
}

func (h *host) deviceCall(uid int64, device, method string, args ...any) (int, webproto.RPCResponse) {
	h.t.Helper()
	if args == nil {
		args = []any{}
	}
	body, _ := json.Marshal(map[string]any{"args": args})
	return h.post(uid, "/api/v1/claudex/web/devices/"+device+"/rpc/"+method, "application/json", body)
}

func TestDevicesListAndRelayForTheirUserOnly(t *testing.T) {
	h := newHost(t)
	methods := []string{"listCodeConversations", "send", "fail"}
	_, err := h.dialDevice(userA, "mac-of-a-0001", "A's Mac", methods, echoDevice)
	require.NoError(t, err)

	waitFor(t, "A's device listed", func() bool { return len(h.devices(userA)) == 1 })
	list := h.devices(userA)
	require.Equal(t, "A's Mac", list[0].Name)
	require.Equal(t, "darwin", list[0].Platform)
	require.Empty(t, h.devices(userB))

	status, res := h.deviceCall(userA, "mac-of-a-0001", "send", map[string]any{"conversationId": "c1", "text": "hi"})
	require.Equal(t, http.StatusOK, status)
	require.True(t, res.OK)
	require.Contains(t, string(res.Value), `"method":"send"`)
	require.Contains(t, string(res.Value), `"text":"hi"`)

	// The device's own errors pass through as handler outcomes.
	status, res = h.deviceCall(userA, "mac-of-a-0001", "fail")
	require.Equal(t, http.StatusOK, status)
	require.False(t, res.OK)
	require.Equal(t, "That conversation is gone.", res.Error.Message)

	// A method the device did not list, another user's device, a device
	// that is not there.
	status, _ = h.deviceCall(userA, "mac-of-a-0001", "deleteEverything")
	require.Equal(t, http.StatusNotFound, status)
	status, res = h.deviceCall(userB, "mac-of-a-0001", "send", map[string]any{})
	require.Equal(t, http.StatusNotFound, status)
	require.Equal(t, "CLAUDEX_DEVICE_OFFLINE", res.Error.Code)
	status, _ = h.deviceCall(userA, "nobody-here-01", "send")
	require.Equal(t, http.StatusNotFound, status)
}

func TestCoworkDevicePresenceAndComputerAccess(t *testing.T) {
	h := newHost(t)
	fd, err := h.dialDevice(userA, "mac-of-a-0001", "A's Mac", []string{"send", "interrupt", "approve"}, echoDevice)
	require.NoError(t, err)
	list := func(uid int64) []DeviceInfo {
		status, res := h.do(uid, http.MethodGet, "/api/v1/claudex"+RouteDevices+"?includeOffline=1", "application/json", nil)
		require.Equal(t, http.StatusOK, status)
		var devices []DeviceInfo
		require.NoError(t, json.Unmarshal(res.Value, &devices))
		return devices
	}
	fd.send(map[string]any{"t": "status", "computerAccess": true})
	waitFor(t, "computer access on", func() bool {
		devices := list(userA)
		return len(devices) == 1 && devices[0].Online && devices[0].ComputerAccess
	})
	fd.send(map[string]any{"t": "status", "computerAccess": false})
	waitFor(t, "computer access off", func() bool { return !list(userA)[0].ComputerAccess })
	_ = fd.conn.Close(websocket.StatusNormalClosure, "")
	waitFor(t, "offline computer retained", func() bool { return !list(userA)[0].Online })
	require.Empty(t, h.devices(userA))
	require.Len(t, list(userA), 1)
	require.Empty(t, list(userB))
	status, res := h.deviceCall(userA, "mac-of-a-0001", "send", map[string]any{"conversationId": "linked-task", "text": "hi"})
	require.Equal(t, http.StatusNotFound, status)
	require.Equal(t, "CLAUDEX_DEVICE_OFFLINE", res.Error.Code)
}

func TestCoworkDeviceRegistryRetainsOfflineOwners(t *testing.T) {
	var devices deviceSet
	device := &deviceConn{userID: userA, info: DeviceInfo{ID: "pc-computer1", Name: "My Mac", ComputerAccess: true}, done: make(chan struct{})}
	_, ok := devices.add(device)
	require.True(t, ok)
	require.True(t, devices.list(userA, true)[0].Online)
	require.True(t, devices.list(userA, true)[0].ComputerAccess)
	require.Empty(t, devices.list(userB, true))
	require.True(t, devices.remove(device))
	require.Empty(t, devices.list(userA, false))
	known := devices.list(userA, true)
	require.Len(t, known, 1)
	require.False(t, known[0].Online)
	require.Equal(t, "My Mac", known[0].Name)
	require.NotEqual(t, deviceRegistryKey(userA), deviceRegistryKey(userB))
}

func TestDeviceEventsReachTheirUsersTabs(t *testing.T) {
	h := newHost(t)
	tabA := h.openTab(userA, "tab-a-000001", nil)
	tabB := h.openTab(userB, "tab-b-000001", nil)
	tabA.ready()
	tabB.ready()
	fd, err := h.dialDevice(userA, "mac-of-a-0001", "A's Mac", []string{"send"}, echoDevice)
	require.NoError(t, err)
	waitFor(t, "devices-changed", func() bool { return len(tabA.of("event")) >= 1 })
	require.JSONEq(t, `{"type":"devices-changed"}`, string(tabA.of("event")[0].Event))

	fd.send(map[string]any{"t": "event", "event": map[string]any{"type": "conversation", "conversation": map[string]any{"id": "c1", "title": "secret of A"}}})
	waitFor(t, "device event", func() bool { return len(tabA.of("event")) >= 2 })
	var ev struct {
		Type     string          `json:"type"`
		DeviceID string          `json:"deviceId"`
		Event    json.RawMessage `json:"event"`
	}
	require.NoError(t, json.Unmarshal(tabA.of("event")[1].Event, &ev))
	require.Equal(t, "device-event", ev.Type)
	require.Equal(t, "mac-of-a-0001", ev.DeviceID)
	require.Contains(t, string(ev.Event), "secret of A")
	// An event without a type is dropped.
	fd.send(map[string]any{"t": "event", "event": map[string]any{"no": "type"}})

	_ = fd.conn.Close(websocket.StatusNormalClosure, "")
	waitFor(t, "device gone", func() bool { return len(tabA.of("event")) >= 3 && len(h.devices(userA)) == 0 })
	require.JSONEq(t, `{"type":"devices-changed"}`, string(tabA.of("event")[2].Event))
	time.Sleep(50 * time.Millisecond)
	for _, f := range tabB.all() {
		require.NotContains(t, string(f.Event), "secret of A")
		require.NotContains(t, string(f.Event), "devices-changed")
	}
}

func TestDeviceLinkRefusalsAndReplacement(t *testing.T) {
	h := newHost(t)
	// A ticket bound to another id, and no ticket at all.
	_, err := h.dialDeviceWithTicket(h.ticket(userA, "other-id-0001"), "mac-of-a-0001", "A's Mac", nil, echoDevice)
	require.Error(t, err)
	_, err = h.dialDeviceWithTicket("not-a-ticket", "mac-of-a-0001", "A's Mac", nil, echoDevice)
	require.Error(t, err)
	// A user without web access.
	h.mu.Lock()
	h.denied[userB] = true
	h.mu.Unlock()
	_, err = h.dialDevice(userB, "mac-of-b-0001", "B's Mac", nil, echoDevice)
	require.Error(t, err)

	first, err := h.dialDevice(userA, "mac-of-a-0001", "A's Mac", []string{"send"}, echoDevice)
	require.NoError(t, err)
	second, err := h.dialDevice(userA, "mac-of-a-0001", "A's Mac again", []string{"send"}, echoDevice)
	require.NoError(t, err)
	require.Equal(t, websocket.StatusCode(webproto.CloseReplaced), first.closeCode())
	waitFor(t, "one device", func() bool {
		list := h.devices(userA)
		return len(list) == 1 && list[0].Name == "A's Mac again"
	})
	status, _ := h.deviceCall(userA, "mac-of-a-0001", "send")
	require.Equal(t, http.StatusOK, status)
	second.mu.Lock()
	require.Len(t, second.calls, 1)
	second.mu.Unlock()
}

func TestRevokeAndSweepCloseDeviceLinks(t *testing.T) {
	h := newHost(t)
	fa, err := h.dialDevice(userA, "mac-of-a-0001", "A's Mac", nil, echoDevice)
	require.NoError(t, err)
	fb, err := h.dialDevice(userB, "mac-of-b-0001", "B's Mac", nil, echoDevice)
	require.NoError(t, err)
	require.NoError(t, h.c.OnSessionsRevoked(context.Background(), userA, "revoke_all"))
	require.Equal(t, websocket.StatusCode(webproto.CloseSignedOut), fa.closeCode())

	h.mu.Lock()
	h.denied[userB] = true
	h.mu.Unlock()
	h.c.sweep(context.Background())
	require.Equal(t, websocket.StatusCode(webproto.CloseForbidden), fb.closeCode())
}
