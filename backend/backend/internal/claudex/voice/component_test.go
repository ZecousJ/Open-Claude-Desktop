package voice

import (
	"context"
	"database/sql"
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
	"github.com/Wei-Shaw/sub2api/internal/claudex/gatewayhook"
	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// memorySettingRepo is an in-memory service.SettingRepository.
type memorySettingRepo struct {
	mu     sync.Mutex
	values map[string]string
}

// testUpstreamURL is the transcription service the tests configure.
const testUpstreamURL = "wss://transcribe.example.com/v1/audio/realtime/transcriptions"

func newMemorySettingRepo() *memorySettingRepo {
	return &memorySettingRepo{values: map[string]string{}}
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

// groupRepo serves ListActive for the price warnings.
type groupRepo struct {
	service.GroupRepository
	groups []service.Group
	err    error
}

func (r *groupRepo) ListActive(context.Context) ([]service.Group, error) {
	return r.groups, r.err
}

func float(v float64) *float64 { return &v }

type envelope struct {
	Code     int               `json:"code"`
	Message  string            `json:"message"`
	Reason   string            `json:"reason"`
	Metadata map[string]string `json:"metadata"`
	Data     json.RawMessage   `json:"data"`
}

func newTestComponent(t *testing.T, deps core.Deps) (*Component, *gin.Engine) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	gatewayhook.Reset()
	t.Cleanup(func() {
		gatewayhook.Reset()
		active.Store(nil)
	})
	c := New(&core.Env{Deps: deps, Now: time.Now})
	r := gin.New()
	c.RegisterAdminRoutes(r.Group("/api/v1/admin/claudex"), func(g *gin.Context) { g.Next() })
	return c, r
}

func do(t *testing.T, r http.Handler, method, path, body string) (*httptest.ResponseRecorder, envelope) {
	t.Helper()
	var req *http.Request
	if body == "" {
		req = httptest.NewRequest(method, path, nil)
	} else {
		req = httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	var env envelope
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &env), w.Body.String())
	return w, env
}

const testEncryptionKey = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"

func fixedKeyConfig() *config.Config {
	cfg := &config.Config{}
	cfg.Totp.EncryptionKey = testEncryptionKey
	cfg.Totp.EncryptionKeyConfigured = true
	return cfg
}

func newMockDB(t *testing.T) (*sql.DB, sqlmock.Sqlmock) {
	t.Helper()
	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	return db, mock
}

type adminData struct {
	Transcription AdminTranscription `json:"transcription"`
	Billing       AdminBilling       `json:"billing"`
	Warnings      []string           `json:"warnings"`
}

func adminOf(t *testing.T, env envelope) adminData {
	t.Helper()
	var d adminData
	require.NoError(t, json.Unmarshal(env.Data, &d))
	return d
}

func TestComponentContract(t *testing.T) {
	c, _ := newTestComponent(t, core.Deps{})
	require.Equal(t, core.NameVoice, c.Name())
	require.Equal(t, []string{"claudex_voice"}, c.SettingKeys())
	require.Equal(t, []string{core.SectionVoice}, c.Sections())
	require.NoError(t, core.CheckSectionOwnership(map[string][]string{c.Name(): c.Sections()}))
}

func TestResolveUpstreamNeedsAnEnabledStoredKey(t *testing.T) {
	gatewayhook.Reset()
	active.Store(nil)
	_, err := ResolveUpstream()
	require.ErrorIs(t, err, ErrDisabled, "no component")
	require.False(t, Current().Transcription.Enabled)

	repo := newMemorySettingRepo()
	_, r := newTestComponent(t, core.Deps{SettingRepo: repo, Config: fixedKeyConfig()})
	_, err = ResolveUpstream()
	require.ErrorIs(t, err, ErrDisabled, "defaults: off, no key")

	w, _ := do(t, r, http.MethodPut, "/api/v1/admin/claudex/voice",
		`{"transcription":{"upstream_url":"wss://transcribe.example.com/v1/audio/realtime/transcriptions","enabled":true,"api_key":"sk-test-0123456789abcdef","max_session_seconds":60,"max_bytes":64000,"idle_timeout_seconds":7}}`)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	up, err := ResolveUpstream()
	require.NoError(t, err)
	require.Equal(t, testUpstreamURL, up.URL)
	require.Equal(t, "sk-test-0123456789abcdef", up.APIKey)
	require.Equal(t, Limits{MaxBytes: 64000, MaxDuration: time.Minute, IdleTimeout: 7 * time.Second}, up.Limits)

	// The stored document holds only the ciphertext.
	raw := repo.values[SettingKey]
	require.NotContains(t, raw, "sk-test-0123456789abcdef")
	require.Contains(t, raw, `"api_key_ciphertext"`)

	// A different server key cannot read it: 503, not a silent upstream 401.
	other := fixedKeyConfig()
	other.Totp.EncryptionKey = strings.Repeat("ab", 32)
	newTestComponent(t, core.Deps{SettingRepo: repo, Config: other})
	_, err = ResolveUpstream()
	require.ErrorIs(t, err, ErrUnavailable)
}

func TestAdminKeyIsWriteOnlyAndMasked(t *testing.T) {
	repo := newMemorySettingRepo()
	_, r := newTestComponent(t, core.Deps{SettingRepo: repo, Config: fixedKeyConfig()})

	w, env := do(t, r, http.MethodGet, "/api/v1/admin/claudex/voice", "")
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	d := adminOf(t, env)
	require.False(t, d.Transcription.Enabled)
	require.False(t, d.Transcription.APIKeyConfigured)
	require.Empty(t, d.Transcription.APIKeyMasked)
	require.Equal(t, DefaultUpstreamURL, d.Transcription.UpstreamURL)
	require.Equal(t, 300, d.Transcription.MaxSessionSeconds)
	require.Equal(t, int64(9600000), d.Transcription.MaxBytes)
	require.Equal(t, 30, d.Transcription.IdleTimeoutSeconds)
	require.Equal(t, AdminBilling{BilledModel: BilledModel, BytesPerSecond: 32000, AudioFormat: "pcm_s16le",
		SampleRate: 16000, Channels: 1, CanStoreAPIKey: true}, d.Billing)

	// Turning on without a key is refused.
	w, env = do(t, r, http.MethodPut, "/api/v1/admin/claudex/voice", `{"transcription":{"upstream_url":"wss://transcribe.example.com/v1/audio/realtime/transcriptions","enabled":true}}`)
	require.Equal(t, http.StatusBadRequest, w.Code)
	require.Equal(t, ReasonInvalid, env.Reason)
	require.Equal(t, "transcription.api_key", env.Metadata["field"])

	w, env = do(t, r, http.MethodPut, "/api/v1/admin/claudex/voice",
		`{"transcription":{"upstream_url":"wss://transcribe.example.com/v1/audio/realtime/transcriptions","enabled":true,"api_key":"  sk-live-abcdefghijklmnop1234  "}}`)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.NotContains(t, w.Body.String(), "sk-live-abcdefghijklmnop1234")
	require.NotContains(t, w.Body.String(), "ciphertext")
	d = adminOf(t, env)
	require.True(t, d.Transcription.Enabled)
	require.True(t, d.Transcription.APIKeyConfigured)
	require.Equal(t, "********1234", d.Transcription.APIKeyMasked)

	// Omitted fields keep their values, including the key.
	w, env = do(t, r, http.MethodPut, "/api/v1/admin/claudex/voice", `{"transcription":{"max_session_seconds":120}}`)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	d = adminOf(t, env)
	require.True(t, d.Transcription.Enabled)
	require.True(t, d.Transcription.APIKeyConfigured)
	require.Equal(t, 120, d.Transcription.MaxSessionSeconds)
	w, _ = do(t, r, http.MethodGet, "/api/v1/admin/claudex/voice", "")
	require.NotContains(t, w.Body.String(), "sk-live")

	// The stored key does not follow the URL to another host.
	w, env = do(t, r, http.MethodPut, "/api/v1/admin/claudex/voice",
		`{"transcription":{"upstream_url":"wss://attacker.example/v1/audio/realtime/transcriptions"}}`)
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
	require.Equal(t, "transcription.api_key", env.Metadata["field"])
	require.Equal(t, "required_for_new_upstream", env.Metadata["rule"])
	w, env = do(t, r, http.MethodPut, "/api/v1/admin/claudex/voice",
		`{"transcription":{"upstream_url":"wss://TRANSCRIBE.example.com/v1/asr/realtime"}}`)
	require.Equal(t, http.StatusOK, w.Code, "same host, other path: %s", w.Body.String())
	w, env = do(t, r, http.MethodPut, "/api/v1/admin/claudex/voice",
		`{"transcription":{"upstream_url":"wss://other.example/v1","api_key":"sk-other-abcdefghijkl5678"}}`)
	require.Equal(t, http.StatusOK, w.Code, "new host with a new key: %s", w.Body.String())
	require.Equal(t, "********5678", adminOf(t, env).Transcription.APIKeyMasked)
	w, _ = do(t, r, http.MethodPut, "/api/v1/admin/claudex/voice",
		`{"transcription":{"upstream_url":"`+testUpstreamURL+`","api_key":"sk-live-abcdefghijklmnop1234"}}`)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	// A short key shows no characters at all.
	w, env = do(t, r, http.MethodPut, "/api/v1/admin/claudex/voice", `{"transcription":{"api_key":"sk-short1"}}`)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Equal(t, "********", adminOf(t, env).Transcription.APIKeyMasked)

	// Clearing the key turns dictation off.
	w, env = do(t, r, http.MethodPut, "/api/v1/admin/claudex/voice", `{"transcription":{"clear_api_key":true}}`)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	d = adminOf(t, env)
	require.False(t, d.Transcription.Enabled)
	require.False(t, d.Transcription.APIKeyConfigured)
	require.NotContains(t, repo.values[SettingKey], "api_key_ciphertext")

	for _, body := range []string{
		`{"transcription":{"api_key":"has space in it"}}`,
		`{"transcription":{"api_key":"short"}}`,
		`{"transcription":{"api_key":"sk-0123456789","clear_api_key":true}}`,
		`{"transcription":{"model":"gpt-4o-transcribe"}}`,
		`{"speech":{"enabled":true}}`,
		`{"transcription":{"upstream_url":"https://transcribe.example.com/v1/audio/realtime/transcriptions"}}`,
		`{"transcription":{"max_bytes":1}}`,
		`not json`,
	} {
		w, env = do(t, r, http.MethodPut, "/api/v1/admin/claudex/voice", body)
		require.Equal(t, http.StatusBadRequest, w.Code, body)
		require.Equal(t, ReasonInvalid, env.Reason, body)
	}
}

func TestAdminRefusesKeysWithoutAFixedEncryptionKey(t *testing.T) {
	cfg := fixedKeyConfig()
	cfg.Totp.EncryptionKeyConfigured = false // auto-generated at start-up
	_, r := newTestComponent(t, core.Deps{SettingRepo: newMemorySettingRepo(), Config: cfg})
	w, env := do(t, r, http.MethodPut, "/api/v1/admin/claudex/voice", `{"transcription":{"api_key":"sk-test-0123456789abcdef"}}`)
	require.Equal(t, http.StatusBadRequest, w.Code)
	require.Equal(t, ReasonEncryptionKeyMissing, env.Reason)

	w, env = do(t, r, http.MethodGet, "/api/v1/admin/claudex/voice", "")
	require.Equal(t, http.StatusOK, w.Code)
	d := adminOf(t, env)
	require.False(t, d.Billing.CanStoreAPIKey)
	require.Contains(t, strings.Join(d.Warnings, "\n"), "TOTP_ENCRYPTION_KEY")

	_, r = newTestComponent(t, core.Deps{SettingRepo: newMemorySettingRepo()}) // no config at all
	w, env = do(t, r, http.MethodPut, "/api/v1/admin/claudex/voice", `{"transcription":{"api_key":"sk-test-0123456789abcdef"}}`)
	require.Equal(t, http.StatusBadRequest, w.Code)
	require.Equal(t, ReasonEncryptionKeyMissing, env.Reason)
}

func TestAdminWarnings(t *testing.T) {
	repo := newMemorySettingRepo()
	groups := &groupRepo{groups: []service.Group{
		{ID: 1, Name: "pro"},
		{ID: 2, Name: "free", AudioSTTPricePerHour: float(0)},
		{ID: 3, Name: "priced", AudioSTTPricePerHour: float(0.5)},
		{ID: 4},
	}}
	_, r := newTestComponent(t, core.Deps{SettingRepo: repo, Config: fixedKeyConfig(), GroupRepo: groups})
	_, env := do(t, r, http.MethodGet, "/api/v1/admin/claudex/voice", "")
	require.Equal(t, []string{
		"Group pro has no audio_stt_price_per_hour; dictation uses the built-in default price ($0.10/hour).",
		"Group free has audio_stt_price_per_hour set to 0; dictation is free in this group.",
		"Group #4 has no audio_stt_price_per_hour; dictation uses the built-in default price ($0.10/hour).",
	}, adminOf(t, env).Warnings)

	groups.err = errors.New("db down")
	_, env = do(t, r, http.MethodGet, "/api/v1/admin/claudex/voice", "")
	require.Equal(t, []string{"Group prices could not be checked; try again later."}, adminOf(t, env).Warnings)

	// A key stored under another encryption key.
	repo.values[SettingKey] = `{"transcription":{"upstream_url":"wss://transcribe.example.com/v1/audio/realtime/transcriptions","enabled":true,"api_key_ciphertext":"bm90IGEgcmVhbCBjaXBoZXJ0ZXh0IGF0IGFsbA==","api_key_hint":"abcd"}}`
	groups.err = nil
	groups.groups = nil
	_, env = do(t, r, http.MethodGet, "/api/v1/admin/claudex/voice", "")
	require.Equal(t, []string{
		"The stored upstream API key cannot be decrypted (the server encryption key changed); enter the key again.",
	}, adminOf(t, env).Warnings)
}

func TestAdminPutWithoutStorageFails(t *testing.T) {
	_, r := newTestComponent(t, core.Deps{})
	w, _ := do(t, r, http.MethodPut, "/api/v1/admin/claudex/voice", `{"transcription":{"max_session_seconds":60}}`)
	require.Equal(t, http.StatusInternalServerError, w.Code)
}

func TestBootstrapSection(t *testing.T) {
	repo := newMemorySettingRepo()
	c, r := newTestComponent(t, core.Deps{SettingRepo: repo, Config: fixedKeyConfig()})
	sections, err := c.BootstrapSections(context.Background(), &core.BootstrapContext{})
	require.NoError(t, err)
	b, _ := json.Marshal(sections[core.SectionVoice])
	require.JSONEq(t, `{"transcription":{"enabled":false,"protocol":"websocket","path":null,"audio":null,
		"max_session_seconds":0,"max_bytes":0,"idle_timeout_seconds":0},"available":{"transcription":false}}`, string(b))

	w, _ := do(t, r, http.MethodPut, "/api/v1/admin/claudex/voice",
		`{"transcription":{"upstream_url":"wss://transcribe.example.com/v1/audio/realtime/transcriptions","enabled":true,"api_key":"sk-test-0123456789abcdef","max_session_seconds":90,"max_bytes":2880000,"idle_timeout_seconds":20}}`)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	sections, err = c.BootstrapSections(context.Background(), nil)
	require.NoError(t, err)
	b, _ = json.Marshal(sections[core.SectionVoice])
	require.JSONEq(t, `{"transcription":{"enabled":true,"protocol":"websocket","path":"/v1/audio/realtime/transcriptions",
		"audio":{"format":"pcm_s16le","sample_rate":16000,"channels":1},
		"max_session_seconds":90,"max_bytes":2880000,"idle_timeout_seconds":20},"available":{"transcription":true}}`, string(b))
	require.NotContains(t, string(b), "sk-test")
	require.NotContains(t, string(b), "transcribe.example.com", "the upstream URL stays on the server")
}

func TestRecordSession(t *testing.T) {
	gatewayhook.Reset()
	active.Store(nil)
	require.Error(t, RecordSession(context.Background(), Session{RequestID: "claudex_audio:x", UserID: 1}))

	db, mock := newMockDB(t)
	newTestComponent(t, core.Deps{DB: db})
	gid := int64(4)
	mock.ExpectExec(regexp.QuoteMeta(insertSessionSQL)).
		WithArgs("claudex_audio:abc", int64(7), sql.NullInt64{Int64: 9, Valid: true}, sql.NullInt64{Int64: 4, Valid: true},
			int64(64000), float64(2), 0.0000555, true, int64(2500), "finished").
		WillReturnResult(sqlmock.NewResult(0, 1))
	require.NoError(t, RecordSession(context.Background(), Session{
		RequestID: " claudex_audio:abc ", UserID: 7, APIKeyID: 9, GroupID: &gid, AudioBytes: 64000, BilledSeconds: 2,
		CostUSD: 0.0000555, Billed: true, DurationMs: 2500, EndReason: "finished",
	}))
	mock.ExpectExec(regexp.QuoteMeta(insertSessionSQL)).
		WithArgs("claudex_audio:def", int64(7), sql.NullInt64{}, sql.NullInt64{}, int64(32000), float64(1), float64(0), false, int64(0), strings.Repeat("r", 64)).
		WillReturnResult(sqlmock.NewResult(0, 0))
	require.NoError(t, RecordSession(context.Background(), Session{RequestID: "claudex_audio:def", UserID: 7, AudioBytes: 32000,
		BilledSeconds: 1, EndReason: strings.Repeat("r", 80)}))
	require.NoError(t, mock.ExpectationsWereMet())

	require.Error(t, RecordSession(context.Background(), Session{RequestID: "", UserID: 7}))
	require.Error(t, RecordSession(context.Background(), Session{RequestID: "x", UserID: 0}))
	require.Error(t, RecordSession(context.Background(), Session{RequestID: strings.Repeat("x", 256), UserID: 7}))
}

func TestAdminSessionList(t *testing.T) {
	db, mock := newMockDB(t)
	_, r := newTestComponent(t, core.Deps{DB: db})
	created := time.Date(2026, 9, 26, 1, 2, 3, 0, time.FixedZone("CST", 8*3600))

	mock.ExpectQuery(regexp.QuoteMeta(countSessionsSQL)).WithArgs(sql.NullInt64{Int64: 7, Valid: true}).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(3))
	mock.ExpectQuery(regexp.QuoteMeta(listSessionsSQL)).WithArgs(sql.NullInt64{Int64: 7, Valid: true}, 2, 2).
		WillReturnRows(sqlmock.NewRows([]string{"request_id", "user_id", "email", "api_key_id", "group_id", "audio_bytes",
			"billed_seconds", "cost_usd", "billed", "duration_ms", "end_reason", "created_at"}).
			AddRow("claudex_audio:1", int64(7), nil, nil, int64(4), int64(48000), float64(1.5), 0.00004, true, int64(2100), "finished", created))
	w, env := do(t, r, http.MethodGet, "/api/v1/admin/claudex/voice/estimated-usage?user_id=7&page=2&page_size=2", "")
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var page struct {
		Items    []SessionItem `json:"items"`
		Total    int64         `json:"total"`
		Page     int           `json:"page"`
		PageSize int           `json:"page_size"`
	}
	require.NoError(t, json.Unmarshal(env.Data, &page))
	require.Equal(t, int64(3), page.Total)
	require.Len(t, page.Items, 1)
	it := page.Items[0]
	require.Equal(t, "claudex_audio:1", it.RequestID)
	require.Nil(t, it.UserEmail, "a deleted user has no email")
	require.Nil(t, it.APIKeyID)
	require.Equal(t, int64(4), *it.GroupID)
	require.Equal(t, 1.5, it.EstimatedSeconds)
	require.Equal(t, int64(48000), it.AudioBytes)
	require.True(t, it.Billed)
	require.Equal(t, "finished", it.EndReason)
	require.Equal(t, time.UTC, it.CreatedAt.Location())
	require.True(t, created.Equal(it.CreatedAt))

	mock.ExpectQuery(regexp.QuoteMeta(countSessionsSQL)).WithArgs(sql.NullInt64{}).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(5))
	w, env = do(t, r, http.MethodGet, "/api/v1/admin/claudex/voice/estimated-usage?page=3&page_size=500", "")
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.NoError(t, json.Unmarshal(env.Data, &page))
	require.Equal(t, 100, page.PageSize)
	require.Empty(t, page.Items)
	require.NotNil(t, page.Items)
	require.NoError(t, mock.ExpectationsWereMet())

	w, env = do(t, r, http.MethodGet, "/api/v1/admin/claudex/voice/estimated-usage?user_id=abc", "")
	require.Equal(t, http.StatusBadRequest, w.Code)
	require.Equal(t, ReasonInvalid, env.Reason)

	mock.ExpectQuery(regexp.QuoteMeta(countSessionsSQL)).WillReturnError(errors.New("boom"))
	w, _ = do(t, r, http.MethodGet, "/api/v1/admin/claudex/voice/estimated-usage", "")
	require.Equal(t, http.StatusInternalServerError, w.Code)
}
