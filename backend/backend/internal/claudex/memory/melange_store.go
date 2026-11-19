package memory

import (
	"context"
	"database/sql"
	"errors"
)

type melangeRow struct {
	Revision int64
	StateEnc sql.NullString
}

type melangeWrite struct {
	BaseRevision int64
	StateEnc     string
	StateBytes   int
	Prefs        prefsWrite
}

func (s *sqlStore) melange(ctx context.Context, userID int64) (melangeRow, error) {
	if err := s.ready(); err != nil {
		return melangeRow{}, err
	}
	var row melangeRow
	err := s.db.QueryRowContext(ctx, `SELECT revision, state_enc FROM claudex_memory_melange WHERE user_id = $1`, userID).
		Scan(&row.Revision, &row.StateEnc)
	if errors.Is(err, sql.ErrNoRows) {
		err = nil
	}
	return row, err
}

func (s *sqlStore) saveMelange(ctx context.Context, userID int64, w melangeWrite) (int64, error) {
	var revision int64
	err := s.withUserLock(ctx, userID, func(tx *sql.Tx) error {
		err := tx.QueryRowContext(ctx, `SELECT revision FROM claudex_memory_melange WHERE user_id = $1`, userID).Scan(&revision)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if revision != w.BaseRevision {
			return &conflictError{Current: revision}
		}
		err = tx.QueryRowContext(ctx, `
			INSERT INTO claudex_memory_melange (user_id, revision, state_enc, state_bytes) VALUES ($1, 1, $2, $3)
			ON CONFLICT (user_id) DO UPDATE SET revision = claudex_memory_melange.revision + 1,
				state_enc = EXCLUDED.state_enc, state_bytes = EXCLUDED.state_bytes, updated_at = NOW()
			RETURNING revision`, userID, w.StateEnc, w.StateBytes).Scan(&revision)
		if err != nil || w.Prefs.Generate == nil {
			return err
		}
		return writePrefs(ctx, tx, userID, w.Prefs)
	})
	return revision, err
}

// Keep the revision after a reset to invalidate writes started before it, even if the account was empty.
func clearMelange(ctx context.Context, tx *sql.Tx, userID int64) (bool, error) {
	var hadState bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS (
		SELECT 1 FROM claudex_memory_melange WHERE user_id = $1 AND state_enc IS NOT NULL)`, userID).Scan(&hadState); err != nil {
		return false, err
	}
	_, err := tx.ExecContext(ctx, `
		INSERT INTO claudex_memory_melange (user_id, revision, state_enc, state_bytes) VALUES ($1, 1, NULL, 0)
		ON CONFLICT (user_id) DO UPDATE SET revision = claudex_memory_melange.revision + 1,
			state_enc = NULL, state_bytes = 0, updated_at = NOW()`, userID)
	return hadState, err
}
