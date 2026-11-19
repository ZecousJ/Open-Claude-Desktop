//go:build integration

package webstore

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"

	"github.com/stretchr/testify/require"
)

func TestExportConversationDates(t *testing.T) {
	c := newIT(t, 0, 0)
	accounts := users(t, 2)
	owner, other := accounts[0], accounts[1]
	start := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	end := start.AddDate(0, 0, 1)
	put := func(user int64, id string, createdAt time.Time) {
		var doc struct {
			Schema       int            `json:"schema"`
			Conversation map[string]any `json:"conversation"`
		}
		require.NoError(t, json.Unmarshal(conversationDoc(id, id), &doc))
		doc.Conversation["createdAt"] = createdAt.UnixMilli()
		doc.Conversation["updatedAt"] = end.Add(time.Hour).UnixMilli()
		must(t, c, user, "store.conversations.put", map[string]any{"doc": doc, "position": 0})
	}
	put(owner, "before", start.Add(-time.Millisecond))
	put(owner, "start", start)
	put(owner, "inside", end.Add(-time.Millisecond))
	put(owner, "end", end)
	put(other, "other", start)
	must(t, c, owner, "store.turns.put", map[string]any{"turns": []any{turnDoc("start", nil, "t1", 0, "exported prompt", "exported reply")}})
	must(t, c, owner, "store.settings.put", map[string]any{"settings": map[string]any{"theme": "dark"}})
	must(t, c, owner, "store.projects.put", map[string]any{"project": map[string]any{"id": "p", "name": "Notes"}, "position": 0})
	must(t, c, owner, "store.artifacts.put", map[string]any{"artifact": map[string]any{"id": "a", "conversationId": "before", "title": "Saved artifact"}})
	file, err := c.BeginUpload(context.Background(), owner, "note.txt", "text/plain", 4)
	require.NoError(t, err)
	_, err = c.WriteUpload(context.Background(), owner, file.ID, 0, []byte("note"))
	require.NoError(t, err)

	r := router(c)
	const startKey, endKey = "conversations_start_date", "conversations_end_date"
	for _, tc := range []struct {
		name  string
		query url.Values
		want  []string
	}{
		{"all", nil, []string{"before", "start", "inside", "end"}},
		{"range", url.Values{startKey: {"2026-11-01T08:00:00+08:00"}, endKey: {end.Format(time.RFC3339)}}, []string{"start", "inside"}},
		{"start only", url.Values{startKey: {"2026-11-01T00:00:00.0005Z"}}, []string{"inside", "end"}},
		{"end only", url.Values{endKey: {end.Format(time.RFC3339)}}, []string{"before", "start", "inside"}},
		{"empty range", url.Values{startKey: {start.Format(time.RFC3339)}, endKey: {start.Format(time.RFC3339)}}, []string{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resp := get(r, owner, RouteExport+"?"+tc.query.Encode())
			require.Equal(t, http.StatusOK, resp.Code)
			require.Equal(t, "application/zip", resp.Header().Get("Content-Type"))
			archive := unzip(t, resp.Body.Bytes())
			conversations := []string{}
			for name := range archive {
				if id, ok := strings.CutPrefix(name, "conversations/"); ok {
					conversations = append(conversations, strings.TrimSuffix(id, ".json"))
				}
			}
			require.ElementsMatch(t, tc.want, conversations)
			if content, ok := archive["conversations/start.json"]; ok {
				require.Contains(t, content, "exported prompt")
				require.Contains(t, content, "exported reply")
			}
			var manifest struct{ Conversations, Projects, Artifacts, Files int }
			require.NoError(t, json.Unmarshal([]byte(archive["manifest.json"]), &manifest))
			require.Equal(t, len(tc.want), manifest.Conversations)
			require.Equal(t, 1, manifest.Projects)
			require.Equal(t, 1, manifest.Artifacts)
			require.Equal(t, 1, manifest.Files)
			require.JSONEq(t, `{"theme":"dark"}`, archive["settings.json"])
			require.Contains(t, archive["projects.json"], "Notes")
			require.Contains(t, archive["artifacts/a.json"], "Saved artifact")
			require.Equal(t, "note", archive["files/"+file.ID+"/note.txt"])
		})
	}

	for _, tc := range []struct {
		name  string
		query string
	}{
		{"invalid start", startKey + "=2026-11-01"},
		{"blank end", endKey + "="},
		{"invalid encoding", startKey + "=%ZZ"},
		{"repeated start", url.Values{startKey: {start.Format(time.RFC3339), start.Format(time.RFC3339)}}.Encode()},
		{"repeated end", url.Values{endKey: {end.Format(time.RFC3339), end.Format(time.RFC3339)}}.Encode()},
		{"descending", url.Values{startKey: {end.Format(time.RFC3339)}, endKey: {start.Format(time.RFC3339)}}.Encode()},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resp := get(r, owner, RouteExport+"?"+tc.query)
			require.Equal(t, http.StatusBadRequest, resp.Code)
			require.Contains(t, resp.Body.String(), webproto.ErrCodeBadRequest)
			require.Empty(t, resp.Header().Get("Content-Disposition"))
		})
	}
}
