//go:build integration

package memory

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"
)

const coworkPath = "/api/v1/claudex/memory/cowork"

func coworkResult(t *testing.T, r result) coworkView {
	t.Helper()
	require.Equal(t, 200, r.Status, r.Raw)
	var v coworkView
	r.into(t, &v)
	return v
}
func TestIntegrationCoworkAuthority(t *testing.T) {
	db := freshDB(t, false)
	a := newFixture(t, fixtureOptions{db: db})
	b := newFixture(t, fixtureOptions{db: db})
	v := coworkResult(t, a.do("GET", coworkPath, ""))
	require.Equal(t, "0", v.Epoch)
	require.Equal(t, "0", v.Revision)
	require.Empty(t, v.Entries)
	v = coworkResult(t, a.do("PUT", coworkPath, `{"expected_epoch":"0","entries":{"MEMORY.md":"index","work.md":"private-canary"}}`))
	require.Equal(t, "1", v.Revision)
	var encrypted string
	require.NoError(t, db.QueryRow(`SELECT entries_enc FROM claudex_memory_cowork WHERE user_id=7`).Scan(&encrypted))
	require.NotContains(t, encrypted, "private-canary")
	require.Equal(t, http.StatusPreconditionFailed, a.do("PUT", coworkPath, `{"expected_epoch":"0","expected_revision":"0","entries":{"work.md":"stale"}}`).Status)
	require.Equal(t, v.Entries, coworkResult(t, b.do("GET", coworkPath, "")).Entries)
	b.userID = 8
	require.Empty(t, coworkResult(t, b.do("GET", coworkPath, "")).Entries)
	v = coworkResult(t, a.do("PUT", coworkPath, `{"expected_epoch":"0","expected_revision":"1","entries":{"MEMORY.md":"clean"},"delete_keys":["work.md"]}`))
	require.Equal(t, map[string]string{"MEMORY.md": "clean"}, v.Entries)
	for _, body := range []string{`{"expected_epoch":"0","entries":{"../bad.md":"x"}}`, `{"expected_epoch":"0","entries":{"x.md":null}}`, `{"expected_epoch":"0","delete_keys":["*"]}`, `{"expected_epoch":"0","entries":{"x.md":"x"},"delete_keys":["x.md"]}`} {
		require.Equal(t, 400, a.do("PUT", coworkPath, body).Status, body)
	}
	a.pol.Enabled = false
	require.Equal(t, 403, a.do("PUT", coworkPath, `{"expected_epoch":"0","entries":{"x.md":"x"}}`).Status)
	v = coworkResult(t, a.do("DELETE", coworkPath, `{"expected_epoch":"0"}`))
	require.Equal(t, "1", v.Epoch)
	require.Empty(t, v.Entries)
	a.pol.Enabled = true
	require.Equal(t, 409, a.do("PUT", coworkPath, `{"expected_epoch":"0","entries":{"work.md":"stale"}}`).Status)
	require.Equal(t, 200, a.do("PUT", coworkPath, `{"expected_epoch":"1","entries":{"work.md":"new"}}`).Status)
	require.Equal(t, 200, a.do("DELETE", "/api/v1/claudex/memory", "").Status)
	v = coworkResult(t, a.do("GET", coworkPath, ""))
	require.Equal(t, "2", v.Epoch)
	require.Empty(t, v.Entries)
	require.Equal(t, 409, a.do("PUT", coworkPath, `{"expected_epoch":"1","entries":{"work.md":"stale"}}`).Status)
}
func TestIntegrationCoworkConcurrentRevision(t *testing.T) {
	db := freshDB(t, false)
	a := newFixture(t, fixtureOptions{db: db})
	b := newFixture(t, fixtureOptions{db: db})
	var wg sync.WaitGroup
	out := make(chan int, 2)
	for i, f := range []*fixture{a, b} {
		wg.Add(1)
		go func(i int, f *fixture) {
			defer wg.Done()
			body, _ := json.Marshal(map[string]any{"expected_epoch": "0", "expected_revision": "0", "entries": map[string]string{fmt.Sprintf("%d.md", i): "v"}})
			out <- f.do("PUT", coworkPath, string(body)).Status
		}(i, f)
	}
	wg.Wait()
	close(out)
	counts := map[int]int{}
	for status := range out {
		counts[status]++
	}
	require.Equal(t, 1, counts[200])
	require.Equal(t, 1, counts[412])
}
