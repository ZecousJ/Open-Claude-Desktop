package migrations

// CLAUDEX: file added by the Claudex fork (see backend/CLAUDEX_CHANGES.md).
//
// Claudex migrations are named claudex_NNNN_description.sql (optionally with
// the upstream "_notx" suffix). The runner applies files in file-name order
// (repository.applyMigrationsFS sorts with sort.Strings), and every upstream
// migration starts with a digit, so a fresh database runs all upstream
// migrations of a release before the Claudex ones.
//
// Numbers are allocated per package (design 1.7) so parallel packages never
// collide; a package that needs a new range asks the B0 owner to add it to
// claudexMigrationRanges. Each file must also be idempotent (IF NOT EXISTS)
// and must not change or write upstream tables.

import (
	"fmt"
	"io/fs"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

var claudexMigrationName = regexp.MustCompile(`^claudex_(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$`)

// claudexMigrationRanges is the number allocation of design 1.7.
var claudexMigrationRanges = []struct {
	from, to int
	owner    string
}{
	{1, 9, ""}, // reserved for B0, which creates no table
	{10, 19, "B3 model catalog"}, // includes plugin/connector directory submissions
	{20, 29, "B4 devices"},
	{30, 39, "B5 usage rules"},
	{40, 49, "B8 feedback"},
	{50, 59, "B7 voice"},
	// Round 2 (PLAN 3 #5, allocated by B-S): R1 creates claudex_0060_sharing.sql,
	// R3 creates claudex_0070_memory.sql.
	{60, 69, "R1 sharing"},
	{70, 79, "R3 memory"},
	// Web app (W-SITE): 0080 web sessions (W-AUTH), 0081 webstore (W-STORE),
	// 0082 web usage (W-KEY); 0090 runners (W-RELAY), 0091 cloud (W-CLOUD).
	{80, 89, "W web"},
	{90, 99, "W runners and cloud"},
	{100, 109, ""}, // reserved: ask the B0 owner for a range of ten
	{110, 119, "announcements"},
	{120, 129, "service status"},
	{130, 139, "(retired)"},
	{140, 149, "account sessions"},
	{150, 159, "account profile and onboarding"},
	{160, 169, "artifact embeds"},
	{170, 179, "scheduled task triggers"},
	{180, 189, "artifact mail"},
	{190, 199, ""}, // reserved: ask the B0 owner for a range of ten
}

func claudexMigrationOwner(number int) (string, error) {
	for _, r := range claudexMigrationRanges {
		if number >= r.from && number <= r.to {
			if r.owner == "" {
				return "", fmt.Errorf("number %04d is reserved; ask the B0 owner to allocate a range", number)
			}
			return r.owner, nil
		}
	}
	return "", fmt.Errorf("number %04d is outside every allocated range", number)
}

// TestClaudexMigrationRangesAreDisjoint checks the allocation table: every
// number 1-199 belongs to exactly one range, and the round 2 ranges are the
// ones PLAN.md assigned (R1 0060-0069, R3 0070-0079).
func TestClaudexMigrationRangesAreDisjoint(t *testing.T) {
	seen := map[int]int{}
	for _, r := range claudexMigrationRanges {
		require.LessOrEqual(t, r.from, r.to)
		for n := r.from; n <= r.to; n++ {
			seen[n]++
		}
	}
	for n := 1; n <= 199; n++ {
		require.Equal(t, 1, seen[n], "number %04d", n)
	}
	for n, want := range map[int]string{60: "R1 sharing", 69: "R1 sharing", 70: "R3 memory", 79: "R3 memory"} {
		owner, err := claudexMigrationOwner(n)
		require.NoError(t, err)
		require.Equal(t, want, owner)
	}
	_, err := claudexMigrationOwner(100)
	require.ErrorContains(t, err, "reserved")
}

func TestClaudexMigrationsAreNamedAndOrderedAfterUpstream(t *testing.T) {
	files, err := fs.Glob(FS, "*.sql")
	require.NoError(t, err)
	sort.Strings(files)
	requireClaudexMigrationOrder(t, files)
}

func requireClaudexMigrationOrder(t *testing.T, sortedFiles []string) {
	t.Helper()
	seenClaudex := false
	numbers := map[string]string{}
	for _, name := range sortedFiles {
		if strings.HasPrefix(name, "claudex_") {
			m := claudexMigrationName.FindStringSubmatch(name)
			require.NotNil(t, m, "Claudex migration %s must be named claudex_NNNN_description.sql", name)
			require.NotContains(t, numbers, m[1], "Claudex migrations %s and %s share number %s", numbers[m[1]], name, m[1])
			numbers[m[1]] = name
			seenClaudex = true
			continue
		}
		require.False(t, seenClaudex, "upstream migration %s sorts after a Claudex migration", name)
		require.Regexp(t, `^[0-9]`, name, "upstream migration %s must start with a digit so Claudex migrations sort after it", name)
	}
}

func TestClaudexMigrationOrderCheck(t *testing.T) {
	names := []string{"001_init.sql", "240_affiliate_ledger_operation_id.sql", "99_late.sql", "claudex_0001_device_keys.sql", "claudex_0002_usage_rules_notx.sql"}
	sort.Strings(names)
	require.Equal(t, "claudex_0001_device_keys.sql", names[3], "claudex_ sorts after every digit-prefixed name")
	requireClaudexMigrationOrder(t, names)

	for _, bad := range []string{"claudex_1_x.sql", "claudex_0001-x.sql", "claudex_0001_X.sql", "claudex_0001_.sql"} {
		require.Nil(t, claudexMigrationName.FindStringSubmatch(bad), bad)
	}
}

// TestClaudexMigrationsFollowTheRules checks every claudex_*.sql file: its
// number is allocated, and its statements are idempotent and leave upstream
// tables alone.
func TestClaudexMigrationsFollowTheRules(t *testing.T) {
	files, err := fs.Glob(FS, "claudex_*.sql")
	require.NoError(t, err)
	for _, name := range files {
		raw, err := fs.ReadFile(FS, name)
		require.NoError(t, err)
		require.NoError(t, checkClaudexMigration(name, string(raw)), name)
	}
}

var (
	sqlLineComment   = regexp.MustCompile(`--[^\n]*`)
	sqlBlockComment  = regexp.MustCompile(`(?s)/\*.*?\*/`)
	sqlCreate        = regexp.MustCompile(`(?i)\bCREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX|SEQUENCE|TYPE|VIEW|MATERIALIZED\s+VIEW|FUNCTION|TRIGGER|EXTENSION|SCHEMA)\b(\s+CONCURRENTLY)?(\s+IF\s+NOT\s+EXISTS)?`)
	sqlCreateOrRepl  = regexp.MustCompile(`(?i)\bCREATE\s+OR\s+REPLACE\b`)
	sqlAlterTable    = regexp.MustCompile(`(?i)\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?"?([A-Za-z0-9_.]+)"?`)
	sqlDropTable     = regexp.MustCompile(`(?i)\bDROP\s+(TABLE|INDEX|VIEW|SEQUENCE)\s+(?:IF\s+EXISTS\s+)?"?([A-Za-z0-9_.]+)"?`)
	sqlWrite         = regexp.MustCompile(`(?i)\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+(?:ONLY\s+)?"?([A-Za-z0-9_.]+)"?`)
	sqlConcurrently  = regexp.MustCompile(`(?i)\bCONCURRENTLY\b`)
	sqlNotAWrite     = regexp.MustCompile(`(?i)\b(ON|DO)\s+(UPDATE|DELETE)\b`) // FK actions, ON CONFLICT DO UPDATE
	sqlCompliance    = regexp.MustCompile(`(?i)admin_compliance`)
	sqlClaudexObject = regexp.MustCompile(`^(?:public\.)?claudex_[a-z0-9_]+$`)
)

// checkClaudexMigration returns the first rule the migration breaks.
func checkClaudexMigration(name, sql string) error {
	m := claudexMigrationName.FindStringSubmatch(name)
	if m == nil {
		return fmt.Errorf("bad name")
	}
	number, _ := strconv.Atoi(m[1])
	if _, err := claudexMigrationOwner(number); err != nil {
		return err
	}
	body := sqlBlockComment.ReplaceAllString(sqlLineComment.ReplaceAllString(sql, ""), "")
	if sqlCompliance.MatchString(body) {
		return fmt.Errorf("must not touch the admin compliance acknowledgement")
	}
	if sqlCreateOrRepl.MatchString(body) {
		return fmt.Errorf("CREATE OR REPLACE is not allowed; create Claudex objects with IF NOT EXISTS")
	}
	for _, c := range sqlCreate.FindAllStringSubmatch(body, -1) {
		if strings.TrimSpace(c[3]) == "" {
			return fmt.Errorf("%q needs IF NOT EXISTS", strings.TrimSpace(c[0]))
		}
	}
	for _, a := range sqlAlterTable.FindAllStringSubmatch(body, -1) {
		if !sqlClaudexObject.MatchString(strings.ToLower(a[1])) {
			return fmt.Errorf("ALTER TABLE %s: upstream tables must not change", a[1])
		}
	}
	for _, d := range sqlDropTable.FindAllStringSubmatch(body, -1) {
		if !sqlClaudexObject.MatchString(strings.ToLower(d[2])) {
			return fmt.Errorf("DROP %s %s: only Claudex objects may be dropped", d[1], d[2])
		}
	}
	for _, w := range sqlWrite.FindAllStringSubmatch(sqlNotAWrite.ReplaceAllString(body, ""), -1) {
		if !sqlClaudexObject.MatchString(strings.ToLower(w[1])) {
			return fmt.Errorf("%q: migrations only write Claudex tables", strings.TrimSpace(w[0]))
		}
	}
	if sqlConcurrently.MatchString(body) && !strings.HasSuffix(name, "_notx.sql") {
		return fmt.Errorf("CONCURRENTLY needs a separate _notx migration")
	}
	return nil
}

func TestCheckClaudexMigrationRules(t *testing.T) {
	good := `-- claudex_0020_devices.sql
CREATE TABLE IF NOT EXISTS claudex_devices (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
    api_key_id BIGINT NULL REFERENCES api_keys(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO claudex_devices (user_id) VALUES (1) ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW();
CREATE UNIQUE INDEX IF NOT EXISTS uq_claudex_devices_user ON claudex_devices (user_id);
ALTER TABLE claudex_devices ADD COLUMN IF NOT EXISTS note TEXT;
UPDATE claudex_devices SET note = '' WHERE note IS NULL;`
	require.NoError(t, checkClaudexMigration("claudex_0020_devices.sql", good))
	// Round 2 ranges (B-S).
	require.NoError(t, checkClaudexMigration("claudex_0060_sharing.sql", `CREATE TABLE IF NOT EXISTS claudex_shares (id BIGSERIAL PRIMARY KEY);`))
	require.NoError(t, checkClaudexMigration("claudex_0070_memory.sql", `CREATE TABLE IF NOT EXISTS claudex_memory_docs (id BIGSERIAL PRIMARY KEY);`))
	// Web app ranges (W-SITE).
	require.NoError(t, checkClaudexMigration("claudex_0080_web.sql", `CREATE TABLE IF NOT EXISTS claudex_web_sessions (id BIGSERIAL PRIMARY KEY);`))
	require.NoError(t, checkClaudexMigration("claudex_0090_cloud.sql", `CREATE TABLE IF NOT EXISTS claudex_cloud_envs (id BIGSERIAL PRIMARY KEY);`))
	require.NoError(t, checkClaudexMigration("claudex_0021_devices_index_notx.sql",
		`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_claudex_devices_seen ON claudex_devices (last_seen_at);`))

	for _, tc := range []struct{ name, sql, want string }{
		{"claudex_0001_x.sql", good, "reserved"},
		{"claudex_0100_x.sql", good, "reserved"},
		{"claudex_0199_x.sql", good, "reserved"},
		{"claudex_0200_x.sql", good, "outside"},
		{"claudex_0010_meta.sql", `CREATE TABLE claudex_model_meta (id BIGINT);`, "IF NOT EXISTS"},
		{"claudex_0010_meta.sql", `CREATE UNIQUE INDEX uq_x ON claudex_model_meta (id);`, "IF NOT EXISTS"},
		{"claudex_0030_rules.sql", `ALTER TABLE users ADD COLUMN claudex_x TEXT;`, "upstream tables"},
		{"claudex_0030_rules.sql", `ALTER TABLE IF EXISTS api_keys DROP COLUMN x;`, "upstream tables"},
		{"claudex_0030_rules.sql", `INSERT INTO settings (key, value) VALUES ('claudex_x', '{}');`, "only write Claudex"},
		{"claudex_0030_rules.sql", `UPDATE groups SET status = 'active';`, "only write Claudex"},
		{"claudex_0030_rules.sql", `DROP TABLE IF EXISTS usage_logs;`, "only Claudex objects"},
		{"claudex_0040_fb.sql", `-- note
CREATE TABLE IF NOT EXISTS claudex_x (v TEXT DEFAULT 'admin_compliance');`, "compliance"},
		{"claudex_0040_fb.sql", `CREATE OR REPLACE FUNCTION f() RETURNS int AS 'select 1' LANGUAGE sql;`, "OR REPLACE"},
		{"claudex_0050_voice.sql", `CREATE INDEX CONCURRENTLY IF NOT EXISTS i ON claudex_x (a);`, "_notx"},
	} {
		err := checkClaudexMigration(tc.name, tc.sql)
		require.Error(t, err, "%s: %s", tc.name, tc.sql)
		require.Contains(t, err.Error(), tc.want, tc.sql)
	}
}
