package signin

import (
	"encoding/json"
	"html"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"
)

func (f *fixture) sendLink(desktop bool) (codeRequest, string) {
	f.t.Helper()
	req := codeRequest{Email: "alice@example.com", RequestID: strings.Repeat("a", 64), RequestSecret: strings.Repeat("b", 64), Desktop: desktop}
	f.c.env.Config.Server.FrontendURL = "https://claudex.example"
	body, err := json.Marshal(req)
	require.NoError(f.t, err)
	require.Equal(f.t, http.StatusOK, f.do(http.MethodPost, "/api/v1/claudex/auth/email-code/send", string(body)).status)
	f.mu.Lock()
	mail := f.mails[len(f.mails)-1].body
	f.mu.Unlock()
	match := regexp.MustCompile(`href="([^"]*#code=[^"]*)"`).FindStringSubmatch(mail)
	require.Len(f.t, match, 2)
	link := html.UnescapeString(match[1])
	parsed, err := url.Parse(link)
	require.NoError(f.t, err)
	params, err := url.ParseQuery(parsed.Fragment)
	require.NoError(f.t, err)
	require.Equal(f.t, req.Email, params.Get("email"))
	require.Equal(f.t, req.RequestID, params.Get("request_id"))
	require.Empty(f.t, params.Get("request_secret"))
	req.Code = params.Get("code")
	require.Equal(f.t, f.lastCode(), req.Code)
	req.Link = true
	return req, link
}

func (f *fixture) loginLink(req codeRequest) reply {
	f.t.Helper()
	body, err := json.Marshal(req)
	require.NoError(f.t, err)
	return f.do(http.MethodPost, "/api/v1/claudex/auth/email-code/login", string(body))
}

func TestEmailLinkBoundSingleUse(t *testing.T) {
	for _, desktop := range []bool{false, true} {
		t.Run(map[bool]string{false: "web", true: "desktop"}[desktop], func(t *testing.T) {
			f := newFixture(t, on)
			req, link := f.sendLink(desktop)
			prefix := "https://claudex.example/sign-in/callback#"
			if desktop {
				prefix = "claudex://sign-in#"
			}
			require.True(t, strings.HasPrefix(link, prefix), link)
			wrong := req
			wrong.RequestSecret = strings.Repeat("c", 64)
			for attempt := 0; attempt <= maxAttempts; attempt++ {
				require.Equal(t, ReasonInvalid, f.loginLink(wrong).reason)
			}
			wrong = req
			wrong.RequestID = strings.Repeat("d", 64)
			require.Equal(t, ReasonInvalid, f.loginLink(wrong).reason)
			wrong.RequestID = ""
			wrong.RequestSecret = ""
			require.Equal(t, ReasonBadRequest, f.loginLink(wrong).reason)
			require.Equal(t, http.StatusOK, f.loginLink(req).status)
			require.Equal(t, ReasonAlreadyUsed, f.loginLink(req).reason)
			require.Equal(t, ReasonAlreadyUsed, f.login(req.Email, req.Code).reason)
		})
	}
}

func TestEmailLinkRequestKeysAndEscaping(t *testing.T) {
	require.True(t, validRequestKey(strings.Repeat("a", 64)))
	for _, key := range []string{"", strings.Repeat("a", 63), strings.Repeat("a", 65), strings.Repeat("g", 64), strings.Repeat("A", 64)} {
		require.False(t, validRequestKey(key))
	}
	_, body := codeEmail("Claudex", "https://example.com", "123456", `https://example.com/sign-in/callback#code=123456&email=a%40b.c`)
	require.Contains(t, body, `href="https://example.com/sign-in/callback#code=123456&amp;email=a%40b.c"`)
	require.Contains(t, body, "123456")
}

func TestEmailLinkExpiryResendAndCodeFallback(t *testing.T) {
	f := newFixture(t, on)
	req, _ := f.sendLink(false)
	require.Equal(t, http.StatusTooManyRequests, f.send(req.Email).status)
	f.mr.FastForward(codeTTL)
	require.Equal(t, ReasonInvalid, f.loginLink(req).reason)
	req, _ = f.sendLink(false)
	f.mr.FastForward(sendCooldown)
	newRequest := req
	newRequest.Code = ""
	newRequest.Link = false
	newRequest.RequestID = strings.Repeat("c", 64)
	newRequest.RequestSecret = strings.Repeat("d", 64)
	body, err := json.Marshal(newRequest)
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, f.do(http.MethodPost, "/api/v1/claudex/auth/email-code/send", string(body)).status)
	require.Equal(t, ReasonInvalid, f.loginLink(req).reason)
	require.Equal(t, http.StatusOK, f.login(req.Email, f.lastCode()).status)
	newRequest.Code = f.lastCode()
	newRequest.Link = true
	require.Equal(t, ReasonAlreadyUsed, f.loginLink(newRequest).reason)
}

func TestEmailLinkConcurrentConsumptionAndTwoFactor(t *testing.T) {
	f := newFixture(t, on)
	req, _ := f.sendLink(true)
	var wait sync.WaitGroup
	results := make(chan reply, 12)
	for index := 0; index < cap(results); index++ {
		wait.Add(1)
		go func() { defer wait.Done(); results <- f.loginLink(req) }()
	}
	wait.Wait()
	close(results)
	success := 0
	for result := range results {
		if result.status == http.StatusOK {
			success++
		}
	}
	require.Equal(t, 1, success)
	f = newFixture(t, on)
	f.backend.challenge = map[string]any{"requires_2fa": true, "temp_token": "tmp"}
	req, _ = f.sendLink(false)
	result := f.loginLink(req)
	require.Equal(t, http.StatusOK, result.status)
	require.Contains(t, string(result.data), `"requires_2fa":true`)
	require.NotContains(t, string(result.data), "access_token")
}
