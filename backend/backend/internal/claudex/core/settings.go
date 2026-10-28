package core

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync/atomic"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/service"

	"golang.org/x/sync/singleflight"
)

// Settings keys owned by Claudex start with this prefix; each feature stores
// one JSON document under one key (e.g. "claudex_client_policy").
const SettingKeyPrefix = "claudex_"

const (
	jsonSettingCacheTTL  = 60 * time.Second
	jsonSettingErrorTTL  = 5 * time.Second
	jsonSettingDBTimeout = 5 * time.Second
)

// JSONSetting stores one feature's settings as a JSON document under a single
// key of the upstream settings table, following the pattern of the upstream
// panel rate-limit setting (setting_panel_rate_limit.go):
//
//   - Get reads the database; a missing, empty or unreadable value yields the
//     defaults, and fields missing from the stored JSON keep their defaults;
//   - Set normalizes, validates, stores and refreshes this node's cache at once;
//   - Cached serves hot paths from a per-process cache (60 s; other nodes see a
//     change within 60 s) and keeps the last known value for 5 s when the
//     database fails.
//
// Values returned by Cached are shared: treat slices and maps inside them as
// read-only.
//
// The stored JSON is decoded on top of a fresh defaults() value, and
// encoding/json decodes into existing maps (and into existing slice elements)
// in place. So defaults must not pre-fill a map, or a slice of structs or maps:
// a stored value could then never drop a default map key. Leave such fields
// nil in defaults and fill them in WithNormalize when they are still nil after
// decoding (a stored empty map or list decodes to a non-nil empty value and is
// kept).
type JSONSetting[T any] struct {
	repo      service.SettingRepository
	key       string
	defaults  func() T
	normalize func(*T)
	validate  func(*T) error

	cache atomic.Pointer[jsonSettingEntry[T]]
	sf    singleflight.Group
	now   func() time.Time
}

type jsonSettingEntry[T any] struct {
	value     T
	expiresAt time.Time
}

// JSONSettingOption configures a JSONSetting.
type JSONSettingOption[T any] func(*JSONSetting[T])

// WithNormalize fixes values in place (clamping, trimming) after every read
// and before validation on write.
func WithNormalize[T any](fn func(*T)) JSONSettingOption[T] {
	return func(s *JSONSetting[T]) { s.normalize = fn }
}

// WithValidate rejects invalid values on Set.
func WithValidate[T any](fn func(*T) error) JSONSettingOption[T] {
	return func(s *JSONSetting[T]) { s.validate = fn }
}

// NewJSONSetting creates the setting stored under key, which must start with
// SettingKeyPrefix. defaults must return a fresh value on every call.
func NewJSONSetting[T any](repo service.SettingRepository, key string, defaults func() T, opts ...JSONSettingOption[T]) *JSONSetting[T] {
	if !strings.HasPrefix(key, SettingKeyPrefix) || len(key) == len(SettingKeyPrefix) {
		panic(fmt.Sprintf("claudex: setting key %q must start with %q", key, SettingKeyPrefix))
	}
	if defaults == nil {
		panic("claudex: setting " + key + " needs a defaults function")
	}
	s := &JSONSetting[T]{repo: repo, key: key, defaults: defaults, now: time.Now}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

// Key returns the settings key.
func (s *JSONSetting[T]) Key() string { return s.key }

// Default returns a fresh default value.
func (s *JSONSetting[T]) Default() T {
	v := s.defaults()
	if s.normalize != nil {
		s.normalize(&v)
	}
	return v
}

// Get reads the current value from the database.
func (s *JSONSetting[T]) Get(ctx context.Context) (T, error) {
	v, _, err := s.GetRaw(ctx)
	return v, err
}

// GetRaw reads the current value together with the stored text ("" when the
// key does not exist). Pass raw to SwapIfUnchanged for an atomic
// compare-and-swap write.
func (s *JSONSetting[T]) GetRaw(ctx context.Context) (v T, raw string, err error) {
	if s.repo == nil {
		return s.Default(), "", nil
	}
	raw, err = s.repo.GetValue(ctx, s.key)
	if err != nil {
		if errors.Is(err, service.ErrSettingNotFound) {
			return s.Default(), "", nil
		}
		var zero T
		return zero, "", fmt.Errorf("get setting %s: %w", s.key, err)
	}
	return s.decode(raw), raw, nil
}

// SwapIfUnchanged normalizes, validates and stores value only if the stored
// text still equals expectedRaw (from GetRaw), in one SQL statement on the
// upstream settings table. ok is false when another writer got there first
// (callers answer 409). On success this node's cache is refreshed.
//
// expectedRaw "" means "the key does not exist yet (or is empty)".
func (s *JSONSetting[T]) SwapIfUnchanged(ctx context.Context, db *sql.DB, expectedRaw string, value T) (saved T, ok bool, err error) {
	var zero T
	if db == nil {
		return zero, false, fmt.Errorf("swap setting %s: database unavailable", s.key)
	}
	if s.normalize != nil {
		s.normalize(&value)
	}
	if s.validate != nil {
		if err := s.validate(&value); err != nil {
			return zero, false, err
		}
	}
	data, err := json.Marshal(value)
	if err != nil {
		return zero, false, fmt.Errorf("marshal setting %s: %w", s.key, err)
	}
	var res sql.Result
	if expectedRaw == "" {
		res, err = db.ExecContext(ctx, `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW() WHERE settings.value = ''`, s.key, string(data))
	} else {
		res, err = db.ExecContext(ctx, `UPDATE settings SET value = $2, updated_at = NOW() WHERE key = $1 AND value = $3`,
			s.key, string(data), expectedRaw)
	}
	if err != nil {
		return zero, false, fmt.Errorf("swap setting %s: %w", s.key, err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return zero, false, fmt.Errorf("swap setting %s: %w", s.key, err)
	}
	if n == 0 {
		return zero, false, nil
	}
	s.store(value, jsonSettingCacheTTL)
	return value, true, nil
}

func (s *JSONSetting[T]) decode(raw string) T {
	v := s.defaults()
	if strings.TrimSpace(raw) != "" {
		if err := json.Unmarshal([]byte(raw), &v); err != nil {
			slog.Warn("claudex: unreadable setting, using defaults", "key", s.key, "error", err)
			v = s.defaults()
		}
	}
	if s.normalize != nil {
		s.normalize(&v)
	}
	return v
}

// Set validates and stores value, then refreshes this node's cache. It returns
// the stored (normalized) value.
func (s *JSONSetting[T]) Set(ctx context.Context, value T) (T, error) {
	var zero T
	if s.repo == nil {
		return zero, fmt.Errorf("set setting %s: settings storage unavailable", s.key)
	}
	if s.normalize != nil {
		s.normalize(&value)
	}
	if s.validate != nil {
		if err := s.validate(&value); err != nil {
			return zero, err
		}
	}
	data, err := json.Marshal(value)
	if err != nil {
		return zero, fmt.Errorf("marshal setting %s: %w", s.key, err)
	}
	if err := s.repo.Set(ctx, s.key, string(data)); err != nil {
		return zero, fmt.Errorf("store setting %s: %w", s.key, err)
	}
	s.store(value, jsonSettingCacheTTL)
	return value, nil
}

// Cached returns the value from the per-process cache, reading the database at
// most once per TTL across concurrent callers. It never fails: on a database
// error it serves the last known value (or the defaults) and retries after 5 s.
func (s *JSONSetting[T]) Cached(ctx context.Context) T {
	if v, ok := s.fresh(); ok {
		return v
	}
	result, _, _ := s.sf.Do(s.key, func() (any, error) {
		if v, ok := s.fresh(); ok {
			return v, nil
		}
		if ctx == nil {
			ctx = context.Background()
		}
		// Detach from the request so a client disconnect cannot poison the cache.
		dbCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), jsonSettingDBTimeout)
		defer cancel()
		v, err := s.Get(dbCtx)
		if err != nil {
			slog.Warn("claudex: reading setting failed, serving last known value", "key", s.key, "error", err)
			fallback := s.Default()
			if prior := s.cache.Load(); prior != nil {
				fallback = prior.value
			}
			s.store(fallback, jsonSettingErrorTTL)
			return fallback, nil
		}
		s.store(v, jsonSettingCacheTTL)
		return v, nil
	})
	if v, ok := result.(T); ok {
		return v
	}
	return s.Default()
}

// Invalidate drops this node's cached value.
func (s *JSONSetting[T]) Invalidate() { s.cache.Store(nil) }

func (s *JSONSetting[T]) fresh() (T, bool) {
	if e := s.cache.Load(); e != nil && s.now().Before(e.expiresAt) {
		return e.value, true
	}
	var zero T
	return zero, false
}

func (s *JSONSetting[T]) store(v T, ttl time.Duration) {
	s.cache.Store(&jsonSettingEntry[T]{value: v, expiresAt: s.now().Add(ttl)})
}
