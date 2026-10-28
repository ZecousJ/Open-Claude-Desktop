// CLAUDEX: ZMIG — Claudex file in the upstream service package.
//
// Users imported from another service keep their passlib/werkzeug password hash until
// their first successful sign-in (see internal/claudex/legacypw). Login calls
// claudexUpgradeLegacyPasswordHash right after the password check so the hash
// is replaced by the standard bcrypt that every other path writes.

package service

import (
	"context"

	"github.com/Wei-Shaw/sub2api/internal/claudex/legacypw"
	"github.com/Wei-Shaw/sub2api/internal/pkg/logger"
)

// claudexUpgradeLegacyPasswordHash rehashes a verified legacy password to
// bcrypt and stores it. It must run before the token is issued: the token
// version is derived from the password hash (resolvedTokenVersion), so the
// token has to be minted from the hash that stays in the database. A failed
// write keeps the legacy hash (the user can still sign in) and is only logged.
func (s *AuthService) claudexUpgradeLegacyPasswordHash(ctx context.Context, user *User, password string) {
	if s == nil || s.userRepo == nil || user == nil || !legacypw.IsLegacy(user.PasswordHash) {
		return
	}
	hashed, err := s.HashPassword(password)
	if err != nil {
		logger.LegacyPrintf("service.auth", "[Auth] legacy password rehash failed: user_id=%d err=%v", user.ID, err)
		return
	}
	previous := user.PasswordHash
	user.PasswordHash = hashed
	if err := s.userRepo.Update(ctx, user, UserUpdateFields{PasswordHash: true}); err != nil {
		user.PasswordHash = previous
		logger.LegacyPrintf("service.auth", "[Auth] legacy password rehash not stored: user_id=%d err=%v", user.ID, err)
		return
	}
	// The stored token version is derived from the hash; drop any value resolved
	// from the old hash so GenerateToken derives it from the new one.
	if user.TokenVersionResolved {
		user.TokenVersionResolved = false
		user.TokenVersion = 0
	}
	logger.LegacyPrintf("service.auth", "[Auth] migrated user password upgraded to bcrypt: user_id=%d scheme=%s", user.ID, legacypw.Detect(previous))
}
