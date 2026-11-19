package memory

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

type memoryReader interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

type memoryRows struct {
	Docs         []docRow
	Edits        []editRow
	Versions     map[string]string
	EmptyVersion string
}

type controlsConflictError struct{ Reset bool }

func (e *controlsConflictError) Error() string { return "claudex memory: controls changed" }

func readControlsVersions(ctx context.Context, tx *sql.Tx, userID int64) (map[string]string, string, error) {
	rows, err := tx.QueryContext(ctx, `SELECT scope, revision, reset_revision FROM claudex_memory_versions WHERE user_id = $1`, userID)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	type version struct {
		scope           string
		revision, reset int64
	}
	values := []version{}
	var epoch int64
	for rows.Next() {
		var v version
		if err := rows.Scan(&v.scope, &v.revision, &v.reset); err != nil {
			return nil, "", err
		}
		if v.scope == "" {
			epoch = v.revision
		} else {
			values = append(values, v)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	empty := fmt.Sprintf("v1:%d:0:0", epoch)
	versions := map[string]string{}
	for _, v := range values {
		versions[v.scope] = fmt.Sprintf("v1:%d:%d:%d", epoch, v.reset, v.revision)
	}
	return versions, empty, nil
}

func checkControlsVersion(ctx context.Context, tx *sql.Tx, userID int64, scope, base string) error {
	versions, empty, err := readControlsVersions(ctx, tx, userID)
	if err != nil {
		return err
	}
	current := versions[scope]
	if current == "" {
		current = empty
	}
	if current != base {
		a, b := strings.Split(base, ":"), strings.Split(current, ":")
		reset := len(a) != 4 || a[0] != "v1" || a[1] != b[1] || a[2] != b[2]
		return &controlsConflictError{Reset: reset}
	}
	return nil
}

func bumpControls(ctx context.Context, tx *sql.Tx, userID int64, scope string, reset bool) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO claudex_memory_versions (user_id, scope, revision, reset_revision)
        VALUES ($1, $2, 1, CASE WHEN $3 THEN 1 ELSE 0 END)
        ON CONFLICT (user_id, scope) DO UPDATE SET revision = claudex_memory_versions.revision + 1,
        reset_revision = claudex_memory_versions.reset_revision + CASE WHEN $3 THEN 1 ELSE 0 END`, userID, scope, reset)
	return err
}

func (s *sqlStore) snapshot(ctx context.Context, userID int64, scope string) (memoryRows, error) {
	var out memoryRows
	err := s.withUserLock(ctx, userID, func(tx *sql.Tx) (err error) {
		if out.Docs, err = readDocs(ctx, tx, userID, scope); err != nil {
			return err
		}
		if out.Edits, err = readEdits(ctx, tx, userID, scope); err != nil {
			return err
		}
		out.Versions, out.EmptyVersion, err = readControlsVersions(ctx, tx, userID)
		return err
	})
	return out, err
}

func (s *sqlStore) replaceControls(ctx context.Context, userID int64, scope string, edits []editWrite, base string) ([]editRow, string, error) {
	out := []editRow{}
	var version string
	err := s.withUserLock(ctx, userID, func(tx *sql.Tx) error {
		if err := checkControlsVersion(ctx, tx, userID, scope, base); err != nil {
			return err
		}
		if len(edits) > MaxEditsPerScope {
			return errEditLimit
		}
		if len(edits) > 0 {
			if err := checkScopeRoom(ctx, tx, userID, scope, MaxScopes); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM claudex_memory_edits WHERE user_id = $1 AND scope = $2`, userID, scope); err != nil {
			return err
		}
		for _, edit := range edits {
			saved := editRow{Scope: scope, TextEnc: edit.TextEnc, TextBytes: edit.TextBytes, DeviceID: edit.DeviceID}
			if err := tx.QueryRowContext(ctx, `INSERT INTO claudex_memory_edits (user_id, scope, text_enc, text_bytes, device_id, created_at)
                VALUES ($1,$2,$3,$4,$5,NOW()) RETURNING id, created_at`, userID, scope, edit.TextEnc, edit.TextBytes, edit.DeviceID).Scan(&saved.ID, &saved.CreatedAt); err != nil {
				return err
			}
			out = append(out, saved)
		}
		if err := bumpControls(ctx, tx, userID, scope, false); err != nil {
			return err
		}
		versions, _, err := readControlsVersions(ctx, tx, userID)
		version = versions[scope]
		return err
	})
	return out, version, err
}
