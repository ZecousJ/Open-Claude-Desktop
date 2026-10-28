package service

// CLAUDEX: file added by the Claudex fork (see backend/CLAUDEX_CHANGES.md).
//
// Signup hooks let Claudex code (internal/claudex) prepare per-user state when
// an account is created through any signup path: email registration, OAuth /
// SSO first login and the pending-OAuth email completion. Every one of those
// paths calls AuthService.assignSubscriptions right after the user row is
// committed; the hooks run when that call returns, i.e. after the default
// subscriptions are in place and outside any database transaction.
//
// Hooks are fail-open: an error or panic is logged and never fails or rolls
// back the signup. A hook must be idempotent and must tolerate the user being
// deleted afterwards (the pending-OAuth flow can still roll a new account back
// when its invitation code turns out to be used). Accounts created by an
// administrator do not go through signup and do not run the hooks.

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/pkg/logger"
)

// SignupHook runs once for every newly registered user.
type SignupHook func(ctx context.Context, userID int64) error

// signupHookTimeout bounds each hook; the signup response waits for the hooks.
const signupHookTimeout = 10 * time.Second

type namedSignupHook struct {
	name string
	fn   SignupHook
}

type signupHookList struct {
	mu    sync.RWMutex
	hooks []namedSignupHook
}

// AddSignupHook registers a hook under a short name used in logs. Hooks run in
// registration order. Register hooks during startup, before serving requests.
func (s *AuthService) AddSignupHook(name string, hook SignupHook) {
	if s == nil || hook == nil {
		return
	}
	name = strings.TrimSpace(name)
	if name == "" {
		name = "unnamed"
	}
	s.signupHooks.mu.Lock()
	defer s.signupHooks.mu.Unlock()
	s.signupHooks.hooks = append(s.signupHooks.hooks, namedSignupHook{name: name, fn: hook})
}

func (s *AuthService) runSignupHooks(ctx context.Context, userID int64) {
	if s == nil || userID <= 0 {
		return
	}
	s.signupHooks.mu.RLock()
	hooks := append([]namedSignupHook(nil), s.signupHooks.hooks...)
	s.signupHooks.mu.RUnlock()
	if len(hooks) == 0 {
		return
	}
	if ctx == nil {
		ctx = context.Background()
	}
	// The user already exists: finish the hooks even if the client disconnects.
	base := context.WithoutCancel(ctx)
	for _, hook := range hooks {
		if err := runSignupHook(base, hook, userID); err != nil {
			logger.LegacyPrintf("service.auth", "[Auth] Signup hook %q failed for user %d (ignored): %v", hook.name, userID, err)
		}
	}
}

func runSignupHook(base context.Context, hook namedSignupHook, userID int64) (err error) {
	ctx, cancel := context.WithTimeout(base, signupHookTimeout)
	defer cancel()
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("panic: %v", r)
		}
	}()
	return hook.fn(ctx, userID)
}

// RefreshTokenOwner returns the user and session family of a refresh token
// that is still stored (Claudex H16: a log out ends the token's row in the
// Active sessions list). ok is false for an unknown or unreadable token.
func (s *AuthService) RefreshTokenOwner(ctx context.Context, refreshToken string) (userID int64, familyID string, ok bool) {
	if s == nil || s.refreshTokenCache == nil || refreshToken == "" || len(refreshToken) > maxTokenLength {
		return 0, "", false
	}
	data, err := s.refreshTokenCache.GetRefreshToken(ctx, hashToken(refreshToken))
	if err != nil || data == nil || data.UserID <= 0 || data.FamilyID == "" {
		return 0, "", false
	}
	return data.UserID, data.FamilyID, true
}
