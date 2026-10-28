package policy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func readFixture(t *testing.T, name string) string {
	t.Helper()
	data, err := os.ReadFile("testdata/" + name)
	require.NoError(t, err)
	return string(data)
}

// topLevelKeys returns the keys of a JSON object in document order.
func topLevelKeys(t *testing.T, raw []byte) []string {
	t.Helper()
	dec := json.NewDecoder(bytes.NewReader(raw))
	tok, err := dec.Token()
	require.NoError(t, err)
	require.Equal(t, json.Delim('{'), tok)
	var keys []string
	for dec.More() {
		tok, err := dec.Token()
		require.NoError(t, err)
		key, ok := tok.(string)
		require.True(t, ok)
		keys = append(keys, key)
		var skip json.RawMessage
		require.NoError(t, dec.Decode(&skip))
	}
	return keys
}

// TestUserPolicyMatchesDesignExample: the stored example of design 2.3,
// resolved for a user of group 4 on macOS, is exactly the GET example of
// design 2.3 (values and key order).
func TestUserPolicyMatchesDesignExample(t *testing.T) {
	f := newFixture(t)
	f.store(designDocument)
	r := f.getPolicy(200, "", map[string]string{core.HeaderPlatform: "darwin"})
	require.Equal(t, http.StatusOK, r.status, "%s", r.body)
	want := readFixture(t, "design-2.3-get-policy.json")
	jsonEq(t, want, string(r.body))

	var wantEnv map[string]json.RawMessage
	require.NoError(t, json.Unmarshal([]byte(want), &wantEnv))
	require.Equal(t, topLevelKeys(t, wantEnv["data"]), topLevelKeys(t, r.data), "field order follows the design")

	// Windows gets the defaults' win32 list only when no override replaces
	// the modes: group 4 replaces them with all four.
	r = f.getPolicy(200, "", map[string]string{core.HeaderPlatform: "win32"})
	require.Equal(t, []any{"auto", "manual", "acceptEdits", "plan"}, dataField(t, r, "permission_modes"))
	// Group 3 does not, so its Windows users get manual and plan.
	r = f.getPolicy(300, "", map[string]string{core.HeaderPlatform: "win32"})
	require.Equal(t, []any{"manual", "plan"}, dataField(t, r, "permission_modes"))
	require.Equal(t, "Pro", dataField(t, r, "plan_label"))
	require.Equal(t, false, dataField(t, r, "voice"))
	// User 123 has an override on top of group 4.
	r = f.getPolicy(123, "", nil)
	require.Equal(t, false, dataField(t, r, "external_links"))
	require.Equal(t, []any{"docs.example.com", "*.example.org"}, dataField(t, r, "trusted_link_domains"))
	require.Equal(t, "Max", dataField(t, r, "plan_label"))
}

func linksOf(t *testing.T, r reply) map[string]any {
	t.Helper()
	links, ok := dataField(t, r, "links").(map[string]any)
	require.True(t, ok, "%s", r.body)
	return links
}

func dataField(t *testing.T, r reply, key string) any {
	t.Helper()
	var m map[string]any
	require.NoError(t, json.Unmarshal(r.data, &m))
	return m[key]
}

// TestAdminViewMatchesDesignShape checks GET /admin/claudex/policy against the
// design 2.3 admin example filled in for the stored example.
func TestAdminViewMatchesDesignShape(t *testing.T) {
	f := newFixture(t)
	f.store(designDocument)
	r := f.adminGet()
	require.Equal(t, http.StatusOK, r.status, "%s", r.body)
	jsonEq(t, readFixture(t, "design-2.3-admin-policy.json"), string(r.body))
}

// TestDesignPutExample stores the PUT example of design 2.3 on top of the
// stored example and answers the admin view.
func TestDesignPutExample(t *testing.T) {
	f := newFixture(t)
	f.store(designDocument)
	f.now = time.Date(2026, 9, 26, 3, 4, 5, 999, time.UTC)
	r := f.put(readFixture(t, "design-2.3-put.json"))
	require.Equal(t, http.StatusOK, r.status, "%s", r.body)
	var view map[string]any
	require.NoError(t, json.Unmarshal(r.data, &view))
	require.EqualValues(t, 18, view["revision"])
	require.Equal(t, "2026-09-26T03:04:05Z", view["updated_at"])
	require.EqualValues(t, adminID, view["updated_by"])
	jsonEq(t, `{"web_search_default":false,"usage_banner":{"warn_percent":80}}`, mustJSON(t, view["defaults"]))
	jsonEq(t, `[{"group_id":4,"group_name":"claudex-pro","deleted":false,"patch":{"plan_label":"Max"}}]`, mustJSON(t, view["group_overrides"]))
	jsonEq(t, `[{"user_id":123,"email":"a@example.com","deleted":false,"patch":{"external_links":false}}]`, mustJSON(t, view["user_overrides"]))
	require.EqualValues(t, 18, f.auditExtra()["config_version"], "the audit entry records the new revision as config_version")

	stored := f.storedDocument()
	require.EqualValues(t, 18, stored.Revision)
	require.Equal(t, 1, stored.Version)
	require.NotContains(t, stored.GroupOverrides, "3", "a PUT replaces the whole document")
}

func (f *fixture) auditExtra() map[string]any {
	f.auditMu.Lock()
	defer f.auditMu.Unlock()
	return f.audit
}

func TestFirstPutCreatesTheSetting(t *testing.T) {
	f := newFixture(t)
	r := f.adminGet()
	require.Equal(t, http.StatusOK, r.status)
	require.EqualValues(t, 0, jsonMap(t, r.data)["revision"])
	require.Nil(t, jsonMap(t, r.data)["updated_at"])

	r = f.put(putBody(`{"voice":false}`, `[]`, `[]`))
	require.Equal(t, http.StatusOK, r.status, "%s", r.body)
	require.EqualValues(t, 1, jsonMap(t, r.data)["revision"])

	r = f.put(putBody(`{"voice":true}`, `[]`, `[]`))
	require.Equal(t, http.StatusConflict, r.status, "revision 0 is stale now")
	require.Equal(t, ReasonRevisionConflict, r.reason)
}

// TestPutRound2FieldsReachTheClient: the new optional blocks are saved by a
// PUT, shown in the admin view and resolved for the user (GET and preview).
func TestPutRound2FieldsReachTheClient(t *testing.T) {
	f := newFixture(t)
	r := f.put(putBody(`{"computer_use":{"enabled":true,"denied_apps":["com.apple.Terminal"]},
	  "memory":{"default_on":true},"research":{"max_searches_per_turn":10},
	  "browser":{"dev_servers":false},"ssh_remote":false,
	  "codex_runtime_mirror":"https://registry.npmmirror.com/"}`,
		`[{"group_id":4,"patch":{"computer_use":{"denied_apps":["cmd.exe"]},"web_search":false}}]`, `[]`))
	require.Equal(t, http.StatusOK, r.status, "%s", r.body)
	jsonEq(t, `{"computer_use":{"enabled":true,"denied_apps":["com.apple.Terminal"]},
	  "memory":{"default_on":true},"research":{"max_searches_per_turn":10},
	  "browser":{"dev_servers":false},"ssh_remote":false,
	  "codex_runtime_mirror":"https://registry.npmmirror.com/"}`, mustJSON(t, jsonMap(t, r.data)["defaults"]))

	got := f.getPolicy(123, "", nil)
	require.Equal(t, http.StatusOK, got.status, "%s", got.body)
	data := jsonMap(t, got.data)
	jsonEq(t, `{"enabled":true,"allow_full_control":true,"denied_apps":["com.apple.Terminal","cmd.exe"],"max_actions_per_turn":null}`,
		mustJSON(t, data["computer_use"]))
	jsonEq(t, `{"enabled":false,"x_search":false,"max_searches_per_turn":10}`, mustJSON(t, data["research"]),
		"group 4 turned web search off")
	jsonEq(t, `{"enabled":true,"search_chats":true,"generate":true,"default_on":true,"model":null}`, mustJSON(t, data["memory"]))
	require.Equal(t, false, data["ssh_remote"])
	require.Equal(t, "https://registry.npmmirror.com/", data["codex_runtime_mirror"])

	p := f.preview(map[string]any{"user_id": 123})
	require.Equal(t, http.StatusOK, p.status, "%s", p.body)
	var preview PreviewResult
	require.NoError(t, json.Unmarshal(p.data, &preview))
	jsonEq(t, string(got.data), mustJSON(t, preview.Policy))
}

func jsonMap(t *testing.T, raw json.RawMessage) map[string]any {
	t.Helper()
	var m map[string]any
	require.NoError(t, json.Unmarshal(raw, &m))
	return m
}

func TestPutWithStaleRevisionIs409(t *testing.T) {
	f := newFixture(t)
	f.store(designDocument)
	before, _ := f.settings.value(SettingKey)
	for _, rev := range []string{"16", "18", "0"} {
		r := f.put(`{"revision":` + rev + `,"defaults":{},"group_overrides":[],"user_overrides":[]}`)
		require.Equal(t, http.StatusConflict, r.status, "revision %s: %s", rev, r.body)
		require.Equal(t, ReasonRevisionConflict, r.reason)
		var md map[string]string
		require.NoError(t, json.Unmarshal(r.env["metadata"], &md))
		require.Equal(t, "17", md["current_revision"])
	}
	after, _ := f.settings.value(SettingKey)
	require.Equal(t, before, after)
}

// TestConcurrentPutsExactlyOneWins: two administrators save from the same
// revision. Both pass the revision check (a barrier holds each at the write
// until both got there), so the compare-and-swap decides: exactly one 200,
// one 409. Repeated without the barrier too.
func TestConcurrentPutsExactlyOneWins(t *testing.T) {
	for _, barrier := range []bool{true, false} {
		for round := 0; round < 10; round++ {
			f := newFixture(t)
			f.store(designDocument)
			if barrier {
				var arrived sync.WaitGroup
				arrived.Add(2)
				f.beforeSwap = func() {
					arrived.Done()
					waitTimeout(t, &arrived, 5*time.Second)
				}
			}
			bodies := []string{
				`{"revision":17,"defaults":{"plan_label":"A"},"group_overrides":[],"user_overrides":[]}`,
				`{"revision":17,"defaults":{"plan_label":"B"},"group_overrides":[],"user_overrides":[]}`,
			}
			statuses := make([]int, 2)
			var wg sync.WaitGroup
			for i := range bodies {
				wg.Add(1)
				go func(i int) {
					defer wg.Done()
					statuses[i] = f.put(bodies[i]).status
				}(i)
			}
			wg.Wait()
			ok, conflict := 0, 0
			for _, s := range statuses {
				switch s {
				case http.StatusOK:
					ok++
				case http.StatusConflict:
					conflict++
				}
			}
			require.Equal(t, 1, ok, "barrier=%v round %d: %v", barrier, round, statuses)
			require.Equal(t, 1, conflict, "barrier=%v round %d: %v", barrier, round, statuses)
			stored := f.storedDocument()
			require.EqualValues(t, 18, stored.Revision)
			winner := "A"
			if statuses[1] == http.StatusOK {
				winner = "B"
			}
			require.Equal(t, Some(winner), stored.Defaults.PlanLabel)
		}
	}
}

func waitTimeout(t *testing.T, wg *sync.WaitGroup, d time.Duration) {
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(d):
		t.Error("barrier timed out")
	}
}

func TestETagChangesAfterPutAnd304Otherwise(t *testing.T) {
	f := newFixture(t)
	f.store(designDocument)
	first := f.getPolicy(200, "", nil)
	require.Equal(t, http.StatusOK, first.status)
	etag := first.header.Get("ETag")
	require.True(t, strings.HasPrefix(etag, `W/"`), etag)
	require.Equal(t, "private, no-cache", first.header.Get("Cache-Control"))
	require.Contains(t, first.header.Get("Vary"), core.HeaderPlatform)

	again := f.getPolicy(200, "", map[string]string{"If-None-Match": etag})
	require.Equal(t, http.StatusNotModified, again.status)
	require.Empty(t, again.body)
	require.Equal(t, etag, again.header.Get("ETag"))

	// Another platform may resolve differently, so it has its own ETag.
	win := f.getPolicy(300, "", map[string]string{core.HeaderPlatform: "win32"})
	mac := f.getPolicy(300, "", map[string]string{core.HeaderPlatform: "darwin"})
	require.NotEqual(t, win.header.Get("ETag"), mac.header.Get("ETag"))

	r := f.put(`{"revision":17,"defaults":{"voice":false},"group_overrides":[],"user_overrides":[]}`)
	require.Equal(t, http.StatusOK, r.status, "%s", r.body)

	// Same node: the new policy is visible at once (the write refreshed the cache).
	changed := f.getPolicy(200, "", map[string]string{"If-None-Match": etag})
	require.Equal(t, http.StatusOK, changed.status)
	require.NotEqual(t, etag, changed.header.Get("ETag"))
	require.EqualValues(t, 18, dataField(t, changed, "revision"))
	require.Equal(t, false, dataField(t, changed, "voice"))

	// Even a PUT that changes no value bumps the revision, hence the ETag.
	etag2 := changed.header.Get("ETag")
	r = f.put(`{"revision":18,"defaults":{"voice":false},"group_overrides":[],"user_overrides":[]}`)
	require.Equal(t, http.StatusOK, r.status)
	require.NotEqual(t, etag2, f.getPolicy(200, "", nil).header.Get("ETag"))
}

func TestGroupIDTheUserCannotUseIsIgnored(t *testing.T) {
	f := newFixture(t)
	f.store(designDocument)
	// User 200 may only use group 4; asking for group 3 gets group 4.
	r := f.getPolicy(200, "group_id=3", nil)
	require.Equal(t, http.StatusOK, r.status)
	require.EqualValues(t, 4, dataField(t, r, "group_id"))
	require.Equal(t, "Max", dataField(t, r, "plan_label"))
	require.Equal(t, true, dataField(t, r, "voice"), "group 3's override does not leak")
	require.Equal(t, int64(3), *f.plans.calls[len(f.plans.calls)-1], "the requested id went through the plan resolver")

	// User 123 may use group 3, so the requested group applies.
	r = f.getPolicy(123, "group_id=3", nil)
	require.EqualValues(t, 3, dataField(t, r, "group_id"))
	require.Equal(t, "Pro", dataField(t, r, "plan_label"))
	require.Equal(t, false, dataField(t, r, "external_links"), "the user override still applies")

	// A group that does not exist is ignored the same way.
	r = f.getPolicy(200, "group_id=9999", nil)
	require.EqualValues(t, 4, dataField(t, r, "group_id"))

	for _, bad := range []string{"abc", "0", "-4", "1.5"} {
		r = f.getPolicy(200, "group_id="+bad, nil)
		require.Equal(t, http.StatusBadRequest, r.status, bad)
		require.Equal(t, "group_id", r.field)
		require.Equal(t, RuleInvalidID, r.rule)
	}
}

func TestNoPlanUsesDefaultsAndUserOverride(t *testing.T) {
	f := newFixture(t)
	f.store(designDocument)
	f.plans.plan = map[int64]int64{}
	f.plans.allowed = map[int64][]int64{}
	r := f.getPolicy(123, "group_id=4", nil)
	require.Equal(t, http.StatusOK, r.status)
	require.Nil(t, dataField(t, r, "group_id"))
	require.Nil(t, dataField(t, r, "plan_label"))
	require.Equal(t, false, dataField(t, r, "external_links"))
}

func TestPlanLookupFailureIsNotAPolicy(t *testing.T) {
	f := newFixture(t)
	f.store(designDocument)
	f.plans.err = infraerrors.ServiceUnavailable("DB_DOWN", "database unavailable")
	r := f.getPolicy(200, "", nil)
	require.Equal(t, http.StatusServiceUnavailable, r.status)
	require.Nil(t, r.data)
}

func TestUserRouteNeedsASubject(t *testing.T) {
	f := newFixture(t)
	r := f.do(http.MethodGet, "/api/v1/claudex/policy", nil, nil)
	require.Equal(t, http.StatusUnauthorized, r.status)
}

func TestPutNeedsStepUp(t *testing.T) {
	f := newFixture(t)
	f.stepUp = func(c *gin.Context) {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"code": 403, "reason": "STEP_UP_REQUIRED"})
	}
	r := f.put(putBody(`{}`, `[]`, `[]`))
	require.Equal(t, http.StatusForbidden, r.status)
	require.Equal(t, "STEP_UP_REQUIRED", r.reason)
	_, stored := f.settings.value(SettingKey)
	require.False(t, stored)
	require.Equal(t, http.StatusOK, f.adminGet().status, "reads do not need step-up")
	require.Equal(t, http.StatusOK, f.preview(`{}`).status, "previews do not need step-up")
}

// TestOverrideOfDeletedGroupIsKept: a group deleted after its override was
// saved is listed as deleted, does not block saving and never applies.
func TestOverrideOfDeletedGroupIsKept(t *testing.T) {
	f := newFixture(t)
	f.store(designDocument)
	delete(f.groups.groups, 3)
	delete(f.users.users, 123)

	r := f.adminGet()
	require.Equal(t, http.StatusOK, r.status)
	var view AdminView
	require.NoError(t, json.Unmarshal(r.data, &view))
	require.Len(t, view.GroupOverrides, 2)
	require.Equal(t, GroupOverrideView{GroupID: 3, GroupName: nil, Deleted: true, Patch: view.GroupOverrides[0].Patch}, view.GroupOverrides[0])
	require.True(t, view.UserOverrides[0].Deleted)
	require.Nil(t, view.UserOverrides[0].Email)

	r = f.put(`{"revision":17,"defaults":{},"group_overrides":[{"group_id":3,"patch":{"voice":false}},{"group_id":4,"patch":{}}],
	  "user_overrides":[{"user_id":123,"patch":{"external_links":false}}]}`)
	require.Equal(t, http.StatusOK, r.status, "carried-over overrides of deleted groups and users save: %s", r.body)

	// A new override for the deleted group is refused.
	f.store(`{"revision":1}`)
	r = f.put(`{"revision":1,"defaults":{},"group_overrides":[{"group_id":3,"patch":{}}],"user_overrides":[]}`)
	require.Equal(t, http.StatusBadRequest, r.status)
	require.Equal(t, ReasonGroupNotFound, r.reason)
}

func TestLookupFailureIsAnError(t *testing.T) {
	f := newFixture(t)
	f.store(designDocument)
	f.groups.err = errors.New("connection refused")
	require.Equal(t, http.StatusInternalServerError, f.adminGet().status)
	r := f.put(`{"revision":17,"defaults":{},"group_overrides":[{"group_id":8,"patch":{}}],"user_overrides":[]}`)
	require.Equal(t, http.StatusInternalServerError, r.status)
	stored := f.storedDocument()
	require.EqualValues(t, 17, stored.Revision)
}

// TestPreviewEqualsActual: without a draft, the preview for a user, a
// requested group and a platform is exactly what that user's client gets.
func TestPreviewEqualsActual(t *testing.T) {
	f := newFixture(t)
	f.store(designDocument)
	f.settings.put(service.SettingKeyDocURL, "https://docs.fallback.example.com")
	f.settings.put(service.SettingKeyPurchaseSubscriptionEnabled, "true")
	f.settings.put(service.SettingKeyPurchaseSubscriptionURL, "https://shop.example.com")
	for _, user := range []int64{123, 200, 300} {
		for _, group := range []string{"", "3", "4", "9999"} {
			for _, platform := range []string{"", "darwin", "win32", "linux"} {
				headers := map[string]string{}
				if platform != "" {
					headers[core.HeaderPlatform] = platform
				}
				query := ""
				body := map[string]any{"user_id": user, "platform": platform}
				if group != "" {
					query = "group_id=" + group
					body["group_id"] = json.Number(group)
				}
				if group == "9999" {
					// The preview requires the group to exist; the client's
					// request would just fall back to the plan group.
					delete(body, "group_id")
				}
				actual := f.getPolicy(user, query, headers)
				require.Equal(t, http.StatusOK, actual.status)
				preview := f.preview(body)
				require.Equal(t, http.StatusOK, preview.status, "%s", preview.body)
				var p PreviewResult
				require.NoError(t, json.Unmarshal(preview.data, &p))
				jsonEq(t, string(actual.data), mustJSON(t, p.Policy), "user %d group %q platform %q", user, group, platform)
			}
		}
	}
}

// TestBootstrapSectionEqualsGet: the bootstrap section is the GET answer for
// the plan group B9 resolved.
func TestBootstrapSectionEqualsGet(t *testing.T) {
	f := newFixture(t)
	f.store(designDocument)
	require.Equal(t, []string{core.SectionPolicy}, f.c.Sections())
	for _, user := range []int64{123, 200, 300} {
		plan, err := f.plans.ResolvePlan(context.Background(), user, nil)
		require.NoError(t, err)
		sections, err := f.c.BootstrapSections(context.Background(), &core.BootstrapContext{UserID: user, Plan: plan, Platform: "win32"})
		require.NoError(t, err)
		require.Len(t, sections, 1)
		actual := f.getPolicy(user, "", map[string]string{core.HeaderPlatform: "win32"})
		jsonEq(t, string(actual.data), mustJSON(t, sections[core.SectionPolicy]))
	}
	sections, err := f.c.BootstrapSections(context.Background(), &core.BootstrapContext{UserID: 5})
	require.NoError(t, err)
	res, ok := sections[core.SectionPolicy].(Resolved)
	require.True(t, ok)
	require.Nil(t, res.GroupID)
	_, err = f.c.BootstrapSections(context.Background(), nil)
	require.Error(t, err)
}

// TestBootstrapWithoutPlanTellsNoPlanFromFailure: B9 passes Plan nil both for
// a user without a plan and when its plan lookup failed. A user without a
// plan gets the no-group policy; after a lookup failure the section is left
// out (an error, like GET), never the no-group policy in place of the group's.
func TestBootstrapWithoutPlanTellsNoPlanFromFailure(t *testing.T) {
	f := newFixture(t)
	f.store(designDocument)

	sections, err := f.c.BootstrapSections(context.Background(), &core.BootstrapContext{UserID: 5, Platform: "win32"})
	require.NoError(t, err, "user 5 has no plan")
	res, ok := sections[core.SectionPolicy].(Resolved)
	require.True(t, ok)
	require.Nil(t, res.GroupID)
	require.Equal(t, []string{"manual", "plan"}, res.PermissionModes, "the defaults' win32 list")

	// B9's lookup failed but the user has a plan: the section is its group's policy.
	sections, err = f.c.BootstrapSections(context.Background(), &core.BootstrapContext{UserID: 300, Platform: "win32"})
	require.NoError(t, err)
	res, ok = sections[core.SectionPolicy].(Resolved)
	require.True(t, ok)
	require.Equal(t, ptr[int64](3), res.GroupID)
	require.Equal(t, ptr("Pro"), res.PlanLabel)

	f.plans.err = infraerrors.ServiceUnavailable("DB_DOWN", "database unavailable")
	sections, err = f.c.BootstrapSections(context.Background(), &core.BootstrapContext{UserID: 300, Platform: "win32"})
	require.Error(t, err)
	require.Nil(t, sections)
}

func TestPreviewGroupOnlyAndDefaultsOnly(t *testing.T) {
	f := newFixture(t)
	f.store(designDocument)
	r := f.preview(`{"group_id":3,"platform":"win32"}`)
	require.Equal(t, http.StatusOK, r.status, "%s", r.body)
	var p PreviewResult
	require.NoError(t, json.Unmarshal(r.data, &p))
	require.Equal(t, ptr[int64](3), p.Policy.GroupID)
	require.Equal(t, ptr("Pro"), p.Policy.PlanLabel)
	require.Equal(t, []string{"manual", "plan"}, p.Policy.PermissionModes)

	r = f.preview(`{"group_id":null,"user_id":null,"platform":null,"draft":null}`)
	require.Equal(t, http.StatusOK, r.status)
	require.NoError(t, json.Unmarshal(r.data, &p))
	require.Nil(t, p.Policy.GroupID)
	require.Nil(t, p.Policy.PlanLabel)
	require.EqualValues(t, 17, p.Policy.Revision)

	r = f.preview("")
	require.Equal(t, http.StatusOK, r.status, "an empty body previews the defaults")
}

func TestPreviewDraftIsNotSaved(t *testing.T) {
	f := newFixture(t)
	f.store(designDocument)
	before, _ := f.settings.value(SettingKey)
	draft := `{"revision":17,"defaults":{"voice":false},"group_overrides":[{"group_id":4,"patch":{"plan_label":"Ultra"}}],"user_overrides":[]}`
	r := f.preview(`{"user_id":200,"platform":"darwin","draft":` + draft + `}`)
	require.Equal(t, http.StatusOK, r.status, "%s", r.body)
	var p PreviewResult
	require.NoError(t, json.Unmarshal(r.data, &p))
	require.Equal(t, ptr("Ultra"), p.Policy.PlanLabel)
	require.False(t, p.Policy.Voice)
	require.EqualValues(t, 17, p.Policy.Revision)
	after, _ := f.settings.value(SettingKey)
	require.Equal(t, before, after)

	// The draft is saved as-is: preview and actual agree afterwards.
	require.Equal(t, http.StatusOK, f.put(draft).status)
	actual := f.getPolicy(200, "", map[string]string{core.HeaderPlatform: "darwin"})
	var got Resolved
	require.NoError(t, json.Unmarshal(actual.data, &got))
	p.Policy.Revision = 18
	require.Equal(t, p.Policy, got)
}

func TestPreviewValidation(t *testing.T) {
	f := newFixture(t)
	f.store(designDocument)
	cases := []struct {
		body, reason, field, rule string
	}{
		{`{"group_id":404}`, ReasonGroupNotFound, "group_id", RuleNotFound},
		{`{"user_id":404}`, ReasonUserNotFound, "user_id", RuleNotFound},
		{`{"group_id":"4"}`, ReasonInvalid, "group_id", RuleInvalidID},
		{`{"user_id":0}`, ReasonInvalid, "user_id", RuleInvalidID},
		{`{"platform":"android"}`, ReasonInvalid, "platform", RuleUnknownPlatform},
		{`{"platform":7}`, ReasonInvalid, "platform", RuleInvalidType},
		{`{"groupId":4}`, ReasonInvalid, "groupId", RuleUnknownField},
		{`{"draft":{"revision":17,"defaults":{"permission_modes":["bypass"]},"group_overrides":[],"user_overrides":[]}}`, ReasonInvalid, "draft.defaults.permission_modes", RuleBypass},
		{`{"draft":{"defaults":{},"group_overrides":[{"group_id":77,"patch":{}}],"user_overrides":[]}}`, ReasonGroupNotFound, "draft.group_overrides.77", RuleNotFound},
		{`{"draft":{"defaults":{},"group_overrides":[]}}`, ReasonInvalid, "draft.user_overrides", RuleRequired},
		{`{"draft":[]}`, ReasonInvalid, "draft", RuleInvalidType},
		{`not json`, ReasonInvalid, "", RuleInvalidJSON},
	}
	for _, tc := range cases {
		r := f.preview(tc.body)
		require.Equal(t, http.StatusBadRequest, r.status, "%s: %s", tc.body, r.body)
		require.Equal(t, tc.reason, r.reason, tc.body)
		require.Equal(t, tc.field, r.field, tc.body)
		require.Equal(t, tc.rule, r.rule, tc.body)
	}
}

// TestCorruptStoredPolicyFallsBackToBuiltin: unreadable JSON is served as the
// built-in policy with a warning, and the next PUT (revision 0) repairs it.
func TestCorruptStoredPolicyFallsBackToBuiltin(t *testing.T) {
	logs := captureLogs(t)
	f := newFixture(t)
	f.store(`{"revision": 9, "defaults": {`)
	r := f.getPolicy(200, "", nil)
	require.Equal(t, http.StatusOK, r.status)
	var got Resolved
	require.NoError(t, json.Unmarshal(r.data, &got))
	require.Equal(t, Resolved{Revision: 0, GroupID: ptr[int64](4), Fields: Builtin()}, got)
	require.Contains(t, logs.String(), "unreadable setting, using defaults")
	require.Contains(t, logs.String(), SettingKey)

	// A well-formed document of the wrong shape is unreadable too.
	f.store(`{"revision": "nine"}`)
	r = f.getPolicy(200, "", nil)
	require.Equal(t, http.StatusOK, r.status)
	require.EqualValues(t, 0, dataField(t, r, "revision"))

	r = f.put(putBody(`{"voice":false}`, `[]`, `[]`))
	require.Equal(t, http.StatusOK, r.status, "%s", r.body)
	require.EqualValues(t, 1, f.storedDocument().Revision)
}

func TestSettingReadFailure(t *testing.T) {
	f := newFixture(t)
	f.settings.getErr = errors.New("db down")
	require.Equal(t, http.StatusInternalServerError, f.adminGet().status)
	require.Equal(t, http.StatusInternalServerError, f.put(putBody(`{}`, `[]`, `[]`)).status)
	// The client read serves the cached or built-in policy instead.
	r := f.getPolicy(200, "", nil)
	require.Equal(t, http.StatusOK, r.status)
}

func TestLinkFallbacksComeFromUpstreamSettings(t *testing.T) {
	f := newFixture(t)
	f.settings.put(service.SettingKeyDocURL, "https://docs.fallback.example.com")
	f.settings.put(service.SettingKeyPurchaseSubscriptionEnabled, "false")
	f.settings.put(service.SettingKeyPurchaseSubscriptionURL, "https://shop.example.com")
	r := f.getPolicy(200, "", nil)
	links := linksOf(t, r)
	require.Equal(t, "https://docs.fallback.example.com", links["help"])
	require.Nil(t, links["plans"], "purchase_subscription_url only counts when enabled")
	require.Nil(t, links["get_more_usage"])

	// Cached for 60 s like the policy.
	f.settings.put(service.SettingKeyPurchaseSubscriptionEnabled, "true")
	f.now = f.now.Add(30 * time.Second)
	links = linksOf(t, f.getPolicy(200, "", nil))
	require.Nil(t, links["plans"])
	f.now = f.now.Add(31 * time.Second)
	links = linksOf(t, f.getPolicy(200, "", nil))
	require.Equal(t, "https://shop.example.com", links["plans"])
	require.Equal(t, "https://shop.example.com", links["get_more_usage"])

	// A failing read keeps the last known values.
	f.settings.multiErr = errors.New("db down")
	f.now = f.now.Add(61 * time.Second)
	links = linksOf(t, f.getPolicy(200, "", nil))
	require.Equal(t, "https://shop.example.com", links["plans"])

	// Non-https upstream links are not handed to the client.
	f.settings.multiErr = nil
	f.settings.put(service.SettingKeyDocURL, "http://docs.example.com")
	f.now = f.now.Add(61 * time.Second)
	links = linksOf(t, f.getPolicy(200, "", nil))
	require.Nil(t, links["help"])

	r = f.adminGet()
	jsonEq(t, `{"doc_url":null,"purchase_subscription_url":"https://shop.example.com"}`, mustJSON(t, jsonMap(t, r.data)["fallbacks"]))
}

// TestNoBypassAnywhere: owner decision 3 — no policy type, stored field,
// resolved field or admin view field names Bypass.
func TestNoBypassAnywhere(t *testing.T) {
	var walk func(t *testing.T, typ reflect.Type, seen map[reflect.Type]bool)
	walk = func(t *testing.T, typ reflect.Type, seen map[reflect.Type]bool) {
		for typ.Kind() == reflect.Pointer || typ.Kind() == reflect.Slice || typ.Kind() == reflect.Map {
			typ = typ.Elem()
		}
		if typ.Kind() != reflect.Struct || seen[typ] {
			return
		}
		seen[typ] = true
		for i := 0; i < typ.NumField(); i++ {
			field := typ.Field(i)
			require.False(t, containsFold(field.Name, "bypass"), "%s.%s", typ.Name(), field.Name)
			require.False(t, containsFold(field.Tag.Get("json"), "bypass"), "%s.%s", typ.Name(), field.Name)
			walk(t, field.Type, seen)
		}
	}
	seen := map[reflect.Type]bool{}
	for _, v := range []any{Document{}, Patch{}, Resolved{}, AdminView{}, PreviewResult{}} {
		walk(t, reflect.TypeOf(v), seen)
	}
	for _, key := range patchKeys {
		require.False(t, containsFold(key, "bypass"))
	}
	for _, m := range PolicyModes {
		require.False(t, containsFold(m, "bypass"))
	}

	f := newFixture(t)
	f.store(`{"revision":2,"defaults":{"permission_modes":["auto","bypass"],"scheduled_tasks":{"allow_bypass":false,"enabled":true}},
	  "group_overrides":{"4":{"permission_modes":{"default":["bypass","plan"]}}}}`)
	for _, r := range []reply{
		f.getPolicy(200, "", nil),
		f.getPolicy(300, "", map[string]string{core.HeaderPlatform: "win32"}),
		f.adminGet(),
		f.preview(`{"user_id":200}`),
	} {
		require.Equal(t, http.StatusOK, r.status)
		require.False(t, containsFold(string(r.body), "bypass"), "%s", r.body)
	}
}

func TestNewWithEmptyDeps(t *testing.T) {
	c := New(&core.Env{})
	require.Equal(t, core.NamePolicy, c.Name())
	require.Equal(t, []string{SettingKey}, c.SettingKeys())
	gin.SetMode(gin.TestMode)
	r := gin.New()
	c.RegisterUserRoutes(r.Group("/api/v1/claudex"))
	c.RegisterAdminRoutes(r.Group("/api/v1/admin/claudex"), nil)
	require.NotNil(t, New(nil))
	// Resolving with no settings repository and no peers is the built-in policy.
	d := c.setting.Cached(context.Background())
	res, err := c.resolveForUser(context.Background(), &d, 1, nil, "")
	require.NoError(t, err)
	require.Equal(t, Resolved{Fields: Builtin()}, res)
}
