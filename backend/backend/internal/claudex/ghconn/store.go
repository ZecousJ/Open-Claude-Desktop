package ghconn

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

var errNoRows = errors.New("ghconn: no such row")

// connection is a user's stored GitHub connection. The token fields are
// sealed (core.SecretBox); no plaintext token is ever stored.
type connection struct {
	UserID        int64
	GitHubID      int64
	Login         string
	AvatarURL     string
	TokenSealed   string
	RefreshSealed string // "" when the token does not expire
	ExpiresAt     *time.Time
	Scope         string
	ConnectedAt   time.Time
}

// oauthState is an authorization in flight.
type oauthState struct {
	UserID         int64
	VerifierSealed string
	ExpiresAt      time.Time
}

// store is the persistence of the component (sqlStore in production, a map in
// unit tests).
type store interface {
	putState(ctx context.Context, hash string, s oauthState) error
	// takeState reads and deletes the state in one step (it is single use);
	// an unknown or expired one answers errNoRows.
	takeState(ctx context.Context, hash string, now time.Time) (oauthState, error)
	upsert(ctx context.Context, c connection) error
	get(ctx context.Context, userID int64) (connection, error)
	// updateTokens stores refreshed tokens; it does nothing when the user
	// disconnected meanwhile.
	updateTokens(ctx context.Context, userID int64, tokenSealed, refreshSealed string, expiresAt *time.Time) error
	remove(ctx context.Context, userID int64) error
	sweep(ctx context.Context, now time.Time) error
}

type sqlStore struct{ db *sql.DB }

func (s *sqlStore) putState(ctx context.Context, hash string, st oauthState) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO claudex_github_oauth_states (state_hash, user_id, verifier_ciphertext, expires_at)
VALUES ($1, $2, $3, $4)`, hash, st.UserID, st.VerifierSealed, st.ExpiresAt)
	return err
}

func (s *sqlStore) takeState(ctx context.Context, hash string, now time.Time) (oauthState, error) {
	var st oauthState
	err := s.db.QueryRowContext(ctx, `
DELETE FROM claudex_github_oauth_states WHERE state_hash = $1
RETURNING user_id, verifier_ciphertext, expires_at`, hash).Scan(&st.UserID, &st.VerifierSealed, &st.ExpiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return oauthState{}, errNoRows
	}
	if err != nil {
		return oauthState{}, err
	}
	if !st.ExpiresAt.After(now) {
		return oauthState{}, errNoRows
	}
	return st, nil
}

func (s *sqlStore) upsert(ctx context.Context, c connection) error {
	var refresh any
	if c.RefreshSealed != "" {
		refresh = c.RefreshSealed
	}
	_, err := s.db.ExecContext(ctx, `
INSERT INTO claudex_github_connections
    (user_id, github_user_id, login, avatar_url, token_ciphertext, refresh_ciphertext, token_expires_at, scope, connected_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
ON CONFLICT (user_id) DO UPDATE SET
    github_user_id = EXCLUDED.github_user_id, login = EXCLUDED.login, avatar_url = EXCLUDED.avatar_url,
    token_ciphertext = EXCLUDED.token_ciphertext, refresh_ciphertext = EXCLUDED.refresh_ciphertext,
    token_expires_at = EXCLUDED.token_expires_at, scope = EXCLUDED.scope,
    connected_at = EXCLUDED.connected_at, updated_at = EXCLUDED.updated_at`,
		c.UserID, c.GitHubID, c.Login, c.AvatarURL, c.TokenSealed, refresh, c.ExpiresAt, c.Scope, c.ConnectedAt)
	return err
}

func (s *sqlStore) get(ctx context.Context, userID int64) (connection, error) {
	var c connection
	var refresh sql.NullString
	var exp sql.NullTime
	err := s.db.QueryRowContext(ctx, `
SELECT user_id, github_user_id, login, avatar_url, token_ciphertext, refresh_ciphertext, token_expires_at, scope, connected_at
FROM claudex_github_connections WHERE user_id = $1`, userID).
		Scan(&c.UserID, &c.GitHubID, &c.Login, &c.AvatarURL, &c.TokenSealed, &refresh, &exp, &c.Scope, &c.ConnectedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return connection{}, errNoRows
	}
	if err != nil {
		return connection{}, err
	}
	c.RefreshSealed = refresh.String
	if exp.Valid {
		t := exp.Time
		c.ExpiresAt = &t
	}
	return c, nil
}

func (s *sqlStore) updateTokens(ctx context.Context, userID int64, tokenSealed, refreshSealed string, expiresAt *time.Time) error {
	var refresh any
	if refreshSealed != "" {
		refresh = refreshSealed
	}
	_, err := s.db.ExecContext(ctx, `
UPDATE claudex_github_connections
SET token_ciphertext = $2, refresh_ciphertext = $3, token_expires_at = $4, updated_at = NOW()
WHERE user_id = $1`, userID, tokenSealed, refresh, expiresAt)
	return err
}

func (s *sqlStore) remove(ctx context.Context, userID int64) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM claudex_github_connections WHERE user_id = $1`, userID)
	return err
}

func (s *sqlStore) sweep(ctx context.Context, now time.Time) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM claudex_github_oauth_states WHERE expires_at < $1`, now)
	return err
}
