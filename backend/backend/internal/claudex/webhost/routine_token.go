package webhost

import (
	"context"
	"log/slog"

	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
)

// routineToken answers routine.token: an access token for a user who has
// scheduled tasks, so the runner can open the user's context when a task is
// due. Only an active user the web switch and allowlist still admit gets one.
// The token is remembered like any the relay saw (key.get and the deadline
// interrupt read it) and is never logged.
func (c *Component) routineToken(ctx context.Context, userID int64) (any, error) {
	b := c.backends()
	u, err := b.LookupUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	if !u.Active {
		return nil, infraerrors.Forbidden("CLAUDEX_ACCOUNT_DISABLED", "This account is turned off.")
	}
	if err := b.CheckAccess(ctx, userID, u.Email, u.Admin); err != nil {
		return nil, err
	}
	token, err := b.WakeToken(ctx, userID)
	if err != nil {
		return nil, err
	}
	claims, err := b.ParseToken(token)
	if err != nil {
		return nil, err
	}
	c.tokens.put(userID, userToken{raw: token, claims: claims})
	slog.Info("claudex webhost: scheduled-task token issued", "user_id", userID)
	return map[string]string{"accessToken": token}, nil
}
