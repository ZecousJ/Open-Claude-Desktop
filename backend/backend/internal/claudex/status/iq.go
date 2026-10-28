package status

import (
	"bufio"
	"bytes"
	"context"
	"database/sql"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/devices"
)

// The IQ check (owner, 2026-10-06): every hour the service asks
// gpt-6-astra at medium reasoning effort ("6-Astra Medium"; first
// gpt-6.1-sol), through its own gateway, for an HTML page with an SVG
// animation of a pelican riding a bicycle, with the owner's prompt and the
// page size the cards show it at (800×600, no scrolling; no other
// instructions). The page it writes is kept and the status page
// shows the latest ones as cards with the time of the check.
//
// One run an hour, on the hour, across instances (owner, 2026-10-06: after
// the first, checks run on the hour): a run claims the hour it starts in
// with a "running" row, under an advisory lock, unless a run already started
// in that hour. A start (deploy, restart) checks at once only when its hour
// has none yet; a second instance (blue-green) finds the hour taken. The request goes to this instance's own
// gateway port with a web key of the first active administrator, so it is
// metered like any of that account's requests.
//
// For a local test stack (no upstream accounts of its own) three variables
// point it elsewhere: CLAUDEX_STATUS_IQ_GATEWAY (a gateway origin) with
// CLAUDEX_STATUS_IQ_KEY (an API key there), and CLAUDEX_STATUS_IQ_EVERY (a
// shorter interval, e.g. "10m"). Production sets none of them.

const (
	iqModel  = "gpt-6-astra"
	iqEffort = "medium"
	// The owner's prompt, then the page's size (owner, 2026-10-06: a card
	// shows the whole page, without scrolling).
	iqPrompt  = "创建一个html，内容为一个鹈鹕骑单车的SVG动画。页面按 4:3 比例（800×600 像素）设计，全部内容完整显示在这个区域内，不出现滚动条。"
	iqEvery   = time.Hour
	iqTimeout = 15 * time.Minute
	// iqShown: the runs the status page carries per group; iqKeep: the
	// rows kept per group.
	iqShown       = 24
	iqKeep        = 200
	iqHTMLBytes   = 512 << 10
	iqOutputBytes = 2 << 20
	// iqStale: a run still "running" after this was cut off (a restart).
	iqStale = 30 * time.Minute
	// A run that brings back no page (an upstream error, a cut stream, a
	// reply without HTML) asks again, up to iqAttempts times within
	// iqBudget, which stays under iqStale (owner, 2026-10-09: checks without
	// a picture). iqPause is the wait before the first retry and doubles
	// twice per retry after (owner, 2026-10-10: three attempts five seconds
	// apart all met the same upstream outage within 18 s).
	iqAttempts = 3
	iqBudget   = 28 * time.Minute
	iqPause    = 30 * time.Second
)

// iqGroup is a group the check runs in: the status page switches between
// them (owner, 2026-10-14: codex, and "Astra 专用" beside it). Name is the
// Sub2API group's name; the request goes out with the administrator's key
// of that group.
type iqGroup struct {
	Key  string
	Name string
}

var iqGroups = []iqGroup{
	{Key: "codex", Name: "codex"},
	{Key: "astra", Name: "Astra 专用"},
}

// IQGroupRuns is one group's latest runs as the status page shows them.
type IQGroupRuns struct {
	Key  string  `json:"key"`
	Name string  `json:"name"`
	Runs []IQRun `json:"runs"`
}

// IQ run statuses.
const (
	IQRunning = "running"
	IQOK      = "ok"
	IQFailed  = "failed"
)

// IQExample is a fixed example the status page shows above the checks
// (owner, 2026-10-06): a normal page and a dumbed-down one.
type IQExample struct {
	Kind  string `json:"kind"` // "normal" | "degraded"
	Model string `json:"model"`
	HTML  string `json:"html"`
}

//go:embed examples/normal.html examples/degraded.html
var iqExampleFiles embed.FS

// IQExamples: gpt-6-astra's first page (normal) and gpt-6.1-sol's (degraded).
func IQExamples() []IQExample {
	read := func(name string) string {
		b, _ := iqExampleFiles.ReadFile("examples/" + name)
		return string(b)
	}
	return []IQExample{
		{Kind: "normal", Model: "gpt-6-astra", HTML: read("normal.html")},
		{Kind: "degraded", Model: "gpt-6.1-sol", HTML: read("degraded.html")},
	}
}

// IQRun is one check as the status page shows it.
type IQRun struct {
	ID         int64      `json:"id"`
	Model      string     `json:"model"`
	Status     string     `json:"status"`
	StartedAt  time.Time  `json:"started_at"`
	FinishedAt *time.Time `json:"finished_at"`
	// HTML is the page the model wrote; empty unless Status is "ok".
	HTML string `json:"html"`
}

// iqGroupRuns reads each group's latest finished runs, newest first.
func (c *Component) iqGroupRuns(ctx context.Context) ([]IQGroupRuns, error) {
	out := make([]IQGroupRuns, 0, len(iqGroups))
	for _, g := range iqGroups {
		runs, err := c.iqRuns(ctx, g.Key)
		if err != nil {
			return nil, err
		}
		if runs == nil {
			runs = []IQRun{}
		}
		out = append(out, IQGroupRuns{Key: g.Key, Name: g.Name, Runs: runs})
	}
	return out, nil
}

// iqRuns reads a group's latest finished runs, newest first.
func (c *Component) iqRuns(ctx context.Context, group string) ([]IQRun, error) {
	db := c.db()
	if db == nil {
		return nil, nil
	}
	rows, err := db.QueryContext(ctx, `
SELECT id, model, status, started_at, finished_at, html
FROM claudex_status_iq
WHERE status <> 'running' AND group_key = $2
ORDER BY started_at DESC
LIMIT $1`, iqShown, group)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []IQRun{}
	for rows.Next() {
		var r IQRun
		var finished sql.NullTime
		if err := rows.Scan(&r.ID, &r.Model, &r.Status, &r.StartedAt, &finished, &r.HTML); err != nil {
			return nil, err
		}
		if finished.Valid {
			t := finished.Time
			r.FinishedAt = &t
		}
		if r.Status != IQOK {
			r.HTML = ""
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (c *Component) db() *sql.DB {
	if s, ok := c.store.(*sqlStore); ok {
		return s.db
	}
	return nil
}

// iqInterval is the time between checks: an hour, or CLAUDEX_STATUS_IQ_EVERY
// (at least a minute) on a test stack.
func iqInterval() time.Duration {
	if d, err := time.ParseDuration(os.Getenv("CLAUDEX_STATUS_IQ_EVERY")); err == nil && d >= time.Minute {
		return d
	}
	return iqEvery
}

// iqLoop checks a minute after a start (when that hour has no check yet),
// then on every hour.
func (c *Component) iqLoop(ctx context.Context) {
	every := iqInterval()
	wait := time.Minute
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		c.iqOnce(ctx, every)
		now := c.now()
		wait = now.Truncate(every).Add(every).Sub(now) + 5*time.Second
	}
}

func (c *Component) iqOnce(ctx context.Context, every time.Duration) {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("claudex status: iq check panicked", "panic", r)
		}
	}()
	db := c.db()
	if db == nil {
		return
	}
	// The groups check side by side, each in its own run.
	slot := c.now().UTC().Truncate(every)
	var wg sync.WaitGroup
	for _, g := range iqGroups {
		wg.Add(1)
		go func(g iqGroup) {
			defer wg.Done()
			defer func() {
				if r := recover(); r != nil {
					slog.Error("claudex status: iq check panicked", "group", g.Key, "panic", r)
				}
			}()
			c.iqGroupOnce(ctx, db, slot, g)
		}(g)
	}
	wg.Wait()
	done, dcancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer dcancel()
	// Cut-off runs, and rows past keeping.
	_, _ = db.ExecContext(done, `
UPDATE claudex_status_iq SET status = 'failed', error = 'interrupted', finished_at = NOW()
WHERE status = 'running' AND started_at < NOW() - $1 * INTERVAL '1 second'`, int(iqStale/time.Second))
	_, _ = db.ExecContext(done, `
DELETE FROM claudex_status_iq q USING (
	SELECT id, ROW_NUMBER() OVER (PARTITION BY group_key ORDER BY started_at DESC) AS n FROM claudex_status_iq
) r WHERE q.id = r.id AND r.n > $1`, iqKeep)
}

func (c *Component) iqGroupOnce(ctx context.Context, db *sql.DB, slot time.Time, g iqGroup) {
	id, err := iqClaim(ctx, db, slot, g.Key)
	if errors.Is(err, sql.ErrNoRows) {
		return
	}
	if err != nil {
		slog.Warn("claudex status: iq claim failed", "group", g.Key, "error", err)
		return
	}
	html, err := c.iqAskRetrying(ctx, g, iqPause)
	status, message := IQOK, ""
	if err != nil {
		status, message = IQFailed, clipText(err.Error(), 500)
		slog.Warn("claudex status: iq check failed", "group", g.Key, "error", err)
	}
	done, dcancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer dcancel()
	if _, err := db.ExecContext(done, `
UPDATE claudex_status_iq SET status = $2, html = $3, error = $4, finished_at = NOW() WHERE id = $1`,
		id, status, html, message); err != nil {
		slog.Warn("claudex status: iq save failed", "group", g.Key, "error", err)
	}
}

// iqAskRetrying asks until a page comes back: up to iqAttempts times, each
// within iqTimeout and all within iqBudget, waiting `pause` before the first
// retry and four times as long before the next (30 s, then 2 min); a new
// attempt starts only with two minutes left. The error of a run that never got a page names how many
// times it asked.
func (c *Component) iqAskRetrying(ctx context.Context, g iqGroup, pause time.Duration) (string, error) {
	total, cancel := context.WithTimeout(ctx, iqBudget)
	defer cancel()
	var err error
	attempt := 0
	for attempt < iqAttempts {
		attempt++
		run, cancelRun := context.WithTimeout(total, iqTimeout)
		var html string
		html, err = c.iqAsk(run, g)
		cancelRun()
		if err == nil {
			if attempt > 1 {
				slog.Info("claudex status: iq check got a page on a retry", "attempt", attempt)
			}
			return html, nil
		}
		slog.Warn("claudex status: iq attempt brought no page", "attempt", attempt, "error", err)
		if deadline, ok := total.Deadline(); total.Err() != nil || (ok && time.Until(deadline) < 2*time.Minute) {
			break
		}
		if attempt < iqAttempts {
			select {
			case <-total.Done():
			case <-time.After(pause):
			}
			pause *= 4
		}
	}
	if attempt > 1 {
		return "", fmt.Errorf("%d attempts, last: %w", attempt, err)
	}
	return "", err
}

// iqClaim adds the group's "running" row of the slot starting at `slot`,
// unless the group's run already started in it; sql.ErrNoRows when it has one.
func iqClaim(ctx context.Context, db *sql.DB, slot time.Time, group string) (int64, error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtext('claudex_status_iq'))`); err != nil {
		return 0, err
	}
	var id int64
	if err := tx.QueryRowContext(ctx, `
INSERT INTO claudex_status_iq (model, prompt, status, started_at, group_key)
SELECT $1, $2, 'running', NOW(), $4::varchar
WHERE NOT EXISTS (SELECT 1 FROM claudex_status_iq WHERE started_at >= $3 AND group_key = $4::varchar)
RETURNING id`, iqModel, iqPrompt, slot, group).Scan(&id); err != nil {
		return 0, err
	}
	return id, tx.Commit()
}

func clipText(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// iqAsk sends the prompt with the administrator's key of the group and
// returns the page it wrote.
func (c *Component) iqAsk(ctx context.Context, g iqGroup) (string, error) {
	if gateway, key := strings.TrimRight(os.Getenv("CLAUDEX_STATUS_IQ_GATEWAY"), "/"), os.Getenv("CLAUDEX_STATUS_IQ_KEY"); gateway != "" && key != "" {
		text, _, err := iqRequest(ctx, gateway+"/v1/responses", key)
		if err != nil {
			return "", err
		}
		if page := ExtractHTML(text); page != "" {
			return page, nil
		}
		return "", errors.New("the reply had no HTML")
	}
	if c.env == nil || c.env.Config == nil || c.env.DB == nil {
		return "", errors.New("no configuration")
	}
	issuer := devices.WebKeys(c.env)
	if issuer == nil {
		return "", errors.New("no web keys")
	}
	var userID int64
	if err := c.env.DB.QueryRowContext(ctx, `
SELECT id FROM users WHERE role = 'admin' AND status = 'active' AND deleted_at IS NULL ORDER BY id LIMIT 1`).Scan(&userID); err != nil {
		return "", fmt.Errorf("no administrator: %w", err)
	}
	key, err := issuer.EnsureWebKey(ctx, devices.WebKeyRequest{UserID: userID, SessionID: "status-iq", IssuedAt: c.now(), IP: "127.0.0.1"})
	if err != nil {
		return "", fmt.Errorf("key: %w", err)
	}
	var secrets []string
	for _, k := range key.Keys {
		if k.Key != nil && k.Key.Key != "" && k.Group.Name == g.Name {
			secrets = append(secrets, k.Key.Key)
		}
	}
	if len(secrets) == 0 {
		return "", fmt.Errorf("no key of group %q", g.Name)
	}
	port := c.env.Config.Server.Port
	if port <= 0 {
		port = 8080
	}
	endpoint := "http://127.0.0.1:" + strconv.Itoa(port) + "/v1/responses"
	text, _, err := iqRequest(ctx, endpoint, secrets[0])
	if err != nil {
		return "", err
	}
	page := ExtractHTML(text)
	if page == "" {
		return "", errors.New("the reply had no HTML")
	}
	return page, nil
}

func iqRequest(ctx context.Context, endpoint, secret string) (string, int, error) {
	body, _ := json.Marshal(map[string]any{
		"model":     iqModel,
		"stream":    true,
		"store":     false,
		"reasoning": map[string]any{"effort": iqEffort},
		"input": []any{map[string]any{
			"type": "message", "role": "user",
			"content": []any{map[string]any{"type": "input_text", "text": iqPrompt}},
		}},
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return "", 0, err
	}
	req.Header.Set("Authorization", "Bearer "+secret)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", 0, err
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		return "", res.StatusCode, fmt.Errorf("gateway %d: %s", res.StatusCode, clipText(strings.TrimSpace(string(raw)), 300))
	}
	text, err := ReadResponsesText(io.LimitReader(res.Body, iqOutputBytes))
	return text, res.StatusCode, err
}

// ReadResponsesText collects a Responses stream's output text (its deltas,
// or the completed response's message when no delta came).
func ReadResponsesText(r io.Reader) (string, error) {
	var deltas strings.Builder
	var completed string
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 64<<10), iqOutputBytes)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" || data == "[DONE]" {
			continue
		}
		var ev struct {
			Type     string `json:"type"`
			Delta    string `json:"delta"`
			Message  string `json:"message"`
			Response struct {
				Output []struct {
					Type    string `json:"type"`
					Content []struct {
						Type string `json:"type"`
						Text string `json:"text"`
					} `json:"content"`
				} `json:"output"`
				Error *struct {
					Message string `json:"message"`
				} `json:"error"`
			} `json:"response"`
		}
		if json.Unmarshal([]byte(data), &ev) != nil {
			continue
		}
		switch ev.Type {
		case "response.output_text.delta":
			deltas.WriteString(ev.Delta)
		case "response.completed", "response.done":
			var b strings.Builder
			for _, o := range ev.Response.Output {
				for _, part := range o.Content {
					if part.Type == "output_text" {
						b.WriteString(part.Text)
					}
				}
			}
			completed = b.String()
		case "response.failed", "error":
			msg := ev.Message
			if ev.Response.Error != nil {
				msg = ev.Response.Error.Message
			}
			if msg == "" {
				msg = "the model failed"
			}
			return "", errors.New(msg)
		}
	}
	if err := scanner.Err(); err != nil {
		return "", err
	}
	if deltas.Len() > 0 {
		return deltas.String(), nil
	}
	return completed, nil
}

var (
	fencePattern = regexp.MustCompile("(?s)```(?:html|HTML)?[ \\t]*\\r?\\n(.*?)```")
	docPattern   = regexp.MustCompile(`(?is)(<!doctype html.*?</html>|<html.*?</html>)`)
	svgPattern   = regexp.MustCompile(`(?is)<svg.*?</svg>`)
)

// ExtractHTML is the page in a reply: a fenced block that is a document,
// else the document in the text, else a bare SVG put in a page.
func ExtractHTML(text string) string {
	page := ""
	for _, m := range fencePattern.FindAllStringSubmatch(text, -1) {
		block := strings.TrimSpace(m[1])
		if docPattern.MatchString(block) || svgPattern.MatchString(block) {
			page = block
			break
		}
	}
	if page == "" {
		page = docPattern.FindString(text)
	}
	if page == "" {
		if svg := svgPattern.FindString(text); svg != "" {
			page = "<!doctype html><html><head><meta charset=\"utf-8\"></head><body style=\"margin:0\">" + svg + "</body></html>"
		}
	}
	if len(page) > iqHTMLBytes {
		return ""
	}
	return strings.TrimSpace(page)
}
