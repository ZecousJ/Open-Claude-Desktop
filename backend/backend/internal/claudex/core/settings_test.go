package core

import (
	"context"
	"errors"
	"regexp"
	"sync"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/stretchr/testify/require"
)

// memorySettingRepo is an in-memory service.SettingRepository.
type memorySettingRepo struct {
	mu     sync.Mutex
	values map[string]string
	reads  int
	getErr error
}

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
	r.reads++
	if r.getErr != nil {
		return "", r.getErr
	}
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

func (r *memorySettingRepo) readCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.reads
}

type testSettings struct {
	Enabled bool     `json:"enabled"`
	Limit   int      `json:"limit"`
	Models  []string `json:"models"`
}

func defaultTestSettings() testSettings {
	return testSettings{Enabled: true, Limit: 10, Models: []string{"gpt-5.5"}}
}

func newTestSetting(repo service.SettingRepository) *JSONSetting[testSettings] {
	return NewJSONSetting(repo, "claudex_test_feature", defaultTestSettings,
		WithNormalize(func(s *testSettings) {
			if s.Limit < 0 {
				s.Limit = 0
			}
		}),
		WithValidate(func(s *testSettings) error {
			if s.Limit > 100 {
				return errors.New("limit must be at most 100")
			}
			return nil
		}),
	)
}

func TestJSONSettingGetDefaultsAndMerge(t *testing.T) {
	repo := newMemorySettingRepo()
	s := newTestSetting(repo)
	ctx := context.Background()

	got, err := s.Get(ctx)
	require.NoError(t, err)
	require.Equal(t, defaultTestSettings(), got, "missing key yields defaults")

	repo.values["claudex_test_feature"] = "  "
	got, err = s.Get(ctx)
	require.NoError(t, err)
	require.Equal(t, defaultTestSettings(), got, "empty value yields defaults")

	repo.values["claudex_test_feature"] = `{"enabled":false,"limit":-3}`
	got, err = s.Get(ctx)
	require.NoError(t, err)
	require.Equal(t, testSettings{Enabled: false, Limit: 0, Models: []string{"gpt-5.5"}}, got,
		"stored fields win, missing fields keep defaults, normalize runs on read")

	repo.values["claudex_test_feature"] = `{not json`
	got, err = s.Get(ctx)
	require.NoError(t, err)
	require.Equal(t, defaultTestSettings(), got, "unreadable JSON yields defaults")

	repo.getErr = errors.New("db down")
	_, err = s.Get(ctx)
	require.ErrorContains(t, err, "db down")
}

func TestJSONSettingSetValidatesStoresAndRefreshesCache(t *testing.T) {
	repo := newMemorySettingRepo()
	s := newTestSetting(repo)
	ctx := context.Background()

	require.Equal(t, defaultTestSettings(), s.Cached(ctx))

	_, err := s.Set(ctx, testSettings{Limit: 101})
	require.ErrorContains(t, err, "at most 100")
	_, stored := repo.values["claudex_test_feature"]
	require.False(t, stored, "invalid value is not stored")

	saved, err := s.Set(ctx, testSettings{Enabled: false, Limit: -1, Models: []string{"a"}})
	require.NoError(t, err)
	require.Equal(t, testSettings{Enabled: false, Limit: 0, Models: []string{"a"}}, saved)
	require.JSONEq(t, `{"enabled":false,"limit":0,"models":["a"]}`, repo.values["claudex_test_feature"])

	reads := repo.readCount()
	require.Equal(t, saved, s.Cached(ctx), "Set refreshes this node's cache at once")
	require.Equal(t, reads, repo.readCount())
}

func TestJSONSettingCachedTTLAndErrorFallback(t *testing.T) {
	repo := newMemorySettingRepo()
	s := newTestSetting(repo)
	now := time.Date(2026, 9, 26, 0, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	ctx := context.Background()

	repo.values["claudex_test_feature"] = `{"limit":20}`
	require.Equal(t, 20, s.Cached(ctx).Limit)
	require.Equal(t, 1, repo.readCount())

	repo.values["claudex_test_feature"] = `{"limit":30}`
	now = now.Add(59 * time.Second)
	require.Equal(t, 20, s.Cached(ctx).Limit, "served from cache within 60s")
	require.Equal(t, 1, repo.readCount())

	now = now.Add(2 * time.Second)
	require.Equal(t, 30, s.Cached(ctx).Limit, "re-read after 60s")
	require.Equal(t, 2, repo.readCount())

	repo.getErr = errors.New("db down")
	now = now.Add(61 * time.Second)
	require.Equal(t, 30, s.Cached(ctx).Limit, "last known value on database error")
	require.Equal(t, 3, repo.readCount())
	now = now.Add(4 * time.Second)
	require.Equal(t, 30, s.Cached(ctx).Limit)
	require.Equal(t, 3, repo.readCount(), "error fallback is cached briefly")
	now = now.Add(2 * time.Second)
	s.Cached(ctx)
	require.Equal(t, 4, repo.readCount(), "retried after 5s")

	repo.getErr = nil
	s.Invalidate()
	require.Equal(t, 30, s.Cached(ctx).Limit)
	require.Equal(t, 5, repo.readCount(), "Invalidate forces a read")
}

func TestJSONSettingCachedWithoutRepoOrPriorValue(t *testing.T) {
	require.Equal(t, defaultTestSettings(), newTestSetting(nil).Cached(context.Background()))

	repo := newMemorySettingRepo()
	repo.getErr = errors.New("db down")
	require.Equal(t, defaultTestSettings(), newTestSetting(repo).Cached(context.Background()))

	_, err := newTestSetting(nil).Set(context.Background(), defaultTestSettings())
	require.Error(t, err)
}

type mapSettings struct {
	Limits map[string]int `json:"limits"`
}

func TestJSONSettingMapDefaultsFilledInNormalize(t *testing.T) {
	// The documented pattern for map defaults: nil in defaults, filled in
	// normalize only while still nil, so a stored map replaces the default map
	// instead of being merged into it.
	repo := newMemorySettingRepo()
	s := NewJSONSetting(repo, "claudex_map_feature", func() mapSettings { return mapSettings{} },
		WithNormalize(func(v *mapSettings) {
			if v.Limits == nil {
				v.Limits = map[string]int{"default-model": 10}
			}
		}))
	ctx := context.Background()

	got, err := s.Get(ctx)
	require.NoError(t, err)
	require.Equal(t, map[string]int{"default-model": 10}, got.Limits, "missing key yields the default map")

	repo.values["claudex_map_feature"] = `{"limits":{"other-model":3}}`
	got, err = s.Get(ctx)
	require.NoError(t, err)
	require.Equal(t, map[string]int{"other-model": 3}, got.Limits, "a stored map replaces the default map")

	_, err = s.Set(ctx, mapSettings{Limits: map[string]int{}})
	require.NoError(t, err)
	got, err = s.Get(ctx)
	require.NoError(t, err)
	require.Empty(t, got.Limits, "a stored empty map stays empty")
	require.NotNil(t, got.Limits)
}

func TestNewJSONSettingRejectsForeignKeys(t *testing.T) {
	require.Panics(t, func() { NewJSONSetting(nil, "panel_rate_limit_settings", defaultTestSettings) })
	require.Panics(t, func() { NewJSONSetting(nil, "claudex_", defaultTestSettings) })
	require.Panics(t, func() { NewJSONSetting[testSettings](nil, "claudex_x", nil) })
}

func TestJSONSettingGetRaw(t *testing.T) {
	repo := newMemorySettingRepo()
	s := newTestSetting(repo)
	ctx := context.Background()

	v, raw, err := s.GetRaw(ctx)
	require.NoError(t, err)
	require.Equal(t, "", raw, "missing key has no raw value")
	require.Equal(t, defaultTestSettings(), v)

	repo.values["claudex_test_feature"] = `{"limit":7}`
	v, raw, err = s.GetRaw(ctx)
	require.NoError(t, err)
	require.Equal(t, `{"limit":7}`, raw)
	require.Equal(t, 7, v.Limit)

	repo.getErr = errors.New("db down")
	_, _, err = s.GetRaw(ctx)
	require.ErrorContains(t, err, "db down")
}

func TestJSONSettingSwapIfUnchangedStatements(t *testing.T) {
	ctx := context.Background()
	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	s := newTestSetting(newMemorySettingRepo())

	// Key missing: insert, or fill a stored empty value, never overwrite.
	mock.ExpectExec(regexp.QuoteMeta(`INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW() WHERE settings.value = ''`)).
		WithArgs("claudex_test_feature", `{"enabled":true,"limit":0,"models":null}`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	saved, ok, err := s.SwapIfUnchanged(ctx, db, "", testSettings{Enabled: true, Limit: -5})
	require.NoError(t, err)
	require.True(t, ok)
	require.Equal(t, 0, saved.Limit, "normalized before storing")
	require.Equal(t, saved, s.Cached(ctx), "a successful swap refreshes this node's cache")

	// Existing value: compare and swap on the stored text.
	mock.ExpectExec(regexp.QuoteMeta(`UPDATE settings SET value = $2, updated_at = NOW() WHERE key = $1 AND value = $3`)).
		WithArgs("claudex_test_feature", `{"enabled":false,"limit":3,"models":null}`, `{"limit":7}`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	_, ok, err = s.SwapIfUnchanged(ctx, db, `{"limit":7}`, testSettings{Limit: 3})
	require.NoError(t, err)
	require.False(t, ok, "zero rows means another writer won")

	mock.ExpectExec(`UPDATE settings`).WillReturnError(errors.New("db down"))
	_, ok, err = s.SwapIfUnchanged(ctx, db, `{"limit":7}`, testSettings{Limit: 3})
	require.ErrorContains(t, err, "db down")
	require.False(t, ok)

	// Validation runs before any statement.
	_, ok, err = s.SwapIfUnchanged(ctx, db, `{"limit":7}`, testSettings{Limit: 101})
	require.ErrorContains(t, err, "at most 100")
	require.False(t, ok)
	require.NoError(t, mock.ExpectationsWereMet())

	_, _, err = s.SwapIfUnchanged(ctx, nil, "", testSettings{})
	require.Error(t, err)
}
