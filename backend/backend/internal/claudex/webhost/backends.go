package webhost

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/devices"
	webusage "github.com/Wei-Shaw/sub2api/internal/claudex/web/usage"
	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
	"github.com/Wei-Shaw/sub2api/internal/claudex/webstore"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/service"
)

// Claims are the parts of a user's access token the relay needs: who, which
// web session (JWT sid), when it was issued (the web key's revocation rule)
// and when it expires (a token past its expiry is never handed to a runner).
type Claims struct {
	UserID    int64
	SessionID string
	IssuedAt  time.Time
	ExpiresAt time.Time
}

// UserInfo is what the relay checks about a user outside the JWT routes
// (events socket, previews).
type UserInfo struct {
	Email  string
	Admin  bool
	Active bool
}

// StoreOps serves a runner's store.* requests (webstore.RunnerStore).
type StoreOps interface {
	ServeRunnerOp(ctx context.Context, userID int64, op string, body json.RawMessage) (any, error)
}

// UploadStore keeps browser uploads (the webstore file area).
type UploadStore interface {
	BeginUpload(ctx context.Context, userID int64, name, mime string, size int64) (webstore.FileInfo, error)
	WriteUpload(ctx context.Context, userID int64, id string, offset int64, data []byte) (webstore.FileInfo, error)
	File(ctx context.Context, userID int64, id string) (webstore.FileInfo, error)
	DeleteFile(ctx context.Context, userID int64, id string) error
}

// GitHubOps serves a runner's github.* requests (ghconn.Component).
type GitHubOps interface {
	ServeGitHubOp(ctx context.Context, userID int64, op string, body json.RawMessage) (any, error)
}

// KeyRequest asks for a user's web key on behalf of the runner (key.get).
type KeyRequest struct {
	UserID int64
	Claims Claims // of the user's newest access token
	IP     string
}

// RunSlot is one run holding web capacity (*webusage.Slot).
type RunSlot interface {
	Deadline() time.Time
	Release(ctx context.Context, end webusage.SlotEnd) error
}

// Backends are the services the relay calls. New fills every nil field from
// the environment on first use (the other components, found through
// env.Components); NewWithBackends lets tests and tools replace any of them.
type Backends struct {
	// ParseToken validates an access token (the JWT routes validated it
	// already; the relay reads sid, iat and exp from it).
	ParseToken func(token string) (Claims, error)
	// CheckAccess is the web switch and allowlist (claudex/web).
	CheckAccess func(ctx context.Context, userID int64, email string, isAdmin bool) error
	// RedeemTicket consumes a one-time events ticket (claudex/web).
	RedeemTicket func(ctx context.Context, ticket, tabID string) (int64, error)
	// LookupUser reads a user (events socket, previews, periodic checks).
	LookupUser func(ctx context.Context, userID int64) (UserInfo, error)
	// BackendMode reports the upstream Backend mode switch.
	BackendMode func(ctx context.Context) bool
	// Store serves store.* requests of the runners (webstore).
	Store StoreOps
	// Uploads keeps browser uploads (webstore).
	Uploads UploadStore
	// WebKey answers key.get: {deviceId, registration} (devices, W-KEY).
	WebKey func(ctx context.Context, req KeyRequest) (any, error)
	// AcquireSlot takes run capacity for a turn (web-usage, W-KEY).
	AcquireSlot func(ctx context.Context, req webusage.SlotRequest) (RunSlot, error)
	// GitHub serves github.* requests of the runners (ghconn): a short-lived
	// clone credential for a repository of the user.
	GitHub GitHubOps
	// Runners stores runner tokens and user assignments.
	Runners RunnerDirectory
	// WakeToken mints a short-lived access token for a user a runner serves,
	// for a scheduled task that starts while no page is open (routine.token).
	WakeToken func(ctx context.Context, userID int64) (string, error)
	// Triggers keeps the API triggers of scheduled tasks (routine_triggers.go).
	Triggers RoutineTriggerStore
	// LocalRunnerToken is the token of the runner next to the server (DC6
	// single mode); it is accepted only on a direct loopback connection.
	LocalRunnerToken string
}

// Environment variables of the local runner's token (the systemd units of
// the server and the runner read the same file).
const (
	EnvLocalRunnerToken     = "CLAUDEX_WEB_RUNNER_TOKEN"
	EnvLocalRunnerTokenFile = "CLAUDEX_WEB_RUNNER_TOKEN_FILE"
)

var errNoService = infraerrors.ServiceUnavailable(webproto.ErrCodeRunnerUnavailable, "Claudex on the web is not available right now. Try again later.")

// localRunnerToken reads the local runner's token from the environment.
func localRunnerToken() string {
	if path := strings.TrimSpace(os.Getenv(EnvLocalRunnerTokenFile)); path != "" {
		// The path comes from the server's own environment (its unit file).
		if raw, err := os.ReadFile(path); err == nil { //nolint:gosec // operator-set path
			return strings.TrimSpace(string(raw))
		}
	}
	return strings.TrimSpace(os.Getenv(EnvLocalRunnerToken))
}

// fill completes b from the environment.
func fill(env *core.Env, b Backends) Backends {
	if env == nil {
		env = &core.Env{}
	}
	if b.ParseToken == nil {
		auth := env.AuthService
		b.ParseToken = func(token string) (Claims, error) {
			if auth == nil {
				return Claims{}, errNoService
			}
			claims, err := auth.ValidateToken(token)
			if err != nil {
				return Claims{}, err
			}
			out := Claims{UserID: claims.UserID, SessionID: claims.SessionID}
			if claims.IssuedAt != nil {
				out.IssuedAt = claims.IssuedAt.Time
			}
			if claims.ExpiresAt != nil {
				out.ExpiresAt = claims.ExpiresAt.Time
			}
			return out, nil
		}
	}
	if b.CheckAccess == nil {
		type accessChecker interface {
			CheckWebAccess(ctx context.Context, userID int64, email string, isAdmin bool) error
		}
		var checker accessChecker
		for _, f := range env.Components {
			if a, ok := f.(accessChecker); ok {
				checker = a
				break
			}
		}
		b.CheckAccess = func(ctx context.Context, userID int64, email string, isAdmin bool) error {
			if checker == nil {
				return infraerrors.Forbidden(webproto.ErrCodeDisabled, "The web app is turned off.")
			}
			return checker.CheckWebAccess(ctx, userID, email, isAdmin)
		}
	}
	if b.RedeemTicket == nil {
		type redeemer interface {
			RedeemTicket(ctx context.Context, ticket, tabID string) (int64, error)
		}
		var r redeemer
		for _, f := range env.Components {
			if x, ok := f.(redeemer); ok {
				r = x
				break
			}
		}
		b.RedeemTicket = func(ctx context.Context, ticket, tabID string) (int64, error) {
			if r == nil {
				return 0, errNoService
			}
			return r.RedeemTicket(ctx, ticket, tabID)
		}
	}
	if b.LookupUser == nil {
		users := env.Users
		b.LookupUser = func(ctx context.Context, id int64) (UserInfo, error) {
			if users == nil {
				return UserInfo{}, errNoService
			}
			u, err := users.GetByID(ctx, id)
			if err != nil {
				return UserInfo{}, err
			}
			return UserInfo{Email: u.Email, Admin: u.Role == service.RoleAdmin, Active: u.IsActive()}, nil
		}
	}
	if b.BackendMode == nil {
		svc := env.SettingService
		b.BackendMode = func(ctx context.Context) bool {
			return svc != nil && svc.IsBackendModeEnabled(ctx)
		}
	}
	if b.Store == nil {
		for _, f := range env.Components {
			if s, ok := f.(webstore.RunnerStore); ok {
				b.Store = s
				break
			}
		}
	}
	if b.Uploads == nil {
		for _, f := range env.Components {
			if s, ok := f.(UploadStore); ok {
				b.Uploads = s
				break
			}
		}
	}
	if b.GitHub == nil {
		for _, f := range env.Components {
			if s, ok := f.(GitHubOps); ok {
				b.GitHub = s
				break
			}
		}
	}
	if b.WebKey == nil {
		b.WebKey = webKeyFrom(env)
	}
	if b.Triggers == nil && env.DB != nil {
		b.Triggers = sqlRoutineTriggers{db: env.DB}
	}
	if b.AcquireSlot == nil {
		u := webusage.From(env)
		b.AcquireSlot = func(ctx context.Context, req webusage.SlotRequest) (RunSlot, error) {
			if u == nil {
				return noSlot{deadline: time.Now().Add(30 * time.Minute)}, nil
			}
			s, err := u.Acquire(ctx, req)
			if err != nil {
				return nil, err
			}
			return s, nil
		}
	}
	if b.Runners == nil {
		if env.DB != nil {
			b.Runners = &sqlDirectory{db: env.DB}
		} else {
			b.Runners = newMemoryDirectory()
		}
	}
	if b.WakeToken == nil {
		auth, users := env.AuthService, env.Users
		b.WakeToken = func(ctx context.Context, userID int64) (string, error) {
			if auth == nil || users == nil {
				return "", errNoService
			}
			u, err := users.GetByID(ctx, userID)
			if err != nil {
				return "", err
			}
			return auth.GenerateToken(ctx, u)
		}
	}
	if b.LocalRunnerToken == "" {
		b.LocalRunnerToken = localRunnerToken()
	}
	return b
}

// noSlot stands in when the web-usage component is not installed (tests).
type noSlot struct{ deadline time.Time }

func (s noSlot) Deadline() time.Time                           { return s.deadline }
func (noSlot) Release(context.Context, webusage.SlotEnd) error { return nil }

// keyAnswer is the answer of key.get: the registration in the shape of
// POST /api/v1/claudex/devices (devices.RegisterResponse, with every group's
// key since MG), which the runner parses with the desktop's contract
// (parseDeviceRegistration) and routes per model.
type keyAnswer struct {
	DeviceID     string                   `json:"deviceId"`
	Registration devices.RegisterResponse `json:"registration"`
}

var errNoKeys = infraerrors.ServiceUnavailable(webproto.ErrCodeRunnerUnavailable, "Model access for the web is not available right now. Try again later.")

// webKeyFrom answers key.get with the user's managed web key (W-KEY).
func webKeyFrom(env *core.Env) func(ctx context.Context, req KeyRequest) (any, error) {
	return func(ctx context.Context, req KeyRequest) (any, error) {
		issuer := devices.WebKeys(env)
		if issuer == nil {
			return nil, errNoKeys
		}
		key, err := issuer.EnsureWebKey(ctx, devices.WebKeyRequest{
			UserID: req.UserID, SessionID: req.Claims.SessionID, IssuedAt: req.Claims.IssuedAt, IP: req.IP,
		})
		if errors.Is(err, core.ErrNoPlan) {
			// Claudex has no subscriptions (owner decision, 2026-10-12): an
			// account without a group it can use still signs in to the web
			// app; the registration carries no key, so the runner opens the
			// account with no models and says why.
			registration := devices.NoPlanRegistration()
			registration.Device.CreatedAt = time.Now().UTC()
			return keyAnswer{DeviceID: devices.WebDeviceID(req.UserID), Registration: registration}, nil
		}
		if err != nil {
			return nil, err
		}
		if key == nil || key.Key == "" {
			return nil, errors.New("webhost: empty web key")
		}
		registration := key.Registration()
		registration.Device.CreatedAt = time.Now().UTC()
		return keyAnswer{DeviceID: devices.WebDeviceID(req.UserID), Registration: registration}, nil
	}
}
