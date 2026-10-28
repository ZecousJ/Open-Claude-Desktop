package memory

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"

	"github.com/gin-gonic/gin"
)

// Unavailability reasons of Status.Reason.
const (
	ReasonPolicy = "policy" // the administrator's policy turned memory off
	ReasonServer = "server" // the server has no fixed encryption key
)

// Switches are the two memory switches of the desktop app's Settings → Memory.
type Switches struct {
	SearchChats bool `json:"search_chats"`
	Generate    bool `json:"generate"`
}

// Status says what memory can do for the user.
//
//   - Available: memory can be stored (policy on and the server key ready).
//   - Allowed: what the policy lets the user turn on.
//   - Prefs: the user's own choice; the policy's default_on while PrefsSet is
//     false.
//   - Effective: what the desktop app should do. search_chats runs on the
//     device only, so it needs the policy and the user's switch but not the
//     server key; generate needs Available too.
type Status struct {
	Available bool     `json:"available"`
	Reason    *string  `json:"reason"`
	Allowed   Switches `json:"allowed"`
	Prefs     Switches `json:"prefs"`
	PrefsSet  bool     `json:"prefs_set"`
	Effective Switches `json:"effective"`
	// Model is the policy's synthesis model (nil: the plan group's default).
	Model *string `json:"model"`
}

// Limits are the server's memory limits (GET /memory).
type Limits struct {
	DocBytes      int `json:"doc_bytes"`
	EditsPerScope int `json:"edits_per_scope"`
	EditChars     int `json:"edit_chars"`
	Scopes        int `json:"scopes"`
}

var serverLimits = Limits{DocBytes: MaxDocBytes, EditsPerScope: MaxEditsPerScope, EditChars: MaxEditChars, Scopes: MaxScopes}

// DocView is a memory document for its owner. Content is nil and Readable
// false when it cannot be decrypted any more (the server key changed).
type DocView struct {
	Scope        string     `json:"scope"`
	Content      *string    `json:"content"`
	Readable     bool       `json:"readable"`
	ContentBytes int        `json:"content_bytes"`
	Revision     int64      `json:"revision"`
	Source       string     `json:"source"`
	GeneratedAt  *time.Time `json:"generated_at"`
	UpdatedAt    time.Time  `json:"updated_at"`
	CreatedAt    time.Time  `json:"created_at"`
}

// EditView is a memory edit for its owner.
type EditView struct {
	ID        int64     `json:"id"`
	Scope     string    `json:"scope"`
	Text      *string   `json:"text"`
	Readable  bool      `json:"readable"`
	CreatedAt time.Time `json:"created_at"`
}

// MemoryView is GET /api/v1/claudex/memory.
type MemoryView struct {
	Status
	Limits Limits     `json:"limits"`
	Docs   []DocView  `json:"docs"`
	Edits  []EditView `json:"edits"`
}

// DeleteResult answers the deletes.
type DeleteResult struct {
	DeletedDocs  int64 `json:"deleted_docs"`
	DeletedEdits int64 `json:"deleted_edits"`
}

func reason(r string) *string { return &r }

// status resolves the policy and the user's switches.
func (c *Component) status(ctx context.Context, userID int64, plan *core.PlanRef, platform string) (Status, error) {
	p, err := c.policy(ctx, userID, plan, platform)
	if err != nil {
		return Status{}, errPolicyUnavailable.WithCause(err)
	}
	p = p.normalized()
	prefs, err := c.store.prefs(ctx, userID)
	if err != nil {
		return Status{}, errStoreFailed.WithCause(err)
	}
	st := Status{
		Available: p.Enabled && c.box.CanStore(),
		Allowed:   Switches{SearchChats: p.SearchChats, Generate: p.Generate},
		Prefs:     Switches{SearchChats: p.DefaultOn, Generate: p.DefaultOn},
		Model:     p.Model,
	}
	switch {
	case !p.Enabled:
		st.Reason = reason(ReasonPolicy)
	case !c.box.CanStore():
		st.Reason = reason(ReasonServer)
	}
	if prefs != nil {
		st.PrefsSet = true
		st.Prefs = Switches{SearchChats: prefs.SearchChats, Generate: prefs.Generate}
	}
	st.Effective = Switches{
		SearchChats: p.Enabled && p.SearchChats && st.Prefs.SearchChats,
		Generate:    st.Available && p.Generate && st.Prefs.Generate,
	}
	return st, nil
}

// requestStatus is status for the signed-in user of a request.
func (c *Component) requestStatus(g *gin.Context, userID int64) (Status, error) {
	platform, _, _, _ := core.ClientInfo(g)
	return c.status(g.Request.Context(), userID, nil, platform)
}

func (c *Component) docView(d docRow) DocView {
	v := DocView{Scope: d.Scope, ContentBytes: d.ContentBytes, Revision: d.Revision, Source: d.Source,
		GeneratedAt: d.GeneratedAt, UpdatedAt: d.UpdatedAt, CreatedAt: d.CreatedAt}
	if text, err := c.box.Open(d.ContentEnc); err == nil {
		v.Content, v.Readable = &text, true
	}
	return v
}

func (c *Component) editView(e editRow) EditView {
	v := EditView{ID: e.ID, Scope: e.Scope, CreatedAt: e.CreatedAt}
	if text, err := c.box.Open(e.TextEnc); err == nil {
		v.Text, v.Readable = &text, true
	}
	return v
}

func subject(g *gin.Context) (int64, bool) {
	userID, ok := core.Subject(g)
	if !ok {
		response.ErrorFrom(g, errUnauthorized)
		return 0, false
	}
	return userID, true
}

func scopeParam(raw string) (string, error) {
	scope, ok := normalizeScope(raw)
	if !ok {
		return "", ErrBadScope
	}
	return scope, nil
}

// readJSON decodes a JSON object with only the fields of v.
func readJSON(g *gin.Context, v any) error {
	if g.Request.ContentLength > maxBodyBytes {
		return ErrTooLarge
	}
	if g.Request.Body == nil {
		return invalid("body", "json", "The request body must be a JSON object.")
	}
	raw, err := io.ReadAll(http.MaxBytesReader(g.Writer, g.Request.Body, maxBodyBytes))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return ErrTooLarge
		}
		return invalid("body", "read", "Couldn't read the request body.")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return invalid("body", "json", "The request body must be a JSON object with the documented fields.")
	}
	if dec.More() {
		return invalid("body", "json", "The request body must be a single JSON object.")
	}
	return nil
}

// GET /api/v1/claudex/memory[?scope=]
func (c *Component) getMemory(g *gin.Context) {
	userID, ok := subject(g)
	if !ok {
		return
	}
	scope := ""
	if raw, set := g.GetQuery("scope"); set {
		var err error
		if scope, err = scopeParam(raw); err != nil {
			response.ErrorFrom(g, err)
			return
		}
	}
	st, err := c.requestStatus(g, userID)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	ctx := g.Request.Context()
	docs, err := c.store.docs(ctx, userID, scope)
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	edits, err := c.store.edits(ctx, userID, scope)
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	view := MemoryView{Status: st, Limits: serverLimits, Docs: make([]DocView, 0, len(docs)), Edits: make([]EditView, 0, len(edits))}
	for _, d := range docs {
		view.Docs = append(view.Docs, c.docView(d))
	}
	for _, e := range edits {
		view.Edits = append(view.Edits, c.editView(e))
	}
	g.Header("Cache-Control", "no-store")
	response.Success(g, view)
}

// PUT /api/v1/claudex/memory/prefs {"search_chats"?: bool, "generate"?: bool}
// Fields left out keep their value. Turning a switch on that the policy does
// not allow answers 403 CLAUDEX_MEMORY_DISABLED; turning one off always works.
func (c *Component) putPrefs(g *gin.Context) {
	userID, ok := subject(g)
	if !ok {
		return
	}
	var body struct {
		SearchChats *bool `json:"search_chats"`
		Generate    *bool `json:"generate"`
	}
	if err := readJSON(g, &body); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	if body.SearchChats == nil && body.Generate == nil {
		response.ErrorFrom(g, invalid("body", "required", "Send search_chats, generate or both."))
		return
	}
	st, err := c.requestStatus(g, userID)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	next := st.Prefs
	if body.SearchChats != nil {
		if *body.SearchChats && !st.Allowed.SearchChats {
			response.ErrorFrom(g, disabledFor("search_chats"))
			return
		}
		next.SearchChats = *body.SearchChats
	}
	if body.Generate != nil {
		if *body.Generate && !st.Allowed.Generate {
			response.ErrorFrom(g, disabledFor("generate"))
			return
		}
		next.Generate = *body.Generate
	}
	if _, err := c.store.setPrefs(g.Request.Context(), userID, next.SearchChats, next.Generate); err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	st, err = c.requestStatus(g, userID)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	response.Success(g, st)
}

// PUT /api/v1/claudex/memory/docs/:scope
// {"content": "...", "source": "user|import|generated", "base_revision": 0,
// "edits_upto": 12}
// base_revision 0 creates the document; otherwise it must be the stored
// revision (409 CLAUDEX_MEMORY_CONFLICT with metadata current_revision).
// edits_upto (generated only) removes the scope's edits the synthesis folded
// in.
func (c *Component) putDoc(g *gin.Context) {
	userID, ok := subject(g)
	if !ok {
		return
	}
	scope, err := scopeParam(g.Param("scope"))
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	var body struct {
		Content      *string `json:"content"`
		Source       *string `json:"source"`
		BaseRevision *int64  `json:"base_revision"`
		EditsUpto    *int64  `json:"edits_upto"`
	}
	if err := readJSON(g, &body); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	switch {
	case body.Content == nil:
		response.ErrorFrom(g, invalid("content", "required", "content is required."))
		return
	case body.Source == nil || !validSource(*body.Source):
		response.ErrorFrom(g, invalid("source", "enum", "source must be user, import or generated."))
		return
	case body.BaseRevision == nil || *body.BaseRevision < 0:
		response.ErrorFrom(g, invalid("base_revision", "min", "base_revision must be 0 (new) or the current revision."))
		return
	case body.EditsUpto != nil && (*body.Source != SourceGenerated || *body.EditsUpto < 1):
		response.ErrorFrom(g, invalid("edits_upto", "generated", "edits_upto is only for generated memory and must be a memory edit id."))
		return
	case !utf8.ValidString(*body.Content):
		response.ErrorFrom(g, invalid("content", "utf8", "content must be valid UTF-8 text."))
		return
	case len(*body.Content) > MaxDocBytes:
		response.ErrorFrom(g, ErrTooLarge)
		return
	}
	st, err := c.requestStatus(g, userID)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	if st.Reason != nil && *st.Reason == ReasonPolicy {
		response.ErrorFrom(g, disabledFor("memory"))
		return
	}
	if *body.Source == SourceGenerated && !st.Allowed.Generate {
		response.ErrorFrom(g, disabledFor("generate"))
		return
	}
	sealed, err := c.box.Seal(*body.Content)
	if err != nil {
		response.ErrorFrom(g, sealError(err))
		return
	}
	saved, err := c.store.saveDoc(g.Request.Context(), userID, docWrite{
		Scope: scope, ContentEnc: sealed, ContentBytes: len(*body.Content), Source: *body.Source,
		BaseRevision: *body.BaseRevision, EditsUpto: body.EditsUpto, MaxScopes: MaxScopes,
	})
	if err != nil {
		response.ErrorFrom(g, writeError(err))
		return
	}
	g.Header("Cache-Control", "no-store")
	response.Success(g, c.docView(saved))
}

// DELETE /api/v1/claudex/memory/docs/:scope removes the document and the
// edits of one scope (also while the policy turned memory off).
func (c *Component) deleteDoc(g *gin.Context) {
	userID, ok := subject(g)
	if !ok {
		return
	}
	scope, err := scopeParam(g.Param("scope"))
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	docs, edits, err := c.store.deleteScope(g.Request.Context(), userID, scope)
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	response.Success(g, DeleteResult{DeletedDocs: docs, DeletedEdits: edits})
}

// DELETE /api/v1/claudex/memory (Reset memory): every document and edit of
// the user; the switches stay.
func (c *Component) deleteAll(g *gin.Context) {
	userID, ok := subject(g)
	if !ok {
		return
	}
	docs, edits, err := c.store.deleteAll(g.Request.Context(), userID)
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	response.Success(g, DeleteResult{DeletedDocs: docs, DeletedEdits: edits})
}

// POST /api/v1/claudex/memory/edits {"scope": "global", "text": "..."}
// A memory edit is one statement about the user (at most 500 characters,
// one line); anything shaped like a credential or a card number is refused
// (422 CLAUDEX_MEMORY_SENSITIVE). Needs the policy's generate switch, like
// the memory_edits tool that sends it.
func (c *Component) postEdit(g *gin.Context) {
	userID, ok := subject(g)
	if !ok {
		return
	}
	var body struct {
		Scope *string `json:"scope"`
		Text  *string `json:"text"`
	}
	if err := readJSON(g, &body); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	if body.Scope == nil {
		response.ErrorFrom(g, ErrBadScope)
		return
	}
	scope, err := scopeParam(*body.Scope)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	text := ""
	if body.Text != nil {
		text = cleanEdit(*body.Text)
	}
	switch {
	case text == "":
		response.ErrorFrom(g, invalid("text", "required", "text is required."))
		return
	case runeLen(text) > MaxEditChars:
		response.ErrorFrom(g, limitReached("edit_chars", MaxEditChars))
		return
	case looksSecret(text):
		response.ErrorFrom(g, ErrSensitive)
		return
	}
	st, err := c.requestStatus(g, userID)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	if st.Reason != nil && *st.Reason == ReasonPolicy {
		response.ErrorFrom(g, disabledFor("memory"))
		return
	}
	if !st.Allowed.Generate {
		response.ErrorFrom(g, disabledFor("generate"))
		return
	}
	sealed, err := c.box.Seal(text)
	if err != nil {
		response.ErrorFrom(g, sealError(err))
		return
	}
	saved, err := c.store.addEdit(g.Request.Context(), userID, editWrite{
		Scope: scope, TextEnc: sealed, TextBytes: len(text), DeviceID: c.deviceID(g, userID),
		MaxPerScope: MaxEditsPerScope, MaxScopes: MaxScopes,
	})
	if err != nil {
		response.ErrorFrom(g, writeError(err))
		return
	}
	v := c.editView(saved)
	if v.Text == nil { // sealed a moment ago; answer what was stored
		v.Text, v.Readable = &text, true
	}
	g.Header("Cache-Control", "no-store")
	response.Created(g, v)
}

// DELETE /api/v1/claudex/memory/edits/:id (only the user's own edits).
func (c *Component) deleteEdit(g *gin.Context) {
	userID, ok := subject(g)
	if !ok {
		return
	}
	id, err := strconv.ParseInt(strings.TrimSpace(g.Param("id")), 10, 64)
	if err != nil || id <= 0 {
		response.ErrorFrom(g, ErrEditNotFound)
		return
	}
	deleted, err := c.store.deleteEdit(g.Request.Context(), userID, id)
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	if !deleted {
		response.ErrorFrom(g, ErrEditNotFound)
		return
	}
	response.Success(g, DeleteResult{DeletedEdits: 1})
}

// deviceID is the claudex_devices id of the request's X-Claudex-Device-Id
// (nil when unknown): memory edits remember which device wrote them.
func (c *Component) deviceID(g *gin.Context, userID int64) *int64 {
	_, _, _, raw := core.ClientInfo(g)
	if raw == "" || c.env == nil || c.env.Peers.Devices == nil {
		return nil
	}
	ref, ok := c.env.Peers.Devices.LookupByDeviceID(g.Request.Context(), userID, raw)
	if !ok || ref == nil || ref.UserID != userID || ref.ID <= 0 {
		return nil
	}
	id := ref.ID
	return &id
}

func sealError(err error) error {
	if errors.Is(err, core.ErrSecretKeyMissing) {
		return ErrEncryptionKeyMissing
	}
	return errStoreFailed.WithCause(err)
}

func writeError(err error) error {
	var conflictErr *conflictError
	switch {
	case errors.As(err, &conflictErr):
		return conflict(conflictErr.Current)
	case errors.Is(err, errScopeLimit):
		return limitReached("scopes", MaxScopes)
	case errors.Is(err, errEditLimit):
		return limitReached("edits_per_scope", MaxEditsPerScope)
	case infraerrors.Code(err) != http.StatusInternalServerError && infraerrors.Reason(err) != "":
		return err
	default:
		return errStoreFailed.WithCause(err)
	}
}
