package zmigrate

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

type failingRemote struct{}

func (failingRemote) Quote(context.Context, string) (Answer, error) {
	return Answer{}, errors.New("ssh: connect to host: connection refused")
}

func (failingRemote) Confirm(context.Context, string, int64) (Answer, error) {
	return Answer{}, errors.New("ssh: connect to host: connection refused")
}

func writeSnapshot(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "snapshot.json")
	body := `{"taken_at":"2026-10-14T00:00:00Z","answers":{"Ann@Example.com":{"ok":true,"found":true,"total_cny":"163.59","balance_cny":"0.00","subscription_cny":"163.59"}}}`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestSnapshotAnswersWhenTheServerIsGone(t *testing.T) {
	remote := withSnapshot(failingRemote{}, writeSnapshot(t))
	ctx := context.Background()
	quote, err := remote.Quote(ctx, " ann@example.COM ")
	if err != nil || !quote.Found || quote.TotalCNY != "163.59" {
		t.Fatalf("quote = %+v, %v", quote, err)
	}
	confirm, err := remote.Confirm(ctx, "ann@example.com", 7)
	if err != nil || !confirm.Migrated || confirm.TotalCNY != "163.59" {
		t.Fatalf("confirm = %+v, %v", confirm, err)
	}
	none, err := remote.Quote(ctx, "bob@example.com")
	if err != nil || none.Found {
		t.Fatalf("an unknown email has no account: %+v, %v", none, err)
	}
}

func TestSnapshotWithoutAServer(t *testing.T) {
	remote := withSnapshot(nil, writeSnapshot(t))
	if quote, err := remote.Quote(context.Background(), "ann@example.com"); err != nil || !quote.Found {
		t.Fatalf("quote = %+v, %v", quote, err)
	}
}

func TestNoSnapshotKeepsTheServerOnly(t *testing.T) {
	if remote := withSnapshot(nil, ""); remote != nil {
		t.Fatalf("no target and no snapshot should leave the remote unset, got %#v", remote)
	}
}

func TestAMissingSnapshotFileIsAnError(t *testing.T) {
	remote := withSnapshot(failingRemote{}, filepath.Join(t.TempDir(), "missing.json"))
	if _, err := remote.Quote(context.Background(), "ann@example.com"); err == nil {
		t.Fatal("a missing snapshot must not look like \"no account\"")
	}
}
