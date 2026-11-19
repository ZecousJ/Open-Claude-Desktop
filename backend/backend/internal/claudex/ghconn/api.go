package ghconn

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// GitHub endpoints. Tests point the component at a fake server.
const (
	defaultWebBase = "https://github.com"
	defaultAPIBase = "https://api.github.com"
	maxAPIBody     = 4 << 20
	apiTimeout     = 10 * time.Second
	userAgent      = "Claudex-GitHub-Connection"
)

// errRevoked means GitHub no longer accepts the user's token (revoked on
// GitHub, or expired without a usable refresh token): the connection is dead.
var errRevoked = errors.New("ghconn: GitHub refused the stored token")

// errNotFound is GitHub's 404 (also what it answers for a private repository
// the token cannot see).
var errNotFound = errors.New("ghconn: not found on GitHub")

// errUpstream is any other failure talking to GitHub; it never carries a
// response body (which could echo a token).
type errUpstream struct{ status int }

func (e errUpstream) Error() string {
	if e.status == 0 {
		return "ghconn: GitHub could not be reached"
	}
	return "ghconn: GitHub answered " + strconv.Itoa(e.status)
}

type client struct {
	http    *http.Client
	webBase string
	apiBase string
}

func newClient(web, api string, hc *http.Client) *client {
	if web == "" {
		web = defaultWebBase
	}
	if api == "" {
		api = defaultAPIBase
	}
	if hc == nil {
		hc = &http.Client{Timeout: apiTimeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	return &client{http: hc, webBase: strings.TrimRight(web, "/"), apiBase: strings.TrimRight(api, "/")}
}

// tokenSet is what GitHub's token endpoint answers.
type tokenSet struct {
	Access    string
	Refresh   string
	ExpiresAt time.Time // zero: never expires
	Scope     string
}

func (c *client) do(ctx context.Context, req *http.Request, out any) (int, error) {
	req = req.WithContext(ctx)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	resp, err := c.http.Do(req)
	if err != nil {
		return 0, errUpstream{}
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxAPIBody))
	if err != nil {
		return resp.StatusCode, errUpstream{status: resp.StatusCode}
	}
	switch {
	case resp.StatusCode == http.StatusUnauthorized:
		return resp.StatusCode, errRevoked
	case resp.StatusCode == http.StatusNotFound:
		return resp.StatusCode, errNotFound
	case resp.StatusCode < 200 || resp.StatusCode > 299:
		return resp.StatusCode, errUpstream{status: resp.StatusCode}
	}
	if out != nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, out); err != nil {
			return resp.StatusCode, errUpstream{status: resp.StatusCode}
		}
	}
	return resp.StatusCode, nil
}

func (c *client) authorizeURL(clientID, redirect, state, challenge, scope string) string {
	q := url.Values{}
	q.Set("client_id", clientID)
	q.Set("redirect_uri", redirect)
	q.Set("state", state)
	q.Set("code_challenge", challenge)
	q.Set("code_challenge_method", "S256")
	if scope != "" {
		q.Set("scope", scope)
	}
	q.Set("allow_signup", "false")
	return c.webBase + "/login/oauth/authorize?" + q.Encode()
}

// token posts to the token endpoint (code exchange or refresh).
func (c *client) token(ctx context.Context, form url.Values) (tokenSet, error) {
	req, err := http.NewRequest(http.MethodPost, c.webBase+"/login/oauth/access_token", strings.NewReader(form.Encode()))
	if err != nil {
		return tokenSet{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	var out struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int64  `json:"expires_in"`
		Scope        string `json:"scope"`
		Error        string `json:"error"`
	}
	if _, err := c.do(ctx, req, &out); err != nil {
		if errors.Is(err, errNotFound) {
			return tokenSet{}, errUpstream{status: 404}
		}
		return tokenSet{}, err
	}
	if out.Error != "" || out.AccessToken == "" {
		// bad_verification_code, bad_refresh_token, incorrect_client_credentials.
		return tokenSet{}, errRevoked
	}
	ts := tokenSet{Access: out.AccessToken, Refresh: out.RefreshToken, Scope: out.Scope}
	if out.ExpiresIn > 0 {
		ts.ExpiresAt = time.Now().Add(time.Duration(out.ExpiresIn) * time.Second)
	}
	return ts, nil
}

func (c *client) exchangeCode(ctx context.Context, clientID, secret, code, redirect, verifier string) (tokenSet, error) {
	return c.token(ctx, url.Values{
		"client_id": {clientID}, "client_secret": {secret}, "code": {code},
		"redirect_uri": {redirect}, "code_verifier": {verifier},
	})
}

func (c *client) refresh(ctx context.Context, clientID, secret, refresh string) (tokenSet, error) {
	return c.token(ctx, url.Values{
		"client_id": {clientID}, "client_secret": {secret},
		"grant_type": {"refresh_token"}, "refresh_token": {refresh},
	})
}

func (c *client) get(ctx context.Context, token, path string, q url.Values, out any) error {
	u := c.apiBase + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	req, err := http.NewRequest(http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	_, err = c.do(ctx, req, out)
	return err
}

type ghUser struct {
	ID        int64  `json:"id"`
	Login     string `json:"login"`
	AvatarURL string `json:"avatar_url"`
}

func (c *client) user(ctx context.Context, token string) (ghUser, error) {
	var u ghUser
	err := c.get(ctx, token, "/user", nil, &u)
	if err == nil && (u.ID == 0 || u.Login == "") {
		err = errUpstream{status: 200}
	}
	return u, err
}

// Repository is one repository a user can pick.
type Repository struct {
	FullName      string `json:"full_name"`
	Name          string `json:"name"`
	Owner         string `json:"owner"`
	Private       bool   `json:"private"`
	Description   string `json:"description"`
	DefaultBranch string `json:"default_branch"`
	CloneURL      string `json:"clone_url"`
	PushedAt      string `json:"pushed_at,omitempty"`
	Permissions   struct {
		Pull bool `json:"pull"`
		Push bool `json:"push"`
	} `json:"permissions"`
}

// wireRepo is GitHub's repository object.
type wireRepo struct {
	FullName      string  `json:"full_name"`
	Name          string  `json:"name"`
	Private       bool    `json:"private"`
	Description   *string `json:"description"`
	DefaultBranch string  `json:"default_branch"`
	CloneURL      string  `json:"clone_url"`
	PushedAt      *string `json:"pushed_at"`
	Owner         struct {
		Login string `json:"login"`
	} `json:"owner"`
	Permissions struct {
		Pull bool `json:"pull"`
		Push bool `json:"push"`
	} `json:"permissions"`
}

func (w wireRepo) repo() Repository {
	r := Repository{
		FullName: w.FullName, Name: w.Name, Owner: w.Owner.Login, Private: w.Private,
		DefaultBranch: w.DefaultBranch, CloneURL: w.CloneURL,
	}
	if w.Description != nil {
		r.Description = *w.Description
	}
	if w.PushedAt != nil {
		r.PushedAt = *w.PushedAt
	}
	r.Permissions.Pull, r.Permissions.Push = w.Permissions.Pull, w.Permissions.Push
	return r
}

// listRepos reads one page of the repositories the user can read, most
// recently pushed first. more is true when GitHub has a next page.
func (c *client) listRepos(ctx context.Context, token string, page, perPage int) (repos []Repository, more bool, err error) {
	var wire []wireRepo
	q := url.Values{
		"sort": {"pushed"}, "direction": {"desc"},
		"affiliation": {"owner,collaborator,organization_member"},
		"per_page":    {strconv.Itoa(perPage)}, "page": {strconv.Itoa(page)},
	}
	if err := c.get(ctx, token, "/user/repos", q, &wire); err != nil {
		return nil, false, err
	}
	repos = make([]Repository, 0, len(wire))
	for _, w := range wire {
		repos = append(repos, w.repo())
	}
	return repos, len(wire) == perPage, nil
}

func (c *client) repo(ctx context.Context, token, owner, name string) (Repository, error) {
	var w wireRepo
	if err := c.get(ctx, token, "/repos/"+url.PathEscape(owner)+"/"+url.PathEscape(name), nil, &w); err != nil {
		return Repository{}, err
	}
	return w.repo(), nil
}

// Branch is one branch of a repository.
type Branch struct {
	Name      string `json:"name"`
	Protected bool   `json:"protected"`
}

func (c *client) branches(ctx context.Context, token, owner, name string, page, perPage int) (out []Branch, more bool, err error) {
	var wire []struct {
		Name      string `json:"name"`
		Protected bool   `json:"protected"`
	}
	q := url.Values{"per_page": {strconv.Itoa(perPage)}, "page": {strconv.Itoa(page)}}
	if err := c.get(ctx, token, "/repos/"+url.PathEscape(owner)+"/"+url.PathEscape(name)+"/branches", q, &wire); err != nil {
		return nil, false, err
	}
	out = make([]Branch, 0, len(wire))
	for _, b := range wire {
		out = append(out, Branch{Name: b.Name, Protected: b.Protected})
	}
	return out, len(wire) == perPage, nil
}

// revoke deletes the user's grant of the app on GitHub (best effort: the
// caller ignores the error, the local row is removed either way).
func (c *client) revoke(ctx context.Context, clientID, secret, token string) error {
	body, _ := json.Marshal(map[string]string{"access_token": token})
	req, err := http.NewRequest(http.MethodDelete, c.apiBase+"/applications/"+url.PathEscape(clientID)+"/grant", strings.NewReader(string(body)))
	if err != nil {
		return err
	}
	req.SetBasicAuth(clientID, secret)
	req.Header.Set("Content-Type", "application/json")
	_, err = c.do(ctx, req, nil)
	return err
}

// RepoRef is a parsed repository address.
type RepoRef struct{ Owner, Name string }

// FullName is "owner/name".
func (r RepoRef) FullName() string { return r.Owner + "/" + r.Name }

// parseRepoURL reads <web base>/<owner>/<name>[.git] (https://github.com in
// production). Anything else (other hosts, ssh URLs, credentials,
// extra path, query) is refused.
func parseRepoURL(raw, webBase string) (RepoRef, error) {
	base, err := url.Parse(webBase)
	if err != nil {
		return RepoRef{}, err
	}
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme != base.Scheme || !strings.EqualFold(u.Host, base.Host) || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return RepoRef{}, fmt.Errorf("not a repository address on %s", base.Host)
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(parts) != 2 {
		return RepoRef{}, errors.New("not a repository address")
	}
	ref := RepoRef{Owner: parts[0], Name: strings.TrimSuffix(parts[1], ".git")}
	if !validOwner(ref.Owner) || !validName(ref.Name) {
		return RepoRef{}, errors.New("not a repository address")
	}
	return ref, nil
}

func validOwner(s string) bool {
	if s == "" || len(s) > 39 || s[0] == '-' {
		return false
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-') {
			return false
		}
	}
	return true
}

func validName(s string) bool {
	if s == "" || len(s) > 100 || s == "." || s == ".." {
		return false
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' || r == '.') {
			return false
		}
	}
	return true
}
