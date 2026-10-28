package voice

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Session is one relayed dictation session (claudex_voice_sessions).
type Session struct {
	// RequestID is the billing request id (prefix claudex_audio:).
	RequestID     string
	UserID        int64
	APIKeyID      int64
	GroupID       *int64
	AudioBytes    int64
	BilledSeconds float64
	CostUSD       float64
	// Billed is false when the billing was not applied (a duplicate request
	// id, a zero price, or an error).
	Billed     bool
	DurationMs int64
	EndReason  string
}

// SessionItem is one row of GET /api/v1/admin/claudex/voice/estimated-usage.
// Every session is billed from its byte count, so every row is an estimate
// (owner decision 6); estimated_seconds is audio_bytes / 32000.
type SessionItem struct {
	RequestID        string    `json:"request_id"`
	UserID           int64     `json:"user_id"`
	UserEmail        *string   `json:"user_email"` // null when the user was deleted
	APIKeyID         *int64    `json:"api_key_id"`
	GroupID          *int64    `json:"group_id"`
	AudioBytes       int64     `json:"audio_bytes"`
	EstimatedSeconds float64   `json:"estimated_seconds"`
	CostUSD          float64   `json:"cost_usd"`
	Billed           bool      `json:"billed"`
	DurationMs       int64     `json:"duration_ms"`
	EndReason        string    `json:"end_reason"`
	CreatedAt        time.Time `json:"created_at"`
}

var errSessionStoreUnavailable = errors.New("voice: session store unavailable")

const insertSessionSQL = `INSERT INTO claudex_voice_sessions
    (request_id, user_id, api_key_id, group_id, audio_bytes, billed_seconds, cost_usd, billed, duration_ms, end_reason)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
ON CONFLICT (request_id) DO NOTHING`

func insertSession(ctx context.Context, db *sql.DB, s Session) error {
	s.RequestID = strings.TrimSpace(s.RequestID)
	if s.RequestID == "" || len(s.RequestID) > 255 {
		return fmt.Errorf("voice: invalid request id %q", s.RequestID)
	}
	if s.UserID <= 0 {
		return errors.New("voice: session without user")
	}
	if len(s.EndReason) > 64 {
		s.EndReason = s.EndReason[:64]
	}
	apiKeyID := sql.NullInt64{Int64: s.APIKeyID, Valid: s.APIKeyID > 0}
	var groupID sql.NullInt64
	if s.GroupID != nil {
		groupID = sql.NullInt64{Int64: *s.GroupID, Valid: true}
	}
	if _, err := db.ExecContext(ctx, insertSessionSQL,
		s.RequestID, s.UserID, apiKeyID, groupID, s.AudioBytes, s.BilledSeconds, s.CostUSD, s.Billed,
		s.DurationMs, s.EndReason); err != nil {
		return fmt.Errorf("voice: store session %s: %w", s.RequestID, err)
	}
	return nil
}

const countSessionsSQL = `SELECT COUNT(*) FROM claudex_voice_sessions s
WHERE ($1::bigint IS NULL OR s.user_id = $1::bigint)`

const listSessionsSQL = `SELECT s.request_id, s.user_id, u.email, s.api_key_id, s.group_id,
       s.audio_bytes, s.billed_seconds::float8, s.cost_usd::float8, s.billed, s.duration_ms,
       s.end_reason, s.created_at
FROM claudex_voice_sessions s
LEFT JOIN users u ON u.id = s.user_id AND u.deleted_at IS NULL
WHERE ($1::bigint IS NULL OR s.user_id = $1::bigint)
ORDER BY s.created_at DESC, s.request_id DESC
LIMIT $2 OFFSET $3`

func listSessions(ctx context.Context, db *sql.DB, userID *int64, page, pageSize int) ([]SessionItem, int64, error) {
	var filter sql.NullInt64
	if userID != nil {
		filter = sql.NullInt64{Int64: *userID, Valid: true}
	}
	var total int64
	if err := db.QueryRowContext(ctx, countSessionsSQL, filter).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("voice: count sessions: %w", err)
	}
	items := []SessionItem{}
	offset := (page - 1) * pageSize
	if total == 0 || int64(offset) >= total {
		return items, total, nil
	}
	rows, err := db.QueryContext(ctx, listSessionsSQL, filter, pageSize, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("voice: list sessions: %w", err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var (
			it      SessionItem
			email   sql.NullString
			keyID   sql.NullInt64
			groupID sql.NullInt64
		)
		if err := rows.Scan(&it.RequestID, &it.UserID, &email, &keyID, &groupID, &it.AudioBytes,
			&it.EstimatedSeconds, &it.CostUSD, &it.Billed, &it.DurationMs, &it.EndReason, &it.CreatedAt); err != nil {
			return nil, 0, fmt.Errorf("voice: read session: %w", err)
		}
		if email.Valid {
			v := email.String
			it.UserEmail = &v
		}
		if keyID.Valid {
			v := keyID.Int64
			it.APIKeyID = &v
		}
		if groupID.Valid {
			v := groupID.Int64
			it.GroupID = &v
		}
		it.CreatedAt = it.CreatedAt.UTC()
		items = append(items, it)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("voice: read sessions: %w", err)
	}
	return items, total, nil
}
