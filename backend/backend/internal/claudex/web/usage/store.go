package usage

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"
)

// usageLink is one claudex_web_usage_links row.
type usageLink struct {
	RequestID    string
	APIKeyID     int64
	UserID       int64
	Conversation string
	WebSession   string
	Model        string
	CostUSD      float64
	At           time.Time
}

// RunnerUsage is one run's resources (claudex_web_runner_usage).
type RunnerUsage struct {
	UserID         int64
	ConversationID string
	RunnerID       string
	Mode           string // chat | cowork | code
	WallSeconds    float64
	CPUSeconds     float64
	StartedAt      time.Time
	EndedAt        time.Time
	ExitReason     string
}

// ModelUsage is the billed usage of one model in a conversation.
type ModelUsage struct {
	Model    string  `json:"model"`
	Requests int64   `json:"requests"`
	CostUSD  float64 `json:"cost_usd"`
}

// RunnerTotals sums runner resources.
type RunnerTotals struct {
	Runs        int64   `json:"runs"`
	WallSeconds float64 `json:"wall_seconds"`
	CPUSeconds  float64 `json:"cpu_seconds"`
}

// ConversationUsage is the usage of one web conversation.
type ConversationUsage struct {
	UserID         int64        `json:"user_id"`
	ConversationID string       `json:"conversation_id"`
	Requests       int64        `json:"requests"`
	CostUSD        float64      `json:"cost_usd"`
	Models         []ModelUsage `json:"models"`
	Runner         RunnerTotals `json:"runner"`
	FirstAt        *time.Time   `json:"first_at"`
	LastAt         *time.Time   `json:"last_at"`
}

// ConversationRow is one line of the admin conversation list.
type ConversationRow struct {
	UserID         int64     `json:"user_id"`
	UserEmail      string    `json:"user_email"`
	ConversationID string    `json:"conversation_id"`
	Requests       int64     `json:"requests"`
	CostUSD        float64   `json:"cost_usd"`
	LastAt         time.Time `json:"last_at"`
}

// RunnerSummaryRow sums runner resources per mode and runner.
type RunnerSummaryRow struct {
	Mode     string `json:"mode"`
	RunnerID string `json:"runner_id"`
	RunnerTotals
	Users int64 `json:"users"`
}

type sqlStore struct{ db *sql.DB }

func (s sqlStore) insertLink(ctx context.Context, l usageLink) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO claudex_web_usage_links
	(request_id, api_key_id, user_id, conversation_id, web_session_id, model, cost_usd, created_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (request_id, api_key_id) DO NOTHING`,
		clip(l.RequestID, 255), l.APIKeyID, l.UserID, l.Conversation, l.WebSession, clip(l.Model, 128), l.CostUSD, l.At.UTC())
	return err
}

func (s sqlStore) insertRunnerUsage(ctx context.Context, r RunnerUsage) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO claudex_web_runner_usage
	(user_id, conversation_id, runner_id, mode, wall_seconds, cpu_seconds, started_at, ended_at, exit_reason)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		r.UserID, r.ConversationID, r.RunnerID, r.Mode, r.WallSeconds, r.CPUSeconds, r.StartedAt.UTC(), r.EndedAt.UTC(), r.ExitReason)
	return err
}

// conversation sums the usage of one conversation of one user.
func (s sqlStore) conversation(ctx context.Context, userID int64, conversationID string) (*ConversationUsage, error) {
	out := &ConversationUsage{UserID: userID, ConversationID: conversationID, Models: []ModelUsage{}}
	rows, err := s.db.QueryContext(ctx, `SELECT model, COUNT(*), COALESCE(SUM(cost_usd), 0)::float8, MIN(created_at), MAX(created_at)
FROM claudex_web_usage_links WHERE user_id = $1 AND conversation_id = $2
GROUP BY model ORDER BY model`, userID, conversationID)
	if err != nil {
		return nil, fmt.Errorf("claudex web usage: read conversation usage: %w", err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var m ModelUsage
		var first, last time.Time
		if err := rows.Scan(&m.Model, &m.Requests, &m.CostUSD, &first, &last); err != nil {
			return nil, fmt.Errorf("claudex web usage: read conversation usage: %w", err)
		}
		out.Models = append(out.Models, m)
		out.Requests += m.Requests
		out.CostUSD += m.CostUSD
		first, last = first.UTC(), last.UTC()
		if out.FirstAt == nil || first.Before(*out.FirstAt) {
			out.FirstAt = &first
		}
		if out.LastAt == nil || last.After(*out.LastAt) {
			out.LastAt = &last
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("claudex web usage: read conversation usage: %w", err)
	}
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*), COALESCE(SUM(wall_seconds), 0), COALESCE(SUM(cpu_seconds), 0)
FROM claudex_web_runner_usage WHERE user_id = $1 AND conversation_id = $2`, userID, conversationID).
		Scan(&out.Runner.Runs, &out.Runner.WallSeconds, &out.Runner.CPUSeconds); err != nil {
		return nil, fmt.Errorf("claudex web usage: read conversation runner usage: %w", err)
	}
	return out, nil
}

// conversations lists conversations by last billed request (admin).
func (s sqlStore) conversations(ctx context.Context, userID int64, since time.Time, limit int) ([]ConversationRow, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT l.user_id, COALESCE(u.email, ''), l.conversation_id, COUNT(*), COALESCE(SUM(l.cost_usd), 0)::float8, MAX(l.created_at)
FROM claudex_web_usage_links l LEFT JOIN users u ON u.id = l.user_id
WHERE ($1::bigint = 0 OR l.user_id = $1) AND l.created_at >= $2
GROUP BY l.user_id, u.email, l.conversation_id
ORDER BY MAX(l.created_at) DESC
LIMIT $3`, userID, since.UTC(), limit)
	if err != nil {
		return nil, fmt.Errorf("claudex web usage: list conversations: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := []ConversationRow{}
	for rows.Next() {
		var r ConversationRow
		if err := rows.Scan(&r.UserID, &r.UserEmail, &r.ConversationID, &r.Requests, &r.CostUSD, &r.LastAt); err != nil {
			return nil, fmt.Errorf("claudex web usage: list conversations: %w", err)
		}
		r.LastAt = r.LastAt.UTC()
		out = append(out, r)
	}
	return out, rows.Err()
}

// runnerSummary sums runner resources since a time (admin).
func (s sqlStore) runnerSummary(ctx context.Context, userID int64, since time.Time) ([]RunnerSummaryRow, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT mode, runner_id, COUNT(*), COALESCE(SUM(wall_seconds), 0), COALESCE(SUM(cpu_seconds), 0), COUNT(DISTINCT user_id)
FROM claudex_web_runner_usage
WHERE ($1::bigint = 0 OR user_id = $1) AND started_at >= $2
GROUP BY mode, runner_id
ORDER BY mode, runner_id`, userID, since.UTC())
	if err != nil {
		return nil, fmt.Errorf("claudex web usage: runner summary: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := []RunnerSummaryRow{}
	for rows.Next() {
		var r RunnerSummaryRow
		if err := rows.Scan(&r.Mode, &r.RunnerID, &r.Runs, &r.WallSeconds, &r.CPUSeconds, &r.Users); err != nil {
			return nil, fmt.Errorf("claudex web usage: runner summary: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// clip cuts s to n bytes on a rune boundary.
func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return strings.ToValidUTF8(s[:n], "")
}
