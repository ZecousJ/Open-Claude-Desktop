package sharing

import (
	"context"
	"encoding/json"
	"net"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Where the public base URL came from (admin settings response).
const (
	BaseSourceSetting     = "setting"      // claudex_sharing.public_base_url
	BaseSourceFrontendURL = "frontend_url" // upstream frontend_url setting or config
	BaseSourceNone        = "none"         // links are paths; clients add their server address
)

// Upstream settings the component reads (never writes).
const (
	upstreamKeySiteName        = "site_name"
	upstreamKeyLegalDocuments  = "login_agreement_documents"
	usagePolicyDocumentID      = "usage-policy"
	defaultSiteName            = "Claudex"
	upstreamDefaultSiteName    = "Sub2API"
	upstreamValueCacheTTL      = 60 * time.Second
	upstreamValueCacheErrorTTL = 5 * time.Second
)

// publicBase resolves the base of public links: the sharing setting, then
// the upstream frontend URL, then "" (links are returned as paths and the
// desktop app completes them with the server address it is connected to).
// Nothing is hard-coded and links are never stored, so a new domain applies
// to every existing share at once.
func (c *Component) publicBase(ctx context.Context, s Settings) (base, source string) {
	if s.PublicBaseURL != "" {
		if _, err := parseBaseURL(s.PublicBaseURL); err == nil {
			return s.PublicBaseURL, BaseSourceSetting
		}
	}
	if c.env != nil && c.env.SettingService != nil {
		if fu := frontendBase(c.env.SettingService.GetFrontendURL(ctx)); fu != "" {
			return fu, BaseSourceFrontendURL
		}
	}
	return "", BaseSourceNone
}

// frontendBase accepts the upstream frontend URL when it is an absolute
// http(s) address without query or fragment (the administrator configured
// it for the console, so plain http is kept as is).
func frontendBase(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return ""
	}
	if s := strings.ToLower(u.Scheme); s != "https" && s != "http" {
		return ""
	}
	return strings.TrimRight(raw, "/")
}

// sharePath is the path of a share's page.
func sharePath(token string) string { return PathPrefix + "/" + token }

// joinBase appends a path to a base ("" base: the path alone).
func joinBase(base, path string) string {
	if base == "" {
		return path
	}
	return strings.TrimRight(base, "/") + path
}

// artifactPath is the path of a share's n-th artifact document.
func artifactPath(token string, n int) string {
	return sharePath(token) + "/a/" + strconv.Itoa(n)
}

// rawPath is the path of a share's n-th artifact source download.
func rawPath(token string, n int) string {
	return sharePath(token) + "/raw/" + strconv.Itoa(n)
}

// hostOf returns the lowercased host name (no port) of a base URL.
func hostOf(base string) string {
	if base == "" {
		return ""
	}
	u, err := url.Parse(base)
	if err != nil {
		return ""
	}
	return strings.ToLower(u.Hostname())
}

// originOf returns scheme://host[:port] of a base URL ("" when unusable).
func originOf(base string) string {
	u, err := url.Parse(base)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return ""
	}
	return strings.ToLower(u.Scheme) + "://" + strings.ToLower(u.Host)
}

// requestHost is the host name the visitor asked for (no port).
func requestHost(host string) string {
	host = strings.TrimSpace(host)
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	return strings.ToLower(strings.Trim(host, "[]"))
}

// usagePolicy returns the Usage Policy link of the share dialogs: the
// setting, else the server's own usage-policy legal page (/legal/usage-policy
// in the console, open to everyone) when the administrator wrote one; url is
// absolute when a public base is known, path is set for the legal page.
func (c *Component) usagePolicy(ctx context.Context, s Settings, base string) (link, path string) {
	if s.UsagePolicyURL != "" {
		return s.UsagePolicyURL, ""
	}
	if !c.upstream.hasUsagePolicy(ctx, c) {
		return "", ""
	}
	path = "/legal/" + usagePolicyDocumentID
	if base == "" {
		return "", path
	}
	return joinBase(base, path), path
}

// siteName is the upstream site name, "Claudex" when unset or still the
// upstream default.
func (c *Component) siteName(ctx context.Context) string {
	return c.upstream.siteName(ctx, c)
}

// upstreamValues caches the two upstream settings the public pages and the
// status endpoint read, so a busy public page does not query them on every
// view.
type upstreamValues struct {
	mu        sync.Mutex
	loadedAt  time.Time
	ttl       time.Duration
	site      string
	hasPolicy bool
}

func (u *upstreamValues) load(ctx context.Context, c *Component) (string, bool) {
	u.mu.Lock()
	defer u.mu.Unlock()
	now := c.now()
	if !u.loadedAt.IsZero() && now.Sub(u.loadedAt) < u.ttl {
		return u.site, u.hasPolicy
	}
	u.site, u.hasPolicy, u.ttl = defaultSiteName, false, upstreamValueCacheTTL
	if c.env != nil && c.env.SettingRepo != nil {
		failed := false
		if v, err := c.env.SettingRepo.GetValue(ctx, upstreamKeySiteName); err == nil {
			if v = strings.TrimSpace(v); v != "" && v != upstreamDefaultSiteName {
				u.site = v
			}
		} else if !isNotFound(err) {
			failed = true
		}
		if v, err := c.env.SettingRepo.GetValue(ctx, upstreamKeyLegalDocuments); err == nil {
			u.hasPolicy = hasUsagePolicyDocument(v)
		} else if !isNotFound(err) {
			failed = true
		}
		if failed {
			u.ttl = upstreamValueCacheErrorTTL
		}
	}
	u.loadedAt = now
	return u.site, u.hasPolicy
}

func (u *upstreamValues) siteName(ctx context.Context, c *Component) string {
	site, _ := u.load(ctx, c)
	return site
}

func (u *upstreamValues) hasUsagePolicy(ctx context.Context, c *Component) bool {
	_, ok := u.load(ctx, c)
	return ok
}

// hasUsagePolicyDocument reports whether the upstream legal documents
// (JSON list of {id, title, content_md}) hold a usage-policy document with
// content.
func hasUsagePolicyDocument(raw string) bool {
	var docs []struct {
		ID        string `json:"id"`
		ContentMD string `json:"content_md"`
	}
	if err := json.Unmarshal([]byte(raw), &docs); err != nil {
		return false
	}
	for _, d := range docs {
		if strings.EqualFold(strings.TrimSpace(d.ID), usagePolicyDocumentID) && strings.TrimSpace(d.ContentMD) != "" {
			return true
		}
	}
	return false
}
