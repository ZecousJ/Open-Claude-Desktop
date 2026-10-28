package webhost

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/geoip"
	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
	"github.com/stretchr/testify/require"
)

func TestLocationRequestUsesTheAssignedUsersRecordedIP(t *testing.T) {
	c := New(nil)
	c.backends()
	c.reg.assign[7] = "runner-a"
	c.reg.assign[8] = "runner-b"
	c.tokens.put(7, userToken{ip: "1.1.1.1", claims: Claims{ExpiresAt: time.Now().Add(time.Hour)}})
	c.tokens.put(8, userToken{ip: "8.8.8.8", claims: Claims{ExpiresAt: time.Now().Add(time.Hour)}})
	rc := &runnerConn{c: c, id: "runner-a", out: make(chan []byte, 1), done: make(chan struct{})}
	request := func(userID int64) webproto.GoFrame {
		rc.serveRequest(context.Background(), webproto.RunnerFrame{T: "request", ID: "location-1", Op: "location.get", UserID: userID})
		var frame webproto.GoFrame
		require.NoError(t, json.Unmarshal(<-rc.out, &frame))
		return frame
	}
	frame := request(7)
	require.True(t, *frame.OK)
	var location geoip.Location
	require.NoError(t, json.Unmarshal(frame.Value, &location))
	require.Equal(t, geoip.Lookup("1.1.1.1"), location)
	frame = request(8)
	require.False(t, *frame.OK)
	require.Equal(t, webproto.ErrCodeNotAllowed, frame.Error.Code)
	c.tokens.forget(7)
	frame = request(7)
	require.False(t, *frame.OK)
}
