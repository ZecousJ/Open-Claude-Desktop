// Package webproto is the wire contract of the Claudex web version (web plan
// §1.2, package W-PROTO): the browser RPC and events socket, the runner link
// between Go and claudex-runner, and the stored turn document (schema v1).
//
// It mirrors shared/web-protocol.ts. Both sides check the JSON samples in
// testdata/ (tests/web-protocol.test.ts and this package's tests), so a
// change here needs the same change there. The package has no dependencies
// beyond the standard library; W-AUTH, W-STORE and W-RELAY import it.
package webproto

import (
	"crypto/rand"
	"encoding/base64"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Version is the protocol version carried by hello, ready and welcome frames.
const Version = 1

// Paths of the web version's API (all under /api/v1/claudex/web).
const (
	PathBase = "/api/v1/claudex/web"
	// PathRPC + method: POST with an RPCRequest body.
	PathRPC = PathBase + "/rpc/"
	// PathEvents is the per-tab events WebSocket.
	PathEvents = PathBase + "/events"
	// PathUploads takes chunked uploads.
	PathUploads = PathBase + "/uploads"
	// PathPreview + id + "?k=" + signature serves an artifact preview.
	PathPreview = PathBase + "/preview/"
	// PathAuth is the web sign-in session (W-AUTH); see the Auth* routes.
	PathAuth = PathBase + "/auth/"
	// PathDownloads serves exports and generated files built from webstore.
	PathDownloads = PathBase + "/downloads/"
	// PathRunnerLink is the WebSocket claudex-runner dials.
	PathRunnerLink = PathBase + "/runner/link"
)

// Routes under PathAuth (all POST; refresh and logout use the cookie).
const (
	AuthLogin           = "login"
	AuthTwoFactor       = "2fa"
	AuthCancelTwoFactor = "2fa/cancel"
	AuthRegister        = "register"
	AuthSendCode        = "send-code"
	AuthForgotPassword  = "forgot-password"
	AuthResetPassword   = "reset-password"
	AuthRefresh         = "refresh"
	AuthLogout          = "logout"
	AuthRevokeAll       = "revoke-all"
	AuthEventsTicket    = "events-ticket"
	// AuthVoiceTicket is the dictation socket's ticket (W-VOICE; served by
	// the voice component beside these routes).
	AuthVoiceTicket = "voice-ticket"
	// AuthEmailCodeSend and AuthEmailCodeLogin sign in with a one-time code
	// sent by email (package LOGIN, internal/claudex/signin).
	AuthEmailCodeSend  = "email-code/send"
	AuthEmailCodeLogin = "email-code/login"
	// AuthGoogleLogin signs in with a Google ID token (LOGIN-GOOGLE).
	AuthGoogleLogin = "google/login"
	// AuthPasskeyBegin and AuthPasskeyFinish are the upstream passkey login.
	AuthPasskeyBegin  = "passkey/login/begin"
	AuthPasskeyFinish = "passkey/login/finish"
	// AuthAccounts lists the accounts this browser is signed in to (the
	// account cookies it sends; several accounts per browser).
	AuthAccounts = "accounts"
)

// Headers and names.
const (
	// HeaderWeb is "1" on the cookie endpoints (forces a CORS preflight).
	HeaderWeb = "X-Claudex-Web"
	// HeaderTab carries the tab's random id.
	HeaderTab = "X-Claudex-Web-Tab"
	// HeaderClient is ClientName on every request of the web version.
	HeaderClient = "X-Claudex-Client"
	// EventSeqHeader answers the snapshot call with the user's last event
	// number the snapshot already holds.
	EventSeqHeader = "X-Claudex-Event-Seq"
	ClientName     = "web"
	// RefreshCookie is the HttpOnly refresh cookie, Path=PathAuth.
	RefreshCookie = "__Secure-claudex_web_rt"
	// EventsSubprotocol is what the events socket selects.
	EventsSubprotocol = "claudex.v1"
	// TicketSubprotocolPrefix precedes the one-time ticket in the offered
	// sub-protocols, so the ticket never appears in a URL or an access log.
	TicketSubprotocolPrefix = "ticket."
	// RunnerLinkSubprotocol is the runner link's sub-protocol.
	RunnerLinkSubprotocol = "claudex.runner.v1"
)

// Limits shared with the TypeScript side (webLimits).
const (
	RPCBodyBytes        = 1 << 20
	UploadChunkBytes    = 1 << 20
	LinkFrameBytes      = 16 << 20
	TurnDocBytes        = 4 << 20
	TicketTTL           = 30 * time.Second
	PreviewSignatureTTL = 5 * time.Minute
	Heartbeat           = 25 * time.Second
	EventRing           = 2000
	Coalesce            = 80 * time.Millisecond
	CallTimeout         = 120 * time.Second
	MethodNameLength    = 64
	RunnerMethods       = 1000
	// BrowserAccounts is how many accounts one browser can be signed in to
	// at once (each keeps its own account cookie).
	BrowserAccounts = 5
)

// AccountCookie names an account's own refresh cookie: RefreshCookie, "_"
// and the user id, with RefreshCookie's attributes. A browser signed in to
// several accounts holds one per account.
func AccountCookie(userID int64) string {
	return RefreshCookie + "_" + strconv.FormatInt(userID, 10)
}

// AccountOfCookie is the user id an account cookie's name carries, 0 for
// any other name.
func AccountOfCookie(name string) int64 {
	rest, ok := strings.CutPrefix(name, RefreshCookie+"_")
	if !ok || rest == "" || len(rest) > 19 {
		return 0
	}
	id, err := strconv.ParseInt(rest, 10, 64)
	if err != nil || id <= 0 || strconv.FormatInt(id, 10) != rest {
		return 0
	}
	return id
}

// Close codes of the events socket and the runner link.
const (
	CloseNormal         = 1000
	CloseGoingAway      = 1001
	CloseBadTicket      = 4001
	CloseForbidden      = 4003
	CloseSignedOut      = 4008
	CloseProtocolError  = 4400
	CloseUnavailable    = 4503
	CloseRunnerRejected = 4401
	CloseReplaced       = 4409
)

// Error codes the web layer adds.
const (
	ErrCodeDisabled          = "CLAUDEX_WEB_DISABLED"
	ErrCodeNotAllowed        = "CLAUDEX_WEB_NOT_ALLOWED"
	ErrCodeCapacity          = "CLAUDEX_WEB_CAPACITY"
	ErrCodeMethodUnavailable = "CLAUDEX_WEB_METHOD_UNAVAILABLE"
	ErrCodeBadRequest        = "CLAUDEX_WEB_BAD_REQUEST"
	ErrCodeTooLarge          = "CLAUDEX_WEB_TOO_LARGE"
	ErrCodeRunnerUnavailable = "CLAUDEX_WEB_RUNNER_UNAVAILABLE"
	ErrCodeTimeout           = "CLAUDEX_WEB_TIMEOUT"
	ErrCodeBadTicket         = "CLAUDEX_WEB_BAD_TICKET"
	ErrCodeQuotaExceeded     = "CLAUDEX_WEB_QUOTA_EXCEEDED"
	ErrCodeHandlerFailed     = "CLAUDEX_WEB_HANDLER_FAILED"
)

var (
	methodPattern = regexp.MustCompile(`^[a-z][A-Za-z0-9]{0,63}$`)
	ticketPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	tabPattern    = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)
	opPattern     = regexp.MustCompile(`^[a-z]+(?:\.[a-z][a-z-]*)+$`)
	idPattern     = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,64}$`)
	docIDPattern  = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,128}$`)
)

// ValidMethodName reports whether name can be a bridge method (rpc/<method>).
// Whether the method is served is decided by the runner's hello list.
func ValidMethodName(name string) bool { return methodPattern.MatchString(name) }

// ValidTicket reports whether s has the shape of a ticket from NewTicket.
func ValidTicket(s string) bool { return ticketPattern.MatchString(s) }

// ValidTabID reports whether s can be a tab id (8-64 of [A-Za-z0-9_-]).
func ValidTabID(s string) bool { return tabPattern.MatchString(s) }

// ValidOp reports whether s has the shape of a runner request op.
func ValidOp(s string) bool { return opPattern.MatchString(s) }

// NewTicket returns 32 random bytes as unpadded base64url (43 characters).
func NewTicket() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b[:]), nil
}

// TicketFromSubprotocols returns the ticket offered in Sec-WebSocket-Protocol
// header values (comma-separated, possibly repeated): ok only when
// EventsSubprotocol and exactly one well-formed ticket are offered. The
// server then selects EventsSubprotocol, never the ticket.
func TicketFromSubprotocols(values []string) (string, bool) {
	hasProtocol := false
	var tickets []string
	for _, line := range values {
		for _, item := range strings.Split(line, ",") {
			item = strings.TrimSpace(item)
			switch {
			case item == EventsSubprotocol:
				hasProtocol = true
			case strings.HasPrefix(item, TicketSubprotocolPrefix):
				tickets = append(tickets, strings.TrimPrefix(item, TicketSubprotocolPrefix))
			}
		}
	}
	if !hasProtocol || len(tickets) != 1 || !ValidTicket(tickets[0]) {
		return "", false
	}
	return tickets[0], true
}

// OpGitHubClone is the runner request that asks for a short-lived clone
// credential for a repository of the user the runner serves (W-GITHUB).
const OpGitHubClone = "github.clone"

// OpGitHubPush leases a push credential for a cloud Code session's
// repository; OpGitHubAPI opens a pull request or an issue, comments, or
// reads one, with the user's token (ghconn/actions.go).
const (
	OpGitHubPush = "github.push"
	OpGitHubAPI  = "github.api"
	// OpGitHubHook makes or removes a scheduled task's repository webhook
	// (ghconn/routine_hooks.go).
	OpGitHubHook = "github.hook"
)

// OpRoutineToken is the runner request that asks for a short-lived access
// token of a user the runner serves, so a scheduled task can run while the
// user has no page open (the runner keeps the schedule and its timer; Go only
// vouches for the user, as it does for key.get).
const OpRoutineToken = "routine.token"

// OpRoutineAPIToken is the runner request that makes or deletes the token of
// a scheduled task's API trigger (webhost/routine_triggers.go); the runner
// checked the trigger is one of the user's saved tasks.
const OpRoutineAPIToken = "routine.api-token"

// RunnerOps are the runner request ops of v1 (W-STORE and W-KEY own their
// semantics). Unknown ops are answered with ErrCodeMethodUnavailable.
var RunnerOps = []string{
	"store.settings.get",
	"store.settings.put",
	"store.projects.list",
	"store.projects.put",
	"store.projects.delete",
	"store.conversations.list",
	"store.conversations.get",
	"store.conversations.put",
	"store.conversations.delete",
	"store.turns.list",
	"store.turns.put",
	"store.turns.delete",
	"store.artifacts.list",
	"store.artifacts.put",
	"store.artifacts.delete",
	"store.files.get",
	"store.files.put",
	"store.files.delete",
	"store.search",
	"key.get",
	"location.get",
	OpGitHubClone,
	OpGitHubPush,
	OpGitHubAPI,
	OpGitHubHook,
	OpRoutineToken,
	OpRoutineAPIToken,
	"device.list",
	"device.call",
}
