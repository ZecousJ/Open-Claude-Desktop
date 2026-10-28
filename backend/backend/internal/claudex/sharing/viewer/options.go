package viewer

import (
	"net/url"
	"strings"
)

// Options are the settings a page is rendered with. The sharing component
// builds them from claudex_sharing and the public settings on every request,
// so an administrator's change applies at once.
type Options struct {
	ScreenshotURL string
	ArtifactURL   string
	RawURL        string
	FrameSource   string
	// SiteName is shown in the top bar and the footer ("" = "Claudex").
	SiteName string
	// PublicBaseURL is the effective public base URL of the share pages
	// (claudex_sharing.public_base_url, else the frontend URL, else "").
	// It only feeds security headers; links inside pages stay relative, so
	// a reverse-proxy prefix keeps working.
	PublicBaseURL string
	// ContentBaseURL is the optional separate origin for artifact content
	// (claudex_sharing.content_base_url). It is honoured only together with
	// PublicBaseURL on a different host: artifact documents, sources and the
	// Mermaid runtime then answer only on that host, and pages never do.
	ContentBaseURL string
	// UsagePolicyURL is linked from the footer when it is an https URL or a
	// path on this server ("/legal/<document>", the fallback the component
	// uses when no URL is configured). Anything else hides the link.
	UsagePolicyURL string
	// AllowReports shows the Report form and accepts POST /s/<token>/report
	// (claudex_sharing.allow_reports; the component must also implement
	// Reporter).
	AllowReports bool
}

// base is a parsed base URL: origin (scheme://host[:port]) and path prefix
// without a trailing slash.
type base struct {
	origin string
	host   string
	path   string
}

func parseBase(raw string) (base, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return base{}, false
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || u.User != nil {
		return base{}, false
	}
	return base{
		origin: u.Scheme + "://" + strings.ToLower(u.Host),
		host:   normalizeHost(u.Host, u.Scheme),
		path:   strings.TrimRight(u.EscapedPath(), "/"),
	}, true
}

// normalizeHost lower-cases a host and drops the scheme's default port.
func normalizeHost(host, scheme string) string {
	host = strings.ToLower(strings.TrimSpace(host))
	switch {
	case scheme == "https" && strings.HasSuffix(host, ":443"):
		host = strings.TrimSuffix(host, ":443")
	case scheme == "http" && strings.HasSuffix(host, ":80"):
		host = strings.TrimSuffix(host, ":80")
	}
	return host
}

// resolved is Options after validation.
type resolved struct {
	siteName    string
	public      base
	hasPublic   bool
	content     base
	hasContent  bool
	usagePolicy string
	reports     bool
}

func resolve(o Options) resolved {
	r := resolved{siteName: plainText(o.SiteName, 60), reports: o.AllowReports}
	if r.siteName == "" {
		r.siteName = "Claudex"
	}
	r.public, r.hasPublic = parseBase(o.PublicBaseURL)
	if r.hasPublic {
		if c, ok := parseBase(o.ContentBaseURL); ok && c.host != r.public.host {
			r.content, r.hasContent = c, true
		}
	}
	r.usagePolicy = usagePolicyLink(o.UsagePolicyURL)
	return r
}

// usagePolicyLink accepts an https URL or a root-relative path on this
// server (not "//host" or "/\\host", which browsers treat as another host).
func usagePolicyLink(raw string) string {
	raw = strings.TrimSpace(raw)
	if u, ok := safeURL(raw); ok && strings.HasPrefix(u, "https://") {
		return u
	}
	if len(raw) < 2 || len(raw) > 2048 || raw[0] != '/' || raw[1] == '/' || raw[1] == '\\' {
		return ""
	}
	for _, c := range raw {
		if c < 0x21 || c == 0x7f || c == '\\' || c == '"' || c == '<' || c == '>' {
			return ""
		}
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "" || u.Host != "" || u.User != nil {
		return ""
	}
	return u.String()
}

// isContentHost reports whether a request arrived on the separate content
// host. The request's Host may carry either scheme's default port behind a
// TLS-terminating proxy, so both are dropped before comparing.
func (r resolved) isContentHost(requestHost string) bool {
	if !r.hasContent {
		return false
	}
	return normalizeHost(requestHost, "https") == r.content.host || normalizeHost(requestHost, "http") == r.content.host
}
