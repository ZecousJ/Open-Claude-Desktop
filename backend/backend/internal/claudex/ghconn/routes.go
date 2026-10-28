package ghconn

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"

	"github.com/gin-gonic/gin"
)

const (
	defaultPerPage = 30
	maxPerPage     = 100
	// searchPages is how many GitHub pages (of 100) a search scans.
	searchPages = 5
	// oauthScope is what an OAuth App asks for: read and clone private
	// repositories. (A GitHub App's permissions are set on GitHub.)
	oauthScope = "repo"
)

// Status is the answer of GET /api/v1/claudex/web/github.
type Status struct {
	// Configured: an administrator set GitHub up (the picker is enabled).
	Configured  bool   `json:"configured"`
	Connected   bool   `json:"connected"`
	Login       string `json:"login,omitempty"`
	AvatarURL   string `json:"avatar_url,omitempty"`
	ConnectedAt string `json:"connected_at,omitempty"`
}

func (c *Component) userID(g *gin.Context) (int64, bool) {
	id, ok := core.Subject(g)
	if !ok {
		response.ErrorFrom(g, infraerrors.Unauthorized("UNAUTHORIZED", "Sign in to continue."))
	}
	return id, ok
}

func (c *Component) getStatus(g *gin.Context) {
	uid, ok := c.userID(g)
	if !ok {
		return
	}
	ctx := g.Request.Context()
	s := c.setting.Cached(ctx)
	st := Status{Configured: c.ready(ctx, s) && c.store != nil}
	if st.Configured {
		conn, err := c.store.get(ctx, uid)
		switch {
		case err == nil:
			st.Connected, st.Login, st.AvatarURL = true, conn.Login, conn.AvatarURL
			st.ConnectedAt = conn.ConnectedAt.UTC().Format(time.RFC3339)
		case !errors.Is(err, errNoRows):
			response.ErrorFrom(g, errUnavailable)
			return
		}
	}
	response.Success(g, st)
}

func randomToken(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func stateHash(state string) string {
	sum := sha256.Sum256([]byte(state))
	return hex.EncodeToString(sum[:])
}

func (c *Component) redirectURI(base string) string { return base + CallbackPath }

// startConnect answers {authorize_url}: the page the browser opens to
// approve the app on GitHub.
func (c *Component) startConnect(g *gin.Context) {
	uid, ok := c.userID(g)
	if !ok {
		return
	}
	ctx := g.Request.Context()
	s := c.setting.Cached(ctx)
	if !c.ready(ctx, s) || c.store == nil {
		response.ErrorFrom(g, errNotConfigured)
		return
	}
	state, err1 := randomToken(32)
	verifier, err2 := randomToken(32)
	if err1 != nil || err2 != nil {
		response.ErrorFrom(g, errUnavailable)
		return
	}
	sealed, err := c.box.Seal(verifier)
	if err != nil {
		response.ErrorFrom(g, errUnavailable)
		return
	}
	if err := c.store.putState(ctx, stateHash(state), oauthState{UserID: uid, VerifierSealed: sealed, ExpiresAt: c.clock().Add(stateTTL)}); err != nil {
		response.ErrorFrom(g, errUnavailable)
		return
	}
	challenge := sha256.Sum256([]byte(verifier))
	scope := ""
	if s.Kind == KindOAuthApp {
		scope = oauthScope
	}
	response.Success(g, gin.H{"authorize_url": c.gh.authorizeURL(s.ClientID, c.redirectURI(c.publicBase(ctx, s)),
		state, base64.RawURLEncoding.EncodeToString(challenge[:]), scope)})
}

// callback finishes the flow and sends the browser back to the Code page:
// /code?github=connected, or github=denied / github=failed.
func (c *Component) callback(g *gin.Context) {
	ctx := g.Request.Context()
	s := c.setting.Cached(ctx)
	g.Header("Cache-Control", "no-store")
	g.Header("Referrer-Policy", "no-referrer")
	base := c.publicBase(ctx, s)
	if base == "" || c.store == nil {
		g.String(http.StatusNotFound, "GitHub isn't set up on this service.")
		return
	}
	back := func(result string) {
		g.Redirect(http.StatusFound, base+"/code?github="+url.QueryEscape(result))
	}
	state := g.Query("state")
	if state == "" || len(state) > 200 {
		back("failed")
		return
	}
	// The state is single use: take it before anything else.
	st, err := c.store.takeState(ctx, stateHash(state), c.clock())
	if err != nil || !s.Enabled || !s.SecretConfigured() {
		back("failed")
		return
	}
	if g.Query("error") != "" {
		back("denied")
		return
	}
	code := g.Query("code")
	verifier, err := c.box.Open(st.VerifierSealed)
	secret, serr := c.secret(s)
	if code == "" || len(code) > 200 || err != nil || serr != nil {
		back("failed")
		return
	}
	ts, err := c.gh.exchangeCode(ctx, s.ClientID, secret, code, c.redirectURI(base), verifier)
	if err != nil {
		back("failed")
		return
	}
	user, err := c.gh.user(ctx, ts.Access)
	if err != nil {
		back("failed")
		return
	}
	sealed, err := c.box.Seal(ts.Access)
	if err != nil {
		back("failed")
		return
	}
	refresh := ""
	if ts.Refresh != "" {
		if refresh, err = c.box.Seal(ts.Refresh); err != nil {
			back("failed")
			return
		}
	}
	conn := connection{
		UserID: st.UserID, GitHubID: user.ID, Login: user.Login, AvatarURL: truncate(user.AvatarURL, 512),
		TokenSealed: sealed, RefreshSealed: refresh, Scope: truncate(ts.Scope, 255), ConnectedAt: c.clock(),
	}
	if !ts.ExpiresAt.IsZero() {
		t := ts.ExpiresAt
		conn.ExpiresAt = &t
	}
	if err := c.store.upsert(ctx, conn); err != nil {
		back("failed")
		return
	}
	back("connected")
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

// disconnect removes the connection (and the app's grant on GitHub, best
// effort).
func (c *Component) disconnect(g *gin.Context) {
	uid, ok := c.userID(g)
	if !ok {
		return
	}
	ctx := g.Request.Context()
	if c.store == nil {
		response.ErrorFrom(g, errNotConfigured)
		return
	}
	if conn, err := c.store.get(ctx, uid); err == nil {
		s := c.setting.Cached(ctx)
		if token, terr := c.box.Open(conn.TokenSealed); terr == nil && s.SecretConfigured() {
			if secret, serr := c.secret(s); serr == nil {
				_ = c.gh.revoke(ctx, s.ClientID, secret, token)
			}
		}
	}
	if err := c.store.remove(ctx, uid); err != nil {
		response.ErrorFrom(g, errUnavailable)
		return
	}
	response.Success(g, Status{Configured: c.ready(ctx, c.setting.Cached(ctx))})
}

func pageParams(g *gin.Context) (page, perPage int) {
	page, _ = strconv.Atoi(g.Query("page"))
	if page < 1 {
		page = 1
	}
	perPage, _ = strconv.Atoi(g.Query("per_page"))
	if perPage < 1 {
		perPage = defaultPerPage
	}
	if perPage > maxPerPage {
		perPage = maxPerPage
	}
	return page, perPage
}

// ReposPage is the answer of GET .../web/github/repos.
type ReposPage struct {
	Items []Repository `json:"items"`
	// NextPage is the page to ask for next; null when there is none. A
	// search never has one (it shows the first matches).
	NextPage *int `json:"next_page"`
	// Truncated: a search stopped scanning before the end of the list.
	Truncated bool `json:"truncated,omitempty"`
}

func (c *Component) listRepos(g *gin.Context) {
	uid, ok := c.userID(g)
	if !ok {
		return
	}
	ctx := g.Request.Context()
	token, err := c.accessToken(ctx, uid)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	page, perPage := pageParams(g)
	query := strings.ToLower(strings.TrimSpace(g.Query("query")))
	if len(query) > 100 {
		response.ErrorFrom(g, infraerrors.BadRequest(ReasonBadRepo, "The search text is too long."))
		return
	}
	out := ReposPage{Items: []Repository{}}
	if query == "" {
		repos, more, err := c.gh.listRepos(ctx, token, page, perPage)
		if err != nil {
			response.ErrorFrom(g, c.mapUpstream(ctx, uid, err))
			return
		}
		out.Items = repos
		if more {
			n := page + 1
			out.NextPage = &n
		}
		response.Success(g, out)
		return
	}
	// GitHub cannot search across everything a user can reach, so a search
	// scans the most recently pushed repositories and keeps the matches.
	for p := 1; p <= searchPages && len(out.Items) < perPage; p++ {
		repos, more, err := c.gh.listRepos(ctx, token, p, maxPerPage)
		if err != nil {
			response.ErrorFrom(g, c.mapUpstream(ctx, uid, err))
			return
		}
		for _, r := range repos {
			if strings.Contains(strings.ToLower(r.FullName), query) && len(out.Items) < perPage {
				out.Items = append(out.Items, r)
			}
		}
		if !more {
			break
		}
		if p == searchPages {
			out.Truncated = true
		}
	}
	response.Success(g, out)
}

// BranchesPage is the answer of GET .../web/github/branches.
type BranchesPage struct {
	DefaultBranch string   `json:"default_branch"`
	Items         []Branch `json:"items"`
	NextPage      *int     `json:"next_page"`
	Truncated     bool     `json:"truncated,omitempty"`
}

func (c *Component) listBranches(g *gin.Context) {
	uid, ok := c.userID(g)
	if !ok {
		return
	}
	ctx := g.Request.Context()
	parts := strings.Split(g.Query("repo"), "/")
	if len(parts) != 2 || !validOwner(parts[0]) || !validName(parts[1]) {
		response.ErrorFrom(g, infraerrors.BadRequest(ReasonBadRepo, "repo must be owner/name"))
		return
	}
	token, err := c.accessToken(ctx, uid)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	repo, err := c.gh.repo(ctx, token, parts[0], parts[1])
	if err != nil {
		response.ErrorFrom(g, c.mapUpstream(ctx, uid, err))
		return
	}
	page, perPage := pageParams(g)
	query := strings.ToLower(strings.TrimSpace(g.Query("query")))
	out := BranchesPage{DefaultBranch: repo.DefaultBranch, Items: []Branch{}}
	if query == "" {
		items, more, err := c.gh.branches(ctx, token, parts[0], parts[1], page, perPage)
		if err != nil {
			response.ErrorFrom(g, c.mapUpstream(ctx, uid, err))
			return
		}
		out.Items = items
		if more {
			n := page + 1
			out.NextPage = &n
		}
	} else {
		for p := 1; p <= searchPages && len(out.Items) < perPage; p++ {
			items, more, err := c.gh.branches(ctx, token, parts[0], parts[1], p, maxPerPage)
			if err != nil {
				response.ErrorFrom(g, c.mapUpstream(ctx, uid, err))
				return
			}
			for _, b := range items {
				if strings.Contains(strings.ToLower(b.Name), query) && len(out.Items) < perPage {
					out.Items = append(out.Items, b)
				}
			}
			if !more {
				break
			}
			if p == searchPages {
				out.Truncated = true
			}
		}
	}
	response.Success(g, out)
}
