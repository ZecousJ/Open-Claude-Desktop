package web

// The phone apps' sessions (Settings → Account → Active sessions).
//
// The iOS and Android apps sign in through the upstream /api/v1/auth bearer
// flow, which keeps no list of sessions. Hook H16 tells this component of
// every token pair those endpoints answer and of every refresh token given
// back at log out; each session family becomes a row of
// claudex_native_sessions (user agent, IP, when it began and was last
// used). The desktop app (its X-Claudex-Platform header; its sign-ins are
// claudex_devices rows) and the web app (its own auth routes) are left out.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/geoip"
	claudexhook "github.com/Wei-Shaw/sub2api/internal/claudex/hook"
	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"

	"github.com/gin-gonic/gin"
)

// desktopPlatforms are the X-Claudex-Platform values of the desktop app.
var desktopPlatforms = map[string]bool{"darwin": true, "win32": true, "linux": true}

// NativeSessionList answers GET /api/v1/claudex/native-sessions.
type NativeSessionList struct {
	Items            []SessionItem `json:"items"`
	CurrentSessionID int64         `json:"current_session_id,omitempty"`
}

// OnTokensIssued implements core.TokenObserver: a sign-in starts a row, a
// refresh records the last use (a session from before this table starts
// its row at its first refresh).
func (c *Component) OnTokensIssued(ctx context.Context, ev claudexhook.TokenIssue) {
	if c.env.DB == nil || ev.UserID <= 0 || ev.SessionID == "" || desktopPlatforms[ev.Platform] {
		return
	}
	now := c.now()
	if err := c.store.recordNative(ctx, ev.UserID, clip(ev.SessionID, 64), clip(ev.UserAgent, 256), clip(ev.IP, 64), now, now.Add(c.refreshTTL())); err != nil {
		slog.Warn("claudex web: recording a sign-in failed", "user_id", ev.UserID, "error", err)
	}
}

// OnTokensReturned implements core.TokenObserver: a log out ends the row.
func (c *Component) OnTokensReturned(ctx context.Context, userID int64, sessionID string) {
	if c.env.DB == nil || userID <= 0 || sessionID == "" {
		return
	}
	if err := c.store.endNative(ctx, userID, sessionID, RevokedLogout, c.now()); err != nil {
		slog.Warn("claudex web: ending a sign-in failed", "user_id", userID, "error", err)
	}
}

// GET /native-sessions: the user's signed-in phone apps (and other bearer
// clients), most recently used first; current marks the caller's own.
func (c *Component) listNativeSessions(g *gin.Context) {
	uid, ok := core.Subject(g)
	if !ok {
		response.Unauthorized(g, "User not authenticated")
		return
	}
	if c.env.DB == nil {
		response.ErrorFrom(g, errUnavailable)
		return
	}
	rows, err := c.store.listNative(g.Request.Context(), uid, c.now())
	if err != nil {
		response.ErrorFrom(g, errUnavailable)
		return
	}
	sid := core.SessionID(g)
	out := NativeSessionList{Items: make([]SessionItem, 0, len(rows))}
	for _, r := range rows {
		cur := sid != "" && r.FamilyID == sid
		if cur {
			out.CurrentSessionID = r.ID
		}
		out.Items = append(out.Items, SessionItem{Session: r, Current: cur, LocationInfo: geoip.Lookup(r.IP)})
	}
	response.Success(g, out)
}

// DELETE /native-sessions/:id: signs one of them out (its refresh tokens
// are deleted and its access tokens refused at once).
func (c *Component) deleteNativeSession(g *gin.Context) {
	ctx := g.Request.Context()
	uid, ok := core.Subject(g)
	if !ok {
		response.Unauthorized(g, "User not authenticated")
		return
	}
	id, err := strconv.ParseInt(g.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		response.ErrorFrom(g, infraerrors.BadRequest(webproto.ErrCodeBadRequest, "Invalid session id."))
		return
	}
	if c.env.DB == nil {
		response.ErrorFrom(g, errUnavailable)
		return
	}
	now := c.now()
	family, err := c.store.revokeNative(ctx, uid, id, now, c.revokedUntil(now))
	if errors.Is(err, errNoSession) {
		response.ErrorFrom(g, infraerrors.NotFound("CLAUDEX_NATIVE_SESSION_NOT_FOUND", "Session not found."))
		return
	}
	if err != nil {
		response.ErrorFrom(g, errUnavailable)
		return
	}
	c.dropFamilies(ctx, []string{family})
	response.Success(g, gin.H{"id": id, "revoked": true})
}

const nativeColumns = `s.id, s.user_id, s.family_id, s.user_agent, s.ip, s.created_at, s.last_seen_at, s.expires_at, s.revoked_at, s.revoked_reason`

// recordNative starts a session's row or records its last use. An ended
// row stays ended, and a family never moves to another user.
func (s *store) recordNative(ctx context.Context, userID int64, family, ua, ip string, now, expiresAt time.Time) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO claudex_native_sessions (user_id, family_id, user_agent, ip, created_at, last_seen_at, expires_at)
VALUES ($1, $2, $3, $4, $5, $5, $6)
ON CONFLICT (family_id) DO UPDATE SET user_agent = EXCLUDED.user_agent, ip = EXCLUDED.ip,
  last_seen_at = EXCLUDED.last_seen_at, expires_at = EXCLUDED.expires_at
WHERE claudex_native_sessions.revoked_at IS NULL AND claudex_native_sessions.user_id = EXCLUDED.user_id`,
		userID, family, ua, ip, now, expiresAt)
	if err != nil {
		return fmt.Errorf("claudex web: record native session: %w", err)
	}
	return nil
}

// endNative ends the row of a family the user gave back (log out).
func (s *store) endNative(ctx context.Context, userID int64, family, reason string, now time.Time) error {
	_, err := s.db.ExecContext(ctx, `UPDATE claudex_native_sessions SET revoked_at = $3, revoked_reason = $4
WHERE family_id = $1 AND user_id = $2 AND revoked_at IS NULL`, family, userID, now, reason)
	if err != nil {
		return fmt.Errorf("claudex web: end native session: %w", err)
	}
	return nil
}

// listNative returns the user's active sessions, most recently used first.
// A family a desktop device registered with is the desktop's row instead.
func (s *store) listNative(ctx context.Context, userID int64, now time.Time) ([]Session, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+nativeColumns+` FROM claudex_native_sessions s
WHERE s.user_id = $1 AND s.revoked_at IS NULL AND s.expires_at > $2
  AND NOT EXISTS (SELECT 1 FROM claudex_devices d WHERE d.user_id = s.user_id AND d.session_family_id = s.family_id)
ORDER BY s.last_seen_at DESC, s.id DESC LIMIT $3`, userID, now, maxListed)
	if err != nil {
		return nil, fmt.Errorf("claudex web: list native sessions: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := []Session{}
	for rows.Next() {
		sess, err := scanSession(rows)
		if err != nil {
			return nil, fmt.Errorf("claudex web: scan native session: %w", err)
		}
		out = append(out, *sess)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("claudex web: list native sessions: %w", err)
	}
	return out, nil
}

// revokeNative ends one active session of the user and records its family
// as revoked. It returns the family, errNoSession when no active row matched.
func (s *store) revokeNative(ctx context.Context, userID, id int64, now, revokedUntil time.Time) (string, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", fmt.Errorf("claudex web: begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var family string
	err = tx.QueryRowContext(ctx, `UPDATE claudex_native_sessions SET revoked_at = $3, revoked_reason = 'user'
WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > $3 RETURNING family_id`, id, userID, now).Scan(&family)
	if errors.Is(err, sql.ErrNoRows) {
		return "", errNoSession
	}
	if err != nil {
		return "", fmt.Errorf("claudex web: revoke native session: %w", err)
	}
	if err := markFamiliesRevoked(ctx, tx, userID, []string{family}, now, revokedUntil); err != nil {
		return "", err
	}
	if err := tx.Commit(); err != nil {
		return "", fmt.Errorf("claudex web: commit: %w", err)
	}
	return family, nil
}

// revokeAllNative ends every row of the user ("log out of all devices"; the
// upstream revoke-all already ended the families themselves).
func (s *store) revokeAllNative(ctx context.Context, userID int64, now time.Time) error {
	_, err := s.db.ExecContext(ctx, `UPDATE claudex_native_sessions SET revoked_at = $2, revoked_reason = 'revoke_all'
WHERE user_id = $1 AND revoked_at IS NULL`, userID, now)
	if err != nil {
		return fmt.Errorf("claudex web: revoke native sessions: %w", err)
	}
	return nil
}

// cleanupNative drops rows that expired or ended more than keep ago.
func (s *store) cleanupNative(ctx context.Context, now time.Time, keep time.Duration) (int64, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM claudex_native_sessions
WHERE expires_at < $1 OR (revoked_at IS NOT NULL AND revoked_at < $1)`, now.Add(-keep))
	if err != nil {
		return 0, fmt.Errorf("claudex web: cleanup native sessions: %w", err)
	}
	n, _ := res.RowsAffected()
	return n, nil
}

var _ core.TokenObserver = (*Component)(nil)
