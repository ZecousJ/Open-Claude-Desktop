package feedback

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

const (
	uuidA = "8a0f0000-0000-4000-8000-000000000001"
	uuidB = "8a0f0000-0000-4000-8000-000000000002"
	uuidC = "c1d20000-0000-4000-8000-000000000003"
)

func diagBody(consent string, reports ...string) string {
	if consent != "" {
		return `{"consent":` + consent + `,"reports":[` + strings.Join(reports, ",") + `]}`
	}
	return `{"reports":[` + strings.Join(reports, ",") + `]}`
}

func report(id, kind string, extra string) string {
	s := `{"id":"` + id + `","kind":"` + kind + `","occurred_at":"2026-09-26T02:00:00Z"`
	if extra != "" {
		s += "," + extra
	}
	return s + "}"
}

func TestComponentContract(t *testing.T) {
	c := New(&core.Env{})
	require.Equal(t, core.NameFeedback, c.Name())
	require.Equal(t, []string{"claudex_feedback"}, c.SettingKeys())
	require.Equal(t, []string{core.SectionFeedback}, c.Sections())
	require.NoError(t, core.CheckSectionOwnership(map[string][]string{c.Name(): c.Sections()}))
	// Nothing is touched in New, even without dependencies.
	require.NotNil(t, New(nil))
	New(nil).Start(context.Background()) // no database: no job, no panic
}

func TestDefaultsCollectNothing(t *testing.T) {
	f := newFixture(t)
	s := f.c.Settings(context.Background())
	require.Equal(t, defaultSettings(), s)
	require.False(t, s.Diagnostics.Enabled)
	require.False(t, s.Feedback.Enabled)
	require.False(t, s.Feedback.AllowConversationExcerpt)
	require.Equal(t, 30, s.Diagnostics.RetentionDays)
	require.Equal(t, 200, s.Diagnostics.MaxPerUserPerDay)
	require.Equal(t, 180, s.Feedback.RetentionDays)
	require.Equal(t, 100, s.Feedback.MaxPerUserPerDay)

	res := f.do(http.MethodPost, "/api/v1/claudex/diagnostics", diagBody("true", report(uuidA, "crash", "")))
	require.Equal(t, http.StatusNotFound, res.Status, res.Raw)
	require.Equal(t, "CLAUDEX_FEEDBACK_DISABLED", res.Reason)
	require.Equal(t, "no-store", res.Header.Get("Cache-Control"))
	res = f.do(http.MethodPost, "/api/v1/claudex/feedback", `{"consent":true,"id":"`+uuidC+`","rating":"up"}`)
	require.Equal(t, http.StatusNotFound, res.Status, res.Raw)
	require.Equal(t, "CLAUDEX_FEEDBACK_DISABLED", res.Reason)
	// Disabled wins over every other check: no consent, no body at all.
	res = f.do(http.MethodPost, "/api/v1/claudex/feedback", "")
	require.Equal(t, "CLAUDEX_FEEDBACK_DISABLED", res.Reason)
	require.Empty(t, f.store.diagnostics)
	require.Empty(t, f.store.feedback)

	sections, err := f.c.BootstrapSections(context.Background(), &core.BootstrapContext{UserID: 7})
	require.NoError(t, err)
	raw, err := json.Marshal(sections)
	require.NoError(t, err)
	require.JSONEq(t, `{"feedback":{"diagnostics":{"enabled":false},"feedback":{"enabled":false,"allow_conversation_excerpt":false}}}`, string(raw))
}

func TestBootstrapFollowsSettings(t *testing.T) {
	f := newFixture(t)
	f.enable(func(s *Settings) { s.Feedback.AllowConversationExcerpt = true })
	sections, err := f.c.BootstrapSections(context.Background(), nil)
	require.NoError(t, err)
	raw, _ := json.Marshal(sections)
	require.JSONEq(t, `{"feedback":{"diagnostics":{"enabled":true},"feedback":{"enabled":true,"allow_conversation_excerpt":true}}}`, string(raw))

	// Excerpts are only advertised while feedback itself is on.
	f.enable(func(s *Settings) { s.Feedback.Enabled = false; s.Feedback.AllowConversationExcerpt = true })
	sections, _ = f.c.BootstrapSections(context.Background(), nil)
	raw, _ = json.Marshal(sections)
	require.JSONEq(t, `{"feedback":{"diagnostics":{"enabled":true},"feedback":{"enabled":false,"allow_conversation_excerpt":false}}}`, string(raw))
}

func TestConsentIsRequired(t *testing.T) {
	f := newFixture(t)
	f.enable(nil)
	for _, consent := range []string{"", "false", `"true"`, "1", "null"} {
		res := f.do(http.MethodPost, "/api/v1/claudex/diagnostics", diagBody(consent, report(uuidA, "crash", "")))
		require.Equal(t, http.StatusBadRequest, res.Status, "consent %q: %s", consent, res.Raw)
		require.Equal(t, "CLAUDEX_CONSENT_REQUIRED", res.Reason, consent)

		body := `{"id":"` + uuidC + `","rating":"down"`
		if consent != "" {
			body += `,"consent":` + consent
		}
		res = f.do(http.MethodPost, "/api/v1/claudex/feedback", body+"}")
		require.Equal(t, http.StatusBadRequest, res.Status, res.Raw)
		require.Equal(t, "CLAUDEX_CONSENT_REQUIRED", res.Reason, consent)
	}
	require.Empty(t, f.store.diagnostics)
	require.Empty(t, f.store.feedback)

	res := f.do(http.MethodPost, "/api/v1/claudex/diagnostics", diagBody("true", report(uuidA, "crash", "")))
	require.Equal(t, http.StatusOK, res.Status, res.Raw)
	require.JSONEq(t, `{"accepted":1,"duplicates":0,"dropped":0}`, string(res.Data))
	require.Equal(t, "no-store", res.Header.Get("Cache-Control"))
}

func TestDiagnosticsValidation(t *testing.T) {
	f := newFixture(t)
	f.enable(nil)
	many := make([]string, 51)
	for i := range many {
		many[i] = report(fmt.Sprintf("8a0f0000-0000-4000-8000-%012d", i), "crash", "")
	}
	for name, tc := range map[string]struct {
		body, reason, field string
	}{
		"not json":      {`{"consent":true,`, "CLAUDEX_REPORT_INVALID", "body"},
		"no reports":    {diagBody("true"), "CLAUDEX_REPORT_INVALID", "reports"},
		"too many":      {diagBody("true", many...), "CLAUDEX_REPORT_INVALID", "reports"},
		"bad id":        {diagBody("true", report("abc", "crash", "")), "CLAUDEX_REPORT_INVALID", "reports[0].id"},
		"unknown kind":  {diagBody("true", report(uuidA, "crash", ""), report(uuidB, "prompt_dump", "")), "CLAUDEX_REPORT_INVALID", "reports[1].kind"},
		"wrong types":   {diagBody("true", `{"id":"`+uuidA+`","kind":"crash","message":42}`), "CLAUDEX_REPORT_INVALID", "reports[0]"},
		"report scalar": {diagBody("true", `"crash"`), "CLAUDEX_REPORT_INVALID", "reports[0]"},
	} {
		res := f.do(http.MethodPost, "/api/v1/claudex/diagnostics", tc.body)
		require.Equal(t, http.StatusBadRequest, res.Status, "%s: %s", name, res.Raw)
		require.Equal(t, tc.reason, res.Reason, name)
		require.Equal(t, tc.field, res.Meta["field"], name)
	}
	require.Empty(t, f.store.diagnostics, "a rejected batch stores nothing")

	// Fifty reports are fine.
	res := f.do(http.MethodPost, "/api/v1/claudex/diagnostics", diagBody("true", many[:50]...))
	require.Equal(t, http.StatusOK, res.Status, res.Raw)
	require.JSONEq(t, `{"accepted":50,"duplicates":0,"dropped":0}`, string(res.Data))
}

func TestRequestBodyLimit(t *testing.T) {
	f := newFixture(t)
	f.enable(nil)
	big := strings.Repeat("x", maxBodyBytes)
	res := f.do(http.MethodPost, "/api/v1/claudex/feedback", `{"consent":true,"id":"`+uuidC+`","rating":"down","comment":"`+big+`"}`)
	require.Equal(t, http.StatusRequestEntityTooLarge, res.Status, res.Raw)
	require.Equal(t, "CLAUDEX_REQUEST_TOO_LARGE", res.Reason)
	res = f.do(http.MethodPost, "/api/v1/claudex/diagnostics", diagBody("true", report(uuidA, "crash", `"message":"`+big+`"`)))
	require.Equal(t, http.StatusRequestEntityTooLarge, res.Status)
	require.Empty(t, f.store.feedback)
	require.Empty(t, f.store.diagnostics)
}

func TestDiagnosticsAreSanitized(t *testing.T) {
	f := newFixture(t, fixtureOptions{env: func(env *core.Env) {
		env.Peers.Devices = fakeDevices{byRaw: map[string]*core.DeviceRef{
			"6f1c2a4e-9b0d-4c1e-8a57-2f3b9d0c7e11": {ID: 51, UserID: 7},
			"00000000-0000-4000-8000-0000000000ff": {ID: 99, UserID: 8}, // someone else's device
		}}
	}})
	f.enable(nil)
	long := strings.Repeat("界", 400)
	reports := []string{
		report(uuidA, "gateway_refusal", `"code":"USAGE_LIMIT_EXCEEDED","message":"upstream said: your prompt was secret","request_id":"req_01H","model":"gpt-5.5",
			"app_version":"1.3.2","codex_version":"0.144.1","platform":"darwin","arch":"arm64","os_version":"macOS 26.1",
			"context":{"surface":"code","reason":"SUBSCRIPTION_WEEKLY_LIMIT","http_status":429,"retry_count":2,"feature":true,
			           "prompt":"never stored","extra":{"nested":1},"surface2":"x"}`),
		report(uuidB, "turn_error", `"message":"`+long+`","context":{"surface":{"obj":1},"reason":"`+strings.Repeat("r", 300)+`","http_status":"502"}`),
		// Values from the client that fail validation fall back to the X-Claudex-* headers or are dropped.
		`{"id":"C1D20000-0000-4000-8000-00000000000A","kind":"crash","occurred_at":"2099-01-01T00:00:00Z","platform":"beos","arch":"mips","app_version":"not a version",
		  "message":"key sk-proj-AbC_123-xyz and Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig in /Users/alice/project for bob@example.com",
		  "os_version":"C:\\Users\\Bob\\AppData"}`,
	}
	res := f.do(http.MethodPost, "/api/v1/claudex/diagnostics", diagBody("true", reports...),
		core.HeaderDeviceID, "6f1c2a4e-9b0d-4c1e-8a57-2f3b9d0c7e11", core.HeaderPlatform, "win32", core.HeaderArch, "x64", core.HeaderVersion, "1.4.0")
	require.Equal(t, http.StatusOK, res.Status, res.Raw)
	require.JSONEq(t, `{"accepted":3,"duplicates":0,"dropped":0}`, string(res.Data))
	require.Len(t, f.store.diagnostics, 3)

	refusal := f.store.diagnostics[0]
	require.Equal(t, "", refusal.Message, "a gateway_refusal never keeps the upstream text")
	require.Equal(t, "USAGE_LIMIT_EXCEEDED", refusal.Code)
	require.Equal(t, "gpt-5.5", refusal.Model)
	require.Equal(t, "1.3.2", refusal.AppVersion)
	require.Equal(t, "0.144.1", refusal.CodexVersion)
	require.Equal(t, "darwin", refusal.Platform)
	require.Equal(t, "arm64", refusal.Arch)
	require.Equal(t, "macOS 26.1", refusal.OSVersion)
	require.Equal(t, time.Date(2026, 9, 26, 2, 0, 0, 0, time.UTC), refusal.OccurredAt)
	require.NotNil(t, refusal.DeviceID)
	require.Equal(t, int64(51), *refusal.DeviceID)
	var ctx map[string]any
	require.NoError(t, json.Unmarshal(refusal.Context, &ctx))
	require.Equal(t, []string{"feature", "http_status", "reason", "retry_count", "surface"}, sortedKeys(ctx), "only whitelisted keys")
	require.Equal(t, "SUBSCRIPTION_WEEKLY_LIMIT", ctx["reason"])
	require.EqualValues(t, 429, ctx["http_status"])
	require.Equal(t, true, ctx["feature"])

	turn := f.store.diagnostics[1]
	require.Equal(t, 300, utf8.RuneCountInString(turn.Message), "message cut to 300 characters")
	require.True(t, utf8.ValidString(turn.Message))
	ctx = nil
	require.NoError(t, json.Unmarshal(turn.Context, &ctx))
	require.Equal(t, []string{"http_status", "reason"}, sortedKeys(ctx), "object values are dropped")
	require.Len(t, ctx["reason"], 200)
	require.Equal(t, "502", ctx["http_status"])
	// Missing fields fall back to the request headers.
	require.Equal(t, "win32", turn.Platform)
	require.Equal(t, "x64", turn.Arch)
	require.Equal(t, "1.4.0", turn.AppVersion)

	crash := f.store.diagnostics[2]
	require.Equal(t, "c1d20000-0000-4000-8000-00000000000a", crash.ReportUUID, "uuids are stored canonically")
	require.Equal(t, testNow, crash.OccurredAt, "a time far in the future is clamped to the receive time")
	require.Equal(t, "win32", crash.Platform)
	require.Equal(t, "x64", crash.Arch)
	require.Equal(t, "1.4.0", crash.AppVersion)
	for _, secret := range []string{"AbC_123", "eyJ", "alice", "bob@example.com", "Bob"} {
		require.NotContains(t, crash.Message+crash.OSVersion, secret)
	}
	require.Contains(t, crash.Message, "sk-[redacted]")
	require.Contains(t, crash.Message, "/Users/[user]/project")
	require.Equal(t, `C:\Users\[user]\AppData`, crash.OSVersion)

	// Someone else's device id is never linked.
	res = f.do(http.MethodPost, "/api/v1/claudex/diagnostics", diagBody("true", report("8a0f0000-0000-4000-8000-0000000000aa", "crash", "")),
		core.HeaderDeviceID, "00000000-0000-4000-8000-0000000000ff")
	require.Equal(t, http.StatusOK, res.Status)
	require.Nil(t, f.store.diagnostics[3].DeviceID)
}

func TestRedaction(t *testing.T) {
	for in, want := range map[string]string{
		"key sk-abc123DEF used":                       "key sk-[redacted] used",
		"sk-proj-Ab_c-9 and sk-admin-x":               "sk-[redacted] and sk-[redacted]",
		"Authorization: Bearer abc.def-ghi":           "Authorization: Bearer [redacted]",
		"bearer sk-secret":                            "Bearer [redacted]",
		"token eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl ok": "token [jwt] ok",
		"mail john.doe+x@mail.example.co.uk now":      "mail [email] now",
		"at /Users/alice/Library/Logs":                "at /Users/[user]/Library/Logs",
		"cwd /home/bob":                               "cwd /home/[user]",
		`C:\Users\Carol\AppData\x`:                    `C:\Users\[user]\AppData\x`,
		`c:/users/dave/x`:                             `c:/Users/[user]/x`,
		`"D:\\Users\\Eve\\x"`:                         `"D:\\Users\\[user]\\x"`,
		"nothing to hide 404":                         "nothing to hide 404",
	} {
		require.Equal(t, want, redact(in), in)
	}
}

func TestCleanText(t *testing.T) {
	require.Equal(t, "a b", cleanText("  a\x00\nb ", 10, false))
	require.Equal(t, "a\nb\tc", cleanText("a\r\nb\tc\x07", 10, true))
	require.Equal(t, "ab", cleanText("ab\xff", 10, false), "invalid UTF-8 is removed")
	require.Equal(t, "日本", cleanText("日本語", 2, false))
	// Redaction runs before the cut: a key straddling the limit is not half-kept.
	require.Equal(t, "x sk-[redacted]", cleanText("x sk-"+strings.Repeat("A", 50), 15, false))
	require.Equal(t, "", truncateRunes("abc", 0))
	require.Equal(t, "abc", truncateRunes("abc", 3))
}

func TestDiagnosticsAreIdempotent(t *testing.T) {
	f := newFixture(t)
	f.enable(nil)
	body := diagBody("true", report(uuidA, "crash", ""), report(uuidB, "crash", ""), report(uuidA, "crash", ""))
	res := f.do(http.MethodPost, "/api/v1/claudex/diagnostics", body)
	require.Equal(t, http.StatusOK, res.Status, res.Raw)
	require.JSONEq(t, `{"accepted":2,"duplicates":1,"dropped":0}`, string(res.Data))
	// A retry of the same batch stores nothing new.
	res = f.do(http.MethodPost, "/api/v1/claudex/diagnostics", body)
	require.JSONEq(t, `{"accepted":0,"duplicates":3,"dropped":0}`, string(res.Data))
	require.Len(t, f.store.diagnostics, 2)
	// Ids are per user.
	f.userID = 8
	res = f.do(http.MethodPost, "/api/v1/claudex/diagnostics", diagBody("true", report(uuidA, "crash", "")))
	require.JSONEq(t, `{"accepted":1,"duplicates":0,"dropped":0}`, string(res.Data))
}

func TestDiagnosticsDailyCap(t *testing.T) {
	f := newFixture(t)
	f.enable(func(s *Settings) { s.Diagnostics.MaxPerUserPerDay = 3 })
	ids := func(from, n int) []string {
		out := []string{}
		for i := from; i < from+n; i++ {
			out = append(out, report(fmt.Sprintf("8a0f0000-0000-4000-8000-%012d", i), "crash", ""))
		}
		return out
	}
	res := f.do(http.MethodPost, "/api/v1/claudex/diagnostics", diagBody("true", ids(0, 2)...))
	require.JSONEq(t, `{"accepted":2,"duplicates":0,"dropped":0}`, string(res.Data))
	// Partly over the cap: what fits is kept, the rest reported as dropped.
	res = f.do(http.MethodPost, "/api/v1/claudex/diagnostics", diagBody("true", ids(2, 3)...))
	require.Equal(t, http.StatusOK, res.Status)
	require.JSONEq(t, `{"accepted":1,"duplicates":0,"dropped":2}`, string(res.Data))
	// Entirely over the cap: 429 with Retry-After until the oldest report leaves the 24-hour window.
	f.clock = testNow.Add(time.Hour)
	res = f.do(http.MethodPost, "/api/v1/claudex/diagnostics", diagBody("true", ids(10, 1)...))
	require.Equal(t, http.StatusTooManyRequests, res.Status, res.Raw)
	require.Equal(t, "CLAUDEX_REPORT_QUOTA_EXCEEDED", res.Reason)
	require.Equal(t, "3", res.Meta["limit"])
	require.Equal(t, "82800", res.Header.Get("Retry-After"))
	require.Equal(t, "82800", res.Meta["retry_after_seconds"])
	// Retrying reports that were already stored still succeeds at the cap.
	res = f.do(http.MethodPost, "/api/v1/claudex/diagnostics", diagBody("true", ids(0, 1)...))
	require.Equal(t, http.StatusOK, res.Status)
	require.JSONEq(t, `{"accepted":0,"duplicates":1,"dropped":0}`, string(res.Data))
	// A day later there is room again; other users were never affected.
	f.clock = testNow.Add(25 * time.Hour)
	res = f.do(http.MethodPost, "/api/v1/claudex/diagnostics", diagBody("true", ids(10, 1)...))
	require.JSONEq(t, `{"accepted":1,"duplicates":0,"dropped":0}`, string(res.Data))
}

func TestFeedbackIntake(t *testing.T) {
	f := newFixture(t)
	f.enable(nil)
	excerpt := "User: my key is sk-live123\nAssistant: the table"
	body := func(id, extra string) string {
		return `{"consent":true,"id":"` + id + `","rating":"down","categories":["Inaccurate","not_helpful","inaccurate","has space","` +
			strings.Repeat("c", 33) + `"],"comment":"The table was wrong. Mail me at eve@example.org","model":"gpt-5.5",
			"request_id":"req_01H","app_version":"1.3.2","platform":"darwin"` + extra + `}`
	}

	// Excerpts are not allowed: dropped, and the answer says so.
	res := f.do(http.MethodPost, "/api/v1/claudex/feedback", body(uuidC, `,"conversation_excerpt":`+jsonString(excerpt)))
	require.Equal(t, http.StatusOK, res.Status, res.Raw)
	require.JSONEq(t, `{"accepted":true,"duplicate":false,"excerpt_dropped":true}`, string(res.Data))
	require.Len(t, f.store.feedback, 1)
	got := f.store.feedback[0]
	require.Nil(t, got.ConversationExcerpt)
	require.Equal(t, "down", got.Rating)
	require.Equal(t, []string{"inaccurate", "not_helpful"}, got.Categories)
	require.Equal(t, "The table was wrong. Mail me at [email]", got.Comment)
	require.Equal(t, "gpt-5.5", got.Model)
	require.Equal(t, "req_01H", got.RequestID)
	require.Equal(t, "1.3.2", got.AppVersion)
	require.Equal(t, "darwin", got.Platform)

	// Retrying the same feedback is idempotent.
	res = f.do(http.MethodPost, "/api/v1/claudex/feedback", body(uuidC, ""))
	require.JSONEq(t, `{"accepted":true,"duplicate":true,"excerpt_dropped":false}`, string(res.Data))
	require.Len(t, f.store.feedback, 1)

	// No excerpt attached (null): nothing is dropped.
	res = f.do(http.MethodPost, "/api/v1/claudex/feedback", body("c1d20000-0000-4000-8000-000000000004", `,"conversation_excerpt":null`))
	require.JSONEq(t, `{"accepted":true,"duplicate":false,"excerpt_dropped":false}`, string(res.Data))

	// Allowed: kept, redacted and cut to 20000 characters; the comment to 4000.
	f.enable(func(s *Settings) { s.Feedback.AllowConversationExcerpt = true })
	long := excerpt + strings.Repeat("é", 30000)
	res = f.do(http.MethodPost, "/api/v1/claudex/feedback", `{"consent":true,"id":"c1d20000-0000-4000-8000-000000000005","rating":"up",
		"comment":`+jsonString(strings.Repeat("w", 5000))+`,"conversation_excerpt":`+jsonString(long)+`}`)
	require.Equal(t, http.StatusOK, res.Status, res.Raw)
	require.JSONEq(t, `{"accepted":true,"duplicate":false,"excerpt_dropped":false}`, string(res.Data))
	kept := f.store.feedback[len(f.store.feedback)-1]
	require.NotNil(t, kept.ConversationExcerpt)
	require.Equal(t, maxExcerptChars, utf8.RuneCountInString(*kept.ConversationExcerpt))
	require.True(t, strings.HasPrefix(*kept.ConversationExcerpt, "User: my key is sk-[redacted]\nAssistant: the table"))
	require.Equal(t, maxCommentChars, utf8.RuneCountInString(kept.Comment))
	require.Equal(t, []string{}, kept.Categories)

	for name, tc := range map[string]struct{ body, field string }{
		"bad id":     {`{"consent":true,"id":"x","rating":"up"}`, "id"},
		"bad rating": {`{"consent":true,"id":"` + uuidA + `","rating":"meh"}`, "rating"},
		"no rating":  {`{"consent":true,"id":"` + uuidA + `"}`, "rating"},
		"bad json":   {`[1,2]`, "body"},
	} {
		res := f.do(http.MethodPost, "/api/v1/claudex/feedback", tc.body)
		require.Equal(t, http.StatusBadRequest, res.Status, name)
		require.Equal(t, "CLAUDEX_REPORT_INVALID", res.Reason, name)
		require.Equal(t, tc.field, res.Meta["field"], name)
	}
}

func TestFeedbackDailyCap(t *testing.T) {
	f := newFixture(t)
	f.enable(func(s *Settings) { s.Feedback.MaxPerUserPerDay = 1 })
	res := f.do(http.MethodPost, "/api/v1/claudex/feedback", `{"consent":true,"id":"`+uuidA+`","rating":"up"}`)
	require.Equal(t, http.StatusOK, res.Status)
	res = f.do(http.MethodPost, "/api/v1/claudex/feedback", `{"consent":true,"id":"`+uuidB+`","rating":"up"}`)
	require.Equal(t, http.StatusTooManyRequests, res.Status, res.Raw)
	require.Equal(t, "CLAUDEX_REPORT_QUOTA_EXCEEDED", res.Reason)
	require.NotEmpty(t, res.Header.Get("Retry-After"))
	// The stored one can still be retried.
	res = f.do(http.MethodPost, "/api/v1/claudex/feedback", `{"consent":true,"id":"`+uuidA+`","rating":"up"}`)
	require.Equal(t, http.StatusOK, res.Status)
}

func TestStoreFailureIsAGeneric500(t *testing.T) {
	f := newFixture(t)
	f.enable(nil)
	f.store.failWith = errors.New(`pq: relation "claudex_diagnostics" does not exist`)
	res := f.do(http.MethodPost, "/api/v1/claudex/diagnostics", diagBody("true", report(uuidA, "crash", "")))
	require.Equal(t, http.StatusInternalServerError, res.Status)
	require.Equal(t, "CLAUDEX_FEEDBACK_STORE_FAILED", res.Reason)
	require.NotContains(t, res.Raw, "relation")

	// Without a database (empty Deps) the component answers 500, not panic.
	c := New(&core.Env{Deps: core.Deps{SettingRepo: f.repo}})
	_, err := c.store.insertDiagnostics(context.Background(), 1, nil, 1)
	require.ErrorIs(t, err, errNoDatabase)
}

func jsonString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// auditCapture is an audit repository that keeps what the real audit
// middleware writes.
type auditCapture struct {
	service.AuditLogRepository
	mu      sync.Mutex
	entries []*service.AuditLog
}

func (r *auditCapture) BatchInsert(_ context.Context, logs []*service.AuditLog) (int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.entries = append(r.entries, logs...)
	return int64(len(logs)), nil
}

func (r *auditCapture) Insert(ctx context.Context, log *service.AuditLog) error {
	_, err := r.BatchInsert(ctx, []*service.AuditLog{log})
	return err
}

// TestAuditLog runs the real upstream audit middleware: the two intake
// endpoints leave no audit entry at all (their text never reaches
// audit_logs), while an administrator opening or deleting a report leaves an
// entry without any report text.
func TestAuditLog(t *testing.T) {
	repo := &auditCapture{}
	audit := service.NewAuditLogService(repo, nil)
	audit.Start()
	f := newFixture(t, fixtureOptions{audit: middleware.NewAuditLogMiddleware(audit)})
	f.enable(func(s *Settings) { s.Feedback.AllowConversationExcerpt = true })

	res := f.do(http.MethodPost, "/api/v1/claudex/diagnostics", diagBody("true",
		report(uuidA, "turn_error", `"message":"secret message","context":{"surface":"secret surface"}`)))
	require.Equal(t, http.StatusOK, res.Status, res.Raw)
	res = f.do(http.MethodPost, "/api/v1/claudex/feedback",
		`{"consent":true,"id":"`+uuidC+`","rating":"down","comment":"secret comment","conversation_excerpt":"secret prompt"}`)
	require.Equal(t, http.StatusOK, res.Status, res.Raw)
	// Refused requests are not audited either.
	res = f.do(http.MethodPost, "/api/v1/claudex/feedback", `{"id":"`+uuidB+`","rating":"down","comment":"secret refused"}`)
	require.Equal(t, "CLAUDEX_CONSENT_REQUIRED", res.Reason)

	diagID := f.store.diagnostics[0].ID
	fbID := f.store.feedback[0].ID
	res = f.do(http.MethodGet, fmt.Sprintf("/api/v1/admin/claudex/feedback/%d", fbID), "")
	require.Equal(t, http.StatusOK, res.Status, res.Raw)
	require.Contains(t, string(res.Data), "secret prompt", "the detail view shows the excerpt")
	res = f.do(http.MethodGet, fmt.Sprintf("/api/v1/admin/claudex/diagnostics/%d", diagID), "")
	require.Equal(t, http.StatusOK, res.Status)
	res = f.do(http.MethodGet, "/api/v1/admin/claudex/feedback", "")
	require.Equal(t, http.StatusOK, res.Status)
	res = f.do(http.MethodDelete, fmt.Sprintf("/api/v1/admin/claudex/feedback/%d", fbID), "")
	require.Equal(t, http.StatusOK, res.Status)
	res = f.do(http.MethodDelete, fmt.Sprintf("/api/v1/admin/claudex/diagnostics/%d", diagID+100), "")
	require.Equal(t, http.StatusNotFound, res.Status)
	audit.Stop()

	repo.mu.Lock()
	defer repo.mu.Unlock()
	actions := map[string]*service.AuditLog{}
	for _, e := range repo.entries {
		require.NotContains(t, e.Path, "/api/v1/claudex/", "intake requests are not audited")
		for _, secret := range []string{"secret", "comment", "conversation_excerpt", "message"} {
			require.NotContains(t, e.RequestBody, secret, "%s %s", e.Method, e.Path)
		}
		extra, _ := json.Marshal(e.Extra)
		require.NotContains(t, string(extra), "secret")
		actions[e.Action] = e
	}
	require.Contains(t, actions, auditFeedbackRead, "opening a feedback is audited")
	require.Contains(t, actions, auditDiagnosticRead, "opening a diagnostic report is audited")
	require.Contains(t, actions, auditFeedbackDelete)
	require.Contains(t, actions, auditDiagnosticDelete)
	require.Equal(t, http.MethodGet, actions[auditFeedbackRead].Method)
	require.Empty(t, actions[auditFeedbackRead].RequestBody)
	require.Equal(t, map[string]string{"id": fmt.Sprint(fbID)}, actions[auditFeedbackRead].Extra["params"])
	require.Equal(t, "deleted", actions[auditFeedbackDelete].Extra["result"])
	require.Equal(t, "not_found", actions[auditDiagnosticDelete].Extra["result"])
	require.Len(t, repo.entries, 4, "lists are not audited; details and deletes are")
}

func TestAdminSettings(t *testing.T) {
	stepUpCalls := 0
	f := newFixture(t, fixtureOptions{stepUp: func(c *gin.Context) {
		stepUpCalls++
		if c.GetHeader("X-Step-Up") != "ok" {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"code": 403, "reason": "STEP_UP_REQUIRED"})
			return
		}
		c.Next()
	}})
	res := f.do(http.MethodGet, "/api/v1/admin/claudex/feedback-settings", "")
	require.Equal(t, http.StatusOK, res.Status)
	require.JSONEq(t, `{"diagnostics":{"enabled":false,"retention_days":30,"max_per_user_per_day":200},
		"feedback":{"enabled":false,"retention_days":180,"allow_conversation_excerpt":false,"max_per_user_per_day":100}}`, string(res.Data))

	// Turning collection on needs step-up.
	res = f.do(http.MethodPut, "/api/v1/admin/claudex/feedback-settings", `{"diagnostics":{"enabled":true}}`)
	require.Equal(t, http.StatusForbidden, res.Status)
	require.Equal(t, 1, stepUpCalls)
	require.False(t, f.c.Settings(context.Background()).Diagnostics.Enabled)

	// Fields left out keep their values.
	res = f.do(http.MethodPut, "/api/v1/admin/claudex/feedback-settings", `{"diagnostics":{"enabled":true,"retention_days":7}}`, "X-Step-Up", "ok")
	require.Equal(t, http.StatusOK, res.Status, res.Raw)
	require.JSONEq(t, `{"diagnostics":{"enabled":true,"retention_days":7,"max_per_user_per_day":200},
		"feedback":{"enabled":false,"retention_days":180,"allow_conversation_excerpt":false,"max_per_user_per_day":100}}`, string(res.Data))
	res = f.do(http.MethodPut, "/api/v1/admin/claudex/feedback-settings", `{"feedback":{"enabled":true,"allow_conversation_excerpt":true}}`, "X-Step-Up", "ok")
	require.Equal(t, http.StatusOK, res.Status, res.Raw)
	s := f.c.Settings(context.Background())
	require.True(t, s.Diagnostics.Enabled)
	require.Equal(t, 7, s.Diagnostics.RetentionDays)
	require.True(t, s.Feedback.Enabled)
	require.True(t, s.Feedback.AllowConversationExcerpt)
	stored := f.repo.values[SettingKey]
	require.Contains(t, stored, `"allow_conversation_excerpt":true`)

	// The intake follows at once on this node.
	res = f.do(http.MethodPost, "/api/v1/claudex/diagnostics", diagBody("true", report(uuidA, "crash", "")))
	require.Equal(t, http.StatusOK, res.Status)

	for body, field := range map[string]string{
		`{"diagnostics":{"retention_days":0}}`:          "diagnostics.retention_days",
		`{"diagnostics":{"retention_days":366}}`:        "diagnostics.retention_days",
		`{"diagnostics":{"max_per_user_per_day":1001}}`: "diagnostics.max_per_user_per_day",
		`{"feedback":{"retention_days":731}}`:           "feedback.retention_days",
		`{"feedback":{"max_per_user_per_day":0}}`:       "feedback.max_per_user_per_day",
		`{"feedback":{"enabled":true,"typo":1}}`:        "body",
		`{"diagnostics":{"enabled":"yes"}}`:             "body",
		`not json`:                                      "body",
	} {
		res := f.do(http.MethodPut, "/api/v1/admin/claudex/feedback-settings", body, "X-Step-Up", "ok")
		require.Equal(t, http.StatusBadRequest, res.Status, body)
		require.Equal(t, "CLAUDEX_SETTING_INVALID", res.Reason, body)
		require.Equal(t, field, res.Meta["field"], body)
	}
	require.Equal(t, 7, f.c.Settings(context.Background()).Diagnostics.RetentionDays, "a refused PUT changes nothing")
	res = f.do(http.MethodPut, "/api/v1/admin/claudex/feedback-settings", `{"feedback":{"retention_days":730,"max_per_user_per_day":1000}}`, "X-Step-Up", "ok")
	require.Equal(t, http.StatusOK, res.Status, "the upper bounds are allowed")
}

func TestStoredSettingsAreClamped(t *testing.T) {
	f := newFixture(t)
	f.repo.values[SettingKey] = `{"diagnostics":{"enabled":true,"retention_days":0,"max_per_user_per_day":99999},"feedback":{"retention_days":-5}}`
	s, err := f.c.setting.Get(context.Background())
	require.NoError(t, err)
	require.True(t, s.Diagnostics.Enabled)
	require.Equal(t, 1, s.Diagnostics.RetentionDays)
	require.Equal(t, 1000, s.Diagnostics.MaxPerUserPerDay)
	require.Equal(t, 1, s.Feedback.RetentionDays)
	require.Equal(t, 100, s.Feedback.MaxPerUserPerDay, "missing fields keep their defaults")
}

func TestAdminListsAndDetails(t *testing.T) {
	f := newFixture(t)
	f.enable(func(s *Settings) { s.Feedback.AllowConversationExcerpt = true })
	f.do(http.MethodPost, "/api/v1/claudex/diagnostics", diagBody("true",
		report(uuidA, "crash", `"code":"E1","request_id":"req_1"`), report(uuidB, "update_failed", `"code":"E2"`)))
	f.do(http.MethodPost, "/api/v1/claudex/feedback", `{"consent":true,"id":"`+uuidC+`","rating":"down","conversation_excerpt":"hello"}`)

	res := f.do(http.MethodGet, "/api/v1/admin/claudex/diagnostics?kind=crash&code=E1&user_id=7&app_version=1.3.2&from=2026-09-01&to=2026-09-26T03:00:00Z&page=2&page_size=500", "")
	require.Equal(t, http.StatusOK, res.Status, res.Raw)
	flt := f.store.lastDiagF
	require.Equal(t, int64(7), flt.UserID)
	require.Equal(t, "crash", flt.Kind)
	require.Equal(t, "E1", flt.Code)
	require.Equal(t, "1.3.2", flt.AppVersion)
	require.Equal(t, time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC), *flt.From)
	require.Equal(t, time.Date(2026, 9, 26, 3, 0, 0, 0, time.UTC), flt.To.UTC())
	require.Equal(t, 2, flt.Page)
	require.Equal(t, 100, flt.Size, "page size is capped at 100")
	var page struct {
		Items    []Diagnostic `json:"items"`
		Total    int64        `json:"total"`
		Page     int          `json:"page"`
		PageSize int          `json:"page_size"`
	}
	res.into(t, &page)
	require.Equal(t, int64(1), page.Total)
	require.Equal(t, "req_1", page.Items[0].RequestID)

	// A date in "to" includes that whole day.
	f.do(http.MethodGet, "/api/v1/admin/claudex/feedback?to=2026-09-26&rating=down", "")
	require.Equal(t, time.Date(2026, 9, 27, 0, 0, 0, 0, time.UTC), *f.store.lastFeedF.To)
	require.Equal(t, "down", f.store.lastFeedF.Rating)

	for _, q := range []string{"diagnostics?user_id=x", "diagnostics?user_id=-1", "diagnostics?kind=nope", "diagnostics?from=yesterday",
		"feedback?rating=meh", "feedback?to=26/09/2026", "diagnostics?code=" + strings.Repeat("c", 65)} {
		res := f.do(http.MethodGet, "/api/v1/admin/claudex/"+q, "")
		require.Equal(t, http.StatusBadRequest, res.Status, q)
		require.Equal(t, "CLAUDEX_REPORT_FILTER_INVALID", res.Reason, q)
	}

	// Lists carry has_excerpt but never the excerpt; the detail always has the key.
	res = f.do(http.MethodGet, "/api/v1/admin/claudex/feedback", "")
	require.Equal(t, http.StatusOK, res.Status)
	require.NotContains(t, string(res.Data), "conversation_excerpt")
	require.Contains(t, string(res.Data), `"has_excerpt":true`)
	fbID := f.store.feedback[0].ID
	res = f.do(http.MethodGet, fmt.Sprintf("/api/v1/admin/claudex/feedback/%d", fbID), "")
	require.Equal(t, http.StatusOK, res.Status)
	var detail map[string]any
	res.into(t, &detail)
	require.Equal(t, "hello", detail["conversation_excerpt"])
	require.Equal(t, uuidC, detail["feedback_uuid"])

	for _, path := range []string{"diagnostics/999", "diagnostics/abc", "feedback/0", "feedback/999"} {
		res := f.do(http.MethodGet, "/api/v1/admin/claudex/"+path, "")
		require.Equal(t, http.StatusNotFound, res.Status, path)
		require.Equal(t, "CLAUDEX_REPORT_NOT_FOUND", res.Reason, path)
	}
	res = f.do(http.MethodDelete, fmt.Sprintf("/api/v1/admin/claudex/feedback/%d", fbID), "")
	require.Equal(t, http.StatusOK, res.Status)
	require.JSONEq(t, `{"deleted":true}`, string(res.Data))
	require.Empty(t, f.store.feedback)
	res = f.do(http.MethodDelete, fmt.Sprintf("/api/v1/admin/claudex/feedback/%d", fbID), "")
	require.Equal(t, http.StatusNotFound, res.Status)

	// Detail of a feedback without an excerpt: explicit null.
	f.do(http.MethodPost, "/api/v1/claudex/feedback", `{"consent":true,"id":"`+uuidA+`","rating":"up"}`)
	res = f.do(http.MethodGet, fmt.Sprintf("/api/v1/admin/claudex/feedback/%d", f.store.feedback[0].ID), "")
	require.Contains(t, string(res.Data), `"conversation_excerpt":null`)
}

func TestPurgeExpired(t *testing.T) {
	f := newFixture(t)
	f.enable(func(s *Settings) { s.Diagnostics.RetentionDays = 10; s.Feedback.RetentionDays = 100 })
	for i := 0; i < 2500; i++ {
		f.store.diagnostics = append(f.store.diagnostics, Diagnostic{ID: int64(i + 1), CreatedAt: testNow.Add(-11 * 24 * time.Hour)})
	}
	f.store.diagnostics = append(f.store.diagnostics, Diagnostic{ID: 9999, CreatedAt: testNow.Add(-9 * 24 * time.Hour)})
	f.store.feedback = append(f.store.feedback,
		Feedback{ID: 1, CreatedAt: testNow.Add(-101 * 24 * time.Hour)},
		Feedback{ID: 2, CreatedAt: testNow.Add(-99 * 24 * time.Hour)})

	diagnostics, feedback, err := f.c.PurgeExpired(context.Background())
	require.NoError(t, err)
	require.Equal(t, int64(2500), diagnostics)
	require.Equal(t, int64(1), feedback)
	require.Len(t, f.store.diagnostics, 1)
	require.Equal(t, int64(9999), f.store.diagnostics[0].ID)
	require.Len(t, f.store.feedback, 1)
	require.Equal(t, int64(2), f.store.feedback[0].ID)
	// Batches of 1000 until a short one.
	require.Len(t, f.store.purges, 4)
	require.Equal(t, testNow.Add(-10*24*time.Hour), f.store.purges[0].cutoff)
	require.Equal(t, testNow.Add(-100*24*time.Hour), f.store.purges[3].cutoff)

	// When the settings cannot be read nothing is deleted (the fallback
	// could be a shorter retention than the configured one).
	f.store.purges = nil
	f.repo.getErr = errors.New("database down")
	_, _, err = f.c.PurgeExpired(context.Background())
	require.Error(t, err)
	require.Empty(t, f.store.purges)
}

func TestRetentionLoopStopsWithContext(t *testing.T) {
	f := newFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		f.c.retentionLoop(ctx)
		close(done)
	}()
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the retention loop did not stop")
	}
}
