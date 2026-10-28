package web

// Several accounts in one browser (the account menu's other accounts and
// "Add account", the sign-in page's "Choose an account"; live claude.ai
// bundle, 2026-10-12). Each signed-in account keeps its own refresh cookie,
// webproto.AccountCookie(user id), with the attributes of the bare cookie;
// a tab names the account it means in the body of refresh and logout. The
// bare cookie (webproto.RefreshCookie) of a browser signed in before this
// is still read, and moves to its account's cookie on the next refresh.

import (
	"net/http"
	"sort"
	"strconv"
	"strings"

	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"

	"github.com/gin-gonic/gin"
)

// ReasonAccountLimit refuses a sign-in that would take the browser past
// webproto.BrowserAccounts accounts.
const ReasonAccountLimit = "CLAUDEX_WEB_ACCOUNT_LIMIT"

var errAccountLimit = infraerrors.Conflict(ReasonAccountLimit,
	"This browser is signed in to as many accounts as it can hold. Log out of one, then try again.")

// accountRequest is the optional body of refresh and logout.
type accountRequest struct {
	// Account is the user id whose cookie the request means.
	Account string `json:"account"`
}

// requestedAccount is the account the body names, 0 when it names none
// (an empty or older client's body).
func requestedAccount(g *gin.Context) int64 {
	var req accountRequest
	if err := g.ShouldBindJSON(&req); err != nil {
		return 0
	}
	id, err := strconv.ParseInt(strings.TrimSpace(req.Account), 10, 64)
	if err != nil || id <= 0 {
		return 0
	}
	return id
}

// browserAccounts maps the user ids of the account cookies the request
// carries to their tokens.
func browserAccounts(r *http.Request) map[int64]string {
	out := map[int64]string{}
	for _, ck := range r.Cookies() {
		id := webproto.AccountOfCookie(ck.Name)
		if id == 0 {
			continue
		}
		if v := strings.TrimSpace(ck.Value); v != "" {
			out[id] = v
		}
	}
	return out
}

// sessionCookie is the cookie a refresh or logout uses. A named account
// uses only its own cookie. Without a name: the bare cookie, else (when
// anyAccount) the account cookie with the lowest user id, so a new tab of
// a browser that remembers no account still opens one.
func sessionCookie(g *gin.Context, account int64, anyAccount bool) (name, token string) {
	if account > 0 {
		name = webproto.AccountCookie(account)
		return name, cookieNamed(g, name)
	}
	if rt := refreshCookie(g); rt != "" {
		return webproto.RefreshCookie, rt
	}
	if !anyAccount {
		return webproto.RefreshCookie, ""
	}
	accounts := browserAccounts(g.Request)
	var first int64
	for id := range accounts {
		if first == 0 || id < first {
			first = id
		}
	}
	if first == 0 {
		return webproto.RefreshCookie, ""
	}
	return webproto.AccountCookie(first), accounts[first]
}

// atAccountLimit reports whether signing userID in would take the browser
// past webproto.BrowserAccounts accounts (its own cookie and the bare one
// do not count: they are replaced).
func atAccountLimit(r *http.Request, userID int64) bool {
	others := browserAccounts(r)
	delete(others, userID)
	return len(others) >= webproto.BrowserAccounts
}

// AccountsResponse answers auth/accounts.
type AccountsResponse struct {
	// Accounts are the user ids (decimal strings) of the account cookies.
	Accounts []string `json:"accounts"`
	// Legacy reports a bare cookie of an unknown account.
	Legacy bool `json:"legacy"`
	// MaxAccounts is webproto.BrowserAccounts.
	MaxAccounts int `json:"max_accounts"`
}

// POST auth/accounts: the accounts this browser holds a session cookie for.
// Only what the browser itself sent; nothing about the accounts is read.
func (c *Component) accounts(g *gin.Context) {
	ids := make([]int64, 0, webproto.BrowserAccounts)
	for id := range browserAccounts(g.Request) {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	out := AccountsResponse{Accounts: make([]string, 0, len(ids)), Legacy: refreshCookie(g) != "", MaxAccounts: webproto.BrowserAccounts}
	for _, id := range ids {
		out.Accounts = append(out.Accounts, strconv.FormatInt(id, 10))
	}
	g.Header("Cache-Control", "no-store")
	response.Success(g, out)
}
