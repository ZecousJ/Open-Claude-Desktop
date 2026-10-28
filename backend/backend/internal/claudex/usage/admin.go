package usage

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
)

// Administrator endpoints under /api/v1/admin/claudex (admin auth, rate
// limit, audit log, compliance guard; writes behind step-up).

const maxRuleBodyBytes = 64 << 10

var errNotSignedIn = infraerrors.Unauthorized("UNAUTHORIZED", "Sign in first.")

// optionalID is a JSON id that tells "absent" from null.
type optionalID struct {
	set   bool
	value *int64
}

func (o *optionalID) UnmarshalJSON(b []byte) error {
	o.set = true
	if bytes.Equal(bytes.TrimSpace(b), []byte("null")) {
		o.value = nil
		return nil
	}
	var v int64
	if err := json.Unmarshal(b, &v); err != nil {
		return fieldTypeError{field: "group"}
	}
	o.value = &v
	return nil
}

// fieldTypeError reports a body field of the wrong type from a custom
// decoder (encoding/json does not add the field name to those errors).
type fieldTypeError struct{ field string }

func (e fieldTypeError) Error() string { return "field " + e.field + " has the wrong type" }

// ruleInput is the body of POST /usage-rules and PUT /usage-rules/:id. On
// PUT, fields that are absent keep their stored value.
type ruleInput struct {
	GroupID       optionalID `json:"group_id"`
	Kind          *string    `json:"kind"`
	Label         *string    `json:"label"`
	ModelPatterns *[]string  `json:"model_patterns"`
	WindowSeconds *int       `json:"window_seconds"`
	LimitUSD      *float64   `json:"limit_usd"`
	Enabled       *bool      `json:"enabled"`
	ShowInClient  *bool      `json:"show_in_client"`
	SortOrder     *int       `json:"sort_order"`
}

func (in ruleInput) apply(f *ruleFields) {
	if in.GroupID.set {
		f.GroupID = in.GroupID.value
	}
	if in.Kind != nil {
		f.Kind = *in.Kind
	}
	if in.Label != nil {
		f.Label = *in.Label
	}
	if in.ModelPatterns != nil {
		f.ModelPatterns = append([]string(nil), (*in.ModelPatterns)...)
	}
	if in.WindowSeconds != nil {
		f.WindowSeconds = *in.WindowSeconds
	}
	if in.LimitUSD != nil {
		f.LimitUSD = *in.LimitUSD
	}
	if in.Enabled != nil {
		f.Enabled = *in.Enabled
	}
	if in.ShowInClient != nil {
		f.ShowInClient = *in.ShowInClient
	}
	if in.SortOrder != nil {
		f.SortOrder = *in.SortOrder
	}
}

// jsonFieldNames maps body fields to the "field" metadata of
// CLAUDEX_USAGE_RULE_INVALID.
var jsonFieldNames = map[string]string{
	"group_id": "group", "model_patterns": "patterns", "window_seconds": "window", "limit_usd": "limit",
}

func decodeRuleInput(g *gin.Context) (ruleInput, error) {
	var in ruleInput
	body, err := io.ReadAll(io.LimitReader(g.Request.Body, maxRuleBodyBytes+1))
	if err != nil {
		return in, invalidRule("body", "read", "Could not read the request body.")
	}
	if len(body) > maxRuleBodyBytes {
		return in, invalidRule("body", "size", "The request body is too large.")
	}
	if err := json.Unmarshal(body, &in); err != nil {
		var fieldErr fieldTypeError
		if errors.As(err, &fieldErr) {
			return in, invalidRule(fieldErr.field, "type", "Field "+fieldErr.field+" has the wrong type.")
		}
		var typeErr *json.UnmarshalTypeError
		if errors.As(err, &typeErr) && typeErr.Field != "" {
			field := typeErr.Field
			if i := strings.Index(field, "."); i >= 0 {
				field = field[:i]
			}
			if mapped, ok := jsonFieldNames[field]; ok {
				field = mapped
			}
			return in, invalidRule(field, "type", "Field "+typeErr.Field+" has the wrong type.")
		}
		return in, invalidRule("body", "json", "The request body must be a JSON object.")
	}
	return in, nil
}

func pathID(g *gin.Context, name string) (int64, bool) {
	id, err := strconv.ParseInt(strings.TrimSpace(g.Param(name)), 10, 64)
	return id, err == nil && id > 0
}

// adminList answers GET /usage-rules?group_id= with every rule (or those of
// one group) and this node's counter health.
func (c *Component) adminList(g *gin.Context) {
	var groupID *int64
	if raw := strings.TrimSpace(g.Query("group_id")); raw != "" {
		id, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || id <= 0 {
			response.ErrorFrom(g, invalidRule("group", "positive", "group_id must be a positive number."))
			return
		}
		groupID = &id
	}
	rules, err := c.store.listRules(g.Request.Context(), groupID)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	response.Success(g, gin.H{"items": rules, "counter_health": c.Metrics()})
}

func (c *Component) adminCreate(g *gin.Context) {
	in, err := decodeRuleInput(g)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	f := ruleFields{Enabled: true, ShowInClient: true}
	in.apply(&f)
	if in.Kind == nil {
		response.ErrorFrom(g, invalidRule("kind", "required", "Kind is required: session, all_models or models."))
		return
	}
	if err := c.validateFields(g, &f); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	var createdBy *int64
	if uid, ok := core.Subject(g); ok {
		createdBy = &uid
	}
	id, err := c.store.createRule(g.Request.Context(), f, createdBy)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	c.rules.invalidate()
	c.writeRule(g, id)
}

func (c *Component) adminUpdate(g *gin.Context) {
	id, ok := pathID(g, "id")
	if !ok {
		response.ErrorFrom(g, ErrRuleNotFound)
		return
	}
	in, err := decodeRuleInput(g)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	current, err := c.store.getRule(g.Request.Context(), id)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	f := ruleFields{
		GroupID: current.GroupID, Kind: current.Kind, Label: current.Label, ModelPatterns: current.ModelPatterns,
		WindowSeconds: current.WindowSeconds, LimitUSD: current.LimitUSD, Enabled: current.Enabled,
		ShowInClient: current.ShowInClient, SortOrder: current.SortOrder,
	}
	kindChanged := in.Kind != nil && strings.TrimSpace(*in.Kind) != current.Kind
	in.apply(&f)
	if kindChanged && in.ModelPatterns == nil {
		// Switching between "every model" and per-model rules needs new
		// patterns; the stored ["*"] never carries over to a models rule.
		f.ModelPatterns = nil
		if in.Label == nil && current.Kind != KindModels {
			f.Label = ""
		}
	}
	if err := c.validateFields(g, &f); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	if err := c.store.updateRule(g.Request.Context(), id, f); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	c.rules.invalidate()
	c.writeRule(g, id)
}

func (c *Component) validateFields(g *gin.Context, f *ruleFields) error {
	if err := f.normalizeAndValidate(); err != nil {
		return err
	}
	if f.GroupID != nil {
		ok, err := c.store.groupExists(g.Request.Context(), *f.GroupID)
		if err != nil {
			return err
		}
		if !ok {
			return ErrGroupMissing
		}
	}
	return nil
}

func (c *Component) writeRule(g *gin.Context, id int64) {
	rule, err := c.store.getRule(g.Request.Context(), id)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	response.Success(g, rule)
}

func (c *Component) adminDelete(g *gin.Context) {
	id, ok := pathID(g, "id")
	if !ok {
		response.ErrorFrom(g, ErrRuleNotFound)
		return
	}
	if err := c.store.deleteRule(g.Request.Context(), id); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	c.rules.invalidate()
	response.Success(g, gin.H{"deleted": true})
}

// counterItem is one row of GET /usage-rules/:id/counters.
type counterItem struct {
	UserID       int64     `json:"user_id"`
	UserEmail    *string   `json:"user_email"`
	WindowStart  time.Time `json:"window_start"`
	WindowEnd    time.Time `json:"window_end"`
	UsedUSD      float64   `json:"used_usd"`
	RequestCount int64     `json:"request_count"`
	UpdatedAt    time.Time `json:"updated_at"`
	Active       bool      `json:"active"`
}

func (c *Component) adminCounters(g *gin.Context) {
	id, ok := pathID(g, "id")
	if !ok {
		response.ErrorFrom(g, ErrRuleNotFound)
		return
	}
	var userID *int64
	if raw := strings.TrimSpace(g.Query("user_id")); raw != "" {
		uid, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || uid <= 0 {
			response.ErrorFrom(g, invalidRule("user_id", "positive", "user_id must be a positive number."))
			return
		}
		userID = &uid
	}
	ctx := g.Request.Context()
	if _, err := c.store.getRule(ctx, id); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	page, pageSize := response.ParsePagination(g)
	if pageSize > 200 {
		pageSize = 200
	}
	rows, total, err := c.store.listCounters(ctx, id, userID, pageSize, (page-1)*pageSize)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	now := c.now()
	items := make([]counterItem, 0, len(rows))
	for _, r := range rows {
		items = append(items, counterItem{
			UserID: r.UserID, UserEmail: r.UserEmail, WindowStart: r.WindowStart.UTC(), WindowEnd: r.WindowEnd.UTC(),
			UsedUSD: roundUSD(r.UsedUSD), RequestCount: r.RequestCount, UpdatedAt: r.UpdatedAt.UTC(),
			Active: r.WindowEnd.After(now),
		})
	}
	response.Paginated(g, items, total, page, pageSize)
}

func (c *Component) adminReset(g *gin.Context) {
	id, ok := pathID(g, "id")
	if !ok {
		response.ErrorFrom(g, ErrRuleNotFound)
		return
	}
	var body struct {
		UserID int64 `json:"user_id"`
	}
	raw, err := io.ReadAll(io.LimitReader(g.Request.Body, 4<<10))
	if err != nil || json.Unmarshal(raw, &body) != nil || body.UserID <= 0 {
		response.ErrorFrom(g, invalidRule("user_id", "required", "user_id must be a positive number."))
		return
	}
	ctx := g.Request.Context()
	if _, err := c.store.getRule(ctx, id); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	if err := c.store.resetCounter(ctx, id, body.UserID); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	response.Success(g, gin.H{"reset": true})
}

// adminUserStatus answers GET /users/:user_id/usage-status?group_id= with the
// user endpoint's body, for an administrator looking at a user.
func (c *Component) adminUserStatus(g *gin.Context) {
	userID, ok := pathID(g, "user_id")
	if !ok {
		response.ErrorFrom(g, ErrUserMissing)
		return
	}
	ctx := g.Request.Context()
	u, err := c.sources.user(ctx, userID)
	switch {
	case errors.Is(err, service.ErrUserNotFound) || (err == nil && u == nil):
		response.ErrorFrom(g, ErrUserMissing)
		return
	case err != nil:
		response.ErrorFrom(g, err)
		return
	}
	st, err := c.status(ctx, userID, queryGroupID(g), "")
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	g.Header("Cache-Control", "no-store")
	response.Success(g, st)
}
