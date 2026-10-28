package webstore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"regexp"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
)

// Tenant isolation: every statement below takes the user id as its first
// parameter and every table's key starts with user_id, so a row is only ever
// found, changed or deleted together with the user it belongs to. The ids
// the runner sends (conversation, turn, project, artifact, file) are never
// enough on their own. store_integration_test.go checks this with two users
// that use the same ids.

// docID is the id shape of stored documents (webproto's docIDPattern).
var docID = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,128}$`)

type querier interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

type store struct{ db *sql.DB }

func (s *store) ok() error {
	if s == nil || s.db == nil {
		return failed(errors.New("webstore: no database"))
	}
	return nil
}

// tx runs fn in a transaction holding the user's write lock, so the quota
// check and the usage counters stay exact under concurrent writes.
func (s *store) tx(ctx context.Context, userID int64, fn func(tx *sql.Tx) error) (err error) {
	if err := s.ok(); err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return failed(err)
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('claudex_web_store', $1))`, userID); err != nil {
		return failed(err)
	}
	if err = fn(tx); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return failed(err)
	}
	return nil
}

// Usage is what a user stores.
type Usage struct {
	DocBytes  int64 `json:"doc_bytes"`
	FileBytes int64 `json:"file_bytes"`
}

// Total is documents plus files.
func (u Usage) Total() int64 { return u.DocBytes + u.FileBytes }

func usageOf(ctx context.Context, q querier, userID int64) (Usage, error) {
	var u Usage
	err := q.QueryRowContext(ctx, `SELECT doc_bytes, file_bytes FROM claudex_web_store_usage WHERE user_id = $1`, userID).
		Scan(&u.DocBytes, &u.FileBytes)
	if errors.Is(err, sql.ErrNoRows) {
		return Usage{}, nil
	}
	return u, err
}

func addUsage(ctx context.Context, q querier, userID, docDelta, fileDelta int64) error {
	if docDelta == 0 && fileDelta == 0 {
		return nil
	}
	_, err := q.ExecContext(ctx, `INSERT INTO claudex_web_store_usage (user_id, doc_bytes, file_bytes, updated_at)
VALUES ($1, GREATEST($2::bigint, 0), GREATEST($3::bigint, 0), NOW())
ON CONFLICT (user_id) DO UPDATE SET
    doc_bytes = GREATEST(claudex_web_store_usage.doc_bytes + $2::bigint, 0),
    file_bytes = GREATEST(claudex_web_store_usage.file_bytes + $3::bigint, 0),
    updated_at = NOW()`, userID, docDelta, fileDelta)
	return err
}

// quotaMode says how strictly a write that grows the store is checked.
type quotaMode int

const (
	quotaStrict quotaMode = iota // new rows: stop at the quota
	quotaGrace                   // rows that exist (turns while streaming): 10% more
)

// checkQuota refuses a write that would grow the user's store past the
// quota. Writes that shrink it always pass.
func checkQuota(ctx context.Context, q querier, userID, grow int64, lim Limits, mode quotaMode) error {
	if grow <= 0 {
		return nil
	}
	u, err := usageOf(ctx, q, userID)
	if err != nil {
		return failed(err)
	}
	limit := lim.QuotaBytes
	if mode == quotaGrace {
		limit = limit / docGraceDen * docGraceNum
	}
	if u.Total()+grow > limit {
		return quotaExceeded()
	}
	return nil
}

// oldBytes reads the bytes column of one row (0 and false when missing).
func oldBytes(ctx context.Context, q querier, query string, args ...any) (int64, bool, error) {
	var n int64
	err := q.QueryRowContext(ctx, query, args...).Scan(&n)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, failed(err)
	}
	return n, true, nil
}

// ---------------------------------------------------------------------------
// Settings

func (s *store) getSettings(ctx context.Context, userID int64) (json.RawMessage, error) {
	if err := s.ok(); err != nil {
		return nil, err
	}
	var doc []byte
	err := s.db.QueryRowContext(ctx, `SELECT doc FROM claudex_web_settings WHERE user_id = $1`, userID).Scan(&doc)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, failed(err)
	}
	return doc, nil
}

func (s *store) putSettings(ctx context.Context, userID int64, doc json.RawMessage, lim Limits) error {
	doc = jsonbSafe(doc)
	size := int64(len(doc))
	return s.tx(ctx, userID, func(tx *sql.Tx) error {
		old, _, err := oldBytes(ctx, tx, `SELECT bytes FROM claudex_web_settings WHERE user_id = $1`, userID)
		if err != nil {
			return err
		}
		if err := checkQuota(ctx, tx, userID, size-old, lim, quotaGrace); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO claudex_web_settings (user_id, doc, bytes, updated_at) VALUES ($1, $2::jsonb, $3, NOW())
ON CONFLICT (user_id) DO UPDATE SET doc = EXCLUDED.doc, bytes = EXCLUDED.bytes, updated_at = NOW()`, userID, string(doc), size); err != nil {
			return failed(err)
		}
		return failedIf(addUsage(ctx, tx, userID, size-old, 0))
	})
}

func failedIf(err error) error {
	if err != nil {
		return failed(err)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Projects

type positionCursor struct {
	P  int    `json:"p"`
	ID string `json:"id"`
}

func (s *store) listProjects(ctx context.Context, userID int64, cursor string) ([]json.RawMessage, string, error) {
	if err := s.ok(); err != nil {
		return nil, "", err
	}
	after := positionCursor{P: -1 << 31}
	if cursor != "" && !decodeCursor(cursor, &after) {
		return nil, "", badRequest("The cursor is not valid.")
	}
	rows, err := s.db.QueryContext(ctx, `SELECT position, id, doc, bytes FROM claudex_web_projects
WHERE user_id = $1 AND (position, id) > ($2, $3) ORDER BY position, id LIMIT $4`, userID, after.P, after.ID, pageRows+1)
	if err != nil {
		return nil, "", failed(err)
	}
	defer func() { _ = rows.Close() }()
	var out []json.RawMessage
	var total int64
	next := ""
	for rows.Next() {
		var c positionCursor
		var doc []byte
		var n int64
		if err := rows.Scan(&c.P, &c.ID, &doc, &n); err != nil {
			return nil, "", failed(err)
		}
		if len(out) == pageRows || (len(out) > 0 && total+n > pageBytes) {
			next = encodeCursor(after)
			break
		}
		out = append(out, doc)
		total += n
		after = c
	}
	if err := rows.Err(); err != nil {
		return nil, "", failed(err)
	}
	return out, next, nil
}

func (s *store) putProject(ctx context.Context, userID int64, id string, position int, doc json.RawMessage, lim Limits) error {
	doc = jsonbSafe(doc)
	size := int64(len(doc))
	return s.tx(ctx, userID, func(tx *sql.Tx) error {
		old, exists, err := oldBytes(ctx, tx, `SELECT bytes FROM claudex_web_projects WHERE user_id = $1 AND id = $2`, userID, id)
		if err != nil {
			return err
		}
		mode := quotaStrict
		if exists {
			mode = quotaGrace
		}
		if err := checkQuota(ctx, tx, userID, size-old, lim, mode); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO claudex_web_projects (user_id, id, position, doc, bytes) VALUES ($1, $2, $3, $4::jsonb, $5)
ON CONFLICT (user_id, id) DO UPDATE SET position = EXCLUDED.position, doc = EXCLUDED.doc, bytes = EXCLUDED.bytes, updated_at = NOW()`,
			userID, id, position, string(doc), size); err != nil {
			return failed(err)
		}
		return failedIf(addUsage(ctx, tx, userID, size-old, 0))
	})
}

func (s *store) deleteProject(ctx context.Context, userID int64, id string) error {
	return s.tx(ctx, userID, func(tx *sql.Tx) error {
		var n int64
		err := tx.QueryRowContext(ctx, `DELETE FROM claudex_web_projects WHERE user_id = $1 AND id = $2 RETURNING bytes`, userID, id).Scan(&n)
		if errors.Is(err, sql.ErrNoRows) {
			return nil // already gone: deletes are idempotent
		}
		if err != nil {
			return failed(err)
		}
		return failedIf(addUsage(ctx, tx, userID, -n, 0))
	})
}

// ---------------------------------------------------------------------------
// Conversations

// ConversationRow is a conversation document and its sidebar position.
type ConversationRow struct {
	Doc      json.RawMessage `json:"doc"`
	Position int             `json:"position"`
}

func (s *store) listConversations(ctx context.Context, userID int64, cursor string) ([]ConversationRow, string, error) {
	if err := s.ok(); err != nil {
		return nil, "", err
	}
	after := positionCursor{P: -1 << 31}
	if cursor != "" && !decodeCursor(cursor, &after) {
		return nil, "", badRequest("The cursor is not valid.")
	}
	rows, err := s.db.QueryContext(ctx, `SELECT position, id, doc, bytes FROM claudex_web_conversations
WHERE user_id = $1 AND (position, id) > ($2, $3) ORDER BY position, id LIMIT $4`, userID, after.P, after.ID, pageRows+1)
	if err != nil {
		return nil, "", failed(err)
	}
	defer func() { _ = rows.Close() }()
	out := []ConversationRow{}
	var total int64
	next := ""
	for rows.Next() {
		var c positionCursor
		var doc []byte
		var n int64
		if err := rows.Scan(&c.P, &c.ID, &doc, &n); err != nil {
			return nil, "", failed(err)
		}
		if len(out) == pageRows || (len(out) > 0 && total+n > pageBytes) {
			next = encodeCursor(after)
			break
		}
		out = append(out, ConversationRow{Doc: doc, Position: c.P})
		total += n
		after = c
	}
	if err := rows.Err(); err != nil {
		return nil, "", failed(err)
	}
	return out, next, nil
}

func (s *store) getConversation(ctx context.Context, userID int64, id string) (*ConversationRow, error) {
	if err := s.ok(); err != nil {
		return nil, err
	}
	var row ConversationRow
	var doc []byte
	err := s.db.QueryRowContext(ctx, `SELECT doc, position FROM claudex_web_conversations WHERE user_id = $1 AND id = $2`, userID, id).
		Scan(&doc, &row.Position)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, failed(err)
	}
	row.Doc = doc
	return &row, nil
}

func strOr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func boolOr(p *bool) bool { return p != nil && *p }

func int64Or(p *int64) int64 {
	if p == nil {
		return 0
	}
	return *p
}

func (s *store) putConversation(ctx context.Context, userID int64, raw json.RawMessage, meta webproto.ConversationMeta, position int, lim Limits) (int64, error) {
	raw = jsonbSafe(raw)
	size := int64(len(raw))
	var revision int64
	err := s.tx(ctx, userID, func(tx *sql.Tx) error {
		old, exists, err := oldBytes(ctx, tx, `SELECT bytes FROM claudex_web_conversations WHERE user_id = $1 AND id = $2`, userID, meta.ID)
		if err != nil {
			return err
		}
		mode := quotaStrict
		if exists {
			mode = quotaGrace
		}
		if err := checkQuota(ctx, tx, userID, size-old, lim, mode); err != nil {
			return err
		}
		err = tx.QueryRowContext(ctx, `INSERT INTO claudex_web_conversations
    (user_id, id, position, mode, project_id, title, model, pinned, archived, doc, bytes, created_ms, updated_ms)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13)
ON CONFLICT (user_id, id) DO UPDATE SET position = EXCLUDED.position, mode = EXCLUDED.mode,
    project_id = EXCLUDED.project_id, title = EXCLUDED.title, model = EXCLUDED.model, pinned = EXCLUDED.pinned,
    archived = EXCLUDED.archived, doc = EXCLUDED.doc, bytes = EXCLUDED.bytes, created_ms = EXCLUDED.created_ms,
    updated_ms = EXCLUDED.updated_ms, revision = claudex_web_conversations.revision + 1, updated_at = NOW()
RETURNING revision`,
			userID, meta.ID, position, meta.Mode, truncateUTF8(clean(meta.ProjectID), 128),
			clean(strOr(meta.Title)), truncateUTF8(clean(strOr(meta.Model)), 256),
			boolOr(meta.Pinned), boolOr(meta.Archived), string(raw), size,
			int64Or(meta.CreatedAt), int64Or(meta.UpdatedAt)).Scan(&revision)
		if err != nil {
			return failed(err)
		}
		return failedIf(addUsage(ctx, tx, userID, size-old, 0))
	})
	return revision, err
}

// deleteConversation removes a conversation, its turns and its artifacts.
func (s *store) deleteConversation(ctx context.Context, userID int64, id string) error {
	return s.tx(ctx, userID, func(tx *sql.Tx) error {
		var freed int64
		if err := tx.QueryRowContext(ctx, `SELECT
    COALESCE((SELECT bytes FROM claudex_web_conversations WHERE user_id = $1 AND id = $2), 0)
  + COALESCE((SELECT SUM(bytes) FROM claudex_web_turns WHERE user_id = $1 AND conversation_id = $2), 0)
  + COALESCE((SELECT SUM(v.bytes) FROM claudex_web_artifact_versions v JOIN claudex_web_artifacts a
        ON a.user_id = v.user_id AND a.id = v.artifact_id
      WHERE a.user_id = $1 AND a.conversation_id = $2), 0)
  + COALESCE((SELECT SUM(bytes) FROM claudex_web_artifacts WHERE user_id = $1 AND conversation_id = $2), 0)`,
			userID, id).Scan(&freed); err != nil {
			return failed(err)
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM claudex_web_artifacts WHERE user_id = $1 AND conversation_id = $2`, userID, id); err != nil {
			return failed(err)
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM claudex_web_conversations WHERE user_id = $1 AND id = $2`, userID, id); err != nil {
			return failed(err)
		}
		return failedIf(addUsage(ctx, tx, userID, -freed, 0))
	})
}

// ---------------------------------------------------------------------------
// Turns

type turnCursor struct {
	B string `json:"b"`
	O int    `json:"o"`
	T string `json:"t"`
}

func (s *store) conversationExists(ctx context.Context, q querier, userID int64, id string) (bool, error) {
	var one int
	err := q.QueryRowContext(ctx, `SELECT 1 FROM claudex_web_conversations WHERE user_id = $1 AND id = $2`, userID, id).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, failed(err)
	}
	return true, nil
}

func (s *store) listTurns(ctx context.Context, userID int64, conversationID, cursor string) ([]json.RawMessage, string, error) {
	if err := s.ok(); err != nil {
		return nil, "", err
	}
	var after *turnCursor
	if cursor != "" {
		after = &turnCursor{}
		if !decodeCursor(cursor, after) {
			return nil, "", badRequest("The cursor is not valid.")
		}
	}
	exists, err := s.conversationExists(ctx, s.db, userID, conversationID)
	if err != nil {
		return nil, "", err
	}
	if !exists {
		return nil, "", notFound("conversation")
	}
	query := `SELECT branch_id, ordinal, turn_id, doc, bytes FROM claudex_web_turns
WHERE user_id = $1 AND conversation_id = $2`
	args := []any{userID, conversationID}
	if after != nil {
		query += ` AND (branch_id, ordinal, turn_id) > ($3, $4, $5)`
		args = append(args, after.B, after.O, after.T)
	}
	query += ` ORDER BY branch_id, ordinal, turn_id LIMIT ` + itoa(pageRows+1)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, "", failed(err)
	}
	defer func() { _ = rows.Close() }()
	out := []json.RawMessage{}
	var total int64
	var last turnCursor
	next := ""
	for rows.Next() {
		var c turnCursor
		var doc []byte
		var n int64
		if err := rows.Scan(&c.B, &c.O, &c.T, &doc, &n); err != nil {
			return nil, "", failed(err)
		}
		if len(out) == pageRows || (len(out) > 0 && total+n > pageBytes) {
			next = encodeCursor(last)
			break
		}
		out = append(out, doc)
		total += n
		last = c
	}
	if err := rows.Err(); err != nil {
		return nil, "", failed(err)
	}
	return out, next, nil
}

// turnRow is one decoded turn of a turns.put.
type turnRow struct {
	raw    json.RawMessage
	doc    webproto.TurnDoc
	head   webproto.TurnHeader
	branch string
}

// putTurns upserts turns (any conversations of the user, each of which must
// exist) and returns the new revision of each conversation touched.
func (s *store) putTurns(ctx context.Context, userID int64, turns []turnRow, lim Limits) (map[string]int64, error) {
	revisions := map[string]int64{}
	err := s.tx(ctx, userID, func(tx *sql.Tx) error {
		for _, t := range turns {
			if _, seen := revisions[t.doc.ConversationID]; seen {
				continue
			}
			exists, err := s.conversationExists(ctx, tx, userID, t.doc.ConversationID)
			if err != nil {
				return err
			}
			if !exists {
				return notFound("conversation")
			}
			revisions[t.doc.ConversationID] = 0
		}
		var grow int64
		olds := make([]int64, len(turns))
		for i, t := range turns {
			old, _, err := oldBytes(ctx, tx, `SELECT bytes FROM claudex_web_turns
WHERE user_id = $1 AND conversation_id = $2 AND branch_id = $3 AND turn_id = $4`, userID, t.doc.ConversationID, t.branch, t.doc.TurnID)
			if err != nil {
				return err
			}
			olds[i] = old
			grow += int64(len(t.raw)) - old
		}
		if err := checkQuota(ctx, tx, userID, grow, lim, quotaGrace); err != nil {
			return err
		}
		for _, t := range turns {
			if _, err := tx.ExecContext(ctx, `INSERT INTO claudex_web_turns
    (user_id, conversation_id, branch_id, turn_id, ordinal, status, doc, bytes, search_text, created_ms)
VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)
ON CONFLICT (user_id, conversation_id, branch_id, turn_id) DO UPDATE SET ordinal = EXCLUDED.ordinal,
    status = EXCLUDED.status, doc = EXCLUDED.doc, bytes = EXCLUDED.bytes, search_text = EXCLUDED.search_text,
    created_ms = EXCLUDED.created_ms, updated_at = NOW()`,
				userID, t.doc.ConversationID, t.branch, t.doc.TurnID, t.doc.Ordinal, t.head.Status,
				string(t.raw), len(t.raw), searchText(t.doc.Turn), int64Or(t.head.CreatedAt)); err != nil {
				return failed(err)
			}
		}
		for id := range revisions {
			var rev int64
			if err := tx.QueryRowContext(ctx, `UPDATE claudex_web_conversations SET revision = revision + 1, updated_at = NOW()
WHERE user_id = $1 AND id = $2 RETURNING revision`, userID, id).Scan(&rev); err != nil {
				return failed(err)
			}
			revisions[id] = rev
		}
		return failedIf(addUsage(ctx, tx, userID, grow, 0))
	})
	return revisions, err
}

// TurnKey names one turn of a conversation (BranchID nil: live transcript).
type TurnKey struct {
	BranchID *string `json:"branchId"`
	TurnID   string  `json:"turnId"`
}

func (s *store) deleteTurns(ctx context.Context, userID int64, conversationID string, keys []TurnKey) error {
	return s.tx(ctx, userID, func(tx *sql.Tx) error {
		var freed int64
		for _, k := range keys {
			var n int64
			err := tx.QueryRowContext(ctx, `DELETE FROM claudex_web_turns
WHERE user_id = $1 AND conversation_id = $2 AND branch_id = $3 AND turn_id = $4 RETURNING bytes`,
				userID, conversationID, strOr(k.BranchID), k.TurnID).Scan(&n)
			if errors.Is(err, sql.ErrNoRows) {
				continue
			}
			if err != nil {
				return failed(err)
			}
			freed += n
		}
		if freed > 0 {
			if _, err := tx.ExecContext(ctx, `UPDATE claudex_web_conversations SET revision = revision + 1, updated_at = NOW()
WHERE user_id = $1 AND id = $2`, userID, conversationID); err != nil {
				return failed(err)
			}
		}
		return failedIf(addUsage(ctx, tx, userID, -freed, 0))
	})
}

// ---------------------------------------------------------------------------
// Artifacts

// ArtifactRow is the latest version of an artifact.
type ArtifactRow struct {
	Artifact  json.RawMessage `json:"artifact"`
	Version   int             `json:"version"`
	UpdatedAt time.Time       `json:"updatedAt"`
}

// ArtifactVersion is one kept version of an artifact.
type ArtifactVersion struct {
	Artifact  json.RawMessage `json:"artifact"`
	Version   int             `json:"version"`
	CreatedAt time.Time       `json:"createdAt"`
}

type artifactCursor struct {
	U  time.Time `json:"u"`
	ID string    `json:"id"`
}

func (s *store) listArtifacts(ctx context.Context, userID int64, conversationID *string, cursor string) ([]ArtifactRow, string, error) {
	if err := s.ok(); err != nil {
		return nil, "", err
	}
	query := `SELECT id, doc, version, updated_at, bytes FROM claudex_web_artifacts WHERE user_id = $1`
	args := []any{userID}
	if conversationID != nil {
		args = append(args, *conversationID)
		query += ` AND conversation_id = $2`
	}
	if cursor != "" {
		var after artifactCursor
		if !decodeCursor(cursor, &after) {
			return nil, "", badRequest("The cursor is not valid.")
		}
		args = append(args, after.U, after.ID)
		query += ` AND (updated_at, id) < ($` + itoa(len(args)-1) + `, $` + itoa(len(args)) + `)`
	}
	query += ` ORDER BY updated_at DESC, id DESC LIMIT ` + itoa(pageRows+1)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, "", failed(err)
	}
	defer func() { _ = rows.Close() }()
	out := []ArtifactRow{}
	var total int64
	var last artifactCursor
	next := ""
	for rows.Next() {
		var r ArtifactRow
		var id string
		var doc []byte
		var n int64
		if err := rows.Scan(&id, &doc, &r.Version, &r.UpdatedAt, &n); err != nil {
			return nil, "", failed(err)
		}
		if len(out) == pageRows || (len(out) > 0 && total+n > pageBytes) {
			next = encodeCursor(last)
			break
		}
		r.Artifact = doc
		out = append(out, r)
		total += n
		last = artifactCursor{U: r.UpdatedAt, ID: id}
	}
	if err := rows.Err(); err != nil {
		return nil, "", failed(err)
	}
	return out, next, nil
}

func (s *store) listArtifactVersions(ctx context.Context, userID int64, artifactID string) ([]ArtifactVersion, error) {
	if err := s.ok(); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT doc, version, created_at FROM claudex_web_artifact_versions
WHERE user_id = $1 AND artifact_id = $2 ORDER BY version DESC`, userID, artifactID)
	if err != nil {
		return nil, failed(err)
	}
	defer func() { _ = rows.Close() }()
	out := []ArtifactVersion{}
	for rows.Next() {
		var v ArtifactVersion
		var doc []byte
		if err := rows.Scan(&doc, &v.Version, &v.CreatedAt); err != nil {
			return nil, failed(err)
		}
		v.Artifact = doc
		out = append(out, v)
	}
	if err := rows.Err(); err != nil {
		return nil, failed(err)
	}
	if len(out) == 0 {
		return nil, notFound("artifact")
	}
	return out, nil
}

// putArtifact stores a new version of an artifact unless it equals the
// latest one, keeps the last maxArtifactVersions versions and returns the
// current version number.
func (s *store) putArtifact(ctx context.Context, userID int64, id, conversationID, title string, doc json.RawMessage, lim Limits) (int, error) {
	doc = jsonbSafe(doc)
	size := int64(len(doc))
	var version int
	err := s.tx(ctx, userID, func(tx *sql.Tx) error {
		var same bool
		var cur int
		err := tx.QueryRowContext(ctx, `SELECT version, doc = $3::jsonb FROM claudex_web_artifacts WHERE user_id = $1 AND id = $2`,
			userID, id, string(doc)).Scan(&cur, &same)
		exists := err == nil
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return failed(err)
		}
		if same {
			version = cur
			return nil
		}
		mode := quotaStrict
		if exists {
			mode = quotaGrace
		}
		// The new version is stored twice: as the latest row and as a version.
		if err := checkQuota(ctx, tx, userID, 2*size, lim, mode); err != nil {
			return err
		}
		var oldLatest int64
		if exists {
			if err := tx.QueryRowContext(ctx, `SELECT bytes FROM claudex_web_artifacts WHERE user_id = $1 AND id = $2`, userID, id).Scan(&oldLatest); err != nil {
				return failed(err)
			}
		}
		if err := tx.QueryRowContext(ctx, `INSERT INTO claudex_web_artifacts (user_id, id, conversation_id, title, version, doc, bytes)
VALUES ($1, $2, $3, $4, 1, $5::jsonb, $6)
ON CONFLICT (user_id, id) DO UPDATE SET conversation_id = EXCLUDED.conversation_id, title = EXCLUDED.title,
    version = claudex_web_artifacts.version + 1, doc = EXCLUDED.doc, bytes = EXCLUDED.bytes, updated_at = NOW()
RETURNING version`, userID, id, conversationID, title, string(doc), size).Scan(&version); err != nil {
			return failed(err)
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO claudex_web_artifact_versions (user_id, artifact_id, version, doc, bytes)
VALUES ($1, $2, $3, $4::jsonb, $5)`, userID, id, version, string(doc), size); err != nil {
			return failed(err)
		}
		var pruned int64
		if err := tx.QueryRowContext(ctx, `WITH gone AS (
    DELETE FROM claudex_web_artifact_versions WHERE user_id = $1 AND artifact_id = $2 AND version <= $3 RETURNING bytes)
SELECT COALESCE(SUM(bytes), 0) FROM gone`, userID, id, version-maxArtifactVersions).Scan(&pruned); err != nil {
			return failed(err)
		}
		return failedIf(addUsage(ctx, tx, userID, 2*size-oldLatest-pruned, 0))
	})
	return version, err
}

func (s *store) deleteArtifact(ctx context.Context, userID int64, id string) error {
	return s.tx(ctx, userID, func(tx *sql.Tx) error {
		var freed int64
		if err := tx.QueryRowContext(ctx, `SELECT
    COALESCE((SELECT bytes FROM claudex_web_artifacts WHERE user_id = $1 AND id = $2), 0)
  + COALESCE((SELECT SUM(bytes) FROM claudex_web_artifact_versions WHERE user_id = $1 AND artifact_id = $2), 0)`,
			userID, id).Scan(&freed); err != nil {
			return failed(err)
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM claudex_web_artifacts WHERE user_id = $1 AND id = $2`, userID, id); err != nil {
			return failed(err)
		}
		return failedIf(addUsage(ctx, tx, userID, -freed, 0))
	})
}
