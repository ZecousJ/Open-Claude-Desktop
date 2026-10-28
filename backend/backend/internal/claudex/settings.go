package claudex

import (
	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/service"
)

// The JSON settings helper moved to core (component packages cannot import
// this package); these wrappers keep the original names.

// SettingKeyPrefix starts every Claudex settings key.
const SettingKeyPrefix = core.SettingKeyPrefix

// JSONSetting stores one component's settings as a JSON document (see core).
type JSONSetting[T any] = core.JSONSetting[T]

// JSONSettingOption configures a JSONSetting.
type JSONSettingOption[T any] = core.JSONSettingOption[T]

// NewJSONSetting creates a setting stored under key (must start with
// SettingKeyPrefix).
func NewJSONSetting[T any](repo service.SettingRepository, key string, defaults func() T, opts ...JSONSettingOption[T]) *JSONSetting[T] {
	return core.NewJSONSetting(repo, key, defaults, opts...)
}

// WithNormalize fixes values in place after every read and before writes.
func WithNormalize[T any](fn func(*T)) JSONSettingOption[T] { return core.WithNormalize(fn) }

// WithValidate rejects invalid values on Set.
func WithValidate[T any](fn func(*T) error) JSONSettingOption[T] { return core.WithValidate(fn) }
