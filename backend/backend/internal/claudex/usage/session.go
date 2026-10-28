package usage

import (
	"context"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"

	"github.com/gin-gonic/gin"
	"github.com/lib/pq"
)

// GET /api/v1/claudex/session-usage: what one Claudex session used, model by
// model, for the usage report a Code session posts in its transcript (live
// claude.ai bundle, 2026-10-12: "This session" with Cost, API time and the
// Input / Output / Cache read / Cache write breakdown).
//
// A session is the Codex threads of one Claudex conversation. The Claudex
// gateway sends each thread's id as the session_id header, which the gateway
// handlers store in usage_logs.session_id (ExtractClientSessionID), so the
// rows are read back by those ids. Only the caller's own rows are read, from
// `since` (the conversation's start) on, which keeps the scan on the
// (user_id, created_at) index.

const (
	// maxSessionUsageIDs bounds the threads one request names (a session's
	// own thread, the thread a rewind set aside, saved branches).
	maxSessionUsageIDs = 20
	// maxSessionUsageModels bounds the answer; a session uses a few models.
	maxSessionUsageModels = 50
	// maxSessionIDLength is the usage_logs.session_id column width.
	maxSessionIDLength = 255
	// maxSessionUsageAge bounds how far back a request may read.
	maxSessionUsageAge = 400 * 24 * time.Hour
)

var errBadSessionUsageQuery = infraerrors.BadRequest("INVALID_SESSION_USAGE_QUERY", "Name the session and when it started.")

// SessionUsageModel is what a session used of one model.
type SessionUsageModel struct {
	Model            string  `json:"model"`
	Requests         int64   `json:"requests"`
	InputTokens      int64   `json:"input_tokens"`
	OutputTokens     int64   `json:"output_tokens"`
	CacheReadTokens  int64   `json:"cache_read_tokens"`
	CacheWriteTokens int64   `json:"cache_creation_tokens"`
	ActualCost       float64 `json:"actual_cost"`
	DurationMs       int64   `json:"duration_ms"`
}

// SessionUsage is the body of GET /api/v1/claudex/session-usage.
type SessionUsage struct {
	Models []SessionUsageModel `json:"models"`
}

// sessionUsageReader reads a user's usage rows of the given session ids.
type sessionUsageReader func(ctx context.Context, userID int64, sessionIDs []string, since time.Time) ([]SessionUsageModel, error)

// parseSessionUsageQuery checks ?session_id= (one or more) and ?since=
// (RFC 3339). Blank and duplicate ids are dropped; a request naming none, more
// than maxSessionUsageIDs, or an id longer than the column is refused. A start
// in the future is refused; one further back than maxSessionUsageAge is
// brought forward to it.
func parseSessionUsageQuery(rawIDs []string, rawSince string, now time.Time) ([]string, time.Time, error) {
	seen := map[string]bool{}
	ids := make([]string, 0, len(rawIDs))
	for _, raw := range rawIDs {
		id := strings.TrimSpace(raw)
		if id == "" || seen[id] {
			continue
		}
		if len(id) > maxSessionIDLength {
			return nil, time.Time{}, errBadSessionUsageQuery
		}
		seen[id] = true
		ids = append(ids, id)
	}
	if len(ids) == 0 || len(ids) > maxSessionUsageIDs {
		return nil, time.Time{}, errBadSessionUsageQuery
	}
	since, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(rawSince))
	if err != nil || since.After(now.Add(time.Minute)) {
		return nil, time.Time{}, errBadSessionUsageQuery
	}
	if earliest := now.Add(-maxSessionUsageAge); since.Before(earliest) {
		since = earliest
	}
	return ids, since.UTC(), nil
}

func (c *Component) userSessionUsage(g *gin.Context) {
	g.Header("Cache-Control", "no-store")
	userID, ok := core.Subject(g)
	if !ok {
		response.ErrorFrom(g, errNotSignedIn)
		return
	}
	ids, since, err := parseSessionUsageQuery(g.QueryArray("session_id"), g.Query("since"), c.now())
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	models, err := c.readSessionUsage(g.Request.Context(), userID, ids, since)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	if models == nil {
		models = []SessionUsageModel{}
	}
	response.Success(g, SessionUsage{Models: models})
}

// selectSessionUsage groups the caller's rows of the sessions by the model
// the client asked for (the model column for rows written before
// requested_model existed), costliest first. actual_cost is what the
// balance was charged.
const selectSessionUsage = `
SELECT COALESCE(NULLIF(requested_model, ''), model) AS usage_model,
       COUNT(*)::bigint,
       COALESCE(SUM(input_tokens), 0)::bigint,
       COALESCE(SUM(output_tokens), 0)::bigint,
       COALESCE(SUM(cache_read_tokens), 0)::bigint,
       COALESCE(SUM(cache_creation_tokens), 0)::bigint,
       COALESCE(SUM(actual_cost), 0)::double precision,
       COALESCE(SUM(duration_ms), 0)::bigint
FROM usage_logs
WHERE user_id = $1::bigint
  AND created_at >= $2::timestamptz
  AND session_id = ANY($3::text[])
GROUP BY usage_model
ORDER BY 7 DESC, usage_model
LIMIT $4::int`

func (s sqlStore) sessionUsage(ctx context.Context, userID int64, sessionIDs []string, since time.Time) ([]SessionUsageModel, error) {
	db, err := s.conn()
	if err != nil {
		return nil, err
	}
	rows, err := db.QueryContext(ctx, selectSessionUsage, userID, since.UTC(), pq.Array(sessionIDs), maxSessionUsageModels)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []SessionUsageModel{}
	for rows.Next() {
		var m SessionUsageModel
		if err := rows.Scan(&m.Model, &m.Requests, &m.InputTokens, &m.OutputTokens, &m.CacheReadTokens, &m.CacheWriteTokens, &m.ActualCost, &m.DurationMs); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}
