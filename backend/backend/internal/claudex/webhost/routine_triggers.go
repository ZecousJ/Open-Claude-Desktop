package webhost

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"

	"github.com/gin-gonic/gin"
)

// The API triggers of scheduled tasks (shared/routine-triggers.ts): a task
// lives on its user's runner; its API trigger has an id the runner made and
// a token this component makes and keeps only as a SHA-256 (with its last
// four characters, which the task's page shows). Anyone holding the token
// can start the task with
//
//	POST /api/v1/claudex/routines/<trigger id>/fire
//	Authorization: Bearer <token>
//	{"text": "optional words that follow the task's instructions"}
//
// The runner asks for a token (routine.api-token, generate or delete) after
// checking that the trigger is one of the user's saved tasks; the fire
// address relays to the runner's internal fireRoutineTrigger call on a
// short-lived token of the user, as a scheduled run does (routine.token).

// RouteRoutineFire is the fire address (relative to /api/v1/claudex).
const RouteRoutineFire = "/routines/:id/fire"

// fireRoutineMethod is the runner-internal call (runner/src/dispatcher-sessions.ts).
const fireRoutineMethod = "fireRoutineTrigger"

var routineTriggerID = regexp.MustCompile(`^trg_[0-9A-Za-z]{24}$`)

const (
	// routineFireBody caps the fire request's body.
	routineFireBody = 64 << 10
	// routineFireText caps the text that follows the instructions.
	routineFireText = 65536
	// routineFireLimit runs per trigger in routineFireWindow.
	routineFireLimit  = 30
	routineFireWindow = time.Hour
	// routineFireTimeout is how long the runner has to start the run.
	routineFireTimeout = 60 * time.Second
)

var errRoutineTriggerNotFound = errors.New("webhost: no such routine trigger")

// routineTrigger is a stored API trigger.
type routineTrigger struct {
	UserID    int64
	TokenHash string
	TokenHint string
}

// RoutineTriggerStore keeps the API triggers (claudex_routine_triggers).
type RoutineTriggerStore interface {
	// PutToken stores a new token of the trigger for the user; a trigger
	// another user holds is refused (errRoutineTriggerTaken).
	PutToken(ctx context.Context, triggerID string, userID int64, hash, hint string) error
	// DeleteToken removes the user's trigger (nothing when it is not theirs).
	DeleteToken(ctx context.Context, triggerID string, userID int64) error
	Get(ctx context.Context, triggerID string) (routineTrigger, error)
	Fired(ctx context.Context, triggerID string, at time.Time) error
}

var errRoutineTriggerTaken = infraerrors.Forbidden("CLAUDEX_ROUTINE_TRIGGER_TAKEN", "This trigger belongs to another account.")

type sqlRoutineTriggers struct{ db *sql.DB }

func (s sqlRoutineTriggers) PutToken(ctx context.Context, triggerID string, userID int64, hash, hint string) error {
	res, err := s.db.ExecContext(ctx, `
INSERT INTO claudex_routine_triggers (trigger_id, user_id, token_hash, token_hint)
VALUES ($1, $2, $3, $4)
ON CONFLICT (trigger_id) DO UPDATE
SET token_hash = EXCLUDED.token_hash, token_hint = EXCLUDED.token_hint, updated_at = NOW()
WHERE claudex_routine_triggers.user_id = EXCLUDED.user_id`, triggerID, userID, hash, hint)
	if err != nil {
		return err
	}
	if n, err := res.RowsAffected(); err == nil && n == 0 {
		return errRoutineTriggerTaken
	}
	return nil
}

func (s sqlRoutineTriggers) DeleteToken(ctx context.Context, triggerID string, userID int64) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM claudex_routine_triggers WHERE trigger_id = $1 AND user_id = $2`, triggerID, userID)
	return err
}

func (s sqlRoutineTriggers) Get(ctx context.Context, triggerID string) (routineTrigger, error) {
	var t routineTrigger
	err := s.db.QueryRowContext(ctx, `
SELECT user_id, token_hash, token_hint FROM claudex_routine_triggers WHERE trigger_id = $1`, triggerID).
		Scan(&t.UserID, &t.TokenHash, &t.TokenHint)
	if errors.Is(err, sql.ErrNoRows) {
		return t, errRoutineTriggerNotFound
	}
	return t, err
}

func (s sqlRoutineTriggers) Fired(ctx context.Context, triggerID string, at time.Time) error {
	_, err := s.db.ExecContext(ctx, `UPDATE claudex_routine_triggers SET last_fired_at = $2 WHERE trigger_id = $1`, triggerID, at)
	return err
}

// newRoutineToken is "cxr_" and 43 characters of base64url (32 random bytes).
func newRoutineToken() (token, hash, hint string, err error) {
	b := make([]byte, 32)
	if _, err = rand.Read(b); err != nil {
		return "", "", "", err
	}
	token = "cxr_" + base64.RawURLEncoding.EncodeToString(b)
	return token, routineTokenHash(token), token[len(token)-4:], nil
}

func routineTokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// routineAPIToken answers routine.api-token for a user the runner serves:
// {triggerId, action: "generate"} → {token, hint}; "delete" → {}.
func (c *Component) routineAPIToken(ctx context.Context, userID int64, body json.RawMessage) (any, error) {
	var req struct {
		TriggerID string `json:"triggerId"`
		Action    string `json:"action"`
	}
	if err := json.Unmarshal(body, &req); err != nil || !routineTriggerID.MatchString(req.TriggerID) {
		return nil, errBadRPC
	}
	store := c.backends().Triggers
	if store == nil {
		return nil, errNoService
	}
	switch req.Action {
	case "generate":
		token, hash, hint, err := newRoutineToken()
		if err != nil {
			return nil, err
		}
		if err := store.PutToken(ctx, req.TriggerID, userID, hash, hint); err != nil {
			return nil, err
		}
		slog.Info("claudex webhost: scheduled-task API token made", "user_id", userID)
		return map[string]string{"token": token, "hint": hint}, nil
	case "delete":
		if err := store.DeleteToken(ctx, req.TriggerID, userID); err != nil {
			return nil, err
		}
		return map[string]string{}, nil
	}
	return nil, errBadRPC
}

// fireLimiter counts each trigger's runs in the last window.
type fireLimiter struct {
	mu   sync.Mutex
	runs map[string][]time.Time
}

func (l *fireLimiter) allow(id string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.runs == nil {
		l.runs = map[string][]time.Time{}
	}
	kept := l.runs[id][:0]
	for _, at := range l.runs[id] {
		if now.Sub(at) < routineFireWindow {
			kept = append(kept, at)
		}
	}
	if len(kept) >= routineFireLimit {
		l.runs[id] = kept
		return false
	}
	l.runs[id] = append(kept, now)
	return true
}

// fireError answers the fire address in the shape of the API's errors.
func fireError(g *gin.Context, status int, kind, message string) {
	g.Header("Cache-Control", "no-store")
	g.AbortWithStatusJSON(status, gin.H{"type": "error", "error": gin.H{"type": kind, "message": message}})
}

// POST /routines/:id/fire
func (c *Component) fireRoutine(g *gin.Context) {
	id := g.Param("id")
	raw := bearerToken(g.Request)
	if !routineTriggerID.MatchString(id) || raw == "" {
		fireError(g, http.StatusUnauthorized, "authentication_error", "Invalid or missing token.")
		return
	}
	ctx := g.Request.Context()
	b := c.backends()
	if b.Triggers == nil {
		fireError(g, http.StatusServiceUnavailable, "api_error", "This service can't start scheduled tasks right now.")
		return
	}
	t, err := b.Triggers.Get(ctx, id)
	if err != nil && !errors.Is(err, errRoutineTriggerNotFound) {
		slog.Warn("claudex webhost: reading a routine trigger failed", "error", err)
		fireError(g, http.StatusServiceUnavailable, "api_error", "This service can't start scheduled tasks right now.")
		return
	}
	// Compared whether or not the trigger exists, so the answer's timing
	// says nothing about which ids do.
	want := t.TokenHash
	if want == "" {
		want = strings.Repeat("0", 64)
	}
	if subtle.ConstantTimeCompare([]byte(routineTokenHash(raw)), []byte(want)) != 1 || err != nil {
		fireError(g, http.StatusUnauthorized, "authentication_error", "Invalid or missing token.")
		return
	}
	if !c.fires.allow(id, c.now()) {
		fireError(g, http.StatusTooManyRequests, "rate_limit_error", "This task was started too often. Try again later.")
		return
	}
	var req struct {
		Text string `json:"text"`
	}
	body, err := io.ReadAll(http.MaxBytesReader(g.Writer, g.Request.Body, routineFireBody))
	if err != nil {
		fireError(g, http.StatusRequestEntityTooLarge, "invalid_request_error", "The request is too large.")
		return
	}
	if len(strings.TrimSpace(string(body))) > 0 {
		if err := json.Unmarshal(body, &req); err != nil {
			fireError(g, http.StatusBadRequest, "invalid_request_error", "The body must be JSON, such as {\"text\": \"…\"}.")
			return
		}
	}
	if len(req.Text) > routineFireText {
		fireError(g, http.StatusBadRequest, "invalid_request_error", "The text is too long.")
		return
	}
	started, err := c.startRoutine(ctx, t.UserID, id, "api", req.Text, nil)
	if err != nil {
		var refused routineRefused
		switch {
		case errors.As(err, &refused):
			fireError(g, http.StatusConflict, "invalid_request_error", refused.message)
		case errors.Is(err, errRoutineAccount):
			fireError(g, http.StatusForbidden, "permission_error", "This account can't start scheduled tasks.")
		default:
			fireError(g, http.StatusServiceUnavailable, "api_error", "Claudex on the web is not available right now. Try again later.")
		}
		return
	}
	if err := b.Triggers.Fired(context.WithoutCancel(ctx), id, c.now()); err != nil {
		slog.Warn("claudex webhost: recording a routine fire failed", "error", err)
	}
	slog.Info("claudex webhost: scheduled task started by its API trigger", "user_id", t.UserID)
	g.Header("Cache-Control", "no-store")
	g.JSON(http.StatusOK, gin.H{
		"type":              "routine_fire",
		"scheduled_task_id": started.ScheduledTaskID,
		"conversation_id":   started.ConversationID,
	})
}

// routineStarted is the runner's answer to fireRoutineTrigger.
type routineStarted struct {
	ScheduledTaskID string `json:"scheduledTaskId"`
	ConversationID  string `json:"conversationId"`
	// A GitHub event the trigger's events or filters leave out.
	Skipped bool `json:"skipped"`
}

// routineRefused is the runner's refusal (a paused task, a trigger that is
// gone), with its words.
type routineRefused struct{ message string }

func (r routineRefused) Error() string { return "webhost: the runner refused: " + r.message }

var errRoutineAccount = errors.New("webhost: the account can't start scheduled tasks")

// startRoutine starts the task a trigger names on the user's runner, on a
// short-lived token of the user (routine.token).
func (c *Component) startRoutine(ctx context.Context, userID int64, triggerID, kind, text string, event any) (routineStarted, error) {
	var out routineStarted
	grant, err := c.routineToken(ctx, userID)
	token, _ := grant.(map[string]string)
	if err != nil || token["accessToken"] == "" {
		return out, errRoutineAccount
	}
	rc, err := c.reg.pick(ctx, userID)
	if err != nil {
		return out, err
	}
	args := []json.RawMessage{mustJSON(triggerID), mustJSON(kind)}
	if text != "" || event != nil {
		args = append(args, mustJSON(text))
	}
	if event != nil {
		args = append(args, mustJSON(event))
	}
	callCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), routineFireTimeout)
	defer cancel()
	res, err := rc.call(callCtx, webproto.LinkUser{ID: userID, AccessToken: token["accessToken"]}, fireRoutineMethod, args, routineFireTimeout)
	if err != nil || res.OK == nil {
		return out, errRunnerUnavailable
	}
	if !*res.OK {
		message := "The task could not start."
		if res.Error != nil && res.Error.Message != "" {
			message = res.Error.Message
		}
		return out, routineRefused{message: message}
	}
	_ = json.Unmarshal(res.Value, &out)
	return out, nil
}

// FireRoutineTrigger implements ghconn.RoutineFirer: a GitHub delivery whose
// signature held starts the task if its trigger matches the event.
func (c *Component) FireRoutineTrigger(ctx context.Context, userID int64, triggerID, kind, text string, event any) (any, error) {
	return c.startRoutine(ctx, userID, triggerID, kind, text, event)
}

func mustJSON(v any) json.RawMessage {
	raw, _ := json.Marshal(v)
	return raw
}
