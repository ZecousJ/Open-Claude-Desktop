package ghconn

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestPushGrantForTheDesktop(t *testing.T) {
	h := newHarness(t)
	h.connect(t, 7)
	base := h.gh.srv.URL

	w, env := h.do(t, http.MethodPost, "/api/v1/claudex"+RoutePushGrant, `{"repository":"octo/repo-1"}`, 7)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var grant CloneGrant
	require.NoError(t, json.Unmarshal(env.Data, &grant))
	require.Equal(t, base+"/octo/repo-1.git", grant.URL)
	require.NotContains(t, grant.URL, testAccessTok)
	require.Equal(t, "x-access-token", grant.Username)
	require.Equal(t, testAccessTok, grant.Token)
	require.True(t, grant.CanPush)
	exp, err := time.Parse(time.RFC3339, grant.ExpiresAt)
	require.NoError(t, err)
	require.Equal(t, h.clock.Add(CloneLease), exp)

	// Only "owner/name" of the service's own GitHub.
	for _, bad := range []string{
		`{}`, `{"repository":"octo"}`, `{"repository":"octo/repo-1/extra"}`, `{"repository":"-x/y"}`,
		`{"repository":"octo/.."}`, `{"repository":"https://evil.example.com/octo/repo-1"}`, `not json`,
	} {
		w, env = h.do(t, http.MethodPost, "/api/v1/claudex"+RoutePushGrant, bad, 7)
		require.Equal(t, http.StatusBadRequest, w.Code, bad)
		require.Equal(t, ReasonBadRepo, env.Reason, bad)
	}

	// A repository the account can read but not push to.
	w, env = h.do(t, http.MethodPost, "/api/v1/claudex"+RoutePushGrant, `{"repository":"octo/readonly"}`, 7)
	require.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
	require.Equal(t, ReasonNoAccess, env.Reason)

	// One it cannot see at all.
	w, env = h.do(t, http.MethodPost, "/api/v1/claudex"+RoutePushGrant, `{"repository":"octo/secret"}`, 7)
	require.Equal(t, http.StatusNotFound, w.Code)
	require.Equal(t, ReasonNoAccess, env.Reason)

	// Nobody else's connection is used.
	w, env = h.do(t, http.MethodPost, "/api/v1/claudex"+RoutePushGrant, `{"repository":"octo/repo-1"}`, 8)
	require.Equal(t, http.StatusConflict, w.Code)
	require.Equal(t, ReasonNotConnected, env.Reason)
}

func TestPushGrantWhenTurnedOff(t *testing.T) {
	h := newHarness(t)
	w, env := h.do(t, http.MethodPost, "/api/v1/claudex"+RoutePushGrant, `{"repository":"octo/repo-1"}`, 7)
	require.NotEqual(t, http.StatusOK, w.Code)
	require.Equal(t, ReasonNotConfigured, env.Reason)
}
