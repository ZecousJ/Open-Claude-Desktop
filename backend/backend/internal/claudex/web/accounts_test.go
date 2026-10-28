package web

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func withCookies(cookies ...string) map[string]string {
	h := webHeaders()
	h["Cookie"] = strings.Join(cookies, "; ")
	return h
}

func TestAccountsListsTheAccountCookies(t *testing.T) {
	f := newFixture(t, enabled)
	r := f.auth(webproto.AuthAccounts, ``, withCookies(
		webproto.AccountCookie(7)+"=rt-a",
		webproto.AccountCookie(3)+"=rt-b",
		webproto.RefreshCookie+"=rt-c",
		webproto.RefreshCookie+"_x=rt-d",
		webproto.AccountCookie(9)+"=",
	))
	require.Equal(t, http.StatusOK, r.status)
	require.JSONEq(t, `{"accounts":["3","7"],"legacy":true,"max_accounts":5}`, string(r.data))
	require.Equal(t, "no-store", r.header.Get("Cache-Control"))
	require.Empty(t, r.header.Values("Set-Cookie"), "listing changes nothing")

	r = f.auth(webproto.AuthAccounts, ``, webHeaders())
	require.JSONEq(t, `{"accounts":[],"legacy":false,"max_accounts":5}`, string(r.data))

	// CSRF first, like every cookie route.
	r = f.auth(webproto.AuthAccounts, ``, map[string]string{"Origin": "https://evil.example"})
	require.Equal(t, http.StatusForbidden, r.status)
}

func TestRefreshOfAnAccountWithoutItsCookie(t *testing.T) {
	f := newFixture(t, enabled)
	r := f.auth(webproto.AuthRefresh, `{"account":"7"}`, withCookies(webproto.AccountCookie(3)+"=rt-b"))
	require.Equal(t, http.StatusUnauthorized, r.status)
	require.Equal(t, ReasonNoSession, r.reason)
	require.Empty(t, r.header.Values("Set-Cookie"), "the other account's cookie is left alone")
}

func TestLogoutOfOneAccountClearsOnlyItsCookie(t *testing.T) {
	f := newFixture(t, enabled)
	r := f.auth(webproto.AuthLogout, `{"account":"7"}`, withCookies(
		webproto.AccountCookie(3)+"=rt-b",
		webproto.AccountCookie(7)+"=rt-a",
	))
	require.Equal(t, http.StatusOK, r.status)
	cleared := r.header.Values("Set-Cookie")
	require.Len(t, cleared, 1)
	require.True(t, strings.HasPrefix(cleared[0], webproto.AccountCookie(7)+"=;"), cleared[0])
	require.Contains(t, cleared[0], "Max-Age=0")
	require.Contains(t, cleared[0], "Path=/api/v1/claudex/web/auth;")
}

func TestSignInIsRefusedPastTheAccountLimit(t *testing.T) {
	f := newFixture(t, enabled)
	f.backend.user = &service.User{ID: 99, Email: "a@example.com", Role: service.RoleUser, Status: service.StatusActive}
	full := []string{}
	for id := int64(1); id <= webproto.BrowserAccounts; id++ {
		full = append(full, webproto.AccountCookie(id)+"=rt")
	}
	r := f.auth(webproto.AuthLogin, `{}`, withCookies(full...))
	require.Equal(t, http.StatusConflict, r.status)
	require.Equal(t, ReasonAccountLimit, r.reason)
	require.Empty(t, r.header.Values("Set-Cookie"))

	// The same account signing in again replaces its own cookie: no limit
	// (the fixture has no token service, so it stops there).
	full[0] = webproto.AccountCookie(99) + "=rt"
	r = f.auth(webproto.AuthLogin, `{}`, withCookies(full...))
	require.Equal(t, http.StatusServiceUnavailable, r.status)

	// The bare cookie of an older session does not count.
	r = f.auth(webproto.AuthLogin, `{}`, withCookies(append(full[1:], webproto.RefreshCookie+"=rt")...))
	require.Equal(t, http.StatusServiceUnavailable, r.status)
}

func TestSessionCookieChoice(t *testing.T) {
	gin.SetMode(gin.TestMode)
	ctx := func(cookies ...string) *gin.Context {
		g, _ := gin.CreateTestContext(httptest.NewRecorder())
		g.Request = httptest.NewRequest(http.MethodPost, "/x", nil)
		if len(cookies) > 0 {
			g.Request.Header.Set("Cookie", strings.Join(cookies, "; "))
		}
		return g
	}
	both := ctx(webproto.AccountCookie(8)+"=rt-8", webproto.AccountCookie(4)+"=rt-4", webproto.RefreshCookie+"=rt-bare")

	name, rt := sessionCookie(both, 8, true)
	require.Equal(t, webproto.AccountCookie(8), name)
	require.Equal(t, "rt-8", rt)

	name, rt = sessionCookie(both, 5, true)
	require.Equal(t, webproto.AccountCookie(5), name)
	require.Empty(t, rt, "a named account never falls back to another cookie")

	name, rt = sessionCookie(both, 0, true)
	require.Equal(t, webproto.RefreshCookie, name)
	require.Equal(t, "rt-bare", rt, "an older browser's bare cookie first")

	accounts := ctx(webproto.AccountCookie(8)+"=rt-8", webproto.AccountCookie(4)+"=rt-4")
	name, rt = sessionCookie(accounts, 0, true)
	require.Equal(t, webproto.AccountCookie(4), name)
	require.Equal(t, "rt-4", rt)

	name, rt = sessionCookie(accounts, 0, false)
	require.Equal(t, webproto.RefreshCookie, name)
	require.Empty(t, rt, "logout without a name touches no account cookie")

	require.False(t, atAccountLimit(ctx().Request, 1))
	require.False(t, atAccountLimit(accounts.Request, 1))
}

func TestRequestedAccount(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for body, want := range map[string]int64{
		``:                    0,
		`{}`:                  0,
		`{"account":"42"}`:    42,
		`{"account":" 42 "}`:  42,
		`{"account":"-1"}`:    0,
		`{"account":"abc"}`:   0,
		`{"account":42}`:      0,
		`not json`:            0,
		`{"account":"0"}`:     0,
		`{"account":"9e3"}`:   0,
		`{"account":"12345"}`: 12345,
	} {
		g, _ := gin.CreateTestContext(httptest.NewRecorder())
		g.Request = httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(body))
		g.Request.Header.Set("Content-Type", "application/json")
		require.Equal(t, want, requestedAccount(g), body)
	}
}
