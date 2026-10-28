package webhost

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
)

// A runner may ask for a scheduled-task token only for a user it serves, only
// while the account is active and the web app admits it, and the token is then
// the one key.get and the deadline interrupt use.
func TestRoutineTokenIsIssuedOnlyForServedAdmittedUsers(t *testing.T) {
	h := newHost(t)
	fr := h.runner()
	h.rpc(userA, "listThings") // assigns A to the runner

	res := fr.request("t1", webproto.OpRoutineToken, userA, map[string]any{})
	require.True(t, *res.OK, "%+v", res.Error)
	var v map[string]string
	require.NoError(t, json.Unmarshal(res.Value, &v))
	require.NotEmpty(t, v["accessToken"])

	// Another runner's user: refused before anything is minted.
	res = fr.request("t2", webproto.OpRoutineToken, userB, map[string]any{})
	require.False(t, *res.OK)
	require.Equal(t, webproto.ErrCodeNotAllowed, res.Error.Code)

	// A turned-off account and one the allowlist no longer admits get none.
	h.mu.Lock()
	h.blocked[userA] = true
	h.mu.Unlock()
	res = fr.request("t3", webproto.OpRoutineToken, userA, map[string]any{})
	require.False(t, *res.OK)
	h.mu.Lock()
	h.blocked[userA] = false
	h.denied[userA] = true
	h.mu.Unlock()
	res = fr.request("t4", webproto.OpRoutineToken, userA, map[string]any{})
	require.False(t, *res.OK)
}
