// Package wscompat provides client-facing WebSocket handshake options.
package wscompat

import "github.com/coder/websocket"

// AcceptOptions avoids compressed frames that Apple clients reject with the
// current coder/websocket version. Origin verification retains its safe default.
// Upstream provider connections have their own independently negotiated options.
func AcceptOptions(subprotocols ...string) *websocket.AcceptOptions {
	return &websocket.AcceptOptions{
		Subprotocols:    append([]string(nil), subprotocols...),
		CompressionMode: websocket.CompressionDisabled,
	}
}
