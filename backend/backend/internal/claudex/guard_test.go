package claudex

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// TestClaudexCodeOnlyWritesClaudexSettings scans the non-test Go files under
// internal/claudex: settings are written only through core.JSONSetting (whose
// keys must start with "claudex_"), never through the upstream settings
// repository or setting service and never with raw SQL, so Claudex code can
// never write admin_compliance* or any other upstream key. It also enforces
// the import rules of design 1.1.
func TestClaudexCodeOnlyWritesClaudexSettings(t *testing.T) {
	settingWrite := regexp.MustCompile(`\.(SettingRepo|SettingService|settingRepo|settingService)\.(Set|Update|Save|Delete|Accept|Reset|Clear|Import|Apply|Write|Store|Put|Upsert)\w*\(`)
	settingsSQL := regexp.MustCompile(`(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+settings\b`)
	forbiddenImports := []string{
		`"github.com/Wei-Shaw/sub2api/internal/repository"`,
		`"github.com/Wei-Shaw/sub2api/internal/handler"`,
	}
	var checked int
	err := filepath.WalkDir(".", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if d.Name() == "testdata" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		src := string(raw)
		checked++
		slash := filepath.ToSlash(path)
		require.NotRegexp(t, settingWrite, src, "%s writes settings outside core.JSONSetting", slash)
		require.NotContains(t, src, "admin_compliance", "%s must not touch the compliance acknowledgement", slash)
		if slash != "core/settings.go" {
			require.NotRegexp(t, settingsSQL, src, "%s writes the settings table with SQL", slash)
		}
		for _, imp := range forbiddenImports {
			require.NotContains(t, src, imp, "%s imports %s", slash, imp)
		}
		if strings.Contains(slash, "/") && !strings.HasPrefix(slash, "core/") {
			// Component packages never import the module package (cycle).
			require.NotContains(t, src, `"github.com/Wei-Shaw/sub2api/internal/claudex"`, "%s imports the module package", slash)
		}
		return nil
	})
	require.NoError(t, err)
	require.Greater(t, checked, 15, "the scan must see the module, core, hooks and components")
}
