package web

import (
	"net"
	"net/http"
	"net/url"
	"strings"

	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"

	"github.com/gin-gonic/gin"
)

// errCSRF is the answer to a request that did not come from the web app.
var errCSRF = infraerrors.Forbidden(webproto.ErrCodeBadRequest, "This request must come from the web app.")

// csrf guards the cookie routes. The refresh cookie is SameSite=Strict
// already; on top of that every request must carry X-Claudex-Web: 1 (a
// custom header, so a cross-site form or simple request cannot send it
// without a CORS preflight) and come from the site's own origin: Origin must
// match, or, without Origin, Sec-Fetch-Site must be same-origin.
func (c *Component) csrf(g *gin.Context) {
	if g.GetHeader(webproto.HeaderWeb) != "1" || !c.sameOrigin(g) {
		response.ErrorFrom(g, errCSRF)
		g.Abort()
		return
	}
	g.Next()
}

func (c *Component) sameOrigin(g *gin.Context) bool {
	origin := strings.TrimSpace(g.GetHeader("Origin"))
	if origin == "" {
		return g.GetHeader("Sec-Fetch-Site") == "same-origin"
	}
	if origin == "null" {
		return false
	}
	want := c.siteOrigin(g)
	return want != "" && strings.EqualFold(normalizeOrigin(origin), want)
}

// siteOrigin is the origin the web app is served from: the configured
// frontend URL, else the request's own scheme and host.
func (c *Component) siteOrigin(g *gin.Context) string {
	var configured string
	if svc := c.env.SettingService; svc != nil {
		configured = svc.GetFrontendURL(g.Request.Context())
	} else if cfg := c.env.Config; cfg != nil {
		configured = cfg.Server.FrontendURL
	}
	if o := normalizeOrigin(configured); o != "" {
		return o
	}
	host := strings.TrimSpace(g.Request.Host)
	if host == "" {
		return ""
	}
	return normalizeOrigin(c.requestScheme(g) + "://" + host)
}

// requestScheme is https when the connection is TLS, or when a trusted
// proxy (server.trusted_proxies, explicitly configured) says so with
// X-Forwarded-Proto. A client cannot claim https by itself.
func (c *Component) requestScheme(g *gin.Context) string {
	if g.Request.TLS != nil {
		return "https"
	}
	if strings.EqualFold(strings.TrimSpace(firstValue(g.GetHeader("X-Forwarded-Proto"))), "https") && c.fromTrustedProxy(g) {
		return "https"
	}
	return "http"
}

func firstValue(v string) string {
	if i := strings.IndexByte(v, ','); i >= 0 {
		return v[:i]
	}
	return v
}

func (c *Component) fromTrustedProxy(g *gin.Context) bool {
	cfg := c.env.Config
	if cfg == nil || !cfg.Server.TrustedProxiesConfigured {
		return false
	}
	remote := net.ParseIP(g.RemoteIP())
	if remote == nil {
		return false
	}
	for _, p := range cfg.Server.TrustedProxies {
		p = strings.TrimSpace(p)
		if strings.Contains(p, "/") {
			if _, n, err := net.ParseCIDR(p); err == nil && n.Contains(remote) {
				return true
			}
			continue
		}
		if ip := net.ParseIP(p); ip != nil && ip.Equal(remote) {
			return true
		}
	}
	return false
}

// normalizeOrigin returns scheme://host[:port] in lower case with the default
// port dropped, "" when raw is not an http(s) URL.
func normalizeOrigin(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil {
		return ""
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return ""
	}
	host := strings.ToLower(u.Hostname())
	port := u.Port()
	if (scheme == "https" && port == "443") || (scheme == "http" && port == "80") {
		port = ""
	}
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if port != "" {
		return scheme + "://" + host + ":" + port
	}
	return scheme + "://" + host
}

// Cookie path: the auth routes only (no trailing slash, so the refresh and
// logout requests carry it and nothing else does).
var cookiePath = strings.TrimSuffix(webproto.PathAuth, "/")

// setRefreshCookie stores the refresh token under the bare name (a browser
// signed in before several accounts were possible; sessions now use
// setAccountCookie).
func (c *Component) setRefreshCookie(g *gin.Context, token string) {
	c.setCookieNamed(g, webproto.RefreshCookie, token)
}

// setAccountCookie stores an account's refresh token in its own cookie
// (webproto.AccountCookie), so one browser can stay signed in to several.
func (c *Component) setAccountCookie(g *gin.Context, userID int64, token string) {
	c.setCookieNamed(g, webproto.AccountCookie(userID), token)
}

// setCookieNamed stores a refresh token. __Secure- cookies are always
// Secure (browsers accept them on http://localhost only).
func (c *Component) setCookieNamed(g *gin.Context, name, token string) {
	http.SetCookie(g.Writer, &http.Cookie{
		Name:     name,
		Value:    token,
		Path:     cookiePath,
		MaxAge:   int(c.refreshTTL().Seconds()),
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteStrictMode,
	})
}

func clearRefreshCookie(g *gin.Context) {
	clearCookieNamed(g, webproto.RefreshCookie)
}

func clearCookieNamed(g *gin.Context, name string) {
	http.SetCookie(g.Writer, &http.Cookie{
		Name:     name,
		Value:    "",
		Path:     cookiePath,
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteStrictMode,
	})
}

func refreshCookie(g *gin.Context) string {
	return cookieNamed(g, webproto.RefreshCookie)
}

func cookieNamed(g *gin.Context, name string) string {
	v, err := g.Cookie(name)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(v)
}
