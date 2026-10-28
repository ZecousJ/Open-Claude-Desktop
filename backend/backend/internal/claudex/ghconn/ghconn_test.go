package ghconn

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
	"github.com/Wei-Shaw/sub2api/internal/config"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

const testEncryptionKey = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"

const (
	testSecret     = "s3cr3t-value-0123456789"
	testAccessTok  = "gho_access_TOKEN_1"
	testRefreshTok = "ghr_refresh_TOKEN_1"
)

func fixedKeyConfig() *config.Config {
	cfg := &config.Config{}
	cfg.Totp.EncryptionKey = testEncryptionKey
	cfg.Totp.EncryptionKeyConfigured = true
	return cfg
}

type memorySettingRepo struct {
	mu     sync.Mutex
	values map[string]string
}

func (r *memorySettingRepo) Get(ctx context.Context, key string) (*service.Setting, error) {
	v, err := r.GetValue(ctx, key)
	if err != nil {
		return nil, err
	}
	return &service.Setting{Key: key, Value: v}, nil
}
func (r *memorySettingRepo) GetValue(_ context.Context, key string) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	v, ok := r.values[key]
	if !ok {
		return "", service.ErrSettingNotFound
	}
	return v, nil
}
func (r *memorySettingRepo) Set(_ context.Context, key, value string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.values[key] = value
	return nil
}
func (r *memorySettingRepo) GetMultiple(context.Context, []string) (map[string]string, error) {
	return nil, errors.New("not used")
}
func (r *memorySettingRepo) SetMultiple(context.Context, map[string]string) error {
	return errors.New("not used")
}
func (r *memorySettingRepo) GetAll(context.Context) (map[string]string, error) {
	return nil, errors.New("not used")
}
func (r *memorySettingRepo) Delete(context.Context, string) error { return errors.New("not used") }

// memStore is the in-memory store of the unit tests.
type memStore struct {
	mu     sync.Mutex
	states map[string]oauthState
	conns  map[int64]connection
}

func newMemStore() *memStore {
	return &memStore{states: map[string]oauthState{}, conns: map[int64]connection{}}
}
func (m *memStore) putState(_ context.Context, h string, s oauthState) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.states[h] = s
	return nil
}
func (m *memStore) takeState(_ context.Context, h string, now time.Time) (oauthState, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.states[h]
	delete(m.states, h)
	if !ok || !s.ExpiresAt.After(now) {
		return oauthState{}, errNoRows
	}
	return s, nil
}
func (m *memStore) upsert(_ context.Context, c connection) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.conns[c.UserID] = c
	return nil
}
func (m *memStore) get(_ context.Context, id int64) (connection, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c, ok := m.conns[id]
	if !ok {
		return connection{}, errNoRows
	}
	return c, nil
}
func (m *memStore) updateTokens(_ context.Context, id int64, tok, refresh string, exp *time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if c, ok := m.conns[id]; ok {
		c.TokenSealed, c.RefreshSealed, c.ExpiresAt = tok, refresh, exp
		m.conns[id] = c
	}
	return nil
}
func (m *memStore) remove(_ context.Context, id int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.conns, id)
	return nil
}
func (m *memStore) sweep(context.Context, time.Time) error { return nil }

// fakeGitHub serves the endpoints the component calls.
type fakeGitHub struct {
	srv        *httptest.Server
	mu         sync.Mutex
	tokenCalls []url.Values
	grantCalls int
	// tokenReply overrides the token endpoint's answer.
	tokenReply func(form url.Values) map[string]any
	// The scheduled tasks' webhooks made and removed (routine_hooks.go).
	hooksMade    []map[string]any
	hooksRemoved []string
}

func newFakeGitHub(t *testing.T) *fakeGitHub {
	f := &fakeGitHub{}
	mux := http.NewServeMux()
	mux.HandleFunc("/login/oauth/access_token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		f.mu.Lock()
		f.tokenCalls = append(f.tokenCalls, r.PostForm)
		reply := f.tokenReply
		f.mu.Unlock()
		out := map[string]any{"access_token": testAccessTok, "scope": "repo", "token_type": "bearer"}
		if reply != nil {
			out = reply(r.PostForm)
		}
		_ = json.NewEncoder(w).Encode(out)
	})
	authed := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer gho_") {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			h(w, r)
		}
	}
	mux.HandleFunc("/user", authed(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"id": 42, "login": "octo", "avatar_url": "https://avatars.example/42"})
	}))
	repos := []map[string]any{}
	for i := 1; i <= 250; i++ {
		name := "repo-" + strconv.Itoa(i)
		if i == 200 {
			name = "special-tool"
		}
		repos = append(repos, map[string]any{
			"full_name": "octo/" + name, "name": name, "private": i%2 == 0, "default_branch": "main",
			"clone_url": "https://github.com/octo/" + name + ".git", "owner": map[string]any{"login": "octo"},
			"permissions": map[string]any{"pull": true, "push": true},
		})
	}
	mux.HandleFunc("/user/repos", authed(func(w http.ResponseWriter, r *http.Request) {
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		per, _ := strconv.Atoi(r.URL.Query().Get("per_page"))
		lo, hi := (page-1)*per, page*per
		if lo > len(repos) {
			lo = len(repos)
		}
		if hi > len(repos) {
			hi = len(repos)
		}
		_ = json.NewEncoder(w).Encode(repos[lo:hi])
	}))
	mux.HandleFunc("/repos/octo/secret", authed(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNotFound) }))
	mux.HandleFunc("/repos/octo/readonly", authed(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"full_name": "octo/readonly", "name": "readonly", "default_branch": "trunk", "owner": map[string]any{"login": "octo"},
			"permissions": map[string]any{"pull": true, "push": false},
		})
	}))
	mux.HandleFunc("/repos/octo/repo-1/branches", authed(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode([]map[string]any{{"name": "main", "protected": true}, {"name": "feature/x"}, {"name": "fix-y"}})
	}))
	mux.HandleFunc("/repos/octo/repo-1/pulls/5", authed(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"number": 5, "html_url": "https://github.com/octo/repo-1/pull/5", "title": "Fix it",
			"state": "closed", "merged": true, "draft": false, "head": map[string]any{"ref": "feature/x"},
			"user": map[string]any{"login": "octo"},
		})
	}))
	mux.HandleFunc("/repos/octo/repo-1/pulls/6", authed(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"number": 6, "state": "open", "merged": false, "draft": true})
	}))
	mux.HandleFunc("/repos/octo/repo-1/pulls/8", authed(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"number": 8, "state": "open", "merged": false, "draft": false})
	}))
	mux.HandleFunc("/repos/octo/repo-1/hooks", authed(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.mu.Lock()
		f.hooksMade = append(f.hooksMade, body)
		id := 98 + len(f.hooksMade)
		f.mu.Unlock()
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{"id": id})
	}))
	mux.HandleFunc("/repos/octo/repo-1/hooks/", authed(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.hooksRemoved = append(f.hooksRemoved, r.Method+" "+r.URL.Path)
		f.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	}))
	mux.HandleFunc("/repos/octo/repo-1", authed(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"full_name": "octo/repo-1", "name": "repo-1", "default_branch": "main", "owner": map[string]any{"login": "octo"},
			"permissions": map[string]any{"pull": true, "push": true},
		})
	}))
	mux.HandleFunc("/applications/", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.grantCalls++
		f.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	})
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

type harness struct {
	c     *Component
	r     *gin.Engine
	st    *memStore
	gh    *fakeGitHub
	clock *time.Time
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	gin.SetMode(gin.TestMode)
	repo := &memorySettingRepo{values: map[string]string{}}
	c := New(&core.Env{Deps: core.Deps{SettingRepo: repo, Config: fixedKeyConfig()}, Now: time.Now})
	h := &harness{c: c, st: newMemStore(), gh: newFakeGitHub(t)}
	c.store = h.st
	c.gh = newClient(h.gh.srv.URL, h.gh.srv.URL, h.gh.srv.Client())
	now := time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)
	h.clock = &now
	c.now = func() time.Time { return *h.clock }
	r := gin.New()
	admin := r.Group("/api/v1/admin/claudex")
	c.RegisterAdminRoutes(admin, nil)
	user := r.Group("/api/v1/claudex")
	c.RegisterPublicRoutes(user)
	authed := r.Group("/api/v1/claudex")
	authed.Use(func(g *gin.Context) {
		id, _ := strconv.ParseInt(g.GetHeader("X-Test-User"), 10, 64)
		g.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: id})
		g.Next()
	})
	c.RegisterUserRoutes(authed)
	h.r = r
	return h
}

type envelope struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Reason  string          `json:"reason"`
	Data    json.RawMessage `json:"data"`
}

func (h *harness) do(t *testing.T, method, path, body string, user int64) (*httptest.ResponseRecorder, envelope) {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if user > 0 {
		req.Header.Set("X-Test-User", strconv.FormatInt(user, 10))
	}
	w := httptest.NewRecorder()
	h.r.ServeHTTP(w, req)
	var env envelope
	_ = json.Unmarshal(w.Body.Bytes(), &env)
	return w, env
}

func (h *harness) configure(t *testing.T) {
	t.Helper()
	w, env := h.do(t, http.MethodPut, "/api/v1/admin/claudex/github",
		`{"enabled":true,"client_id":"Iv1.abc","client_secret":"`+testSecret+`","public_base_url":"https://claudex.example.com"}`, 0)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Equal(t, 0, env.Code)
}

func TestAdminSettingsKeepTheSecretWriteOnly(t *testing.T) {
	h := newHarness(t)

	// Turning it on without a secret is refused.
	w, env := h.do(t, http.MethodPut, "/api/v1/admin/claudex/github", `{"enabled":true,"client_id":"Iv1.abc"}`, 0)
	require.Equal(t, http.StatusBadRequest, w.Code)
	require.Equal(t, ReasonInvalid, env.Reason)

	h.configure(t)
	w, env = h.do(t, http.MethodGet, "/api/v1/admin/claudex/github", "", 0)
	require.Equal(t, http.StatusOK, w.Code)
	require.NotContains(t, w.Body.String(), testSecret)
	var v AdminView
	require.NoError(t, json.Unmarshal(env.Data, &v))
	require.True(t, v.Enabled)
	require.True(t, v.ClientSecretSet)
	require.Equal(t, "Iv1.abc", v.ClientID)
	require.Equal(t, "https://claudex.example.com/api/v1/claudex/web/github/callback", v.CallbackURL)

	// The stored document holds a ciphertext, not the secret.
	raw, err := h.c.env.SettingRepo.GetValue(context.Background(), SettingKey)
	require.NoError(t, err)
	require.NotContains(t, raw, testSecret)
	require.Contains(t, raw, "client_secret_ciphertext")

	// Another client id needs the secret again.
	w, env = h.do(t, http.MethodPut, "/api/v1/admin/claudex/github", `{"client_id":"other"}`, 0)
	require.Equal(t, http.StatusBadRequest, w.Code)
	require.Equal(t, ReasonInvalid, env.Reason)

	// Clearing the secret turns GitHub off.
	w, env = h.do(t, http.MethodPut, "/api/v1/admin/claudex/github", `{"clear_client_secret":true}`, 0)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.NoError(t, json.Unmarshal(env.Data, &v))
	require.False(t, v.Enabled)
	require.False(t, v.ClientSecretSet)
}

func TestAdminRefusesAnInsecurePublicAddress(t *testing.T) {
	h := newHarness(t)
	w, env := h.do(t, http.MethodPut, "/api/v1/admin/claudex/github", `{"public_base_url":"http://claudex.example.com"}`, 0)
	require.Equal(t, http.StatusBadRequest, w.Code)
	require.Equal(t, ReasonInvalid, env.Reason)
}

func TestSecretNeedsAFixedEncryptionKey(t *testing.T) {
	h := newHarness(t)
	h.c.box = core.NewSecretBox(&config.Config{})
	w, env := h.do(t, http.MethodPut, "/api/v1/admin/claudex/github", `{"client_secret":"`+testSecret+`"}`, 0)
	require.Equal(t, http.StatusBadRequest, w.Code)
	require.Equal(t, ReasonEncryptionKeyMissing, env.Reason)
}

func TestNotConfiguredIsHonest(t *testing.T) {
	h := newHarness(t)
	w, env := h.do(t, http.MethodGet, "/api/v1/claudex/web/github", "", 7)
	require.Equal(t, http.StatusOK, w.Code)
	var st Status
	require.NoError(t, json.Unmarshal(env.Data, &st))
	require.False(t, st.Configured)
	require.False(t, st.Connected)

	w, env = h.do(t, http.MethodPost, "/api/v1/claudex/web/github/connect", "", 7)
	require.Equal(t, http.StatusNotFound, w.Code)
	require.Equal(t, ReasonNotConfigured, env.Reason)
	w, env = h.do(t, http.MethodGet, "/api/v1/claudex/web/github/repos", "", 7)
	require.Equal(t, http.StatusNotFound, w.Code)
	require.Equal(t, ReasonNotConfigured, env.Reason)
}

func (h *harness) connect(t *testing.T, user int64) {
	t.Helper()
	h.configure(t)
	w, env := h.do(t, http.MethodPost, "/api/v1/claudex/web/github/connect", "", user)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var out struct {
		AuthorizeURL string `json:"authorize_url"`
	}
	require.NoError(t, json.Unmarshal(env.Data, &out))
	u, err := url.Parse(out.AuthorizeURL)
	require.NoError(t, err)
	require.Equal(t, "/login/oauth/authorize", u.Path)
	q := u.Query()
	require.Equal(t, "Iv1.abc", q.Get("client_id"))
	require.Equal(t, "https://claudex.example.com/api/v1/claudex/web/github/callback", q.Get("redirect_uri"))
	require.Equal(t, "S256", q.Get("code_challenge_method"))
	require.NotEmpty(t, q.Get("code_challenge"))
	require.Equal(t, "repo", q.Get("scope"))
	state := q.Get("state")
	require.NotEmpty(t, state)
	// Only the hash of the state is stored.
	require.NotContains(t, h.st.states, state)

	w, _ = h.do(t, http.MethodGet, "/api/v1/claudex/web/github/callback?code=abc&state="+url.QueryEscape(state), "", 0)
	require.Equal(t, http.StatusFound, w.Code)
	require.Equal(t, "https://claudex.example.com/code?github=connected", w.Header().Get("Location"))
	require.Equal(t, "no-store", w.Header().Get("Cache-Control"))

	// The PKCE verifier reached the token endpoint, with the client secret.
	require.Len(t, h.gh.tokenCalls, 1)
	form := h.gh.tokenCalls[0]
	require.Equal(t, "abc", form.Get("code"))
	require.Equal(t, testSecret, form.Get("client_secret"))
	require.NotEmpty(t, form.Get("code_verifier"))

	// The state is single use.
	w, _ = h.do(t, http.MethodGet, "/api/v1/claudex/web/github/callback?code=abc&state="+url.QueryEscape(state), "", 0)
	require.Equal(t, "https://claudex.example.com/code?github=failed", w.Header().Get("Location"))
}

func TestConnectStoresTheTokenSealed(t *testing.T) {
	h := newHarness(t)
	h.connect(t, 7)
	conn := h.st.conns[7]
	require.Equal(t, "octo", conn.Login)
	require.NotEmpty(t, conn.TokenSealed)
	require.NotContains(t, conn.TokenSealed, testAccessTok)
	plain, err := h.c.box.Open(conn.TokenSealed)
	require.NoError(t, err)
	require.Equal(t, testAccessTok, plain)

	_, env := h.do(t, http.MethodGet, "/api/v1/claudex/web/github", "", 7)
	var st Status
	require.NoError(t, json.Unmarshal(env.Data, &st))
	require.True(t, st.Configured)
	require.True(t, st.Connected)
	require.Equal(t, "octo", st.Login)

	// Another user is not connected.
	_, env = h.do(t, http.MethodGet, "/api/v1/claudex/web/github", "", 8)
	require.NoError(t, json.Unmarshal(env.Data, &st))
	require.False(t, st.Connected)
}

func TestCallbackDeniedOrUnknownState(t *testing.T) {
	h := newHarness(t)
	h.configure(t)
	w, _ := h.do(t, http.MethodGet, "/api/v1/claudex/web/github/callback?error=access_denied&state=nope", "", 0)
	require.Equal(t, "https://claudex.example.com/code?github=failed", w.Header().Get("Location"))
	require.Empty(t, h.gh.tokenCalls)

	// A denial with a valid state.
	_, env := h.do(t, http.MethodPost, "/api/v1/claudex/web/github/connect", "", 7)
	var out struct {
		AuthorizeURL string `json:"authorize_url"`
	}
	require.NoError(t, json.Unmarshal(env.Data, &out))
	u, _ := url.Parse(out.AuthorizeURL)
	w, _ = h.do(t, http.MethodGet, "/api/v1/claudex/web/github/callback?error=access_denied&state="+url.QueryEscape(u.Query().Get("state")), "", 0)
	require.Equal(t, "https://claudex.example.com/code?github=denied", w.Header().Get("Location"))
	require.Empty(t, h.gh.tokenCalls)
	require.Empty(t, h.st.conns)
}

func TestExpiredStateIsRefused(t *testing.T) {
	h := newHarness(t)
	h.configure(t)
	_, env := h.do(t, http.MethodPost, "/api/v1/claudex/web/github/connect", "", 7)
	var out struct {
		AuthorizeURL string `json:"authorize_url"`
	}
	require.NoError(t, json.Unmarshal(env.Data, &out))
	u, _ := url.Parse(out.AuthorizeURL)
	*h.clock = h.clock.Add(stateTTL + time.Second)
	w, _ := h.do(t, http.MethodGet, "/api/v1/claudex/web/github/callback?code=abc&state="+url.QueryEscape(u.Query().Get("state")), "", 0)
	require.Equal(t, "https://claudex.example.com/code?github=failed", w.Header().Get("Location"))
	require.Empty(t, h.st.conns)
}

func TestRepositoriesPagedAndSearched(t *testing.T) {
	h := newHarness(t)
	h.connect(t, 7)

	_, env := h.do(t, http.MethodGet, "/api/v1/claudex/web/github/repos?per_page=30", "", 7)
	var page ReposPage
	require.NoError(t, json.Unmarshal(env.Data, &page))
	require.Len(t, page.Items, 30)
	require.NotNil(t, page.NextPage)
	require.Equal(t, 2, *page.NextPage)
	require.Equal(t, "octo/repo-1", page.Items[0].FullName)

	_, env = h.do(t, http.MethodGet, "/api/v1/claudex/web/github/repos?per_page=100&page=3", "", 7)
	require.NoError(t, json.Unmarshal(env.Data, &page))
	require.Len(t, page.Items, 50)
	require.Nil(t, page.NextPage)

	// A search scans past the first page.
	_, env = h.do(t, http.MethodGet, "/api/v1/claudex/web/github/repos?query=SPECIAL", "", 7)
	require.NoError(t, json.Unmarshal(env.Data, &page))
	require.Len(t, page.Items, 1)
	require.Equal(t, "octo/special-tool", page.Items[0].FullName)
	require.Nil(t, page.NextPage)
}

func TestBranches(t *testing.T) {
	h := newHarness(t)
	h.connect(t, 7)
	w, env := h.do(t, http.MethodGet, "/api/v1/claudex/web/github/branches?repo=octo/repo-1", "", 7)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var page BranchesPage
	require.NoError(t, json.Unmarshal(env.Data, &page))
	require.Equal(t, "main", page.DefaultBranch)
	require.Len(t, page.Items, 3)
	require.True(t, page.Items[0].Protected)

	_, env = h.do(t, http.MethodGet, "/api/v1/claudex/web/github/branches?repo=octo/repo-1&query=fix", "", 7)
	require.NoError(t, json.Unmarshal(env.Data, &page))
	require.Len(t, page.Items, 1)
	require.Equal(t, "fix-y", page.Items[0].Name)

	for _, bad := range []string{"", "octo", "octo/repo/extra", "-x/y", "octo/..", "octo/a b"} {
		w, env = h.do(t, http.MethodGet, "/api/v1/claudex/web/github/branches?repo="+url.QueryEscape(bad), "", 7)
		require.Equal(t, http.StatusBadRequest, w.Code, bad)
		require.Equal(t, ReasonBadRepo, env.Reason)
	}
	// A repository the token cannot see is a 404 without saying why.
	w, env = h.do(t, http.MethodGet, "/api/v1/claudex/web/github/branches?repo=octo/secret", "", 7)
	require.Equal(t, http.StatusNotFound, w.Code)
	require.Equal(t, ReasonNoAccess, env.Reason)
}

func TestNotConnectedUserCannotList(t *testing.T) {
	h := newHarness(t)
	h.connect(t, 7)
	w, env := h.do(t, http.MethodGet, "/api/v1/claudex/web/github/repos", "", 8)
	require.Equal(t, http.StatusConflict, w.Code)
	require.Equal(t, ReasonNotConnected, env.Reason)
}

func TestDisconnect(t *testing.T) {
	h := newHarness(t)
	h.connect(t, 7)
	w, _ := h.do(t, http.MethodDelete, "/api/v1/claudex/web/github", "", 7)
	require.Equal(t, http.StatusOK, w.Code)
	require.Empty(t, h.st.conns)
	require.Equal(t, 1, h.gh.grantCalls, "the grant is revoked on GitHub too")
	w, env := h.do(t, http.MethodGet, "/api/v1/claudex/web/github/repos", "", 7)
	require.Equal(t, http.StatusConflict, w.Code)
	require.Equal(t, ReasonNotConnected, env.Reason)
}

func TestRevokedTokenDropsTheConnection(t *testing.T) {
	h := newHarness(t)
	h.connect(t, 7)
	// GitHub now refuses the token.
	sealed, err := h.c.box.Seal("bad-token")
	require.NoError(t, err)
	conn := h.st.conns[7]
	conn.TokenSealed = sealed
	h.st.conns[7] = conn
	w, env := h.do(t, http.MethodGet, "/api/v1/claudex/web/github/repos", "", 7)
	require.Equal(t, http.StatusConflict, w.Code)
	require.Equal(t, ReasonNotConnected, env.Reason)
	require.Empty(t, h.st.conns)
}

func TestExpiredTokenIsRefreshed(t *testing.T) {
	h := newHarness(t)
	h.connect(t, 7)
	sealedOld, _ := h.c.box.Seal("gho_old")
	sealedRefresh, _ := h.c.box.Seal(testRefreshTok)
	past := h.clock.Add(-time.Minute)
	conn := h.st.conns[7]
	conn.TokenSealed, conn.RefreshSealed, conn.ExpiresAt = sealedOld, sealedRefresh, &past
	h.st.conns[7] = conn
	h.gh.tokenReply = func(url.Values) map[string]any {
		return map[string]any{"access_token": "gho_new", "refresh_token": "ghr_new", "expires_in": 28800}
	}
	w, _ := h.do(t, http.MethodGet, "/api/v1/claudex/web/github/repos", "", 7)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	last := h.gh.tokenCalls[len(h.gh.tokenCalls)-1]
	require.Equal(t, "refresh_token", last.Get("grant_type"))
	require.Equal(t, testRefreshTok, last.Get("refresh_token"))
	stored := h.st.conns[7]
	plain, err := h.c.box.Open(stored.TokenSealed)
	require.NoError(t, err)
	require.Equal(t, "gho_new", plain)
	require.NotNil(t, stored.ExpiresAt)

	// An expired token without a refresh token ends the connection.
	stored.RefreshSealed = ""
	past2 := h.clock.Add(-time.Second)
	stored.ExpiresAt = &past2
	h.st.conns[7] = stored
	w, env := h.do(t, http.MethodGet, "/api/v1/claudex/web/github/repos", "", 7)
	require.Equal(t, http.StatusConflict, w.Code)
	require.Equal(t, ReasonNotConnected, env.Reason)
	require.Empty(t, h.st.conns)
}

func cloneBody(t *testing.T, url, ref string) json.RawMessage {
	b, err := json.Marshal(cloneRequest{URL: url, Ref: ref})
	require.NoError(t, err)
	return b
}

func TestCloneCredential(t *testing.T) {
	h := newHarness(t)
	h.connect(t, 7)
	base := h.gh.srv.URL
	ctx := context.Background()

	v, err := h.c.ServeGitHubOp(ctx, 7, webproto.OpGitHubClone, cloneBody(t, base+"/octo/repo-1.git", "feature/x"))
	require.NoError(t, err)
	grant, _ := v.(CloneGrant)
	require.Equal(t, base+"/octo/repo-1.git", grant.URL)
	require.NotContains(t, grant.URL, testAccessTok)
	require.Equal(t, "x-access-token", grant.Username)
	require.Equal(t, testAccessTok, grant.Token)
	require.Equal(t, "main", grant.DefaultBranch)
	require.Equal(t, "feature/x", grant.Ref)
	require.True(t, grant.CanPush)
	exp, err := time.Parse(time.RFC3339, grant.ExpiresAt)
	require.NoError(t, err)
	require.Equal(t, h.clock.Add(CloneLease), exp)

	// The address form does not matter.
	_, err = h.c.ServeGitHubOp(ctx, 7, webproto.OpGitHubClone, cloneBody(t, base+"/octo/repo-1", ""))
	require.NoError(t, err)

	// Not another host, not ssh, not extra paths, not option-like refs.
	for _, bad := range []string{
		"https://evil.example.com/octo/repo-1.git", "git@github.com:octo/repo-1.git", base + "/octo/repo-1/tree/main",
		base + "/octo", base + "/-x/y", "ftp://x/y/z", base + "/octo/repo-1?x=1", "",
	} {
		_, err = h.c.ServeGitHubOp(ctx, 7, webproto.OpGitHubClone, cloneBody(t, bad, ""))
		require.Error(t, err, bad)
		require.Equal(t, ReasonBadRepo, reasonOf(err), bad)
	}
	for _, ref := range []string{"--upload-pack=x", "a..b", "a b", "x.lock", "a~1"} {
		_, err = h.c.ServeGitHubOp(ctx, 7, webproto.OpGitHubClone, cloneBody(t, base+"/octo/repo-1", ref))
		require.Equal(t, ReasonBadRepo, reasonOf(err), ref)
	}

	// A repository the user cannot read.
	_, err = h.c.ServeGitHubOp(ctx, 7, webproto.OpGitHubClone, cloneBody(t, base+"/octo/secret", ""))
	require.Equal(t, ReasonNoAccess, reasonOf(err))

	// Nobody else's token is used.
	_, err = h.c.ServeGitHubOp(ctx, 8, webproto.OpGitHubClone, cloneBody(t, base+"/octo/repo-1", ""))
	require.Equal(t, ReasonNotConnected, reasonOf(err))

	_, err = h.c.ServeGitHubOp(ctx, 7, "github.other", cloneBody(t, base+"/octo/repo-1", ""))
	require.Error(t, err)
}

func TestCloneReadOnlyRepository(t *testing.T) {
	h := newHarness(t)
	h.connect(t, 7)
	v, err := h.c.ServeGitHubOp(context.Background(), 7, webproto.OpGitHubClone, cloneBody(t, h.gh.srv.URL+"/octo/readonly", ""))
	require.NoError(t, err)
	grant, _ := v.(CloneGrant)
	require.False(t, grant.CanPush)
	require.Equal(t, "trunk", grant.DefaultBranch)
}

func TestCloneWhenTurnedOff(t *testing.T) {
	h := newHarness(t)
	_, err := h.c.ServeGitHubOp(context.Background(), 7, webproto.OpGitHubClone, cloneBody(t, h.gh.srv.URL+"/octo/repo-1", ""))
	require.Equal(t, ReasonNotConfigured, reasonOf(err))
}

func TestParseRepoURL(t *testing.T) {
	ref, err := parseRepoURL("https://github.com/Octo-Cat/my.repo_1.git", "https://github.com")
	require.NoError(t, err)
	require.Equal(t, "Octo-Cat/my.repo_1", ref.FullName())
	for _, bad := range []string{"http://github.com/a/b", "https://user@github.com/a/b", "https://github.com/a/b#x", "https://github.com/a/../b", "https://github.com/a/b/c"} {
		_, err := parseRepoURL(bad, "https://github.com")
		require.Error(t, err, bad)
	}
}

func TestRunnerOpIsUserScoped(t *testing.T) {
	require.True(t, webproto.IsUserOp(webproto.OpGitHubClone))
}

func reasonOf(err error) string { return infraerrors.Reason(err) }
