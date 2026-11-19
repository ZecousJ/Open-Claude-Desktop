package memory

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func controlsBody(controls []string, version string) string {
	raw, _ := json.Marshal(map[string]any{"controls": controls, "base_controls_version": version})
	return string(raw)
}

func exerciseControls(t *testing.T, f *fixture) {
	t.Helper()
	const path = "/api/v1/claudex/memory/controls/global"
	prefs := f.do("PUT", "/api/v1/claudex/memory/prefs", `{"generate":true}`)
	require.Equal(t, 200, prefs.Status, prefs.Raw)
	initial := f.memory()
	base := initial.EmptyControlsVersion
	require.NotEmpty(t, base)
	save := f.do("PUT", path, controlsBody([]string{"Use metric", "Concise replies", "Use metric"}, base))
	require.Equal(t, 200, save.Status, save.Raw)
	saved := f.memory()
	require.Len(t, saved.Edits, 3)
	require.Equal(t, "Use metric", *saved.Edits[0].Text)
	require.Equal(t, "Concise replies", *saved.Edits[1].Text)
	require.NotEqual(t, base, saved.ControlsVersions["global"])
	stale := f.do("PUT", path, controlsBody([]string{"Overwrite"}, base))
	require.Equal(t, 409, stale.Status, stale.Raw)
	require.Equal(t, "CLAUDEX_MEMORY_CONTROLS_CONFLICT", stale.Reason)
	for _, list := range [][]string{{"Valid", "password=secret123"}, {""}, {strings.Repeat("x", 501)}, make([]string, 51)} {
		rejected := f.do("PUT", path, controlsBody(list, saved.ControlsVersions["global"]))
		require.GreaterOrEqual(t, rejected.Status, 400, rejected.Raw)
		require.Equal(t, saved.Edits, f.memory().Edits)
	}
	// The user's identity comes from authentication; no payload can select it.
	f.userID = 8
	other := f.memory()
	require.Empty(t, other.Edits)
	require.Equal(t, 200, f.do("PUT", "/api/v1/claudex/memory/prefs", `{"generate":true}`).Status)
	require.Equal(t, 200, f.do("PUT", path, controlsBody([]string{"Other user"}, other.EmptyControlsVersion)).Status)
	f.userID = 7
	require.Equal(t, saved.Edits, f.memory().Edits)
	// Regeneration cannot commit a result using controls that changed in flight.
	old := saved.ControlsVersions["global"]
	require.Equal(t, 201, f.do("POST", "/api/v1/claudex/memory/edits", `{"scope":"global","text":"New preference"}`).Status)
	generated := f.do("PUT", "/api/v1/claudex/memory/docs/global", `{"content":"Old result","source":"generated","base_revision":0,"base_controls_version":"`+old+`"}`)
	require.Equal(t, 409, generated.Status, generated.Raw)
	require.Empty(t, f.memory().Docs)
	current := f.memory().ControlsVersions["global"]
	require.Equal(t, 200, f.do("DELETE", "/api/v1/claudex/memory/docs/global", "").Status)
	reset := f.do("PUT", path, controlsBody([]string{"Resurrect"}, current))
	require.Equal(t, 409, reset.Status, reset.Raw)
	require.Equal(t, "CLAUDEX_MEMORY_CONTROLS_RESET", reset.Reason)
	tombstone := f.memory().ControlsVersions["global"]
	require.NotEmpty(t, tombstone)
	require.Equal(t, 200, f.do("PUT", path, controlsBody([]string{"After reset"}, tombstone)).Status)
	allBase := f.memory().ControlsVersions["global"]
	require.Equal(t, 200, f.do("DELETE", "/api/v1/claudex/memory", "").Status)
	require.Equal(t, "CLAUDEX_MEMORY_CONTROLS_RESET", f.do("PUT", path, controlsBody([]string{"Resurrect"}, allBase)).Reason)
	require.Equal(t, "Other user", *func() *string { f.userID = 8; return f.memory().Edits[0].Text }())
	f.userID = 7
	require.Equal(t, 400, f.do("PUT", path, controlsBody([]string{}, base)+` {"extra":true}`).Status)
}

func TestControls(t *testing.T) { exerciseControls(t, newFixture(t)) }

func TestControlsRequireEnabledPolicyAndPrefs(t *testing.T) {
	f := newFixture(t)
	f.pol.DefaultOn = false
	base := f.memory().EmptyControlsVersion
	require.Equal(t, http.StatusForbidden, f.do("PUT", "/api/v1/claudex/memory/controls/global", controlsBody([]string{"Hi"}, base)).Status)
	require.Empty(t, f.memory().Edits)
}

func TestControlsSnapshotHasConsistentToken(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	first, err := f.c.store.snapshot(ctx, 7, "global")
	require.NoError(t, err)
	_, version, err := f.c.store.replaceControls(ctx, 7, "global", []editWrite{{TextEnc: "sealed", TextBytes: 6}}, first.EmptyVersion)
	require.NoError(t, err)
	next, err := f.c.store.snapshot(ctx, 7, "global")
	require.NoError(t, err)
	require.Equal(t, version, next.Versions["global"])
	require.Len(t, next.Edits, 1)
}
