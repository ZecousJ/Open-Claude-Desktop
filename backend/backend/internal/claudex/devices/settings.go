package devices

import (
	"math"
	"sort"
	"strings"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
)

// Plan strategies.
const (
	StrategySubscriptionThenDefault = "subscription_then_default"
	StrategyFixed                   = "fixed"
)

// Device limit bounds (owner decision 9: default 5, adjustable per user).
const (
	DefaultMaxDevices = 5
	MinMaxDevices     = 1
	MaxMaxDevices     = 50
)

// Provisioning is the claudex_provisioning setting (design 2.5).
type Provisioning struct {
	// Enabled turns device-key provisioning (POST /claudex/devices) on.
	Enabled bool `json:"enabled"`
	// Strategy picks the plan group: subscription_then_default or fixed.
	Strategy string `json:"strategy"`
	// DefaultGroupID is the default plan group (required for fixed).
	DefaultGroupID *int64 `json:"default_group_id"`
	// AllowedGroupIDs limits the plan groups; empty means every group the
	// user may bind.
	AllowedGroupIDs []int64 `json:"allowed_group_ids"`
	// OnSignup runs for self-registered users.
	OnSignup SignupSettings `json:"on_signup"`
	// KeyDefaults are the limits of newly created device keys.
	KeyDefaults KeyDefaults `json:"key_defaults"`
	// MaxDevicesPerUser is the default device limit (1-50); an administrator
	// can override it per user (claudex_user_device_limits).
	MaxDevicesPerUser int `json:"max_devices_per_user"`
	// UserAPIKeysEnabled lets users create their own API keys through the
	// upstream /api/v1/keys endpoint (owner decision 17, default off).
	// Device keys never depend on it.
	UserAPIKeysEnabled bool `json:"user_api_keys_enabled"`
}

// SignupSettings configures the signup hook.
type SignupSettings struct {
	// GrantDefaultGroup adds the default group to a new user's allowed
	// groups when it is an exclusive standard group. Anyone who can register
	// gets that group.
	GrantDefaultGroup bool `json:"grant_default_group"`
}

// KeyDefaults are the limits of a new device key (0 = unlimited).
type KeyDefaults struct {
	QuotaUSD      float64 `json:"quota_usd"`
	ExpiresInDays *int    `json:"expires_in_days"`
	RateLimit5h   float64 `json:"rate_limit_5h"`
	RateLimit1d   float64 `json:"rate_limit_1d"`
	RateLimit7d   float64 `json:"rate_limit_7d"`
}

func defaultProvisioning() Provisioning {
	return Provisioning{
		Enabled:           true,
		Strategy:          StrategySubscriptionThenDefault,
		MaxDevicesPerUser: DefaultMaxDevices,
	}
}

func normalizeProvisioning(p *Provisioning) {
	p.Strategy = strings.ToLower(strings.TrimSpace(p.Strategy))
	if p.Strategy == "" {
		p.Strategy = StrategySubscriptionThenDefault
	}
	if p.AllowedGroupIDs == nil {
		p.AllowedGroupIDs = []int64{}
	}
	if len(p.AllowedGroupIDs) > 1 {
		ids := append([]int64(nil), p.AllowedGroupIDs...)
		sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
		out := ids[:0]
		for i, id := range ids {
			if i == 0 || id != ids[i-1] {
				out = append(out, id)
			}
		}
		p.AllowedGroupIDs = out
	}
}

func invalidProvisioning(field, rule, message string) error {
	return core.InvalidSetting("CLAUDEX_PROVISIONING_INVALID", field, rule, message)
}

// validateProvisioning checks the value shape; group existence is checked by
// the admin handler (it needs the database).
func validateProvisioning(p *Provisioning) error {
	switch p.Strategy {
	case StrategySubscriptionThenDefault, StrategyFixed:
	default:
		return invalidProvisioning("strategy", "enum", "Strategy must be subscription_then_default or fixed.")
	}
	if p.DefaultGroupID != nil && *p.DefaultGroupID <= 0 {
		return invalidProvisioning("default_group_id", "positive", "Default group must be a group id.")
	}
	if p.Strategy == StrategyFixed && p.DefaultGroupID == nil {
		return invalidProvisioning("default_group_id", "required_for_fixed", "Choose a default group to always use.")
	}
	if len(p.AllowedGroupIDs) > 500 {
		return invalidProvisioning("allowed_group_ids", "max_items", "Allow at most 500 groups.")
	}
	for _, id := range p.AllowedGroupIDs {
		if id <= 0 {
			return invalidProvisioning("allowed_group_ids", "positive", "Allowed groups must be group ids.")
		}
	}
	if p.DefaultGroupID != nil && len(p.AllowedGroupIDs) > 0 && !containsID(p.AllowedGroupIDs, *p.DefaultGroupID) {
		return invalidProvisioning("default_group_id", "not_in_allowed_groups", "The default group must be one of the allowed groups.")
	}
	if p.OnSignup.GrantDefaultGroup && p.DefaultGroupID == nil {
		return invalidProvisioning("on_signup.grant_default_group", "needs_default_group", "Choose a default group to grant at sign-up.")
	}
	for _, l := range []struct {
		field string
		v     float64
	}{
		{"key_defaults.quota_usd", p.KeyDefaults.QuotaUSD},
		{"key_defaults.rate_limit_5h", p.KeyDefaults.RateLimit5h},
		{"key_defaults.rate_limit_1d", p.KeyDefaults.RateLimit1d},
		{"key_defaults.rate_limit_7d", p.KeyDefaults.RateLimit7d},
	} {
		if math.IsNaN(l.v) || math.IsInf(l.v, 0) || l.v < 0 {
			return invalidProvisioning(l.field, "non_negative", "Limits must be 0 (unlimited) or more.")
		}
	}
	if d := p.KeyDefaults.ExpiresInDays; d != nil && (*d < 1 || *d > 3650) {
		return invalidProvisioning("key_defaults.expires_in_days", "range", "Expiry must be empty or 1 to 3650 days.")
	}
	if p.MaxDevicesPerUser < MinMaxDevices || p.MaxDevicesPerUser > MaxMaxDevices {
		return invalidProvisioning("max_devices_per_user", "range", "Max devices per user must be 1 to 50.")
	}
	return nil
}

func containsID(ids []int64, id int64) bool {
	for _, v := range ids {
		if v == id {
			return true
		}
	}
	return false
}
