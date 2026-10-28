//go:build unit

package usage

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/gatewayhook"
	servermiddleware "github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

var statusNow = time.Date(2026, 9, 26, 2, 30, 0, 0, time.UTC)

const testDeviceID = "7f1c2a4e-9b3d-4c5e-8f60-1a2b3c4d5e6f"

// fakePlans resolves every user to group 4 unless the requested group is 4
// or 6 (the groups user 11 may use).
type fakePlans struct{ requested []*int64 }

func (p *fakePlans) ResolvePlan(_ context.Context, userID int64, requested *int64) (*core.PlanRef, error) {
	p.requested = append(p.requested, requested)
	if userID == 13 {
		return nil, core.ErrNoPlan
	}
	sub := int64(77)
	plan := &core.PlanRef{GroupID: 4, GroupName: "claudex-pro", Platform: "openai", SubscriptionType: service.SubscriptionTypeSubscription, SubscriptionID: &sub, Subscribed: true}
	if requested != nil && *requested == 6 {
		plan = &core.PlanRef{GroupID: 6, GroupName: "pay-as-you-go", Platform: "anthropic", SubscriptionType: service.SubscriptionTypeStandard}
	}
	return plan, nil
}

type fakeDevices struct{}

func (fakeDevices) LookupByAPIKey(context.Context, int64) (*core.DeviceRef, bool) { return nil, false }
func (fakeDevices) LookupByDeviceID(_ context.Context, userID int64, raw string) (*core.DeviceRef, bool) {
	if userID == 11 && raw == testDeviceID {
		return &gatewayhook.DeviceRef{ID: 51, UserID: 11, APIKeyID: 501}, true
	}
	return nil, false
}

func statusSetup(t *testing.T) (*Component, *fakeStore, *fakePlans) {
	t.Helper()
	fs := newFakeStore()
	fs.addRule(Rule{ID: 3, GroupID: ptr(int64(4)), Kind: KindSession, Label: DefaultSessionLabel, WindowSeconds: 18000, LimitUSD: 5, Enabled: true, ShowInClient: true})
	fs.addRule(Rule{ID: 5, GroupID: ptr(int64(4)), Kind: KindModels, Label: "Opus", ModelPatterns: []string{"claude-opus-*"}, WindowSeconds: 604800, LimitUSD: 20, Enabled: true, ShowInClient: true, SortOrder: 10})
	fs.addRule(Rule{ID: 7, GroupID: ptr(int64(4)), Kind: KindModels, Label: "Hidden", ModelPatterns: []string{"x-*"}, WindowSeconds: 604800, LimitUSD: 20, Enabled: true, ShowInClient: false})
	fs.addRule(Rule{ID: 8, GroupID: ptr(int64(6)), Kind: KindSession, Label: DefaultSessionLabel, WindowSeconds: 18000, LimitUSD: 1, Enabled: true, ShowInClient: true})
	fs.setCounter(3, 11, time.Date(2026, 9, 26, 1, 0, 0, 0, time.UTC), time.Date(2026, 9, 26, 6, 0, 0, 0, time.UTC), 1.2)
	fs.setCounter(5, 11, time.Date(2026, 9, 10, 0, 0, 0, 0, time.UTC), time.Date(2026, 9, 17, 0, 0, 0, 0, time.UTC), 25) // ended
	c, _ := newTestComponent(fs, statusNow)
	plans := &fakePlans{}
	c.env.Peers = core.Peers{Plans: plans, Devices: fakeDevices{}}
	week, day := 100.0, 20.0
	c.sources = statusSources{
		subscriptionProgress: func(_ context.Context, id int64) (*service.SubscriptionProgress, error) {
			require.Equal(t, int64(77), id)
			return &service.SubscriptionProgress{ID: 77, GroupName: "claudex-pro",
				Weekly: &service.UsageWindowProgress{LimitUSD: 100, UsedUSD: 30, WindowStart: time.Date(2026, 9, 22, 0, 0, 0, 0, time.UTC), ResetsAt: time.Date(2026, 9, 29, 0, 0, 0, 0, time.UTC)},
				Daily:  &service.UsageWindowProgress{LimitUSD: 20, UsedUSD: 4, WindowStart: time.Date(2026, 9, 26, 0, 0, 0, 0, time.UTC), ResetsAt: time.Date(2026, 9, 27, 0, 0, 0, 0, time.UTC)},
			}, nil
		},
		group: func(_ context.Context, id int64) (*service.Group, error) {
			return &service.Group{ID: id, WeeklyLimitUSD: &week, DailyLimitUSD: &day}, nil
		},
		apiKey: func(_ context.Context, id int64) (*service.APIKey, error) {
			require.Equal(t, int64(501), id)
			return &service.APIKey{ID: 501, UserID: 11, RateLimit5h: 2}, nil
		},
		rateLimitData: func(context.Context, int64) (*service.APIKeyRateLimitData, error) {
			start := time.Date(2026, 9, 26, 1, 30, 0, 0, time.UTC)
			return &service.APIKeyRateLimitData{Usage5h: 0.5, Window5hStart: &start}, nil
		},
		user: func(_ context.Context, id int64) (*service.User, error) {
			if id == 404 {
				return nil, service.ErrUserNotFound
			}
			return &service.User{ID: id, Balance: 12.34}, nil
		},
	}
	return c, fs, plans
}

func statusRouter(c *Component, userID int64) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	g := r.Group("/api/v1/claudex", func(g *gin.Context) {
		g.Set(string(servermiddleware.ContextKeyUser), servermiddleware.AuthSubject{UserID: userID})
		g.Next()
	})
	c.RegisterUserRoutes(g)
	a := r.Group("/api/v1/admin/claudex", func(g *gin.Context) {
		g.Set(string(servermiddleware.ContextKeyUser), servermiddleware.AuthSubject{UserID: 1})
		g.Next()
	})
	c.RegisterAdminRoutes(a, func(g *gin.Context) { g.Header("X-Step-Up", "checked"); g.Next() })
	return r
}

func getJSON(r http.Handler, path string, header ...string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	for i := 0; i+1 < len(header); i += 2 {
		req.Header.Set(header[i], header[i+1])
	}
	r.ServeHTTP(rec, req)
	return rec
}

// The design 2.6 fixture, with the "…" placeholders filled in.
const statusFixture = `{"code":0,"message":"success","data":{
  "plan":{"group_id":4,"group_name":"claudex-pro","subscription_id":77,"billing_mode":"subscription"},
  "windows":[
    {"id":"rule:3","source":"rule","kind":"session","label":"Current session","window":"5h","window_seconds":18000,
     "used_usd":1.2,"limit_usd":5,"percent":24,"active":true,"window_start":"2026-09-26T01:00:00Z","resets_at":"2026-09-26T06:00:00Z",
     "models":null,"exceeded":false},
    {"id":"subscription:weekly","source":"subscription","kind":"all_models","label":"All models","window":"7d","window_seconds":604800,
     "used_usd":30,"limit_usd":100,"percent":30,"active":true,"window_start":"2026-09-22T00:00:00Z","resets_at":"2026-09-29T00:00:00Z",
     "models":null,"exceeded":false},
    {"id":"rule:5","source":"rule","kind":"models","label":"Opus","window":"7d","window_seconds":604800,
     "used_usd":0,"limit_usd":20,"percent":0,"active":false,"window_start":null,"resets_at":null,
     "models":["claude-opus-*"],"exceeded":false},
    {"id":"subscription:daily","source":"subscription","kind":"daily","label":"Daily","window":"1d","window_seconds":86400,
     "used_usd":4,"limit_usd":20,"percent":20,"active":true,"window_start":"2026-09-26T00:00:00Z","resets_at":"2026-09-27T00:00:00Z","models":null,"exceeded":false},
    {"id":"key:5h","source":"key","kind":"key","label":"This device · 5 hours","window":"5h","window_seconds":18000,
     "used_usd":0.5,"limit_usd":2,"percent":25,"active":true,"window_start":"2026-09-26T01:30:00Z","resets_at":"2026-09-26T06:30:00Z","models":null,"exceeded":false}],
  "balance":{"balance_usd":12.34},
  "blocked":{"blocked":false,"window_id":null,"reason":null,"resets_at":null},
  "updated_at":"2026-09-26T02:30:00Z"}}`

func TestUsageStatusMatchesTheDesignFixture(t *testing.T) {
	c, _, _ := statusSetup(t)
	r := statusRouter(c, 11)
	rec := getJSON(r, "/api/v1/claudex/usage-status", core.HeaderDeviceID, testDeviceID)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
	require.JSONEq(t, statusFixture, rec.Body.String())

	// Without the device header there are no key windows.
	rec = getJSON(r, "/api/v1/claudex/usage-status")
	var body struct {
		Data Status `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Len(t, body.Data.Windows, 4)
	require.Equal(t, "subscription:daily", body.Data.Windows[3].ID)
}

func TestUsageStatusOrdersKindsAndSortOrder(t *testing.T) {
	c, fs, _ := statusSetup(t)
	fs.addRule(Rule{ID: 9, Kind: KindAllModels, Label: "Every group", WindowSeconds: 604800, LimitUSD: 50, Enabled: true, ShowInClient: true})
	fs.addRule(Rule{ID: 10, GroupID: ptr(int64(4)), Kind: KindModels, Label: "Sonnet", ModelPatterns: []string{"claude-sonnet-*"}, WindowSeconds: 604800, LimitUSD: 30, Enabled: true, ShowInClient: true, SortOrder: 5})
	fs.addRule(Rule{ID: 11, GroupID: ptr(int64(4)), Kind: KindSession, Label: "Burst", WindowSeconds: 3600, LimitUSD: 1, Enabled: true, ShowInClient: true, SortOrder: -1})
	rec := getJSON(statusRouter(c, 11), "/api/v1/claudex/usage-status", core.HeaderDeviceID, testDeviceID)
	var body struct {
		Data Status `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	var ids []string
	for _, w := range body.Data.Windows {
		ids = append(ids, w.ID)
	}
	require.Equal(t, []string{"rule:11", "rule:3", "subscription:weekly", "rule:9", "rule:10", "rule:5", "subscription:daily", "key:5h"}, ids,
		"session rules, subscription weekly, all-models rules, model rules by sort order, daily/monthly, key windows; hidden rules and other groups' rules left out")
}

func TestUsageStatusBlockedIsTheExceededWindowThatResetsLast(t *testing.T) {
	c, fs, _ := statusSetup(t)
	fs.setCounter(3, 11, time.Date(2026, 9, 26, 1, 0, 0, 0, time.UTC), time.Date(2026, 9, 26, 6, 0, 0, 0, time.UTC), 5.5)
	fs.setCounter(5, 11, time.Date(2026, 9, 25, 0, 0, 0, 0, time.UTC), time.Date(2026, 10, 2, 0, 0, 0, 0, time.UTC), 20)
	st, err := c.status(context.Background(), 11, nil, "")
	require.NoError(t, err)
	require.True(t, st.Windows[0].Exceeded)
	require.Equal(t, 100, st.Windows[0].Percent)
	require.True(t, st.Blocked.Blocked)
	require.Equal(t, "rule:5", *st.Blocked.WindowID)
	require.Equal(t, "RULE_LIMIT", *st.Blocked.Reason)
	require.True(t, st.Blocked.ResetsAt.Equal(time.Date(2026, 10, 2, 0, 0, 0, 0, time.UTC)))

	// A full subscription window names the upstream reason.
	c.sources.subscriptionProgress = func(context.Context, int64) (*service.SubscriptionProgress, error) {
		return &service.SubscriptionProgress{Weekly: &service.UsageWindowProgress{LimitUSD: 100, UsedUSD: 100,
			WindowStart: time.Date(2026, 9, 22, 0, 0, 0, 0, time.UTC), ResetsAt: time.Date(2026, 10, 6, 0, 0, 0, 0, time.UTC)}}, nil
	}
	st, err = c.status(context.Background(), 11, nil, "")
	require.NoError(t, err)
	require.Equal(t, "subscription:weekly", *st.Blocked.WindowID)
	require.Equal(t, "SUBSCRIPTION_WEEKLY_LIMIT", *st.Blocked.Reason)
}

func TestUsageStatusShowsInactiveSubscriptionWindows(t *testing.T) {
	c, _, _ := statusSetup(t)
	c.sources.subscriptionProgress = func(context.Context, int64) (*service.SubscriptionProgress, error) {
		// Weekly not started yet; daily started but its reset time passed.
		return &service.SubscriptionProgress{Daily: &service.UsageWindowProgress{LimitUSD: 20, UsedUSD: 19,
			WindowStart: time.Date(2026, 9, 24, 0, 0, 0, 0, time.UTC), ResetsAt: time.Date(2026, 9, 25, 0, 0, 0, 0, time.UTC)}}, nil
	}
	st, err := c.status(context.Background(), 11, nil, "")
	require.NoError(t, err)
	byID := map[string]StatusWindow{}
	for _, w := range st.Windows {
		byID[w.ID] = w
	}
	require.False(t, byID["subscription:weekly"].Active)
	require.Equal(t, 100.0, byID["subscription:weekly"].LimitUSD)
	require.Nil(t, byID["subscription:weekly"].ResetsAt)
	require.False(t, byID["subscription:daily"].Active)
	require.Equal(t, 0.0, byID["subscription:daily"].UsedUSD)
}

func TestUsageStatusResolvesTheRequestedGroupThroughThePlan(t *testing.T) {
	c, _, plans := statusSetup(t)
	r := statusRouter(c, 11)

	// A group the user may not use is ignored: the resolver answers the plan
	// group, and that group's rules are shown.
	rec := getJSON(r, "/api/v1/claudex/usage-status?group_id=99")
	require.Equal(t, http.StatusOK, rec.Code)
	var body struct {
		Data Status `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Equal(t, int64(4), body.Data.Plan.GroupID)
	require.Equal(t, int64(99), *plans.requested[len(plans.requested)-1])

	rec = getJSON(r, "/api/v1/claudex/usage-status?group_id=6")
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Equal(t, int64(6), body.Data.Plan.GroupID)
	require.Equal(t, "balance", body.Data.Plan.BillingMode)
	require.Len(t, body.Data.Windows, 1)
	require.Equal(t, "rule:8", body.Data.Windows[0].ID)

	rec = getJSON(r, "/api/v1/claudex/usage-status?group_id=abc")
	require.Equal(t, http.StatusOK, rec.Code)
	require.Nil(t, plans.requested[len(plans.requested)-1], "a malformed group_id means the plan group")

	rec = getJSON(statusRouter(c, 13), "/api/v1/claudex/usage-status")
	require.Equal(t, http.StatusForbidden, rec.Code)
	require.Contains(t, rec.Body.String(), "CLAUDEX_NO_PLAN")
}

func TestAdminSeesAUsersStatus(t *testing.T) {
	c, _, _ := statusSetup(t)
	r := statusRouter(c, 11)
	rec := getJSON(r, "/api/v1/admin/claudex/users/11/usage-status")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var body struct {
		Data Status `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Equal(t, "rule:3", body.Data.Windows[0].ID)
	require.Len(t, body.Data.Windows, 4, "no device header, no key windows")

	rec = getJSON(r, "/api/v1/admin/claudex/users/404/usage-status")
	require.Equal(t, http.StatusBadRequest, rec.Code)
	require.Contains(t, rec.Body.String(), "CLAUDEX_USER_NOT_FOUND")
	rec = getJSON(r, "/api/v1/admin/claudex/users/x/usage-status")
	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestBootstrapUsageSection(t *testing.T) {
	c, fs, _ := statusSetup(t)
	require.Equal(t, []string{core.SectionUsage}, c.Sections())
	got, err := c.BootstrapSections(context.Background(), &core.BootstrapContext{UserID: 11, Plan: &core.PlanRef{GroupID: 4}})
	require.NoError(t, err)
	require.Equal(t, map[string]any{"usage": map[string]any{"rules_enabled": true, "has_session_window": true}}, got)

	got, err = c.BootstrapSections(context.Background(), &core.BootstrapContext{UserID: 11, Plan: &core.PlanRef{GroupID: 12}})
	require.NoError(t, err)
	require.Equal(t, map[string]any{"usage": map[string]any{"rules_enabled": false, "has_session_window": false}}, got)

	// A hidden session rule limits requests but shows no row.
	fs.addRule(Rule{ID: 20, GroupID: ptr(int64(12)), Kind: KindSession, Label: DefaultSessionLabel, WindowSeconds: 18000, LimitUSD: 1, Enabled: true})
	c.rules.invalidate()
	got, err = c.BootstrapSections(context.Background(), &core.BootstrapContext{UserID: 11, Plan: &core.PlanRef{GroupID: 12}})
	require.NoError(t, err)
	require.Equal(t, map[string]any{"usage": map[string]any{"rules_enabled": true, "has_session_window": false}}, got)

	got, err = c.BootstrapSections(context.Background(), &core.BootstrapContext{UserID: 11})
	require.NoError(t, err)
	require.Equal(t, map[string]any{"usage": map[string]any{"rules_enabled": false, "has_session_window": false}}, got)
}
