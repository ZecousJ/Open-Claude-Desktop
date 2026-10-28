package policy

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"

	"github.com/stretchr/testify/require"
)

// contractDir holds the fixtures the desktop client and the server share
// (design 4.1; written by C1 only, <endpoint>.<case>.json).
const contractDir = "../contract/testdata"

// TestContractFixtures locks GET /api/v1/claudex/policy to the shared
// fixtures policy.*.json: the same field names and JSON types (values may
// differ). It skips until C1 adds the fixtures.
func TestContractFixtures(t *testing.T) {
	entries, err := os.ReadDir(contractDir)
	if errors.Is(err, fs.ErrNotExist) {
		t.Skip("no contract fixtures yet (C1)")
	}
	require.NoError(t, err)
	var files []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasPrefix(e.Name(), "policy.") && strings.HasSuffix(e.Name(), ".json") {
			files = append(files, e.Name())
		}
	}
	if len(files) == 0 {
		t.Skip("no policy.*.json contract fixtures yet (C1)")
	}
	f := newFixture(t)
	f.store(designDocument)
	actual := f.getPolicy(200, "", map[string]string{core.HeaderPlatform: "darwin"})
	require.Equal(t, http.StatusOK, actual.status)
	var got any
	require.NoError(t, json.Unmarshal(actual.body, &got))
	for _, name := range files {
		t.Run(name, func(t *testing.T) {
			data, err := os.ReadFile(filepath.Join(contractDir, name))
			require.NoError(t, err)
			var want any
			require.NoError(t, json.Unmarshal(data, &want))
			if problems := sameShape("", want, got); len(problems) > 0 {
				t.Fatalf("GET /api/v1/claudex/policy drifted from %s:\n%s", name, strings.Join(problems, "\n"))
			}
		})
	}
}

// TestDesignExampleShape applies the same shape check to the design 2.3
// example (so the checker itself is exercised before C1's fixtures exist).
func TestDesignExampleShape(t *testing.T) {
	f := newFixture(t)
	f.store(designDocument)
	actual := f.getPolicy(123, "", nil)
	var got, want any
	require.NoError(t, json.Unmarshal(actual.body, &got))
	require.NoError(t, json.Unmarshal([]byte(readFixture(t, "design-2.3-get-policy.json")), &want))
	require.Empty(t, sameShape("", want, got))

	var broken map[string]any
	require.NoError(t, json.Unmarshal([]byte(readFixture(t, "design-2.3-get-policy.json")), &broken))
	data, ok := broken["data"].(map[string]any)
	require.True(t, ok)
	delete(data, "voice")
	data["extra"] = true
	data["revision"] = "17"
	problems := sameShape("", broken, got)
	require.Len(t, problems, 3, "%v", problems)
}

// sameShape compares field names and JSON types. null in either document
// matches any type (nullable fields); arrays compare their first elements.
func sameShape(path string, want, got any) []string {
	if want == nil || got == nil {
		return nil
	}
	kind := func(v any) string { return fmt.Sprintf("%T", v) }
	if kind(want) != kind(got) {
		return []string{fmt.Sprintf("%s: fixture has %s, server answers %s", orRoot(path), kind(want), kind(got))}
	}
	switch w := want.(type) {
	case map[string]any:
		g, _ := got.(map[string]any) // same %T as want
		var problems []string
		keys := make([]string, 0, len(w)+len(g))
		for k := range w {
			keys = append(keys, k)
		}
		for k := range g {
			if _, ok := w[k]; !ok {
				keys = append(keys, k)
			}
		}
		sort.Strings(keys)
		for _, k := range keys {
			wv, inW := w[k]
			gv, inG := g[k]
			switch {
			case !inG:
				problems = append(problems, fmt.Sprintf("%s: missing in the server answer", join(path, k)))
			case !inW:
				problems = append(problems, fmt.Sprintf("%s: not in the fixture", join(path, k)))
			default:
				problems = append(problems, sameShape(join(path, k), wv, gv)...)
			}
		}
		return problems
	case []any:
		g, _ := got.([]any) // same %T as want
		if len(w) > 0 && len(g) > 0 {
			return sameShape(path+"[0]", w[0], g[0])
		}
	}
	return nil
}

func orRoot(path string) string {
	if path == "" {
		return "(root)"
	}
	return path
}
