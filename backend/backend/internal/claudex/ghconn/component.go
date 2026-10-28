// Package ghconn connects a user's GitHub account to Code on the web
// (W-GITHUB).
//
// An administrator stores a GitHub OAuth App or GitHub App (client id and
// secret) in the console; the secret is sealed with the server's secret
// encryption key like the other Claudex secrets and never leaves the server.
// A user starts the web application flow from the web app
// (POST /api/v1/claudex/web/github/connect answers GitHub's authorize URL),
// GitHub sends the browser back to GET .../web/github/callback, and the
// user's token is stored sealed (claudex_github_connections). The web app
// then lists repositories and branches through this component, and a runner
// that prepares a Code session's workspace asks for a clone credential
// (ServeGitHubOp, the runner link op "github.clone").
//
// The clone credential is a lease: the runner gets the user's token for one
// clone, valid for at most CloneLease, and must keep it out of the sandbox
// (an askpass helper on the runner side, never written to .git/config). It is
// not stored by this component and never logged.
package ghconn

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"

	"github.com/gin-gonic/gin"
)

// Routes, under /api/v1/claudex.
const (
	RouteStatus   = "/web/github"
	RouteConnect  = "/web/github/connect"
	RouteCallback = "/web/github/callback"
	RouteRepos    = "/web/github/repos"
	RouteBranches = "/web/github/branches"
	RouteIssues   = "/web/github/issues"
	RouteIssue    = "/web/github/issue"
	RoutePull     = "/web/github/pull"
	// CallbackPath is what an administrator registers with GitHub as the
	// authorization callback URL, after the public address.
	CallbackPath = "/api/v1/claudex" + RouteCallback
)

// Error reasons.
const (
	ReasonNotConfigured = "CLAUDEX_GITHUB_NOT_CONFIGURED"
	ReasonNotConnected  = "CLAUDEX_GITHUB_NOT_CONNECTED"
	ReasonUnavailable   = "CLAUDEX_GITHUB_UNAVAILABLE"
	ReasonBadRepo       = "CLAUDEX_GITHUB_BAD_REPOSITORY"
	ReasonNoAccess      = "CLAUDEX_GITHUB_NO_ACCESS"
	ReasonRateLimited   = "CLAUDEX_GITHUB_UPSTREAM_ERROR"
)

// Timings.
const (
	stateTTL      = 10 * time.Minute
	refreshMargin = time.Minute
	sweepEvery    = 10 * time.Minute
	// CloneLease is how long a clone credential is meant to be used for.
	CloneLease = 10 * time.Minute
)

var (
	errNotConfigured = infraerrors.NotFound(ReasonNotConfigured, "GitHub isn't set up on this service")
	errNotConnected  = infraerrors.Conflict(ReasonNotConnected, "Connect your GitHub account first")
	errUnavailable   = infraerrors.ServiceUnavailable(ReasonUnavailable, "GitHub is temporarily unavailable. Try again.")
)

// Component is the GitHub connection component.
type Component struct {
	env     *core.Env
	setting *core.JSONSetting[Settings]
	box     *core.SecretBox
	store   store
	gh      *client
	now     func() time.Time

	locks     sync.Map // user id -> *sync.Mutex (serialises token refreshes)
	sweepOnce sync.Once

	// The scheduled tasks' webhooks (routine_hooks.go); nil fields come
	// from the environment (tests set them).
	hooks hookStore
	fire  RoutineFirer
}

// New builds the component. It must not call its dependencies.
func New(env *core.Env) *Component {
	if env == nil {
		env = &core.Env{}
	}
	c := &Component{
		env: env,
		setting: core.NewJSONSetting(env.SettingRepo, SettingKey, defaultSettings,
			core.WithNormalize(normalize), core.WithValidate(validate)),
		box: core.NewSecretBox(env.Config),
		gh:  newClient("", "", nil),
	}
	if env.DB != nil {
		c.store = &sqlStore{db: env.DB}
	}
	return c
}

// Name implements core.Feature.
func (c *Component) Name() string { return core.NameGitHub }

// SettingKeys implements core.SettingsOwner.
func (c *Component) SettingKeys() []string { return []string{c.setting.Key()} }

func (c *Component) clock() time.Time {
	if c.now != nil {
		return c.now()
	}
	if c.env.Now != nil {
		return c.env.Now()
	}
	return time.Now()
}

// RegisterAdminRoutes implements core.AdminRouter: GET/PUT /github.
func (c *Component) RegisterAdminRoutes(g *gin.RouterGroup, stepUp gin.HandlerFunc) {
	if stepUp == nil {
		stepUp = func(g *gin.Context) { g.Next() }
	}
	g.GET("/github", c.adminGet)
	g.PUT("/github", stepUp, c.adminPut)
}

// RegisterPublicRoutes implements core.PublicRouter: the OAuth callback,
// which the browser reaches by redirect from GitHub without a bearer token;
// the single-use state ties it to the user who started the flow.
func (c *Component) RegisterPublicRoutes(g *gin.RouterGroup) {
	g.GET(RouteCallback, c.callback)
	// A scheduled task's GitHub trigger: the delivery carries its signature.
	g.POST(RouteRoutineHook, c.routineHook)
}

// RegisterUserRoutes implements core.UserRouter.
func (c *Component) RegisterUserRoutes(g *gin.RouterGroup) {
	g.GET(RouteStatus, c.getStatus)
	g.POST(RouteConnect, c.env.RateLimitPerUser("github-connect", 20, time.Minute), c.startConnect)
	g.DELETE(RouteStatus, c.disconnect)
	g.GET(RouteRepos, c.env.RateLimitPerUser("github-repos", 120, time.Minute), c.listRepos)
	g.GET(RouteBranches, c.env.RateLimitPerUser("github-branches", 120, time.Minute), c.listBranches)
	g.POST("/web/github/repository/read", c.env.RateLimitPerUser("github-read", 120, time.Minute), c.readRepository)
	g.GET(RouteIssues, c.env.RateLimitPerUser("github-issues", 120, time.Minute), c.listIssues)
	g.GET(RouteIssue, c.env.RateLimitPerUser("github-issue", 120, time.Minute), c.getIssue)
	// The branch row polls an open pull request about once a minute.
	g.GET(RoutePull, c.env.RateLimitPerUser("github-pull", 240, time.Minute), c.getPull)
	// The desktop's push before it continues a local session in the cloud.
	c.registerPushGrant(g)
	// Merge, auto-merge, ready for review and back to draft (pulls.go).
	g.POST(RoutePullAction, c.env.RateLimitPerUser("github-pull-action", 30, time.Minute), c.postPullAction)
	// Which finished sessions wait for a reviewer (pullstates.go; the phones' Ready for review filter).
	g.POST(RoutePullStates, c.env.RateLimitPerUser("github-pull-states", 30, time.Minute), c.postPullStates)
}

// Start implements core.Starter: drops expired authorization states.
func (c *Component) Start(ctx context.Context) {
	if c.store == nil {
		return
	}
	c.sweepOnce.Do(func() {
		go func() {
			t := time.NewTicker(sweepEvery)
			defer t.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-t.C:
					sctx, cancel := context.WithTimeout(ctx, 30*time.Second)
					if err := c.store.sweep(sctx, c.clock()); err != nil {
						slog.Warn("claudex github: sweeping states failed", "error", err)
					}
					cancel()
				}
			}
		}()
	})
}

// OnSessionsRevoked is not needed: a connection belongs to the user, not to
// a web session.

// publicBase resolves the address users reach the service at.
func (c *Component) publicBase(ctx context.Context, s Settings) string {
	if s.PublicBaseURL != "" {
		if _, err := parseBaseURL(s.PublicBaseURL); err == nil {
			return s.PublicBaseURL
		}
	}
	if c.env.SettingService != nil {
		fu := strings.TrimRight(strings.TrimSpace(c.env.SettingService.GetFrontendURL(ctx)), "/")
		if fu != "" {
			if _, err := parseBaseURL(fu); err == nil {
				return fu
			}
		}
	}
	return ""
}

// ready reports whether users can connect: the app is on, has a secret and
// the service knows its own address.
func (c *Component) ready(ctx context.Context, s Settings) bool {
	return s.Enabled && s.ClientID != "" && s.SecretConfigured() && c.publicBase(ctx, s) != ""
}

// secret opens the stored client secret.
func (c *Component) secret(s Settings) (string, error) {
	v, err := c.box.Open(s.ClientSecretCiphertext)
	if err != nil {
		return "", infraerrors.ServiceUnavailable(ReasonUnavailable, "GitHub is set up, but its stored secret can't be read. Ask the administrator to enter it again.")
	}
	return v, nil
}

func (c *Component) userLock(userID int64) *sync.Mutex {
	m, _ := c.locks.LoadOrStore(userID, &sync.Mutex{})
	mu, _ := m.(*sync.Mutex)
	return mu
}

// accessToken returns the user's usable token, refreshing an expired one. It
// answers errNotConfigured, errNotConnected (also after GitHub revoked the
// grant: the row is removed) or errUnavailable.
func (c *Component) accessToken(ctx context.Context, userID int64) (string, error) {
	s := c.setting.Cached(ctx)
	if !s.Enabled || c.store == nil {
		return "", errNotConfigured
	}
	lock := c.userLock(userID)
	lock.Lock()
	defer lock.Unlock()
	conn, err := c.store.get(ctx, userID)
	if errors.Is(err, errNoRows) {
		return "", errNotConnected
	}
	if err != nil {
		return "", errUnavailable
	}
	token, err := c.box.Open(conn.TokenSealed)
	if err != nil {
		_ = c.store.remove(ctx, userID)
		return "", errNotConnected
	}
	if conn.ExpiresAt == nil || c.clock().Add(refreshMargin).Before(*conn.ExpiresAt) {
		return token, nil
	}
	// Expired (a GitHub App user token): refresh it once.
	if conn.RefreshSealed == "" {
		_ = c.store.remove(ctx, userID)
		return "", errNotConnected
	}
	refresh, err := c.box.Open(conn.RefreshSealed)
	if err != nil {
		_ = c.store.remove(ctx, userID)
		return "", errNotConnected
	}
	secret, err := c.secret(s)
	if err != nil {
		return "", err
	}
	ts, err := c.gh.refresh(ctx, s.ClientID, secret, refresh)
	if errors.Is(err, errRevoked) {
		_ = c.store.remove(ctx, userID)
		return "", errNotConnected
	}
	if err != nil {
		return "", errUnavailable
	}
	if err := c.saveTokens(ctx, userID, ts); err != nil {
		return "", errUnavailable
	}
	return ts.Access, nil
}

func (c *Component) saveTokens(ctx context.Context, userID int64, ts tokenSet) error {
	sealed, err := c.box.Seal(ts.Access)
	if err != nil {
		return err
	}
	refresh := ""
	if ts.Refresh != "" {
		if refresh, err = c.box.Seal(ts.Refresh); err != nil {
			return err
		}
	}
	var exp *time.Time
	if !ts.ExpiresAt.IsZero() {
		t := ts.ExpiresAt
		exp = &t
	}
	return c.store.updateTokens(ctx, userID, sealed, refresh, exp)
}

// mapUpstream turns a GitHub client error into the answer the user sees; a
// dead token removes the connection.
func (c *Component) mapUpstream(ctx context.Context, userID int64, err error) error {
	switch {
	case errors.Is(err, errRevoked):
		_ = c.store.remove(ctx, userID)
		return errNotConnected
	case errors.Is(err, errNotFound):
		return infraerrors.NotFound(ReasonNoAccess, "That repository isn't available to your GitHub account")
	default:
		slog.Warn("claudex github: GitHub request failed", "error", err)
		return errUnavailable
	}
}

// CloneGrant is the answer of the runner link op "github.clone".
type CloneGrant struct {
	// URL is the https clone address (never carries the token).
	URL string `json:"url"`
	// Username and Token are the HTTP basic credentials for that URL; the
	// runner passes them to git through an askpass helper.
	Username string `json:"username"`
	Token    string `json:"token"`
	// ExpiresAt is when the runner must have finished cloning and dropped
	// the credential (RFC 3339, at most CloneLease ahead).
	ExpiresAt     string `json:"expiresAt"`
	Repository    string `json:"repository"` // "owner/name"
	DefaultBranch string `json:"defaultBranch"`
	Ref           string `json:"ref,omitempty"`
	CanPush       bool   `json:"canPush"`
}

// cloneRequest is the body of "github.clone".
type cloneRequest struct {
	URL string `json:"url"`
	Ref string `json:"ref,omitempty"`
}

// ServeGitHubOp implements webhost's GitHub backend: it answers a runner's
// "github.clone" for the user the runner serves. The repository must be a
// github.com address the user's own token can read.
func (c *Component) ServeGitHubOp(ctx context.Context, userID int64, op string, body json.RawMessage) (any, error) {
	switch op {
	case webproto.OpGitHubPush:
		return c.servePush(ctx, userID, body)
	case webproto.OpGitHubAPI:
		return c.serveAPI(ctx, userID, body)
	case webproto.OpGitHubHook:
		return c.serveHook(ctx, userID, body)
	case webproto.OpGitHubClone:
	default:
		return nil, infraerrors.BadRequest(ReasonBadRepo, "Unknown request.")
	}
	var req cloneRequest
	if err := json.Unmarshal(body, &req); err != nil {
		return nil, infraerrors.BadRequest(ReasonBadRepo, "The repository request is not valid.")
	}
	ref, err := parseRepoURL(req.URL, c.gh.webBase)
	if err != nil {
		return nil, infraerrors.BadRequest(ReasonBadRepo, "That isn't a GitHub repository address.")
	}
	if !validRef(req.Ref) {
		return nil, infraerrors.BadRequest(ReasonBadRepo, "That branch name isn't valid.")
	}
	token, err := c.accessToken(ctx, userID)
	if err != nil {
		return nil, err
	}
	repo, err := c.gh.repo(ctx, token, ref.Owner, ref.Name)
	if err != nil {
		return nil, c.mapUpstream(ctx, userID, err)
	}
	if !repo.Permissions.Pull {
		return nil, infraerrors.NotFound(ReasonNoAccess, "That repository isn't available to your GitHub account")
	}
	now := c.clock()
	expires := now.Add(CloneLease)
	// Never mention the token: the log line carries who and what only.
	slog.Info("claudex github: clone credential issued", "user_id", userID, "repository", repo.FullName)
	return CloneGrant{
		URL:      c.webBaseURL() + "/" + repo.FullName + ".git",
		Username: "x-access-token", Token: token,
		ExpiresAt:  expires.UTC().Format(time.RFC3339),
		Repository: repo.FullName, DefaultBranch: repo.DefaultBranch, Ref: req.Ref,
		CanPush: repo.Permissions.Push,
	}, nil
}

func (c *Component) webBaseURL() string { return c.gh.webBase }

// validRef accepts the branch or tag names git allows that are also safe as a
// command argument and path part ("" means the default branch).
func validRef(ref string) bool {
	if ref == "" {
		return true
	}
	if len(ref) > 255 || strings.HasPrefix(ref, "-") || strings.HasPrefix(ref, "/") || strings.HasSuffix(ref, "/") ||
		strings.HasSuffix(ref, ".") || strings.HasSuffix(ref, ".lock") || strings.Contains(ref, "..") ||
		strings.Contains(ref, "//") || strings.Contains(ref, "@{") {
		return false
	}
	for _, r := range ref {
		if r < 0x21 || r == 0x7f || strings.ContainsRune(`~^:?*[\`, r) {
			return false
		}
	}
	return true
}

var (
	_ core.Feature       = (*Component)(nil)
	_ core.SettingsOwner = (*Component)(nil)
	_ core.AdminRouter   = (*Component)(nil)
	_ core.PublicRouter  = (*Component)(nil)
	_ core.UserRouter    = (*Component)(nil)
	_ core.Starter       = (*Component)(nil)
)
