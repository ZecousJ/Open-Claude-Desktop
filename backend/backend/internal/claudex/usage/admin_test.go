//go:build unit

package usage

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func adminDo(r http.Handler, method, path, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	var req *http.Request
	if body != "" {
		req = httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
	} else {
		req = httptest.NewRequest(method, path, nil)
	}
	r.ServeHTTP(rec, req)
	return rec
}

type envelope struct {
	Code     int               `json:"code"`
	Reason   string            `json:"reason"`
	Metadata map[string]string `json:"metadata"`
	Data     json.RawMessage   `json:"data"`
}

func decode(t *testing.T, rec *httptest.ResponseRecorder) envelope {
	t.Helper()
	var e envelope
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &e), rec.Body.String())
	return e
}

const rulesPath = "/api/v1/admin/claudex/usage-rules"

func TestAdminCreatesRulesWithDefaultsBehindStepUp(t *testing.T) {
	fs := newFakeStore()
	fs.groups[4] = true
	c, _ := newTestComponent(fs, statusNow)
	r := statusRouter(c, 11)

	// Prime the rule cache: the create below must invalidate it.
	_, err := c.rules.get(t.Context())
	require.NoError(t, err)

	rec := adminDo(r, http.MethodPost, rulesPath, `{"group_id":4,"kind":"session","limit_usd":0.01}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, "checked", rec.Header().Get("X-Step-Up"))
	var rule Rule
	require.NoError(t, json.Unmarshal(decode(t, rec).Data, &rule))
	require.Equal(t, int64(4), *rule.GroupID)
	require.Equal(t, KindSession, rule.Kind)
	require.Equal(t, DefaultSessionLabel, rule.Label)
	require.Equal(t, []string{"*"}, rule.ModelPatterns)
	require.Equal(t, 18000, rule.WindowSeconds)
	require.Equal(t, 0.01, rule.LimitUSD)
	require.True(t, rule.Enabled)
	require.True(t, rule.ShowInClient)
	require.Equal(t, int64(1), *rule.CreatedBy, "created_by is the administrator")

	set, err := c.rules.get(t.Context())
	require.NoError(t, err)
	require.Len(t, set.forGroup(ptr(int64(4))), 1, "the cache was invalidated")

	// Every group (group_id null or absent), per-model rule.
	rec = adminDo(r, http.MethodPost, rulesPath, `{"group_id":null,"kind":"models","label":"Opus","model_patterns":["claude-opus-*"],"window_seconds":604800,"limit_usd":20,"sort_order":10,"show_in_client":false}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.NoError(t, json.Unmarshal(decode(t, rec).Data, &rule))
	require.Nil(t, rule.GroupID)
	require.False(t, rule.ShowInClient)
	require.Equal(t, 10, rule.SortOrder)

	// List: all, one group, invalid group.
	rec = adminDo(r, http.MethodGet, rulesPath, "")
	require.Equal(t, http.StatusOK, rec.Code)
	require.Empty(t, rec.Header().Get("X-Step-Up"), "reads need no step-up")
	var list struct {
		Items         []Rule  `json:"items"`
		CounterHealth Metrics `json:"counter_health"`
	}
	require.NoError(t, json.Unmarshal(decode(t, rec).Data, &list))
	require.Len(t, list.Items, 2)
	require.Equal(t, retryQueueCapacity, list.CounterHealth.RetryQueueCapacity)
	rec = adminDo(r, http.MethodGet, rulesPath+"?group_id=4", "")
	require.NoError(t, json.Unmarshal(decode(t, rec).Data, &list))
	require.Len(t, list.Items, 1)
	rec = adminDo(r, http.MethodGet, rulesPath+"?group_id=x", "")
	require.Equal(t, http.StatusBadRequest, rec.Code)
	require.Equal(t, "group", decode(t, rec).Metadata["field"])
}

func TestAdminRejectsInvalidRules(t *testing.T) {
	fs := newFakeStore()
	fs.groups[4] = true
	c, _ := newTestComponent(fs, statusNow)
	r := statusRouter(c, 11)
	for name, tc := range map[string]struct {
		body, reason, field string
	}{
		"no kind":           {`{"group_id":4,"limit_usd":1}`, "CLAUDEX_USAGE_RULE_INVALID", "kind"},
		"bad kind":          {`{"kind":"monthly","window_seconds":3600,"limit_usd":1}`, "CLAUDEX_USAGE_RULE_INVALID", "kind"},
		"models w/o list":   {`{"kind":"models","label":"Opus","window_seconds":3600,"limit_usd":1}`, "CLAUDEX_USAGE_RULE_INVALID", "patterns"},
		"window as string":  {`{"kind":"session","window_seconds":"5h","limit_usd":1}`, "CLAUDEX_USAGE_RULE_INVALID", "window"},
		"limit as string":   {`{"kind":"session","limit_usd":"free"}`, "CLAUDEX_USAGE_RULE_INVALID", "limit"},
		"patterns bad type": {`{"kind":"models","label":"Opus","model_patterns":"claude-*","window_seconds":3600,"limit_usd":1}`, "CLAUDEX_USAGE_RULE_INVALID", "patterns"},
		"window too short":  {`{"kind":"all_models","window_seconds":60,"limit_usd":1}`, "CLAUDEX_USAGE_RULE_INVALID", "window"},
		"no limit":          {`{"kind":"session"}`, "CLAUDEX_USAGE_RULE_INVALID", "limit"},
		"group string":      {`{"group_id":"four","kind":"session","limit_usd":1}`, "CLAUDEX_USAGE_RULE_INVALID", "group"},
		"not json":          {`kind=session`, "CLAUDEX_USAGE_RULE_INVALID", "body"},
		"unknown group":     {`{"group_id":5,"kind":"session","limit_usd":1}`, "CLAUDEX_GROUP_NOT_FOUND", ""},
	} {
		t.Run(name, func(t *testing.T) {
			rec := adminDo(r, http.MethodPost, rulesPath, tc.body)
			require.Equal(t, http.StatusBadRequest, rec.Code, rec.Body.String())
			e := decode(t, rec)
			require.Equal(t, tc.reason, e.Reason)
			if tc.field != "" {
				require.Equal(t, tc.field, e.Metadata["field"])
			}
		})
	}
	fs.mu.Lock()
	require.Empty(t, fs.rules, "nothing was written")
	fs.mu.Unlock()
}

func TestAdminUpdatesDeletesAndResets(t *testing.T) {
	fs := newFakeStore()
	fs.groups[4], fs.groups[6] = true, true
	c, _ := newTestComponent(fs, statusNow)
	r := statusRouter(c, 11)
	id := fs.addRule(Rule{ID: 5, GroupID: ptr(int64(4)), Kind: KindModels, Label: "Opus", ModelPatterns: []string{"claude-opus-*"}, WindowSeconds: 604800, LimitUSD: 20, Enabled: true, ShowInClient: true, SortOrder: 10})
	fs.setCounter(id, 11, statusNow.Add(-time.Hour), statusNow.Add(time.Hour), 3)
	fs.setCounter(id, 12, statusNow.Add(-10*24*time.Hour), statusNow.Add(-3*24*time.Hour), 9)

	// Partial update: only the limit and enabled change.
	rec := adminDo(r, http.MethodPut, rulesPath+"/5", `{"limit_usd":25,"enabled":false}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, "checked", rec.Header().Get("X-Step-Up"))
	var rule Rule
	require.NoError(t, json.Unmarshal(decode(t, rec).Data, &rule))
	require.Equal(t, 25.0, rule.LimitUSD)
	require.False(t, rule.Enabled)
	require.Equal(t, "Opus", rule.Label)
	require.Equal(t, []string{"claude-opus-*"}, rule.ModelPatterns)
	require.Equal(t, int64(4), *rule.GroupID)

	// Moving to every group and back to one; unknown group refused.
	rec = adminDo(r, http.MethodPut, rulesPath+"/5", `{"group_id":null}`)
	require.NoError(t, json.Unmarshal(decode(t, rec).Data, &rule))
	require.Nil(t, rule.GroupID)
	rec = adminDo(r, http.MethodPut, rulesPath+"/5", `{"group_id":7}`)
	require.Equal(t, http.StatusBadRequest, rec.Code)
	require.Equal(t, "CLAUDEX_GROUP_NOT_FOUND", decode(t, rec).Reason)

	// Switching kinds: models -> session drops the patterns; session ->
	// models needs new patterns and a label.
	rec = adminDo(r, http.MethodPut, rulesPath+"/5", `{"kind":"session","label":""}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.NoError(t, json.Unmarshal(decode(t, rec).Data, &rule))
	require.Equal(t, []string{"*"}, rule.ModelPatterns)
	require.Equal(t, DefaultSessionLabel, rule.Label)
	rec = adminDo(r, http.MethodPut, rulesPath+"/5", `{"kind":"models"}`)
	require.Equal(t, http.StatusBadRequest, rec.Code)
	rec = adminDo(r, http.MethodPut, rulesPath+"/5", `{"kind":"models","label":"Sonnet","model_patterns":["claude-sonnet-*"]}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	rec = adminDo(r, http.MethodPut, rulesPath+"/99", `{"limit_usd":1}`)
	require.Equal(t, http.StatusNotFound, rec.Code)
	require.Equal(t, "CLAUDEX_USAGE_RULE_NOT_FOUND", decode(t, rec).Reason)

	// Counters, paginated, with the active flag.
	rec = adminDo(r, http.MethodGet, rulesPath+"/5/counters?page=1&page_size=1", "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var page struct {
		Items []counterItem `json:"items"`
		Total int64         `json:"total"`
		Pages int           `json:"pages"`
	}
	require.NoError(t, json.Unmarshal(decode(t, rec).Data, &page))
	require.Equal(t, int64(2), page.Total)
	require.Equal(t, 2, page.Pages)
	require.Len(t, page.Items, 1)
	require.Equal(t, int64(11), page.Items[0].UserID)
	require.True(t, page.Items[0].Active)
	rec = adminDo(r, http.MethodGet, rulesPath+"/5/counters?user_id=12", "")
	require.NoError(t, json.Unmarshal(decode(t, rec).Data, &page))
	require.Len(t, page.Items, 1)
	require.False(t, page.Items[0].Active)
	require.Equal(t, http.StatusNotFound, adminDo(r, http.MethodGet, rulesPath+"/99/counters", "").Code)
	require.Equal(t, http.StatusBadRequest, adminDo(r, http.MethodGet, rulesPath+"/5/counters?user_id=-1", "").Code)

	// Reset one user's counter.
	rec = adminDo(r, http.MethodPost, rulesPath+"/5/reset", `{"user_id":11}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, "checked", rec.Header().Get("X-Step-Up"))
	require.JSONEq(t, `{"reset":true}`, string(decode(t, rec).Data))
	fs.mu.Lock()
	_, still := fs.counterRows[[2]int64{5, 11}]
	fs.mu.Unlock()
	require.False(t, still)
	require.Equal(t, http.StatusBadRequest, adminDo(r, http.MethodPost, rulesPath+"/5/reset", `{}`).Code)
	require.Equal(t, http.StatusNotFound, adminDo(r, http.MethodPost, rulesPath+"/99/reset", `{"user_id":11}`).Code)

	// Delete.
	rec = adminDo(r, http.MethodDelete, rulesPath+"/5", "")
	require.Equal(t, http.StatusOK, rec.Code)
	require.Equal(t, "checked", rec.Header().Get("X-Step-Up"))
	require.JSONEq(t, `{"deleted":true}`, string(decode(t, rec).Data))
	require.Equal(t, http.StatusNotFound, adminDo(r, http.MethodDelete, rulesPath+"/5", "").Code)
	require.Equal(t, http.StatusNotFound, adminDo(r, http.MethodDelete, rulesPath+"/abc", "").Code)
}
