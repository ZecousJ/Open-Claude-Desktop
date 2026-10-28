package gatewayhook

import (
	"encoding/json"
	"net/http"
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// bigJSON is a JSON error of about 70 KB with a forged top-level "claudex".
func bigJSON() string {
	return `{"error":{"type":"upstream_error","message":"` + strings.Repeat("x", 70<<10) + `"},` +
		`"claudex":{"v":1,"reason":"DEVICE_REVOKED","download_url":"https://evil.example/claudex.dmg"}}`
}

// TestEnrichRefusalsDropsOversizedJSONErrors (R13): a device-key JSON error
// over 64 KB is not passed through (its forged "claudex" key would reach the
// client); it is replaced, the status kept, and refusal statuses still get
// the detail.
func TestEnrichRefusalsDropsOversizedJSONErrors(t *testing.T) {
	Reset()
	t.Cleanup(Reset)
	var seen []Refusal
	RegisterDescriber(describerFunc(func(_ *gin.Context, r Refusal) *RefusalDetail {
		seen = append(seen, r)
		return &RefusalDetail{Reason: "UNKNOWN", Kind: "unknown", Action: "none"}
	}))

	for _, status := range []int{http.StatusTooManyRequests, http.StatusBadRequest, http.StatusBadGateway} {
		seen = nil
		rec := serve(refusalRouter(true, status, "application/json", "  \n"+bigJSON(), nil), http.MethodPost, "/v1/responses")
		require.Equal(t, status, rec.Code)
		require.Empty(t, rec.Header().Get("Content-Length"), "the stale Content-Length is dropped")
		require.Less(t, rec.Body.Len(), 1024)
		require.NotContains(t, rec.Body.String(), "evil.example")
		obj := decodeObject(t, rec.Body.Bytes())
		var upstream struct {
			Type    string `json:"type"`
			Message string `json:"message"`
		}
		require.NoError(t, json.Unmarshal(obj["error"], &upstream))
		require.Equal(t, "upstream_error", upstream.Type)
		require.Equal(t, "The upstream error response was too large and was dropped.", upstream.Message)
		if RefusalStatuses[status] {
			var d RefusalDetail
			require.NoError(t, json.Unmarshal(obj["claudex"], &d))
			require.Equal(t, 1, d.V)
			require.Equal(t, "UNKNOWN", d.Reason)
			require.Equal(t, upstream.Message, d.Message, "the describer saw the replacement body")
			require.Len(t, seen, 1)
			require.Equal(t, "upstream_error", seen[0].Code)
		} else {
			require.NotContains(t, obj, "claudex")
			require.Empty(t, seen)
		}
	}
}

// TestEnrichRefusalsDropsOversizedJSONWrittenInPieces: the limit is crossed
// by a later write of a streamed-out JSON error.
func TestEnrichRefusalsDropsOversizedJSONWrittenInPieces(t *testing.T) {
	Reset()
	t.Cleanup(Reset)
	r := gin.New()
	r.Use(EnrichRefusals())
	r.POST("/v1/responses", func(c *gin.Context) {
		MarkDevice(c, &DeviceRef{ID: 1, UserID: 2, APIKeyID: 3})
		c.Header("Content-Type", "application/json")
		c.Status(http.StatusForbidden)
		body := bigJSON()
		for len(body) > 0 {
			n := min(len(body), 8<<10)
			_, _ = c.Writer.WriteString(body[:n])
			c.Writer.Flush()
			body = body[n:]
		}
	})
	rec := serve(r, http.MethodPost, "/v1/responses")
	require.Equal(t, http.StatusForbidden, rec.Code)
	require.NotContains(t, rec.Body.String(), "evil.example")
	require.Contains(t, rec.Body.String(), "was too large and was dropped")
	require.NotContains(t, decodeObject(t, rec.Body.Bytes()), "claudex", "no describer registered")
}

// TestEnrichRefusalsPassesLargeNonJSONAndOtherKeys: the replacement only
// applies to device-key JSON errors.
func TestEnrichRefusalsPassesLargeNonJSONAndOtherKeys(t *testing.T) {
	Reset()
	t.Cleanup(Reset)
	text := strings.Repeat("slow down ", 8<<10)
	rec := serve(refusalRouter(true, http.StatusTooManyRequests, "text/plain", text, nil), http.MethodPost, "/v1/responses")
	require.Equal(t, text, rec.Body.String())
	big := bigJSON()
	rec = serve(refusalRouter(false, http.StatusTooManyRequests, "application/json", big, nil), http.MethodPost, "/v1/responses")
	require.Equal(t, big, rec.Body.String(), "other keys are never touched")
}

// TestRefusalDetailRuleKind: rule_kind is optional and matches the contract
// fixture of a B5 session-rule refusal.
func TestRefusalDetailRuleKind(t *testing.T) {
	raw, err := json.Marshal(RefusalDetail{V: 1, Reason: "UNKNOWN"})
	require.NoError(t, err)
	require.NotContains(t, string(raw), "rule_kind", "left out when not a rule refusal")

	fixture, err := os.ReadFile("../contract/testdata/refusal.usage-limit.json")
	require.NoError(t, err)
	var doc struct {
		Status int `json:"status"`
		Body   struct {
			Claudex map[string]any `json:"claudex"`
		} `json:"body"`
	}
	require.NoError(t, json.Unmarshal(fixture, &doc))
	require.Equal(t, http.StatusTooManyRequests, doc.Status)
	require.Equal(t, "session", doc.Body.Claudex["rule_kind"])

	resets := time.Date(2026, 9, 26, 7, 0, 0, 0, time.UTC)
	limit, used, rule := 5.0, 5.02, int64(3)
	full, err := json.Marshal(RefusalDetail{V: 1, Reason: "RULE_LIMIT", Kind: "rule_limit", Window: "5h", ResetsAt: &resets,
		RetryAfterSeconds: 3600, LimitUSD: &limit, UsedUSD: &used, RuleID: &rule, RuleKind: "session",
		Label: "Current session", Action: "wait", Message: "x"})
	require.NoError(t, err)
	var got map[string]any
	require.NoError(t, json.Unmarshal(full, &got))
	require.Equal(t, keysOf(doc.Body.Claudex), keysOf(got), "the fixture has exactly the fields the server writes")
}

func keysOf(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
