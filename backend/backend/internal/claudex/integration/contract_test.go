// Package integration holds the I1 checks across Claudex components.
//
// contract_test.go locks the JSON the handlers write to the fixtures the
// desktop app's tests read (internal/claudex/contract/testdata, design 3.6):
// each response type is filled with non-zero values, marshalled, and its
// field names and JSON types must equal the fixture's, both ways. Values
// may differ; null on either side matches any type. It needs no database;
// scripts/claudex-live-check.ts compares a live server's answers the same way.
package integration

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/catalog"
	"github.com/Wei-Shaw/sub2api/internal/claudex/devices"
	"github.com/Wei-Shaw/sub2api/internal/claudex/feedback"
	"github.com/Wei-Shaw/sub2api/internal/claudex/payment"
	"github.com/Wei-Shaw/sub2api/internal/claudex/policy"
	"github.com/Wei-Shaw/sub2api/internal/claudex/release"
	"github.com/Wei-Shaw/sub2api/internal/claudex/usage"
	"github.com/Wei-Shaw/sub2api/internal/claudex/voice"
	claudexweb "github.com/Wei-Shaw/sub2api/internal/claudex/web"
	"github.com/Wei-Shaw/sub2api/internal/claudex/webconsole"
)

const fixtureDir = "../contract/testdata"

// contractCases pairs a fixture location with the Go type the handler writes there.
var contractCases = []struct {
	fixture string
	// path inside the fixture: object keys, or "0" for an array's first item.
	path  []string
	value any
}{
	{"section.voice.json", []string{"voice"}, voice.BootstrapSection{}},
	{"bootstrap.full.json", []string{"data", "voice"}, voice.BootstrapSection{}},
	{"bootstrap.full.json", []string{"data", "release"}, release.Public{}},
	{"bootstrap.full.json", []string{"data", "models", "items", "0"}, catalog.Item{}},
	{"models.group.json", []string{"data"}, catalog.Catalog{}},
	{"diagnostics.accepted.json", []string{"data"}, feedback.DiagnosticsResult{}},
	{"feedback.accepted.json", []string{"data"}, feedback.FeedbackResult{}},
	{"feedback.excerpt-dropped.json", []string{"data"}, feedback.FeedbackResult{}},
	{"admin-usage-rules.rule.json", nil, usage.Rule{}},
	{"usage-status.plan.json", []string{"data"}, usage.Status{}},
	{"devices.registered.json", []string{"data"}, devices.RegisterResponse{}},
	{"section.plan-device.json", []string{"device"}, devices.DeviceSection{}},
	{"bootstrap.full.json", []string{"data", "device"}, devices.DeviceSection{}},
	{"devices.list.json", []string{"data", "items", "0"}, devices.MyDeviceJSON{}},
	{"admin-devices.list.json", []string{"data", "items", "0"}, devices.AdminDeviceJSON{}},
	{"admin-device-limit.get.json", []string{"data"}, devices.DeviceLimitJSON{}},
	{"web-sessions.list.json", []string{"data"}, claudexweb.SessionList{}},
	{"admin-policy.get.json", []string{"data", "group_overrides", "0"}, policy.GroupOverrideView{}},
	{"admin-policy.get.json", []string{"data", "user_overrides", "0"}, policy.UserOverrideView{}},
	{"payment-checkout-links.request.json", nil, payment.LinkRequest{}},
	{"payment-checkout-links.created.json", []string{"data"}, payment.LinkView{}},
	{"payment-checkout.stripe.json", []string{"data"}, payment.CheckoutView{}},
	{"payment-checkout.airwallex.json", []string{"data"}, payment.CheckoutView{}},
	{"web-console.default.json", []string{"data"}, webconsole.PublicView{}},
	{"admin-web-console.get.json", []string{"data"}, webconsole.AdminView{}},
}

func TestFixturesMatchResponseTypes(t *testing.T) {
	for _, c := range contractCases {
		name := fmt.Sprintf("%s/%s/%T", c.fixture, strings.Join(c.path, "."), c.value)
		t.Run(name, func(t *testing.T) {
			fixture := at(t, readFixture(t, c.fixture), c.path)
			filled := fill(reflect.New(reflect.TypeOf(c.value)).Elem())
			raw, err := json.Marshal(filled.Interface())
			if err != nil {
				t.Fatalf("marshal %T: %v", c.value, err)
			}
			var actual any
			if err := json.Unmarshal(raw, &actual); err != nil {
				t.Fatal(err)
			}
			if diffs := shapeDiff(fixture, actual, "$"); len(diffs) > 0 {
				t.Errorf("%s differs from %T:\n  %s", c.fixture, c.value, strings.Join(diffs, "\n  "))
			}
		})
	}
}

// The usage rules count dictation under the model the voice relay bills.
func TestDictationModelNamesAgree(t *testing.T) {
	if usage.RealtimeTranscriptionModel != voice.BilledModel {
		t.Fatalf("usage counts dictation as %q, voice bills it as %q", usage.RealtimeTranscriptionModel, voice.BilledModel)
	}
}

// The fixtures listed above exist and every one of them is valid JSON.
func TestFixturesAreJSON(t *testing.T) {
	entries, err := os.ReadDir(fixtureDir)
	if err != nil {
		t.Fatal(err)
	}
	seen := 0
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		seen++
		readFixture(t, e.Name())
	}
	if seen == 0 {
		t.Fatal("no fixtures")
	}
}

// The shape comparison itself.
func TestShapeDiff(t *testing.T) {
	fixture := map[string]any{"a": 1.0, "b": map[string]any{"c": "x"}, "d": nil, "e": []any{map[string]any{"f": true}}}
	same := map[string]any{"a": 2.0, "b": map[string]any{"c": "y"}, "d": "anything", "e": []any{map[string]any{"f": false}}}
	if diffs := shapeDiff(fixture, same, "$"); len(diffs) != 0 {
		t.Fatalf("same shape reported as different: %v", diffs)
	}
	other := map[string]any{"a": "1", "b": map[string]any{}, "d": nil, "e": []any{map[string]any{"f": true, "g": 1.0}}, "h": 1.0}
	want := []string{
		"$.a: fixture number, response string",
		"$.b.c: in the fixture, not in the response",
		"$.e[].g: in the response (number), not in the fixture",
		"$.h: in the response (number), not in the fixture",
	}
	if got := shapeDiff(fixture, other, "$"); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q\nwant %q", got, want)
	}
}

func readFixture(t *testing.T, name string) any {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(fixtureDir, name))
	if err != nil {
		t.Fatal(err)
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return v
}

func at(t *testing.T, v any, path []string) any {
	t.Helper()
	for _, p := range path {
		switch x := v.(type) {
		case map[string]any:
			next, ok := x[p]
			if !ok {
				t.Fatalf("fixture has no %q", p)
			}
			v = next
		case []any:
			if p != "0" || len(x) == 0 {
				t.Fatalf("fixture array has no item %q", p)
			}
			v = x[0]
		default:
			t.Fatalf("fixture has no %q", p)
		}
	}
	return v
}

var timeType = reflect.TypeOf(time.Time{})

// fill sets every pointer, slice and struct field to a non-zero value, so
// fields with omitempty appear in the JSON. Maps (patches, sources) stay
// empty: their keys are data, not contract.
func fill(v reflect.Value) reflect.Value {
	switch v.Kind() {
	case reflect.Pointer:
		p := reflect.New(v.Type().Elem())
		fill(p.Elem())
		v.Set(p)
	case reflect.Struct:
		if v.Type() == timeType {
			v.Set(reflect.ValueOf(time.Date(2026, 9, 26, 0, 0, 0, 0, time.UTC)))
			return v
		}
		for i := 0; i < v.NumField(); i++ {
			if v.Type().Field(i).IsExported() {
				fill(v.Field(i))
			}
		}
	case reflect.Slice:
		s := reflect.MakeSlice(v.Type(), 1, 1)
		fill(s.Index(0))
		v.Set(s)
	case reflect.String:
		v.SetString("x")
	case reflect.Bool:
		v.SetBool(true)
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		v.SetInt(1)
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		v.SetUint(1)
	case reflect.Float32, reflect.Float64:
		v.SetFloat(1)
	}
	return v
}

func kind(v any) string {
	switch v.(type) {
	case nil:
		return "null"
	case bool:
		return "bool"
	case float64:
		return "number"
	case string:
		return "string"
	case []any:
		return "array"
	default:
		return "object"
	}
}

// shapeDiff lists field-name and type differences between the fixture and
// the response; values are not compared and null matches anything.
func shapeDiff(fixture, actual any, at string) []string {
	a, b := kind(fixture), kind(actual)
	if a == "null" || b == "null" {
		return nil
	}
	if a != b {
		return []string{fmt.Sprintf("%s: fixture %s, response %s", at, a, b)}
	}
	var out []string
	switch a {
	case "object":
		f, _ := fixture.(map[string]any)
		r, _ := actual.(map[string]any)
		keys := func(m map[string]any) []string {
			k := make([]string, 0, len(m))
			for key := range m {
				k = append(k, key)
			}
			sort.Strings(k)
			return k
		}
		for _, k := range keys(f) {
			if _, ok := r[k]; !ok {
				out = append(out, fmt.Sprintf("%s.%s: in the fixture, not in the response", at, k))
				continue
			}
			out = append(out, shapeDiff(f[k], r[k], at+"."+k)...)
		}
		// A policy patch is sparse (omitempty fields): the fixture shows some
		// of them, and each one it shows must exist in the type.
		if strings.HasSuffix(at, ".patch") || strings.HasSuffix(at, ".defaults") {
			return out
		}
		for _, k := range keys(r) {
			if _, ok := f[k]; !ok {
				out = append(out, fmt.Sprintf("%s.%s: in the response (%s), not in the fixture", at, k, kind(r[k])))
			}
		}
	case "array":
		f, _ := fixture.([]any)
		r, _ := actual.([]any)
		if len(f) > 0 && len(r) > 0 {
			out = append(out, shapeDiff(f[0], r[0], at+"[]")...)
		}
	}
	return out
}
