package zmigrate

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
)

// The ZecousAI server (192LAX) closes on 2026-10-15 (owner, 2026-10-12).
// Before it does, every account's quote is taken from its database with
// zmigrate.py's own valuation and kept on the Claudex server as a snapshot:
//
//	{"taken_at": "…", "answers": {"<email>": <Answer>}}
//
// A move then still works once the server is gone: the dialog shows the
// snapshot's amount and confirming credits it. Nothing is cleared on the
// ZecousAI side, which no longer exists; claudex_zecous_migrations still
// credits each Claudex user once.

type snapshotFile struct {
	TakenAt string            `json:"taken_at"`
	Answers map[string]Answer `json:"answers"`
}

// snapshotRemote answers from the snapshot file, read once.
type snapshotRemote struct {
	path    string
	once    sync.Once
	answers map[string]Answer
	err     error
}

func (r *snapshotRemote) load() (map[string]Answer, error) {
	r.once.Do(func() {
		data, err := os.ReadFile(r.path)
		if err != nil {
			r.err = fmt.Errorf("zmigrate snapshot: %w", err)
			return
		}
		var file snapshotFile
		if err := json.Unmarshal(data, &file); err != nil {
			r.err = fmt.Errorf("zmigrate snapshot: %w", err)
			return
		}
		r.answers = make(map[string]Answer, len(file.Answers))
		for email, answer := range file.Answers {
			r.answers[strings.ToLower(strings.TrimSpace(email))] = answer
		}
	})
	return r.answers, r.err
}

func (r *snapshotRemote) Quote(_ context.Context, email string) (Answer, error) {
	answers, err := r.load()
	if err != nil {
		return Answer{}, err
	}
	answer, ok := answers[strings.ToLower(strings.TrimSpace(email))]
	if !ok {
		return Answer{OK: true, Found: false}, nil
	}
	answer.OK = true
	return answer, nil
}

func (r *snapshotRemote) Confirm(ctx context.Context, email string, _ int64) (Answer, error) {
	answer, err := r.Quote(ctx, email)
	if err != nil || !answer.Found {
		return answer, err
	}
	answer.Migrated = true
	return answer, nil
}

// fallbackRemote asks the ZecousAI server first and the snapshot when the
// server cannot answer.
type fallbackRemote struct {
	primary  Remote
	snapshot Remote
}

func (r fallbackRemote) Quote(ctx context.Context, email string) (Answer, error) {
	if r.primary != nil {
		if answer, err := r.primary.Quote(ctx, email); err == nil {
			return answer, nil
		}
	}
	return r.snapshot.Quote(ctx, email)
}

func (r fallbackRemote) Confirm(ctx context.Context, email string, userID int64) (Answer, error) {
	if r.primary != nil {
		if answer, err := r.primary.Confirm(ctx, email, userID); err == nil {
			return answer, nil
		}
	}
	return r.snapshot.Confirm(ctx, email, userID)
}

// withSnapshot puts the snapshot behind the server when one is configured.
func withSnapshot(primary Remote, path string) Remote {
	if path == "" {
		return primary
	}
	return fallbackRemote{primary: primary, snapshot: &snapshotRemote{path: path}}
}
