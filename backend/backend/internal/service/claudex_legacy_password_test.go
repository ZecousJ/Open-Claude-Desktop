//go:build unit

// CLAUDEX: ZMIG — sign-in with passwords imported from another service.

package service

import (
	"context"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	"golang.org/x/crypto/bcrypt"
)

// passlib bcrypt_sha256 v2 (rounds 4) and werkzeug pbkdf2 hashes of this
// password; generated with passlib 1.7.4 / werkzeug 3 (see legacypw tests).
const (
	zmigPassword     = "correct horse battery staple"
	zmigPasslibHash  = "$bcrypt-sha256$v=2,t=2b,r=4$g.KXyKrsnYGb4dyhquY11e$vQZL03xE38FkuJqXiDwqw3DjVW9JjNy"
	zmigWerkzeugHash = "pbkdf2:sha256:1000$bwIAYKGbSgQQsupq$625ad9f533557de84af07b881de4dbb259f7e9d43bfffb4b9720628cf91f0d72"
)

func zmigLoginFixture(hash, status string) (*AuthService, *userRepoStub, *User) {
	user := &User{ID: 42, Email: "migrated@example.com", PasswordHash: hash, Role: RoleUser, Status: status}
	repo := &userRepoStub{usersByEmail: map[string]*User{user.Email: user}}
	return newAuthService(repo, nil, nil, nil), repo, user
}

func TestClaudexLoginUpgradesLegacyHashToBcrypt(t *testing.T) {
	for _, hash := range []string{zmigPasslibHash, zmigWerkzeugHash} {
		svc, repo, _ := zmigLoginFixture(hash, StatusActive)

		token, user, err := svc.Login(context.Background(), "migrated@example.com", zmigPassword)
		require.NoError(t, err)
		require.Len(t, repo.updated, 1)
		stored := repo.updated[0].PasswordHash
		require.True(t, strings.HasPrefix(stored, "$2a$"), stored)
		require.NoError(t, bcrypt.CompareHashAndPassword([]byte(stored), []byte(zmigPassword)))
		require.Equal(t, stored, user.PasswordHash)

		// The token must carry the version derived from the stored (new) hash,
		// otherwise the JWT middleware would reject it straight away.
		claims, err := svc.ValidateToken(token)
		require.NoError(t, err)
		fresh := &User{Email: user.Email, PasswordHash: stored}
		require.Equal(t, resolvedTokenVersion(fresh), claims.TokenVersion)

		// Next sign-in uses plain bcrypt and writes nothing.
		_, _, err = svc.Login(context.Background(), "migrated@example.com", zmigPassword)
		require.NoError(t, err)
		require.Len(t, repo.updated, 1)
	}
}

func TestClaudexLoginWrongPasswordKeepsLegacyHash(t *testing.T) {
	svc, repo, user := zmigLoginFixture(zmigPasslibHash, StatusActive)
	_, _, err := svc.Login(context.Background(), "migrated@example.com", "wrong")
	require.ErrorIs(t, err, ErrInvalidCredentials)
	require.Empty(t, repo.updated)
	require.Equal(t, zmigPasslibHash, user.PasswordHash)
}

func TestClaudexLoginBcryptUserUnchanged(t *testing.T) {
	h, err := bcrypt.GenerateFromPassword([]byte(zmigPassword), bcrypt.MinCost)
	require.NoError(t, err)
	svc, repo, _ := zmigLoginFixture(string(h), StatusActive)
	_, _, err = svc.Login(context.Background(), "migrated@example.com", zmigPassword)
	require.NoError(t, err)
	require.Empty(t, repo.updated)
}

func TestClaudexLoginDisabledMigratedUserStillRejected(t *testing.T) {
	svc, _, _ := zmigLoginFixture(zmigPasslibHash, StatusDisabled)
	_, _, err := svc.Login(context.Background(), "migrated@example.com", zmigPassword)
	require.ErrorIs(t, err, ErrUserNotActive)
}

func TestClaudexUserCheckPasswordAcceptsLegacyHash(t *testing.T) {
	// Password confirmations (change password, TOTP, passkeys, backups) go through
	// User.CheckPassword and must accept a migrated user's hash too.
	u := &User{PasswordHash: zmigWerkzeugHash}
	require.True(t, u.CheckPassword(zmigPassword))
	require.False(t, u.CheckPassword("nope"))
	require.NoError(t, u.SetPassword("new-password"))
	require.True(t, strings.HasPrefix(u.PasswordHash, "$2a$"))
}
