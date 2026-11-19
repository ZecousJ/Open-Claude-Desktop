package migrations

import (
	"io/fs"
	"testing"
)

// Tests actual embed discovery, not migration application to a database.
func TestProductFeedbackMigrationEmbedded(t *testing.T) {
	names, err := fs.Glob(FS, "*.sql")
	if err != nil {
		t.Fatal(err)
	}
	const target = "claudex_0182_product_feedback.sql"
	for _, name := range names {
		if name == target {
			if body, err := FS.ReadFile(name); err != nil || len(body) == 0 {
				t.Fatal("empty or missing migration", err)
			}
			return
		}
	}
	t.Fatal("product feedback migration missing from embedded FS")
}
