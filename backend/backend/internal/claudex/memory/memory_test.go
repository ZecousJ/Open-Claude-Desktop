package memory

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

const projectA = "project:6f1c2a4e-9b0d-4c1e-8a57-2f3b9d0c7e11"

func TestDefaultsAreOffAndPolicyDefaultOnApplies(t *testing.T) {
	f := newFixture(t)
	v := f.memory()
	require.True(t, v.Available)
	require.Nil(t, v.Reason)
	require.Equal(t, Switches{true, true}, v.Allowed)
	require.Equal(t, Switches{false, false}, v.Prefs, "the user's switches are off by default")
	require.False(t, v.PrefsSet)
	require.Equal(t, Switches{false, false}, v.Effective)
	require.Equal(t, serverLimits, v.Limits)
	require.Empty(t, v.Docs)
	require.Empty(t, v.Edits)

	// The administrator can make them default to on; a stored choice wins.
	f.pol.DefaultOn = true
	require.Equal(t, Switches{true, true}, f.memory().Effective)
	r := f.do(http.MethodPut, "/api/v1/claudex/memory/prefs", `{"generate":false}`)
	require.Equal(t, http.StatusOK, r.Status, r.Raw)
	var st Status
	r.into(t, &st)
	require.True(t, st.PrefsSet)
	require.Equal(t, Switches{SearchChats: true, Generate: false}, st.Prefs)
	require.Equal(t, Switches{SearchChats: true, Generate: false}, st.Effective)
}

func TestPrefsFollowThePolicy(t *testing.T) {
	f := newFixture(t)
	r := f.do(http.MethodPut, "/api/v1/claudex/memory/prefs", `{"search_chats":true,"generate":true}`)
	require.Equal(t, http.StatusOK, r.Status, r.Raw)
	require.Equal(t, Switches{true, true}, f.memory().Effective)

	// The policy stops "generate": the user cannot turn it on, can turn it
	// off, and the effective switch is off while the choice is kept.
	f.pol.Generate = false
	require.Equal(t, Switches{SearchChats: true, Generate: false}, f.memory().Effective)
	require.Equal(t, Switches{true, true}, f.memory().Prefs)
	r = f.do(http.MethodPut, "/api/v1/claudex/memory/prefs", `{"generate":true}`)
	require.Equal(t, http.StatusForbidden, r.Status)
	require.Equal(t, "CLAUDEX_MEMORY_DISABLED", r.Reason)
	require.Equal(t, "generate", r.Meta["field"])
	r = f.do(http.MethodPut, "/api/v1/claudex/memory/prefs", `{"generate":false}`)
	require.Equal(t, http.StatusOK, r.Status, r.Raw)

	// Memory off: every switch is off and memory is unavailable (policy).
	f.pol = Policy{Enabled: false, SearchChats: true, Generate: true, DefaultOn: true}
	v := f.memory()
	require.False(t, v.Available)
	require.Equal(t, ReasonPolicy, *v.Reason)
	require.Equal(t, Switches{}, v.Allowed)
	require.Equal(t, Switches{}, v.Effective)
	r = f.do(http.MethodPut, "/api/v1/claudex/memory/prefs", `{"search_chats":true}`)
	require.Equal(t, http.StatusForbidden, r.Status)
	require.Equal(t, "search_chats", r.Meta["field"])

	for _, body := range []string{`{}`, `{"x":true}`, `{"generate":"yes"}`, `[]`, `{"generate":true}{}`} {
		r = f.do(http.MethodPut, "/api/v1/claudex/memory/prefs", body)
		require.Equal(t, http.StatusBadRequest, r.Status, body)
		require.Equal(t, "CLAUDEX_MEMORY_INVALID", r.Reason, body)
	}
}

func TestDocumentLifecycleAndConflicts(t *testing.T) {
	f := newFixture(t)
	put := func(scope, body string) result {
		return f.do(http.MethodPut, "/api/v1/claudex/memory/docs/"+scope, body)
	}
	r := put("global", `{"content":"## Work context\nWrites Go.","source":"user","base_revision":0}`)
	require.Equal(t, http.StatusOK, r.Status, r.Raw)
	var d DocView
	r.into(t, &d)
	require.Equal(t, int64(1), d.Revision)
	require.Equal(t, "## Work context\nWrites Go.", *d.Content)
	require.True(t, d.Readable)
	require.Nil(t, d.GeneratedAt)
	require.Equal(t, len("## Work context\nWrites Go."), d.ContentBytes)

	// The stored text is sealed, never plain.
	stored := f.store.scopes[7]["global"].doc
	require.NotContains(t, stored.ContentEnc, "Writes Go")
	plain, err := f.c.box.Open(stored.ContentEnc)
	require.NoError(t, err)
	require.Equal(t, "## Work context\nWrites Go.", plain)

	// Creating again or writing an old revision conflicts.
	r = put("global", `{"content":"x","source":"user","base_revision":0}`)
	require.Equal(t, http.StatusConflict, r.Status)
	require.Equal(t, "CLAUDEX_MEMORY_CONFLICT", r.Reason)
	require.Equal(t, "1", r.Meta["current_revision"])
	r = put("global", `{"content":"x","source":"user","base_revision":5}`)
	require.Equal(t, http.StatusConflict, r.Status)

	// Edits, then a generated write folding in the first two.
	for i := 1; i <= 3; i++ {
		r = f.do(http.MethodPost, "/api/v1/claudex/memory/edits", fmt.Sprintf(`{"scope":"global","text":"Prefers tabs %d"}`, i))
		require.Equal(t, http.StatusCreated, r.Status, r.Raw)
	}
	r = put("global", `{"content":"Merged","source":"generated","base_revision":1,"edits_upto":2}`)
	require.Equal(t, http.StatusOK, r.Status, r.Raw)
	r.into(t, &d)
	require.Equal(t, int64(2), d.Revision)
	require.NotNil(t, d.GeneratedAt)
	v := f.memory()
	require.Len(t, v.Edits, 1)
	require.Equal(t, "Prefers tabs 3", *v.Edits[0].Text)

	// A later user edit keeps generated_at.
	r = put("global", `{"content":"Edited","source":"user","base_revision":2}`)
	require.Equal(t, http.StatusOK, r.Status, r.Raw)
	r.into(t, &d)
	require.NotNil(t, d.GeneratedAt)
	require.Equal(t, SourceUser, d.Source)

	// Project scopes are separate; the scope is canonicalised.
	r = put(strings.ToUpper(projectA[:8])+strings.ToUpper(projectA[8:]), `{"content":"Project memory","source":"import","base_revision":0}`)
	require.Equal(t, http.StatusOK, r.Status, r.Raw)
	r.into(t, &d)
	require.Equal(t, projectA, d.Scope)
	r = f.do(http.MethodGet, "/api/v1/claudex/memory?scope="+projectA, "")
	require.Equal(t, http.StatusOK, r.Status)
	r.into(t, &v)
	require.Len(t, v.Docs, 1)
	require.Empty(t, v.Edits)
	require.Len(t, f.memory().Docs, 2)

	// Delete one scope, then everything; the switches stay.
	require.Equal(t, http.StatusOK, f.do(http.MethodPut, "/api/v1/claudex/memory/prefs", `{"generate":true}`).Status)
	r = f.do(http.MethodDelete, "/api/v1/claudex/memory/docs/global", "")
	require.Equal(t, http.StatusOK, r.Status)
	var del DeleteResult
	r.into(t, &del)
	require.Equal(t, DeleteResult{DeletedDocs: 1, DeletedEdits: 1}, del)
	r = f.do(http.MethodDelete, "/api/v1/claudex/memory", "")
	require.Equal(t, http.StatusOK, r.Status)
	r.into(t, &del)
	require.Equal(t, DeleteResult{DeletedDocs: 1}, del)
	v = f.memory()
	require.Empty(t, v.Docs)
	require.True(t, v.Prefs.Generate)
}

func TestDocumentValidation(t *testing.T) {
	f := newFixture(t)
	put := func(scope, body string) result {
		return f.do(http.MethodPut, "/api/v1/claudex/memory/docs/"+scope, body)
	}
	for _, scope := range []string{"globals", "project:123", "project:", "user:1", "project:6f1c2a4e-9b0d-4c1e-8a57-2f3b9d0c7e1"} {
		r := put(scope, `{"content":"x","source":"user","base_revision":0}`)
		require.Equal(t, http.StatusBadRequest, r.Status, scope)
		require.Equal(t, "CLAUDEX_MEMORY_BAD_SCOPE", r.Reason, scope)
	}
	r := f.do(http.MethodGet, "/api/v1/claudex/memory?scope=nope", "")
	require.Equal(t, "CLAUDEX_MEMORY_BAD_SCOPE", r.Reason)

	for body, field := range map[string]string{
		`{"source":"user","base_revision":0}`:                                   "content",
		`{"content":"x","base_revision":0}`:                                     "source",
		`{"content":"x","source":"robot","base_revision":0}`:                    "source",
		`{"content":"x","source":"user"}`:                                       "base_revision",
		`{"content":"x","source":"user","base_revision":-1}`:                    "base_revision",
		`{"content":"x","source":"user","base_revision":0,"edits_upto":3}`:      "edits_upto",
		`{"content":"x","source":"generated","base_revision":0,"edits_upto":0}`: "edits_upto",
		`{"content":"x","source":"user","base_revision":0,"revision":1}`:        "body",
	} {
		r := put("global", body)
		require.Equal(t, http.StatusBadRequest, r.Status, body)
		require.Equal(t, field, r.Meta["field"], body)
	}

	// 16 KiB of text fits, one byte more does not.
	ok, _ := json.Marshal(map[string]any{"content": strings.Repeat("a", MaxDocBytes), "source": "user", "base_revision": 0})
	require.Equal(t, http.StatusOK, put("global", string(ok)).Status)
	big, _ := json.Marshal(map[string]any{"content": strings.Repeat("a", MaxDocBytes+1), "source": "user", "base_revision": 1})
	r = put("global", string(big))
	require.Equal(t, http.StatusRequestEntityTooLarge, r.Status)
	require.Equal(t, "CLAUDEX_MEMORY_TOO_LARGE", r.Reason)
	huge := `{"content":"` + strings.Repeat("a", maxBodyBytes) + `","source":"user","base_revision":1}`
	require.Equal(t, http.StatusRequestEntityTooLarge, put("global", huge).Status)
	// Multi-byte text counts bytes.
	cjk, _ := json.Marshal(map[string]any{"content": strings.Repeat("记", MaxDocBytes/3+1), "source": "user", "base_revision": 1})
	require.Equal(t, http.StatusRequestEntityTooLarge, put("global", string(cjk)).Status)
}

func TestScopeLimit(t *testing.T) {
	f := newFixture(t)
	put := func(scope string) result {
		return f.do(http.MethodPut, "/api/v1/claudex/memory/docs/"+scope, `{"content":"x","source":"user","base_revision":0}`)
	}
	require.Equal(t, http.StatusOK, put("global").Status)
	for i := 1; i < MaxScopes; i++ {
		r := put(fmt.Sprintf("project:00000000-0000-4000-8000-%012d", i))
		require.Equal(t, http.StatusOK, r.Status, r.Raw)
	}
	r := put("project:00000000-0000-4000-8000-999999999999")
	require.Equal(t, http.StatusUnprocessableEntity, r.Status)
	require.Equal(t, "CLAUDEX_MEMORY_LIMIT", r.Reason)
	require.Equal(t, "scopes", r.Meta["limit"])
	r = f.do(http.MethodPost, "/api/v1/claudex/memory/edits", `{"scope":"project:00000000-0000-4000-8000-999999999999","text":"Likes tea"}`)
	require.Equal(t, "scopes", r.Meta["limit"])
	// An existing scope still takes edits.
	r = f.do(http.MethodPost, "/api/v1/claudex/memory/edits", `{"scope":"global","text":"Likes tea"}`)
	require.Equal(t, http.StatusCreated, r.Status)
}

func TestEdits(t *testing.T) {
	devices := fakeDevices{byRaw: map[string]*core.DeviceRef{
		"6f1c2a4e-9b0d-4c1e-8a57-2f3b9d0c7e11": {ID: 31, UserID: 7},
		"6f1c2a4e-9b0d-4c1e-8a57-2f3b9d0c7e12": {ID: 32, UserID: 8},
	}}
	f := newFixture(t, fixtureOptions{env: func(e *core.Env) { e.Peers.Devices = devices }})
	post := func(body string, headers ...string) result {
		return f.do(http.MethodPost, "/api/v1/claudex/memory/edits", body, headers...)
	}
	r := post(`{"scope":"global","text":"  Works at\na bakery\t "}`, core.HeaderDeviceID, "6f1c2a4e-9b0d-4c1e-8a57-2f3b9d0c7e11")
	require.Equal(t, http.StatusCreated, r.Status, r.Raw)
	var e EditView
	r.into(t, &e)
	require.Equal(t, "Works at a bakery", *e.Text)
	require.Equal(t, int64(31), *f.store.scopes[7]["global"].edits[0].DeviceID)
	require.NotContains(t, f.store.scopes[7]["global"].edits[0].TextEnc, "bakery")

	// Another user's device is not recorded.
	r = post(`{"scope":"global","text":"Has a cat"}`, core.HeaderDeviceID, "6f1c2a4e-9b0d-4c1e-8a57-2f3b9d0c7e12")
	require.Equal(t, http.StatusCreated, r.Status)
	require.Nil(t, f.store.scopes[7]["global"].edits[1].DeviceID)

	for body, reason := range map[string]string{
		`{"scope":"global","text":"   "}`: "CLAUDEX_MEMORY_INVALID",
		`{"scope":"global"}`:              "CLAUDEX_MEMORY_INVALID",
		`{"text":"x"}`:                    "CLAUDEX_MEMORY_BAD_SCOPE",
		`{"scope":"nope","text":"x"}`:     "CLAUDEX_MEMORY_BAD_SCOPE",
		`{"scope":"global","text":"` + strings.Repeat("é", MaxEditChars+1) + `"}`:      "CLAUDEX_MEMORY_LIMIT",
		`{"scope":"global","text":"My API key is sk-proj-abcdefghijklmnop"}`:           "CLAUDEX_MEMORY_SENSITIVE",
		`{"scope":"global","text":"password: hunter22"}`:                               "CLAUDEX_MEMORY_SENSITIVE",
		`{"scope":"global","text":"Card 4111 1111 1111 1111 for travel"}`:              "CLAUDEX_MEMORY_SENSITIVE",
		`{"scope":"global","text":"Use Authorization: Bearer abcdefghijklmnopqrstuv"}`: "CLAUDEX_MEMORY_SENSITIVE",
	} {
		r = post(body)
		require.Equal(t, reason, r.Reason, body)
	}
	require.Equal(t, http.StatusCreated, post(`{"scope":"global","text":"`+strings.Repeat("é", MaxEditChars)+`"}`).Status)

	// At most 50 edits per scope.
	for i := len(f.store.scopes[7]["global"].edits); i < MaxEditsPerScope; i++ {
		require.Equal(t, http.StatusCreated, post(fmt.Sprintf(`{"scope":"global","text":"Fact %d"}`, i)).Status)
	}
	r = post(`{"scope":"global","text":"One more"}`)
	require.Equal(t, http.StatusUnprocessableEntity, r.Status)
	require.Equal(t, "edits_per_scope", r.Meta["limit"])

	// Delete: only the user's own edit; unknown ids 404.
	id := f.store.scopes[7]["global"].edits[0].ID
	f.userID = 8
	r = f.do(http.MethodDelete, fmt.Sprintf("/api/v1/claudex/memory/edits/%d", id), "")
	require.Equal(t, http.StatusNotFound, r.Status)
	require.Equal(t, "CLAUDEX_MEMORY_EDIT_NOT_FOUND", r.Reason)
	require.Empty(t, f.memory().Edits, "user 8 sees none of user 7's edits")
	f.userID = 7
	require.Equal(t, http.StatusOK, f.do(http.MethodDelete, fmt.Sprintf("/api/v1/claudex/memory/edits/%d", id), "").Status)
	require.Equal(t, http.StatusNotFound, f.do(http.MethodDelete, fmt.Sprintf("/api/v1/claudex/memory/edits/%d", id), "").Status)
	require.Equal(t, http.StatusNotFound, f.do(http.MethodDelete, "/api/v1/claudex/memory/edits/abc", "").Status)
}

func TestPolicyOffKeepsReadsAndDeletes(t *testing.T) {
	f := newFixture(t)
	require.Equal(t, http.StatusOK, f.do(http.MethodPut, "/api/v1/claudex/memory/docs/global", `{"content":"Kept","source":"user","base_revision":0}`).Status)
	require.Equal(t, http.StatusCreated, f.do(http.MethodPost, "/api/v1/claudex/memory/edits", `{"scope":"global","text":"Kept too"}`).Status)

	// Generate off: generated writes and edits stop, user edits go on.
	f.pol.Generate = false
	r := f.do(http.MethodPut, "/api/v1/claudex/memory/docs/global", `{"content":"G","source":"generated","base_revision":1}`)
	require.Equal(t, http.StatusForbidden, r.Status)
	require.Equal(t, "generate", r.Meta["field"])
	r = f.do(http.MethodPost, "/api/v1/claudex/memory/edits", `{"scope":"global","text":"x"}`)
	require.Equal(t, "generate", r.Meta["field"])
	require.Equal(t, http.StatusOK, f.do(http.MethodPut, "/api/v1/claudex/memory/docs/global", `{"content":"U","source":"user","base_revision":1}`).Status)

	// Memory off: data is kept and readable, writes refused, deletes work.
	f.pol = Policy{Enabled: false}
	v := f.memory()
	require.Len(t, v.Docs, 1)
	require.Equal(t, "U", *v.Docs[0].Content)
	require.Len(t, v.Edits, 1)
	r = f.do(http.MethodPut, "/api/v1/claudex/memory/docs/global", `{"content":"x","source":"user","base_revision":2}`)
	require.Equal(t, http.StatusForbidden, r.Status)
	require.Equal(t, "memory", r.Meta["field"])
	r = f.do(http.MethodPost, "/api/v1/claudex/memory/edits", `{"scope":"global","text":"x"}`)
	require.Equal(t, "memory", r.Meta["field"])
	require.Equal(t, http.StatusOK, f.do(http.MethodDelete, "/api/v1/claudex/memory", "").Status)
	require.Empty(t, f.memory().Docs)
}

func TestEncryptionKeyMissing(t *testing.T) {
	f := newFixture(t, fixtureOptions{keyMissing: true})
	v := f.memory()
	require.False(t, v.Available)
	require.Equal(t, ReasonServer, *v.Reason)
	require.Equal(t, Switches{true, true}, v.Allowed)

	// Switches can be stored; search runs on the device so it takes effect,
	// generate cannot.
	require.Equal(t, http.StatusOK, f.do(http.MethodPut, "/api/v1/claudex/memory/prefs", `{"search_chats":true,"generate":true}`).Status)
	require.Equal(t, Switches{SearchChats: true, Generate: false}, f.memory().Effective)

	for _, req := range [][2]string{
		{"/api/v1/claudex/memory/docs/global", `{"content":"x","source":"user","base_revision":0}`},
	} {
		r := f.do(http.MethodPut, req[0], req[1])
		require.Equal(t, http.StatusServiceUnavailable, r.Status)
		require.Equal(t, "CLAUDEX_MEMORY_ENCRYPTION_KEY_MISSING", r.Reason)
	}
	r := f.do(http.MethodPost, "/api/v1/claudex/memory/edits", `{"scope":"global","text":"x"}`)
	require.Equal(t, "CLAUDEX_MEMORY_ENCRYPTION_KEY_MISSING", r.Reason)
	require.Empty(t, f.store.scopes, "nothing is stored in plain text")

	// A value sealed under another key reads as unreadable, not as an error.
	f2 := newFixture(t)
	require.Equal(t, http.StatusOK, f2.do(http.MethodPut, "/api/v1/claudex/memory/docs/global", `{"content":"x","source":"user","base_revision":0}`).Status)
	other := keyConfig(true)
	other.Totp.EncryptionKey = strings.Repeat("ab", 32)
	f2.c.box = core.NewSecretBox(other)
	d := f2.memory().Docs[0]
	require.False(t, d.Readable)
	require.Nil(t, d.Content)
	require.Equal(t, int64(1), d.Revision)
}

func TestPolicyAndStoreFailures(t *testing.T) {
	f := newFixture(t)
	f.polErr = errors.New("boom")
	for _, req := range [][3]string{
		{http.MethodGet, "/api/v1/claudex/memory", ""},
		{http.MethodPut, "/api/v1/claudex/memory/prefs", `{"generate":false}`},
		{http.MethodPut, "/api/v1/claudex/memory/docs/global", `{"content":"x","source":"user","base_revision":0}`},
		{http.MethodPost, "/api/v1/claudex/memory/edits", `{"scope":"global","text":"x"}`},
	} {
		r := f.do(req[0], req[1], req[2])
		require.Equal(t, http.StatusServiceUnavailable, r.Status, req[1])
		require.Equal(t, "CLAUDEX_MEMORY_POLICY_UNAVAILABLE", r.Reason, req[1])
		require.NotContains(t, r.Raw, "boom")
	}
	f.polErr = nil
	f.store.failWith = errors.New("db down")
	r := f.do(http.MethodGet, "/api/v1/claudex/memory", "")
	require.Equal(t, http.StatusInternalServerError, r.Status)
	require.Equal(t, "CLAUDEX_MEMORY_STORE_FAILED", r.Reason)
	require.NotContains(t, r.Raw, "db down")
}

func TestUnauthenticated(t *testing.T) {
	f := newFixture(t)
	f.userID = 0
	require.Equal(t, http.StatusUnauthorized, f.do(http.MethodGet, "/api/v1/claudex/memory", "").Status)
	require.Equal(t, http.StatusUnauthorized, f.do(http.MethodDelete, "/api/v1/claudex/memory", "").Status)
}

func TestBootstrapSection(t *testing.T) {
	f := newFixture(t)
	require.Equal(t, []string{core.SectionMemory}, f.c.Sections())
	require.Equal(t, http.StatusOK, f.do(http.MethodPut, "/api/v1/claudex/memory/docs/"+projectA, `{"content":"x","source":"user","base_revision":0}`).Status)
	require.Equal(t, http.StatusOK, f.do(http.MethodPut, "/api/v1/claudex/memory/prefs", `{"generate":true}`).Status)

	var seenPlan *core.PlanRef
	var seenPlatform string
	f.c.policy = func(_ context.Context, _ int64, plan *core.PlanRef, platform string) (Policy, error) {
		seenPlan, seenPlatform = plan, platform
		p := defaultPolicy()
		model := "gpt-5.4-mini"
		p.Model = &model
		return p, nil
	}
	plan := &core.PlanRef{GroupID: 3}
	sections, err := f.c.BootstrapSections(context.Background(), &core.BootstrapContext{UserID: 7, Plan: plan, Platform: "darwin"})
	require.NoError(t, err)
	require.Same(t, plan, seenPlan)
	require.Equal(t, "darwin", seenPlatform)
	raw, err := json.Marshal(sections)
	require.NoError(t, err)
	var got map[string]map[string]any
	require.NoError(t, json.Unmarshal(raw, &got))
	require.Equal(t, map[string]any{
		"available": true, "reason": nil,
		"allowed": map[string]any{"search_chats": true, "generate": true},
		"prefs":   map[string]any{"search_chats": false, "generate": true}, "prefs_set": true,
		"effective":         map[string]any{"search_chats": false, "generate": true},
		"model":             "gpt-5.4-mini",
		"revision_by_scope": map[string]any{projectA: float64(1)},
	}, got[core.SectionMemory])

	// No memory text in the section.
	require.NotContains(t, string(raw), `"x"`)

	f.store.failWith = errors.New("down")
	_, err = f.c.BootstrapSections(context.Background(), &core.BootstrapContext{UserID: 7})
	require.Error(t, err)
	_, err = f.c.BootstrapSections(context.Background(), nil)
	require.Error(t, err)
}

// policyStub stands in for the B2 component: a bootstrap contributor whose
// "policy" section is a resolved policy.
type policyStub struct {
	section any
	err     error
	got     *core.BootstrapContext
}

func (p *policyStub) Name() string       { return core.NamePolicy }
func (p *policyStub) Sections() []string { return []string{core.SectionPolicy} }
func (p *policyStub) BootstrapSections(_ context.Context, bc *core.BootstrapContext) (map[string]any, error) {
	p.got = bc
	if p.err != nil {
		return nil, p.err
	}
	return map[string]any{core.SectionPolicy: p.section}, nil
}

type bareFeature struct{ name string }

func (b bareFeature) Name() string { return b.name }

func TestPolicyFromComponents(t *testing.T) {
	ctx := context.Background()
	env := &core.Env{}
	c := New(env)

	// No policy component, or the B2 stub: the built-in default.
	p, err := c.policyFromComponents(ctx, 7, nil, "")
	require.NoError(t, err)
	require.Equal(t, defaultPolicy(), p)
	env.Components = []core.Feature{bareFeature{core.NamePolicy}}
	p, err = c.policyFromComponents(ctx, 7, nil, "")
	require.NoError(t, err)
	require.Equal(t, defaultPolicy(), p)

	// The resolved policy's memory block, normalized.
	stub := &policyStub{section: map[string]any{"web_search": true, "memory": map[string]any{
		"enabled": true, "search_chats": false, "generate": true, "default_on": true, "model": "m1"}}}
	env.Components = []core.Feature{bareFeature{"other"}, stub}
	plan := &core.PlanRef{GroupID: 9}
	p, err = c.policyFromComponents(ctx, 7, plan, "win32")
	require.NoError(t, err)
	model := "m1"
	require.Equal(t, Policy{Enabled: true, SearchChats: false, Generate: true, DefaultOn: true, Model: &model}, p)
	require.Equal(t, int64(7), stub.got.UserID)
	require.Same(t, plan, stub.got.Plan)
	require.Equal(t, "win32", stub.got.Platform)

	stub.section = map[string]any{"memory": map[string]any{"enabled": false, "search_chats": true, "generate": true, "default_on": true}}
	p, err = c.policyFromComponents(ctx, 7, nil, "")
	require.NoError(t, err)
	require.Equal(t, Policy{}, p)

	// An older policy without the block keeps the default; errors surface.
	stub.section = map[string]any{"web_search": true}
	p, err = c.policyFromComponents(ctx, 7, nil, "")
	require.NoError(t, err)
	require.Equal(t, defaultPolicy(), p)
	stub.err = errors.New("plan lookup failed")
	_, err = c.policyFromComponents(ctx, 7, nil, "")
	require.Error(t, err)
	stub.err, stub.section = nil, map[string]any{"memory": "nope"}
	_, err = c.policyFromComponents(ctx, 7, nil, "")
	require.Error(t, err)
}

func TestAdminRoutesNeverReturnText(t *testing.T) {
	stepUps := 0
	f := newFixture(t, fixtureOptions{stepUp: func(c *gin.Context) {
		stepUps++
		c.Next()
	}})
	require.Equal(t, http.StatusOK, f.do(http.MethodPut, "/api/v1/claudex/memory/prefs", `{"search_chats":true}`).Status)
	require.Equal(t, http.StatusOK, f.do(http.MethodPut, "/api/v1/claudex/memory/docs/global", `{"content":"Top secret memory","source":"user","base_revision":0}`).Status)
	require.Equal(t, http.StatusCreated, f.do(http.MethodPost, "/api/v1/claudex/memory/edits", `{"scope":"`+projectA+`","text":"Private edit"}`).Status)

	r := f.do(http.MethodGet, "/api/v1/admin/claudex/memory/stats", "")
	require.Equal(t, http.StatusOK, r.Status)
	var st AdminStats
	r.into(t, &st)
	require.Equal(t, AdminStats{Stats: Stats{UsersOptedIn: 1, UsersWithMemory: 1, Documents: 1, Edits: 1,
		TotalBytes: int64(len("Top secret memory") + len("Private edit"))}, EncryptionKeyReady: true}, st)

	r = f.do(http.MethodGet, "/api/v1/admin/claudex/memory/users/7", "")
	require.Equal(t, http.StatusOK, r.Status, r.Raw)
	require.NotContains(t, r.Raw, "Top secret")
	require.NotContains(t, r.Raw, "Private edit")
	require.Equal(t, []string{"documents", "edits", "prefs", "scopes", "total_bytes", "user_id"}, keysOf(r.Data, t))
	var u AdminUserMemory
	r.into(t, &u)
	require.Equal(t, 1, u.Documents)
	require.Equal(t, 1, u.Edits)
	require.True(t, u.Prefs.Set)
	require.True(t, *u.Prefs.SearchChats)
	require.Len(t, u.Scopes, 2)
	require.Equal(t, "global", u.Scopes[0].Scope)
	require.True(t, u.Scopes[0].HasDocument)
	require.Equal(t, projectA, u.Scopes[1].Scope)
	require.False(t, u.Scopes[1].HasDocument)
	require.Equal(t, 1, u.Scopes[1].Edits)
	var scopeKeys []string
	var scopes []json.RawMessage
	var wrapper struct {
		Scopes []json.RawMessage `json:"scopes"`
	}
	r.into(t, &wrapper)
	scopes = wrapper.Scopes
	scopeKeys = keysOf(scopes[0], t)
	require.Equal(t, []string{"content_bytes", "edit_bytes", "edits", "generated_at", "has_document", "revision", "scope", "source", "updated_at"}, scopeKeys)

	// Unknown users 404; clearing needs step-up and keeps the switches.
	require.Equal(t, http.StatusNotFound, f.do(http.MethodGet, "/api/v1/admin/claudex/memory/users/99", "").Status)
	require.Equal(t, http.StatusNotFound, f.do(http.MethodGet, "/api/v1/admin/claudex/memory/users/x", "").Status)
	r = f.do(http.MethodDelete, "/api/v1/admin/claudex/memory/users/7", "")
	require.Equal(t, http.StatusOK, r.Status)
	require.Equal(t, 1, stepUps)
	var del DeleteResult
	r.into(t, &del)
	require.Equal(t, DeleteResult{DeletedDocs: 1, DeletedEdits: 1}, del)
	v := f.memory()
	require.Empty(t, v.Docs)
	require.Empty(t, v.Edits)
	require.True(t, v.Prefs.SearchChats)

	// Without a fixed key the console can warn.
	f2 := newFixture(t, fixtureOptions{keyMissing: true})
	r = f2.do(http.MethodGet, "/api/v1/admin/claudex/memory/stats", "")
	r.into(t, &st)
	require.False(t, st.EncryptionKeyReady)
}

func TestScopesAndSecrets(t *testing.T) {
	for raw, want := range map[string]string{
		"global":   "global",
		" global ": "global",
		"project:6F1C2A4E-9B0D-4C1E-8A57-2F3B9D0C7E11": projectA,
		"Project:6f1c2a4e-9b0d-4c1e-8a57-2f3b9d0c7e11": projectA,
	} {
		got, ok := normalizeScope(raw)
		require.True(t, ok, raw)
		require.Equal(t, want, got, raw)
	}
	for _, raw := range []string{"", "Global", "project", "project:x", "projects:6f1c2a4e-9b0d-4c1e-8a57-2f3b9d0c7e11", "project:6f1c2a4e9b0d4c1e8a572f3b9d0c7e11"} {
		_, ok := normalizeScope(raw)
		require.False(t, ok, raw)
	}

	for _, s := range []string{
		"token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123",
		"-----BEGIN OPENSSH PRIVATE KEY-----",
		"AKIAABCDEFGHIJKLMNOP",
		"ghp_abcdefghijklmnopqrstuvwxyz0123",
		"xoxb-1234567890-abcdef",
		"api key = 123456",
		"my passcode is 4321",
		"5500-0000-0000-0004",
	} {
		require.True(t, looksSecret(s), s)
	}
	for _, s := range []string{
		"Prefers Go over Rust",
		"Works on the password reset flow",
		"Phone support hours are 9-17",
		"Order number 1234567890123", // 13 digits that fail Luhn
		"Lives in Berlin since 2019",
	} {
		require.False(t, looksSecret(s), s)
	}
	require.Equal(t, "a b c", cleanEdit("a b\x00c"))
}
