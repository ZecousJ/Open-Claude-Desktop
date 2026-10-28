package bootstrap

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/gatewayhook"
	"github.com/Wei-Shaw/sub2api/internal/config"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/timezone"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// --- fakes ---------------------------------------------------------------

// contributor is a fake component that adds bootstrap sections.
type contributor struct {
	name     string
	sections []string
	fn       func(ctx context.Context, bc *core.BootstrapContext) (map[string]any, error)
}

func (f *contributor) Name() string       { return f.name }
func (f *contributor) Sections() []string { return f.sections }
func (f *contributor) BootstrapSections(ctx context.Context, bc *core.BootstrapContext) (map[string]any, error) {
	return f.fn(ctx, bc)
}

// routedContributor also serves user routes (like a finished B package).
type routedContributor struct{ *contributor }

func (routedContributor) RegisterUserRoutes(*gin.RouterGroup) {}

// component is a fake installed component without sections.
type component struct{ name string }

func (f component) Name() string { return f.name }

type userRoutes struct{ component }

func (userRoutes) RegisterUserRoutes(*gin.RouterGroup) {}

type userAndPublicRoutes struct{ userRoutes }

func (userAndPublicRoutes) RegisterPublicRoutes(*gin.RouterGroup) {}

type describer struct{ component }

func (describer) Describe(*gin.Context, gatewayhook.Refusal) *gatewayhook.RefusalDetail { return nil }

// plans is a fake plan resolver.
type plans struct {
	fn        func(ctx context.Context, userID int64, requested *int64) (*core.PlanRef, error)
	requested atomic.Pointer[int64]
	calls     atomic.Int32
}

func (p *plans) ResolvePlan(ctx context.Context, userID int64, requested *int64) (*core.PlanRef, error) {
	p.calls.Add(1)
	if requested != nil {
		v := *requested
		p.requested.Store(&v)
	} else {
		p.requested.Store(nil)
	}
	return p.fn(ctx, userID, requested)
}

// settings is an in-memory service.SettingRepository.
type settings struct {
	mu     sync.Mutex
	values map[string]string
	block  chan struct{} // when set, GetValue waits for it (ignoring ctx)
}

func newSettings(kv map[string]string) *settings {
	values := map[string]string{}
	for k, v := range kv {
		values[k] = v
	}
	return &settings{values: values}
}

func (s *settings) GetValue(_ context.Context, key string) (string, error) {
	if s.block != nil {
		<-s.block
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.values[key]
	if !ok {
		return "", service.ErrSettingNotFound
	}
	return v, nil
}
func (s *settings) Get(ctx context.Context, key string) (*service.Setting, error) {
	v, err := s.GetValue(ctx, key)
	if err != nil {
		return nil, err
	}
	return &service.Setting{Key: key, Value: v}, nil
}
func (s *settings) Set(_ context.Context, key, value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.values[key] = value
	return nil
}
func (s *settings) GetMultiple(ctx context.Context, keys []string) (map[string]string, error) {
	out := map[string]string{}
	for _, k := range keys {
		if v, err := s.GetValue(ctx, k); err == nil {
			out[k] = v
		}
	}
	return out, nil
}
func (s *settings) SetMultiple(ctx context.Context, kv map[string]string) error {
	for k, v := range kv {
		_ = s.Set(ctx, k, v)
	}
	return nil
}
func (s *settings) GetAll(context.Context) (map[string]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := map[string]string{}
	for k, v := range s.values {
		out[k] = v
	}
	return out, nil
}
func (s *settings) Delete(_ context.Context, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.values, key)
	return nil
}

// --- helpers -------------------------------------------------------------

var testNow = time.Date(2026, 9, 26, 2, 30, 0, 0, time.UTC)

const (
	testUserID   = int64(42)
	testSession  = "sid-family-1"
	testDeviceID = "6f1c2a4e-9b0d-4c1e-8a57-2f3b9d0c7e11"
)

func testPlan() *core.PlanRef {
	sub := int64(77)
	expires := time.Date(2026, 10, 25, 0, 0, 0, 0, time.UTC)
	return &core.PlanRef{GroupID: 4, GroupName: "claudex-pro", Platform: "openai", Protocol: "responses",
		SubscriptionType: "subscription", SubscriptionID: &sub, ExpiresAt: &expires, Subscribed: true}
}

// newEnv builds an environment the way ProvideModule binds it: Components
// lists every feature, Contributors those adding sections.
func newEnv(resolver core.PlanResolver, features ...core.Feature) *core.Env {
	env := &core.Env{Now: func() time.Time { return testNow }}
	env.Peers.Plans = resolver
	env.BuildInfo = service.BuildInfo{Version: "0.2.8+claudex.1", BuildType: "source"}
	for _, f := range features {
		env.Components = append(env.Components, f)
		if bc, ok := f.(core.BootstrapContributor); ok {
			env.Contributors = append(env.Contributors, bc)
		}
	}
	return env
}

// withSettings wires the upstream setting and payment services to repo.
func withSettings(env *core.Env, repo *settings) *core.Env {
	env.SettingRepo = repo
	env.SettingService = service.NewSettingService(repo, &config.Config{})
	env.PaymentConfig = service.NewPaymentConfigService(nil, repo, nil)
	return env
}

func newComponent(env *core.Env, timeout time.Duration) *Component {
	c := New(env)
	if timeout > 0 {
		c.timeout = timeout
	}
	return c
}

// router serves the component's routes behind a stand-in for the user chain
// that signs in testUserID with testSession (no subject when anonymous).
func router(c *Component, anonymous bool) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	g := r.Group("/api/v1/claudex")
	g.Use(func(ctx *gin.Context) {
		if !anonymous {
			ctx.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: testUserID})
			ctx.Set(middleware.ContextKeySessionID, testSession)
		}
		ctx.Next()
	})
	c.RegisterUserRoutes(g)
	return r
}

func request(r http.Handler, target string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, target, nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

// document decodes the envelope data of a 200 answer.
func document(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var env struct {
		Code int            `json:"code"`
		Data map[string]any `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &env))
	require.Equal(t, 0, env.Code)
	return env.Data
}

// object returns v as a JSON object.
func object(t *testing.T, v any) map[string]any {
	t.Helper()
	m, ok := v.(map[string]any)
	require.True(t, ok, "%v is not an object", v)
	return m
}

func jsonValue(t *testing.T, v any) any {
	t.Helper()
	raw, err := json.Marshal(v)
	require.NoError(t, err)
	var out any
	require.NoError(t, json.Unmarshal(raw, &out))
	return out
}

func static(sections map[string]any) func(context.Context, *core.BootstrapContext) (map[string]any, error) {
	return func(context.Context, *core.BootstrapContext) (map[string]any, error) { return sections, nil }
}

// fullSet returns contributors for every section, like the finished B
// packages; devices builds plan from bc.Plan.
func fullSet() []core.Feature {
	devices := routedContributor{&contributor{name: core.NameDevices, sections: []string{core.SectionPlan, core.SectionDevice},
		fn: func(_ context.Context, bc *core.BootstrapContext) (map[string]any, error) {
			out := map[string]any{core.SectionDevice: map[string]any{"registered": true, "id": 51, "key_group_id": 4, "revoked": false, "reprovision_needed": false}}
			if bc.Plan != nil {
				out[core.SectionPlan] = bc.Plan
			}
			return out, nil
		}}}
	return []core.Feature{
		&contributor{name: core.NameRelease, sections: []string{core.SectionRelease}, fn: static(map[string]any{
			core.SectionRelease: map[string]any{"channel": "stable", "latest_version": "1.4.0", "minimum_version": "1.2.0", "state": "available", "enforced": false},
		})},
		routedContributor{&contributor{name: core.NamePolicy, sections: []string{core.SectionPolicy}, fn: static(map[string]any{
			core.SectionPolicy: map[string]any{"revision": 17, "group_id": 4, "permission_modes": []string{"auto", "manual", "acceptEdits", "plan"}},
		})}},
		routedContributor{&contributor{name: core.NameCatalog, sections: []string{core.SectionModels}, fn: static(map[string]any{
			core.SectionModels: map[string]any{"group_id": 4, "default_model": "gpt-5.5", "items": []any{}},
		})}},
		devices,
		routedContributor{&contributor{name: core.NameUsage, sections: []string{core.SectionUsage}, fn: static(map[string]any{
			core.SectionUsage: map[string]any{"rules_enabled": true, "has_session_window": true},
		})}},
		describer{component{core.NameRefusal}},
		&contributor{name: core.NameVoice, sections: []string{core.SectionVoice}, fn: static(map[string]any{
			core.SectionVoice: json.RawMessage(`{"transcription":{"enabled":true,"model":"gpt-4o-transcribe","max_bytes":26214400,"max_seconds":600},` +
				`"speech":{"enabled":false,"model":null,"voices":[],"default_voice":null,"max_input_chars":0},` +
				`"available":{"transcription":true,"speech":false}}`),
		})},
		routedContributor{&contributor{name: core.NameFeedback, sections: []string{core.SectionFeedback}, fn: static(map[string]any{
			core.SectionFeedback: map[string]any{"diagnostics": map[string]any{"enabled": false}, "feedback": map[string]any{"enabled": false, "allow_conversation_excerpt": false}},
		})}},
		userAndPublicRoutes{userRoutes{component{core.NamePayment}}},
	}
}

func okPlans() *plans {
	return &plans{fn: func(context.Context, int64, *int64) (*core.PlanRef, error) { return testPlan(), nil }}
}

// --- tests ---------------------------------------------------------------

// Every contributor's sections end up in one document next to B9's own keys,
// in the shape of the design 2.10 example.
func TestBootstrapMergesEveryContributor(t *testing.T) {
	repo := newSettings(map[string]string{service.SettingKeySiteName: "Claudex", service.SettingPaymentEnabled: "true"})
	env := withSettings(newEnv(okPlans(), fullSet()...), repo)
	rec := request(router(newComponent(env, 0), false), "/api/v1/claudex/bootstrap", nil)
	data := document(t, rec)

	require.Equal(t, map[string]any{
		"schema_version": float64(1),
		"generated_at":   "2026-09-26T02:30:00Z",
		"server":         map[string]any{"site_name": "Claudex", "version": "0.2.8+claudex.1", "timezone": timezone.Name()},
		"plan": map[string]any{"group_id": float64(4), "group_name": "claudex-pro", "platform": "openai", "protocol": "responses",
			"subscription_type": "subscription", "subscription_id": float64(77), "expires_at": "2026-10-25T00:00:00Z", "subscribed": true},
		"device":  map[string]any{"registered": true, "id": float64(51), "key_group_id": float64(4), "revoked": false, "reprovision_needed": false},
		"policy":  map[string]any{"revision": float64(17), "group_id": float64(4), "permission_modes": []any{"auto", "manual", "acceptEdits", "plan"}},
		"models":  map[string]any{"group_id": float64(4), "default_model": "gpt-5.5", "items": []any{}},
		"release": map[string]any{"channel": "stable", "latest_version": "1.4.0", "minimum_version": "1.2.0", "state": "available", "enforced": false},
		"voice": map[string]any{
			"transcription": map[string]any{"enabled": true, "model": "gpt-4o-transcribe", "max_bytes": float64(26214400), "max_seconds": float64(600)},
			"speech":        map[string]any{"enabled": false, "model": nil, "voices": []any{}, "default_voice": nil, "max_input_chars": float64(0)},
			"available":     map[string]any{"transcription": true, "speech": false},
		},
		"usage":    map[string]any{"rules_enabled": true, "has_session_window": true},
		"feedback": map[string]any{"diagnostics": map[string]any{"enabled": false}, "feedback": map[string]any{"enabled": false, "allow_conversation_excerpt": false}},
		"features": map[string]any{"device_keys": true, "usage_status": true, "structured_refusals": true, "model_catalog": true,
			"voice_transcription": true, "voice_speech": false, "payment": true, "desktop_checkout": true, "redeem": true,
			"diagnostics": false, "feedback": false, "self_delete": false, "announcements": true},
		"errors": []any{},
	}, data)
	require.Equal(t, "private, no-cache", rec.Header().Get("Cache-Control"))
	require.NotEmpty(t, rec.Header().Get("ETag"))
}

// Contributors run at the same time: each one waits until all of them have
// started, which only finishes when they run in parallel.
func TestBootstrapCallsContributorsInParallel(t *testing.T) {
	owners := []struct{ name, section string }{
		{core.NamePolicy, core.SectionPolicy}, {core.NameCatalog, core.SectionModels}, {core.NameRelease, core.SectionRelease},
		{core.NameVoice, core.SectionVoice}, {core.NameUsage, core.SectionUsage}, {core.NameFeedback, core.SectionFeedback},
	}
	var started sync.WaitGroup
	started.Add(len(owners))
	var features []core.Feature
	for _, o := range owners {
		features = append(features, &contributor{name: o.name, sections: []string{o.section},
			fn: func(ctx context.Context, _ *core.BootstrapContext) (map[string]any, error) {
				started.Done()
				all := make(chan struct{})
				go func() { started.Wait(); close(all) }()
				select {
				case <-all:
					return map[string]any{o.section: map[string]any{"ok": true}}, nil
				case <-ctx.Done():
					return nil, ctx.Err()
				}
			}})
	}
	c := newComponent(newEnv(okPlans(), features...), time.Second)
	begin := time.Now()
	data := document(t, request(router(c, false), "/api/v1/claudex/bootstrap", nil))
	require.Less(t, time.Since(begin), 900*time.Millisecond)
	require.Empty(t, data["errors"])
	for _, o := range owners {
		require.Equal(t, map[string]any{"ok": true}, data[o.section], o.section)
	}
}

// A contributor that hangs, fails, panics or returns something that is not
// JSON loses only its own sections; the others are served, the request ends
// within the budget and failure details (error text) never reach the client.
func TestBootstrapIsolatesFailingContributors(t *testing.T) {
	hang := make(chan struct{})
	t.Cleanup(func() { close(hang) })
	features := []core.Feature{
		routedContributor{&contributor{name: core.NameDevices, sections: []string{core.SectionPlan, core.SectionDevice},
			fn: static(map[string]any{core.SectionPlan: testPlan(), core.SectionDevice: map[string]any{"registered": false}})}},
		// Ignores its context and never returns in time.
		&contributor{name: core.NameRelease, sections: []string{core.SectionRelease},
			fn: func(context.Context, *core.BootstrapContext) (map[string]any, error) {
				<-hang
				return map[string]any{core.SectionRelease: "late"}, nil
			}},
		// Honours its context and gives up with ctx.Err().
		&contributor{name: core.NameUsage, sections: []string{core.SectionUsage},
			fn: func(ctx context.Context, _ *core.BootstrapContext) (map[string]any, error) {
				<-ctx.Done()
				return nil, ctx.Err()
			}},
		&contributor{name: core.NamePolicy, sections: []string{core.SectionPolicy},
			fn: func(context.Context, *core.BootstrapContext) (map[string]any, error) { panic("policy exploded") }},
		&contributor{name: core.NameCatalog, sections: []string{core.SectionModels},
			fn: func(context.Context, *core.BootstrapContext) (map[string]any, error) {
				return nil, infraerrors.NotFound("CLAUDEX_MODEL_META_NOT_FOUND", "no catalog")
			}},
		&contributor{name: core.NameFeedback, sections: []string{core.SectionFeedback},
			fn: func(context.Context, *core.BootstrapContext) (map[string]any, error) {
				return nil, errors.New("pq: password authentication failed for user secret-db-user")
			}},
		// Returns its own section fine, plus keys it does not own.
		&contributor{name: core.NameVoice, sections: []string{core.SectionVoice, core.SectionPolicy},
			fn: static(map[string]any{
				core.SectionVoice:  map[string]any{"available": map[string]any{"transcription": true, "speech": true}},
				core.SectionPolicy: map[string]any{"forged": true},
				KeyServer:          map[string]any{"site_name": "forged"},
				KeyFeatures:        map[string]any{"self_delete": true},
			})},
	}
	c := newComponent(newEnv(okPlans(), features...), 150*time.Millisecond)
	begin := time.Now()
	rec := request(router(c, false), "/api/v1/claudex/bootstrap", nil)
	require.Less(t, time.Since(begin), time.Second, "a hanging contributor must not hold the request")
	data := document(t, rec)

	require.Equal(t, []any{
		map[string]any{"section": "feedback", "code": "CLAUDEX_SECTION_FAILED"},
		map[string]any{"section": "models", "code": "CLAUDEX_MODEL_META_NOT_FOUND"},
		map[string]any{"section": "policy", "code": "CLAUDEX_SECTION_FAILED"},
		map[string]any{"section": "release", "code": "CLAUDEX_SECTION_TIMEOUT"},
		map[string]any{"section": "usage", "code": "CLAUDEX_SECTION_TIMEOUT"},
	}, data["errors"])
	for _, missing := range []string{"release", "usage", "policy", "models", "feedback"} {
		require.NotContains(t, data, missing)
	}
	require.Equal(t, jsonValue(t, testPlan()), data["plan"])
	require.Equal(t, map[string]any{"registered": false}, data["device"])
	require.Equal(t, map[string]any{"available": map[string]any{"transcription": true, "speech": true}}, data["voice"])
	require.Equal(t, fallbackSiteName, object(t, data["server"])["site_name"], "a contributor cannot overwrite B9's keys")
	flags := object(t, data["features"])
	require.Equal(t, false, flags["self_delete"])
	require.Equal(t, true, flags["voice_speech"])
	require.NotContains(t, rec.Body.String(), "secret-db-user")
	require.NotContains(t, rec.Body.String(), "exploded")
	require.NotContains(t, rec.Body.String(), "forged")
}

// Values that cannot be encoded fail only their section, a nil section is
// simply absent, and a contributor whose Sections panics adds nothing.
func TestBootstrapDropsUnencodableAndNilSections(t *testing.T) {
	features := []core.Feature{
		&contributor{name: core.NameUsage, sections: []string{core.SectionUsage},
			fn: static(map[string]any{core.SectionUsage: map[string]any{"bad": func() {}}})},
		&contributor{name: core.NameRelease, sections: []string{core.SectionRelease},
			fn: static(map[string]any{core.SectionRelease: (*core.ReleaseState)(nil)})},
		&panickySections{contributor{name: core.NameVoice, sections: nil,
			fn: static(map[string]any{core.SectionVoice: map[string]any{"ok": true}})}},
		// A panicking MarshalJSON must not take the process down.
		&contributor{name: core.NameCatalog, sections: []string{core.SectionModels},
			fn: static(map[string]any{core.SectionModels: panicJSON{}})},
		&contributor{name: core.NameFeedback, sections: []string{core.SectionFeedback},
			fn: static(map[string]any{core.SectionFeedback: json.RawMessage(`{"diagnostics":`)})},
		&contributor{name: core.NamePolicy, sections: []string{core.SectionPolicy},
			fn: static(map[string]any{core.SectionPolicy: map[string]any{"revision": 1}})},
		// A panicking MarshalJSON in one section keeps the contributor's other section.
		routedContributor{&contributor{name: core.NameDevices, sections: []string{core.SectionPlan, core.SectionDevice},
			fn: static(map[string]any{core.SectionPlan: testPlan(), core.SectionDevice: panicJSON{}})}},
	}
	data := document(t, request(router(newComponent(newEnv(okPlans(), features...), 0), false), "/api/v1/claudex/bootstrap", nil))
	require.Equal(t, []any{
		map[string]any{"section": "device", "code": "CLAUDEX_SECTION_FAILED"},
		map[string]any{"section": "feedback", "code": "CLAUDEX_SECTION_FAILED"},
		map[string]any{"section": "models", "code": "CLAUDEX_SECTION_FAILED"},
		map[string]any{"section": "usage", "code": "CLAUDEX_SECTION_FAILED"},
	}, data["errors"])
	for _, missing := range []string{"usage", "release", "voice", "models", "feedback", "device"} {
		require.NotContains(t, data, missing)
	}
	require.Equal(t, map[string]any{"revision": float64(1)}, data["policy"])
	require.Equal(t, jsonValue(t, testPlan()), data["plan"])
}

type panickySections struct{ contributor }

func (*panickySections) Sections() []string { panic("sections") }

type panicJSON struct{}

func (panicJSON) MarshalJSON() ([]byte, error) { panic("marshal") }

// The plan is resolved once, before the contributors run, from ?group_id=;
// its failure is reported as the plan section's error.
func TestBootstrapResolvesThePlanFirst(t *testing.T) {
	var seen []*core.PlanRef
	var noPlan []bool
	var mu sync.Mutex
	recordPlan := routedContributor{&contributor{name: core.NameDevices, sections: []string{core.SectionPlan, core.SectionDevice},
		fn: func(_ context.Context, bc *core.BootstrapContext) (map[string]any, error) {
			mu.Lock()
			seen = append(seen, bc.Plan)
			noPlan = append(noPlan, bc.NoPlan)
			mu.Unlock()
			out := map[string]any{core.SectionDevice: map[string]any{"registered": false}}
			if bc.Plan != nil {
				out[core.SectionPlan] = bc.Plan
			}
			return out, nil
		}}}

	t.Run("resolved", func(t *testing.T) {
		p := okPlans()
		r := router(newComponent(newEnv(p, recordPlan), 0), false)
		for target, want := range map[string]*int64{
			"/api/v1/claudex/bootstrap?group_id=4": ptr(4), "/api/v1/claudex/bootstrap": nil,
			"/api/v1/claudex/bootstrap?group_id=abc": nil, "/api/v1/claudex/bootstrap?group_id=-3": nil,
			"/api/v1/claudex/bootstrap?group_id=0": nil,
		} {
			data := document(t, request(r, target, nil))
			require.Equal(t, want, p.requested.Load(), target)
			require.Equal(t, jsonValue(t, testPlan()), data["plan"], target)
			require.Empty(t, data["errors"], target)
		}
		require.EqualValues(t, 5, p.calls.Load())
		require.Equal(t, testPlan(), seen[len(seen)-1])
		require.False(t, noPlan[len(noPlan)-1])
	})

	t.Run("no plan", func(t *testing.T) {
		p := &plans{fn: func(context.Context, int64, *int64) (*core.PlanRef, error) { return nil, core.ErrNoPlan }}
		data := document(t, request(router(newComponent(newEnv(p, recordPlan), 0), false), "/api/v1/claudex/bootstrap", nil))
		require.NotContains(t, data, "plan")
		require.Equal(t, map[string]any{"registered": false}, data["device"])
		require.Equal(t, []any{map[string]any{"section": "plan", "code": "CLAUDEX_NO_PLAN"}}, data["errors"])
		require.Nil(t, seen[len(seen)-1], "contributors see a nil plan")
		require.True(t, noPlan[len(noPlan)-1], "and know the account has no plan group (balance only)")
	})

	t.Run("resolver hangs", func(t *testing.T) {
		p := &plans{fn: func(context.Context, int64, *int64) (*core.PlanRef, error) { select {} }}
		begin := time.Now()
		data := document(t, request(router(newComponent(newEnv(p, recordPlan), 100*time.Millisecond), false), "/api/v1/claudex/bootstrap", nil))
		require.Less(t, time.Since(begin), time.Second)
		require.Equal(t, []any{map[string]any{"section": "plan", "code": "CLAUDEX_SECTION_TIMEOUT"}}, data["errors"])
		require.False(t, noPlan[len(noPlan)-1], "a lookup that failed is not an account without a plan")
	})

	t.Run("resolver breaks its contract", func(t *testing.T) {
		for name, fn := range map[string]func(context.Context, int64, *int64) (*core.PlanRef, error){
			"nil,nil": func(context.Context, int64, *int64) (*core.PlanRef, error) { return nil, nil },
			"panic":   func(context.Context, int64, *int64) (*core.PlanRef, error) { panic("boom") },
		} {
			data := document(t, request(router(newComponent(newEnv(&plans{fn: fn}, recordPlan), 0), false), "/api/v1/claudex/bootstrap", nil))
			require.Equal(t, []any{map[string]any{"section": "plan", "code": "CLAUDEX_SECTION_FAILED"}}, data["errors"], name)
		}
		// No resolver at all (a module without B4).
		data := document(t, request(router(newComponent(newEnv(nil, recordPlan), 0), false), "/api/v1/claudex/bootstrap", nil))
		require.Equal(t, []any{map[string]any{"section": "plan", "code": "CLAUDEX_SECTION_FAILED"}}, data["errors"])
	})

	t.Run("owner still returns a plan", func(t *testing.T) {
		p := &plans{fn: func(context.Context, int64, *int64) (*core.PlanRef, error) { return nil, core.ErrNoPlan }}
		own := routedContributor{&contributor{name: core.NameDevices, sections: []string{core.SectionPlan},
			fn: static(map[string]any{core.SectionPlan: map[string]any{"group_id": 9}})}}
		data := document(t, request(router(newComponent(newEnv(p, own), 0), false), "/api/v1/claudex/bootstrap", nil))
		require.Equal(t, map[string]any{"group_id": float64(9)}, data["plan"])
		require.Empty(t, data["errors"], "no error for a section that is present")
	})

	t.Run("contributor failure keeps the resolver's reason", func(t *testing.T) {
		p := &plans{fn: func(context.Context, int64, *int64) (*core.PlanRef, error) { return nil, core.ErrNoPlan }}
		broken := routedContributor{&contributor{name: core.NameDevices, sections: []string{core.SectionPlan, core.SectionDevice},
			fn: func(context.Context, *core.BootstrapContext) (map[string]any, error) { return nil, errors.New("db") }}}
		data := document(t, request(router(newComponent(newEnv(p, broken), 0), false), "/api/v1/claudex/bootstrap", nil))
		require.Equal(t, []any{
			map[string]any{"section": "device", "code": "CLAUDEX_SECTION_FAILED"},
			map[string]any{"section": "plan", "code": "CLAUDEX_NO_PLAN"},
		}, data["errors"])
	})
}

func ptr(v int64) *int64 { return &v }

// The X-Claudex-* headers, the user and the JWT session id reach every
// contributor, each with its own copy of the context.
func TestBootstrapPassesTheClientContext(t *testing.T) {
	var mu sync.Mutex
	got := map[string]core.BootstrapContext{}
	mutated := make(chan struct{})
	record := func(bc *core.BootstrapContext) core.BootstrapContext {
		copied := *bc
		if bc.Plan != nil {
			plan := *bc.Plan
			copied.Plan = &plan
		}
		return copied
	}
	// policy changes its context first; catalog records its own afterwards
	// and must not see the change.
	policy := &contributor{name: core.NamePolicy, sections: []string{core.SectionPolicy},
		fn: func(_ context.Context, bc *core.BootstrapContext) (map[string]any, error) {
			mu.Lock()
			got[core.NamePolicy] = record(bc)
			mu.Unlock()
			bc.Platform = "win32"
			bc.SessionID = "other"
			bc.Plan.GroupID = 999
			close(mutated)
			return nil, nil
		}}
	catalog := &contributor{name: core.NameCatalog, sections: []string{core.SectionModels},
		fn: func(ctx context.Context, bc *core.BootstrapContext) (map[string]any, error) {
			select {
			case <-mutated:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
			mu.Lock()
			got[core.NameCatalog] = record(bc)
			mu.Unlock()
			return nil, nil
		}}
	c := newComponent(newEnv(okPlans(), policy, catalog), 0)
	data := document(t, request(router(c, false), "/api/v1/claudex/bootstrap", map[string]string{
		core.HeaderPlatform: "darwin", core.HeaderArch: "arm64", core.HeaderVersion: "1.3.2", core.HeaderDeviceID: testDeviceID,
	}))
	require.Empty(t, data["errors"])
	want := core.BootstrapContext{UserID: testUserID, Plan: testPlan(), Platform: "darwin", Arch: "arm64", AppVersion: "1.3.2",
		DeviceID: testDeviceID, SessionID: testSession}
	require.Equal(t, want, got[core.NamePolicy])
	require.Equal(t, want, got[core.NameCatalog], "each contributor gets its own copy")
}

// generated_at changes on every request but does not change the ETag, so an
// unchanged bootstrap answers 304; a changed section gives a new ETag.
func TestBootstrapETagIgnoresGeneratedAt(t *testing.T) {
	var tick atomic.Int64
	models := map[string]any{"default_model": "gpt-5.5"}
	var mu sync.Mutex
	env := newEnv(okPlans(), fullSet()[0], &contributor{name: core.NameCatalog, sections: []string{core.SectionModels},
		fn: func(context.Context, *core.BootstrapContext) (map[string]any, error) {
			mu.Lock()
			defer mu.Unlock()
			return map[string]any{core.SectionModels: map[string]any{"default_model": models["default_model"]}}, nil
		}})
	env.Now = func() time.Time { return testNow.Add(time.Duration(tick.Add(1)) * time.Minute) }
	r := router(newComponent(env, 0), false)

	first := request(r, "/api/v1/claudex/bootstrap", nil)
	firstData := document(t, first)
	etag := first.Header().Get("ETag")
	require.Regexp(t, `^W/"[A-Za-z0-9_-]{22}"$`, etag)

	second := request(r, "/api/v1/claudex/bootstrap", nil)
	require.NotEqual(t, firstData["generated_at"], document(t, second)["generated_at"])
	require.Equal(t, etag, second.Header().Get("ETag"))

	notModified := request(r, "/api/v1/claudex/bootstrap", map[string]string{"If-None-Match": etag})
	require.Equal(t, http.StatusNotModified, notModified.Code)
	require.Empty(t, notModified.Body.String())
	require.Equal(t, etag, notModified.Header().Get("ETag"))

	mu.Lock()
	models["default_model"] = "gpt-5.5-mini"
	mu.Unlock()
	changed := request(r, "/api/v1/claudex/bootstrap", map[string]string{"If-None-Match": etag})
	require.Equal(t, http.StatusOK, changed.Code)
	require.NotEqual(t, etag, changed.Header().Get("ETag"))

	// The document depends on the user and the client headers.
	require.Contains(t, changed.Header().Get("Vary"), "Authorization")
	require.Contains(t, changed.Header().Get("Vary"), core.HeaderDeviceID)
}

func TestBootstrapFeatures(t *testing.T) {
	all := fullSet()
	cases := []struct {
		name     string
		features []core.Feature
		settings map[string]string
		cfg      *config.Config
		want     Features
	}{
		{
			name: "nothing installed",
			want: Features{Redeem: true, Announcements: true},
		},
		{
			name:     "every component, payment on",
			features: all,
			settings: map[string]string{service.SettingPaymentEnabled: "true"},
			want: Features{DeviceKeys: true, UsageStatus: true, StructuredRefusals: true, ModelCatalog: true, VoiceTranscription: true,
				Payment: true, DesktopCheckout: true, Redeem: true, Announcements: true},
		},
		{
			name:     "payment off turns desktop checkout off",
			features: all,
			settings: map[string]string{service.SettingPaymentEnabled: "false"},
			want: Features{DeviceKeys: true, UsageStatus: true, StructuredRefusals: true, ModelCatalog: true, VoiceTranscription: true,
				Redeem: true, Announcements: true},
		},
		{
			name: "B0 stubs serve nothing",
			features: []core.Feature{component{core.NameDevices}, component{core.NameUsage}, component{core.NameRefusal},
				component{core.NameCatalog}, component{core.NamePayment}},
			settings: map[string]string{service.SettingPaymentEnabled: "true"},
			want:     Features{Payment: true, Redeem: true, Announcements: true},
		},
		{
			name:     "checkout needs the public page API too",
			features: []core.Feature{userRoutes{component{core.NamePayment}}},
			settings: map[string]string{service.SettingPaymentEnabled: "true"},
			want:     Features{Payment: true, Redeem: true, Announcements: true},
		},
		{
			name:     "provisioning turned off",
			features: []core.Feature{userRoutes{component{core.NameDevices}}},
			settings: map[string]string{provisioningKey: `{"enabled":false,"max_devices_per_user":5}`},
			want:     Features{Redeem: true, Announcements: true},
		},
		{
			name:     "provisioning setting without enabled keeps the default",
			features: []core.Feature{userRoutes{component{core.NameDevices}}},
			settings: map[string]string{provisioningKey: `{"max_devices_per_user":3}`},
			want:     Features{DeviceKeys: true, Redeem: true, Announcements: true},
		},
		{
			name:     "unreadable provisioning setting keeps the default",
			features: []core.Feature{userRoutes{component{core.NameDevices}}},
			settings: map[string]string{provisioningKey: `{not json`},
			want:     Features{DeviceKeys: true, Redeem: true, Announcements: true},
		},
		{
			name: "voice and feedback follow their sections",
			features: []core.Feature{
				&contributor{name: core.NameVoice, sections: []string{core.SectionVoice}, fn: static(map[string]any{
					core.SectionVoice: map[string]any{"available": map[string]any{"transcription": false, "speech": true}}})},
				&contributor{name: core.NameFeedback, sections: []string{core.SectionFeedback}, fn: static(map[string]any{
					core.SectionFeedback: map[string]any{"diagnostics": map[string]any{"enabled": true}, "feedback": map[string]any{"enabled": true}}})},
			},
			want: Features{VoiceSpeech: true, Diagnostics: true, Feedback: true, Redeem: true, Announcements: true},
		},
		{
			name: "failed voice and feedback sections turn their features off",
			features: []core.Feature{
				&contributor{name: core.NameVoice, sections: []string{core.SectionVoice},
					fn: func(context.Context, *core.BootstrapContext) (map[string]any, error) { return nil, errors.New("x") }},
				&contributor{name: core.NameFeedback, sections: []string{core.SectionFeedback},
					fn: static(map[string]any{core.SectionFeedback: "not an object"})},
			},
			want: Features{Redeem: true, Announcements: true},
		},
		{
			name: "simple mode has no redeem",
			cfg:  &config.Config{RunMode: config.RunModeSimple},
			want: Features{Announcements: true},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			env := withSettings(newEnv(okPlans(), tc.features...), newSettings(tc.settings))
			env.Config = tc.cfg
			data := document(t, request(router(newComponent(env, 0), false), "/api/v1/claudex/bootstrap", nil))
			require.Equal(t, jsonValue(t, tc.want), data["features"])
		})
	}
}

func TestBootstrapServerSection(t *testing.T) {
	// Site name from the upstream setting, build version, server time zone.
	env := withSettings(newEnv(okPlans()), newSettings(map[string]string{service.SettingKeySiteName: "Acme AI"}))
	data := document(t, request(router(newComponent(env, 0), false), "/api/v1/claudex/bootstrap", nil))
	require.Equal(t, map[string]any{"site_name": "Acme AI", "version": "0.2.8+claudex.1", "timezone": timezone.Name()}, data["server"])
	require.Equal(t, float64(SchemaVersion), data["schema_version"])

	// No settings service (tests, broken wiring): upstream default name.
	data = document(t, request(router(newComponent(newEnv(okPlans()), 0), false), "/api/v1/claudex/bootstrap", nil))
	require.Equal(t, fallbackSiteName, object(t, data["server"])["site_name"])

	// A settings store that hangs ignoring its context: defaults within the budget.
	repo := newSettings(map[string]string{service.SettingKeySiteName: "Acme AI", service.SettingPaymentEnabled: "true",
		provisioningKey: `{"enabled":false}`})
	repo.block = make(chan struct{})
	t.Cleanup(func() { close(repo.block) })
	env = withSettings(newEnv(okPlans(), userRoutes{component{core.NameDevices}}), repo)
	begin := time.Now()
	data = document(t, request(router(newComponent(env, 100*time.Millisecond), false), "/api/v1/claudex/bootstrap", nil))
	require.Less(t, time.Since(begin), time.Second)
	require.Equal(t, fallbackSiteName, object(t, data["server"])["site_name"])
	features := object(t, data["features"])
	require.Equal(t, false, features["payment"], "payment is off when its switch cannot be read")
	require.Equal(t, true, features["device_keys"], "provisioning falls back to its default")
}

func TestBootstrapNeedsASignedInUser(t *testing.T) {
	rec := request(router(newComponent(newEnv(okPlans()), 0), true), "/api/v1/claudex/bootstrap", nil)
	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestBootstrapIsNotAContributor(t *testing.T) {
	var c any = New(&core.Env{})
	_, isContributor := c.(core.BootstrapContributor)
	require.False(t, isContributor, "B9 builds its own keys and declares no section")
	_, ownsSettings := c.(core.SettingsOwner)
	require.False(t, ownsSettings, "claudex_provisioning belongs to B4")
	require.Equal(t, core.NameBootstrap, New(nil).Name())
}

func TestSectionCode(t *testing.T) {
	require.Equal(t, CodeSectionTimeout, sectionCode(errTimeout))
	require.Equal(t, CodeSectionTimeout, sectionCode(context.DeadlineExceeded))
	require.Equal(t, CodeSectionTimeout, sectionCode(context.Canceled))
	require.Equal(t, CodeSectionFailed, sectionCode(errors.New("boom")))
	require.Equal(t, CodeSectionFailed, sectionCode(nil))
	require.Equal(t, "CLAUDEX_NO_PLAN", sectionCode(core.ErrNoPlan))
	require.Equal(t, CodeSectionFailed, sectionCode(infraerrors.BadRequest("lower case", "x")))
	require.Equal(t, CodeSectionFailed, sectionCode(infraerrors.BadRequest("", "x")))
	require.Equal(t, "CLAUDEX_X", sectionCode(errors.Join(errors.New("wrapped"), infraerrors.Conflict("CLAUDEX_X", "x"))))
	require.True(t, strings.HasPrefix(CodeSectionFailed, "CLAUDEX_"))
}
