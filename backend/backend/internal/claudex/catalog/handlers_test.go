package catalog

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

const adminUserID = 1

type harness struct {
	t        *testing.T
	c        *Component
	store    *memStore
	groups   *fakeGroups
	channels *fakeChannels
	plans    *fakePlans
	now      time.Time
	r        *gin.Engine
	stepUps  int
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	gin.SetMode(gin.TestMode)
	h := &harness{
		t:     t,
		store: newMemStore(),
		groups: &fakeGroups{groups: map[int64]*service.Group{
			4: {ID: 4, Name: "claudex-pro", Platform: service.PlatformOpenAI, Status: service.StatusActive},
			5: {ID: 5, Name: "claudex-team", Platform: service.PlatformOpenAI, Status: service.StatusActive},
			9: {ID: 9, Name: "exclusive", Platform: service.PlatformOpenAI, Status: service.StatusActive, IsExclusive: true},
		}},
		channels: &fakeChannels{byGroup: map[int64]*service.Channel{}},
		plans:    &fakePlans{allowed: map[int64][]int64{7: {4, 5}}},
		now:      time.Date(2026, 9, 26, 2, 30, 0, 0, time.UTC),
	}
	h.store.names = map[int64]string{4: "claudex-pro", 5: "claudex-team", 9: "exclusive"}
	env := &core.Env{Now: func() time.Time { return h.now }}
	env.Peers.Plans = h.plans
	h.c = newComponent(env, h.store, func() groupReader { return h.groups }, func() channelReader { return h.channels })

	r := gin.New()
	user := r.Group("/api/v1/claudex")
	user.Use(func(c *gin.Context) {
		raw := c.GetHeader("X-Test-User")
		if raw == "" {
			middleware.AbortWithError(c, http.StatusUnauthorized, "UNAUTHORIZED", "Authorization required")
			return
		}
		id, _ := strconv.ParseInt(raw, 10, 64)
		c.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: id})
		c.Next()
	})
	h.c.RegisterUserRoutes(user)
	admin := r.Group("/api/v1/admin/claudex")
	admin.Use(func(c *gin.Context) {
		c.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: adminUserID})
		c.Next()
	})
	h.c.RegisterAdminRoutes(admin, func(c *gin.Context) { h.stepUps++; c.Next() })
	h.r = r
	return h
}

type envelope struct {
	Code     any               `json:"code"` // int in envelopes, a string from middleware.AbortWithError
	Message  string            `json:"message"`
	Reason   string            `json:"reason"`
	Metadata map[string]string `json:"metadata"`
	Data     json.RawMessage   `json:"data"`
}

func (h *harness) do(method, path string, header map[string]string, body string) (*httptest.ResponseRecorder, envelope) {
	h.t.Helper()
	req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range header {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.r.ServeHTTP(rec, req)
	var env envelope
	if rec.Body.Len() > 0 {
		require.NoError(h.t, json.Unmarshal(rec.Body.Bytes(), &env), rec.Body.String())
	}
	return rec, env
}

func (h *harness) user(path string, extra ...map[string]string) (*httptest.ResponseRecorder, envelope) {
	header := map[string]string{"X-Test-User": "7"}
	for _, e := range extra {
		for k, v := range e {
			header[k] = v
		}
	}
	return h.do(http.MethodGet, path, header, "")
}

func (h *harness) create(body string) Row {
	h.t.Helper()
	rec, env := h.do(http.MethodPost, "/api/v1/admin/claudex/models", nil, body)
	require.Equal(h.t, http.StatusOK, rec.Code, rec.Body.String())
	var row Row
	require.NoError(h.t, json.Unmarshal(env.Data, &row))
	return row
}

func decodeCatalog(t *testing.T, env envelope) Catalog {
	t.Helper()
	var cat Catalog
	require.NoError(t, json.Unmarshal(env.Data, &cat))
	return cat
}

func (h *harness) seed() {
	h.create(`{"model_id":"gpt-5.5","display_name":"GPT-5.5","description":"Our smartest model for complex work",
		"badges":["new"],"sort_order":10,"is_default":true,"supported_efforts":["low","medium","high","xhigh"],
		"default_effort":"medium","context_window":400000,"auto_compact_tokens":320000,"fast_tier":true,"usage_hint":"1.5× usage"}`)
	h.create(`{"model_id":"gpt-5.5-mini","display_name":"GPT-5.5 mini","description":"Fast for everyday tasks",
		"sort_order":20,"supported_efforts":["low","medium","high"],"default_effort":"low","context_window":400000,"fast_tier":false}`)
	h.create(`{"model_id":"gpt-4.1","group_id":4,"display_name":"GPT-4.1","sort_order":30,"hidden":true,"badges":["legacy"]}`)
	h.create(`{"model_id":"secret-model","group_id":9,"display_name":"Secret","is_default":true}`)
}

func TestRoutesAreRegistered(t *testing.T) {
	h := newHarness(t)
	var got []string
	for _, r := range h.r.Routes() {
		got = append(got, r.Method+" "+r.Path)
	}
	sort.Strings(got)
	require.Equal(t, []string{
		"DELETE /api/v1/admin/claudex/models/:id",
		"DELETE /api/v1/claudex/directory/submissions/:id",
		"GET /api/v1/admin/claudex/directory/submissions",
		"GET /api/v1/admin/claudex/models",
		"GET /api/v1/admin/claudex/models/candidates",
		"GET /api/v1/admin/claudex/models/groups",
		"GET /api/v1/claudex/directory",
		"GET /api/v1/claudex/directory/submissions",
		"GET /api/v1/claudex/models",
		"POST /api/v1/admin/claudex/models",
		"POST /api/v1/claudex/directory/submissions",
		"POST /api/v1/claudex/skills/scan",
		"PUT /api/v1/admin/claudex/directory/submissions/:id/review",
		"PUT /api/v1/admin/claudex/models/:id",
		"PUT /api/v1/admin/claudex/models/groups/:id/placements",
		"PUT /api/v1/claudex/directory/submissions/:id",
	}, got)
	require.Equal(t, core.NameCatalog, h.c.Name())
	require.Equal(t, []string{core.SectionModels}, h.c.Sections())
	require.NoError(t, core.CheckSectionOwnership(map[string][]string{h.c.Name(): h.c.Sections()}))
}

func TestUserModelsMatchesTheDesignExample(t *testing.T) {
	h := newHarness(t)
	h.seed()
	rec, env := h.user("/api/v1/claudex/models?group_id=4")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.JSONEq(t, `{"group_id":4,"default_model":"gpt-5.5","items":[
		{"id":"gpt-5.5","display_name":"GPT-5.5","description":"Our smartest model for complex work","badges":["new"],
		 "sort":10,"hidden":false,"default":true,"efforts":["low","medium","high","xhigh"],"default_effort":"medium",
		 "context_window":400000,"auto_compact_tokens":320000,"usage_hint":"1.5× usage","web_search":"native","x_search":false,"group_id":4},
		{"id":"gpt-5.5-mini","display_name":"GPT-5.5 mini","description":"Fast for everyday tasks","badges":[],
		 "sort":20,"hidden":false,"default":false,"efforts":["low","medium","high"],"default_effort":"low",
		 "context_window":400000,"auto_compact_tokens":null,"usage_hint":"","web_search":"native","x_search":false,"group_id":4},
		{"id":"gpt-4.1","display_name":"GPT-4.1","description":"","badges":["legacy"],
		 "sort":30,"hidden":true,"default":false,"context_window":null,"auto_compact_tokens":null,"usage_hint":"","web_search":"native","x_search":false,"group_id":4}]}`,
		string(env.Data))
	require.Equal(t, "private, no-cache", rec.Header().Get("Cache-Control"))
	require.Contains(t, rec.Header().Get("Vary"), "Authorization")
	require.NotEmpty(t, rec.Header().Get("ETag"))
}

func TestUserModelsIgnoresAGroupTheUserCannotUse(t *testing.T) {
	h := newHarness(t)
	h.seed()
	for _, path := range []string{
		"/api/v1/claudex/models?group_id=9", // exclusive group of someone else
		"/api/v1/claudex/models?group_id=404",
		"/api/v1/claudex/models?group_id=abc",
		"/api/v1/claudex/models?group_id=-4",
		"/api/v1/claudex/models",
	} {
		rec, env := h.user(path)
		require.Equal(t, http.StatusOK, rec.Code, path)
		cat := decodeCatalog(t, env)
		require.Equal(t, int64(4), *cat.GroupID, path)
		require.Equal(t, "gpt-5.5", *cat.DefaultModel, path)
		require.NotContains(t, ids(cat), "secret-model", path)
	}
	require.Equal(t, int64(9), *h.plans.calls[0], "the requested group goes to the plan resolver")
	require.Nil(t, h.plans.calls[2], "a malformed group_id is no request")

	rec, env := h.user("/api/v1/claudex/models?group_id=5")
	require.Equal(t, http.StatusOK, rec.Code)
	cat := decodeCatalog(t, env)
	require.Equal(t, int64(5), *cat.GroupID, "a group the user may use is honored")
	require.NotContains(t, ids(cat), "gpt-4.1", "group 4 rows do not leak into group 5")
}

func TestUserModelsWithoutPlanGetsTheGlobalRows(t *testing.T) {
	h := newHarness(t)
	h.seed()
	rec, env := h.do(http.MethodGet, "/api/v1/claudex/models?group_id=9", map[string]string{"X-Test-User": "8"}, "")
	require.Equal(t, http.StatusOK, rec.Code)
	cat := decodeCatalog(t, env)
	require.Nil(t, cat.GroupID)
	require.Equal(t, []string{"gpt-5.5", "gpt-5.5-mini"}, ids(cat))
	require.Equal(t, "gpt-5.5", *cat.DefaultModel)

	h.plans.err = errors.New("database is down")
	h.c.cache.clear()
	rec, env = h.user("/api/v1/claudex/models")
	require.Equal(t, http.StatusInternalServerError, rec.Code)
	require.NotContains(t, env.Message, "database", "internal errors are not echoed")

	rec, _ = h.do(http.MethodGet, "/api/v1/claudex/models", nil, "")
	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestUserModelsNotModifiedUntilTheCatalogChanges(t *testing.T) {
	h := newHarness(t)
	h.seed()
	rec, _ := h.user("/api/v1/claudex/models")
	etag := rec.Header().Get("ETag")
	require.True(t, strings.HasPrefix(etag, `W/"`), etag)

	rec, _ = h.user("/api/v1/claudex/models", map[string]string{"If-None-Match": etag})
	require.Equal(t, http.StatusNotModified, rec.Code)
	require.Zero(t, rec.Body.Len())

	h.create(`{"model_id":"o4","sort_order":1}`)
	rec, env := h.user("/api/v1/claudex/models", map[string]string{"If-None-Match": etag})
	require.Equal(t, http.StatusOK, rec.Code, "a write clears the cache on this node at once")
	require.NotEqual(t, etag, rec.Header().Get("ETag"))
	require.Equal(t, "o4", decodeCatalog(t, env).Items[0].ID)
}

func TestCatalogCachePerGroupFor60Seconds(t *testing.T) {
	h := newHarness(t)
	h.seed()
	h.user("/api/v1/claudex/models")
	h.user("/api/v1/claudex/models")
	require.Equal(t, 1, h.store.scopes)
	h.user("/api/v1/claudex/models?group_id=5")
	require.Equal(t, 2, h.store.scopes, "each group has its own entry")

	h.now = h.now.Add(59 * time.Second)
	h.user("/api/v1/claudex/models")
	require.Equal(t, 2, h.store.scopes)
	h.now = h.now.Add(2 * time.Second)
	h.user("/api/v1/claudex/models")
	require.Equal(t, 3, h.store.scopes, "expired after 60 s")

	// A read that started before a write must not store its result after the clear.
	gen := h.c.cache.generation()
	h.c.cache.clear()
	h.c.cache.put(4, &Catalog{}, gen)
	_, ok := h.c.cache.get(4)
	require.False(t, ok)
}

func TestCatalogAppliesTheGroupEffortCeiling(t *testing.T) {
	h := newHarness(t)
	h.seed()
	h.groups.groups[4].MaxReasoningEffort = "medium"
	rec, env := h.user("/api/v1/claudex/models")
	require.Equal(t, http.StatusOK, rec.Code)
	it := item(t, decodeCatalog(t, env), "gpt-5.5")
	require.Equal(t, []string{"low", "medium"}, *it.Efforts)
	require.Equal(t, "medium", it.DefaultEffort)

	// Group 5 has no ceiling.
	_, env = h.user("/api/v1/claudex/models?group_id=5")
	require.Equal(t, []string{"low", "medium", "high", "xhigh"}, *item(t, decodeCatalog(t, env), "gpt-5.5").Efforts)
}

func TestCatalogIgnoresADeletedPlanGroup(t *testing.T) {
	h := newHarness(t)
	h.seed()
	delete(h.groups.groups, 4) // soft-deleted upstream: GetByIDLite says not found
	h.store.deleted[4] = true
	rec, env := h.user("/api/v1/claudex/models")
	require.Equal(t, http.StatusOK, rec.Code)
	cat := decodeCatalog(t, env)
	require.Nil(t, cat.GroupID)
	require.Equal(t, []string{"gpt-5.5", "gpt-5.5-mini"}, ids(cat))

	h.groups.err = errors.New("db down")
	h.c.cache.clear()
	rec, _ = h.user("/api/v1/claudex/models")
	require.Equal(t, http.StatusInternalServerError, rec.Code)
}

func TestBootstrapModelsEqualsTheUserEndpoint(t *testing.T) {
	h := newHarness(t)
	h.seed()
	// The console switches the default model.
	h.create(`{"model_id":"gpt-5.5-pro","sort_order":5,"is_default":true}`)

	_, env := h.user("/api/v1/claudex/models")
	fromAPI := decodeCatalog(t, env)
	require.Equal(t, "gpt-5.5-pro", *fromAPI.DefaultModel)

	plan, err := h.plans.ResolvePlan(context.Background(), 7, i64p(9))
	require.NoError(t, err)
	sections, err := h.c.BootstrapSections(context.Background(), &core.BootstrapContext{UserID: 7, Plan: plan})
	require.NoError(t, err)
	require.Len(t, sections, 1)
	raw, err := json.Marshal(sections[core.SectionModels])
	require.NoError(t, err)
	require.JSONEq(t, string(env.Data), string(raw))

	// No plan: the global rows, like the user endpoint.
	sections, err = h.c.BootstrapSections(context.Background(), &core.BootstrapContext{UserID: 8})
	require.NoError(t, err)
	cat, ok := sections[core.SectionModels].(*Catalog)
	require.True(t, ok)
	require.Nil(t, cat.GroupID)
	require.Equal(t, "gpt-5.5-pro", *cat.DefaultModel)

	h.store.err = errors.New("db down")
	h.c.cache.clear()
	_, err = h.c.BootstrapSections(context.Background(), &core.BootstrapContext{UserID: 7, Plan: plan})
	require.Error(t, err, "B9 drops the section and records the error")
}

func TestAdminCreate(t *testing.T) {
	h := newHarness(t)
	row := h.create(`{"model_id":" gpt-5.5 ","group_id":4,"display_name":"GPT-5.5","badges":[" new "],
		"supported_efforts":["HIGH","low"],"default_effort":"low","fast_tier":null,"unknown":1}`)
	require.Positive(t, row.ID)
	require.Equal(t, "gpt-5.5", row.ModelID)
	require.Equal(t, int64(4), *row.GroupID)
	require.Equal(t, "claudex-pro", row.GroupName)
	require.Equal(t, []string{"new"}, row.Badges)
	require.Equal(t, []string{"low", "high"}, row.SupportedEfforts)
	require.Nil(t, row.FastTier)
	require.Equal(t, int64(adminUserID), *row.CreatedBy)
	require.Equal(t, 1, h.stepUps, "catalog writes go through step-up (R13)")

	cases := []struct {
		body   string
		status int
		reason string
		field  string
	}{
		{`{"model_id":"gpt-5.5","group_id":4}`, http.StatusConflict, "CLAUDEX_MODEL_META_CONFLICT", "model_id"},
		{`{"model_id":"x","group_id":404}`, http.StatusBadRequest, "CLAUDEX_GROUP_NOT_FOUND", ""},
		{`{"model_id":"x","badges":["a","b","c","d"]}`, http.StatusBadRequest, "CLAUDEX_MODEL_META_INVALID", "badges"},
		{`{"model_id":"x","supported_efforts":["ultra"]}`, http.StatusBadRequest, "CLAUDEX_MODEL_META_INVALID", "supported_efforts"},
		{`{"model_id":""}`, http.StatusBadRequest, "CLAUDEX_MODEL_META_INVALID", "model_id"},
		{`{"model_id":"x","context_window":"big"}`, http.StatusBadRequest, "CLAUDEX_MODEL_META_INVALID", "context_window"},
		{`not json`, http.StatusBadRequest, "CLAUDEX_MODEL_META_INVALID", "body"},
		{`{"model_id":"x","description":"` + strings.Repeat("d", maxBodyBytes) + `"}`, http.StatusBadRequest, "CLAUDEX_MODEL_META_INVALID", "body"},
	}
	for _, tc := range cases {
		rec, env := h.do(http.MethodPost, "/api/v1/admin/claudex/models", nil, tc.body)
		name := tc.body
		if len(name) > 60 {
			name = name[:60]
		}
		require.Equal(t, tc.status, rec.Code, name)
		require.Equal(t, tc.reason, env.Reason, name)
		if tc.field != "" {
			require.Equal(t, tc.field, env.Metadata["field"], name)
		}
	}

	// A deleted group is not found either.
	delete(h.groups.groups, 5)
	rec, env := h.do(http.MethodPost, "/api/v1/admin/claudex/models", nil, `{"model_id":"x","group_id":5}`)
	require.Equal(t, http.StatusBadRequest, rec.Code)
	require.Equal(t, "CLAUDEX_GROUP_NOT_FOUND", env.Reason)

	// The same model may have a global row and rows in other groups.
	h.create(`{"model_id":"gpt-5.5"}`)
	h.create(`{"model_id":"gpt-5.5","group_id":9}`)
}

func TestAdminDefaultSwitchesWithinTheScope(t *testing.T) {
	h := newHarness(t)
	a := h.create(`{"model_id":"a","is_default":true}`)
	g := h.create(`{"model_id":"g","group_id":4,"is_default":true}`)
	b := h.create(`{"model_id":"b","is_default":true}`)

	get := func(id int64) Row {
		r, err := h.store.Get(context.Background(), id)
		require.NoError(t, err)
		return *r
	}
	require.False(t, get(a.ID).IsDefault, "the new global default replaces the old one")
	require.True(t, get(b.ID).IsDefault)
	require.True(t, get(g.ID).IsDefault, "other scopes keep their default")

	rec, _ := h.do(http.MethodPut, "/api/v1/admin/claudex/models/"+strconv.FormatInt(a.ID, 10), nil, `{"is_default":true}`)
	require.Equal(t, http.StatusOK, rec.Code)
	require.True(t, get(a.ID).IsDefault)
	require.False(t, get(b.ID).IsDefault)

	// A group's menus take the first of its main menu, whatever an entry
	// is marked: "g" orders after "a" and "b".
	_, env := h.user("/api/v1/claudex/models")
	require.Equal(t, "a", *decodeCatalog(t, env).DefaultModel)
	_, env = h.user("/api/v1/claudex/models?group_id=5")
	require.Equal(t, "a", *decodeCatalog(t, env).DefaultModel)
}

func TestAdminUpdate(t *testing.T) {
	h := newHarness(t)
	row := h.create(`{"model_id":"gpt-5.5","group_id":4,"display_name":"Old","badges":["new"],"hidden":true}`)
	path := "/api/v1/admin/claudex/models/" + strconv.FormatInt(row.ID, 10)

	rec, env := h.do(http.MethodPut, path, nil, `{"model_id":"gpt-5.5","group_id":4,"display_name":"New"}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var updated Row
	require.NoError(t, json.Unmarshal(env.Data, &updated))
	require.Equal(t, "New", updated.DisplayName)
	require.Empty(t, updated.Badges, "PUT replaces the whole entry")
	require.False(t, updated.Hidden)
	require.Equal(t, "gpt-5.5", updated.ModelID)
	require.Equal(t, int64(4), *updated.GroupID)

	rec, _ = h.do(http.MethodPut, path, nil, `{"display_name":"Kept scope"}`)
	require.Equal(t, http.StatusOK, rec.Code, "leaving model_id and group_id out keeps them")

	for body, field := range map[string]string{
		`{"model_id":"gpt-6"}`: "model_id",
		`{"group_id":null}`:    "group_id",
		`{"group_id":5}`:       "group_id",
	} {
		rec, env := h.do(http.MethodPut, path, nil, body)
		require.Equal(t, http.StatusBadRequest, rec.Code, body)
		require.Equal(t, "CLAUDEX_MODEL_META_INVALID", env.Reason, body)
		require.Equal(t, field, env.Metadata["field"], body)
		require.Equal(t, "immutable", env.Metadata["rule"], body)
	}

	global := h.create(`{"model_id":"x"}`)
	rec, _ = h.do(http.MethodPut, "/api/v1/admin/claudex/models/"+strconv.FormatInt(global.ID, 10), nil, `{"group_id":4}`)
	require.Equal(t, http.StatusBadRequest, rec.Code, "a global row cannot move to a group")
	rec, _ = h.do(http.MethodPut, "/api/v1/admin/claudex/models/"+strconv.FormatInt(global.ID, 10), nil, `{"group_id":null,"model_id":"x"}`)
	require.Equal(t, http.StatusOK, rec.Code)

	rec, env = h.do(http.MethodPut, path, nil, `{"default_effort":"max"}`)
	require.Equal(t, http.StatusBadRequest, rec.Code)
	require.Equal(t, "default_effort", env.Metadata["field"])

	rec, env = h.do(http.MethodPut, "/api/v1/admin/claudex/models/999", nil, `{}`)
	require.Equal(t, http.StatusNotFound, rec.Code)
	require.Equal(t, "CLAUDEX_MODEL_META_NOT_FOUND", env.Reason)
	rec, env = h.do(http.MethodPut, "/api/v1/admin/claudex/models/abc", nil, `{}`)
	require.Equal(t, http.StatusBadRequest, rec.Code)
	require.Equal(t, "id", env.Metadata["field"])

	// Rows of a deleted group can still be edited (the console labels them).
	delete(h.groups.groups, 4)
	h.store.deleted[4] = true
	rec, env = h.do(http.MethodPut, path, nil, `{"display_name":"Still editable"}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.NoError(t, json.Unmarshal(env.Data, &updated))
	require.True(t, updated.GroupDeleted)
}

func TestAdminDelete(t *testing.T) {
	h := newHarness(t)
	row := h.create(`{"model_id":"a","sort_order":1}`)
	h.user("/api/v1/claudex/models")
	path := "/api/v1/admin/claudex/models/" + strconv.FormatInt(row.ID, 10)
	rec, env := h.do(http.MethodDelete, path, nil, "")
	require.Equal(t, http.StatusOK, rec.Code)
	require.JSONEq(t, `{"deleted":true}`, string(env.Data))
	_, env = h.user("/api/v1/claudex/models")
	require.Empty(t, decodeCatalog(t, env).Items, "delete clears the cache")

	rec, env = h.do(http.MethodDelete, path, nil, "")
	require.Equal(t, http.StatusNotFound, rec.Code)
	require.Equal(t, "CLAUDEX_MODEL_META_NOT_FOUND", env.Reason)
	rec, _ = h.do(http.MethodDelete, "/api/v1/admin/claudex/models/0", nil, "")
	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestAdminList(t *testing.T) {
	h := newHarness(t)
	h.seed()
	h.store.deleted[9] = true
	type page struct {
		Items    []Row `json:"items"`
		Total    int64 `json:"total"`
		Page     int   `json:"page"`
		PageSize int   `json:"page_size"`
		Pages    int   `json:"pages"`
	}
	list := func(query string) page {
		rec, env := h.do(http.MethodGet, "/api/v1/admin/claudex/models"+query, nil, "")
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var p page
		require.NoError(t, json.Unmarshal(env.Data, &p))
		return p
	}
	all := list("")
	require.EqualValues(t, 4, all.Total)
	require.Equal(t, 50, all.PageSize)
	var secret Row
	for _, r := range all.Items {
		if r.ModelID == "secret-model" {
			secret = r
		}
	}
	require.True(t, secret.GroupDeleted, "rows of a deleted group are labelled")
	require.Equal(t, "", secret.GroupName)

	require.EqualValues(t, 2, list("?group_id=global").Total)
	require.EqualValues(t, 2, list("?group_id=0").Total)
	g4 := list("?group_id=4")
	require.EqualValues(t, 1, g4.Total)
	require.Equal(t, "gpt-4.1", g4.Items[0].ModelID)
	require.Equal(t, "claudex-pro", g4.Items[0].GroupName)
	require.EqualValues(t, 2, list("?q=MINI").Total+list("?q=4.1").Total)

	p := list("?page=2&page_size=3")
	require.Len(t, p.Items, 1)
	require.Equal(t, 2, p.Page)
	require.Equal(t, 2, p.Pages)
	require.Equal(t, 200, list("?page_size=100000").PageSize)
	require.Equal(t, maxPage, list("?page=99999999999").Page, "a huge page never overflows OFFSET")

	rec, env := h.do(http.MethodGet, "/api/v1/admin/claudex/models?group_id=x", nil, "")
	require.Equal(t, http.StatusBadRequest, rec.Code)
	require.Equal(t, "group_id", env.Metadata["field"])

	raw, err := json.Marshal(all.Items[0])
	require.NoError(t, err)
	for _, key := range []string{"id", "model_id", "group_id", "group_name", "group_deleted", "display_name", "description",
		"badges", "sort_order", "hidden", "is_default", "supported_efforts", "default_effort", "context_window",
		"auto_compact_tokens", "fast_tier", "usage_hint", "created_by", "created_at", "updated_at"} {
		require.Contains(t, string(raw), `"`+key+`":`)
	}
}

func TestAdminCandidates(t *testing.T) {
	h := newHarness(t)
	h.groups.groups[4].ModelAllowlist = service.GroupModelAllowlist{Enabled: true, Models: []string{"gpt-5.5", "gpt-5.5-mini"}}
	h.groups.groups[4].DefaultMappedModel = "gpt-5.5"
	h.groups.groups[4].ModelPricing = []service.ChannelModelPricing{{Platform: "openai", Models: []string{"o4"}}}
	h.groups.groups[5].ModelAllowlist = service.GroupModelAllowlist{Enabled: false, Models: []string{"disabled-list"}}
	h.channels.byGroup[4] = &service.Channel{
		ModelPricing: []service.ChannelModelPricing{
			{Platform: "openai", Models: []string{"gpt-5.5", "gpt-*", "GPT-Image"}},
			{Platform: "anthropic", Models: []string{"claude-opus"}},
		},
		ModelMapping: map[string]map[string]string{
			"openai":    {"codex-mini": "gpt-5.5-mini", "gpt-4*": "gpt-5.5"},
			"anthropic": {"claude-x": "claude-opus"},
		},
	}
	rec, env := h.do(http.MethodGet, "/api/v1/admin/claudex/models/candidates?group_id=4", nil, "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.JSONEq(t, `{"models":["codex-mini","gpt-5.5","gpt-5.5-mini","GPT-Image","o4"],
		"sources":{"codex-mini":["channel_mapping"],"gpt-5.5":["allowlist","default_mapped_model","channel_pricing"],
		"gpt-5.5-mini":["allowlist"],"GPT-Image":["channel_pricing"],"o4":["group_pricing"]}}`, string(env.Data))

	// Without a group: every active group (group 5's disabled allowlist does not count).
	h.groups.groups[5].DefaultMappedModel = "team-model"
	h.groups.groups[9].Status = service.StatusDisabled
	h.groups.groups[9].DefaultMappedModel = "exclusive-model"
	_, env = h.do(http.MethodGet, "/api/v1/admin/claudex/models/candidates", nil, "")
	var all Candidates
	require.NoError(t, json.Unmarshal(env.Data, &all))
	require.Contains(t, all.Models, "team-model")
	require.Contains(t, all.Models, "codex-mini")
	require.NotContains(t, all.Models, "exclusive-model")
	require.NotContains(t, all.Models, "disabled-list")

	rec, env = h.do(http.MethodGet, "/api/v1/admin/claudex/models/candidates?group_id=404", nil, "")
	require.Equal(t, http.StatusBadRequest, rec.Code)
	require.Equal(t, "CLAUDEX_GROUP_NOT_FOUND", env.Reason)
	rec, _ = h.do(http.MethodGet, "/api/v1/admin/claudex/models/candidates?group_id=x", nil, "")
	require.Equal(t, http.StatusBadRequest, rec.Code)

	h.channels.err = errors.New("channel cache down")
	rec, _ = h.do(http.MethodGet, "/api/v1/admin/claudex/models/candidates?group_id=4", nil, "")
	require.Equal(t, http.StatusInternalServerError, rec.Code)
}

func TestComponentWithEmptyDepsFailsClosed(t *testing.T) {
	gin.SetMode(gin.TestMode)
	c := New(&core.Env{}) // ProvideModule(Deps{}) must construct; requests then fail with 500
	_, err := c.catalogFor(context.Background(), 0)
	require.ErrorIs(t, err, errNoDB)
	_, err = c.catalogFor(context.Background(), 4)
	require.ErrorIs(t, err, errNoGroups)
	_, err = c.candidates(context.Background(), nil)
	require.ErrorIs(t, err, errNoGroups)
	require.NotNil(t, New(nil))
}
