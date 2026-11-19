// Package productfeedback sends only explicit product feedback to a fixed inbox.
// This is separate from opt-in diagnostics and message ratings.
package productfeedback

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"html"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/service"
)

const Recipient = "2243140006@qq.com"
const perHour = 5

var (
	errUnavailable = errors.New("product feedback unavailable")
	errConflict    = errors.New("request id has different content")
	errUnknown     = errors.New("delivery outcome unknown; do not resend")
	errLimited     = errors.New("feedback rate limit exceeded")
)

type request struct {
	Text       string `json:"text"`
	AppVersion string `json:"app_version"`
	RequestID  string `json:"request_id"`
}
type receipt struct{ ID, Hash, Status string }
type receiptStore interface {
	// Lookup is owner-scoped and read-only; replay must survive SMTP configuration loss.
	Lookup(context.Context, int64, string) (receipt, bool, error)
	// Claim must durably serialize same-user claims, rate-limit new requests,
	// and return existing receipts without granting permission to resend.
	Claim(context.Context, int64, string, string, string, time.Time) (receipt, bool, error)
	Finish(context.Context, int64, string, string) error
	Release(ctx context.Context, userID int64, requestID, feedbackID string) error
}
type sendMail func(context.Context, string, string, string) error
type processor struct {
	store receiptStore
	// Prepare checks configuration before claiming and returns the sender using
	// that configuration. It must not send mail itself.
	prepare func(context.Context) (sendMail, error)
	newID   func() string
	now     func() time.Time
}

func (p *processor) submit(ctx context.Context, userID int64, in request) (receipt, error) {
	if p.store == nil {
		return receipt{}, errUnavailable
	}
	// Request ID is not part of semantic content; the DB key scopes it to user.
	data, _ := json.Marshal(struct{ Text, AppVersion string }{in.Text, in.AppVersion})
	sum := sha256.Sum256(data)
	hash := hex.EncodeToString(sum[:])
	r, found, err := p.store.Lookup(ctx, userID, in.RequestID)
	if err != nil {
		return receipt{}, errUnavailable
	}
	if found {
		return replay(r, hash)
	}
	if p.prepare == nil {
		return receipt{}, errUnavailable
	}
	send, err := p.prepare(ctx)
	if err != nil || send == nil {
		return receipt{}, errUnavailable
	}
	r, fresh, err := p.store.Claim(ctx, userID, in.RequestID, hash, p.newID(), p.now())
	if err != nil {
		return r, err
	}
	if r.Hash != hash {
		return r, errConflict
	}
	if !fresh {
		return replay(r, hash)
	}
	// No account identity, logs, paths, conversation or device metadata.
	// Keep quoted content IDs from triggering the mailer's inline logo.
	text := strings.ReplaceAll(html.EscapeString(in.Text), "cid:", "cid&#58;")
	body := "<p>Claudex product feedback</p><p>App version: " + html.EscapeString(in.AppVersion) + "</p><pre>" + text + "</pre>"
	err = send(ctx, Recipient, "Claudex product feedback", body)
	finishCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var notAccepted *service.SMTPNotAcceptedError
	if errors.As(err, &notAccepted) {
		if releaseErr := p.store.Release(finishCtx, userID, in.RequestID, r.ID); releaseErr != nil {
			return r, errUnknown
		}
		return receipt{}, errUnavailable
	}
	// SMTP errors can occur after remote acceptance. Never retry automatically.
	// A process crash leaves 'sending', which also blocks all re-delivery.
	status := "sent"
	if err != nil {
		status = "unknown"
	}
	if saveErr := p.store.Finish(finishCtx, userID, in.RequestID, status); saveErr != nil {
		return r, errUnknown
	}
	r.Status = status
	if status != "sent" {
		return r, errUnknown
	}
	return r, nil
}

// Unknown/sending (including unrecognized states) never grants re-delivery.
func replay(r receipt, hash string) (receipt, error) {
	if r.Hash != hash {
		return r, errConflict
	}
	if r.Status == "sent" {
		return r, nil
	}
	return r, errUnknown
}

func normalize(in *request) {
	in.RequestID = strings.ToLower(in.RequestID)
}
