package webhost

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"

	"github.com/stretchr/testify/require"
)

// fakeGitHub answers github.* ops with the user it was asked for.
type fakeGitHub struct{}

func (fakeGitHub) ServeGitHubOp(_ context.Context, userID int64, op string, body json.RawMessage) (any, error) {
	return map[string]any{"user": userID, "op": op, "body": json.RawMessage(body)}, nil
}

// TestGitHubCloneIsServedForTheRoutedUserOnly: a runner's github.clone runs
// for a user assigned to that runner, like the store and key requests.
func TestGitHubCloneIsServedForTheRoutedUserOnly(t *testing.T) {
	h := newHost(t)
	fr := h.runner()
	h.rpc(userA, "listThings")

	res := fr.request("g1", webproto.OpGitHubClone, userA, map[string]any{"url": "https://github.com/o/r"})
	require.True(t, *res.OK, "%+v", res.Error)
	var v map[string]any
	require.NoError(t, json.Unmarshal(res.Value, &v))
	require.EqualValues(t, userA, v["user"])
	require.Equal(t, webproto.OpGitHubClone, v["op"])

	res = fr.request("g2", webproto.OpGitHubClone, userB, map[string]any{"url": "https://github.com/o/r"})
	require.False(t, *res.OK)
	require.Equal(t, webproto.ErrCodeNotAllowed, res.Error.Code)
}
