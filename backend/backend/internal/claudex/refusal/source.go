package refusal

import (
	"context"
	"database/sql"
	"errors"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/service"
)

// source is where the describer reads the data it adds to a refusal. The
// component uses envSource (the upstream services and the Claudex database);
// tests substitute stubs.
type source interface {
	// APIKey loads the key with its quota and rate-limit configuration.
	APIKey(ctx context.Context, id int64) (*service.APIKey, error)
	// RateLimitData reads the key's 5h/1d/7d usage windows.
	RateLimitData(ctx context.Context, id int64) (*service.APIKeyRateLimitData, error)
	// ActiveSubscription returns the user's active subscription to a group.
	ActiveSubscription(ctx context.Context, userID, groupID int64) (*service.UserSubscription, error)
	// SubscriptionProgress computes the usage windows of a subscription.
	SubscriptionProgress(ctx context.Context, subscriptionID int64) (*service.SubscriptionProgress, error)
	// SubscriptionStatus returns the status of the user's subscription to a
	// group whatever its state (active, expired, suspended); found is false
	// when the user has none.
	SubscriptionStatus(ctx context.Context, userID, groupID int64) (status string, found bool, err error)
	// DeviceRevoked reads claudex_devices directly (no cache): whether the
	// device owning the key is revoked, and whether such a device exists.
	DeviceRevoked(ctx context.Context, apiKeyID int64) (revoked, found bool, err error)
	// Settings reads settings rows (missing keys are absent from the map).
	Settings(ctx context.Context, keys []string) (map[string]string, error)
}

var errUnavailable = errors.New("claudex refusal: dependency not available")

// envSource reads through the upstream services in core.Deps, so the data
// goes through the same repositories (and caches) as the upstream checks.
type envSource struct{ env *core.Env }

func (s envSource) APIKey(ctx context.Context, id int64) (*service.APIKey, error) {
	if s.env == nil || s.env.APIKeys == nil {
		return nil, errUnavailable
	}
	return s.env.APIKeys.GetByID(ctx, id)
}

func (s envSource) RateLimitData(ctx context.Context, id int64) (*service.APIKeyRateLimitData, error) {
	if s.env == nil || s.env.APIKeys == nil {
		return nil, errUnavailable
	}
	return s.env.APIKeys.GetRateLimitData(ctx, id)
}

func (s envSource) ActiveSubscription(ctx context.Context, userID, groupID int64) (*service.UserSubscription, error) {
	if s.env == nil || s.env.Subscriptions == nil {
		return nil, errUnavailable
	}
	return s.env.Subscriptions.GetActiveSubscription(ctx, userID, groupID)
}

func (s envSource) SubscriptionProgress(ctx context.Context, subscriptionID int64) (*service.SubscriptionProgress, error) {
	if s.env == nil || s.env.Subscriptions == nil {
		return nil, errUnavailable
	}
	return s.env.Subscriptions.GetSubscriptionProgress(ctx, subscriptionID)
}

func (s envSource) SubscriptionStatus(ctx context.Context, userID, groupID int64) (string, bool, error) {
	if s.env == nil || s.env.Subscriptions == nil {
		return "", false, errUnavailable
	}
	subs, err := s.env.Subscriptions.ListUserSubscriptions(ctx, userID)
	if err != nil {
		return "", false, err
	}
	for _, sub := range subs {
		if sub.GroupID == groupID {
			return sub.Status, true, nil
		}
	}
	return "", false, nil
}

// deviceRevokedSQL reads the B4 table directly: the device directory caches
// lookups for 5 s per node, and a device revoked on another node a moment ago
// must not be reported as a disabled key that the client can re-provision.
// A key of another group of the device (MG, claudex_device_group_keys) counts
// as the device's key.
const deviceRevokedSQL = `SELECT revoked_at IS NOT NULL FROM claudex_devices WHERE api_key_id = $1
UNION ALL
SELECT d.revoked_at IS NOT NULL FROM claudex_device_group_keys gk JOIN claudex_devices d ON d.id = gk.device_id WHERE gk.api_key_id = $1
LIMIT 1`

func (s envSource) DeviceRevoked(ctx context.Context, apiKeyID int64) (bool, bool, error) {
	if s.env == nil || s.env.DB == nil {
		return false, false, errUnavailable
	}
	var revoked bool
	err := s.env.DB.QueryRowContext(ctx, deviceRevokedSQL, apiKeyID).Scan(&revoked)
	if errors.Is(err, sql.ErrNoRows) {
		return false, false, nil
	}
	if err != nil {
		return false, false, err
	}
	return revoked, true, nil
}

func (s envSource) Settings(ctx context.Context, keys []string) (map[string]string, error) {
	if s.env == nil || s.env.SettingRepo == nil {
		return nil, errUnavailable
	}
	return s.env.SettingRepo.GetMultiple(ctx, keys)
}
