package webstore

import (
	"context"
	"strings"
	"unicode/utf8"
)

// SearchOptions narrow a search.
type SearchOptions struct {
	Mode            string // chat | cowork | code | "" (all)
	ProjectID       string
	IncludeArchived bool
	Limit           int // 1..50, default 20
}

// SearchHit is one conversation that matches, with where it matched.
type SearchHit struct {
	ConversationID string `json:"conversationId"`
	Title          string `json:"title"`
	Mode           string `json:"mode"`
	ProjectID      string `json:"projectId,omitempty"`
	Archived       bool   `json:"archived"`
	UpdatedAt      int64  `json:"updatedAt"`
	// TurnID is the first matching turn of the live transcript ("" when
	// only the title matched); Snippet is the text around the match.
	TurnID  string `json:"turnId,omitempty"`
	Snippet string `json:"snippet,omitempty"`
}

// Search finds the user's conversations whose title or live transcript
// (prompts and reply text) contains the query, case-insensitively, newest
// first. A plain substring match is used on purpose: it works for Chinese
// and other text without word boundaries, which PostgreSQL's 'simple'
// text search does not split. The scan is bounded by the user's own rows
// (every clause is scoped by user_id) and the storage quota.
func (c *Component) Search(ctx context.Context, userID int64, query string, opt SearchOptions) ([]SearchHit, error) {
	query = strings.TrimSpace(clean(query))
	if query == "" {
		return []SearchHit{}, nil
	}
	if utf8.RuneCountInString(query) > maxQuery {
		return nil, badRequest("The search is too long.")
	}
	if opt.Mode != "" && opt.Mode != "chat" && opt.Mode != "cowork" && opt.Mode != "code" {
		return nil, badRequest("The mode is not valid.")
	}
	if opt.Limit <= 0 {
		opt.Limit = 20
	}
	if opt.Limit > searchLimit {
		opt.Limit = searchLimit
	}
	if err := c.store.ok(); err != nil {
		return nil, err
	}
	pattern := "%" + escapeLike(query) + "%"
	rows, err := c.store.db.QueryContext(ctx, `WITH hits AS (
    SELECT c.id, ''::text AS turn_id, ''::text AS text, 0 AS rank, 0 AS ordinal
      FROM claudex_web_conversations c
     WHERE c.user_id = $1 AND c.title ILIKE $2 ESCAPE '\'
    UNION ALL
    SELECT t.conversation_id, t.turn_id, t.search_text, 1, t.ordinal
      FROM claudex_web_turns t
     WHERE t.user_id = $1 AND t.branch_id = '' AND t.search_text ILIKE $2 ESCAPE '\'
), first AS (
    SELECT DISTINCT ON (id) id, turn_id, text FROM hits ORDER BY id, rank, ordinal
)
SELECT c.id, c.title, c.mode, c.project_id, c.archived, c.updated_ms, f.turn_id, f.text
  FROM first f JOIN claudex_web_conversations c ON c.user_id = $1 AND c.id = f.id
 WHERE ($3 = '' OR c.mode = $3) AND ($4 OR NOT c.archived)
   AND ($6 = '' OR c.project_id = $6)
 ORDER BY c.updated_ms DESC, c.id
 LIMIT $5`, userID, pattern, opt.Mode, opt.IncludeArchived, opt.Limit, opt.ProjectID)
	if err != nil {
		return nil, failed(err)
	}
	defer func() { _ = rows.Close() }()
	out := []SearchHit{}
	for rows.Next() {
		var h SearchHit
		var text string
		if err := rows.Scan(&h.ConversationID, &h.Title, &h.Mode, &h.ProjectID, &h.Archived, &h.UpdatedAt, &h.TurnID, &text); err != nil {
			return nil, failed(err)
		}
		if h.TurnID != "" {
			h.Snippet = snippet(text, query, 160)
		}
		out = append(out, h)
	}
	if err := rows.Err(); err != nil {
		return nil, failed(err)
	}
	return out, nil
}

// snippet returns about width runes of text around the first match of query.
func snippet(text, query string, width int) string {
	runes := []rune(text)
	lower := strings.ToLower(text)
	at := 0
	// Rune positions only line up when lowering kept the rune count.
	if i := strings.Index(lower, strings.ToLower(query)); i >= 0 && utf8.RuneCountInString(lower) == len(runes) {
		at = utf8.RuneCountInString(lower[:i])
	}
	start := at - width/3
	if start < 0 {
		start = 0
	}
	end := start + width
	if end > len(runes) {
		end = len(runes)
	}
	s := strings.Join(strings.Fields(string(runes[start:end])), " ")
	if start > 0 {
		s = "…" + s
	}
	if end < len(runes) {
		s += "…"
	}
	return s
}

// Usage returns what the user stores and the limits.
func (c *Component) Usage(ctx context.Context, userID int64) (Usage, Limits, error) {
	lim := c.Limits(ctx)
	if err := c.store.ok(); err != nil {
		return Usage{}, lim, err
	}
	u, err := usageOf(ctx, c.store.db, userID)
	if err != nil {
		return Usage{}, lim, failed(err)
	}
	return u, lim, nil
}
