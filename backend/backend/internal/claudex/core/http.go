package core

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"unicode"

	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"

	"github.com/gin-gonic/gin"
)

// Subject returns the signed-in user of a JWT route.
func Subject(c *gin.Context) (userID int64, ok bool) {
	subject, ok := middleware.GetAuthSubjectFromContext(c)
	if !ok || subject.UserID <= 0 {
		return 0, false
	}
	return subject.UserID, true
}

// SessionID returns the JWT session id (refresh-token family, "sid" claim),
// "" for tokens issued without one.
func SessionID(c *gin.Context) string {
	if c == nil {
		return ""
	}
	return c.GetString(middleware.ContextKeySessionID)
}

// Claudex client headers (design 1.9).
const (
	HeaderVersion  = "X-Claudex-Version"
	HeaderPlatform = "X-Claudex-Platform"
	HeaderArch     = "X-Claudex-Arch"
	HeaderDeviceID = "X-Claudex-Device-Id"
	// HeaderClient tells the web app ("web") from the desktop app (absent).
	HeaderClient = webproto.HeaderClient
)

// ClientWeb is the only X-Claudex-Client value.
const ClientWeb = webproto.ClientName

// ValidClient checks an X-Claudex-Client value ("" is not valid).
func ValidClient(v string) bool { return v == ClientWeb }

var (
	platforms = map[string]bool{"darwin": true, "win32": true, "linux": true}
	arches    = map[string]bool{"arm64": true, "x64": true}
	uuidRe    = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
)

// ValidPlatform, ValidArch, ValidDeviceID and ValidVersion check the values
// of the X-Claudex-* headers ("" is not valid; absent headers are fine).
func ValidPlatform(v string) bool { return platforms[v] }
func ValidArch(v string) bool     { return arches[v] }
func ValidDeviceID(v string) bool { return uuidRe.MatchString(v) }

// ClientHeaders are the validated X-Claudex-* request headers.
type ClientHeaders struct {
	Platform string // darwin | win32 | linux | ""
	Arch     string // arm64 | x64 | ""
	Version  string // semver-like, <= 32 chars, or ""
	DeviceID string // UUID (panel API only), or ""
	Client   string // ClientWeb | ""
}

// ReadClientHeaders validates the X-Claudex-* headers. Missing headers are
// empty; a present but malformed header is an InvalidClientHeader error.
func ReadClientHeaders(c *gin.Context) (ClientHeaders, error) {
	var h ClientHeaders
	if c == nil || c.Request == nil {
		return h, nil
	}
	h.Platform = strings.TrimSpace(c.GetHeader(HeaderPlatform))
	h.Arch = strings.TrimSpace(c.GetHeader(HeaderArch))
	h.Version = strings.TrimSpace(c.GetHeader(HeaderVersion))
	h.DeviceID = strings.TrimSpace(c.GetHeader(HeaderDeviceID))
	h.Client = strings.TrimSpace(c.GetHeader(HeaderClient))
	switch {
	case h.Platform != "" && !ValidPlatform(h.Platform):
		return ClientHeaders{}, InvalidClientHeader(HeaderPlatform)
	case h.Arch != "" && !ValidArch(h.Arch):
		return ClientHeaders{}, InvalidClientHeader(HeaderArch)
	case h.Version != "" && !ValidVersion(h.Version):
		return ClientHeaders{}, InvalidClientHeader(HeaderVersion)
	case h.DeviceID != "" && !ValidDeviceID(h.DeviceID):
		return ClientHeaders{}, InvalidClientHeader(HeaderDeviceID)
	case h.Client != "" && !ValidClient(h.Client):
		return ClientHeaders{}, InvalidClientHeader(HeaderClient)
	}
	return h, nil
}

// ClientKind returns ClientWeb when the request comes from the web app
// (X-Claudex-Client: web), "" otherwise (desktop app, other callers; a
// malformed value counts as absent, like ClientInfo).
func ClientKind(c *gin.Context) string {
	if c == nil || c.Request == nil {
		return ""
	}
	if v := strings.TrimSpace(c.GetHeader(HeaderClient)); ValidClient(v) {
		return v
	}
	return ""
}

// ClientInfo returns the X-Claudex-* headers, with malformed values treated
// as absent (the gateway never refuses a request for them). On
// /api/v1/claudex/* routes the module already answered 400 for malformed
// headers, so there every value is valid.
func ClientInfo(c *gin.Context) (platform, arch, version, deviceID string) {
	if c == nil || c.Request == nil {
		return "", "", "", ""
	}
	if v := strings.TrimSpace(c.GetHeader(HeaderPlatform)); ValidPlatform(v) {
		platform = v
	}
	if v := strings.TrimSpace(c.GetHeader(HeaderArch)); ValidArch(v) {
		arch = v
	}
	if v := strings.TrimSpace(c.GetHeader(HeaderVersion)); ValidVersion(v) {
		version = v
	}
	if v := strings.TrimSpace(c.GetHeader(HeaderDeviceID)); ValidDeviceID(v) {
		deviceID = v
	}
	return platform, arch, version, deviceID
}

// ValidateClientHeaders answers 400 CLAUDEX_INVALID_CLIENT_HEADER for a
// malformed X-Claudex-* header. The module mounts it on the public and user
// /api/v1/claudex groups.
func ValidateClientHeaders() gin.HandlerFunc {
	return func(c *gin.Context) {
		if _, err := ReadClientHeaders(c); err != nil {
			response.ErrorFrom(c, err)
			c.Abort()
			return
		}
		c.Next()
	}
}

// ETag cache headers (design 1.10).
const (
	etagCacheControl = "private, no-cache"
	etagVary         = "Authorization, X-Claudex-Platform, X-Claudex-Arch, X-Claudex-Version, X-Claudex-Device-Id, X-Claudex-Client"
)

// WriteJSONWithETag answers v in the standard success envelope with a weak
// ETag computed from v (minus the top-level keys in ignoreTopLevelKeys, e.g.
// "generated_at"), and answers 304 without a body when If-None-Match matches.
// It sets Cache-Control: private, no-cache and Vary on Authorization and the
// X-Claudex-* headers.
func WriteJSONWithETag(c *gin.Context, v any, ignoreTopLevelKeys ...string) {
	etag, err := ETagOf(v, ignoreTopLevelKeys...)
	if err != nil {
		response.ErrorFrom(c, err)
		return
	}
	c.Header("ETag", etag)
	c.Header("Cache-Control", etagCacheControl)
	c.Header("Vary", etagVary)
	if IfNoneMatch(c.GetHeader("If-None-Match"), etag) {
		c.Status(http.StatusNotModified)
		c.Writer.WriteHeaderNow()
		return
	}
	response.Success(c, v)
}

// ETagOf returns W/"<22 base64url chars>" for the first 16 bytes of the
// SHA-256 of v's JSON, ignoring the given top-level keys.
func ETagOf(v any, ignoreTopLevelKeys ...string) (string, error) {
	data, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	if len(ignoreTopLevelKeys) > 0 {
		var obj map[string]json.RawMessage
		if err := json.Unmarshal(data, &obj); err == nil && obj != nil {
			for _, k := range ignoreTopLevelKeys {
				delete(obj, k)
			}
			if data, err = json.Marshal(obj); err != nil {
				return "", err
			}
		}
	}
	sum := sha256.Sum256(data)
	return `W/"` + base64.RawURLEncoding.EncodeToString(sum[:16]) + `"`, nil
}

// IfNoneMatch reports whether an If-None-Match header matches etag (weak
// comparison, lists and "*").
func IfNoneMatch(header, etag string) bool {
	header = strings.TrimSpace(header)
	if header == "" {
		return false
	}
	want := strings.TrimPrefix(etag, "W/")
	for _, candidate := range strings.Split(header, ",") {
		candidate = strings.TrimSpace(candidate)
		if candidate == "*" || strings.TrimPrefix(candidate, "W/") == want {
			return true
		}
	}
	return false
}

// ProtocolForPlatform maps a group platform to the desktop provider
// protocol: openai speaks Responses, everything else Chat Completions (same
// as the client's protocolFor).
func ProtocolForPlatform(platform string) string {
	if strings.EqualFold(strings.TrimSpace(platform), "openai") {
		return "responses"
	}
	return "chat"
}

// ErrInvalidURL is returned (wrapped) by HTTPSURL.
var ErrInvalidURL = errors.New("invalid URL")

// HTTPSURL validates an administrator-entered link: https only, a host, no
// user info, no spaces or control characters, at most maxLen bytes. It
// returns the trimmed URL. The server never fetches these URLs.
func HTTPSURL(raw string, maxLen int) (string, error) {
	s := strings.TrimSpace(raw)
	if s == "" || (maxLen > 0 && len(s) > maxLen) {
		return "", ErrInvalidURL
	}
	for _, r := range s {
		if unicode.IsSpace(r) || unicode.IsControl(r) {
			return "", ErrInvalidURL
		}
	}
	u, err := url.Parse(s)
	if err != nil || !strings.EqualFold(u.Scheme, "https") || u.Host == "" || u.Hostname() == "" || u.User != nil || u.Opaque != "" {
		return "", ErrInvalidURL
	}
	return s, nil
}
