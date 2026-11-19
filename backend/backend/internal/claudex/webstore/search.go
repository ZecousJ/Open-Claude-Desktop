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
	Page            *SearchPage
}

// SearchPage applies filters and an offset for official clients.
type SearchPage struct {
	Offset      int    `json:"offset"`
	Archive     string `json:"archive"`
	StarredOnly bool   `json:"starredOnly"`
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
	archive := "active"
	offset := 0
	starred := false
	if opt.IncludeArchived {
		archive = "all"
	}
	if opt.Page != nil {
		archive, offset, starred = opt.Page.Archive, opt.Page.Offset, opt.Page.StarredOnly
		if offset < 0 || offset > 100000 || (archive != "all" && archive != "active" && archive != "archived") {
			return nil, badRequest("The search page is not valid.")
		}
	}
	if err := c.store.ok(); err != nil {
		return nil, err
	}
	pattern := "%" + escapeLike(query) + "%"
	rows, err := c.store.db.QueryContext(ctx, `WITH eligible AS MATERIALIZED (
 SELECT c.* FROM claudex_web_conversations c
 WHERE c.user_id = $1 AND ($3 = '' OR c.mode = $3)
   AND ($6 = '' OR c.project_id = $6)
   AND ($4 = 'all' OR ($4 = 'active' AND NOT c.archived) OR ($4 = 'archived' AND c.archived))
   AND (NOT $8 OR c.pinned)
), texts AS MATERIALIZED (
 SELECT t.conversation_id, t.turn_id, t.ordinal,
   CASE WHEN octet_length(t.search_text) BETWEEN 65533 AND 65536 OR t.search_text = '' THEN
     COALESCE(t.doc->'turn'->>'prompt', '') || E'\n' || COALESCE((
       SELECT string_agg(item->>'text', E'\n' ORDER BY ord)
       FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.doc->'turn'->'items') = 'array'
         THEN t.doc->'turn'->'items' ELSE '[]'::jsonb END) WITH ORDINALITY AS i(item, ord)
       WHERE item->>'type' = 'agentMessage' AND jsonb_typeof(item->'text') = 'string'
     ), '')
   ELSE t.search_text END AS text
 FROM claudex_web_turns t JOIN eligible c ON c.id = t.conversation_id
 WHERE t.user_id = $1 AND t.branch_id = ''
), hits AS (
 SELECT c.id, ''::text AS turn_id, ''::text AS text, 1 AS rank, 0 AS ordinal
 FROM eligible c WHERE c.title ILIKE $2 ESCAPE '\'
 UNION ALL
 SELECT t.conversation_id, t.turn_id, t.text, 0, t.ordinal
 FROM texts t WHERE t.text ILIKE $2 ESCAPE '\'
), first AS (
 SELECT DISTINCT ON (id) id, turn_id, text FROM hits ORDER BY id, rank, ordinal, turn_id
)
SELECT c.id, c.title, c.mode, c.project_id, c.archived, c.updated_ms, f.turn_id, f.text
FROM first f JOIN eligible c ON c.id = f.id
ORDER BY c.updated_ms DESC, c.id
LIMIT $5 OFFSET $7`, userID, pattern, opt.Mode, archive, opt.Limit, opt.ProjectID, offset, starred)
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
