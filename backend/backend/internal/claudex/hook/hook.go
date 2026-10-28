// Package claudexhook is the registry behind the Claudex hooks in upstream
// service, handler and middleware code.
//
// Upstream Sub2API files call the dispatch functions of this package with a
// single marked line ("// CLAUDEX: Hn ..."); the Claudex module installs the
// implementations once at startup (claudex.ProvideModule). The package only
// depends on the standard library so every upstream layer can import it
// without an import cycle. Until Install runs, every dispatch function is a
// no-op that returns the zero value, so upstream behavior and upstream tests
// are unchanged.
package claudexhook

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync/atomic"
	"time"
)

// UsageEvent describes one request whose usage was billed (H8).
type UsageEvent struct {
	RequestID string
	UserID    int64
	APIKeyID  int64
	GroupID   *int64
	// RequestedModel is the model the client wrote, BilledModel the model the
	// request was billed as, UpstreamModel the model sent upstream after
	// channel or group mapping (empty when unknown).
	RequestedModel string
	BilledModel    string
	UpstreamModel  string
	// CostUSD is the billed cost after the group and user multipliers
	// (CostBreakdown.ActualCost).
	CostUSD float64
	At      time.Time
}

// SessionState is the answer of the JWT revocation check (H9b).
type SessionState int

const (
	// Valid means the access token may be used.
	Valid SessionState = iota
	// Revoked means the token was issued before a "log out of all devices" or
	// belongs to a signed-out device session: answer 401 CLAUDEX_SESSION_REVOKED.
	Revoked
	// CheckFailed means the revocation state could not be read and no cached
	// answer exists: answer 503 CLAUDEX_SESSION_CHECK_FAILED (fail closed).
	CheckFailed
)

// Hooks holds the implementations. A nil field keeps upstream behavior.
type Hooks struct {
	// UsageApplied runs once per billed request, after the billing
	// transaction committed (H8). It must not block for long.
	UsageApplied func(ctx context.Context, ev UsageEvent)
	// SessionsRevoked runs when a user logs out of all devices (H9). An error
	// makes the endpoint answer 500 so the client retries.
	SessionsRevoked func(ctx context.Context, userID int64, reason string) error
	// JWTRevoked checks every access token after the upstream token-version
	// check (H9b).
	JWTRevoked func(ctx context.Context, userID int64, issuedAt time.Time, sessionID string) SessionState
	// ManagedAPIKeyIDs returns which of the user's key ids are Claudex device
	// keys (H13): those are read-only and masked in /api/v1/keys.
	ManagedAPIKeyIDs func(ctx context.Context, userID int64, ids []int64) map[int64]bool
	// PrecheckTurn checks the usage rules for one Responses WebSocket turn
	// (H14). A non-nil error closes the connection with the error text.
	PrecheckTurn func(ctx context.Context, userID, apiKeyID int64, groupID *int64, models []string) error
	// CreateAPIKey decides whether a user may create an API key through the
	// upstream /api/v1/keys endpoint (H13, owner decision 17). A non-nil
	// error is written to the client as is (use an infraerrors value).
	CreateAPIKey func(ctx context.Context, userID int64, isAdmin bool) error
	// TokensIssued runs after the upstream /api/v1/auth endpoints answered a
	// token pair (sign-in, 2FA, sign-up, refresh) (H16), so the phone apps'
	// sign-ins are listed under Active sessions. It must not block for long.
	TokensIssued func(ctx context.Context, ev TokenIssue)
	// TokensReturned runs when /api/v1/auth/logout revoked a refresh token
	// (H16), with that token's session family.
	TokensReturned func(ctx context.Context, userID int64, sessionID string)
}

// TokenIssue describes a token pair the upstream auth endpoints answered (H16).
type TokenIssue struct {
	UserID    int64
	SessionID string
	UserAgent string
	IP        string
	// Platform is the X-Claudex-Platform header ("" for clients without it).
	Platform string
	// Refreshed is true for /api/v1/auth/refresh.
	Refreshed bool
}

var installed atomic.Pointer[Hooks]

// Install sets the implementations. Only claudex.ProvideModule calls it (once
// in production); a later call replaces the earlier hooks.
func Install(h Hooks) {
	installed.Store(&h)
}

// Reset removes every implementation (tests).
func Reset() {
	installed.Store(nil)
}

func current() *Hooks {
	return installed.Load()
}

// usageTimeout bounds UsageApplied, which runs detached from the caller.
const usageTimeout = 2 * time.Second

// UsageApplied reports a billed request. It runs detached from the caller's
// cancellation with a 2 s timeout; panics are logged and swallowed.
func UsageApplied(ctx context.Context, ev UsageEvent) {
	h := current()
	if h == nil || h.UsageApplied == nil {
		return
	}
	if ctx == nil {
		ctx = context.Background()
	}
	hookCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), usageTimeout)
	defer cancel()
	defer recoverAndLog("UsageApplied")
	h.UsageApplied(hookCtx, ev)
}

// SessionsRevoked reports "log out of all devices". It returns the hook's
// error (and turns a panic into an error) so the caller can fail the request.
func SessionsRevoked(ctx context.Context, userID int64, reason string) (err error) {
	h := current()
	if h == nil || h.SessionsRevoked == nil {
		return nil
	}
	defer func() {
		if r := recover(); r != nil {
			slog.Error("claudexhook: SessionsRevoked panicked", "panic", r)
			err = fmt.Errorf("claudex: sessions revoked hook panicked: %v", r)
		}
	}()
	return h.SessionsRevoked(ctx, userID, reason)
}

// JWTRevoked checks an access token. Without a hook it answers Valid; a
// panicking hook answers CheckFailed (fail closed).
func JWTRevoked(ctx context.Context, userID int64, issuedAt time.Time, sessionID string) (state SessionState) {
	h := current()
	if h == nil || h.JWTRevoked == nil {
		return Valid
	}
	defer func() {
		if r := recover(); r != nil {
			slog.Error("claudexhook: JWTRevoked panicked", "panic", r)
			state = CheckFailed
		}
	}()
	return h.JWTRevoked(ctx, userID, issuedAt, sessionID)
}

// ManagedAPIKeyIDs returns the subset of ids that are Claudex device keys of
// the user. It never returns nil. A panicking hook fails closed: every id
// counts as a device key (masked, read-only), so a broken lookup never shows
// a device key's plaintext or lets it be edited.
func ManagedAPIKeyIDs(ctx context.Context, userID int64, ids []int64) (out map[int64]bool) {
	out = map[int64]bool{}
	h := current()
	if h == nil || h.ManagedAPIKeyIDs == nil || len(ids) == 0 {
		return out
	}
	defer func() {
		if r := recover(); r != nil {
			slog.Error("claudexhook: ManagedAPIKeyIDs panicked", "panic", r)
			out = make(map[int64]bool, len(ids))
			for _, id := range ids {
				out[id] = true
			}
		}
	}()
	if got := h.ManagedAPIKeyIDs(ctx, userID, ids); got != nil {
		out = got
	}
	return out
}

// ManagedAPIKey reports whether keyID is a Claudex device key of the user.
func ManagedAPIKey(ctx context.Context, userID, keyID int64) bool {
	return ManagedAPIKeyIDs(ctx, userID, []int64{keyID})[keyID]
}

// PrecheckTurn checks the usage rules for one WebSocket turn. A panicking
// hook fails closed like the HTTP guards (H5b): the turn is refused, because
// the rules must not be bypassable (owner decision 8).
func PrecheckTurn(ctx context.Context, userID, apiKeyID int64, groupID *int64, models []string) (err error) {
	h := current()
	if h == nil || h.PrecheckTurn == nil {
		return nil
	}
	defer func() {
		if r := recover(); r != nil {
			slog.Error("claudexhook: PrecheckTurn panicked", "panic", r)
			err = errors.New("CLAUDEX_USAGE_CHECK_FAILED: usage limits could not be checked, try again")
		}
	}()
	return h.PrecheckTurn(ctx, userID, apiKeyID, groupID, models)
}

// CreateAPIKeyAllowed returns nil when the user may create an API key through
// /api/v1/keys, or the error to answer with.
func CreateAPIKeyAllowed(ctx context.Context, userID int64, isAdmin bool) (err error) {
	h := current()
	if h == nil || h.CreateAPIKey == nil {
		return nil
	}
	defer func() {
		if r := recover(); r != nil {
			slog.Error("claudexhook: CreateAPIKey panicked", "panic", r)
			err = fmt.Errorf("claudex: create api key hook panicked: %v", r)
		}
	}()
	return h.CreateAPIKey(ctx, userID, isAdmin)
}

// tokenTimeout bounds TokensIssued and TokensReturned.
const tokenTimeout = 2 * time.Second

// TokensIssued reports a token pair the upstream auth endpoints answered. It
// runs detached from the caller's cancellation with a 2 s timeout; panics
// are logged and swallowed (the sign-in itself already succeeded).
func TokensIssued(ctx context.Context, ev TokenIssue) {
	h := current()
	if h == nil || h.TokensIssued == nil || ev.UserID <= 0 || ev.SessionID == "" {
		return
	}
	if ctx == nil {
		ctx = context.Background()
	}
	hookCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), tokenTimeout)
	defer cancel()
	defer recoverAndLog("TokensIssued")
	h.TokensIssued(hookCtx, ev)
}

// TokensReturned reports a refresh token given back at log out, like
// TokensIssued (detached, bounded, panics swallowed).
func TokensReturned(ctx context.Context, userID int64, sessionID string) {
	h := current()
	if h == nil || h.TokensReturned == nil || userID <= 0 || sessionID == "" {
		return
	}
	if ctx == nil {
		ctx = context.Background()
	}
	hookCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), tokenTimeout)
	defer cancel()
	defer recoverAndLog("TokensReturned")
	h.TokensReturned(hookCtx, userID, sessionID)
}

// MaskKey hides an API key except for its last four characters:
// "sk-…a1b2" for sk- keys, "…a1b2" otherwise.
func MaskKey(key string) string {
	const ellipsis = "…"
	prefix := ""
	if strings.HasPrefix(key, "sk-") {
		prefix = "sk-"
	}
	rest := []rune(strings.TrimPrefix(key, prefix))
	if len(rest) <= 4 {
		return prefix + ellipsis
	}
	return prefix + ellipsis + string(rest[len(rest)-4:])
}

func recoverAndLog(name string) {
	if r := recover(); r != nil {
		slog.Error("claudexhook: hook panicked", "hook", name, "panic", r)
	}
}
