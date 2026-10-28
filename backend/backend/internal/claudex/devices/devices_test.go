//go:build unit

package devices

import (
	"bytes"
	"context"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/gatewayhook"
	claudexhook "github.com/Wei-Shaw/sub2api/internal/claudex/hook"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/alicebob/miniredis/v2"
	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
)

// ---- fakes ----

type memSettings struct {
	mu     sync.Mutex
	values map[string]string
}

func newMemSettings(kv ...string) *memSettings {
	m := &memSettings{values: map[string]string{}}
	for i := 0; i+1 < len(kv); i += 2 {
		m.values[kv[i]] = kv[i+1]
	}
	return m
}

func (m *memSettings) Get(ctx context.Context, key string) (*service.Setting, error) {
	v, err := m.GetValue(ctx, key)
	if err != nil {
		return nil, err
	}
	return &service.Setting{Key: key, Value: v}, nil
}
func (m *memSettings) GetValue(_ context.Context, key string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	v, ok := m.values[key]
	if !ok {
		return "", service.ErrSettingNotFound
	}
	return v, nil
}
func (m *memSettings) Set(_ context.Context, key, value string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.values[key] = value
	return nil
}
func (m *memSettings) GetMultiple(context.Context, []string) (map[string]string, error) {
	return nil, errors.New("not used")
}
func (m *memSettings) SetMultiple(context.Context, map[string]string) error {
	return errors.New("not used")
}
func (m *memSettings) GetAll(context.Context) (map[string]string, error) {
	return nil, errors.New("not used")
}
func (m *memSettings) Delete(context.Context, string) error { return errors.New("not used") }

// fakeKeys implements apiKeyStore for plan resolution tests.
type fakeKeys struct {
	apiKeyStore
	groups []service.Group
	err    error
}

func (f fakeKeys) GetAvailableGroups(context.Context, int64) ([]service.Group, error) {
	return f.groups, f.err
}

type fakeSubs struct {
	subs []service.UserSubscription
	err  error
}

func (f fakeSubs) ListActiveUserSubscriptions(context.Context, int64) ([]service.UserSubscription, error) {
	return f.subs, f.err
}

func newTestComponent(deps core.Deps) *Component {
	env := &core.Env{Deps: deps, Now: time.Now}
	c := New(env)
	env.Peers = core.Peers{Plans: c, Devices: c, Sessions: c}
	return c
}

func int64p(v int64) *int64 { return &v }
func intp(v int) *int       { return &v }

// ---- settings ----

func TestProvisioningDefaults(t *testing.T) {
	c := newTestComponent(core.Deps{})
	require.Equal(t, []string{"claudex_provisioning"}, c.SettingKeys())
	require.Equal(t, core.NameDevices, c.Name())
	p := c.settings(context.Background())
	require.True(t, p.Enabled)
	require.Equal(t, StrategySubscriptionThenDefault, p.Strategy)
	require.Nil(t, p.DefaultGroupID)
	require.Equal(t, []int64{}, p.AllowedGroupIDs)
	require.False(t, p.OnSignup.GrantDefaultGroup)
	require.Equal(t, 5, p.MaxDevicesPerUser)
	require.False(t, p.UserAPIKeysEnabled, "owner decision 17: user API keys are off by default")
	raw, err := json.Marshal(p)
	require.NoError(t, err)
	require.JSONEq(t, `{"enabled":true,"strategy":"subscription_then_default","default_group_id":null,"allowed_group_ids":[],
		"on_signup":{"grant_default_group":false},
		"key_defaults":{"quota_usd":0,"expires_in_days":null,"rate_limit_5h":0,"rate_limit_1d":0,"rate_limit_7d":0},
		"max_devices_per_user":5,"user_api_keys_enabled":false}`, string(raw))
	require.NotContains(t, string(raw), "revoke_devices_on_revoke_all", "owner decision 13: revoke-all has no switch")
}

func TestProvisioningValidation(t *testing.T) {
	valid := func() Provisioning {
		p := defaultProvisioning()
		normalizeProvisioning(&p)
		return p
	}
	p := valid()
	p.AllowedGroupIDs = []int64{4, 2, 4, 3}
	normalizeProvisioning(&p)
	require.Equal(t, []int64{2, 3, 4}, p.AllowedGroupIDs)
	require.NoError(t, validateProvisioning(&p))

	for _, tc := range []struct {
		field, rule string
		edit        func(p *Provisioning)
	}{
		{"strategy", "enum", func(p *Provisioning) { p.Strategy = "random" }},
		{"default_group_id", "required_for_fixed", func(p *Provisioning) { p.Strategy = StrategyFixed }},
		{"default_group_id", "positive", func(p *Provisioning) { p.DefaultGroupID = int64p(0) }},
		{"default_group_id", "not_in_allowed_groups", func(p *Provisioning) {
			p.DefaultGroupID = int64p(9)
			p.AllowedGroupIDs = []int64{1, 2}
		}},
		{"allowed_group_ids", "positive", func(p *Provisioning) { p.AllowedGroupIDs = []int64{-1} }},
		{"on_signup.grant_default_group", "needs_default_group", func(p *Provisioning) { p.OnSignup.GrantDefaultGroup = true }},
		{"key_defaults.quota_usd", "non_negative", func(p *Provisioning) { p.KeyDefaults.QuotaUSD = -1 }},
		{"key_defaults.rate_limit_7d", "non_negative", func(p *Provisioning) { p.KeyDefaults.RateLimit7d = -0.5 }},
		{"key_defaults.expires_in_days", "range", func(p *Provisioning) { p.KeyDefaults.ExpiresInDays = intp(0) }},
		{"key_defaults.expires_in_days", "range", func(p *Provisioning) { p.KeyDefaults.ExpiresInDays = intp(3651) }},
		{"max_devices_per_user", "range", func(p *Provisioning) { p.MaxDevicesPerUser = 0 }},
		{"max_devices_per_user", "range", func(p *Provisioning) { p.MaxDevicesPerUser = 51 }},
	} {
		p := valid()
		tc.edit(&p)
		normalizeProvisioning(&p)
		err := validateProvisioning(&p)
		require.Error(t, err, tc.field)
		require.Equal(t, "CLAUDEX_PROVISIONING_INVALID", infraerrors.Reason(err))
		require.Equal(t, http.StatusBadRequest, infraerrors.Code(err))
		md := infraerrors.FromError(err).Metadata
		require.Equal(t, tc.field, md["field"])
		require.Equal(t, tc.rule, md["rule"])
	}

	// A fixed strategy with a default group, limits and an expiry is fine.
	p = valid()
	p.Strategy, p.DefaultGroupID, p.AllowedGroupIDs = StrategyFixed, int64p(3), []int64{3}
	p.KeyDefaults = KeyDefaults{QuotaUSD: 50, ExpiresInDays: intp(30), RateLimit5h: 5, RateLimit1d: 10, RateLimit7d: 20}
	p.MaxDevicesPerUser = 50
	require.NoError(t, validateProvisioning(&p))
}

func TestStoredProvisioningKeepsDefaultsForMissingFields(t *testing.T) {
	repo := newMemSettings(SettingKey, `{"enabled":false,"allowed_group_ids":[3,1],"user_api_keys_enabled":true}`)
	c := newTestComponent(core.Deps{SettingRepo: repo})
	p, err := c.provisioning.Get(context.Background())
	require.NoError(t, err)
	require.False(t, p.Enabled)
	require.True(t, p.UserAPIKeysEnabled)
	require.Equal(t, []int64{1, 3}, p.AllowedGroupIDs)
	require.Equal(t, 5, p.MaxDevicesPerUser, "fields missing from the stored JSON keep their defaults")
	require.Equal(t, StrategySubscriptionThenDefault, p.Strategy)
}

// ---- plan resolution ----

func TestChoosePlan(t *testing.T) {
	now := time.Date(2026, 9, 26, 0, 0, 0, 0, time.UTC)
	groups := []service.Group{
		{ID: 1, Name: "public", Platform: "openai", Status: service.StatusActive, SubscriptionType: service.SubscriptionTypeStandard},
		{ID: 2, Name: "anthropic", Platform: "anthropic", Status: service.StatusActive, SubscriptionType: service.SubscriptionTypeStandard},
		{ID: 3, Name: "pro", Platform: "openai", Status: service.StatusActive, SubscriptionType: service.SubscriptionTypeSubscription},
		{ID: 4, Name: "max", Platform: "openai", Status: service.StatusActive, SubscriptionType: service.SubscriptionTypeSubscription},
		{ID: 5, Name: "off", Platform: "openai", Status: "disabled", SubscriptionType: service.SubscriptionTypeStandard},
	}
	sub := func(id, group int64, expires time.Duration) service.UserSubscription {
		return service.UserSubscription{ID: id, GroupID: group, Status: service.SubscriptionStatusActive, ExpiresAt: now.Add(expires)}
	}
	day := 24 * time.Hour
	base := func(edit func(p *Provisioning)) Provisioning {
		p := defaultProvisioning()
		if edit != nil {
			edit(&p)
		}
		normalizeProvisioning(&p)
		return p
	}
	for _, tc := range []struct {
		name      string
		p         Provisioning
		groups    []service.Group
		subs      []service.UserSubscription
		requested *int64
		want      int64 // 0: CLAUDEX_NO_PLAN
	}{
		{"latest-expiring subscription wins", base(nil), groups, []service.UserSubscription{sub(70, 3, 10*day), sub(71, 4, 20*day)}, nil, 4},
		{"equal expiry: smallest group id", base(nil), groups, []service.UserSubscription{sub(71, 4, 10*day), sub(70, 3, 10*day)}, nil, 3},
		{"expired subscriptions are ignored", base(nil), groups, []service.UserSubscription{sub(70, 4, -day)}, nil, 1},
		{"allowed groups limit subscriptions", base(func(p *Provisioning) { p.AllowedGroupIDs = []int64{2, 3} }), groups,
			[]service.UserSubscription{sub(70, 3, 10*day), sub(71, 4, 20*day)}, nil, 3},
		{"allowed groups limit the fallback", base(func(p *Provisioning) { p.AllowedGroupIDs = []int64{2, 3} }), groups, nil, nil, 2},
		{"default group without subscription", base(func(p *Provisioning) { p.DefaultGroupID = int64p(2) }), groups, nil, nil, 2},
		{"smallest available group without default", base(nil), groups, nil, nil, 1},
		{"requested group is used when available", base(nil), groups, []service.UserSubscription{sub(71, 4, 20*day)}, int64p(2), 2},
		{"requested disabled group is ignored", base(nil), groups, []service.UserSubscription{sub(71, 4, 20*day)}, int64p(5), 4},
		{"requested unknown group is ignored", base(nil), groups, nil, int64p(99), 1},
		{"requested group outside allowed is ignored", base(func(p *Provisioning) { p.AllowedGroupIDs = []int64{3} }), groups,
			[]service.UserSubscription{sub(70, 3, day)}, int64p(1), 3},
		{"fixed uses the default group", base(func(p *Provisioning) { p.Strategy, p.DefaultGroupID = StrategyFixed, int64p(2) }), groups,
			[]service.UserSubscription{sub(71, 4, 20*day)}, nil, 2},
		{"fixed with a disabled default has no plan", base(func(p *Provisioning) { p.Strategy, p.DefaultGroupID = StrategyFixed, int64p(5) }),
			groups, nil, nil, 0},
		{"disabled default falls through", base(func(p *Provisioning) { p.DefaultGroupID = int64p(5) }), groups, nil, nil, 1},
		{"no groups, no plan", base(nil), nil, nil, nil, 0},
		{"only disabled groups, no plan", base(nil), groups[4:], nil, nil, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			plan, err := choosePlan(tc.p, tc.groups, tc.subs, tc.requested, now)
			if tc.want == 0 {
				require.ErrorIs(t, err, core.ErrNoPlan)
				require.Nil(t, plan)
				return
			}
			require.NoError(t, err)
			require.Equal(t, tc.want, plan.GroupID)
		})
	}

	plan, err := choosePlan(base(nil), groups, []service.UserSubscription{sub(77, 4, 29*day)}, nil, now)
	require.NoError(t, err)
	expires := now.Add(29 * day)
	require.Equal(t, &core.PlanRef{GroupID: 4, GroupName: "max", Platform: "openai", Protocol: "responses",
		SubscriptionType: "subscription", SubscriptionID: int64p(77), ExpiresAt: &expires, Subscribed: true}, plan)
	plan, err = choosePlan(base(nil), groups, nil, int64p(2), now)
	require.NoError(t, err)
	require.Equal(t, &core.PlanRef{GroupID: 2, GroupName: "anthropic", Platform: "anthropic", Protocol: "chat",
		SubscriptionType: "standard"}, plan)
}

func TestResolvePlanReadsTheUpstreamServices(t *testing.T) {
	ctx := context.Background()
	c := newTestComponent(core.Deps{})
	_, err := c.ResolvePlan(ctx, 1, nil)
	require.ErrorIs(t, err, core.ErrNoPlan, "without the key service there is no plan")

	c.keyStore = fakeKeys{groups: []service.Group{{ID: 3, Name: "pro", Platform: "openai", Status: service.StatusActive,
		SubscriptionType: service.SubscriptionTypeSubscription}}}
	c.subStore = fakeSubs{subs: []service.UserSubscription{{ID: 9, GroupID: 3, Status: service.SubscriptionStatusActive,
		ExpiresAt: time.Now().Add(time.Hour)}}}
	plan, err := c.ResolvePlan(ctx, 1, nil)
	require.NoError(t, err)
	require.Equal(t, int64(3), plan.GroupID)
	require.True(t, plan.Subscribed)

	c.keyStore = fakeKeys{err: service.ErrUserNotFound}
	_, err = c.ResolvePlan(ctx, 1, nil)
	require.ErrorIs(t, err, core.ErrNoPlan)

	c.keyStore = fakeKeys{err: errors.New("db down")}
	_, err = c.ResolvePlan(ctx, 1, nil)
	require.Error(t, err)
	require.NotErrorIs(t, err, core.ErrNoPlan, "a database error is not a missing plan")

	c.keyStore = fakeKeys{}
	c.subStore = fakeSubs{err: errors.New("db down")}
	_, err = c.ResolvePlan(ctx, 1, nil)
	require.Error(t, err)
}

// ---- small helpers ----

func TestDeviceHashAndKeyNames(t *testing.T) {
	id := "6F1C2A4E-9B0D-4C1E-8A57-2F3B9D0C7E11"
	h := DeviceHash(id)
	require.Len(t, h, 64)
	require.Equal(t, h, DeviceHash(strings.ToLower(id)), "the same UUID in either case is one device")
	require.NotEqual(t, h, DeviceHash("6f1c2a4e-9b0d-4c1e-8a57-2f3b9d0c7e12"))
	require.NotContains(t, h, strings.ToLower(id))
	require.Equal(t, "claudex-device:"+h[:12], DeviceKeyName(h))
	require.True(t, strings.HasPrefix(DeviceKeyName(h), "claudex-device:"))
	require.Equal(t, "claudex-desktop:"+id, LegacyKeyName(id))
}

func TestCleanDeviceName(t *testing.T) {
	require.Equal(t, "Ada's MacBook Pro", cleanDeviceName("  Ada's\u0000 MacBook‮ Pro\n "))
	long := strings.Repeat("é", 150)
	require.Equal(t, 100, len([]rune(cleanDeviceName(long))))
	require.Equal(t, "", cleanDeviceName("\t\r\n"))
}

func TestKeyNeedsRotation(t *testing.T) {
	now := time.Now()
	past, future := now.Add(-time.Minute), now.Add(time.Hour)
	for _, tc := range []struct {
		name string
		key  *service.APIKey
		want bool
	}{
		{"missing", nil, true},
		{"someone else's", &service.APIKey{UserID: 2, Status: service.StatusAPIKeyActive}, true},
		{"active", &service.APIKey{UserID: 1, Status: service.StatusAPIKeyActive, ExpiresAt: &future}, false},
		{"disabled", &service.APIKey{UserID: 1, Status: service.StatusAPIKeyDisabled}, true},
		{"expired status", &service.APIKey{UserID: 1, Status: service.StatusAPIKeyExpired}, true},
		{"expired by time", &service.APIKey{UserID: 1, Status: service.StatusAPIKeyActive, ExpiresAt: &past}, true},
		{"quota exhausted is kept", &service.APIKey{UserID: 1, Status: service.StatusAPIKeyQuotaExhausted}, false},
		{"quota exhausted and expired", &service.APIKey{UserID: 1, Status: service.StatusAPIKeyQuotaExhausted, ExpiresAt: &past}, true},
	} {
		require.Equal(t, tc.want, keyNeedsRotation(tc.key, 1, now), tc.name)
	}
}

func TestDeviceLimitError(t *testing.T) {
	err := errDeviceLimit(5, 5)
	require.Equal(t, http.StatusConflict, infraerrors.Code(err))
	require.Equal(t, "CLAUDEX_DEVICE_LIMIT", infraerrors.Reason(err))
	require.Equal(t, "You're signed in to Claudex on 5 devices, the most your account allows. Sign out on one of them, then sign in again.",
		infraerrors.Message(err))
	require.Equal(t, map[string]string{"limit": "5", "active": "5"}, infraerrors.FromError(err).Metadata)
}

func TestSessionStateRevokes(t *testing.T) {
	revokedAt := time.Date(2026, 9, 26, 3, 0, 0, 700_000_000, time.UTC)
	second := revokedAt.Truncate(time.Second)
	cases := []struct {
		name     string
		state    sessionState
		issuedAt time.Time
		want     bool
	}{
		{"nothing revoked", sessionState{HasSID: true}, time.Now(), false},
		{"nothing revoked, no iat", sessionState{}, time.Time{}, false},
		{"signed-out session", sessionState{SidRevoked: true, HasSID: true}, time.Now(), true},
		{"an earlier second", sessionState{RevokedAt: &revokedAt, HasSID: true}, revokedAt.Add(-time.Hour), true},
		{"just before, earlier second", sessionState{RevokedAt: &revokedAt, HasSID: true}, second.Add(-time.Millisecond), true},
		{"a later second", sessionState{RevokedAt: &revokedAt}, second.Add(time.Second), false},
		{"no iat", sessionState{RevokedAt: &revokedAt, HasSID: true}, time.Time{}, true},
		// The same second (i1 finding 3): a new sign-in has a session id that
		// no revocation recorded; the signed-out device sessions were recorded.
		{"same second, new session", sessionState{RevokedAt: &revokedAt, HasSID: true}, second, false},
		{"same second, signed-out session", sessionState{RevokedAt: &revokedAt, HasSID: true, SidRevoked: true}, second, true},
		{"same second, no session id", sessionState{RevokedAt: &revokedAt}, second, true},
	}
	for _, tc := range cases {
		require.Equal(t, tc.want, tc.state.revokes(tc.issuedAt), tc.name)
	}

	// Re-registering a device the administrator or revoke-all signed out
	// follows the same rule.
	fresh := sessionState{HasSID: true}
	require.True(t, fresh.issuedAfterRevoke(second, revokedAt))
	require.True(t, fresh.issuedAfterRevoke(second.Add(time.Second), revokedAt))
	require.False(t, fresh.issuedAfterRevoke(second.Add(-time.Second), revokedAt))
	require.False(t, sessionState{}.issuedAfterRevoke(second, revokedAt), "no session id: refused in the same second")
	require.False(t, sessionState{HasSID: true, SidRevoked: true}.issuedAfterRevoke(second, revokedAt))
}

// ---- session guard, device directory, managed keys (sqlmock) ----

func sessionRows(revokedAt *time.Time, sidRevoked bool) *sqlmock.Rows {
	rows := sqlmock.NewRows([]string{"revoked_at", "exists"})
	if revokedAt == nil {
		return rows.AddRow(nil, sidRevoked)
	}
	return rows.AddRow(*revokedAt, sidRevoked)
}

func TestCheckCachesAndFailsClosed(t *testing.T) {
	ctx := context.Background()
	require.Equal(t, claudexhook.Valid, newTestComponent(core.Deps{}).Check(ctx, 1, time.Now(), "s"),
		"without Claudex storage nothing is revoked")

	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	defer func() { _ = db.Close() }()
	c := newTestComponent(core.Deps{DB: db})
	now := time.Date(2026, 9, 26, 3, 0, 0, 0, time.UTC)
	c.clock = func() time.Time { return now }
	revokedAt := now.Add(-time.Minute)
	before := revokedAt.Add(-time.Second)

	mock.ExpectQuery(`claudex_session_revocations`).WithArgs(int64(7), "sid-a").WillReturnRows(sessionRows(&revokedAt, false))
	require.Equal(t, claudexhook.Revoked, c.Check(ctx, 7, before, "sid-a"))
	require.Equal(t, claudexhook.Valid, c.Check(ctx, 7, revokedAt.Add(time.Second), "sid-a"), "served from the cache")
	require.NoError(t, mock.ExpectationsWereMet())

	// After 5 s the state is read again; a failing read serves the cached state.
	now = now.Add(6 * time.Second)
	mock.ExpectQuery(`claudex_session_revocations`).WillReturnError(errors.New("db down"))
	require.Equal(t, claudexhook.Revoked, c.Check(ctx, 7, before, "sid-a"))
	// Nothing cached for this session: fail closed.
	mock.ExpectQuery(`claudex_session_revocations`).WillReturnError(errors.New("db down"))
	require.Equal(t, claudexhook.CheckFailed, c.Check(ctx, 7, now, "sid-b"))
	// Too old to serve when the database fails.
	now = now.Add(3 * time.Minute)
	mock.ExpectQuery(`claudex_session_revocations`).WillReturnError(errors.New("db down"))
	require.Equal(t, claudexhook.CheckFailed, c.Check(ctx, 7, now, "sid-a"))

	// A signed-out session is refused whatever its iat; a local write drops the cache.
	mock.ExpectQuery(`claudex_session_revocations`).WithArgs(int64(8), "sid-c").WillReturnRows(sessionRows(nil, false))
	require.Equal(t, claudexhook.Valid, c.Check(ctx, 8, now, "sid-c"))
	c.invalidateUser(8)
	mock.ExpectQuery(`claudex_session_revocations`).WithArgs(int64(8), "sid-c").WillReturnRows(sessionRows(nil, true))
	require.Equal(t, claudexhook.Revoked, c.Check(ctx, 8, now.Add(time.Hour), "sid-c"))
	require.NoError(t, mock.ExpectationsWereMet())
}

var deviceCols = []string{"id", "user_id", "device_id_hash", "api_key_id", "group_id", "session_family_id", "device_name", "platform",
	"arch", "app_version", "last_seen_at", "last_ip", "revoked_at", "revoked_reason", "created_at", "updated_at", "key_group_id"}

func deviceRowValues(id, userID, keyID int64, revokedAt driver.Value) []driver.Value {
	created := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	return []driver.Value{id, userID, strings.Repeat("a", 64), keyID, int64(4), "fam", "Mac", "darwin", "arm64", "1.3.2", nil, "", revokedAt,
		"", created, created, nil}
}

func TestLookupByAPIKeyCachesAnswersAndMisses(t *testing.T) {
	ctx := context.Background()
	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	defer func() { _ = db.Close() }()
	c := newTestComponent(core.Deps{DB: db})
	now := time.Now()
	c.clock = func() time.Time { return now }

	mock.ExpectQuery(`FROM claudex_devices WHERE api_key_id`).WithArgs(int64(10)).WillReturnRows(sqlmock.NewRows(deviceCols))
	_, ok := c.LookupByAPIKey(ctx, 10)
	require.False(t, ok)
	_, ok = c.LookupByAPIKey(ctx, 10)
	require.False(t, ok, "the miss is cached")

	mock.ExpectQuery(`FROM claudex_devices WHERE api_key_id`).WithArgs(int64(11)).
		WillReturnRows(sqlmock.NewRows(deviceCols).AddRow(deviceRowValues(51, 7, 11, now)...))
	dev, ok := c.LookupByAPIKey(ctx, 11)
	require.True(t, ok)
	require.Equal(t, int64(51), dev.ID)
	require.Equal(t, int64(7), dev.UserID)
	require.Equal(t, int64(11), dev.APIKeyID)
	require.Equal(t, int64(4), *dev.GroupID)
	require.True(t, dev.Revoked)
	dev.Revoked = false // callers get a copy
	dev, _ = c.LookupByAPIKey(ctx, 11)
	require.True(t, dev.Revoked)

	// Stale answers are used while the database fails; unknown keys are not devices.
	now = now.Add(10 * time.Second)
	mock.ExpectQuery(`FROM claudex_devices WHERE api_key_id`).WillReturnError(errors.New("db down"))
	dev, ok = c.LookupByAPIKey(ctx, 11)
	require.True(t, ok)
	require.True(t, dev.Revoked)
	mock.ExpectQuery(`FROM claudex_devices WHERE api_key_id`).WillReturnError(errors.New("db down"))
	_, ok = c.LookupByAPIKey(ctx, 12)
	require.False(t, ok)
	require.NoError(t, mock.ExpectationsWereMet())

	_, ok = newTestComponent(core.Deps{}).LookupByAPIKey(ctx, 11)
	require.False(t, ok)
}

func TestManagedAPIKeyIDsFailsClosed(t *testing.T) {
	ctx := context.Background()
	require.Empty(t, newTestComponent(core.Deps{}).ManagedAPIKeyIDs(ctx, 1, []int64{1, 2}), "no storage, no device keys")

	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	defer func() { _ = db.Close() }()
	c := newTestComponent(core.Deps{DB: db})
	require.Empty(t, c.ManagedAPIKeyIDs(ctx, 1, nil))

	mock.ExpectQuery(`SELECT api_key_id FROM claudex_devices WHERE user_id = \$1 AND api_key_id = ANY\(\$2\)`).
		WithArgs(int64(1), sqlmock.AnyArg()).WillReturnRows(sqlmock.NewRows([]string{"api_key_id"}).AddRow(int64(2)))
	require.Equal(t, map[int64]bool{2: true}, c.ManagedAPIKeyIDs(ctx, 1, []int64{1, 2, 3}))

	mock.ExpectQuery(`SELECT api_key_id FROM claudex_devices`).WillReturnError(errors.New("db down"))
	require.Equal(t, map[int64]bool{1: true, 2: true, 3: true}, c.ManagedAPIKeyIDs(ctx, 1, []int64{1, 2, 3}),
		"a failed lookup masks and locks every key")
	require.NoError(t, mock.ExpectationsWereMet())
}

// ---- gateway ----

func TestGuardRefusesRevokedDevices(t *testing.T) {
	gin.SetMode(gin.TestMode)
	c := newTestComponent(core.Deps{})
	require.Equal(t, gatewayhook.PriorityDevice, c.Priority())

	run := func(dev *core.DeviceRef) (*httptest.ResponseRecorder, bool, *gin.Context) {
		rec := httptest.NewRecorder()
		g, _ := gin.CreateTestContext(rec)
		g.Request = httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
		if dev != nil {
			gatewayhook.MarkDevice(g, dev)
		}
		return rec, c.OnRequest(g, &service.APIKey{ID: 11}), g
	}
	_, abort, _ := run(nil)
	require.False(t, abort, "user-created keys pass")
	_, abort, _ = run(&core.DeviceRef{ID: 1, APIKeyID: 11})
	require.False(t, abort, "active devices pass")
	rec, abort, g := run(&core.DeviceRef{ID: 1, APIKeyID: 11, Revoked: true})
	require.True(t, abort)
	require.Equal(t, http.StatusUnauthorized, rec.Code)
	require.JSONEq(t, `{"code":"API_KEY_DISABLED","message":"API key is disabled"}`, rec.Body.String())
	detail := gatewayhook.PresetDetail(g)
	require.NotNil(t, detail)
	require.Equal(t, "DEVICE_REVOKED", detail.Reason)
	require.Equal(t, "sign_in", detail.Action)
	require.False(t, detail.Reprovision)
}

// TestMarkerPresetsDeviceRevokedOnUpstreamRefusal: a revoked device's key is
// disabled, so the upstream middleware refuses it before any guard runs; the
// marker's preset detail still reaches the client through the rewriter.
func TestMarkerPresetsDeviceRevokedOnUpstreamRefusal(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	defer func() { _ = db.Close() }()
	c := newTestComponent(core.Deps{DB: db})
	mock.ExpectQuery(`FROM claudex_devices WHERE api_key_id`).WithArgs(int64(11)).
		WillReturnRows(sqlmock.NewRows(deviceCols).AddRow(deviceRowValues(51, 7, 11, time.Now())...))
	mock.ExpectQuery(`FROM claudex_devices WHERE api_key_id`).WithArgs(int64(12)).WillReturnRows(sqlmock.NewRows(deviceCols))

	r := gin.New()
	v1 := r.Group("/v1")
	v1.Use(gatewayhook.EnrichRefusals(), func(g *gin.Context) {
		id := int64(11)
		if g.GetHeader("X-Key") == "user" {
			id = 12
		}
		c.OnKeyResolved(g, &service.APIKey{ID: id})
		middleware.AbortWithError(g, http.StatusUnauthorized, "API_KEY_DISABLED", "API key is disabled")
	})
	v1.POST("/messages", func(g *gin.Context) { g.Status(http.StatusOK) })

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/messages", nil))
	require.Equal(t, http.StatusUnauthorized, rec.Code)
	var body map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Equal(t, "API_KEY_DISABLED", body["code"])
	claudex, _ := body["claudex"].(map[string]any)
	require.Equal(t, "DEVICE_REVOKED", claudex["reason"])
	require.Equal(t, float64(1), claudex["v"])

	rec = httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	req.Header.Set("X-Key", "user")
	r.ServeHTTP(rec, req)
	require.JSONEq(t, `{"code":"API_KEY_DISABLED","message":"API key is disabled"}`, rec.Body.String(),
		"other keys are left byte for byte")
	require.NoError(t, mock.ExpectationsWereMet())
}

// ---- HTTP validation (no database) ----

func userRouter(t *testing.T, c *Component, userID int64) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	g := r.Group("/api/v1/claudex")
	g.Use(func(ctx *gin.Context) {
		ctx.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: userID})
		ctx.Next()
	}, core.ValidateClientHeaders())
	c.RegisterUserRoutes(g)
	return r
}

func call(r http.Handler, method, path string, headers map[string]string, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	r.ServeHTTP(rec, req)
	return rec
}

type envelope struct {
	Code     int               `json:"code"`
	Message  string            `json:"message"`
	Reason   string            `json:"reason"`
	Metadata map[string]string `json:"metadata"`
	Data     json.RawMessage   `json:"data"`
}

func decode(t *testing.T, rec *httptest.ResponseRecorder) envelope {
	t.Helper()
	var e envelope
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &e), rec.Body.String())
	return e
}

const testDevice = "6f1c2a4e-9b0d-4c1e-8a57-2f3b9d0c7e11"

func TestRegisterValidatesTheRequest(t *testing.T) {
	c := newTestComponent(core.Deps{})
	r := userRouter(t, c, 5)
	dev := map[string]string{core.HeaderDeviceID: testDevice}

	rec := call(r, http.MethodPost, "/api/v1/claudex/devices", nil, `{"device_name":"Mac"}`)
	require.Equal(t, http.StatusBadRequest, rec.Code)
	e := decode(t, rec)
	require.Equal(t, "CLAUDEX_DEVICE_INVALID", e.Reason)
	require.Equal(t, core.HeaderDeviceID, e.Metadata["field"])
	require.Equal(t, "no-store", rec.Header().Get("Cache-Control"))

	rec = call(r, http.MethodPost, "/api/v1/claudex/devices", map[string]string{core.HeaderDeviceID: "not-a-uuid"}, `{}`)
	require.Equal(t, http.StatusBadRequest, rec.Code)
	require.Equal(t, "CLAUDEX_INVALID_CLIENT_HEADER", decode(t, rec).Reason)

	for body, field := range map[string]string{
		`{"platform":"android"}`:     "platform",
		`{"arch":"ia32"}`:            "arch",
		`{"app_version":"latest!"}`:  "app_version",
		`{"group_id":0}`:             "group_id",
		`[1,2]`:                      "body",
		`{"device_name":"x"` + "\n}": "",
	} {
		rec = call(r, http.MethodPost, "/api/v1/claudex/devices", dev, body)
		if field == "" {
			require.NotEqual(t, http.StatusBadRequest, rec.Code, body)
			continue
		}
		require.Equal(t, http.StatusBadRequest, rec.Code, body)
		e := decode(t, rec)
		require.Equal(t, "CLAUDEX_DEVICE_INVALID", e.Reason, body)
		require.Equal(t, field, e.Metadata["field"], body)
	}

	// Valid requests without a database answer 503, never a fake success.
	rec = call(r, http.MethodPost, "/api/v1/claudex/devices", dev, `{"device_name":"Mac","platform":"darwin","arch":"arm64","app_version":"1.3.2"}`)
	require.Equal(t, http.StatusServiceUnavailable, rec.Code)
}

func TestRegisterHonorsTheSwitchAndThrottlesOneDevice(t *testing.T) {
	ctx := context.Background()
	off := newTestComponent(core.Deps{SettingRepo: newMemSettings(SettingKey, `{"enabled":false}`)})
	rec := call(userRouter(t, off, 5), http.MethodPost, "/api/v1/claudex/devices", map[string]string{core.HeaderDeviceID: testDevice}, `{}`)
	require.Equal(t, http.StatusForbidden, rec.Code)
	require.Equal(t, "CLAUDEX_DEVICE_KEYS_DISABLED", decode(t, rec).Reason)
	require.False(t, off.settings(ctx).Enabled)

	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer func() { _ = rdb.Close() }()
	c := newTestComponent(core.Deps{Redis: rdb})
	r := userRouter(t, c, 5)
	dev := map[string]string{core.HeaderDeviceID: testDevice}
	for i := 0; i < 2; i++ {
		require.Equal(t, http.StatusServiceUnavailable, call(r, http.MethodPost, "/api/v1/claudex/devices", dev, `{}`).Code)
	}
	rec = call(r, http.MethodPost, "/api/v1/claudex/devices", dev, `{}`)
	require.Equal(t, http.StatusTooManyRequests, rec.Code)
	e := decode(t, rec)
	require.Equal(t, "CLAUDEX_DEVICE_REGISTRATION_THROTTLED", e.Reason)
	require.NotEmpty(t, rec.Header().Get("Retry-After"))
	require.NotEmpty(t, e.Metadata["retry_after_seconds"])
	// Another device of the same user is not throttled by this one.
	other := map[string]string{core.HeaderDeviceID: "7f1c2a4e-9b0d-4c1e-8a57-2f3b9d0c7e11"}
	require.Equal(t, http.StatusServiceUnavailable, call(r, http.MethodPost, "/api/v1/claudex/devices", other, `{}`).Code)
	// Per user: 10 registrations a minute over all devices.
	for i := 0; i < 6; i++ {
		call(r, http.MethodPost, "/api/v1/claudex/devices", other, `{}`)
	}
	rec = call(r, http.MethodPost, "/api/v1/claudex/devices", map[string]string{core.HeaderDeviceID: "8f1c2a4e-9b0d-4c1e-8a57-2f3b9d0c7e11"}, `{}`)
	require.Equal(t, http.StatusTooManyRequests, rec.Code)
	require.Equal(t, "CLAUDEX_RATE_LIMITED", decode(t, rec).Reason)
}

func TestUserDeviceRoutesNeedTheirInputs(t *testing.T) {
	c := newTestComponent(core.Deps{})
	r := userRouter(t, c, 5)
	rec := call(r, http.MethodDelete, "/api/v1/claudex/devices/current", nil, "")
	require.Equal(t, http.StatusBadRequest, rec.Code)
	require.Equal(t, "CLAUDEX_DEVICE_INVALID", decode(t, rec).Reason)
	rec = call(r, http.MethodDelete, "/api/v1/claudex/devices/abc", nil, "")
	require.Equal(t, http.StatusNotFound, rec.Code)
	require.Equal(t, "CLAUDEX_DEVICE_NOT_FOUND", decode(t, rec).Reason)
	rec = call(r, http.MethodGet, "/api/v1/claudex/devices", nil, "")
	require.Equal(t, http.StatusServiceUnavailable, rec.Code)
	require.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
}

func TestAdminRoutesPutWritesBehindStepUp(t *testing.T) {
	gin.SetMode(gin.TestMode)
	repo := newMemSettings()
	c := newTestComponent(core.Deps{SettingRepo: repo})
	r := gin.New()
	var stepped []string
	stepUp := func(g *gin.Context) {
		stepped = append(stepped, g.Request.Method+" "+g.FullPath())
		if g.GetHeader("X-Step-Up") != "ok" {
			g.AbortWithStatus(http.StatusTeapot)
			return
		}
		g.Next()
	}
	admin := r.Group("/api/v1/admin/claudex")
	admin.Use(func(g *gin.Context) {
		g.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: 1})
		g.Next()
	})
	c.RegisterAdminRoutes(admin, stepUp)

	for _, rt := range []struct{ method, path string }{
		{http.MethodPut, "/api/v1/admin/claudex/provisioning"},
		{http.MethodPost, "/api/v1/admin/claudex/devices/1/revoke"},
		{http.MethodPost, "/api/v1/admin/claudex/users/1/devices/revoke-all"},
		{http.MethodPut, "/api/v1/admin/claudex/users/1/device-limit"},
		{http.MethodDelete, "/api/v1/admin/claudex/users/1/device-limit"},
	} {
		require.Equal(t, http.StatusTeapot, call(r, rt.method, rt.path, nil, `{}`).Code, rt.path)
	}
	require.Len(t, stepped, 5)
	for _, rt := range []string{"/api/v1/admin/claudex/provisioning", "/api/v1/admin/claudex/devices", "/api/v1/admin/claudex/users/1/device-limit"} {
		require.NotEqual(t, http.StatusTeapot, call(r, http.MethodGet, rt, nil, "").Code, rt)
	}
	require.Len(t, stepped, 5, "reads skip step-up")

	ok := map[string]string{"X-Step-Up": "ok"}
	rec := call(r, http.MethodGet, "/api/v1/admin/claudex/provisioning", nil, "")
	require.Equal(t, http.StatusOK, rec.Code)
	var got Provisioning
	require.NoError(t, json.Unmarshal(decode(t, rec).Data, &got))
	require.Equal(t, 5, got.MaxDevicesPerUser)

	rec = call(r, http.MethodPut, "/api/v1/admin/claudex/provisioning", ok, `{"strategy":"nope"}`)
	require.Equal(t, http.StatusBadRequest, rec.Code)
	e := decode(t, rec)
	require.Equal(t, "CLAUDEX_PROVISIONING_INVALID", e.Reason)
	require.Equal(t, "strategy", e.Metadata["field"])

	rec = call(r, http.MethodPut, "/api/v1/admin/claudex/provisioning", ok,
		`{"max_devices_per_user":8,"user_api_keys_enabled":true,"key_defaults":{"quota_usd":20,"expires_in_days":90}}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.NoError(t, json.Unmarshal(decode(t, rec).Data, &got))
	require.Equal(t, 8, got.MaxDevicesPerUser)
	require.True(t, got.UserAPIKeysEnabled)
	require.True(t, got.Enabled, "fields left out keep their value")
	require.Equal(t, 90, *got.KeyDefaults.ExpiresInDays)
	stored, err := repo.GetValue(context.Background(), SettingKey)
	require.NoError(t, err)
	require.Contains(t, stored, `"max_devices_per_user":8`)

	// Naming a group needs the database to check it exists.
	rec = call(r, http.MethodPut, "/api/v1/admin/claudex/provisioning", ok, `{"default_group_id":3}`)
	require.Equal(t, http.StatusServiceUnavailable, rec.Code)

	rec = call(r, http.MethodPut, "/api/v1/admin/claudex/users/abc/device-limit", ok, `{"max_devices":3}`)
	require.Equal(t, http.StatusBadRequest, rec.Code)
	require.Equal(t, "CLAUDEX_USER_NOT_FOUND", decode(t, rec).Reason)
}

func TestAllowUserAPIKeyCreate(t *testing.T) {
	ctx := context.Background()
	c := newTestComponent(core.Deps{SettingRepo: newMemSettings()})
	require.NoError(t, c.AllowUserAPIKeyCreate(ctx, 1, true), "administrators may always create keys")
	err := c.AllowUserAPIKeyCreate(ctx, 1, false)
	require.Equal(t, "CLAUDEX_USER_API_KEYS_DISABLED", infraerrors.Reason(err))

	on := newTestComponent(core.Deps{SettingRepo: newMemSettings(SettingKey, `{"user_api_keys_enabled":true}`)})
	require.NoError(t, on.AllowUserAPIKeyCreate(ctx, 1, false))
}

// ---- signup hook ----

type fakeGroupRepo struct {
	service.GroupRepository
	groups map[int64]*service.Group
}

func (f fakeGroupRepo) GetByID(_ context.Context, id int64) (*service.Group, error) {
	if g, ok := f.groups[id]; ok {
		return g, nil
	}
	return nil, service.ErrGroupNotFound
}

type fakeUserRepo struct {
	service.UserRepository
	users map[int64]*service.User
}

func (f fakeUserRepo) GetByID(_ context.Context, id int64) (*service.User, error) {
	if u, ok := f.users[id]; ok {
		cp := *u
		return &cp, nil
	}
	return nil, service.ErrUserNotFound
}

type fakeAdmin struct {
	service.AdminService
	updates []service.UpdateUserInput
}

func (f *fakeAdmin) UpdateUser(_ context.Context, _ int64, in *service.UpdateUserInput) (*service.User, error) {
	f.updates = append(f.updates, *in)
	return &service.User{}, nil
}

func TestOnSignupGrantsOnlyAnExclusiveStandardDefaultGroup(t *testing.T) {
	ctx := context.Background()
	groups := fakeGroupRepo{groups: map[int64]*service.Group{
		3: {ID: 3, Status: service.StatusActive, SubscriptionType: service.SubscriptionTypeStandard, IsExclusive: true},
		4: {ID: 4, Status: service.StatusActive, SubscriptionType: service.SubscriptionTypeStandard},
		5: {ID: 5, Status: service.StatusActive, SubscriptionType: service.SubscriptionTypeSubscription, IsExclusive: true},
	}}
	users := fakeUserRepo{users: map[int64]*service.User{
		10: {ID: 10, AllowedGroups: []int64{1}},
		11: {ID: 11, AllowedGroups: []int64{3}},
	}}
	run := func(settings string, userID int64) []service.UpdateUserInput {
		admin := &fakeAdmin{}
		c := newTestComponent(core.Deps{SettingRepo: newMemSettings(SettingKey, settings), GroupRepo: groups, UserRepo: users, Admin: admin})
		require.NoError(t, c.OnSignup(ctx, userID))
		return admin.updates
	}
	updates := run(`{"default_group_id":3,"on_signup":{"grant_default_group":true}}`, 10)
	require.Len(t, updates, 1)
	require.Equal(t, []int64{1, 3}, *updates[0].AllowedGroups)
	require.Empty(t, updates[0].Status, "nothing else changes")

	require.Empty(t, run(`{"default_group_id":3,"on_signup":{"grant_default_group":true}}`, 11), "idempotent")
	require.Empty(t, run(`{"default_group_id":3}`, 10), "off by default")
	require.Empty(t, run(`{"enabled":false,"default_group_id":3,"on_signup":{"grant_default_group":true}}`, 10))
	require.Empty(t, run(`{"default_group_id":4,"on_signup":{"grant_default_group":true}}`, 10), "public groups need no grant")
	require.Empty(t, run(`{"default_group_id":5,"on_signup":{"grant_default_group":true}}`, 10), "subscriptions come from upstream")
}

// ---- bootstrap ----

func TestBootstrapSectionsWithoutARegisteredDevice(t *testing.T) {
	c := newTestComponent(core.Deps{})
	require.Equal(t, []string{core.SectionPlan, core.SectionDevice}, c.Sections())
	require.NoError(t, core.CheckSectionOwnership(map[string][]string{c.Name(): c.Sections()}))

	plan := &core.PlanRef{GroupID: 4, GroupName: "pro", Platform: "openai", Protocol: "responses", SubscriptionType: "standard"}
	out, err := c.BootstrapSections(context.Background(), &core.BootstrapContext{UserID: 1, Plan: plan, DeviceID: testDevice})
	require.NoError(t, err)
	require.Equal(t, plan, out[core.SectionPlan])
	raw, err := json.Marshal(out[core.SectionDevice])
	require.NoError(t, err)
	require.JSONEq(t, `{"registered":false,"id":null,"key_group_id":null,"revoked":false,"reprovision_needed":true,"keys":[]}`, string(raw))

	out, err = c.BootstrapSections(context.Background(), &core.BootstrapContext{UserID: 1})
	require.NoError(t, err)
	require.NotContains(t, out, core.SectionPlan, "no plan section when B9 could not resolve one")
	require.Contains(t, out, core.SectionDevice)
}

// ---- cache and storage-less behavior ----

func TestTTLCacheEvictsWhenFull(t *testing.T) {
	c := newTTLCache[int, string](2)
	now := time.Now()
	c.put(1, "old", now.Add(-time.Hour))
	c.put(2, "fresh", now)
	c.put(3, "new", now) // full: the stale entry goes
	_, _, ok := c.get(1, now)
	require.False(t, ok)
	v, age, ok := c.get(2, now.Add(time.Second))
	require.True(t, ok)
	require.Equal(t, "fresh", v)
	require.Equal(t, time.Second, age)
	c.put(4, "x", now) // full of fresh entries: reset
	_, _, ok = c.get(2, now)
	require.False(t, ok)
	_, _, ok = c.get(4, now)
	require.True(t, ok)
	c.delWhere(func(k int) bool { return k == 4 })
	_, _, ok = c.get(4, now)
	require.False(t, ok)
}

func TestWithoutStorageNothingIsRevokedOrManaged(t *testing.T) {
	ctx := context.Background()
	c := newTestComponent(core.Deps{})
	require.NoError(t, c.OnSessionsRevoked(ctx, 1, "revoke_all"), "no devices to sign out")
	require.ErrorIs(t, c.revokeDevice(ctx, revokeTarget{UserID: 1, DeviceID: 1}, ReasonUser), errStorageUnavailable)
	n, err := c.reconcile(ctx)
	require.NoError(t, err)
	require.Zero(t, n)
	c.Start(ctx) // no database: no background work
	_, ok := c.LookupByDeviceID(ctx, 1, testDevice)
	require.False(t, ok)
}

// GET /devices (Settings → Account → Active sessions): every desktop device
// of the user with when its current sign-in began, the calling device
// marked; the web device is never listed.
func TestMyDevicesListsSignInTimesAndTheCurrentDevice(t *testing.T) {
	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	defer func() { _ = db.Close() }()
	c := newTestComponent(core.Deps{DB: db})
	r := userRouter(t, c, 7)

	created := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	signedIn := time.Date(2026, 10, 12, 8, 30, 0, 0, time.UTC)
	seen := time.Date(2026, 10, 12, 9, 0, 0, 0, time.UTC)
	revoked := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	cols := append(append([]string{}, deviceCols[:16]...), "signed_in_at")
	row := func(id int64, hash, name, platform string, lastSeen, revokedAt driver.Value, signed time.Time) []driver.Value {
		return []driver.Value{id, int64(7), hash, id + 100, int64(4), "fam", name, platform, "arm64", "1.3.2", lastSeen, "1.1.1.1", revokedAt,
			"", created, created, signed}
	}
	mock.ExpectQuery(`COALESCE\(signed_in_at, created_at\)\s+FROM claudex_devices WHERE user_id`).WithArgs(int64(7)).
		WillReturnRows(sqlmock.NewRows(cols).
			AddRow(row(51, DeviceHash(testDevice), "Mac", "darwin", seen, nil, signedIn)...).
			AddRow(row(52, strings.Repeat("b", 64), "Work PC", "win32", nil, revoked, created)...).
			AddRow(row(53, strings.Repeat("c", 64), "Claudex on the web", PlatformWeb, nil, nil, created)...))
	mock.ExpectQuery(`FROM claudex_user_device_limits`).WithArgs(int64(7)).WillReturnRows(sqlmock.NewRows([]string{"max_devices"}))

	rec := call(r, http.MethodGet, "/api/v1/claudex/devices", map[string]string{core.HeaderDeviceID: testDevice}, "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
	var list struct {
		Items []MyDeviceJSON `json:"items"`
		Limit int            `json:"limit"`
	}
	require.NoError(t, json.Unmarshal(decode(t, rec).Data, &list))
	require.Len(t, list.Items, 2, "the web device is left out")
	require.Equal(t, DefaultMaxDevices, list.Limit)

	mac, pc := list.Items[0], list.Items[1]
	require.Equal(t, "Brisbane", mac.LocationInfo.City)
	require.Equal(t, "Queensland", mac.LocationInfo.Region)
	require.Equal(t, "Australia", mac.LocationInfo.Country)
	require.Equal(t, int64(51), mac.ID)
	require.True(t, mac.Current)
	require.False(t, mac.Revoked)
	require.True(t, signedIn.Equal(mac.SignedInAt), "a new sign-in, not the first registration")
	require.True(t, created.Equal(mac.CreatedAt))
	require.NotNil(t, mac.LastSeenAt)
	require.True(t, seen.Equal(*mac.LastSeenAt))

	require.Equal(t, "Work PC", pc.DeviceName)
	require.False(t, pc.Current)
	require.True(t, pc.Revoked)
	require.True(t, created.Equal(pc.SignedInAt))
	require.Nil(t, pc.LastSeenAt)
	require.NoError(t, mock.ExpectationsWereMet())
}
