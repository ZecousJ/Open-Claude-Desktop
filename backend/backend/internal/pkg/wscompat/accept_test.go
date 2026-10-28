package wscompat

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// This is a standalone synthetic transport test, without application services,
// accounts, tickets, credentials, relays, providers or production requests.
func TestClientFramesWithoutCompression(t *testing.T) {
	for _, typ := range []websocket.MessageType{websocket.MessageText, websocket.MessageBinary} {
		t.Run(fmt.Sprint(typ), func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			serverDone := make(chan error, 1)
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				conn, err := websocket.Accept(w, r, AcceptOptions("claudex.v1"))
				if err != nil {
					serverDone <- err
					return
				}
				defer conn.CloseNow()
				for _, size := range []int{100, 800, 5000, 50000} {
					if err := conn.Write(ctx, typ, bytes.Repeat([]byte("x"), size)); err != nil {
						serverDone <- err
						return
					}
				}
				serverDone <- nil
				conn.Close(websocket.StatusNormalClosure, "done")
			}))
			defer srv.Close()
			conn, response, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http"), &websocket.DialOptions{
				Subprotocols:    []string{"claudex.v1"},
				CompressionMode: websocket.CompressionNoContextTakeover,
			})
			if err != nil {
				t.Fatal(err)
			}
			defer conn.CloseNow()
			if extension := response.Header.Get("Sec-WebSocket-Extensions"); extension != "" {
				t.Fatalf("server negotiated compression: %q", extension)
			}
			if conn.Subprotocol() != "claudex.v1" {
				t.Fatal("lost selected subprotocol")
			}
			conn.SetReadLimit(64 << 10)
			for _, size := range []int{100, 800, 5000, 50000} {
				gotType, data, err := conn.Read(ctx)
				if err != nil || gotType != typ || !bytes.Equal(data, bytes.Repeat([]byte("x"), size)) {
					t.Fatalf("frame size %d: type=%v length=%d error=%v", size, gotType, len(data), err)
				}
			}
			if err := <-serverDone; err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestCrossOriginStillRejected(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, AcceptOptions())
		if err == nil {
			conn.CloseNow()
		}
	}))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, response, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http"), &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": {"https://foreign.invalid"}},
	})
	if conn != nil {
		conn.CloseNow()
	}
	if err == nil || response == nil || response.StatusCode != http.StatusForbidden {
		t.Fatalf("cross-origin handshake: response=%v error=%v", response, err)
	}
}
