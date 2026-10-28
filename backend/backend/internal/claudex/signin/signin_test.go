package signin

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/config"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/alicebob/miniredis/v2"
	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
)

// memSettings is an in-memory service.SettingRepository.
type memSettings struct {
	mu     sync.Mutex
	values map[string]string
}

func (r *memSettings) Get(ctx context.Context, key string) (*service.Setting, error) {
	v, err := r.GetValue(ctx, key)
	if err != nil {
		return nil, err
	}
	return &service.Setting{Key: key, Value: v}, nil
}

func (r *memSettings) GetValue(_ context.Context, key string) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	v, ok := r.values[key]
	if !ok {
		return "", service.ErrSettingNotFound
	}
	return v, nil
}

func (r *memSettings) Set(_ context.Context, key, value string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.values[key] = value
	return nil
}

func (r *memSettings) GetMultiple(context.Context, []string) (map[string]string, error) {
	return nil, errors.New("not used")
}
func (r *memSettings) SetMultiple(context.Context, map[string]string) error {
	return errors.New("not used")
}
func (r *memSettings) GetAll(context.Context) (map[string]string, error) {
	return nil, errors.New("not used")
}
func (r *memSettings) Delete(context.Context, string) error { return errors.New("not used") }

// userRepo serves users by id and by (case-insensitive) address.
type userRepo struct {
	service.UserRepository
	users map[int64]*service.User
}

func (r *userRepo) GetByID(_ context.Context, id int64) (*service.User, error) {
	if u, ok := r.users[id]; ok {
		cp := *u
		return &cp, nil
	}
	return nil, service.ErrUserNotFound
}

func (r *userRepo) GetByEmail(_ context.Context, email string) (*service.User, error) {
	for _, u := range r.users {
		if strings.EqualFold(u.Email, strings.TrimSpace(email)) {
			cp := *u
			return &cp, nil
		}
	}
	return nil, service.ErrUserNotFound
}

// fakeBackend stands in for the upstream login checks.
type fakeBackend struct {
	core.WebAuthBackend
	challenge any
	err       error
	codeUsers []int64
}

func (f *fakeBackend) CodeLogin(_ *gin.Context, u *service.User) (*service.User, any, error) {
	f.codeUsers = append(f.codeUsers, u.ID)
	if f.err != nil {
		return nil, nil, f.err
	}
	if f.challenge != nil {
		return nil, f.challenge, nil
	}
	return u, nil, nil
}

func (f *fakeBackend) RespondLogin(g *gin.Context, u *service.User) {
	response.Success(g, gin.H{"access_token": "at", "refresh_token": "rt", "expires_in": 3600, "token_type": "Bearer",
		"user": gin.H{"id": u.ID, "email": u.Email}})
}

type sentMail struct{ to, subject, body string }

type fixture struct {
	t        *testing.T
	c        *Component
	mr       *miniredis.Miniredis
	settings *memSettings
	backend  *fakeBackend
	engine   *gin.Engine
	smtp     bool
	backendM bool
	mu       sync.Mutex
	mails    []sentMail
}

func newFixture(t *testing.T, stored *Settings) *fixture {
	t.Helper()
	gin.SetMode(gin.TestMode)
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })
	f := &fixture{t: t, mr: mr, settings: &memSettings{values: map[string]string{}}, backend: &fakeBackend{}, smtp: true}
	if stored != nil {
		data, err := json.Marshal(stored)
		require.NoError(t, err)
		f.settings.values[SettingKey] = string(data)
	}
	cfg := &config.Config{}
	cfg.JWT.Secret = "signin-test-secret-0123456789abcdef"
	users := &userRepo{users: map[int64]*service.User{
		7: {ID: 7, Email: "Alice@Example.com", Role: service.RoleUser, Status: service.StatusActive},
		8: {ID: 8, Email: "off@example.com", Role: service.RoleUser, Status: service.StatusDisabled},
	}}
	env := &core.Env{Deps: core.Deps{SettingRepo: f.settings, Config: cfg, UserRepo: users}}
	f.c = New(env)
	f.c.backend = f.backend
	f.c.smtpReady = func(context.Context) bool { return f.smtp }
	f.c.backendOn = func(context.Context) bool { return f.backendM }
	f.c.async = func(fn func()) { fn() }
	f.c.sendMail = func(_ context.Context, to, subject, body string) error {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.mails = append(f.mails, sentMail{to, subject, body})
		return nil
	}
	// Routes first, then Redis: the per-IP limits stay off here
	// (TestPerIPLimits covers them); the codes use Redis.
	r := gin.New()
	f.c.RegisterPublicRoutes(r.Group("/api/v1/claudex"))
	f.c.RegisterAdminRoutes(r.Group("/api/v1/admin/claudex"), nil)
	f.engine = r
	env.Redis = rdb
	return f
}

type reply struct {
	status int
	header http.Header
	reason string
	data   json.RawMessage
	meta   map[string]string
}

func (f *fixture) do(method, path, body string) reply {
	f.t.Helper()
	req := httptest.NewRequest(method, path, bytes.NewReader([]byte(body)))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	f.engine.ServeHTTP(w, req)
	var env struct {
		Reason   string            `json:"reason"`
		Data     json.RawMessage   `json:"data"`
		Metadata map[string]string `json:"metadata"`
	}
	require.NoError(f.t, json.Unmarshal(w.Body.Bytes(), &env), "body: %s", w.Body.String())
	return reply{status: w.Code, header: w.Header(), reason: env.Reason, data: env.Data, meta: env.Metadata}
}

func (f *fixture) send(email string) reply {
	return f.do(http.MethodPost, "/api/v1/claudex/auth/email-code/send", `{"email":"`+email+`"}`)
}

func (f *fixture) login(email, code string) reply {
	return f.do(http.MethodPost, "/api/v1/claudex/auth/email-code/login", `{"email":"`+email+`","code":"`+code+`"}`)
}

// The code's block in the mail (the layout has other six-digit runs, like colours).
var codeRe = regexp.MustCompile(`>(\d{6})</p>`)

func (f *fixture) lastCode() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	require.NotEmpty(f.t, f.mails)
	match := codeRe.FindStringSubmatch(f.mails[len(f.mails)-1].body)
	require.Len(f.t, match, 2)
	return match[1]
}

func wrongCode(code string) string {
	if code == "000000" {
		return "000001"
	}
	return "000000"
}

var on = &Settings{EmailCodeLoginEnabled: true}

func TestCodeFormat(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 200; i++ {
		code, err := newCode()
		require.NoError(t, err)
		require.True(t, validCode(code), code)
		seen[code] = true
	}
	require.Greater(t, len(seen), 190, "codes are random")
	for _, bad := range []string{"", "12345", "1234567", "12345a", "١٢٣٤٥٦", " 12345"} {
		require.False(t, validCode(bad), bad)
	}
}

func TestCodeStore(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer func() { _ = rdb.Close() }()
	s := &codeStore{rdb: rdb, key: []byte("k")}
	ctx := context.Background()
	email := "a@example.com"
	id := s.id(email)

	require.NoError(t, s.save(ctx, id, s.codeHash(email, "123456"), 7))
	for _, k := range mr.Keys() {
		require.NotContains(t, k, email, "no address in keys")
		require.NotContains(t, mr.HGet(k, "h"), "123456", "only the hash is stored")
	}
	uid, err := s.verify(ctx, email, "123456")
	require.NoError(t, err)
	require.Equal(t, int64(7), uid)
	_, err = s.verify(ctx, email, "123456")
	require.ErrorIs(t, err, errUsedCode, "single use")
	_, err = s.verify(ctx, email, "654321")
	require.ErrorIs(t, err, errNoCode, "only the matching spent code is recognized")
	mr.FastForward(codeTTL + time.Second)
	_, err = s.verify(ctx, email, "123456")
	require.ErrorIs(t, err, errNoCode, "spent-code hashes expire with the code")

	// Five wrong attempts void the code.
	require.NoError(t, s.save(ctx, id, s.codeHash(email, "123456"), 7))
	for i := 0; i < maxAttempts; i++ {
		_, err = s.verify(ctx, email, "654321")
		require.ErrorIs(t, err, errNoCode)
	}
	_, err = s.verify(ctx, email, "123456")
	require.ErrorIs(t, err, errNoCode, "voided after 5 wrong attempts")

	// Four wrong attempts still leave the right one.
	require.NoError(t, s.save(ctx, id, s.codeHash(email, "123456"), 7))
	for i := 0; i < maxAttempts-1; i++ {
		_, err = s.verify(ctx, email, "654321")
		require.ErrorIs(t, err, errNoCode)
	}
	_, err = s.verify(ctx, email, "123456")
	require.NoError(t, err)

	// Expiry.
	require.NoError(t, s.save(ctx, id, s.codeHash(email, "123456"), 7))
	mr.FastForward(codeTTL + time.Second)
	_, err = s.verify(ctx, email, "123456")
	require.ErrorIs(t, err, errNoCode, "expired")

	// A new send replaces the previous code (and resets the attempts).
	require.NoError(t, s.save(ctx, id, s.codeHash(email, "111111"), 7))
	_, err = s.verify(ctx, email, "999999")
	require.ErrorIs(t, err, errNoCode)
	require.NoError(t, s.save(ctx, id, s.codeHash(email, "222222"), 7))
	_, err = s.verify(ctx, email, "111111")
	require.ErrorIs(t, err, errNoCode, "the old code is gone")
	_, err = s.verify(ctx, email, "222222")
	require.NoError(t, err)

	// The code is bound to the address.
	require.NoError(t, s.save(ctx, id, s.codeHash(email, "123456"), 7))
	_, err = s.verify(ctx, "b@example.com", "123456")
	require.ErrorIs(t, err, errNoCode)
}

func TestSpentCodeConcurrentVerification(t *testing.T) {
	redisServer := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: redisServer.Addr()})
	defer func() { _ = client.Close() }()
	store := &codeStore{rdb: client, key: []byte("k")}
	ctx := context.Background()
	email := "a@example.com"
	require.NoError(t, store.save(ctx, store.id(email), store.codeHash(email, "123456"), 7))
	results := make(chan error, 4)
	for range 4 {
		go func() {
			_, err := store.verify(ctx, email, "123456")
			results <- err
		}()
	}
	successes := 0
	for range 4 {
		err := <-results
		if err == nil {
			successes++
		} else {
			require.ErrorIs(t, err, errUsedCode)
		}
	}
	require.Equal(t, 1, successes)
}

func TestSendCooldownAndHourlyCap(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer func() { _ = rdb.Close() }()
	s := &codeStore{rdb: rdb, key: []byte("k")}
	ctx := context.Background()
	id := s.id("a@example.com")

	wait, err := s.reserveSend(ctx, id)
	require.NoError(t, err)
	require.Zero(t, wait)
	wait, err = s.reserveSend(ctx, id)
	require.NoError(t, err)
	require.Greater(t, wait, 55*time.Second, "60 s cooldown")
	require.Zero(t, mustReserve(t, s, s.id("b@example.com")), "per address")

	for i := 1; i < sendsPerHour; i++ {
		mr.FastForward(sendCooldown)
		require.Zero(t, mustReserve(t, s, id), "send %d", i+1)
	}
	mr.FastForward(sendCooldown)
	wait = mustReserve(t, s, id)
	require.Greater(t, wait, time.Duration(0), "at most 10 per hour")
	require.LessOrEqual(t, wait, time.Hour)
	mr.FastForward(time.Hour)
	require.Zero(t, mustReserve(t, s, id))
}

func mustReserve(t *testing.T, s *codeStore, id string) time.Duration {
	t.Helper()
	wait, err := s.reserveSend(context.Background(), id)
	require.NoError(t, err)
	return wait
}

func TestSettingsValidation(t *testing.T) {
	for _, good := range []string{"", "https://example.com/privacy", "/legal/privacy", "/"} {
		s := Settings{PrivacyPolicyURL: good}
		normalizeSettings(&s)
		require.NoError(t, validateSettings(&s), good)
	}
	for _, bad := range []string{"http://example.com", "//evil.example/x", "/a b", "/a\\b", "javascript:alert(1)",
		"privacy", "https://" + strings.Repeat("a", 2000) + ".com", "/" + strings.Repeat("a", 2000)} {
		s := Settings{PrivacyPolicyURL: bad}
		err := validateSettings(&s)
		require.Error(t, err, bad)
		require.Equal(t, ReasonSettingInvalid, infraerrors.Reason(err))
	}
}

func TestOptions(t *testing.T) {
	f := newFixture(t, nil)
	r := f.do(http.MethodGet, "/api/v1/claudex/sign-in/options", "")
	require.Equal(t, http.StatusOK, r.status)
	require.JSONEq(t, `{"email_code_login":false,"privacy_policy_url":null}`, string(r.data))
	require.Equal(t, "public, max-age=5", r.header.Get("Cache-Control"))

	for _, tc := range []struct {
		name          string
		smtp, backend bool
		want          bool
	}{
		{"available", true, false, true},
		{"no smtp", false, false, false},
		{"backend mode", true, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t, &Settings{EmailCodeLoginEnabled: true, PrivacyPolicyURL: "/legal/privacy"})
			f.smtp, f.backendM = tc.smtp, tc.backend
			r := f.do(http.MethodGet, "/api/v1/claudex/sign-in/options", "")
			require.Equal(t, http.StatusOK, r.status)
			var got Options
			require.NoError(t, json.Unmarshal(r.data, &got))
			require.Equal(t, tc.want, got.EmailCodeLogin)
			require.NotNil(t, got.PrivacyPolicyURL)
			require.Equal(t, "/legal/privacy", *got.PrivacyPolicyURL)
		})
	}
}

func TestSendDisabled(t *testing.T) {
	for _, tc := range []struct {
		name          string
		stored        *Settings
		smtp, backend bool
	}{
		{"setting off", nil, true, false},
		{"no smtp", on, false, false},
		{"backend mode", on, true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t, tc.stored)
			f.smtp, f.backendM = tc.smtp, tc.backend
			r := f.send("alice@example.com")
			require.Equal(t, http.StatusForbidden, r.status)
			require.Equal(t, ReasonDisabled, r.reason)
			require.Empty(t, f.mails)
		})
	}
	f := newFixture(t, nil)
	r := f.login("alice@example.com", "123456")
	require.Equal(t, http.StatusForbidden, r.status)
	require.Equal(t, ReasonDisabled, r.reason)
	require.Empty(t, f.backend.codeUsers)
}

func TestSendAnswersAlikeWithoutEnumeration(t *testing.T) {
	f := newFixture(t, on)
	var answers []string
	for _, email := range []string{"ALICE@example.com", "nobody@example.com", "off@example.com"} {
		r := f.send(email)
		require.Equal(t, http.StatusOK, r.status, email)
		require.Equal(t, "no-store", r.header.Get("Cache-Control"))
		answers = append(answers, string(r.data))
	}
	require.Equal(t, `{"countdown":60}`, answers[0])
	require.Equal(t, answers[0], answers[1])
	require.Equal(t, answers[0], answers[2])
	require.Len(t, f.mails, 1, "only the existing active account gets mail")
	m := f.mails[0]
	require.Equal(t, "Alice@Example.com", m.to)
	require.Equal(t, "Your Claudex sign-in code", m.subject)
	require.Contains(t, m.body, "It expires in 10 minutes.")

	r := f.send("alice@example.com")
	require.Equal(t, http.StatusTooManyRequests, r.status, "60 s cooldown")
	require.Equal(t, ReasonTooFrequent, r.reason)
	require.NotEmpty(t, r.header.Get("Retry-After"))
	r = f.send("nobody@example.com")
	require.Equal(t, http.StatusTooManyRequests, r.status, "the cooldown also applies without an account")

	r = f.send("not-an-address")
	require.Equal(t, http.StatusBadRequest, r.status)
	require.Equal(t, ReasonBadRequest, r.reason)
	r = f.do(http.MethodPost, "/api/v1/claudex/auth/email-code/send", `[`)
	require.Equal(t, http.StatusBadRequest, r.status)
}

func TestLogin(t *testing.T) {
	f := newFixture(t, on)
	require.Equal(t, http.StatusOK, f.send("alice@example.com").status)
	code := f.lastCode()

	r := f.login("alice@example.com", wrongCode(code))
	require.Equal(t, http.StatusBadRequest, r.status)
	require.Equal(t, ReasonInvalid, r.reason)
	require.Empty(t, f.backend.codeUsers)
	r = f.login("alice@example.com", "12ab")
	require.Equal(t, ReasonInvalid, r.reason)

	r = f.login(" Alice@Example.COM ", code)
	require.Equal(t, http.StatusOK, r.status, string(r.data))
	require.JSONEq(t, `{"access_token":"at","refresh_token":"rt","expires_in":3600,"token_type":"Bearer","user":{"id":7,"email":"Alice@Example.com"}}`, string(r.data))
	require.Equal(t, []int64{7}, f.backend.codeUsers)

	r = f.login("alice@example.com", code)
	require.Equal(t, http.StatusBadRequest, r.status, "single use")
	require.Equal(t, ReasonAlreadyUsed, r.reason)
}

func TestLoginAttemptLimit(t *testing.T) {
	f := newFixture(t, on)
	require.Equal(t, http.StatusOK, f.send("alice@example.com").status)
	code := f.lastCode()
	for i := 0; i < maxAttempts; i++ {
		require.Equal(t, ReasonInvalid, f.login("alice@example.com", wrongCode(code)).reason)
	}
	r := f.login("alice@example.com", code)
	require.Equal(t, http.StatusBadRequest, r.status, "void after 5 wrong attempts")
	require.Equal(t, ReasonInvalid, r.reason)
}

func TestLoginExpired(t *testing.T) {
	f := newFixture(t, on)
	require.Equal(t, http.StatusOK, f.send("alice@example.com").status)
	code := f.lastCode()
	f.mr.FastForward(codeTTL)
	require.Equal(t, ReasonInvalid, f.login("alice@example.com", code).reason)
}

func TestLoginChallengeAndUpstreamErrors(t *testing.T) {
	f := newFixture(t, on)
	f.backend.challenge = gin.H{"requires_2fa": true, "temp_token": "tmp", "user_email_masked": "a***@example.com"}
	require.Equal(t, http.StatusOK, f.send("alice@example.com").status)
	r := f.login("alice@example.com", f.lastCode())
	require.Equal(t, http.StatusOK, r.status)
	require.JSONEq(t, `{"requires_2fa":true,"temp_token":"tmp","user_email_masked":"a***@example.com"}`, string(r.data))

	// Backend mode after the code was sent: the upstream check answers.
	f = newFixture(t, on)
	require.Equal(t, http.StatusOK, f.send("alice@example.com").status)
	code := f.lastCode()
	f.backendM = true
	f.backend.err = infraerrors.Forbidden("BACKEND_MODE_ADMIN_ONLY", "Backend mode is active. Only admin login is allowed.")
	r = f.login("alice@example.com", code)
	require.Equal(t, http.StatusForbidden, r.status)
	require.Equal(t, "BACKEND_MODE_ADMIN_ONLY", r.reason)
}

func TestLoginWithoutBackend(t *testing.T) {
	f := newFixture(t, on)
	f.c.backend = nil
	core.SetWebAuthBackend(nil)
	require.Equal(t, http.StatusOK, f.send("alice@example.com").status)
	code := f.lastCode()
	r := f.login("alice@example.com", code)
	require.Equal(t, http.StatusServiceUnavailable, r.status)
	f.c.backend = f.backend
	require.Equal(t, http.StatusOK, f.login("alice@example.com", code).status, "the code was not spent")
}

func TestAdmin(t *testing.T) {
	f := newFixture(t, nil)
	f.smtp = false
	r := f.do(http.MethodGet, "/api/v1/admin/claudex/sign-in", "")
	require.Equal(t, http.StatusOK, r.status)
	require.JSONEq(t, `{"email_code_login_enabled":false,"privacy_policy_url":"","smtp_configured":false,"backend_mode_enabled":false,"email_code_login_available":false}`, string(r.data))

	// Warm the options cache, then check a PUT refreshes it.
	require.JSONEq(t, `{"email_code_login":false,"privacy_policy_url":null}`, string(f.do(http.MethodGet, "/api/v1/claudex/sign-in/options", "").data))
	f.smtp = true
	r = f.do(http.MethodPut, "/api/v1/admin/claudex/sign-in", `{"email_code_login_enabled":true,"privacy_policy_url":" https://example.com/privacy "}`)
	require.Equal(t, http.StatusOK, r.status)
	require.JSONEq(t, `{"email_code_login_enabled":true,"privacy_policy_url":"https://example.com/privacy","smtp_configured":true,"backend_mode_enabled":false,"email_code_login_available":true}`, string(r.data))
	require.JSONEq(t, `{"email_code_login":true,"privacy_policy_url":"https://example.com/privacy"}`, string(f.do(http.MethodGet, "/api/v1/claudex/sign-in/options", "").data))

	r = f.do(http.MethodPut, "/api/v1/admin/claudex/sign-in", `{"privacy_policy_url":""}`)
	require.Equal(t, http.StatusOK, r.status)
	var got AdminView
	require.NoError(t, json.Unmarshal(r.data, &got))
	require.True(t, got.EmailCodeLoginEnabled, "fields left out keep their values")
	require.Empty(t, got.PrivacyPolicyURL)

	for _, body := range []string{`{"privacy_policy_url":"http://x.example"}`, `{"nope":1}`, `{"email_code_login_enabled":"yes"}`, `[]`, `{}{}`} {
		r = f.do(http.MethodPut, "/api/v1/admin/claudex/sign-in", body)
		require.Equal(t, http.StatusBadRequest, r.status, body)
		require.Equal(t, ReasonSettingInvalid, r.reason, body)
	}
}

func TestPerIPLimits(t *testing.T) {
	gin.SetMode(gin.TestMode)
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer func() { _ = rdb.Close() }()
	c := New(&core.Env{Deps: core.Deps{Redis: rdb}})
	r := gin.New()
	c.RegisterPublicRoutes(r.Group("/api/v1/claudex"))
	hit := func(path string) int {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{}`)))
		return w.Code
	}
	for i := 0; i < sendPerIPPerMinute; i++ {
		require.Equal(t, http.StatusForbidden, hit("/api/v1/claudex/auth/email-code/send"), "disabled, but counted")
	}
	require.Equal(t, http.StatusTooManyRequests, hit("/api/v1/claudex/auth/email-code/send"))
	for i := 0; i < loginPerIPPerMinute; i++ {
		require.NotEqual(t, http.StatusTooManyRequests, hit("/api/v1/claudex/auth/email-code/login"))
	}
	require.Equal(t, http.StatusTooManyRequests, hit("/api/v1/claudex/auth/email-code/login"))

	// Redis down: fail closed.
	mr.FlushAll()
	require.Equal(t, http.StatusForbidden, hit("/api/v1/claudex/auth/email-code/send"))
	mr.Close()
	require.Equal(t, http.StatusTooManyRequests, hit("/api/v1/claudex/auth/email-code/send"))
}
