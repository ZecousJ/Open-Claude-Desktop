package onboarding

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
)

// store is the persistence the handlers use (sqlStore; a memory store in tests).
type store interface {
	// start writes the pending row of a new account; an existing row stays.
	start(ctx context.Context, userID int64, now time.Time) error
	// get returns nil when the account has no row (made before onboarding).
	get(ctx context.Context, userID int64) (*row, error)
	// save writes the answers. A new row (an account made before onboarding)
	// is finished from the start; finish ends a pending one.
	save(ctx context.Context, userID int64, a Answers, finish bool, now time.Time) (*row, error)
}

type sqlStore struct{ db *sql.DB }

const columns = `user_id, work_function, hear_about, hear_about_platform, hear_about_other, code_setup,
	connected_tools, first_task, science_fields, started_at, finished_at, updated_at`

type scanner interface{ Scan(dest ...any) error }

func scanRow(s scanner) (*row, error) {
	var r row
	var tools, science string
	var finished sql.NullTime
	err := s.Scan(&r.UserID, &r.Answers.WorkFunction, &r.Answers.HearAbout, &r.Answers.HearAboutPlatform,
		&r.Answers.HearAboutOther, &r.Answers.CodeSetup, &tools, &r.Answers.FirstTask, &science,
		&r.StartedAt, &finished, &r.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	r.Answers.ConnectedTools = splitTools(tools)
	r.Answers.ScienceFields = splitTools(science)
	if finished.Valid {
		t := finished.Time
		r.FinishedAt = &t
	}
	return &r, nil
}

// Tool names are stored one per line (names never hold a line break).
func joinTools(tools []string) string { return strings.Join(tools, "\n") }

func splitTools(raw string) []string {
	out := []string{}
	for _, name := range strings.Split(raw, "\n") {
		if name = strings.TrimSpace(name); name != "" {
			out = append(out, name)
		}
	}
	return out
}

func (s *sqlStore) start(ctx context.Context, userID int64, now time.Time) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO claudex_onboarding (user_id, started_at, updated_at)
		VALUES ($1, $2, $2) ON CONFLICT (user_id) DO NOTHING`, userID, now)
	return err
}

func (s *sqlStore) get(ctx context.Context, userID int64) (*row, error) {
	return scanRow(s.db.QueryRowContext(ctx, `SELECT `+columns+` FROM claudex_onboarding WHERE user_id = $1`, userID))
}

func (s *sqlStore) save(ctx context.Context, userID int64, a Answers, finish bool, now time.Time) (*row, error) {
	return scanRow(s.db.QueryRowContext(ctx, `INSERT INTO claudex_onboarding AS o (user_id, work_function, hear_about,
			hear_about_platform, hear_about_other, code_setup, connected_tools, first_task, science_fields,
			started_at, finished_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $11, $9, $9, $9)
		ON CONFLICT (user_id) DO UPDATE SET
			work_function = EXCLUDED.work_function,
			hear_about = EXCLUDED.hear_about,
			hear_about_platform = EXCLUDED.hear_about_platform,
			hear_about_other = EXCLUDED.hear_about_other,
			code_setup = EXCLUDED.code_setup,
			connected_tools = EXCLUDED.connected_tools,
			first_task = EXCLUDED.first_task,
			science_fields = EXCLUDED.science_fields,
			finished_at = CASE WHEN $10 THEN COALESCE(o.finished_at, $9) ELSE o.finished_at END,
			updated_at = $9
		RETURNING `+columns,
		userID, a.WorkFunction, a.HearAbout, a.HearAboutPlatform, a.HearAboutOther, a.CodeSetup,
		joinTools(a.ConnectedTools), a.FirstTask, now, finish, joinTools(a.ScienceFields)))
}
