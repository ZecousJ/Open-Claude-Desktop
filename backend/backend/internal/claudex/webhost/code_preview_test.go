package webhost

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
	"github.com/stretchr/testify/require"
)

type codePreviewSessions struct{ retired atomic.Bool }

func (*codePreviewSessions) Name() string { return "code-preview-test" }

func (s *codePreviewSessions) CheckWebCaller(_ context.Context, owner int64, id string, issuedAt time.Time) error {
	if owner != userA || id != "owned-session" || issuedAt.IsZero() || s.retired.Load() {
		return errors.New("session retired")
	}
	return nil
}

func TestCodePreviewRelayChecksWebSessionBeforeAndAfterRunner(t *testing.T) {
	h := newHost(t)
	sessions := &codePreviewSessions{}
	h.c.env.Components = append(h.c.env.Components, sessions)
	token := strings.Repeat("a", 32)
	var requests atomic.Int32
	_, err := h.dialRunner(localToken, []string{"snapshot", "officialUiRead"}, func(frame webproto.GoFrame) (any, *webproto.RPCError, bool) {
		var args []json.RawMessage
		_ = json.Unmarshal(frame.Args, &args)
		switch frame.Method {
		case "officialCodePreviewLease":
			var supplied string
			_ = json.Unmarshal(args[0], &supplied)
			if frame.User.ID == userA && supplied == token {
				return webproto.LinkWebSession{ID: "owned-session", IssuedAt: 1}, nil, true
			}
			return nil, nil, true
		case "officialCodePreviewRequest":
			requests.Add(1)
			var request codePreviewRequest
			if err := json.Unmarshal(args[1], &request); err != nil || request.Headers["cookie"] != "app=owned" {
				return nil, &webproto.RPCError{Message: "wrong preview request"}, true
			}
			if request.Path == "/retire-during-request" {
				sessions.retired.Store(true)
			}
			return codePreviewResponse{Status: 200, Body: []byte("owned preview")}, nil, true
		}
		return echoCalls(frame)
	})
	require.NoError(t, err)
	h.rpc(userA, "snapshot")
	request := func(path, label string) (*http.Response, codePreviewResponse) {
		body, _ := json.Marshal(codePreviewRequest{
			Method: "GET", Path: path, Headers: map[string]string{"cookie": "app=owned"},
		})
		req, err := http.NewRequest(http.MethodPost, h.srv.URL+"/api/v1/claudex"+RouteCodePreview, bytes.NewReader(body))
		require.NoError(t, err)
		req.Header.Set("X-Claude-Code-Preview", label)
		res, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer res.Body.Close()
		var answer codePreviewResponse
		if res.StatusCode == http.StatusOK {
			require.NoError(t, json.NewDecoder(res.Body).Decode(&answer))
		}
		return res, answer
	}
	label := "101-" + token
	res, _ := request("/", label+"x")
	require.Equal(t, http.StatusNotFound, res.StatusCode)
	require.Zero(t, requests.Load())
	res, answer := request("/", label)
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Equal(t, "owned preview", string(answer.Body))
	require.EqualValues(t, 1, requests.Load())
	res, _ = request("/retire-during-request", label)
	require.Equal(t, http.StatusNotFound, res.StatusCode)
	require.EqualValues(t, 2, requests.Load())
	res, _ = request("/", label)
	require.Equal(t, http.StatusNotFound, res.StatusCode)
	require.EqualValues(t, 2, requests.Load())
}
