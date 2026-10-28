package webhost

import (
	"context"
	"encoding/json"
	"strconv"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
	"github.com/coder/websocket"
	"github.com/stretchr/testify/require"
)

func TestChatDevicesNegotiateAndRelayOnlyTheAuthenticatedScope(t *testing.T) {
	h := newHost(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	id := "chat-device-a-001"
	conn, _, err := websocket.Dial(ctx, h.wsURL("/api/v1/claudex"+RouteDeviceLink), &websocket.DialOptions{Subprotocols: []string{webproto.EventsSubprotocol, webproto.TicketSubprotocolPrefix + h.ticket(userA, id)}})
	require.NoError(t, err)
	t.Cleanup(func() { _ = conn.CloseNow() })
	fd := &fakeDevice{t: t, conn: conn, answer: echoDevice, closed: make(chan struct{})}
	fd.send(map[string]any{"t": "hello", "v": 1, "deviceId": id, "name": "Real link", "platform": "darwin", "version": "1", "methods": []string{"chatDeviceSend", "chatDeviceOpen"}, "computerAccess": true, "chatBindingVersion": 1, "chatPermissionModes": []string{"default", "auto"}, "chatModes": []string{"chat", "cowork"}})
	_, data, err := conn.Read(ctx)
	require.NoError(t, err)
	require.Contains(t, string(data), `"t":"welcome"`)
	go fd.loop()
	value, err := h.c.chatDeviceRequest(ctx, userA, "device.list", nil)
	require.NoError(t, err)
	directory, _ := value.(map[string]any)
	require.Equal(t, strconv.FormatInt(userA, 10), directory["accountScope"])
	require.Nil(t, directory["organizationId"])
	devices, _ := directory["devices"].([]DeviceInfo)
	require.Len(t, devices, 1)
	require.Equal(t, 1, devices[0].ChatBindingVersion)
	require.NotNil(t, devices[0].LastSeenAt)
	require.NotNil(t, devices[0].AddedAt)
	request := func(account string, organization any, version int) json.RawMessage {
		body, _ := json.Marshal(map[string]any{"version": version, "deviceId": id, "method": "chatDeviceSend", "args": []any{map[string]any{"version": 1, "accountScope": account, "organizationId": organization, "text": "Reference"}}})
		return body
	}
	_, err = h.c.chatDeviceRequest(ctx, userA, "device.call", request(strconv.FormatInt(userA, 10), nil, 1))
	require.NoError(t, err)
	fd.mu.Lock()
	require.Len(t, fd.calls, 1)
	fd.mu.Unlock()
	_, err = h.c.chatDeviceRequest(ctx, userB, "device.call", request(strconv.FormatInt(userB, 10), nil, 1))
	require.Error(t, err)
	_, err = h.c.chatDeviceRequest(ctx, userA, "device.call", request(strconv.FormatInt(userB, 10), nil, 1))
	require.Error(t, err)
	_, err = h.c.chatDeviceRequest(ctx, userA, "device.call", request(strconv.FormatInt(userA, 10), "unsupported-org", 1))
	require.Error(t, err)
	_, err = h.c.chatDeviceRequest(ctx, userA, "device.call", request(strconv.FormatInt(userA, 10), nil, 2))
	require.Error(t, err)
	fd.mu.Lock()
	require.Len(t, fd.calls, 1, "rejected scopes never reach a device")
	fd.mu.Unlock()
	require.True(t, webproto.IsUserOp("device.list"))
	require.True(t, webproto.IsUserOp("device.call"), "runner assignment checking must cover device ops")
}

func TestOldChatDeviceHelloDoesNotClaimV1Support(t *testing.T) {
	h := newHost(t)
	_, err := h.dialDevice(userA, "old-device-0001", "Old link", []string{"chatDeviceSend"}, echoDevice)
	require.NoError(t, err)
	value, err := h.c.chatDeviceRequest(context.Background(), userA, "device.list", nil)
	require.NoError(t, err)
	listed, _ := value.(map[string]any)
	devices, _ := listed["devices"].([]DeviceInfo)
	require.Len(t, devices, 1)
	require.Zero(t, devices[0].ChatBindingVersion)
	body, _ := json.Marshal(map[string]any{"version": 1, "deviceId": "old-device-0001", "method": "chatDeviceSend", "args": []any{map[string]any{"version": 1, "accountScope": strconv.FormatInt(userA, 10), "organizationId": nil}}})
	_, err = h.c.chatDeviceRequest(context.Background(), userA, "device.call", body)
	require.Error(t, err, "an RPC name alone is not a version negotiation")
	require.False(t, validChatDeviceModes([]string{"code"}, []string{"default"}))
	require.False(t, validChatDeviceModes([]string{"chat"}, []string{"bypass"}))
}

func TestAssignedChatRelayPreservesProofAndValidatesBothScopes(t *testing.T) {
	h := newHost(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	id := "chat-trust-device-01"
	conn, _, err := websocket.Dial(ctx, h.wsURL("/api/v1/claudex"+RouteDeviceLink), &websocket.DialOptions{Subprotocols: []string{webproto.EventsSubprotocol, webproto.TicketSubprotocolPrefix + h.ticket(userA, id)}})
	require.NoError(t, err)
	t.Cleanup(func() { _ = conn.CloseNow() })
	fd := &fakeDevice{t: t, conn: conn, answer: echoDevice, closed: make(chan struct{})}
	fd.send(map[string]any{"t": "hello", "v": 1, "deviceId": id, "name": "Proof host", "platform": "darwin", "version": "1", "methods": []string{"chatDeviceSend", "deviceTrustChallenge", "deviceTrustEnroll"}, "computerAccess": true, "chatBindingVersion": 1, "chatModes": []string{"chat"}, "chatPermissionModes": []string{"default"}})
	_, _, err = conn.Read(ctx)
	require.NoError(t, err)
	go fd.loop()
	scope := func(uid int64) map[string]any {
		return map[string]any{"version": 1, "accountScope": strconv.FormatInt(uid, 10), "organizationId": nil}
	}
	call := func(method string, arg any, outer any) error {
		body := map[string]any{"version": 1, "deviceId": id, "method": method, "args": []any{arg}}
		if outer != nil {
			body["scope"] = outer
		}
		raw, _ := json.Marshal(body)
		_, e := h.c.chatDeviceRequest(ctx, userA, "device.call", raw)
		return e
	}
	directory, err := h.c.chatDeviceRequest(ctx, userA, "device.list", nil)
	require.NoError(t, err)
	listed, _ := directory.(map[string]any)
	require.Equal(t, 1, listed["deviceTrustRelayVersion"])
	require.NoError(t, call("deviceTrustChallenge", map[string]any{"publicKey": "test key", "name": "Runner", "platform": "linux"}, scope(userA)))
	enroll := map[string]any{"deviceTrust": map[string]any{"challengeId": "challenge", "signature": "proof"}, "args": []any{}}
	require.NoError(t, call("deviceTrustEnroll", enroll, scope(userA)))
	envelope := map[string]any{"deviceTrust": map[string]any{"challengeId": "challenge2", "signature": "proof2"}, "args": []any{scope(userA)}}
	require.NoError(t, call("chatDeviceSend", envelope, scope(userA)))
	fd.mu.Lock()
	require.Len(t, fd.calls, 3)
	expected, _ := json.Marshal(envelope)
	var forwarded []json.RawMessage
	require.NoError(t, json.Unmarshal(fd.calls[2].Args, &forwarded))
	require.Equal(t, json.RawMessage(expected), forwarded[0])
	fd.mu.Unlock()
	require.Error(t, call("chatDeviceSend", envelope, scope(userB)))
	envelope["args"] = []any{scope(userB)}
	require.Error(t, call("chatDeviceSend", envelope, scope(userA)))
	require.Error(t, call("deviceTrustEnroll", enroll, nil))
	require.Error(t, call("deviceTrustChallenge", map[string]any{"publicKey": "key"}, nil))
	require.Error(t, call("approveDeviceTrust", scope(userA), scope(userA)))
	fd.mu.Lock()
	require.Len(t, fd.calls, 3, "rejected scopes and local-only authorities never reach a host")
	fd.mu.Unlock()
}
