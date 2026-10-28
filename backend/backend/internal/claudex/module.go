package claudex

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"sort"
	"syscall"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/accountguard"
	"github.com/Wei-Shaw/sub2api/internal/claudex/announce"
	"github.com/Wei-Shaw/sub2api/internal/claudex/bootstrap"
	"github.com/Wei-Shaw/sub2api/internal/claudex/catalog"
	"github.com/Wei-Shaw/sub2api/internal/claudex/cloud"
	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/devices"
	"github.com/Wei-Shaw/sub2api/internal/claudex/feedback"
	"github.com/Wei-Shaw/sub2api/internal/claudex/gatewayhook"
	"github.com/Wei-Shaw/sub2api/internal/claudex/ghconn"
	claudexhook "github.com/Wei-Shaw/sub2api/internal/claudex/hook"
	"github.com/Wei-Shaw/sub2api/internal/claudex/memory"
	"github.com/Wei-Shaw/sub2api/internal/claudex/onboarding"
	"github.com/Wei-Shaw/sub2api/internal/claudex/payment"
	"github.com/Wei-Shaw/sub2api/internal/claudex/policy"
	"github.com/Wei-Shaw/sub2api/internal/claudex/profile"
	"github.com/Wei-Shaw/sub2api/internal/claudex/refusal"
	"github.com/Wei-Shaw/sub2api/internal/claudex/release"
	"github.com/Wei-Shaw/sub2api/internal/claudex/routinemail"
	"github.com/Wei-Shaw/sub2api/internal/claudex/sharing"
	"github.com/Wei-Shaw/sub2api/internal/claudex/signin"
	"github.com/Wei-Shaw/sub2api/internal/claudex/status"
	"github.com/Wei-Shaw/sub2api/internal/claudex/usage"
	"github.com/Wei-Shaw/sub2api/internal/claudex/voice"
	claudexweb "github.com/Wei-Shaw/sub2api/internal/claudex/web"
	webusage "github.com/Wei-Shaw/sub2api/internal/claudex/web/usage"
	"github.com/Wei-Shaw/sub2api/internal/claudex/webconsole"
	"github.com/Wei-Shaw/sub2api/internal/claudex/webhost"
	"github.com/Wei-Shaw/sub2api/internal/claudex/websearchguard"
	"github.com/Wei-Shaw/sub2api/internal/claudex/webstore"
	"github.com/Wei-Shaw/sub2api/internal/pkg/logger"

	"github.com/google/wire"
)

// APIVersion is the version of the /api/v1/claudex contract. Bump it when a
// change would break a released desktop client.
const APIVersion = 1

// Upstream identifies the Sub2API commit this fork is based on.
const (
	UpstreamRepository = "https://github.com/Wei-Shaw/sub2api"
	UpstreamCommit     = "a3eb7ef302961cba716dc78b39b93b60c467db0e"
)

// The contract types live in the leaf package core so components can live in
// their own packages without importing this one; these aliases keep the
// original names.
type (
	// Deps lists the upstream services Claudex components may use (Wire).
	Deps = core.Deps
	// Env is what a component sees: Deps, a clock and its peers.
	Env = core.Env
	// Feature is one Claudex component.
	Feature = core.Feature
	// PublicRouter adds unauthenticated routes under /api/v1/claudex.
	PublicRouter = core.PublicRouter
	// PageRouter adds public HTML pages under /s (hosted shares).
	PageRouter = core.PageRouter
	// UserRouter adds signed-in user routes under /api/v1/claudex.
	UserRouter = core.UserRouter
	// AdminRouter adds routes under /api/v1/admin/claudex.
	AdminRouter = core.AdminRouter
	// SignupHooker runs for every self-registered user.
	SignupHooker = core.SignupHooker
	// SettingsOwner lists a component's settings keys.
	SettingsOwner = core.SettingsOwner
)

// ProviderSet is the Wire provider set for the Claudex module.
var ProviderSet = wire.NewSet(
	wire.Struct(new(Deps), "*"),
	ProvideModule,
)

// Module is the Claudex part of the server.
type Module struct {
	deps     Deps
	env      *core.Env
	features []Feature
}

// ProvideModule builds every component (B1..B10, then the round 2
// components R1 sharing, R3 memory and R45 web search guard, in this fixed
// order),
// binds their peers, checks bootstrap section ownership, installs the
// upstream hooks (claudexhook, gatewayhook), registers the signup hook and
// starts background work. This is the only place components are installed;
// component packages never edit it.
func ProvideModule(deps Deps) *Module {
	// Registrations made by component constructors (body limits) and below
	// belong to this module only.
	gatewayhook.Reset()
	env := &core.Env{Deps: deps, Now: time.Now}
	m := &Module{deps: deps, env: env}
	m.Install(
		webconsole.New(env),
		release.New(env),
		policy.New(env),
		catalog.New(env),
		devices.New(env),
		usage.New(env),
		refusal.New(env),
		voice.New(env),
		feedback.New(env),
		memory.New(env), // R3 (design R3 2.1: after feedback, before bootstrap)
		bootstrap.New(env),
		payment.New(env),
		sharing.New(env),        // R1
		websearchguard.New(env), // R45: registers itself once it has OnRequest
		// Web app (W-SITE stubs, filled in by the web packages).
		claudexweb.New(env),
		webstore.New(env),
		webhost.New(env),
		cloud.New(env),
		ghconn.New(env),       // W-GITHUB: GitHub connection, repositories, clone credential
		webusage.New(env),     // W-KEY: web usage links, runner usage, run capacity (after devices: KeyMarker order)
		signin.New(env),       // LOGIN: sign-in options, sign in with an email code
		announce.New(env),     // announcements: pop-up notices and e-mail notices
		status.New(env),       // service status: channel uptime and incidents
		accountguard.New(env), // failing upstream accounts paused, probed back
		profile.New(env),      // the account step after sign-up: name, birthday, terms
		onboarding.New(env),   // first-run onboarding answers, shown once per account
		routinemail.New(env),  // scheduled-task e-mail to the person who ran it
	)
	if err := m.bind(); err != nil {
		panic(err)
	}
	if err := m.installHooks(); err != nil {
		panic(err)
	}
	if deps.AuthService != nil {
		deps.AuthService.AddSignupHook("claudex", m.runSignupHooks)
	}
	m.start()
	return m
}

// NewModule returns a module without components, peers or hooks (tests).
func NewModule(deps Deps) *Module {
	return &Module{deps: deps, env: &core.Env{Deps: deps, Now: time.Now}}
}

// Install adds components. It panics on a nil component or a duplicate or
// empty name, which is a programming error caught at startup.
func (m *Module) Install(fs ...Feature) {
	for _, f := range fs {
		if f == nil {
			panic("claudex: nil feature")
		}
		name := f.Name()
		if name == "" {
			panic("claudex: feature with empty name")
		}
		for _, existing := range m.features {
			if existing.Name() == name {
				panic(fmt.Sprintf("claudex: feature %q installed twice", name))
			}
		}
		m.features = append(m.features, f)
	}
}

// FeatureNames returns the installed feature names in install order.
func (m *Module) FeatureNames() []string {
	if m == nil {
		return []string{}
	}
	names := make([]string, 0, len(m.features))
	for _, f := range m.features {
		names = append(names, f.Name())
	}
	return names
}

// Env returns the environment shared by the components.
func (m *Module) Env() *core.Env {
	if m == nil {
		return nil
	}
	return m.env
}

// bind sets env.Peers (each peer interface must have exactly one
// implementation) and validates the bootstrap sections.
func (m *Module) bind() error {
	var plans []core.PlanResolver
	var dirs []core.DeviceDirectory
	var guards []core.SessionGuard
	var releases []core.ReleaseInfo
	var contributors []core.BootstrapContributor
	declared := map[string][]string{}
	for _, f := range m.features {
		if p, ok := f.(core.PlanResolver); ok {
			plans = append(plans, p)
		}
		if d, ok := f.(core.DeviceDirectory); ok {
			dirs = append(dirs, d)
		}
		if g, ok := f.(core.SessionGuard); ok {
			guards = append(guards, g)
		}
		if r, ok := f.(core.ReleaseInfo); ok {
			releases = append(releases, r)
		}
		if bc, ok := f.(core.BootstrapContributor); ok {
			declared[f.Name()] = bc.Sections()
			contributors = append(contributors, bc)
		}
	}
	for name, n := range map[string]int{
		"PlanResolver": len(plans), "DeviceDirectory": len(dirs), "SessionGuard": len(guards), "ReleaseInfo": len(releases),
	} {
		if n != 1 {
			return fmt.Errorf("claudex: peer %s needs exactly one implementation, found %d", name, n)
		}
	}
	m.env.Peers = core.Peers{Plans: plans[0], Devices: dirs[0], Sessions: guards[0], Release: releases[0]}
	m.env.Components = append([]Feature(nil), m.features...)
	m.env.Contributors = contributors
	return core.CheckSectionOwnership(declared)
}

// installHooks registers the gateway hooks and installs the claudexhook
// implementations from the components.
func (m *Module) installHooks() error {
	var observers []core.UsageObserver
	var prechecks []core.TurnPrechecker
	var revokers []core.SessionRevoker
	var owners []core.ManagedKeyOwner
	var gates []core.APIKeyCreateGate
	var tokens []core.TokenObserver
	for _, f := range m.features {
		if k, ok := f.(gatewayhook.KeyMarker); ok {
			gatewayhook.RegisterKeyMarker(k)
		}
		if g, ok := f.(gatewayhook.RequestGuard); ok {
			gatewayhook.RegisterRequestGuard(g)
		}
		if d, ok := f.(gatewayhook.RefusalDescriber); ok {
			gatewayhook.RegisterDescriber(d)
		}
		if o, ok := f.(core.UsageObserver); ok {
			observers = append(observers, o)
		}
		if p, ok := f.(core.TurnPrechecker); ok {
			prechecks = append(prechecks, p)
		}
		if r, ok := f.(core.SessionRevoker); ok {
			revokers = append(revokers, r)
		}
		if o, ok := f.(core.ManagedKeyOwner); ok {
			owners = append(owners, o)
		}
		if o, ok := f.(core.TokenObserver); ok {
			tokens = append(tokens, o)
		}
		if g, ok := f.(core.APIKeyCreateGate); ok {
			gates = append(gates, g)
		}
	}
	// SessionRevoker is a chain (devices and the web sessions of W-AUTH both
	// sign out on revoke-all); the other hooks have a single owner.
	for name, n := range map[string]int{"ManagedKeyOwner": len(owners), "APIKeyCreateGate": len(gates), "TokenObserver": len(tokens)} {
		if n > 1 {
			return fmt.Errorf("claudex: hook %s has %d implementations, at most one allowed", name, n)
		}
	}

	hooks := claudexhook.Hooks{
		JWTRevoked: m.env.Peers.Sessions.Check,
		// Owner decision 17: users may not create API keys through
		// /api/v1/keys unless a component (B4) implements the admin switch.
		CreateAPIKey: func(_ context.Context, _ int64, isAdmin bool) error {
			if isAdmin {
				return nil
			}
			return core.ErrUserAPIKeysDisabled
		},
	}
	if len(observers) > 0 {
		hooks.UsageApplied = func(ctx context.Context, ev claudexhook.UsageEvent) {
			for _, o := range observers {
				runUsageObserver(ctx, o, ev)
			}
		}
	}
	if len(prechecks) > 0 {
		hooks.PrecheckTurn = func(ctx context.Context, userID, apiKeyID int64, groupID *int64, models []string) error {
			for _, p := range prechecks {
				if err := p.PrecheckTurn(ctx, userID, apiKeyID, groupID, models); err != nil {
					return err
				}
			}
			return nil
		}
	}
	if len(revokers) == 1 {
		hooks.SessionsRevoked = revokers[0].OnSessionsRevoked
	} else if len(revokers) > 1 {
		// Every revoker runs even when one fails (the endpoint is retried and
		// each revoker is idempotent); the errors are joined.
		hooks.SessionsRevoked = func(ctx context.Context, userID int64, reason string) error {
			var errs []error
			for _, r := range revokers {
				if err := r.OnSessionsRevoked(ctx, userID, reason); err != nil {
					errs = append(errs, err)
				}
			}
			return errors.Join(errs...)
		}
	}
	if len(owners) == 1 {
		hooks.ManagedAPIKeyIDs = owners[0].ManagedAPIKeyIDs
	}
	if len(tokens) == 1 {
		hooks.TokensIssued = tokens[0].OnTokensIssued
		hooks.TokensReturned = tokens[0].OnTokensReturned
	}
	if len(gates) == 1 {
		hooks.CreateAPIKey = gates[0].AllowUserAPIKeyCreate
	}
	claudexhook.Install(hooks)
	return nil
}

func runUsageObserver(ctx context.Context, o core.UsageObserver, ev claudexhook.UsageEvent) {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("claudex: usage observer panicked", "panic", r)
		}
	}()
	o.OnUsageApplied(ctx, ev)
}

// start calls Start on every Starter with a context cancelled on SIGINT or
// SIGTERM (the server's own shutdown signals).
func (m *Module) start() {
	var starters []core.Starter
	for _, f := range m.features {
		if s, ok := f.(core.Starter); ok {
			starters = append(starters, s)
		}
	}
	if len(starters) == 0 {
		return
	}
	ctx, _ := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM) //nolint:govet // lives for the process
	for _, s := range starters {
		s.Start(ctx)
	}
}

func (m *Module) runSignupHooks(ctx context.Context, userID int64) error {
	for _, f := range m.features {
		hooker, ok := f.(SignupHooker)
		if !ok {
			continue
		}
		if err := runFeatureSignupHook(ctx, hooker, userID); err != nil {
			// One failing feature must not keep the others from preparing the user.
			logger.LegacyPrintf("claudex", "[Claudex] signup hook of feature %q failed for user %d (ignored): %v", f.Name(), userID, err)
		}
	}
	return nil
}

func runFeatureSignupHook(ctx context.Context, hooker SignupHooker, userID int64) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("panic: %v", r)
		}
	}()
	return hooker.OnSignup(ctx, userID)
}

// FeatureInfo describes an installed feature on the admin overview.
type FeatureInfo struct {
	Name        string   `json:"name"`
	SettingKeys []string `json:"setting_keys"`
}

func (m *Module) featureInfos() []FeatureInfo {
	infos := make([]FeatureInfo, 0, len(m.features))
	for _, f := range m.features {
		keys := []string{}
		if owner, ok := f.(SettingsOwner); ok {
			keys = append(keys, owner.SettingKeys()...)
			sort.Strings(keys)
		}
		infos = append(infos, FeatureInfo{Name: f.Name(), SettingKeys: keys})
	}
	return infos
}
