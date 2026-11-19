package feedback

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strconv"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// Separate from collection policy: a person can withdraw retained feedback
// after collection stops. Only the signed-in subject supplies the user id.
type ownHistoryStore interface {
	listOwnFeedback(context.Context, int64, *historyCursor, int) ([]Feedback, error)
	withdrawFeedback(context.Context, int64, string) error
}

type historyCursor struct {
	User int64     `json:"u"`
	ID   int64     `json:"i"`
	At   time.Time `json:"t"`
}

type ownFeedbackItem struct {
	ID         string    `json:"id"`
	CreatedAt  time.Time `json:"createdAt"`
	Rating     string    `json:"rating"`
	Categories []string  `json:"categories"`
	Comment    string    `json:"comment"`
	HasExcerpt bool      `json:"hasExcerpt"`
}

func (c *Component) ownFeedbackHistory(g *gin.Context) {
	middleware.SkipAudit(g)
	g.Header("Cache-Control", "no-store")
	user, ok := core.Subject(g)
	if !ok {
		response.ErrorFrom(g, errUnauthorized)
		return
	}
	limit := 50
	if raw := g.Query("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 100 {
			response.ErrorFrom(g, invalidFilter("limit"))
			return
		}
		limit = parsed
	}
	var before *historyCursor
	if raw := g.Query("cursor"); raw != "" {
		if len(raw) > 512 {
			response.ErrorFrom(g, invalidFilter("cursor"))
			return
		}
		decoded, err := base64.RawURLEncoding.DecodeString(raw)
		var cursor historyCursor
		if err != nil || json.Unmarshal(decoded, &cursor) != nil || cursor.User != user || cursor.ID < 1 || cursor.At.IsZero() {
			response.ErrorFrom(g, invalidFilter("cursor"))
			return
		}
		before = &cursor
	}
	storage, ok := c.store.(ownHistoryStore)
	if !ok {
		response.ErrorFrom(g, errListFailed)
		return
	}
	rows, err := storage.listOwnFeedback(g.Request.Context(), user, before, limit+1)
	if err != nil {
		response.ErrorFrom(g, errListFailed.WithCause(err))
		return
	}
	items := make([]ownFeedbackItem, 0, limit)
	next := ""
	if len(rows) > limit {
		last := rows[limit-1]
		data, _ := json.Marshal(historyCursor{User: user, ID: last.ID, At: last.CreatedAt})
		next = base64.RawURLEncoding.EncodeToString(data)
		rows = rows[:limit]
	}
	for _, row := range rows {
		categories := row.Categories
		if categories == nil {
			categories = []string{}
		}
		items = append(items, ownFeedbackItem{ID: row.FeedbackUUID, CreatedAt: row.CreatedAt, Rating: row.Rating, Categories: categories, Comment: row.Comment, HasExcerpt: row.HasExcerpt})
	}
	response.Success(g, struct {
		Version    int               `json:"version"`
		Items      []ownFeedbackItem `json:"items"`
		NextCursor string            `json:"nextCursor,omitempty"`
	}{1, items, next})
}

func (c *Component) withdrawOwnFeedback(g *gin.Context) {
	middleware.SkipAudit(g)
	g.Header("Cache-Control", "no-store")
	user, ok := core.Subject(g)
	if !ok {
		response.ErrorFrom(g, errUnauthorized)
		return
	}
	id, err := uuid.Parse(g.Param("uuid"))
	if err != nil {
		response.ErrorFrom(g, ErrReportNotFound)
		return
	}
	storage, ok := c.store.(ownHistoryStore)
	if !ok {
		response.ErrorFrom(g, errListFailed)
		return
	}
	if err = storage.withdrawFeedback(g.Request.Context(), user, id.String()); err != nil {
		if err == ErrReportNotFound {
			response.ErrorFrom(g, err)
			return
		}
		response.ErrorFrom(g, errListFailed.WithCause(err))
		return
	}
	response.Success(g, struct {
		Withdrawn bool `json:"withdrawn"`
	}{true})
}

func (s *sqlStore) listOwnFeedback(ctx context.Context, user int64, before *historyCursor, limit int) ([]Feedback, error) {
	if s == nil || s.db == nil {
		return nil, errNoDatabase
	}
	query := `SELECT ` + feedbackColumns + ` FROM claudex_feedback WHERE user_id = $1`
	args := []any{user}
	if before != nil {
		query += ` AND (created_at, id) < ($2, $3)`
		args = append(args, before.At, before.ID)
	}
	args = append(args, limit)
	query += ` ORDER BY created_at DESC, id DESC LIMIT $` + strconv.Itoa(len(args))
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Feedback{}
	for rows.Next() {
		item, err := scanFeedback(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *sqlStore) withdrawFeedback(ctx context.Context, user int64, id string) (err error) {
	if s == nil || s.db == nil {
		return errNoDatabase
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// Same lock as intake. A racing retry can never recreate a withdrawn UUID.
	if err = lockUser(ctx, tx, tableFeedback, user); err != nil {
		return err
	}
	var exists bool
	if err = tx.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM claudex_feedback WHERE user_id = $1 AND feedback_uuid = $2::uuid UNION ALL SELECT 1 FROM claudex_feedback_withdrawals WHERE user_id = $1 AND feedback_uuid = $2::uuid)`, user, id).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return ErrReportNotFound
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO claudex_feedback_withdrawals (user_id, feedback_uuid) VALUES ($1, $2::uuid) ON CONFLICT DO NOTHING`, user, id); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM claudex_feedback WHERE user_id = $1 AND feedback_uuid = $2::uuid`, user, id); err != nil {
		return err
	}
	return tx.Commit()
}
