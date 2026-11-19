//go:build integration

package memory

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

const melangePath = "/api/v1/claudex/memory/melange"

const classifiedMemory = `{"mode":"melange","files":[{"path":"preferences/work.md","content":"private-classified-canary","updated_at":"2026-11-13T10:00:00Z"}],"externalImport":{"status":"pending","id":"00000000-0000-4000-8000-000000000001","ts":"2026-11-13T10:00:00Z","source":{"kind":"external","content":"import-canary","redacted":false}}}`

func melangeBody(base int64, state string) string {
	return fmt.Sprintf(`{"base_revision":%d,"state":%s}`, base, state)
}

func requireMelange(t *testing.T, res result, revision int64, state string) {
	t.Helper()
	require.Equal(t, http.StatusOK, res.Status, res.Raw)
	require.Equal(t, "no-store", res.Header.Get("Cache-Control"))
	require.JSONEq(t, fmt.Sprintf(`{"revision":%d,"state":%s}`, revision, state), string(res.Data))
}

func TestIntegrationMelangePersistsEncryptedStateAndResets(t *testing.T) {
	db := freshDB(t, false)
	f := newFixture(t, fixtureOptions{db: db})
	requireMelange(t, f.do(http.MethodGet, melangePath, ""), 0, "null")
	requireMelange(t, f.do(http.MethodPut, melangePath, melangeBody(0, classifiedMemory)), 1, classifiedMemory)
	var encrypted string
	require.NoError(t, db.QueryRow(`SELECT state_enc FROM claudex_memory_melange WHERE user_id = 7`).Scan(&encrypted))
	require.NotContains(t, encrypted, "private-classified-canary")
	decrypted, err := f.c.box.Open(encrypted)
	require.NoError(t, err)
	require.JSONEq(t, classifiedMemory, decrypted)

	restarted := newFixture(t, fixtureOptions{db: db})
	requireMelange(t, restarted.do(http.MethodGet, melangePath, ""), 1, classifiedMemory)
	restarted.userID = 8
	requireMelange(t, restarted.do(http.MethodGet, melangePath, ""), 0, "null")
	other := `{"mode":"melange","files":[]}`
	requireMelange(t, restarted.do(http.MethodPut, melangePath, melangeBody(0, other)), 1, other)
	res := f.do(http.MethodPut, melangePath, melangeBody(0, other))
	require.Equal(t, http.StatusConflict, res.Status)
	require.Equal(t, "CLAUDEX_MEMORY_CONFLICT", res.Reason)
	require.Equal(t, "1", res.Meta["current_revision"])
	requireMelange(t, f.do(http.MethodGet, melangePath, ""), 1, classifiedMemory)

	require.Equal(t, http.StatusOK, f.do(http.MethodDelete, "/api/v1/claudex/memory/docs/global", "").Status)
	requireMelange(t, f.do(http.MethodGet, melangePath, ""), 1, classifiedMemory)
	res = f.do(http.MethodGet, "/api/v1/admin/claudex/memory/users/7", "")
	require.Equal(t, http.StatusOK, res.Status)
	require.NotContains(t, res.Raw, "private-classified-canary")
	var metadata AdminUserMemory
	res.into(t, &metadata)
	require.Equal(t, 1, metadata.Documents)
	require.Equal(t, len(classifiedMemory), metadata.TotalBytes)
	res = f.do(http.MethodGet, "/api/v1/admin/claudex/memory/stats", "")
	require.Equal(t, http.StatusOK, res.Status)
	var stats AdminStats
	res.into(t, &stats)
	require.EqualValues(t, 2, stats.UsersWithMemory)
	require.EqualValues(t, 2, stats.Documents)

	res = f.do(http.MethodDelete, "/api/v1/admin/claudex/memory/users/7", "")
	require.Equal(t, http.StatusOK, res.Status)
	require.JSONEq(t, `{"deleted_docs":1,"deleted_edits":0}`, string(res.Data))
	requireMelange(t, f.do(http.MethodGet, melangePath, ""), 2, "null")
	res = f.do(http.MethodPut, melangePath, melangeBody(1, classifiedMemory))
	require.Equal(t, http.StatusConflict, res.Status)
	require.Equal(t, "2", res.Meta["current_revision"])
	requireMelange(t, restarted.do(http.MethodGet, melangePath, ""), 1, other)

	f.userID = 9
	require.Equal(t, http.StatusOK, f.do(http.MethodDelete, "/api/v1/claudex/memory", "").Status)
	requireMelange(t, f.do(http.MethodGet, melangePath, ""), 1, "null")
	res = f.do(http.MethodPut, melangePath, melangeBody(0, classifiedMemory))
	require.Equal(t, http.StatusConflict, res.Status)
	require.Equal(t, "1", res.Meta["current_revision"])
	_, err = db.Exec(`DELETE FROM users WHERE id = 8`)
	require.NoError(t, err)
	require.Zero(t, count(t, db, `SELECT COUNT(*) FROM claudex_memory_melange WHERE user_id = 8`))
}

func TestIntegrationMelangeModeUpdatesClassicGeneration(t *testing.T) {
	db := freshDB(t, false)
	f := newFixture(t, fixtureOptions{db: db})
	f.pol.DefaultOn = true
	const classic = `{"mode":"classic","files":[]}`
	const off = `{"mode":"off","files":[]}`
	require.True(t, f.memory().Effective.Generate)
	requireMelange(t, f.do(http.MethodPut, melangePath, melangeBody(0, classifiedMemory)), 1, classifiedMemory)
	require.Equal(t, Switches{SearchChats: true, Generate: false}, f.memory().Effective)
	res := f.do(http.MethodPut, "/api/v1/claudex/memory/docs/global", `{"content":"stale Classic summary","source":"generated","base_revision":0}`)
	require.Equal(t, http.StatusForbidden, res.Status)
	require.Empty(t, f.memory().Docs)
	require.Equal(t, http.StatusOK, f.do(http.MethodPut, "/api/v1/claudex/memory/prefs", `{"search_chats":false}`).Status)
	require.Equal(t, Switches{SearchChats: false, Generate: false}, f.memory().Effective)

	requireMelange(t, f.do(http.MethodPut, melangePath, melangeBody(1, classic)), 2, classic)
	require.Equal(t, Switches{SearchChats: false, Generate: true}, f.memory().Effective)
	res = f.do(http.MethodPut, melangePath, melangeBody(1, off))
	require.Equal(t, http.StatusConflict, res.Status)
	require.True(t, f.memory().Effective.Generate)
	require.Equal(t, http.StatusOK, f.do(http.MethodPut, "/api/v1/claudex/memory/prefs", `{"generate":false}`).Status)
	requireMelange(t, f.do(http.MethodPut, melangePath, melangeBody(2, classic)), 3, classic)
	require.False(t, f.memory().Effective.Generate)

	f.pol.Generate = false
	res = f.do(http.MethodPut, melangePath, melangeBody(3, classifiedMemory))
	require.Equal(t, http.StatusForbidden, res.Status)
	require.Equal(t, "generate", res.Meta["field"])
	requireMelange(t, f.do(http.MethodPut, melangePath, melangeBody(3, off)), 4, off)
	f.pol.Enabled = false
	res = f.do(http.MethodPut, melangePath, melangeBody(4, classic))
	require.Equal(t, http.StatusForbidden, res.Status)
	require.Equal(t, "memory", res.Meta["field"])
	requireMelange(t, f.do(http.MethodGet, melangePath, ""), 4, off)

	f.pol = defaultPolicy()
	_, err := db.Exec(`ALTER TABLE claudex_memory_prefs ADD CHECK (NOT generate)`)
	require.NoError(t, err)
	res = f.do(http.MethodPut, melangePath, melangeBody(4, classic))
	require.Equal(t, http.StatusInternalServerError, res.Status)
	requireMelange(t, f.do(http.MethodGet, melangePath, ""), 4, off)
	require.False(t, f.memory().Effective.Generate)
}

func TestIntegrationMelangeRejectsInvalidStateWithoutChangingIt(t *testing.T) {
	db := freshDB(t, false)
	f := newFixture(t, fixtureOptions{db: db})
	requireMelange(t, f.do(http.MethodPut, melangePath, melangeBody(0, classifiedMemory)), 1, classifiedMemory)
	for _, body := range []string{
		`{"state":{"mode":"melange"}}`,
		melangeBody(-1, classifiedMemory),
		melangeBody(1, `null`),
		melangeBody(1, `[]`),
		melangeBody(1, `{"mode":"unknown"}`),
		melangeBody(1, classifiedMemory) + `{}`,
	} {
		res := f.do(http.MethodPut, melangePath, body)
		require.Equal(t, http.StatusBadRequest, res.Status, res.Raw)
		require.Equal(t, "CLAUDEX_MEMORY_INVALID", res.Reason)
	}
	state := `{"mode":"melange","files":[],"payload":"` + strings.Repeat("x", 1<<20) + `"}`
	res := f.do(http.MethodPut, melangePath, melangeBody(1, state))
	require.Equal(t, http.StatusRequestEntityTooLarge, res.Status)
	require.Equal(t, "CLAUDEX_MEMORY_TOO_LARGE", res.Reason)
	require.Equal(t, "state_bytes", res.Meta["limit"])
	requireMelange(t, f.do(http.MethodGet, melangePath, ""), 1, classifiedMemory)

	noKey := newFixture(t, fixtureOptions{db: db, keyMissing: true})
	for _, method := range []string{http.MethodGet, http.MethodPut} {
		res = noKey.do(method, melangePath, melangeBody(1, classifiedMemory))
		require.Equal(t, http.StatusServiceUnavailable, res.Status)
		require.Equal(t, "CLAUDEX_MEMORY_ENCRYPTION_KEY_MISSING", res.Reason)
	}
	requireMelange(t, f.do(http.MethodGet, melangePath, ""), 1, classifiedMemory)
}

func TestIntegrationMelangeConcurrentWritersAtOneRevision(t *testing.T) {
	db := freshDB(t, false)
	first := newFixture(t, fixtureOptions{db: db})
	second := newFixture(t, fixtureOptions{db: db})
	const classic = `{"mode":"classic","files":[]}`
	start := make(chan struct{})
	responses := make(chan *httptest.ResponseRecorder, 2)
	for f, state := range map[*fixture]string{first: classifiedMemory, second: classic} {
		go func() {
			<-start
			req := httptest.NewRequest(http.MethodPut, melangePath, strings.NewReader(melangeBody(0, state)))
			req.Header.Set("Content-Type", "application/json")
			res := httptest.NewRecorder()
			f.router.ServeHTTP(res, req)
			responses <- res
		}()
	}
	close(start)
	a, b := <-responses, <-responses
	require.ElementsMatch(t, []int{http.StatusOK, http.StatusConflict}, []int{a.Code, b.Code})
	if b.Code == http.StatusOK {
		a = b
	}
	var accepted result
	require.NoError(t, json.Unmarshal(a.Body.Bytes(), &accepted))
	var winner melangeView
	accepted.into(t, &winner)
	requireMelange(t, first.do(http.MethodGet, melangePath, ""), 1, string(winner.State))
	require.Equal(t, string(winner.State) == classic, first.memory().Effective.Generate)
}
