package webstore

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"

	"github.com/stretchr/testify/require"
)

func golden(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "webproto", "testdata", name+".json"))
	require.NoError(t, err)
	return raw
}

func opCode(t *testing.T, err error) string {
	t.Helper()
	var op *OpError
	require.True(t, errors.As(err, &op), "want an OpError, got %v", err)
	return op.Code
}

func TestComponentIsInstalledAsWebStore(t *testing.T) {
	c := New(&core.Env{})
	require.Equal(t, core.NameWebStore, c.Name())
	var _ RunnerStore = c
	// Without a database nothing runs in the background.
	c.Start(context.Background())
}

func TestOpsAreTheStoreOpsOfTheProtocol(t *testing.T) {
	want := []string{}
	for _, op := range webproto.RunnerOps {
		if strings.HasPrefix(op, "store.") {
			want = append(want, op)
		}
	}
	require.Equal(t, want, Ops())
	require.NotContains(t, Ops(), "key.get")
	// Every op is answered (none falls through to "unknown request"): without
	// a database each one fails validation or storage, never as unknown.
	c := New(&core.Env{})
	for _, op := range Ops() {
		_, err := c.ServeRunnerOp(context.Background(), 7, op, json.RawMessage(`{}`))
		if err != nil {
			require.NotEqual(t, webproto.ErrCodeMethodUnavailable, opCode(t, err), op)
		}
	}
}

func TestServeRunnerOpRefusesBadRequests(t *testing.T) {
	c := New(&core.Env{})
	ctx := context.Background()
	cases := []struct {
		name, op, body, code string
		user                 int64
	}{
		{"unknown op", "store.nope", `{}`, webproto.ErrCodeMethodUnavailable, 7},
		{"key op", "key.get", `{}`, webproto.ErrCodeMethodUnavailable, 7},
		{"no user", "store.settings.get", `{}`, webproto.ErrCodeBadRequest, 0},
		{"array body", "store.settings.put", `[1]`, webproto.ErrCodeBadRequest, 7},
		{"settings not object", "store.settings.put", `{"settings":[1]}`, webproto.ErrCodeBadRequest, 7},
		{"unknown field", "store.settings.put", `{"settings":{},"x":1}`, webproto.ErrCodeBadRequest, 7},
		{"project id", "store.projects.put", `{"project":{"id":"a/b"},"position":0}`, webproto.ErrCodeBadRequest, 7},
		{"project position", "store.projects.put", `{"project":{"id":"p"},"position":-1}`, webproto.ErrCodeBadRequest, 7},
		{"delete id", "store.projects.delete", `{"id":""}`, webproto.ErrCodeBadRequest, 7},
		{"conversation doc", "store.conversations.put", `{"doc":{"schema":2,"conversation":{}},"position":0}`, webproto.ErrCodeBadRequest, 7},
		{"turn schema", "store.turns.put", `{"turns":[{"schema":2}]}`, webproto.ErrCodeBadRequest, 7},
		{"turns list id", "store.turns.list", `{"conversationId":"../x"}`, webproto.ErrCodeBadRequest, 7},
		{"turns delete key", "store.turns.delete", `{"conversationId":"c","keys":[{"branchId":null,"turnId":""}]}`, webproto.ErrCodeBadRequest, 7},
		{"artifact id", "store.artifacts.put", `{"artifact":{"id":""}}`, webproto.ErrCodeBadRequest, 7},
		{"artifact conversation", "store.artifacts.put", `{"artifact":{"id":"a","conversationId":"a b"}}`, webproto.ErrCodeBadRequest, 7},
		{"file bytes", "store.files.put", `{"size":1,"offset":0,"bytes":"aGk="}`, webproto.ErrCodeBadRequest, 7},
		{"file base64", "store.files.put", `{"size":1,"offset":0,"bytes":{"$bytes":"!!"}}`, webproto.ErrCodeBadRequest, 7},
		{"file new offset", "store.files.put", `{"size":2,"offset":1,"bytes":{"$bytes":"aA=="}}`, webproto.ErrCodeBadRequest, 7},
		{"search mode", "store.search", `{"query":"x","mode":"desktop"}`, webproto.ErrCodeBadRequest, 7},
		{"search length", "store.search", `{"query":"` + strings.Repeat("字", maxQuery+1) + `"}`, webproto.ErrCodeBadRequest, 7},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := c.ServeRunnerOp(ctx, tc.user, tc.op, json.RawMessage(tc.body))
			require.Error(t, err)
			require.Equal(t, tc.code, opCode(t, err))
		})
	}
}

func TestServeRunnerOpWithoutDatabaseFailsCleanly(t *testing.T) {
	c := New(&core.Env{})
	_, err := c.ServeRunnerOp(context.Background(), 7, "store.settings.get", nil)
	require.Equal(t, webproto.ErrCodeHandlerFailed, opCode(t, err))
	var op *OpError
	require.ErrorAs(t, err, &op)
	// The answer never carries the internal cause.
	require.NotContains(t, op.RPCError().Message, "database")
	require.NoError(t, webproto.RPCResponse{Error: op.RPCError()}.Validate())
}

func TestDecodeTurnsTakesAListOrOneDocument(t *testing.T) {
	one := golden(t, "doc.turn.completed")
	rows, err := decodeTurns(one)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.Equal(t, "", rows[0].branch)

	saved := golden(t, "doc.turn.saved-branch")
	body, _ := json.Marshal(map[string][]json.RawMessage{"turns": {one, saved}})
	rows, err = decodeTurns(body)
	require.NoError(t, err)
	require.Len(t, rows, 2)
	require.NotEmpty(t, rows[1].branch)

	body, _ = json.Marshal(map[string][]json.RawMessage{"turns": {one, one}})
	_, err = decodeTurns(body)
	require.Equal(t, webproto.ErrCodeBadRequest, opCode(t, err))

	big := strings.Repeat("x", webproto.TurnDocBytes)
	_, err = decodeTurns(json.RawMessage(`{"turns":["` + big + `"]}`))
	require.Equal(t, webproto.ErrCodeTooLarge, opCode(t, err))
}

func TestJSONBSafeReplacesNULOnly(t *testing.T) {
	cases := map[string]string{
		`{"a":"x\u0000y"}`:     `{"a":"x\ufffdy"}`,
		`{"a":"x\\u0000y"}`:    `{"a":"x\\u0000y"}`,
		`{"a":"x\\\u0000y"}`:   `{"a":"x\\\ufffdy"}`,
		`{"a":"\u00001"}`:      `{"a":"\ufffd1"}`,
		`{"a":"\u0001"}`:       `{"a":"\u0001"}`,
		`{"u0000":"plain"}`:    `{"u0000":"plain"}`,
		`{"a":"end\u0000"}`:    `{"a":"end\ufffd"}`,
		`{"a":"trunc\u000"}`:   `{"a":"trunc\u000"}`,
		`{"a":"two\\\\u0000"}`: `{"a":"two\\\\u0000"}`,
	}
	for in, want := range cases {
		require.Equal(t, want, string(jsonbSafe([]byte(in))), in)
	}
	// The output stays valid JSON with the same shape.
	var v map[string]string
	require.NoError(t, json.Unmarshal(jsonbSafe([]byte(`{"a":"x\u0000y"}`)), &v))
	require.Equal(t, "x\uFFFDy", v["a"])
}

func TestSearchTextIsPromptAndReplyOnly(t *testing.T) {
	turn := json.RawMessage(`{"prompt":"找一下 notes","items":[
		{"id":"1","type":"commandExecution","command":"rm -rf secret","aggregatedOutput":"TOPSECRET"},
		{"id":"2","type":"agentMessage","text":"这是总结"},
		{"id":"3","type":"reasoning","summary":["hidden thoughts"]}]}`)
	got := searchText(turn)
	require.Contains(t, got, "找一下 notes")
	require.Contains(t, got, "这是总结")
	require.NotContains(t, got, "TOPSECRET")
	require.NotContains(t, got, "rm -rf")
	require.NotContains(t, got, "hidden")

	long := json.RawMessage(`{"prompt":"` + strings.Repeat("字", searchTextBytes) + `","items":[]}`)
	require.LessOrEqual(t, len(searchText(long)), searchTextBytes)
	require.True(t, strings.HasPrefix(searchText(long), "字"))
}

func TestSnippetCentersTheMatch(t *testing.T) {
	text := strings.Repeat("前文", 200) + "关键词在这里" + strings.Repeat("后文", 200)
	s := snippet(text, "关键词", 40)
	require.Contains(t, s, "关键词")
	require.True(t, strings.HasPrefix(s, "…"))
	require.True(t, strings.HasSuffix(s, "…"))
	require.Equal(t, "short", snippet("short", "nothing", 40))
	require.Contains(t, snippet("Hello World", "world", 40), "World")
}

func TestCursorsRoundTripAndRejectGarbage(t *testing.T) {
	c := turnCursor{B: "b", O: 3, T: "t"}
	var back turnCursor
	require.True(t, decodeCursor(encodeCursor(c), &back))
	require.Equal(t, c, back)
	require.False(t, decodeCursor("%%%", &back))
	require.False(t, decodeCursor(strings.Repeat("a", 2000), &back))
}

func TestCleanNameAndMime(t *testing.T) {
	require.Equal(t, "passwd", cleanName("../../etc/passwd"))
	require.Equal(t, "a.txt", cleanName(`C:\x\a.txt`))
	require.Equal(t, "file", cleanName(".."))
	require.Equal(t, "file", cleanName("   "))
	require.Equal(t, "ab", cleanName("a\x00\nb"))
	require.LessOrEqual(t, len(cleanName(strings.Repeat("名", 200))), maxNameBytes)
	require.Equal(t, "image/png", cleanMime("Image/PNG"))
	require.Equal(t, "text/plain", cleanMime("text/plain; charset=utf-8"))
	require.Equal(t, "application/octet-stream", cleanMime("text/html<script>"))
	require.Equal(t, "application/octet-stream", cleanMime(""))
	require.True(t, ValidFileID("abcDEF_-1"))
	require.False(t, ValidFileID("../x"))
}

func TestLimitsDefaultAndNormalize(t *testing.T) {
	c := New(&core.Env{})
	lim := c.Limits(context.Background())
	require.Equal(t, int64(1<<30), lim.QuotaBytes)
	require.Equal(t, int64(30<<20), lim.MaxFileBytes)

	q := quotaView{StorageQuotaMB: -1, MaxUploadMB: 1 << 20}
	normalizeQuota(&q)
	require.Equal(t, defaultQuota(), q)
	q = quotaView{StorageQuotaMB: 2048, MaxUploadMB: 5}
	normalizeQuota(&q)
	require.Equal(t, quotaView{StorageQuotaMB: 2048, MaxUploadMB: 5}, q)
}

func TestDefaultDirFollowsTheEnvironment(t *testing.T) {
	t.Setenv(DirEnv, "")
	t.Setenv("DATA_DIR", "/srv/data")
	require.Equal(t, filepath.Join("/srv/data", "claudex-web", "files"), defaultDir())
	t.Setenv(DirEnv, "/var/lib/claudex-web/")
	require.Equal(t, "/var/lib/claudex-web", defaultDir())
}

// The Go join of stored rows gives back the conversation the TypeScript
// split started from (shared golden doc.split.json).
func TestFullConversationJoinsTheSplitGolden(t *testing.T) {
	var split struct {
		Conversation json.RawMessage `json:"conversation"`
		Doc          struct {
			Conversation map[string]json.RawMessage `json:"conversation"`
		} `json:"doc"`
		Turns []struct {
			BranchID *string         `json:"branchId"`
			Ordinal  int             `json:"ordinal"`
			Turn     json.RawMessage `json:"turn"`
		} `json:"turns"`
	}
	require.NoError(t, json.Unmarshal(golden(t, "doc.split"), &split))
	sort.SliceStable(split.Turns, func(i, j int) bool {
		bi, bj := strOr(split.Turns[i].BranchID), strOr(split.Turns[j].BranchID)
		if bi != bj {
			return bi < bj
		}
		return split.Turns[i].Ordinal < split.Turns[j].Ordinal
	})
	full := &fullConversation{fields: split.Doc.Conversation, branches: map[string][]json.RawMessage{}}
	for _, row := range split.Turns {
		if row.BranchID == nil {
			full.live = append(full.live, row.Turn)
		} else {
			full.branches[*row.BranchID] = append(full.branches[*row.BranchID], row.Turn)
		}
	}
	got, err := full.JSON()
	require.NoError(t, err)
	require.JSONEq(t, string(split.Conversation), string(got))
	require.Equal(t, "Notes summary", full.str("title"))
}

func TestActivityLinesNeverQuoteCommands(t *testing.T) {
	require.Equal(t, []string{"Ran 2 commands", "Searched the web"},
		activityLines(map[string]int{"commandExecution": 2, "webSearch": 1}))
	require.Nil(t, activityLines(map[string]int{}))
}

func TestAsciiNameForContentDisposition(t *testing.T) {
	require.Equal(t, "a_b_.txt", asciiName("a\"b\\.txt"))
	require.Equal(t, "__.png", asciiName("图片.png"))
}
