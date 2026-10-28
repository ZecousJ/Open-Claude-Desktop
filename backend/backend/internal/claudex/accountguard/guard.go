// Package accountguard takes failing upstream accounts out of scheduling and
// brings them back once they answer again (owner, 2026-10-10).
//
// Every minute it looks at each active account's attempts of the last ten
// minutes: failures it is to blame for (ops_error_logs, leaving out what the
// client or the request caused) and requests it served (usage_logs), a
// crawling one counting as a failure (see slowShortMs). Three
// failures in a row, or more than half of at least six attempts, pause it
// with temp_unschedulable_until, never the last account a group could use.
//
// A paused account, and one the service itself marked as broken (status
// error, e.g. a 401), is then probed with its own key: a one-word request
// straight to its upstream, every minute at first and twice as rarely after
// each failure (hourly at most; every ten minutes for a broken one). Two
// answers in a row schedule it again. The guard's state lives in
// accounts.extra.claudex_guard; an account an administrator paused
// (schedulable off, status active) is never touched.
//
// CLAUDEX_ACCOUNT_GUARD=off turns it off.
package accountguard

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
)

const (
	firstRun  = 90 * time.Second
	tickEvery = time.Minute
	reasonTag = "claudex_guard"
)

// Component is the account guard.
type Component struct {
	env    *core.Env
	client *http.Client
}

// New builds the component. It must not call its dependencies here.
func New(env *core.Env) *Component {
	return &Component{env: env, client: &http.Client{Timeout: probeTimeout + 10*time.Second}}
}

// Name implements core.Feature.
func (c *Component) Name() string { return core.NameAccountGuard }

// Start implements core.Starter.
func (c *Component) Start(ctx context.Context) {
	if c.env == nil || c.env.DB == nil || strings.EqualFold(strings.TrimSpace(os.Getenv("CLAUDEX_ACCOUNT_GUARD")), "off") {
		return
	}
	go c.loop(ctx)
}

func (c *Component) loop(ctx context.Context) {
	wait := firstRun
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		wait = tickEvery
		c.tick(ctx)
	}
}

// state is accounts.extra.claudex_guard.
type state struct {
	Kind      string    `json:"kind"` // "degraded" (paused here) | "error" (marked broken by the service)
	Since     time.Time `json:"since"`
	Reason    string    `json:"reason"`
	GapSec    int64     `json:"gap_sec"`
	NextProbe time.Time `json:"next_probe"`
	OK        int       `json:"ok"`
	LastProbe string    `json:"last_probe,omitempty"`
}

func (c *Component) tick(ctx context.Context) {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("claudex guard: tick panicked", "panic", r)
		}
	}()
	db := c.env.DB
	// One instance at a time (blue and green overlap during a deploy).
	conn, err := db.Conn(ctx)
	if err != nil {
		return
	}
	defer func() { _ = conn.Close() }()
	var locked bool
	if err := conn.QueryRowContext(ctx, `SELECT pg_try_advisory_lock(hashtext('claudex_account_guard'))`).Scan(&locked); err != nil || !locked {
		return
	}
	defer func() {
		_, _ = conn.ExecContext(context.Background(), `SELECT pg_advisory_unlock(hashtext('claudex_account_guard'))`)
	}()
	now := time.Now()
	c.adoptBroken(ctx, db, now)
	c.evaluate(ctx, db, now)
	c.probeAll(ctx, db, now)
}

// adoptBroken starts probing accounts the service marked as broken.
func (c *Component) adoptBroken(ctx context.Context, db *sql.DB, now time.Time) {
	rows, err := db.QueryContext(ctx, `
SELECT id, COALESCE(error_message, '') FROM accounts
WHERE deleted_at IS NULL AND status = 'error' AND NOT (COALESCE(extra, '{}'::jsonb) ? 'claudex_guard')`)
	if err != nil {
		return
	}
	type broken struct {
		id  int64
		msg string
	}
	var list []broken
	for rows.Next() {
		var b broken
		if rows.Scan(&b.id, &b.msg) == nil {
			list = append(list, b)
		}
	}
	_ = rows.Close()
	for _, b := range list {
		st := state{Kind: "error", Since: now, Reason: clip(b.msg, 200), GapSec: int64(errorFirstProbe / time.Second), NextProbe: now}
		if c.saveState(ctx, db, b.id, st) == nil {
			slog.Info("claudex guard: probing an account the service marked as broken", "account_id", b.id, "error", st.Reason)
		}
	}
}

// evaluate pauses active accounts whose recent attempts keep failing.
func (c *Component) evaluate(ctx context.Context, db *sql.DB, now time.Time) {
	rows, err := db.QueryContext(ctx, `
SELECT e.account_id, e.created_at, TRUE FROM ops_error_logs e
WHERE e.created_at > NOW() - INTERVAL '10 minutes' AND e.account_id IS NOT NULL
  AND COALESCE(e.upstream_status_code, e.status_code, 0) NOT IN (400, 401, 403, 404, 413, 422, 499)
  AND COALESCE(e.error_phase, '') NOT IN ('request', 'routing', 'auth')
  AND COALESCE(e.upstream_error_message, e.error_message, '') !~* '(context canceled|context deadline exceeded|insufficient account balance|failed to read request body|client disconnected)'
UNION ALL
SELECT u.account_id, u.created_at,
  -- A served request still counts against the account when it crawled
  -- (see decide.go): a stream's first token after slowStreamMs at any
  -- effort, a short reply after slowShortMs in all, or a longer stream
  -- slower than slowShortMs plus slowPerTokenMs a token.
  COALESCE((u.stream AND u.first_token_ms > $1)
    OR (u.output_tokens < $2 AND u.duration_ms > $3)
    OR (u.stream AND u.output_tokens >= $2 AND u.duration_ms > $3 + u.output_tokens * $4), FALSE)
FROM usage_logs u
WHERE u.created_at > NOW() - INTERVAL '10 minutes' AND u.account_id IS NOT NULL`, slowStreamMs, slowShortReply, slowShortMs, slowPerTokenMs)
	if err != nil {
		slog.Warn("claudex guard: reading attempts failed", "error", err)
		return
	}
	events := map[int64][]event{}
	for rows.Next() {
		var id int64
		var e event
		if rows.Scan(&id, &e.at, &e.failed) == nil {
			events[id] = append(events[id], e)
		}
	}
	_ = rows.Close()
	for id, list := range events {
		v := decide(list, now)
		if !v.trip {
			continue
		}
		c.pause(ctx, db, id, v, now)
	}
}

// pause takes an account out unless a group of it would be left without one.
func (c *Component) pause(ctx context.Context, db *sql.DB, id int64, v verdict, now time.Time) {
	var name string
	var eligible bool
	err := db.QueryRowContext(ctx, `
SELECT name, status = 'active' AND schedulable AND NOT (COALESCE(extra, '{}'::jsonb) ? 'claudex_guard')
  AND (temp_unschedulable_until IS NULL OR temp_unschedulable_until < NOW())
FROM accounts WHERE id = $1 AND deleted_at IS NULL`, id).Scan(&name, &eligible)
	if err != nil || !eligible {
		return
	}
	var lonely int
	if err := db.QueryRowContext(ctx, `
SELECT COUNT(*) FROM account_groups g
WHERE g.account_id = $1 AND NOT EXISTS (
  SELECT 1 FROM account_groups o JOIN accounts a ON a.id = o.account_id
  WHERE o.group_id = g.group_id AND a.id <> $1 AND a.deleted_at IS NULL
    AND a.status = 'active' AND a.schedulable
    AND (a.temp_unschedulable_until IS NULL OR a.temp_unschedulable_until < NOW())
    AND (a.rate_limit_reset_at IS NULL OR a.rate_limit_reset_at < NOW())
    AND (a.overload_until IS NULL OR a.overload_until < NOW()))`, id).Scan(&lonely); err != nil {
		return
	}
	reason := fmt.Sprintf("%d of the last %d attempts failed, %d in a row", v.fails, v.total, v.consecutive)
	if lonely > 0 {
		slog.Warn("claudex guard: account keeps failing but is the last one of a group; left on", "account_id", id, "account", name, "detail", reason)
		return
	}
	st := state{Kind: "degraded", Since: now, Reason: reason, GapSec: int64(degradedFirstProbe / time.Second), NextProbe: now.Add(degradedFirstProbe)}
	raw, _ := json.Marshal(st)
	res, err := db.ExecContext(ctx, `
UPDATE accounts SET temp_unschedulable_until = $2, temp_unschedulable_reason = $3,
  extra = jsonb_set(COALESCE(extra, '{}'::jsonb), '{claudex_guard}', $4::jsonb), updated_at = NOW()
WHERE id = $1 AND status = 'active' AND schedulable AND NOT (COALESCE(extra, '{}'::jsonb) ? 'claudex_guard')`,
		id, now.Add(pauseHold), reasonTag+": "+reason, string(raw))
	if err != nil {
		slog.Warn("claudex guard: pausing failed", "account_id", id, "error", err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return
	}
	c.notifyScheduler(ctx, db, id)
	slog.Warn("claudex guard: account paused", "account_id", id, "account", name, "detail", reason)
}

// probeAll probes the accounts the guard holds whose turn has come.
func (c *Component) probeAll(ctx context.Context, db *sql.DB, now time.Time) {
	rows, err := db.QueryContext(ctx, `
SELECT id, name, platform, status, schedulable, COALESCE(temp_unschedulable_reason, ''),
  COALESCE(credentials->>'base_url', ''), COALESCE(credentials->>'api_key', ''),
  COALESCE(credentials->'model_mapping', '{}'::jsonb), extra->'claudex_guard'
FROM accounts WHERE deleted_at IS NULL AND COALESCE(extra, '{}'::jsonb) ? 'claudex_guard'`)
	if err != nil {
		return
	}
	type held struct {
		t           target
		name        string
		status      string
		schedulable bool
		tempReason  string
		st          state
	}
	var list []held
	for rows.Next() {
		var h held
		var mapping, rawState []byte
		if rows.Scan(&h.t.id, &h.name, &h.t.platform, &h.status, &h.schedulable, &h.tempReason, &h.t.baseURL, &h.t.apiKey, &mapping, &rawState) != nil {
			continue
		}
		var m map[string]any
		_ = json.Unmarshal(mapping, &m)
		for k := range m {
			h.t.models = append(h.t.models, k)
		}
		if json.Unmarshal(rawState, &h.st) != nil {
			continue
		}
		list = append(list, h)
	}
	_ = rows.Close()
	for _, h := range list {
		// Someone fixed or paused it by hand meanwhile: let go.
		stillHeld := (h.st.Kind == "error" && h.status == "error") ||
			(h.st.Kind == "degraded" && h.status == "active" && strings.HasPrefix(h.tempReason, reasonTag))
		if !stillHeld {
			_, _ = db.ExecContext(ctx, `UPDATE accounts SET extra = extra - 'claudex_guard' WHERE id = $1`, h.t.id)
			continue
		}
		if now.Before(h.st.NextProbe) {
			continue
		}
		err := probe(ctx, c.client, h.t)
		if err == errNoModel {
			// Nothing to ask with: an hour's pause, then back by itself.
			if h.st.Kind == "degraded" && now.Sub(h.st.Since) >= maxProbeGap {
				c.recover(ctx, db, h.t.id, h.name, h.st, "no model to probe; released after an hour")
			}
			continue
		}
		if err == nil {
			h.st.OK++
			h.st.LastProbe = "ok"
			if h.st.OK >= recoverAfterOK {
				c.recover(ctx, db, h.t.id, h.name, h.st, "probes answered")
				continue
			}
			h.st.NextProbe = now.Add(confirmGap)
		} else {
			h.st.OK = 0
			h.st.LastProbe = clip(err.Error(), 200)
			gap := nextGap(time.Duration(h.st.GapSec) * time.Second)
			if h.st.Kind == "error" && gap < errorFirstProbe {
				gap = errorFirstProbe
			}
			h.st.GapSec = int64(gap / time.Second)
			h.st.NextProbe = now.Add(gap)
			if h.st.Kind == "degraded" {
				_, _ = db.ExecContext(ctx, `UPDATE accounts SET temp_unschedulable_until = $2 WHERE id = $1 AND temp_unschedulable_reason LIKE 'claudex_guard%'`, h.t.id, now.Add(pauseHold))
			}
			slog.Info("claudex guard: probe failed", "account_id", h.t.id, "account", h.name, "next_in", gap.String(), "error", h.st.LastProbe)
		}
		_ = c.saveState(ctx, db, h.t.id, h.st)
	}
}

// recover schedules the account again and drops the guard's state.
func (c *Component) recover(ctx context.Context, db *sql.DB, id int64, name string, st state, why string) {
	var err error
	if st.Kind == "error" {
		_, err = db.ExecContext(ctx, `
UPDATE accounts SET status = 'active', error_message = '', schedulable = TRUE,
  extra = extra - 'claudex_guard', updated_at = NOW()
WHERE id = $1 AND status = 'error'`, id)
	} else {
		_, err = db.ExecContext(ctx, `
UPDATE accounts SET temp_unschedulable_until = NULL, temp_unschedulable_reason = NULL,
  extra = extra - 'claudex_guard', updated_at = NOW()
WHERE id = $1 AND temp_unschedulable_reason LIKE 'claudex_guard%'`, id)
	}
	if err != nil {
		slog.Warn("claudex guard: recovering failed", "account_id", id, "error", err)
		return
	}
	c.notifyScheduler(ctx, db, id)
	slog.Warn("claudex guard: account back in scheduling", "account_id", id, "account", name, "kind", st.Kind, "paused_for", time.Since(st.Since).Round(time.Second).String(), "why", why)
}

func (c *Component) saveState(ctx context.Context, db *sql.DB, id int64, st state) error {
	raw, _ := json.Marshal(st)
	_, err := db.ExecContext(ctx, `UPDATE accounts SET extra = jsonb_set(COALESCE(extra, '{}'::jsonb), '{claudex_guard}', $2::jsonb) WHERE id = $1`, id, string(raw))
	return err
}

// notifyScheduler makes the scheduler reload the account.
func (c *Component) notifyScheduler(ctx context.Context, db *sql.DB, id int64) {
	if _, err := db.ExecContext(ctx, `INSERT INTO scheduler_outbox (event_type, account_id) VALUES ('account_changed', $1)`, id); err != nil {
		slog.Warn("claudex guard: scheduler notice failed", "account_id", id, "error", err)
	}
}
