// Package devices is the B4 component for Claudex devices and their
// idempotent device keys (design 2.5):
//
//   - tables claudex_devices, claudex_session_revocations,
//     claudex_revoked_sessions and claudex_user_device_limits
//     (migrations/claudex_0020_devices.sql), and claudex_device_group_keys
//     for a device's keys of its other groups (MG, group_keys.go,
//     migrations/claudex_0021_device_group_keys.sql);
//   - setting claudex_provisioning (including the owner-decision-17 switch
//     user_api_keys_enabled);
//   - the plan resolver, device registration (POST /api/v1/claudex/devices),
//     the user's own devices and sign-out, the admin provisioning, device list,
//     revocation, revoke-all and per-user device limits;
//   - the peers PlanResolver, DeviceDirectory and SessionGuard (H9b);
//   - the hooks SessionsRevoked (H9), ManagedAPIKeyIDs (H13), the
//     /api/v1/keys create gate (decision 17) and the signup hook (H7);
//   - the gateway KeyMarker (H5) and the revoked-device RequestGuard (H5b,
//     priority 10);
//   - the bootstrap sections plan and device, and the background
//     reconciliation of revoked devices whose key is still usable.
//
// A key is a Claudex device key exactly when claudex_devices.api_key_id or
// claudex_device_group_keys.api_key_id points to it; revoking devices never
// touches any other key of the user (owner decision 13).
package devices

import (
	"context"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/gatewayhook"
	"github.com/Wei-Shaw/sub2api/internal/service"
)

// SettingKey is the settings key of the provisioning settings.
const SettingKey = "claudex_provisioning"

// apiKeyStore is the part of service.APIKeyService the component uses. Device
// keys are only ever written through it, so the upstream key caches stay
// consistent (design 1.3).
type apiKeyStore interface {
	Create(ctx context.Context, userID int64, req service.CreateAPIKeyRequest) (*service.APIKey, error)
	Update(ctx context.Context, id int64, userID int64, req service.UpdateAPIKeyRequest) (*service.APIKey, error)
	Delete(ctx context.Context, id int64, userID int64) error
	GetByID(ctx context.Context, id int64) (*service.APIKey, error)
	SearchAPIKeys(ctx context.Context, userID int64, keyword string, limit int) ([]service.APIKey, error)
	GetAvailableGroups(ctx context.Context, userID int64) ([]service.Group, error)
}

// subscriptionSource lists a user's active subscriptions.
type subscriptionSource interface {
	ListActiveUserSubscriptions(ctx context.Context, userID int64) ([]service.UserSubscription, error)
}

// Component is the B4 devices component.
type Component struct {
	env          *core.Env
	provisioning *core.JSONSetting[Provisioning]

	devices  *ttlCache[int64, deviceLookup]      // LookupByAPIKey, by API key id
	sessions *ttlCache[sessionKey, sessionState] // SessionGuard.Check, by user and sid
	seen     *ttlCache[int64, struct{}]          // devices whose last_seen_at was written recently

	// Test seams; nil means the matching env dependency.
	keyStore apiKeyStore
	subStore subscriptionSource
	clock    func() time.Time
}

// New builds the component. It must not call its dependencies or env.Peers:
// ProvideModule binds the peers after every component is built, and tests
// pass empty Deps.
func New(env *core.Env) *Component {
	if env == nil {
		env = &core.Env{}
	}
	c := &Component{
		env:      env,
		devices:  newTTLCache[int64, deviceLookup](lookupCacheMax),
		sessions: newTTLCache[sessionKey, sessionState](sessionCacheMax),
		seen:     newTTLCache[int64, struct{}](lookupCacheMax),
	}
	c.provisioning = core.NewJSONSetting(env.SettingRepo, SettingKey, defaultProvisioning,
		core.WithNormalize(normalizeProvisioning), core.WithValidate(validateProvisioning))
	return c
}

// Name implements core.Feature.
func (c *Component) Name() string { return core.NameDevices }

// SettingKeys implements core.SettingsOwner.
func (c *Component) SettingKeys() []string { return []string{c.provisioning.Key()} }

func (c *Component) now() time.Time {
	if c.clock != nil {
		return c.clock()
	}
	if c.env != nil && c.env.Now != nil {
		return c.env.Now()
	}
	return time.Now()
}

// keys returns the API key service, nil when it is not wired (tests).
func (c *Component) keys() apiKeyStore {
	if c.keyStore != nil {
		return c.keyStore
	}
	if c.env == nil || c.env.APIKeys == nil {
		return nil
	}
	return c.env.APIKeys
}

func (c *Component) subscriptions() subscriptionSource {
	if c.subStore != nil {
		return c.subStore
	}
	if c.env == nil || c.env.Subscriptions == nil {
		return nil
	}
	return c.env.Subscriptions
}

// settings returns the cached provisioning settings (60 s per node).
func (c *Component) settings(ctx context.Context) Provisioning {
	return c.provisioning.Cached(ctx)
}

var (
	_ core.Feature              = (*Component)(nil)
	_ core.SettingsOwner        = (*Component)(nil)
	_ core.UserRouter           = (*Component)(nil)
	_ core.AdminRouter          = (*Component)(nil)
	_ core.SignupHooker         = (*Component)(nil)
	_ core.Starter              = (*Component)(nil)
	_ core.BootstrapContributor = (*Component)(nil)
	_ core.PlanResolver         = (*Component)(nil)
	_ core.DeviceDirectory      = (*Component)(nil)
	_ core.SessionGuard         = (*Component)(nil)
	_ core.SessionRevoker       = (*Component)(nil)
	_ core.ManagedKeyOwner      = (*Component)(nil)
	_ core.APIKeyCreateGate     = (*Component)(nil)
	_ gatewayhook.KeyMarker     = (*Component)(nil)
	_ gatewayhook.RequestGuard  = (*Component)(nil)
	_ apiKeyStore               = (*service.APIKeyService)(nil)
	_ subscriptionSource        = (*service.SubscriptionService)(nil)
)
