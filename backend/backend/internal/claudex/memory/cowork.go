package memory

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"path"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/gin-gonic/gin"
)

const coworkMaxBytes = 4 << 20

var errCoworkLarge = infraerrors.New(http.StatusRequestEntityTooLarge, "CLAUDEX_MEMORY_TOO_LARGE", "Cowork memory is too large.")
var errCoworkEpoch = infraerrors.Conflict("CLAUDEX_COWORK_MEMORY_RESET", "Cowork memory was reset. Reload it before writing.")
var errCoworkRevision = infraerrors.New(http.StatusPreconditionFailed, "CLAUDEX_COWORK_MEMORY_CONFLICT", "Cowork memory changed. Reload it before writing.")

type coworkView struct {
	Revision  string            `json:"revision"`
	Epoch     string            `json:"epoch"`
	UpdatedAt *time.Time        `json:"updated_at"`
	Entries   map[string]string `json:"entries"`
}
type coworkChange struct {
	Entries          map[string]string `json:"entries"`
	DeleteKeys       []string          `json:"delete_keys"`
	ExpectedRevision *string           `json:"expected_revision"`
	ExpectedEpoch    *string           `json:"expected_epoch"`
}
type coworkPersistence interface {
	coworkGet(context.Context, int64, *core.SecretBox) (coworkView, error)
	coworkUpdate(context.Context, int64, *core.SecretBox, coworkChange, bool) (coworkView, error)
}

func coworkEmpty() coworkView {
	return coworkView{Revision: "0", Epoch: "0", Entries: map[string]string{}}
}
func validCoworkKey(k string) bool {
	return k != "" && len(k) <= 1024 && utf8.ValidString(k) && !strings.ContainsAny(k, "\\\x00*?[]") && !strings.HasPrefix(k, "/") && path.Clean(k) == k && k != "." && k != ".." && !strings.HasPrefix(k, "../") && strings.HasSuffix(strings.ToLower(k), ".md")
}
func validCoworkToken(v *string) bool {
	if v == nil || *v == "" || len(*v) > 19 {
		return false
	}
	n, err := strconv.ParseInt(*v, 10, 64)
	return err == nil && n >= 0 && strconv.FormatInt(n, 10) == *v
}
func (c *Component) coworkStore() (coworkPersistence, error) {
	s, ok := c.store.(coworkPersistence)
	if !ok {
		return nil, errNoDatabase
	}
	return s, nil
}
func (c *Component) getCowork(g *gin.Context) {
	uid, ok := subject(g)
	if !ok {
		return
	}
	if !c.box.CanStore() {
		response.ErrorFrom(g, ErrEncryptionKeyMissing)
		return
	}
	s, err := c.coworkStore()
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	view, err := s.coworkGet(g.Request.Context(), uid, c.box)
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	g.Header("Cache-Control", "no-store")
	response.Success(g, view)
}
func readCoworkJSON(g *gin.Context, body *coworkChange) error {
	const limit = 6*coworkMaxBytes + 4096
	if g.Request.Body == nil {
		return invalid("body", "json", "A JSON object is required.")
	}
	raw, err := io.ReadAll(io.LimitReader(g.Request.Body, limit+1))
	if err != nil {
		return invalid("body", "read", "Could not read the request.")
	}
	if len(raw) > limit {
		return errCoworkLarge
	}
	if !utf8.Valid(raw) {
		return invalid("body", "utf8", "The request must be UTF-8.")
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return invalid("body", "json", "A JSON object is required.")
	}
	if value, ok := fields["entries"]; ok {
		var entries map[string]json.RawMessage
		if err := json.Unmarshal(value, &entries); err != nil || entries == nil {
			return invalid("entries", "object", "entries must be an object of strings.")
		}
		for _, value := range entries {
			var text *string
			if err := json.Unmarshal(value, &text); err != nil || text == nil {
				return invalid("entries", "string", "Each entry must be a string.")
			}
		}
	}
	if value, ok := fields["delete_keys"]; ok {
		var keys []json.RawMessage
		if err := json.Unmarshal(value, &keys); err != nil || keys == nil {
			return invalid("delete_keys", "array", "delete_keys must be an array of strings.")
		}
		for _, value := range keys {
			var text *string
			if err := json.Unmarshal(value, &text); err != nil || text == nil {
				return invalid("delete_keys", "string", "Each key must be a string.")
			}
		}
	}
	g.Request.Body = io.NopCloser(bytes.NewReader(raw))
	g.Request.ContentLength = int64(len(raw))
	return readBoundedJSON(g, body, limit, errCoworkLarge)
}
func (c *Component) changeCowork(g *gin.Context) {
	uid, ok := subject(g)
	if !ok {
		return
	}
	reset := g.Request.Method == http.MethodDelete
	var body coworkChange
	if err := readCoworkJSON(g, &body); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	if !validCoworkToken(body.ExpectedEpoch) || body.ExpectedRevision != nil && !validCoworkToken(body.ExpectedRevision) {
		response.ErrorFrom(g, invalid("expected_epoch", "token", "A valid expected epoch and optional revision are required."))
		return
	}
	if reset && (body.Entries != nil || body.DeleteKeys != nil || body.ExpectedRevision != nil) {
		response.ErrorFrom(g, invalid("body", "reset", "Reset accepts only expected_epoch."))
		return
	}
	if !reset && body.Entries == nil && body.DeleteKeys == nil {
		response.ErrorFrom(g, invalid("body", "required", "Provide entries or delete_keys."))
		return
	}
	for k, v := range body.Entries {
		if !validCoworkKey(k) || !utf8.ValidString(v) {
			response.ErrorFrom(g, invalid("entries", "path", "Memory entries must be valid Markdown paths and UTF-8 text."))
			return
		}
	}
	for _, k := range body.DeleteKeys {
		if !validCoworkKey(k) {
			response.ErrorFrom(g, invalid("delete_keys", "path", "Memory entries must be valid Markdown paths."))
			return
		}
		if _, ok := body.Entries[k]; ok {
			response.ErrorFrom(g, invalid("body", "overlap", "An entry cannot be written and deleted together."))
			return
		}
	}
	if !reset {
		st, err := c.requestStatus(g, uid)
		if err != nil {
			response.ErrorFrom(g, err)
			return
		}
		if st.Reason != nil && *st.Reason == ReasonPolicy {
			response.ErrorFrom(g, disabledFor("memory"))
			return
		}
		if !c.box.CanStore() {
			response.ErrorFrom(g, ErrEncryptionKeyMissing)
			return
		}
	}
	s, err := c.coworkStore()
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	view, err := s.coworkUpdate(g.Request.Context(), uid, c.box, body, reset)
	switch {
	case errors.Is(err, errCoworkEpoch), errors.Is(err, errCoworkRevision), errors.Is(err, errCoworkLarge):
		response.ErrorFrom(g, err)
		return
	case err != nil:
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	g.Header("Cache-Control", "no-store")
	response.Success(g, view)
}
func coworkRead(ctx context.Context, q interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, uid int64, box *core.SecretBox) (coworkView, error) {
	v := coworkEmpty()
	var revision, epoch int64
	var encrypted sql.NullString
	var updated time.Time
	err := q.QueryRowContext(ctx, `SELECT revision, epoch, entries_enc, updated_at FROM claudex_memory_cowork WHERE user_id=$1`, uid).Scan(&revision, &epoch, &encrypted, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return v, nil
	}
	if err != nil {
		return v, err
	}
	v.Revision = strconv.FormatInt(revision, 10)
	v.Epoch = strconv.FormatInt(epoch, 10)
	v.UpdatedAt = &updated
	if encrypted.Valid {
		plain, err := box.Open(encrypted.String)
		if err != nil {
			return v, err
		}
		if err = json.Unmarshal([]byte(plain), &v.Entries); err != nil || v.Entries == nil {
			return v, errors.New("invalid stored cowork memory")
		}
	}
	return v, nil
}
func (s *sqlStore) coworkGet(ctx context.Context, uid int64, box *core.SecretBox) (coworkView, error) {
	if err := s.ready(); err != nil {
		return coworkView{}, err
	}
	return coworkRead(ctx, s.db, uid, box)
}
func (s *sqlStore) coworkUpdate(ctx context.Context, uid int64, box *core.SecretBox, change coworkChange, reset bool) (coworkView, error) {
	var result coworkView
	err := s.withUserLock(ctx, uid, func(tx *sql.Tx) error {
		// Reset does not need the encryption key or plaintext.
		if reset {
			var rev, epoch int64
			err := tx.QueryRowContext(ctx, `SELECT revision,epoch FROM claudex_memory_cowork WHERE user_id=$1`, uid).Scan(&rev, &epoch)
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			if strconv.FormatInt(epoch, 10) != *change.ExpectedEpoch {
				return errCoworkEpoch
			}
			return clearCowork(ctx, tx, uid, &result)
		}
		v, err := coworkRead(ctx, tx, uid, box)
		if err != nil {
			return err
		}
		if v.Epoch != *change.ExpectedEpoch {
			return errCoworkEpoch
		}
		if change.ExpectedRevision != nil && v.Revision != *change.ExpectedRevision {
			return errCoworkRevision
		}
		for k, val := range change.Entries {
			v.Entries[k] = val
		}
		for _, k := range change.DeleteKeys {
			delete(v.Entries, k)
		}
		raw, err := json.Marshal(v.Entries)
		if err != nil {
			return err
		}
		if len(raw) > coworkMaxBytes {
			return errCoworkLarge
		}
		encrypted, err := box.Seal(string(raw))
		if err != nil {
			return err
		}
		var rev, epoch int64
		var updated time.Time
		err = tx.QueryRowContext(ctx, `INSERT INTO claudex_memory_cowork (user_id,revision,epoch,entries_enc,entries_bytes) VALUES ($1,1,0,$2,$3) ON CONFLICT (user_id) DO UPDATE SET revision=claudex_memory_cowork.revision+1,entries_enc=EXCLUDED.entries_enc,entries_bytes=EXCLUDED.entries_bytes,updated_at=NOW() RETURNING revision,epoch,updated_at`, uid, encrypted, len(raw)).Scan(&rev, &epoch, &updated)
		if err != nil {
			return err
		}
		v.Revision = strconv.FormatInt(rev, 10)
		v.Epoch = strconv.FormatInt(epoch, 10)
		v.UpdatedAt = &updated
		result = v
		return nil
	})
	return result, err
}
func clearCowork(ctx context.Context, tx *sql.Tx, uid int64, view *coworkView) error {
	var rev, epoch int64
	var updated time.Time
	err := tx.QueryRowContext(ctx, `INSERT INTO claudex_memory_cowork (user_id,revision,epoch,entries_enc,entries_bytes) VALUES ($1,1,1,NULL,0) ON CONFLICT (user_id) DO UPDATE SET revision=claudex_memory_cowork.revision+1,epoch=claudex_memory_cowork.epoch+1,entries_enc=NULL,entries_bytes=0,updated_at=NOW() RETURNING revision,epoch,updated_at`, uid).Scan(&rev, &epoch, &updated)
	if err == nil && view != nil {
		*view = coworkView{Revision: strconv.FormatInt(rev, 10), Epoch: strconv.FormatInt(epoch, 10), UpdatedAt: &updated, Entries: map[string]string{}}
	}
	return err
}
