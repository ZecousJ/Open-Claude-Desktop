package refusal

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/gatewayhook"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// TestRuleKindOnlyComesFromUsageRules (R13): rule_kind names the B5 rule a
// RULE_LIMIT refusal hit. B5 presets that detail, and it reaches the client
// through EnrichRefusals with this describer registered; the describer's own
// usage_limit details (subscription and platform windows, not B5 rules)
// never carry one, so the client keeps its fallback for them.
func TestRuleKindOnlyComesFromUsageRules(t *testing.T) {
	gatewayhook.Reset()
	t.Cleanup(gatewayhook.Reset)
	src := &stubSource{}
	subscribed(src, progressWith(win(20, 4, dailyResets), win(100, 100.4, weeklyResets), nil))
	c := newComponent(src, func() time.Time { return testNow })
	gatewayhook.RegisterDescriber(c)

	r := gin.New()
	r.Use(gatewayhook.EnrichRefusals())
	r.POST("/v1/responses", func(g *gin.Context) {
		gatewayhook.MarkDevice(g, &gatewayhook.DeviceRef{ID: 51, UserID: testUserID, APIKeyID: testAPIKeyID, GroupID: int64p(testGroupID)})
		resets := testNow.Add(3 * time.Hour)
		rule := int64(3)
		d := &gatewayhook.RefusalDetail{V: 1, Reason: "RULE_LIMIT", Kind: "rule_limit", Window: "5h", ResetsAt: &resets,
			RuleID: &rule, RuleKind: "all_models", Label: "All models", Action: "wait",
			Message: "You've reached your usage limit for all models."}
		gatewayhook.SetDetail(g, d)
		g.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"code": "CLAUDEX_USAGE_LIMIT_EXCEEDED", "message": d.Message, "claudex": d})
	})
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/responses", nil))
	require.Equal(t, http.StatusTooManyRequests, rec.Code)
	var body struct {
		Claudex gatewayhook.RefusalDetail `json:"claudex"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Equal(t, "RULE_LIMIT", body.Claudex.Reason)
	require.Equal(t, "all_models", body.Claudex.RuleKind)

	detail := c.Describe(describeCtx(nil), testRefusal(http.StatusTooManyRequests, "USAGE_LIMIT_EXCEEDED", "weekly usage limit exceeded"))
	require.NotNil(t, detail)
	require.Equal(t, ReasonSubscriptionWeeklyLimit, detail.Reason)
	require.Equal(t, kindUsageLimit, detail.Kind)
	require.Empty(t, detail.RuleKind)
	raw, err := json.Marshal(detail)
	require.NoError(t, err)
	require.NotContains(t, string(raw), "rule_kind")
}
