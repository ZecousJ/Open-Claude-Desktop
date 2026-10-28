//go:build integration

package webstore

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/core/testsupport"
	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/migrations"

	"github.com/gin-gonic/gin"
	_ "github.com/lib/pq"
	"github.com/stretchr/testify/require"
)

var itDB *sql.DB

func TestMain(m *testing.M) {
	ctx := context.Background()
	pg, err := testsupport.StartPostgres(ctx, "claudex_webstore_test")
	if err != nil {
		if testsupport.Skip(err) {
			log.Printf("docker is not available; skipping the webstore integration tests: %v", err)
			os.Exit(0)
		}
		log.Fatalf("start postgres: %v", err)
	}
	itDB, err = pg.Open(ctx)
	if err != nil {
		log.Fatalf("open db: %v", err)
	}
	// A stand-in for the upstream users table (id, email, soft delete).
	if _, err := itDB.ExecContext(ctx, `CREATE TABLE users (id BIGSERIAL PRIMARY KEY, email VARCHAR(255) NOT NULL DEFAULT '', deleted_at TIMESTAMPTZ NULL);
INSERT INTO users (email) SELECT 'user' || g || '@example.com' FROM generate_series(1, 40) AS g;`); err != nil {
		log.Fatalf("schema: %v", err)
	}
	ddl, err := migrations.FS.ReadFile("claudex_0081_web_store.sql")
	if err != nil {
		log.Fatalf("read migration: %v", err)
	}
	for i := 0; i < 2; i++ { // idempotent
		if _, err := itDB.ExecContext(ctx, string(ddl)); err != nil {
			log.Fatalf("migration run %d: %v", i, err)
		}
	}
	code := m.Run()
	_ = itDB.Close()
	pg.Terminate(ctx)
	os.Exit(code)
}

// newIT returns a component on the test database with its own file folder
// and the given limits (0 = defaults).
func newIT(t *testing.T, quota, maxFile int64) *Component {
	t.Helper()
	c := New(&core.Env{Deps: core.Deps{DB: itDB}})
	c.blobs = blobs{root: t.TempDir()}
	if quota == 0 {
		quota = 1 << 30
	}
	if maxFile == 0 {
		maxFile = 30 << 20
	}
	c.limits = func(context.Context) Limits { return Limits{QuotaBytes: quota, MaxFileBytes: maxFile} }
	return c
}

// Users are handed out per test so tests never share rows.
var nextUser int64

func users(t *testing.T, n int) []int64 {
	t.Helper()
	out := make([]int64, n)
	for i := range out {
		nextUser++
		require.LessOrEqual(t, nextUser, int64(40), "add users in TestMain")
		out[i] = nextUser
	}
	return out
}

func call(t *testing.T, c *Component, user int64, op string, body any) (map[string]json.RawMessage, error) {
	t.Helper()
	raw, err := json.Marshal(body)
	require.NoError(t, err)
	v, err := c.ServeRunnerOp(context.Background(), user, op, raw)
	if err != nil {
		return nil, err
	}
	out, err := json.Marshal(v)
	require.NoError(t, err)
	var m map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(out, &m))
	return m, nil
}

func must(t *testing.T, c *Component, user int64, op string, body any) map[string]json.RawMessage {
	t.Helper()
	m, err := call(t, c, user, op, body)
	require.NoError(t, err, op)
	return m
}

func conversationDoc(id, title string) json.RawMessage {
	doc, _ := json.Marshal(map[string]any{"schema": 1, "conversation": map[string]any{
		"id": id, "title": title, "mode": "chat", "providerId": "sub2api", "model": "gpt-5.5",
		"pinned": false, "archived": false, "createdAt": 1790000000000, "updatedAt": 1790000000000,
	}})
	return doc
}

func turnDoc(conversationID string, branch *string, turnID string, ordinal int, prompt, reply string) map[string]any {
	return map[string]any{"schema": 1, "conversationId": conversationID, "branchId": branch, "turnId": turnID, "ordinal": ordinal,
		"turn": map[string]any{"id": turnID, "prompt": prompt, "attachments": []any{}, "status": "completed", "createdAt": 1790000000000,
			"items": []any{
				map[string]any{"id": turnID + "-c", "type": "commandExecution", "command": "cat secret.txt", "aggregatedOutput": "hunter2"},
				map[string]any{"id": turnID + "-m", "type": "agentMessage", "text": reply},
			}}}
}

func usageNow(t *testing.T, c *Component, user int64) Usage {
	t.Helper()
	u, _, err := c.Usage(context.Background(), user)
	require.NoError(t, err)
	return u
}

// actualBytes sums the rows, to check the usage counters.
func actualBytes(t *testing.T, user int64) (docs, files int64) {
	t.Helper()
	require.NoError(t, itDB.QueryRow(`SELECT
  COALESCE((SELECT SUM(bytes) FROM claudex_web_settings WHERE user_id = $1), 0)
+ COALESCE((SELECT SUM(bytes) FROM claudex_web_projects WHERE user_id = $1), 0)
+ COALESCE((SELECT SUM(bytes) FROM claudex_web_conversations WHERE user_id = $1), 0)
+ COALESCE((SELECT SUM(bytes) FROM claudex_web_turns WHERE user_id = $1), 0)
+ COALESCE((SELECT SUM(bytes) FROM claudex_web_artifacts WHERE user_id = $1), 0)
+ COALESCE((SELECT SUM(bytes) FROM claudex_web_artifact_versions WHERE user_id = $1), 0),
  COALESCE((SELECT SUM(size) FROM claudex_web_files WHERE user_id = $1), 0)`, user).Scan(&docs, &files))
	return docs, files
}

func requireCountersExact(t *testing.T, c *Component, user int64) {
	t.Helper()
	docs, files := actualBytes(t, user)
	require.Equal(t, Usage{DocBytes: docs, FileBytes: files}, usageNow(t, c, user))
}

func TestRoundTripLikeCloudStore(t *testing.T) {
	c := newIT(t, 0, 0)
	u := users(t, 1)[0]

	got := must(t, c, u, "store.settings.get", map[string]any{})
	require.JSONEq(t, `null`, string(got["settings"]))
	must(t, c, u, "store.settings.put", map[string]any{"settings": map[string]any{"theme": "dark", "text": "a\u0000b"}})
	got = must(t, c, u, "store.settings.get", map[string]any{})
	require.JSONEq(t, `{"theme":"dark","text":"a�b"}`, string(got["settings"]))

	must(t, c, u, "store.projects.put", map[string]any{"project": map[string]any{"id": "p2", "name": "Two"}, "position": 1})
	must(t, c, u, "store.projects.put", map[string]any{"project": map[string]any{"id": "p1", "name": "One"}, "position": 0})
	got = must(t, c, u, "store.projects.list", map[string]any{})
	require.JSONEq(t, `[{"id":"p1","name":"One"},{"id":"p2","name":"Two"}]`, string(got["projects"]))

	got = must(t, c, u, "store.conversations.put", map[string]any{"doc": conversationDoc("c1", "First"), "position": 0})
	require.JSONEq(t, `1`, string(got["revision"]))
	branch := "b1"
	got = must(t, c, u, "store.turns.put", map[string]any{"turns": []any{
		turnDoc("c1", nil, "t2", 1, "second", "reply two"),
		turnDoc("c1", nil, "t1", 0, "first", "reply one"),
		turnDoc("c1", &branch, "t0", 0, "old", "old reply"),
	}})
	require.JSONEq(t, `2`, string(got["revision"]))
	// One turn document on its own (the golden request frame's body).
	var single map[string]any
	require.NoError(t, json.Unmarshal(golden(t, "doc.turn.in-progress"), &single))
	single["conversationId"] = "c1"
	must(t, c, u, "store.turns.put", single)

	got = must(t, c, u, "store.turns.list", map[string]any{"conversationId": "c1"})
	var turns []webproto.TurnDoc
	require.NoError(t, json.Unmarshal(got["turns"], &turns))
	require.Len(t, turns, 4)
	var order []string
	for _, tr := range turns {
		order = append(order, strOr(tr.BranchID)+"/"+tr.TurnID)
	}
	require.Equal(t, "/t1", order[0])
	require.Equal(t, "b1/t0", order[len(order)-1])

	got = must(t, c, u, "store.conversations.list", map[string]any{})
	var items []ConversationRow
	require.NoError(t, json.Unmarshal(got["items"], &items))
	require.Len(t, items, 1)
	_, meta, err := webproto.DecodeConversationDoc(items[0].Doc)
	require.NoError(t, err)
	require.Equal(t, "First", *meta.Title)

	got = must(t, c, u, "store.conversations.get", map[string]any{"id": "c1"})
	require.NotEqual(t, "null", string(got["doc"]))

	must(t, c, u, "store.turns.delete", map[string]any{"conversationId": "c1", "keys": []any{map[string]any{"branchId": "b1", "turnId": "t0"}}})
	got = must(t, c, u, "store.turns.list", map[string]any{"conversationId": "c1"})
	require.NoError(t, json.Unmarshal(got["turns"], &turns))
	require.Len(t, turns, 3)
	requireCountersExact(t, c, u)

	// Artifacts go with their conversation.
	must(t, c, u, "store.artifacts.put", map[string]any{"artifact": map[string]any{"id": "a1", "conversationId": "c1", "title": "Doc", "content": "v1"}})
	must(t, c, u, "store.conversations.delete", map[string]any{"id": "c1"})
	got = must(t, c, u, "store.artifacts.list", map[string]any{})
	require.JSONEq(t, `[]`, string(got["artifacts"]))
	_, err = call(t, c, u, "store.turns.list", map[string]any{"conversationId": "c1"})
	require.Equal(t, ErrCodeNotFound, opCode(t, err))
	must(t, c, u, "store.projects.delete", map[string]any{"id": "p1"})
	must(t, c, u, "store.projects.delete", map[string]any{"id": "p1"}) // idempotent
	requireCountersExact(t, c, u)
}

func TestListsPage(t *testing.T) {
	c := newIT(t, 0, 0)
	u := users(t, 1)[0]
	for i := 0; i < pageRows+5; i++ {
		must(t, c, u, "store.conversations.put", map[string]any{"doc": conversationDoc(fmt.Sprintf("c%03d", i), "t"), "position": i})
	}
	seen := 0
	cursor := ""
	for pages := 0; ; pages++ {
		require.Less(t, pages, 5)
		got := must(t, c, u, "store.conversations.list", map[string]any{"cursor": cursor})
		var items []ConversationRow
		require.NoError(t, json.Unmarshal(got["items"], &items))
		for _, it := range items {
			require.Equal(t, seen, it.Position)
			seen++
		}
		if got["next"] == nil {
			break
		}
		require.NoError(t, json.Unmarshal(got["next"], &cursor))
	}
	require.Equal(t, pageRows+5, seen)
	_, err := call(t, c, u, "store.conversations.list", map[string]any{"cursor": "garbage!"})
	require.Equal(t, webproto.ErrCodeBadRequest, opCode(t, err))
}

// The core guarantee: user B, using exactly the same ids as user A, can
// neither read nor change anything of A's, through any op, the service
// methods or the download routes.
func TestTenantIsolation(t *testing.T) {
	c := newIT(t, 0, 0)
	ids := users(t, 2)
	a, b := ids[0], ids[1]
	secret := "A的秘密-zebra-42"

	must(t, c, a, "store.settings.put", map[string]any{"settings": map[string]any{"note": secret}})
	must(t, c, a, "store.projects.put", map[string]any{"project": map[string]any{"id": "p1", "name": secret}, "position": 0})
	must(t, c, a, "store.conversations.put", map[string]any{"doc": conversationDoc("c1", secret), "position": 0})
	must(t, c, a, "store.turns.put", map[string]any{"turns": []any{turnDoc("c1", nil, "t1", 0, secret, secret)}})
	must(t, c, a, "store.artifacts.put", map[string]any{"artifact": map[string]any{"id": "a1", "conversationId": "c1", "title": secret}})
	fa := must(t, c, a, "store.files.put", map[string]any{"name": "a.txt", "size": len(secret), "offset": 0,
		"bytes": map[string]string{"$bytes": base64.StdEncoding.EncodeToString([]byte(secret))}})
	var fileA FileInfo
	raw, _ := json.Marshal(fa)
	require.NoError(t, json.Unmarshal(raw, &fileA))
	require.True(t, fileA.Complete)
	aBefore := usageNow(t, c, a)

	// Reads by B see nothing of A.
	got := must(t, c, b, "store.settings.get", map[string]any{})
	require.Equal(t, "null", string(got["settings"]))
	got = must(t, c, b, "store.projects.list", map[string]any{})
	require.Equal(t, "[]", string(got["projects"]))
	got = must(t, c, b, "store.conversations.list", map[string]any{})
	require.Equal(t, "[]", string(got["items"]))
	got = must(t, c, b, "store.conversations.get", map[string]any{"id": "c1"})
	require.Equal(t, "null", string(got["doc"]))
	_, err := call(t, c, b, "store.turns.list", map[string]any{"conversationId": "c1"})
	require.Equal(t, ErrCodeNotFound, opCode(t, err))
	got = must(t, c, b, "store.artifacts.list", map[string]any{})
	require.Equal(t, "[]", string(got["artifacts"]))
	got = must(t, c, b, "store.artifacts.list", map[string]any{"conversationId": "c1"})
	require.Equal(t, "[]", string(got["artifacts"]))
	_, err = call(t, c, b, "store.artifacts.list", map[string]any{"artifactId": "a1"})
	require.Equal(t, ErrCodeNotFound, opCode(t, err))
	_, err = call(t, c, b, "store.files.get", map[string]any{"id": fileA.ID, "offset": 0, "length": 100})
	require.Equal(t, ErrCodeNotFound, opCode(t, err))
	got = must(t, c, b, "store.search", map[string]any{"query": "zebra"})
	require.Equal(t, "[]", string(got["results"]))
	_, err = c.ShareSnapshot(context.Background(), b, "c1")
	require.Equal(t, ErrCodeNotFound, opCode(t, err))

	// Writes by B never reach A's rows.
	_, err = call(t, c, b, "store.turns.put", map[string]any{"turns": []any{turnDoc("c1", nil, "t1", 0, "overwrite", "overwrite")}})
	require.Equal(t, ErrCodeNotFound, opCode(t, err))
	_, err = c.WriteUpload(context.Background(), b, fileA.ID, 0, []byte("x"))
	require.Equal(t, ErrCodeNotFound, opCode(t, err))
	must(t, c, b, "store.turns.delete", map[string]any{"conversationId": "c1", "keys": []any{map[string]any{"branchId": nil, "turnId": "t1"}}})
	must(t, c, b, "store.conversations.delete", map[string]any{"id": "c1"})
	must(t, c, b, "store.projects.delete", map[string]any{"id": "p1"})
	must(t, c, b, "store.artifacts.delete", map[string]any{"id": "a1"})
	must(t, c, b, "store.files.delete", map[string]any{"id": fileA.ID})
	// B's own rows with the same ids are separate rows.
	must(t, c, b, "store.projects.put", map[string]any{"project": map[string]any{"id": "p1", "name": "B"}, "position": 0})
	must(t, c, b, "store.conversations.put", map[string]any{"doc": conversationDoc("c1", "B title"), "position": 0})
	must(t, c, b, "store.turns.put", map[string]any{"turns": []any{turnDoc("c1", nil, "t1", 0, "B prompt", "B reply")}})
	must(t, c, b, "store.artifacts.put", map[string]any{"artifact": map[string]any{"id": "a1", "title": "B"}})
	must(t, c, b, "store.conversations.delete", map[string]any{"id": "c1"})

	// A still has everything, unchanged.
	got = must(t, c, a, "store.settings.get", map[string]any{})
	require.Contains(t, string(got["settings"]), secret)
	got = must(t, c, a, "store.projects.list", map[string]any{})
	require.Contains(t, string(got["projects"]), secret)
	got = must(t, c, a, "store.turns.list", map[string]any{"conversationId": "c1"})
	require.Contains(t, string(got["turns"]), secret)
	got = must(t, c, a, "store.conversations.get", map[string]any{"id": "c1"})
	require.Contains(t, string(got["doc"]), secret)
	got = must(t, c, a, "store.artifacts.list", map[string]any{"artifactId": "a1"})
	require.Contains(t, string(got["versions"]), secret)
	got = must(t, c, a, "store.files.get", map[string]any{"id": fileA.ID})
	require.Contains(t, string(got["bytes"]), base64.StdEncoding.EncodeToString([]byte(secret)))
	got = must(t, c, a, "store.search", map[string]any{"query": "zebra"})
	require.Contains(t, string(got["results"]), `"c1"`)
	require.Equal(t, aBefore, usageNow(t, c, a))
	requireCountersExact(t, c, a)
	requireCountersExact(t, c, b)

	// The same bytes uploaded by B are B's own blob, in B's folder.
	fb, err := c.BeginUpload(context.Background(), b, "b.txt", "text/plain", int64(len(secret)))
	require.NoError(t, err)
	fb, err = c.WriteUpload(context.Background(), b, fb.ID, 0, []byte(secret))
	require.NoError(t, err)
	require.Equal(t, fileA.SHA256, fb.SHA256)
	require.FileExists(t, c.blobs.blobPath(a, fileA.SHA256))
	require.FileExists(t, c.blobs.blobPath(b, fb.SHA256))
	require.NoError(t, c.DeleteFile(context.Background(), b, fb.ID))
	require.NoFileExists(t, c.blobs.blobPath(b, fb.SHA256))
	require.FileExists(t, c.blobs.blobPath(a, fileA.SHA256))

	// Browser downloads: B gets 404 for A's file; the export has nothing of A.
	r := router(c)
	require.Equal(t, http.StatusNotFound, get(r, b, "/web/downloads/files/"+fileA.ID).Code)
	resp := get(r, a, "/web/downloads/files/"+fileA.ID)
	require.Equal(t, http.StatusOK, resp.Code)
	require.Equal(t, secret, resp.Body.String())
	require.Equal(t, "nosniff", resp.Header().Get("X-Content-Type-Options"))
	require.Contains(t, resp.Header().Get("Content-Disposition"), "attachment")
	require.Equal(t, http.StatusUnauthorized, get(r, 0, "/web/downloads/files/"+fileA.ID).Code)

	exp := get(r, b, "/web/downloads/export")
	require.Equal(t, http.StatusOK, exp.Code)
	for name, body := range unzip(t, exp.Body.Bytes()) {
		require.NotContains(t, body, secret, name)
		require.NotContains(t, body, "zebra", name)
	}
	expA := unzip(t, get(r, a, "/web/downloads/export").Body.Bytes())
	require.Contains(t, expA["conversations/c1.json"], secret)
	require.Contains(t, expA["files/"+fileA.ID+"/a.txt"], secret)
	require.Contains(t, expA["manifest.json"], ExportFormat)
}

func router(c *Component) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(func(g *gin.Context) {
		if u := g.GetHeader("X-Test-User"); u != "" && u != "0" {
			var id int64
			_, _ = fmt.Sscan(u, &id)
			g.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: id})
		}
		g.Next()
	})
	c.RegisterUserRoutes(r.Group("/"))
	return r
}

func get(r *gin.Engine, user int64, path string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Header.Set("X-Test-User", fmt.Sprint(user))
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func unzip(t *testing.T, data []byte) map[string]string {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	require.NoError(t, err)
	out := map[string]string{}
	for _, f := range zr.File {
		rc, err := f.Open()
		require.NoError(t, err)
		b, err := io.ReadAll(rc)
		require.NoError(t, err)
		_ = rc.Close()
		out[f.Name] = string(b)
	}
	require.Contains(t, out, "manifest.json")
	return out
}

func TestQuotaAndFileLimits(t *testing.T) {
	c := newIT(t, 2000, 800)
	u := users(t, 1)[0]
	ctx := context.Background()

	_, err := c.BeginUpload(ctx, u, "big", "", 900)
	require.Equal(t, webproto.ErrCodeTooLarge, opCode(t, err))
	f1, err := c.BeginUpload(ctx, u, "one", "", 700)
	require.NoError(t, err)
	_, err = c.BeginUpload(ctx, u, "two", "", 700)
	require.NoError(t, err)
	// 1400 reserved: another 700 would pass the quota.
	_, err = c.BeginUpload(ctx, u, "three", "", 700)
	require.Equal(t, webproto.ErrCodeQuotaExceeded, opCode(t, err))
	// Documents: a new conversation stops at the quota too.
	_, err = call(t, c, u, "store.conversations.put", map[string]any{"doc": conversationDoc("c1", strings.Repeat("x", 600)), "position": 0})
	require.Equal(t, webproto.ErrCodeQuotaExceeded, opCode(t, err))
	require.NoError(t, c.DeleteFile(ctx, u, f1.ID))
	must(t, c, u, "store.conversations.put", map[string]any{"doc": conversationDoc("c1", "t"), "position": 0})
	// Turns of an existing conversation get the 10% grace (2200 bytes).
	usage := usageNow(t, c, u)
	room := int((2000*11/10 - usage.Total()))
	pad := strings.Repeat("y", room-600)
	must(t, c, u, "store.turns.put", map[string]any{"turns": []any{turnDoc("c1", nil, "t1", 0, pad, "")}})
	_, err = call(t, c, u, "store.turns.put", map[string]any{"turns": []any{turnDoc("c1", nil, "t2", 1, strings.Repeat("z", 800), "")}})
	require.Equal(t, webproto.ErrCodeQuotaExceeded, opCode(t, err))
	// Shrinking always works.
	must(t, c, u, "store.turns.put", map[string]any{"turns": []any{turnDoc("c1", nil, "t1", 0, "small", "")}})
	requireCountersExact(t, c, u)
}

func TestChunkedUpload(t *testing.T) {
	c := newIT(t, 0, 0)
	u := users(t, 1)[0]
	ctx := context.Background()
	data := []byte("hello, chunked world")
	f, err := c.BeginUpload(ctx, u, "../../evil.txt", "text/plain; charset=utf-8", int64(len(data)))
	require.NoError(t, err)
	require.Equal(t, "evil.txt", f.Name)
	require.Equal(t, "text/plain", f.Mime)
	require.False(t, f.Complete)

	_, err = c.WriteUpload(ctx, u, f.ID, 5, data[5:])
	require.Equal(t, webproto.ErrCodeBadRequest, opCode(t, err))
	f, err = c.WriteUpload(ctx, u, f.ID, 0, data[:5])
	require.NoError(t, err)
	require.Equal(t, int64(5), f.Received)
	_, err = c.WriteUpload(ctx, u, f.ID, 5, append(append([]byte{}, data[5:]...), 'x'))
	require.Equal(t, webproto.ErrCodeBadRequest, opCode(t, err))
	f, err = c.WriteUpload(ctx, u, f.ID, 5, data[5:])
	require.NoError(t, err)
	require.True(t, f.Complete)
	sum := sha256.Sum256(data)
	require.Equal(t, hex.EncodeToString(sum[:]), f.SHA256)
	// A retried last chunk answers the same state.
	again, err := c.WriteUpload(ctx, u, f.ID, 5, data[5:])
	require.NoError(t, err)
	require.True(t, again.Complete)
	_, err = c.WriteUpload(ctx, u, f.ID, int64(len(data)), []byte("more"))
	require.Equal(t, webproto.ErrCodeBadRequest, opCode(t, err))
	require.NoFileExists(t, c.blobs.tmpPath(u, f.ID))

	// Read back in pieces as the runner does.
	got := must(t, c, u, "store.files.get", map[string]any{"id": f.ID, "offset": 7, "length": 7})
	var piece struct {
		Size  int64             `json:"size"`
		Bytes map[string]string `json:"bytes"`
	}
	raw, _ := json.Marshal(got)
	require.NoError(t, json.Unmarshal(raw, &piece))
	require.Equal(t, int64(len(data)), piece.Size)
	b, _ := base64.StdEncoding.DecodeString(piece.Bytes["$bytes"])
	require.Equal(t, "chunked", string(b))

	// An empty file is complete at once.
	e, err := c.BeginUpload(ctx, u, "empty", "", 0)
	require.NoError(t, err)
	require.True(t, e.Complete)

	// Runner puts in two requests.
	first := must(t, c, u, "store.files.put", map[string]any{"name": "gen.bin", "size": 6, "offset": 0,
		"bytes": map[string]string{"$bytes": base64.StdEncoding.EncodeToString([]byte("abc"))}})
	var id string
	require.NoError(t, json.Unmarshal(first["id"], &id))
	require.Equal(t, "false", string(first["complete"]))
	second := must(t, c, u, "store.files.put", map[string]any{"id": id, "offset": 3,
		"bytes": map[string]string{"$bytes": base64.StdEncoding.EncodeToString([]byte("def"))}})
	require.Equal(t, "true", string(second["complete"]))
	require.Equal(t, `"runner"`, string(second["origin"]))
	requireCountersExact(t, c, u)
}

func TestSearchFindsTitlesAndTextInAnyLanguage(t *testing.T) {
	c := newIT(t, 0, 0)
	u := users(t, 1)[0]
	must(t, c, u, "store.conversations.put", map[string]any{"doc": conversationDoc("c1", "旅行计划"), "position": 0})
	must(t, c, u, "store.conversations.put", map[string]any{"doc": conversationDoc("c2", "Other"), "position": 1})
	must(t, c, u, "store.turns.put", map[string]any{"turns": []any{
		turnDoc("c2", nil, "t1", 0, "帮我写一首关于秋天的诗", "秋风起兮白云飞"),
	}})
	got := must(t, c, u, "store.search", map[string]any{"query": "旅行"})
	var hits []SearchHit
	require.NoError(t, json.Unmarshal(got["results"], &hits))
	require.Len(t, hits, 1)
	require.Equal(t, "c1", hits[0].ConversationID)
	require.Empty(t, hits[0].TurnID)

	got = must(t, c, u, "store.search", map[string]any{"query": "秋天"})
	require.NoError(t, json.Unmarshal(got["results"], &hits))
	require.Len(t, hits, 1)
	require.Equal(t, "t1", hits[0].TurnID)
	require.Contains(t, hits[0].Snippet, "秋天")

	// Tool commands and output are not searchable; LIKE wildcards are text.
	got = must(t, c, u, "store.search", map[string]any{"query": "hunter2"})
	require.Equal(t, "[]", string(got["results"]))
	got = must(t, c, u, "store.search", map[string]any{"query": "%"})
	require.Equal(t, "[]", string(got["results"]))

	archived := conversationDoc("c1", "旅行计划")
	var m map[string]any
	require.NoError(t, json.Unmarshal(archived, &m))
	m["conversation"].(map[string]any)["archived"] = true
	archived, _ = json.Marshal(m)
	must(t, c, u, "store.conversations.put", map[string]any{"doc": archived, "position": 0})
	got = must(t, c, u, "store.search", map[string]any{"query": "旅行"})
	require.Equal(t, "[]", string(got["results"]))
	got = must(t, c, u, "store.search", map[string]any{"query": "旅行", "includeArchived": true})
	require.NoError(t, json.Unmarshal(got["results"], &hits))
	require.Len(t, hits, 1)
	require.True(t, hits[0].Archived)
}

func TestSearchScopesProjectBeforeLimit(t *testing.T) {
	c := newIT(t, 0, 0)
	user := users(t, 1)[0]
	for index, projectID := range []string{"other", "project"} {
		var doc map[string]any
		require.NoError(t, json.Unmarshal(conversationDoc(fmt.Sprintf("c%d", index), "needle"), &doc))
		doc["conversation"].(map[string]any)["projectId"] = projectID
		must(t, c, user, "store.conversations.put", map[string]any{"doc": doc, "position": index})
	}
	got := must(t, c, user, "store.search", map[string]any{"query": "needle", "projectId": "project", "limit": 1})
	var hits []SearchHit
	require.NoError(t, json.Unmarshal(got["results"], &hits))
	require.Len(t, hits, 1)
	require.Equal(t, "c1", hits[0].ConversationID)
	got = must(t, c, user, "store.search", map[string]any{"query": "needle", "projectId": "missing"})
	require.Equal(t, "[]", string(got["results"]))
}

func TestArtifactVersions(t *testing.T) {
	c := newIT(t, 0, 0)
	u := users(t, 1)[0]
	put := func(content string) int {
		got := must(t, c, u, "store.artifacts.put", map[string]any{"artifact": map[string]any{"id": "a1", "title": "T", "content": content}})
		var v int
		require.NoError(t, json.Unmarshal(got["version"], &v))
		return v
	}
	require.Equal(t, 1, put("one"))
	require.Equal(t, 1, put("one")) // unchanged: no new version
	require.Equal(t, 2, put("two"))
	for i := 3; i <= maxArtifactVersions+3; i++ {
		require.Equal(t, i, put(fmt.Sprint("v", i)))
	}
	got := must(t, c, u, "store.artifacts.list", map[string]any{"artifactId": "a1"})
	var versions []ArtifactVersion
	require.NoError(t, json.Unmarshal(got["versions"], &versions))
	require.Len(t, versions, maxArtifactVersions)
	require.Equal(t, maxArtifactVersions+3, versions[0].Version)
	requireCountersExact(t, c, u)
	must(t, c, u, "store.artifacts.delete", map[string]any{"id": "a1"})
	requireCountersExact(t, c, u)
	require.Equal(t, int64(0), usageNow(t, c, u).DocBytes)
}

func TestShareSnapshotLeavesToolDetailsOut(t *testing.T) {
	c := newIT(t, 0, 0)
	u := users(t, 1)[0]
	must(t, c, u, "store.conversations.put", map[string]any{"doc": conversationDoc("c1", "Shared"), "position": 0})
	branch := "old"
	must(t, c, u, "store.turns.put", map[string]any{"turns": []any{
		turnDoc("c1", nil, "t1", 0, "question", "answer"),
		turnDoc("c1", &branch, "t9", 0, "abandoned", "abandoned"),
	}})
	snap, err := c.ShareSnapshot(context.Background(), u, "c1")
	require.NoError(t, err)
	raw, _ := json.Marshal(snap)
	require.NotContains(t, string(raw), "hunter2")
	require.NotContains(t, string(raw), "secret.txt")
	require.NotContains(t, string(raw), "abandoned")
	require.Equal(t, "Shared", snap.Title)
	require.Len(t, snap.Messages, 2)
	require.Equal(t, []string{"Ran a command"}, snap.Messages[1].Activity)
}

func TestCleanupPurgesDeletedAccountsAndStaleUploads(t *testing.T) {
	c := newIT(t, 0, 0)
	ids := users(t, 2)
	gone, kept := ids[0], ids[1]
	ctx := context.Background()
	for _, u := range ids {
		must(t, c, u, "store.conversations.put", map[string]any{"doc": conversationDoc("c1", "t"), "position": 0})
		f, err := c.BeginUpload(ctx, u, "f", "", 3)
		require.NoError(t, err)
		_, err = c.WriteUpload(ctx, u, f.ID, 0, []byte("abc"))
		require.NoError(t, err)
	}
	stale, err := c.BeginUpload(ctx, kept, "stale", "", 10)
	require.NoError(t, err)
	_, err = c.WriteUpload(ctx, kept, stale.ID, 0, []byte("12345"))
	require.NoError(t, err)
	_, err = itDB.Exec(`UPDATE claudex_web_files SET updated_at = NOW() - INTERVAL '2 days' WHERE user_id = $1 AND id = $2`, kept, stale.ID)
	require.NoError(t, err)
	_, err = itDB.Exec(`UPDATE users SET deleted_at = NOW() WHERE id = $1`, gone)
	require.NoError(t, err)
	// An orphan blob (no row), old enough.
	orphan := c.blobs.blobPath(kept, strings.Repeat("0", 64))
	require.NoError(t, os.WriteFile(orphan, []byte("x"), 0o600))
	old := time.Now().Add(-2 * time.Hour)
	require.NoError(t, os.Chtimes(orphan, old, old))

	st, err := c.Cleanup(ctx)
	require.NoError(t, err)
	require.Equal(t, 1, st.StaleUploads)
	require.GreaterOrEqual(t, st.DeletedAccounts, 1)
	require.Equal(t, 1, st.OrphanBlobs)

	got := must(t, c, gone, "store.conversations.list", map[string]any{})
	require.Equal(t, "[]", string(got["items"]))
	require.NoDirExists(t, c.blobs.userDir(gone))
	require.Equal(t, Usage{}, usageNow(t, c, gone))

	got = must(t, c, kept, "store.conversations.list", map[string]any{})
	require.NotEqual(t, "[]", string(got["items"]))
	_, err = c.File(ctx, kept, stale.ID)
	require.Equal(t, ErrCodeNotFound, opCode(t, err))
	require.NoFileExists(t, c.blobs.tmpPath(kept, stale.ID))
	require.NoFileExists(t, orphan)
	requireCountersExact(t, c, kept)
	entries, _ := os.ReadDir(filepath.Join(c.blobs.userDir(kept), "blobs"))
	require.Len(t, entries, 1)
}
