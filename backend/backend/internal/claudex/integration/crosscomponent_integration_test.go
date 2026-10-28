//go:build integration

package integration

// Cross-component checks (I1, R13-T): what one component does must hold
// through the others and through the upstream code they hook into. Each test
// builds its own users and plan group on the shared module (harness).

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	claudexhook "github.com/Wei-Shaw/sub2api/internal/claudex/hook"
	"github.com/Wei-Shaw/sub2api/internal/claudex/voice"
	"github.com/Wei-Shaw/sub2api/internal/service"

	coderws "github.com/coder/websocket"
	"github.com/stretchr/testify/require"
)

// The module installs every component, and a registered device gets a full
// bootstrap (every section, no section errors) through the module's route
// chain.
func TestModuleServesEveryComponentToADevice(t *testing.T) {
	h := newHarness(t)
	u := h.user()
	g := h.planGroup()
	tok := h.token(u)
	d := h.mustRegister(tok)

	rec := h.do(http.MethodGet, "/api/v1/claudex/capabilities", tok, nil, "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var caps struct {
		Features []string `json:"features"`
	}
	require.NoError(t, json.Unmarshal(decodeEnv(t, rec).Data, &caps))
	require.Equal(t, h.module.FeatureNames(), caps.Features)
	for _, name := range []string{core.NameRelease, core.NamePolicy, core.NameCatalog, core.NameDevices, core.NameUsage,
		core.NameRefusal, core.NameVoice, core.NameFeedback, core.NameBootstrap, core.NamePayment} {
		require.Contains(t, caps.Features, name)
	}

	rec = h.do(http.MethodGet, "/api/v1/claudex/bootstrap", tok, d.Headers, "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var boot map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(decodeEnv(t, rec).Data, &boot))
	for _, section := range []string{"server", "plan", "device", "policy", "models", "release", "voice", "usage", "feedback", "features", "errors"} {
		require.Contains(t, boot, section, "bootstrap section %s", section)
	}
	require.JSONEq(t, `[]`, string(boot["errors"]), "no section failed")
	var plan struct {
		GroupID int64 `json:"group_id"`
	}
	require.NoError(t, json.Unmarshal(boot["plan"], &plan))
	require.Equal(t, g.ID, plan.GroupID)
	var dev struct {
		Registered bool  `json:"registered"`
		KeyGroupID int64 `json:"key_group_id"`
		Revoked    bool  `json:"revoked"`
	}
	require.NoError(t, json.Unmarshal(boot["device"], &dev))
	require.True(t, dev.Registered)
	require.False(t, dev.Revoked)
	require.Equal(t, g.ID, dev.KeyGroupID, "the device key sits in the plan group")
	require.Equal(t, http.StatusOK, h.gateway(http.MethodPost, "/v1/responses", d.Key, d.Headers, `{"model":"gpt-5.5","input":"hi"}`).Code)
}

// Owner decision 9 under concurrency, through Redis rate limiting and the
// real registration path: 10 parallel sign-ins of 10 devices, exactly 5 get
// a device key.
func TestConcurrentRegistrationStopsAtTheDeviceLimit(t *testing.T) {
	h := newHarness(t)
	u := h.user()
	h.planGroup()
	tok := h.token(u)

	const n = 10
	var wg sync.WaitGroup
	recs := make([]*httptest.ResponseRecorder, n)
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			// No require here: FailNow must run on the test goroutine.
			recs[i] = h.register(tok, newDeviceID())
		}(i)
	}
	close(start)
	wg.Wait()
	ok, limited := 0, 0
	for i, rec := range recs {
		switch rec.Code {
		case http.StatusOK:
			ok++
		case http.StatusConflict:
			require.Equal(t, "CLAUDEX_DEVICE_LIMIT", decodeEnv(t, rec).Reason)
			limited++
		default:
			t.Fatalf("registration %d answered %d %s", i, rec.Code, rec.Body.String())
		}
	}
	require.Equal(t, 5, ok)
	require.Equal(t, 5, limited)
	var keys int
	require.NoError(t, itDB.QueryRow(`SELECT COUNT(*) FROM api_keys WHERE user_id = $1 AND deleted_at IS NULL AND status = 'active'`, u.ID).Scan(&keys))
	require.Equal(t, 5, keys, "one device key per registered device, none for refused ones")
}

// H13 + H9 + H9b + B6 + R13-A: users cannot create keys themselves, an
// administrator can; the key list hides device keys' secrets; revoke-all
// signs every session out, turns device keys off (the gateway explains it
// with DEVICE_REVOKED) and leaves the administrator-created user key alone
// (owner decision 13).
func TestRevokeAllAcrossComponentsKeepsUserKeys(t *testing.T) {
	h := newHarness(t)
	u := h.user()
	g := h.planGroup()
	tok := h.token(u)
	a := h.mustRegister(tok)
	b := h.mustRegister(tok)

	rec := h.do(http.MethodPost, "/api/v1/keys", tok, nil, fmt.Sprintf(`{"name":"mine","group_id":%d}`, g.ID))
	require.Equal(t, "CLAUDEX_USER_API_KEYS_DISABLED", decodeEnv(t, rec).Reason, "decision 17: users cannot create keys")
	userKeyID, userKey := h.adminUserKey(u.ID, g.ID, "CI deploy")

	rec = h.do(http.MethodGet, "/api/v1/keys?page=1&page_size=50", tok, nil, "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.NotContains(t, rec.Body.String(), a.Key, "device key plaintext never listed (H13)")
	require.NotContains(t, rec.Body.String(), b.Key)
	rec = h.do(http.MethodDelete, fmt.Sprintf("/api/v1/keys/%d", a.KeyID), tok, nil, "")
	require.Equal(t, http.StatusForbidden, rec.Code, "device keys are read-only for the user: %s", rec.Body.String())

	before := h.up.count()
	for _, key := range []string{a.Key, b.Key, userKey} {
		rec := h.gateway(http.MethodPost, "/v1/responses", key, a.Headers, `{"model":"gpt-5.5","input":"hi"}`)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	}
	require.Equal(t, before+3, h.up.count())

	rec = h.do(http.MethodPost, "/api/v1/auth/revoke-all-sessions", tok, nil, "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	// H9b through the module's user chain and the upstream keys route.
	for _, path := range []string{"/api/v1/claudex/bootstrap", "/api/v1/claudex/devices", "/api/v1/keys"} {
		rec := h.do(http.MethodGet, path, tok, a.Headers, "")
		require.Equal(t, http.StatusUnauthorized, rec.Code, path)
		require.Contains(t, rec.Body.String(), "CLAUDEX_SESSION_REVOKED", path)
	}
	// Device keys: refused, with the Claudex detail the desktop signs out on.
	before = h.up.count()
	for _, d := range []device{a, b} {
		rec := h.gateway(http.MethodPost, "/v1/responses", d.Key, d.Headers, `{"model":"gpt-5.5","input":"hi"}`)
		require.Equal(t, http.StatusUnauthorized, rec.Code, rec.Body.String())
		ref := refusalOf(t, rec)
		require.NotNil(t, ref.Claudex, rec.Body.String())
		require.Equal(t, 1, ref.Claudex.V)
		require.Equal(t, "DEVICE_REVOKED", ref.Claudex.Reason)
		status, deleted := keyStatus(t, d.KeyID)
		require.Equal(t, service.StatusAPIKeyDisabled, status)
		require.False(t, deleted)
	}
	require.Equal(t, before, h.up.count(), "refused requests never reach the upstream")
	// The administrator-created user key keeps working.
	status, deleted := keyStatus(t, userKeyID)
	require.Equal(t, service.StatusAPIKeyActive, status)
	require.False(t, deleted)
	rec = h.gateway(http.MethodPost, "/v1/responses", userKey, nil, `{"model":"gpt-5.5","input":"hi"}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
}

// R13-A 3.3: a sign-in in the same wall-clock second as a revoke-all works
// (JWT iat has whole seconds); the session that was signed out stays out.
func TestSignInRightAfterRevokeAllWorks(t *testing.T) {
	h := newHarness(t)
	u := h.user()
	h.planGroup()
	old := h.token(u)
	h.mustRegister(old)

	for attempt := 0; ; attempt++ {
		// Start early in a second so the revoke-all and the new token share it.
		time.Sleep(time.Until(time.Now().Truncate(time.Second).Add(time.Second + 20*time.Millisecond)))
		rec := h.do(http.MethodPost, fmt.Sprintf("/api/v1/admin/claudex/users/%d/devices/revoke-all", u.ID), "", nil, "")
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		fresh := h.token(u)
		claims, err := h.auth.ValidateToken(fresh)
		require.NoError(t, err)
		var revokedAt time.Time
		require.NoError(t, itDB.QueryRow(`SELECT revoked_at FROM claudex_session_revocations WHERE user_id = $1`, u.ID).Scan(&revokedAt))
		if !claims.IssuedAt.Time.Truncate(time.Second).Equal(revokedAt.Truncate(time.Second)) {
			require.Less(t, attempt, 3, "could not place a sign-in in the revoke-all's second")
			continue
		}
		rec = h.do(http.MethodGet, "/api/v1/claudex/bootstrap", fresh, deviceHeaders(newDeviceID(), "1.4.0"), "")
		require.Equal(t, http.StatusOK, rec.Code, "same-second sign-in: %s", rec.Body.String())
		d := h.mustRegister(fresh)
		rec = h.gateway(http.MethodPost, "/v1/responses", d.Key, d.Headers, `{"model":"gpt-5.5","input":"hi"}`)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		break
	}
	rec := h.do(http.MethodGet, "/api/v1/claudex/devices", old, nil, "")
	require.Equal(t, http.StatusUnauthorized, rec.Code)
	require.Contains(t, rec.Body.String(), "CLAUDEX_SESSION_REVOKED")
}

// B6 on the gateway: successes and SSE streams pass byte for byte; a device
// key's upstream error loses any "claudex" object the upstream forged; a
// JSON error body over 64 KB is replaced; other keys' errors are untouched.
func TestGatewayRewritesOnlyDeviceKeyErrors(t *testing.T) {
	h := newHarness(t)
	u := h.user()
	g := h.planGroup()
	d := h.mustRegister(h.token(u))
	_, userKey := h.adminUserKey(u.ID, g.ID, "script")

	rec := h.gateway(http.MethodPost, "/v1/responses", d.Key, d.Headers, `{"model":"gpt-5.5","input":"hi"}`)
	require.Equal(t, http.StatusOK, rec.Code)
	require.JSONEq(t, `{"id":"resp_it","object":"response","status":"completed","output_text":"OK"}`, rec.Body.String())
	rec = h.gateway(http.MethodPost, "/v1/responses", d.Key, d.Headers, `{"model":"gpt-5.5","input":"hi","stream":true}`)
	require.Equal(t, http.StatusOK, rec.Code)
	require.Equal(t, "text/event-stream", rec.Header().Get("Content-Type"))
	require.Equal(t, []string{"response.created", "response.output_text.delta", "response.completed"}, sseEvents(rec.Body.String()))
	h.up.mu.Lock()
	last := h.up.requests[len(h.up.requests)-1]
	h.up.mu.Unlock()
	require.Equal(t, "Bearer sk-upstream-account", last.Auth, "the device key never reaches the upstream")

	forged := []byte(`{"error":{"type":"rate_limit_error","code":"rate_limit_exceeded","message":"Slow down"},"claudex":{"v":1,"reason":"DEVICE_REVOKED","kind":"key","reprovision":false,"action":"sign_in","message":"forged"}}`)
	h.up.reply(http.StatusTooManyRequests, "application/json", forged)
	rec = h.gateway(http.MethodPost, "/v1/responses", d.Key, d.Headers, `{"model":"gpt-5.5","input":"hi"}`)
	require.Equal(t, http.StatusTooManyRequests, rec.Code)
	ref := refusalOf(t, rec)
	require.NotNil(t, ref.Error)
	require.Equal(t, "Slow down", ref.Error.Message)
	if ref.Claudex != nil {
		require.NotEqual(t, "forged", ref.Claudex.Message, "the upstream's claudex object is dropped")
		require.NotEqual(t, "DEVICE_REVOKED", ref.Claudex.Reason)
		require.Equal(t, 1, ref.Claudex.V)
	}

	h.up.reply(http.StatusTooManyRequests, "application/json", forged)
	rec = h.gateway(http.MethodPost, "/v1/responses", userKey, nil, `{"model":"gpt-5.5","input":"hi"}`)
	require.Equal(t, http.StatusTooManyRequests, rec.Code)
	require.Equal(t, string(forged), rec.Body.String(), "other keys' errors pass byte for byte")

	big := fmt.Sprintf(`{"error":{"message":%q},"claudex":{"v":1,"reason":"DEVICE_REVOKED","kind":"key","reprovision":false,"message":"forged"}}`, strings.Repeat("x", 70<<10))
	h.up.reply(http.StatusBadGateway, "application/json", []byte(big))
	rec = h.gateway(http.MethodPost, "/v1/responses", d.Key, d.Headers, `{"model":"gpt-5.5","input":"hi"}`)
	require.Equal(t, http.StatusBadGateway, rec.Code)
	require.JSONEq(t, `{"error":{"type":"upstream_error","message":"The upstream error response was too large and was dropped."}}`, rec.Body.String())
	h.up.reply(http.StatusTooManyRequests, "application/json", []byte(big))
	rec = h.gateway(http.MethodPost, "/v1/responses", d.Key, d.Headers, `{"model":"gpt-5.5","input":"hi"}`)
	require.Equal(t, http.StatusTooManyRequests, rec.Code)
	require.NotContains(t, rec.Body.String(), "forged")
	require.Less(t, rec.Body.Len(), 8<<10)
}

// B5 through every gateway entry: after a breach of a session rule the
// HTTP, SSE and WebSocket handshakes of every key in the group are refused
// with the structured detail (rule_kind included), and an open WebSocket is
// closed at its next turn (H14).
func TestUsageRuleRefusesEveryGatewayEntry(t *testing.T) {
	h := newHarness(t)
	u := h.user()
	g := h.planGroup()
	d := h.mustRegister(h.token(u))
	userKeyID, userKey := h.adminUserKey(u.ID, g.ID, "script")
	h.adminJSON(http.MethodPost, "/usage-rules", fmt.Sprintf(`{"group_id":%d,"kind":"session","limit_usd":0.01}`, g.ID))

	ws, _, err := h.dial("/v1/responses", d.Key, d.Headers)
	require.NoError(t, err, "the handshake passes before the breach")
	defer func() { _ = ws.CloseNow() }()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	require.NoError(t, ws.Write(ctx, coderws.MessageText, []byte(`{"type":"response.create","model":"gpt-5.5"}`)))
	_, data, err := ws.Read(ctx)
	require.NoError(t, err)
	require.JSONEq(t, `{"type":"response.completed"}`, string(data))

	// H8: the billed request (what the gateway's usage recording reports).
	gid := g.ID
	claudexhook.UsageApplied(context.Background(), claudexhook.UsageEvent{
		RequestID: fmt.Sprintf("it-%d", time.Now().UnixNano()), UserID: u.ID, APIKeyID: userKeyID, GroupID: &gid,
		RequestedModel: "gpt-5.5", BilledModel: "gpt-5.5", CostUSD: 0.02, At: time.Now(),
	})

	for _, tc := range []struct{ path, body string }{
		{"/v1/responses", `{"model":"gpt-5.5","input":"hi"}`},
		{"/v1/responses", `{"model":"gpt-5.5","input":"hi","stream":true}`},
		{"/v1/chat/completions", `{"model":"gpt-5.5","messages":[]}`},
	} {
		rec := h.gateway(http.MethodPost, tc.path, d.Key, d.Headers, tc.body)
		require.Equal(t, http.StatusTooManyRequests, rec.Code, "%s %s", tc.path, rec.Body.String())
		ref := refusalOf(t, rec)
		require.NotNil(t, ref.Claudex, rec.Body.String())
		require.Equal(t, "RULE_LIMIT", ref.Claudex.Reason)
		require.Equal(t, "session", ref.Claudex.RuleKind)
		require.Equal(t, "5h", ref.Claudex.Window)
		require.NotEmpty(t, rec.Header().Get("Retry-After"))
		rec = h.gateway(http.MethodPost, tc.path, userKey, nil, tc.body)
		require.Equal(t, http.StatusTooManyRequests, rec.Code, "decision 8: every key of the group")
	}
	_, resp, err := h.dial("/v1/responses", d.Key, d.Headers)
	require.Error(t, err)
	require.NotNil(t, resp)
	require.Equal(t, http.StatusTooManyRequests, resp.StatusCode, "the WebSocket handshake is refused too")

	// The connection opened before the breach: its next turn is refused.
	require.NoError(t, ws.Write(ctx, coderws.MessageText, []byte(`{"type":"response.create","model":"gpt-5.5"}`)))
	_, _, err = ws.Read(ctx)
	require.Equal(t, coderws.StatusPolicyViolation, coderws.CloseStatus(err), "turn refused: %v", err)
}

// B1 + owner decision 7: with enforcement on, a device key of an old build
// gets 426 with the download address; current builds and other keys pass;
// the bootstrap says "required".
func TestMinimumVersionIsEnforcedOnDeviceKeys(t *testing.T) {
	h := newHarness(t)
	u := h.user()
	g := h.planGroup()
	tok := h.token(u)
	d := h.mustRegister(tok)
	_, userKey := h.adminUserKey(u.ID, g.ID, "script")

	var release map[string]any
	require.NoError(t, json.Unmarshal(readFixtureRaw(t, "setting.client-release.json"), &release))
	release["enforce_minimum_on_gateway"] = true
	body, err := json.Marshal(release)
	require.NoError(t, err)
	h.adminJSON(http.MethodPut, "/release", string(body))
	t.Cleanup(func() {
		release["enforce_minimum_on_gateway"] = false
		body, _ := json.Marshal(release)
		h.adminJSON(http.MethodPut, "/release", string(body))
	})

	old := deviceHeaders(d.ID, "1.1.0")
	rec := h.gateway(http.MethodPost, "/v1/responses", d.Key, old, `{"model":"gpt-5.5","input":"hi"}`)
	require.Equal(t, http.StatusUpgradeRequired, rec.Code, rec.Body.String())
	ref := refusalOf(t, rec)
	require.Equal(t, "CLAUDEX_UPGRADE_REQUIRED", ref.Code)
	require.NotNil(t, ref.Claudex)
	require.Equal(t, "UPGRADE_REQUIRED", ref.Claudex.Reason)
	require.Equal(t, "update", ref.Claudex.Action)
	require.Equal(t, "1.2.0", ref.Claudex.MinimumVersion)
	require.Equal(t, "https://dl.example.com/Claudex-1.4.0-arm64.zip", ref.Claudex.DownloadURL)
	_, resp, err := h.dial("/v1/responses", d.Key, old)
	require.Error(t, err)
	require.NotNil(t, resp)
	require.Equal(t, http.StatusUpgradeRequired, resp.StatusCode)

	require.Equal(t, http.StatusOK, h.gateway(http.MethodPost, "/v1/responses", d.Key, d.Headers, `{"model":"gpt-5.5","input":"hi"}`).Code)
	require.Equal(t, http.StatusOK, h.gateway(http.MethodPost, "/v1/responses", userKey, old, `{"model":"gpt-5.5","input":"hi"}`).Code,
		"keys that are not device keys are never affected")

	rec = h.do(http.MethodGet, "/api/v1/claudex/bootstrap", tok, old, "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var boot struct {
		Release struct {
			State    string `json:"state"`
			Enforced bool   `json:"enforced"`
		} `json:"release"`
	}
	require.NoError(t, json.Unmarshal(decodeEnv(t, rec).Data, &boot))
	require.Equal(t, core.ReleaseStateRequired, boot.Release.State)
	require.True(t, boot.Release.Enforced)
}

// B7 + H8 + B5: a dictation session through the real handler is billed as
// realtime-transcription by audio length (an estimate, decision 6), logged
// for administrators, and counted by the usage rules of that model.
func TestDictationIsMeteredAsRealtimeTranscription(t *testing.T) {
	h := newHarness(t)
	u := h.user()
	g := h.planGroup()
	_, err := itDB.Exec(`UPDATE groups SET audio_stt_price_per_hour = 0.36 WHERE id = $1`, g.ID)
	require.NoError(t, err)
	d := h.mustRegister(h.token(u))
	_, userKey := h.adminUserKey(u.ID, g.ID, "script")

	up := "ws" + strings.TrimPrefix(h.asr.srv.URL, "http") + "/v1/audio/realtime/transcriptions"
	h.adminJSON(http.MethodPut, "/voice", fmt.Sprintf(`{"transcription":{"enabled":true,"upstream_url":%q,"api_key":%q,"max_bytes":640000}}`, up, asrKey))
	t.Cleanup(func() { h.adminJSON(http.MethodPut, "/voice", `{"transcription":{"enabled":false}}`) })
	h.adminJSON(http.MethodPost, "/usage-rules", fmt.Sprintf(
		`{"group_id":%d,"kind":"models","label":"Dictation","model_patterns":[%q],"window_seconds":604800,"limit_usd":0.0001}`, g.ID, voice.BilledModel))

	// Only device keys may dictate.
	_, resp, err := h.dial("/v1/audio/realtime/transcriptions", userKey, nil)
	require.Error(t, err)
	require.NotNil(t, resp)
	require.Equal(t, http.StatusForbidden, resp.StatusCode)

	var balanceBefore float64
	require.NoError(t, itDB.QueryRow(`SELECT balance FROM users WHERE id = $1`, u.ID).Scan(&balanceBefore))
	conn, _, err := h.dial("/v1/audio/realtime/transcriptions", d.Key, d.Headers)
	require.NoError(t, err)
	defer func() { _ = conn.CloseNow() }()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	require.NoError(t, conn.Write(ctx, coderws.MessageText, []byte(`{"type":"start","requestId":"it-1","audio":{"format":"pcm_s16le","sampleRate":16000,"channels":1}}`)))
	for i := 0; i < 20; i++ { // 64000 bytes = 2 s of 16 kHz mono 16-bit PCM
		require.NoError(t, conn.Write(ctx, coderws.MessageBinary, make([]byte, 3200)))
	}
	require.NoError(t, conn.Write(ctx, coderws.MessageText, []byte(`{"type":"finish","requestId":"it-1"}`)))
	_, data, err := conn.Read(ctx)
	require.NoError(t, err)
	require.JSONEq(t, `{"type":"final","text":"hello"}`, string(data))
	// Reading on answers the server's close frame (the relay ends with it).
	_, _, err = conn.Read(ctx)
	require.Equal(t, coderws.StatusNormalClosure, coderws.CloseStatus(err), "%v", err)

	var seconds, cost float64
	var billed bool
	require.Eventually(t, func() bool {
		return itDB.QueryRow(`SELECT billed_seconds, cost_usd, billed FROM claudex_voice_sessions WHERE user_id = $1`, u.ID).
			Scan(&seconds, &cost, &billed) == nil
	}, 5*time.Second, 50*time.Millisecond)
	require.InDelta(t, 2.0, seconds, 1e-9)
	require.True(t, billed)
	require.InDelta(t, 0.0002, cost, 1e-9, "2 s at $0.36 an hour")
	var balanceAfter float64
	require.NoError(t, itDB.QueryRow(`SELECT balance FROM users WHERE id = $1`, u.ID).Scan(&balanceAfter))
	require.InDelta(t, balanceBefore-cost, balanceAfter, 1e-9, "billed to the balance")

	data2 := h.adminJSON(http.MethodGet, fmt.Sprintf("/voice/estimated-usage?user_id=%d", u.ID), "")
	var list struct {
		Items []voice.SessionItem `json:"items"`
	}
	require.NoError(t, json.Unmarshal(data2, &list))
	require.Len(t, list.Items, 1)
	require.InDelta(t, 2.0, list.Items[0].EstimatedSeconds, 1e-9, "every session is an estimate by audio length")

	// The usage rule for realtime-transcription counted it: the next session is refused.
	_, resp, err = h.dial("/v1/audio/realtime/transcriptions", d.Key, d.Headers)
	require.Error(t, err)
	require.NotNil(t, resp)
	require.Equal(t, http.StatusTooManyRequests, resp.StatusCode)
	// Other models of the group are not part of that rule.
	require.Equal(t, http.StatusOK, h.gateway(http.MethodPost, "/v1/responses", d.Key, d.Headers, `{"model":"gpt-5.5","input":"hi"}`).Code)
}

// B8: diagnostics are off until an administrator turns them on; report
// bodies never reach the audit log (private body routes), device sign-ins do.
func TestDiagnosticsSwitchAndPrivateBodies(t *testing.T) {
	h := newHarness(t)
	u := h.user()
	h.planGroup()
	tok := h.token(u)
	d := h.mustRegister(tok)
	report := string(readFixtureRaw(t, "diagnostics.request.json"))

	var disabled struct {
		Status int `json:"status"`
		Body   struct {
			Reason string `json:"reason"`
		} `json:"body"`
	}
	require.NoError(t, json.Unmarshal(readFixtureRaw(t, "diagnostics.disabled-error.json"), &disabled))
	rec := h.do(http.MethodPost, "/api/v1/claudex/diagnostics", tok, d.Headers, report)
	require.Equal(t, disabled.Status, rec.Code, rec.Body.String())
	require.Equal(t, disabled.Body.Reason, decodeEnv(t, rec).Reason)

	var settings map[string]map[string]any
	require.NoError(t, json.Unmarshal(readFixtureRaw(t, "setting.feedback.json"), &settings))
	settings["diagnostics"]["enabled"] = true
	body, err := json.Marshal(settings)
	require.NoError(t, err)
	h.adminJSON(http.MethodPut, "/feedback-settings", string(body))
	t.Cleanup(func() {
		settings["diagnostics"]["enabled"] = false
		body, _ := json.Marshal(settings)
		h.adminJSON(http.MethodPut, "/feedback-settings", string(body))
	})

	rec = h.do(http.MethodPost, "/api/v1/claudex/diagnostics", tok, d.Headers, report)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var stored int
	require.NoError(t, itDB.QueryRow(`SELECT COUNT(*) FROM claudex_diagnostics WHERE user_id = $1`, u.ID).Scan(&stored))
	require.Equal(t, 1, stored)

	entry, ok := h.audit.last("POST /api/v1/claudex/diagnostics")
	require.True(t, ok)
	require.Empty(t, entry.Body, "the report text never reaches the audit log")
	entry, ok = h.audit.last("POST /api/v1/claudex/devices")
	require.True(t, ok)
	require.Contains(t, entry.Body, "device_name", "ordinary user writes are audited with their body")
}

// B10: a checkout link for an order paid in the browser: only the order's
// owner gets one, and the public checkout page resolves it from Redis.
func TestCheckoutLinkForAnAirwallexOrder(t *testing.T) {
	h := newHarness(t)
	owner := h.user()
	other := h.user()
	tradeNo := fmt.Sprintf("int_it_%d", time.Now().UnixNano())
	order, err := itClient.PaymentOrder.Create().
		SetUserID(owner.ID).SetUserEmail(owner.Email).SetUserName("it").
		SetAmount(20).SetPayAmount(20).SetRechargeCode(fmt.Sprintf("it-%d", uid())).
		SetOutTradeNo(fmt.Sprintf("it-out-%d", time.Now().UnixNano())).
		SetPaymentType("airwallex").SetPaymentTradeNo(tradeNo).
		SetProviderKey("airwallex").SetProviderInstanceID("999999999").
		SetStatus(service.OrderStatusPending).SetExpiresAt(time.Now().Add(time.Hour)).
		SetClientIP("127.0.0.1").SetSrcHost("claudex.local").
		Save(h.ctx)
	require.NoError(t, err)
	resume, err := service.NewPaymentResumeService(paymentKey).CreateToken(service.ResumeTokenClaims{OrderID: order.ID, UserID: owner.ID})
	require.NoError(t, err)
	body := fmt.Sprintf(`{"order_id":%d,"resume_token":%q,"client_secret":"cs_it","intent_id":%q,"currency":"USD","payment_env":"demo"}`, order.ID, resume, tradeNo)

	rec := h.do(http.MethodPost, "/api/v1/claudex/payment/checkout-links", h.token(other), nil, body)
	require.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())
	env := decodeEnv(t, rec)
	require.Equal(t, "CLAUDEX_CHECKOUT_UNAVAILABLE", env.Reason)

	rec = h.do(http.MethodPost, "/api/v1/claudex/payment/checkout-links", h.token(owner), nil, body)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
	var link struct {
		Token     string    `json:"token"`
		ExpiresAt time.Time `json:"expires_at"`
	}
	require.NoError(t, json.Unmarshal(decodeEnv(t, rec).Data, &link))
	require.NotEmpty(t, link.Token)
	require.False(t, link.ExpiresAt.After(order.ExpiresAt), "the link never outlives the order")

	rec = h.do(http.MethodPost, "/api/v1/claudex/payment/checkout", "", nil, fmt.Sprintf(`{"token":%q}`, link.Token))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var view struct {
		OrderID  int64  `json:"order_id"`
		Provider string `json:"provider"`
		Status   string `json:"status"`
	}
	require.NoError(t, json.Unmarshal(decodeEnv(t, rec).Data, &view))
	require.Equal(t, order.ID, view.OrderID)
	require.Equal(t, "airwallex", view.Provider)
	var paths struct {
		Data struct {
			ResultPath string `json:"result_path"`
			Airwallex  *struct {
				IntentID string `json:"intent_id"`
			} `json:"airwallex"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &paths))
	require.True(t, strings.HasPrefix(paths.Data.ResultPath, "/payment/result?"), paths.Data.ResultPath)
	require.NotNil(t, paths.Data.Airwallex)
	require.Equal(t, tradeNo, paths.Data.Airwallex.IntentID)
	rec = h.do(http.MethodPost, "/api/v1/claudex/payment/checkout", "", nil, `{"token":"not-a-token"}`)
	require.Equal(t, http.StatusNotFound, rec.Code)
}
