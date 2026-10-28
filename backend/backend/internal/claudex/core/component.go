package core

import (
	"context"
	"fmt"
	"sort"

	claudexhook "github.com/Wei-Shaw/sub2api/internal/claudex/hook"

	"github.com/gin-gonic/gin"
)

// Feature is one Claudex component. Name is a stable identifier (lowercase,
// dash separated) listed by GET /api/v1/claudex/capabilities and used to
// check bootstrap section ownership.
//
// ProvideModule type-asserts every component against the optional interfaces
// below and wires whichever it implements, so a component package adds an
// interface by adding methods; it never edits the module.
type Feature interface{ Name() string }

// PublicRouter adds unauthenticated routes under /api/v1/claudex (per-IP
// panel rate limit). Register /<resource>/..., never a top-level wildcard.
type PublicRouter interface{ RegisterPublicRoutes(g *gin.RouterGroup) }

// PageRouter adds public HTML pages under the root path /s (hosted shares,
// R1): per-IP panel rate limit, no JWT, no audit log, no X-Claudex-* header
// check, and never the admin console SPA (the embedded frontend skips /s/).
// Handlers set their own security headers (CSP, X-Frame-Options, robots,
// cache) over the global ones before writing the response. Register
// /:token/..., never a bare wildcard that would swallow /s/_assets/.
type PageRouter interface{ RegisterPageRoutes(g *gin.RouterGroup) }

// UserRouter adds routes under /api/v1/claudex for a signed-in user: JWT
// (with the H9b revocation check), backend-mode guard, panel rate limit,
// audit log, X-Claudex-* header validation.
type UserRouter interface{ RegisterUserRoutes(g *gin.RouterGroup) }

// AdminRouter adds routes under /api/v1/admin/claudex, inside the upstream
// admin group (admin auth, panel rate limit, audit log, AdminComplianceGuard).
// Put stepUp in front of high-risk writes: g.PUT("/policy", stepUp, h.put).
type AdminRouter interface {
	RegisterAdminRoutes(g *gin.RouterGroup, stepUp gin.HandlerFunc)
}

// SignupHooker runs for every self-registered user after the default
// subscriptions (fail-open, idempotent, 10 s budget shared by the module).
type SignupHooker interface {
	OnSignup(ctx context.Context, userID int64) error
}

// SettingsOwner lists the settings keys a component stores (admin overview).
type SettingsOwner interface{ SettingKeys() []string }

// Starter starts background work. ctx is cancelled when the process gets
// SIGINT/SIGTERM. Start must return quickly (spawn goroutines).
type Starter interface{ Start(ctx context.Context) }

// BootstrapContributor adds sections to GET /api/v1/claudex/bootstrap (B9
// calls every contributor in parallel with a 2 s timeout each).
type BootstrapContributor interface {
	// Sections lists the keys BootstrapSections may return. Each must be a
	// Section* constant owned by the component (SectionOwners); the module
	// panics at startup on a foreign or duplicate section.
	Sections() []string
	BootstrapSections(ctx context.Context, bc *BootstrapContext) (map[string]any, error)
}

// WebAppConfig backs the web app zone of the site (internal/web SiteServer;
// the claudex/web component implements it): the admin on/off switch and the
// public config injected into the web app index as window.__CLAUDEX_WEB__.
// WebAppEnabled runs for every web app page request and must be cheap
// (cached); WebAppPublicConfig may only return what pages need before sign-in.
type WebAppConfig interface {
	WebAppEnabled(ctx context.Context) bool
	WebAppPublicConfig(ctx context.Context) (any, error)
}

// BootstrapContext is the request data B9 passes to contributors.
type BootstrapContext struct {
	UserID     int64
	Plan       *PlanRef // resolved by B9 through Peers.Plans; nil when that failed
	Platform   string   // darwin|win32|linux|""
	Arch       string   // arm64|x64|""
	AppVersion string
	Client     string // ClientWeb for the web app (X-Claudex-Client), "" for the desktop app
	DeviceID   string // raw device id from X-Claudex-Device-Id (memory only)
	SessionID  string // JWT sid
	// NoPlan: Plan is nil because the user has no plan group (CLAUDEX_NO_PLAN),
	// not because the lookup failed. Such an account still signs in and runs
	// on its balance alone (owner decision, 2026-10-12).
	NoPlan bool
}

// Bootstrap sections.
const (
	SectionPlan     = "plan"
	SectionDevice   = "device"
	SectionPolicy   = "policy"
	SectionModels   = "models"
	SectionRelease  = "release"
	SectionVoice    = "voice"
	SectionUsage    = "usage"
	SectionFeedback = "feedback"
	SectionMemory   = "memory" // R3
)

// Component names (Feature.Name of the B packages).
const (
	NameWebConsole = "web-console"      // B1 webconsole
	NameRelease    = "client-release"   // B1 release
	NamePolicy     = "client-policy"    // B2 policy
	NameCatalog    = "model-catalog"    // B3 catalog
	NameDevices    = "devices"          // B4 devices
	NameUsage      = "usage-rules"      // B5 usage
	NameRefusal    = "refusals"         // B6 refusal
	NameVoice      = "voice"            // B7 voice
	NameFeedback   = "feedback"         // B8 feedback
	NameBootstrap  = "bootstrap"        // B9 bootstrap
	NamePayment    = "desktop-checkout" // B10 payment

	// Round 2 (B-S installs stubs; the feature packages fill them in).
	NameSharing        = "sharing"          // R1 hosted shares (/s/<token>)
	NameMemory         = "memory"           // R3 per-user memory
	NameWebSearchGuard = "web-search-guard" // R45 web search policy guard

	// Web app (W-SITE installs stubs; the web packages fill them in).
	NameWeb      = "web"       // W-AUTH web sessions, public config, site switch
	NameWebStore = "web-store" // web conversations, projects, uploads
	NameWebHost  = "web-host"  // W-HOST RPC/events/preview proxy to the Web Host
	NameCloud    = "cloud"     // cloud environments (Cowork/Code runners)
	NameGitHub   = "github"    // W-GITHUB GitHub connection for Code on the web

	// LOGIN: sign in with an email code, sign-in page options.
	NameSignIn = "sign-in"

	// Announcements: pop-up notices in the apps and e-mail notices.
	NameAnnouncements = "announcements"
	// Service status: the channels' uptime and incidents.
	NameServiceStatus = "service-status"
	// Failing upstream accounts paused and probed back (owner, 2026-10-10).
	NameAccountGuard = "account-guard"
	// The account step after sign-up: name, birthday, terms (owner, 2026-10-12).
	NameAccountProfile = "account-profile"
)

// SectionOwners maps each bootstrap section to the only component allowed to
// return it (design 1.5). B9 builds server, features, schema_version,
// generated_at and errors itself.
var SectionOwners = map[string]string{
	SectionPlan:     NameDevices,
	SectionDevice:   NameDevices,
	SectionPolicy:   NamePolicy,
	SectionModels:   NameCatalog,
	SectionRelease:  NameRelease,
	SectionVoice:    NameVoice,
	SectionUsage:    NameUsage,
	SectionFeedback: NameFeedback,
	SectionMemory:   NameMemory,
}

// CheckSectionOwnership validates the declared sections of all contributors:
// every section must be known, owned by the declaring component and declared
// once.
func CheckSectionOwnership(declared map[string][]string) error {
	seen := map[string]string{}
	names := make([]string, 0, len(declared))
	for name := range declared {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		for _, section := range declared[name] {
			owner, known := SectionOwners[section]
			if !known {
				return fmt.Errorf("claudex: component %q declares unknown bootstrap section %q", name, section)
			}
			if owner != name {
				return fmt.Errorf("claudex: bootstrap section %q belongs to %q, not %q", section, owner, name)
			}
			if prev, dup := seen[section]; dup {
				return fmt.Errorf("claudex: bootstrap section %q declared twice (%s)", section, prev)
			}
			seen[section] = name
		}
	}
	return nil
}

// Hook providers: components implement these to back the claudexhook
// dispatch functions called from upstream code.

// UsageObserver receives every billed request (H8; B5 counts usage rules).
// It runs synchronously inside the upstream asynchronous billing task with a
// 2 s timeout; it must not block for long.
type UsageObserver interface {
	OnUsageApplied(ctx context.Context, ev claudexhook.UsageEvent)
}

// SessionRevoker handles "log out of all devices" (H9; B4). An error makes
// the endpoint answer 500.
type SessionRevoker interface {
	OnSessionsRevoked(ctx context.Context, userID int64, reason string) error
}

// TokenObserver hears of the token pairs the upstream /api/v1/auth
// endpoints answer and of refresh tokens given back at log out (H16; the
// web component lists the phone apps' sign-ins). At most one component
// implements it; both calls run with a 2 s timeout and must not block.
type TokenObserver interface {
	OnTokensIssued(ctx context.Context, ev claudexhook.TokenIssue)
	OnTokensReturned(ctx context.Context, userID int64, sessionID string)
}

// ManagedKeyOwner tells which API keys are Claudex device keys (H13; B4).
// When the lookup fails (database error) it must fail closed and report
// every id as managed, like the dispatcher does for a panic: /api/v1/keys
// then masks and locks the keys instead of showing a device key's plaintext.
type ManagedKeyOwner interface {
	ManagedAPIKeyIDs(ctx context.Context, userID int64, ids []int64) map[int64]bool
}

// TurnPrechecker checks one Responses WebSocket turn (H14; B5).
type TurnPrechecker interface {
	PrecheckTurn(ctx context.Context, userID, apiKeyID int64, groupID *int64, models []string) error
}

// APIKeyCreateGate decides whether a user may create API keys through the
// upstream /api/v1/keys endpoint (owner decision 17; B4 reads the admin
// switch). Without an implementation the module refuses every non-admin with
// ErrUserAPIKeysDisabled. Device keys are created by B4 through
// service.APIKeyService and never pass this gate.
type APIKeyCreateGate interface {
	AllowUserAPIKeyCreate(ctx context.Context, userID int64, isAdmin bool) error
}
