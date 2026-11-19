package sharing

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"time"

	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/gin-gonic/gin"
)

type EditAccessRequest struct {
	Email     string    `json:"email"`
	Status    string    `json:"status"`
	UpdatedAt time.Time `json:"updated_at"`
}

func (s *sqlStore) editAccessRequests(ctx context.Context, id int64) ([]EditAccessRequest, error) {
	if err := s.ok(); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT email, status, updated_at FROM claudex_artifact_edit_requests WHERE share_id=$1 ORDER BY updated_at, email`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []EditAccessRequest{}
	for rows.Next() {
		var request EditAccessRequest
		if err := rows.Scan(&request.Email, &request.Status, &request.UpdatedAt); err != nil {
			return nil, err
		}
		result = append(result, request)
	}
	return result, rows.Err()
}

func (s *sqlStore) editAccess(ctx context.Context, id int64, email, decision string, now time.Time) (status string, err error) {
	if err = s.ok(); err != nil {
		return "", err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	var active bool
	err = tx.QueryRowContext(ctx, `SELECT status='active' AND kind='artifact' AND (expires_at IS NULL OR expires_at>$2) FROM claudex_shares WHERE id=$1 FOR UPDATE`, id, now).Scan(&active)
	if err != nil {
		return "", err
	}
	if !active {
		return "unavailable", nil
	}
	var role string
	err = tx.QueryRowContext(ctx, `SELECT role FROM claudex_share_invites WHERE share_id=$1 AND email=$2 FOR UPDATE`, id, email).Scan(&role)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	if role != "" && decision == "" {
		if role != "edit" {
			return "unavailable", nil
		}
		return "already_granted", nil
	}
	var previous EditAccessRequest
	err = tx.QueryRowContext(ctx, `SELECT status, updated_at FROM claudex_artifact_edit_requests WHERE share_id=$1 AND email=$2`, id, email).Scan(&previous.Status, &previous.UpdatedAt)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	if decision != "" && previous.Status != "pending" {
		return "unavailable", nil
	}
	if decision == "" {
		if previous.Status == "pending" {
			return "already_pending", nil
		}
		if previous.Status == "declined" && now.Before(previous.UpdatedAt.Add(24*time.Hour)) {
			return "cooldown", nil
		}
		status = "pending"
	} else {
		status = decision
	}
	if status == "granted" {
		if _, err = tx.ExecContext(ctx, `INSERT INTO claudex_share_invites (share_id,email,created_at,role) VALUES ($1,$2,$3,'edit') ON CONFLICT (share_id,email) DO UPDATE SET role='edit'`, id, email, now); err != nil {
			return "", err
		}
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO claudex_artifact_edit_requests (share_id,email,status,updated_at) VALUES ($1,$2,$3,$4) ON CONFLICT (share_id,email) DO UPDATE SET status=EXCLUDED.status, updated_at=EXCLUDED.updated_at`, id, email, status, now)
	if err != nil {
		return "", err
	}
	return status, tx.Commit()
}

func (c *Component) postArtifactEditAccess(g *gin.Context) {
	row, userID := c.sharedWithMe(g)
	if row == nil {
		return
	}
	if row.Kind != KindArtifact {
		response.Success(g, gin.H{"status": "unavailable"})
		return
	}
	var body struct {
		Email    string `json:"email"`
		Decision string `json:"decision"`
	}
	g.Request.Body = http.MaxBytesReader(g.Writer, g.Request.Body, 4096)
	if err := g.ShouldBindJSON(&body); err != nil {
		response.ErrorFrom(g, invalidShare("body", "The request failed."))
		return
	}
	email := c.emailOf(g.Request.Context(), userID)
	if body.Decision != "" {
		if row.UserID != userID || (body.Decision != "granted" && body.Decision != "declined") || body.Email == "" || len(body.Email) > 254 {
			response.ErrorFrom(g, ErrShareNotFound)
			return
		}
		email = body.Email
	} else if row.UserID == userID {
		response.Success(g, gin.H{"status": "already_granted"})
		return
	}
	if email == "" {
		response.Success(g, gin.H{"status": "unavailable"})
		return
	}
	status, err := c.store.editAccess(g.Request.Context(), row.ID, email, body.Decision, c.now())
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	if status == "cooldown" {
		g.Header("Retry-After", "86400")
		response.ErrorFrom(g, infraerrors.New(http.StatusTooManyRequests, "CLAUDEX_EDIT_ACCESS_COOLDOWN", "A recent request was declined. You can ask again later."))
		return
	}
	response.Success(g, gin.H{"status": status})
}
