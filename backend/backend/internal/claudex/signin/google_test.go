package signin

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// googleRoundTrip answers Google's token and tokeninfo endpoints in tests.
type googleRoundTrip struct {
	info     map[string]string
	status   int
	exchange url.Values
	idToken  string
}

func (g *googleRoundTrip) RoundTrip(req *http.Request) (*http.Response, error) {
	body, _ := io.ReadAll(req.Body)
	form, _ := url.ParseQuery(string(body))
	var out any
	status := http.StatusOK
	switch req.URL.String() {
	case googleTokenURL:
		g.exchange = form
		out = map[string]string{"id_token": g.idToken}
	case googleTokenInfoURL:
		if g.status != 0 {
			status = g.status
		}
		out = g.info
	}
	data, _ := json.Marshal(out)
	return &http.Response{
		StatusCode: status,
		Body:       io.NopCloser(strings.NewReader(string(data))),
		Header:     http.Header{"Content-Type": {"application/json"}},
	}, nil
}

// oauthBackend resolves Google identities to the fixture's users.
type oauthBackend struct {
	*fakeBackend
	identities []service.EmailOAuthIdentityInput
}

func (o *oauthBackend) OAuthUser(_ *gin.Context, id service.EmailOAuthIdentityInput) (*service.User, error) {
	o.identities = append(o.identities, id)
	return &service.User{ID: 7, Email: id.Email, Status: service.StatusActive}, nil
}

func googleFixture(t *testing.T, cfg GoogleConfig, trip *googleRoundTrip) (*fixture, *oauthBackend) {
	f := newFixture(t, nil)
	backend := &oauthBackend{fakeBackend: f.backend}
	f.c.backend = backend
	f.c.googleConfig = &cfg
	f.c.googleHTTP = &http.Client{Transport: trip}
	return f, backend
}

func validInfo(aud string) map[string]string {
	return map[string]string{
		"aud":            aud,
		"iss":            "https://accounts.google.com",
		"exp":            strconv.FormatInt(time.Now().Add(time.Hour).Unix(), 10),
		"sub":            "1234567890",
		"email":          "Alice@Example.com",
		"email_verified": "true",
		"name":           "Alice",
	}
}

func TestGoogleSignInWithAWebIDToken(t *testing.T) {
	trip := &googleRoundTrip{info: validInfo("web-client")}
	f, backend := googleFixture(t, GoogleConfig{WebClientID: "web-client", WebClientSecret: "w3b"}, trip)

	r := f.do(http.MethodPost, "/api/v1/claudex/auth/google/login", `{"id_token":"tok"}`)
	require.Equal(t, http.StatusOK, r.status, r.reason)
	require.Contains(t, string(r.data), `"access_token":"at"`)
	require.Len(t, backend.identities, 1)
	require.Equal(t, "google", backend.identities[0].ProviderType)
	require.Equal(t, "1234567890", backend.identities[0].ProviderSubject)
	require.Equal(t, "alice@example.com", backend.identities[0].Email)
	// CodeLogin ran: TOTP and the login checks apply.
	require.Equal(t, []int64{7}, f.backend.codeUsers)

	// The options name the web client; no desktop secret, no desktop client.
	opts := f.do(http.MethodGet, "/api/v1/claudex/sign-in/options", "")
	require.Contains(t, string(opts.data), `"google_client_id":"web-client"`)
	require.NotContains(t, string(opts.data), "google_desktop_client_id")
}

func TestGoogleSignInRefusesOtherClientsUnverifiedAndExpired(t *testing.T) {
	cases := map[string]struct {
		info   map[string]string
		reason string
	}{
		"other client": {info: validInfo("someone-else"), reason: ReasonGoogleInvalid},
		"unverified": {info: func() map[string]string {
			i := validInfo("web-client")
			i["email_verified"] = "false"
			return i
		}(), reason: ReasonGoogleUnverified},
		"expired": {info: func() map[string]string {
			i := validInfo("web-client")
			i["exp"] = strconv.FormatInt(time.Now().Add(-time.Minute).Unix(), 10)
			return i
		}(), reason: ReasonGoogleInvalid},
		"wrong issuer": {info: func() map[string]string {
			i := validInfo("web-client")
			i["iss"] = "https://evil.example"
			return i
		}(), reason: ReasonGoogleInvalid},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			f, backend := googleFixture(t, GoogleConfig{WebClientID: "web-client"}, &googleRoundTrip{info: tc.info})
			r := f.do(http.MethodPost, "/api/v1/claudex/auth/google/login", `{"id_token":"tok"}`)
			require.Equal(t, tc.reason, r.reason)
			require.Empty(t, backend.identities)
		})
	}
	// Google refusing the token.
	f, _ := googleFixture(t, GoogleConfig{WebClientID: "web-client"}, &googleRoundTrip{status: http.StatusBadRequest})
	require.Equal(t, ReasonGoogleInvalid, f.do(http.MethodPost, "/api/v1/claudex/auth/google/login", `{"id_token":"tok"}`).reason)
	// Not configured.
	off, _ := googleFixture(t, GoogleConfig{}, &googleRoundTrip{})
	require.Equal(t, ReasonGoogleDisabled, off.do(http.MethodPost, "/api/v1/claudex/auth/google/login", `{"id_token":"tok"}`).reason)
}

func TestGoogleSignInExchangesTheWebPopupCode(t *testing.T) {
	trip := &googleRoundTrip{info: validInfo("web-client"), idToken: "web-id-token"}
	f, backend := googleFixture(t, GoogleConfig{WebClientID: "web-client", WebClientSecret: "w3b"}, trip)
	r := f.do(http.MethodPost, "/api/v1/claudex/auth/google/login", `{"code":"popup-code","redirect_uri":"postmessage"}`)
	require.Equal(t, http.StatusOK, r.status, r.reason)
	require.Equal(t, "popup-code", trip.exchange.Get("code"))
	require.Equal(t, "postmessage", trip.exchange.Get("redirect_uri"))
	require.Equal(t, "web-client", trip.exchange.Get("client_id"))
	require.Equal(t, "w3b", trip.exchange.Get("client_secret"))
	require.Empty(t, trip.exchange.Get("code_verifier"))
	require.Len(t, backend.identities, 1)
	opts := f.do(http.MethodGet, "/api/v1/claudex/sign-in/options", "")
	require.Contains(t, string(opts.data), `"google_client_id":"web-client"`)
	require.NotContains(t, string(opts.data), "w3b")

	// Without the web secret the popup's code can't be exchanged.
	off, _ := googleFixture(t, GoogleConfig{WebClientID: "web-client"}, &googleRoundTrip{})
	require.Equal(t, ReasonGoogleDisabled, off.do(http.MethodPost, "/api/v1/claudex/auth/google/login", `{"code":"c","redirect_uri":"postmessage"}`).reason)
}

func TestGoogleSignInExchangesTheDesktopCode(t *testing.T) {
	trip := &googleRoundTrip{info: validInfo("desktop-client"), idToken: "desktop-id-token"}
	f, backend := googleFixture(t, GoogleConfig{DesktopClientID: "desktop-client", DesktopClientSecret: "s3cret"}, trip)
	verifier := strings.Repeat("v", 50)
	r := f.do(http.MethodPost, "/api/v1/claudex/auth/google/login",
		`{"code":"auth-code","code_verifier":"`+verifier+`","redirect_uri":"http://127.0.0.1:53682/callback"}`)
	require.Equal(t, http.StatusOK, r.status, r.reason)
	require.Equal(t, "auth-code", trip.exchange.Get("code"))
	require.Equal(t, verifier, trip.exchange.Get("code_verifier"))
	require.Equal(t, "desktop-client", trip.exchange.Get("client_id"))
	require.Equal(t, "s3cret", trip.exchange.Get("client_secret"))
	require.Len(t, backend.identities, 1)

	// Only a loopback redirect and a real PKCE verifier pass.
	bad := f.do(http.MethodPost, "/api/v1/claudex/auth/google/login",
		`{"code":"c","code_verifier":"`+verifier+`","redirect_uri":"https://evil.example/cb"}`)
	require.Equal(t, ReasonGoogleInvalid, bad.reason)
	short := f.do(http.MethodPost, "/api/v1/claudex/auth/google/login",
		`{"code":"c","code_verifier":"short","redirect_uri":"http://127.0.0.1:1/"}`)
	require.Equal(t, ReasonGoogleInvalid, short.reason)

	opts := f.do(http.MethodGet, "/api/v1/claudex/sign-in/options", "")
	require.Contains(t, string(opts.data), `"google_desktop_client_id":"desktop-client"`)
	require.NotContains(t, string(opts.data), "s3cret")
}
