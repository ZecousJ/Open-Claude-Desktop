package core

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/server/middleware"

	"github.com/alicebob/miniredis/v2"
	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
)

func init() { gin.SetMode(gin.TestMode) }

type envelope struct {
	Code     any               `json:"code"`
	Message  string            `json:"message"`
	Reason   string            `json:"reason"`
	Metadata map[string]string `json:"metadata"`
	Data     json.RawMessage   `json:"data"`
}

func TestWriteJSONWithETag(t *testing.T) {
	payload := map[string]any{"generated_at": "2026-09-26T02:30:00Z", "policy": map[string]any{"revision": 17}}
	r := gin.New()
	r.GET("/x", func(c *gin.Context) { WriteJSONWithETag(c, payload, "generated_at") })

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/x", nil))
	require.Equal(t, http.StatusOK, rec.Code)
	etag := rec.Header().Get("ETag")
	require.Regexp(t, `^W/"[A-Za-z0-9_-]{22}"$`, etag)
	require.Equal(t, "private, no-cache", rec.Header().Get("Cache-Control"))
	require.Equal(t, "Authorization, X-Claudex-Platform, X-Claudex-Arch, X-Claudex-Version, X-Claudex-Device-Id, X-Claudex-Client", rec.Header().Get("Vary"))
	var env envelope
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &env))
	require.JSONEq(t, `{"generated_at":"2026-09-26T02:30:00Z","policy":{"revision":17}}`, string(env.Data))

	// Same content with a different generated_at: same ETag, 304 without a body.
	payload["generated_at"] = "2026-09-26T03:00:00Z"
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.Header.Set("If-None-Match", etag)
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	require.Equal(t, http.StatusNotModified, rec.Code)
	require.Empty(t, rec.Body.Bytes())
	require.Equal(t, etag, rec.Header().Get("ETag"))

	// Changed content: new ETag, full answer.
	payload["policy"] = map[string]any{"revision": 18}
	req = httptest.NewRequest(http.MethodGet, "/x", nil)
	req.Header.Set("If-None-Match", etag)
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)
	require.NotEqual(t, etag, rec.Header().Get("ETag"))

	// Without ignored keys generated_at counts.
	a, err := ETagOf(map[string]any{"generated_at": "1", "x": 1})
	require.NoError(t, err)
	b, err := ETagOf(map[string]any{"generated_at": "2", "x": 1})
	require.NoError(t, err)
	require.NotEqual(t, a, b)
}

func TestIfNoneMatch(t *testing.T) {
	etag := `W/"abc"`
	require.True(t, IfNoneMatch(`W/"abc"`, etag))
	require.True(t, IfNoneMatch(`"abc"`, etag))
	require.True(t, IfNoneMatch(`W/"zzz", W/"abc"`, etag))
	require.True(t, IfNoneMatch(`*`, etag))
	require.False(t, IfNoneMatch(``, etag))
	require.False(t, IfNoneMatch(`W/"abd"`, etag))
}

func headerRequest(headers map[string]string) *gin.Context {
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodGet, "/api/v1/claudex/bootstrap", nil)
	for k, v := range headers {
		c.Request.Header.Set(k, v)
	}
	return c
}

func TestClientHeaders(t *testing.T) {
	valid := map[string]string{
		HeaderPlatform: "darwin", HeaderArch: "arm64", HeaderVersion: "1.3.2-beta.1+build.5",
		HeaderDeviceID: "6f1c2a4e-9b0d-4c1e-8a57-2f3b9d0c7e11",
	}
	h, err := ReadClientHeaders(headerRequest(valid))
	require.NoError(t, err)
	require.Equal(t, ClientHeaders{Platform: "darwin", Arch: "arm64", Version: "1.3.2-beta.1+build.5", DeviceID: "6f1c2a4e-9b0d-4c1e-8a57-2f3b9d0c7e11"}, h)
	p, a, v, d := ClientInfo(headerRequest(valid))
	require.Equal(t, []string{"darwin", "arm64", "1.3.2-beta.1+build.5", "6f1c2a4e-9b0d-4c1e-8a57-2f3b9d0c7e11"}, []string{p, a, v, d})

	h, err = ReadClientHeaders(headerRequest(nil))
	require.NoError(t, err)
	require.Equal(t, ClientHeaders{}, h)

	for header, bad := range map[string]string{
		HeaderPlatform: "macos", HeaderArch: "amd64", HeaderVersion: strings.Repeat("1", 33),
		HeaderDeviceID: "not-a-uuid",
	} {
		_, err := ReadClientHeaders(headerRequest(map[string]string{header: bad}))
		require.Error(t, err, header)
		// The lenient reader treats the malformed value as absent.
		p, a, v, d := ClientInfo(headerRequest(map[string]string{header: bad}))
		require.Equal(t, "", p+a+v+d, header)
	}

	r := gin.New()
	r.Use(ValidateClientHeaders())
	r.GET("/x", func(c *gin.Context) { c.Status(http.StatusNoContent) })
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.Header.Set(HeaderPlatform, "beos")
	r.ServeHTTP(rec, req)
	require.Equal(t, http.StatusBadRequest, rec.Code)
	var env envelope
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &env))
	require.Equal(t, "CLAUDEX_INVALID_CLIENT_HEADER", env.Reason)
	require.Equal(t, HeaderPlatform, env.Metadata["header"])
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/x", nil))
	require.Equal(t, http.StatusNoContent, rec.Code)
}

func TestSubjectAndSessionID(t *testing.T) {
	c := headerRequest(nil)
	_, ok := Subject(c)
	require.False(t, ok)
	require.Equal(t, "", SessionID(c))
	c.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: 42})
	c.Set(middleware.ContextKeySessionID, "family-1")
	id, ok := Subject(c)
	require.True(t, ok)
	require.Equal(t, int64(42), id)
	require.Equal(t, "family-1", SessionID(c))
}

func TestCompareVersions(t *testing.T) {
	for _, tc := range []struct {
		a, b string
		want int
	}{
		{"1.2.0", "1.2.0", 0},
		{"1.2", "1.2.0", 0},
		{"1.2.0", "1.10.0", -1},
		{"1.2.0-beta.1", "1.2.0", -1},
		{"1.2.0", "1.2.0-beta.1", 1},
		{"1.2.0-alpha", "1.2.0-beta", -1},
		{"1.2.0-beta.2", "1.2.0-beta.11", -1},
		{"1.2.0-beta", "1.2.0-beta.1", -1},
		{"1.2.0-1", "1.2.0-alpha", -1},
		{"0.2.8+claudex.1", "0.2.8", 0},
		{"0.2.8+claudex.1", "0.2.8+claudex.3", 0},
		{"0.2.8+claudex.1", "0.2.9", -1},
		{"1.0.0.1", "1.0.0", 1},
		{"garbage", "0.0.1", -1},
		{"0.0.1", "garbage", 1},
		{"", "0.0.0", -1},
	} {
		require.Equal(t, tc.want, CompareVersions(tc.a, tc.b), "%s vs %s", tc.a, tc.b)
	}
	require.True(t, ValidVersion("1.4.0"))
	require.True(t, ValidVersion("0.2.8+claudex.1"))
	require.False(t, ValidVersion("v1.4.0"))
	require.False(t, ValidVersion("1.4.0.1.2"))
}

func TestHTTPSURL(t *testing.T) {
	got, err := HTTPSURL("  https://dl.example.com/Claudex-1.4.0-arm64.zip  ", 2000)
	require.NoError(t, err)
	require.Equal(t, "https://dl.example.com/Claudex-1.4.0-arm64.zip", got)
	for _, bad := range []string{
		"", "http://dl.example.com/x", "https://user:pw@dl.example.com/x", "https:///x", "javascript:alert(1)",
		"https://dl.example.com/a b", "https://dl.example.com/\x00", "ftp://x", "//dl.example.com/x",
		"https://" + strings.Repeat("a", 2000) + ".com",
	} {
		_, err := HTTPSURL(bad, 2000)
		require.ErrorIs(t, err, ErrInvalidURL, bad)
	}
}

func TestProtocolForPlatform(t *testing.T) {
	require.Equal(t, "responses", ProtocolForPlatform("openai"))
	for _, p := range []string{"anthropic", "gemini", "grok", ""} {
		require.Equal(t, "chat", ProtocolForPlatform(p))
	}
}

func TestCheckSectionOwnership(t *testing.T) {
	require.NoError(t, CheckSectionOwnership(map[string][]string{
		NameDevices: {SectionPlan, SectionDevice}, NamePolicy: {SectionPolicy},
	}))
	require.ErrorContains(t, CheckSectionOwnership(map[string][]string{NamePolicy: {SectionModels}}), "belongs to")
	require.ErrorContains(t, CheckSectionOwnership(map[string][]string{NamePolicy: {"server"}}), "unknown")
	require.ErrorContains(t, CheckSectionOwnership(map[string][]string{NamePolicy: {SectionPolicy, SectionPolicy}}), "twice")
	for section, owner := range SectionOwners {
		require.NotEmpty(t, owner, section)
	}
}

func TestEnvHeavyLimiter(t *testing.T) {
	env := &Env{}
	r := gin.New()
	r.GET("/x", env.Heavy(), func(c *gin.Context) { c.Status(http.StatusNoContent) })
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/x", nil))
	require.Equal(t, http.StatusNoContent, rec.Code, "no limiter: pass through")

	// The limiter can be set after the route was registered.
	env.SetHeavy(func(c *gin.Context) { c.AbortWithStatus(http.StatusTooManyRequests) })
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/x", nil))
	require.Equal(t, http.StatusTooManyRequests, rec.Code)

	var nilEnv *Env
	require.False(t, nilEnv.Installed("x"))
	require.NotNil(t, nilEnv.Heavy())
}

func TestRateLimitPerUser(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })
	env := &Env{Deps: Deps{Redis: rdb}}

	r := gin.New()
	r.Use(func(c *gin.Context) {
		if id := c.GetHeader("X-User"); id != "" {
			uid := int64(1)
			if id == "2" {
				uid = 2
			}
			c.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: uid})
		}
		c.Next()
	})
	r.POST("/devices", env.RateLimitPerUser("devices.register", 2, time.Minute), func(c *gin.Context) { c.Status(http.StatusNoContent) })
	call := func(user string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/devices", nil)
		if user != "" {
			req.Header.Set("X-User", user)
		}
		r.ServeHTTP(rec, req)
		return rec
	}
	require.Equal(t, http.StatusNoContent, call("1").Code)
	require.Equal(t, http.StatusNoContent, call("1").Code)
	rec := call("1")
	require.Equal(t, http.StatusTooManyRequests, rec.Code)
	require.NotEmpty(t, rec.Header().Get("Retry-After"))
	var env429 envelope
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &env429))
	require.Equal(t, "CLAUDEX_RATE_LIMITED", env429.Reason)
	require.Equal(t, http.StatusNoContent, call("2").Code, "counted per user")
	require.Equal(t, http.StatusNoContent, call("").Code, "no subject: not limited")

	// Redis down: fail open.
	mr.Close()
	require.Equal(t, http.StatusNoContent, call("1").Code)
	allowed, _ := Allow(context.Background(), nil, "k", 1, time.Minute)
	require.True(t, allowed, "no Redis: allowed")
}
