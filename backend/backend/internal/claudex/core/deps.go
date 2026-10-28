// Package core is the frozen contract between the Claudex module and its
// components (design 1.4). Components live in their own packages under
// internal/claudex/<name>, import core (plus gatewayhook and claudexhook) and
// never the parent package internal/claudex, internal/handler or
// internal/repository.
package core

import (
	"context"
	"database/sql"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/gatewayhook"
	claudexhook "github.com/Wei-Shaw/sub2api/internal/claudex/hook"
	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
)

// Deps lists the upstream services Claudex components may use; Wire fills
// every field (wire.Struct(new(Deps), "*") in internal/claudex). Tests may
// leave fields nil: a component's New must not touch its dependencies.
//
// Write upstream tables (users, groups, api_keys, subscriptions, ...) only
// through these services so the upstream caches stay consistent; DB is for
// the Claudex tables (claudex_*).
type Deps struct {
	SettingRepo    service.SettingRepository
	SettingService *service.SettingService
	AuthService    *service.AuthService
	UpdateService  *service.UpdateService
	BuildInfo      service.BuildInfo
	DB             *sql.DB
	Redis          *redis.Client
	Config         *config.Config
	APIKeys        *service.APIKeyService
	Subscriptions  *service.SubscriptionService
	Admin          service.AdminService
	Users          *service.UserService
	UserRepo       service.UserRepository
	GroupRepo      service.GroupRepository
	Channels       *service.ChannelService
	// Gateway lists a group's models as /v1/models does (the catalog).
	Gateway       *service.GatewayService
	BillingCache  *service.BillingCacheService
	PaymentConfig *service.PaymentConfigService
	Payment       *service.PaymentService
	// Email sends mail with the upstream SMTP settings (LOGIN email codes).
	Email *service.EmailService
}

// Env is what a component sees: the dependencies, a clock and its peers.
// ProvideModule binds Peers, Components and Contributors after every
// component is constructed, so use them only while serving a request or in
// Start, never in New.
type Env struct {
	Deps
	Now   func() time.Time
	Peers Peers
	// Components lists every installed component in install order.
	Components []Feature
	// Contributors lists the components that add bootstrap sections; B9
	// calls them for GET /api/v1/claudex/bootstrap.
	Contributors []BootstrapContributor

	heavy gin.HandlerFunc
}

// Installed reports whether a component with this name is installed.
func (e *Env) Installed(name string) bool {
	if e == nil {
		return false
	}
	for _, f := range e.Components {
		if f.Name() == name {
			return true
		}
	}
	return false
}

// Heavy is the upstream panel limiter for expensive per-user reads (the one
// /api/v1/usage uses), for routes such as bootstrap and usage-status:
//
//	g.GET("/usage-status", c.env.Heavy(), c.get)
//
// The module sets the limiter before any RegisterUserRoutes runs; without
// one (tests) the middleware passes through.
func (e *Env) Heavy() gin.HandlerFunc {
	return func(c *gin.Context) {
		if e != nil && e.heavy != nil {
			e.heavy(c)
			return
		}
		c.Next()
	}
}

// SetHeavy installs the limiter returned by Heavy (module only).
func (e *Env) SetHeavy(h gin.HandlerFunc) {
	if e != nil {
		e.heavy = h
	}
}

// Peers are the interfaces one component implements for the others. Each has
// exactly one implementation (the module panics at startup otherwise).
type Peers struct {
	Plans    PlanResolver    // B4 (devices)
	Devices  DeviceDirectory // B4 (devices)
	Sessions SessionGuard    // B4 (devices)
	Release  ReleaseInfo     // B1 (release)
}

// PlanRef is the plan group the server picked for a user.
type PlanRef struct {
	GroupID          int64      `json:"group_id"`
	GroupName        string     `json:"group_name"`
	Platform         string     `json:"platform"`          // openai | anthropic | gemini | grok | ...
	Protocol         string     `json:"protocol"`          // responses | chat (ProtocolForPlatform)
	SubscriptionType string     `json:"subscription_type"` // subscription | standard
	SubscriptionID   *int64     `json:"subscription_id"`
	ExpiresAt        *time.Time `json:"expires_at"`
	Subscribed       bool       `json:"subscribed"`
}

// PlanResolver picks the plan group of a user.
type PlanResolver interface {
	// ResolvePlan uses requested when the user may use that group, otherwise
	// the claudex_provisioning strategy. It only returns active, undeleted
	// groups and answers ErrNoPlan when none fits. Every user endpoint that
	// takes a group_id resolves it here first.
	ResolvePlan(ctx context.Context, userID int64, requested *int64) (*PlanRef, error)
}

// DeviceRef identifies a Claudex device (defined in gatewayhook to avoid an
// import cycle through the middleware package).
type DeviceRef = gatewayhook.DeviceRef

// DeviceDirectory looks up Claudex devices.
type DeviceDirectory interface {
	// LookupByAPIKey is cached per process for 5 s (including misses); a
	// write on this node invalidates the cache.
	LookupByAPIKey(ctx context.Context, apiKeyID int64) (*DeviceRef, bool)
	LookupByDeviceID(ctx context.Context, userID int64, rawDeviceID string) (*DeviceRef, bool)
}

// SessionGuard answers the JWT revocation check (H9b).
type SessionGuard interface {
	// Check returns Revoked when issuedAt <= floor(last revoke-all of the
	// user) or the session id was revoked, CheckFailed when the state cannot
	// be read and nothing is cached (the request then fails with 503).
	Check(ctx context.Context, userID int64, issuedAt time.Time, sessionID string) claudexhook.SessionState
}

// ReleaseInfo evaluates the desktop release for a client (B1). The module
// merges the result into GET /api/v1/claudex/release and B1 adds it to the
// bootstrap release section.
type ReleaseInfo interface {
	Evaluate(ctx context.Context, platform, arch, version string) ReleaseState
}

// Release states.
const (
	ReleaseStateCurrent   = "current"
	ReleaseStateAvailable = "available"
	ReleaseStateRequired  = "required"
	ReleaseStateUnknown   = "unknown"
)

type DesktopUpdaterConfig struct {
	CheckIntervalTicks           *float64 `json:"check_interval_ticks,omitempty"`
	StagedPeekMinIntervalMinutes *float64 `json:"staged_peek_min_interval_minutes,omitempty"`
}

// ReleaseState is the release evaluation for one client.
type ReleaseState struct {
	DesktopUpdaterConfig                                 *DesktopUpdaterConfig
	Channel, LatestVersion, MinimumVersion, State        string // State: current|available|required|unknown
	Enforced                                             bool   // = enforce_minimum_on_gateway
	DownloadURL, SHA256, ReleaseNotesURL, ReleaseNotesMD string
	PublishedAt                                          *time.Time
	// UI is the desktop interface pack (docs/releasing.md), nil
	// when none is published.
	UI *UIPack
	// AppPack is this platform's app files without the installer, nil when
	// none is published.
	AppPack *AppPack
}

// AppPack is a Windows build's app files without its installer: a zip of
// resources/ less the Codex folder, for an install on the same Electron
// Runtime whose Codex files hash to Keep. It installs without running a new
// program, which Smart App Control blocks while the installer is unsigned.
type AppPack struct {
	URL     string `json:"url"`
	SHA256  string `json:"sha256"`
	Runtime string `json:"runtime"`
	Keep    string `json:"keep"`
}

// UIPack is a signed desktop interface pack: Bridge is the lowest desktop
// bridge level that can run it; the signature travels inside the pack.
type UIPack struct {
	Version string `json:"version"`
	Bridge  int    `json:"bridge"`
	URL     string `json:"url"`
	SHA256  string `json:"sha256"`
}
