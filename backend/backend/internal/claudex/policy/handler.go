package policy

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
	"golang.org/x/sync/errgroup"
)

// lookupConcurrency bounds the parallel group and user lookups of one admin
// request (up to 200 groups and 1000 users).
const lookupConcurrency = 8

var errNoSubject = infraerrors.Unauthorized("UNAUTHORIZED", "Sign in to continue.")

// GET /api/v1/claudex/policy[?group_id=N]
func (c *Component) getPolicy(g *gin.Context) {
	userID, ok := core.Subject(g)
	if !ok {
		response.ErrorFrom(g, errNoSubject)
		return
	}
	var requested *int64
	if raw := strings.TrimSpace(g.Query("group_id")); raw != "" {
		id, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || id <= 0 {
			response.ErrorFrom(g, invalid("group_id", RuleInvalidID))
			return
		}
		requested = &id
	}
	platform, _, version, _ := core.ClientInfo(g)
	ctx := g.Request.Context()
	doc := c.setting.Cached(ctx)
	res, err := c.resolveForUser(ctx, &doc, userID, requested, platform)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	if webSearchDefaultBreaksCode(platform, version) {
		res.WebSearchDefault = false
	}
	core.WriteJSONWithETag(g, res)
}

// AdminView is the answer of GET and PUT /api/v1/admin/claudex/policy.
type AdminView struct {
	Revision       int64               `json:"revision"`
	UpdatedAt      *time.Time          `json:"updated_at"`
	UpdatedBy      *int64              `json:"updated_by"`
	Defaults       Patch               `json:"defaults"`
	GroupOverrides []GroupOverrideView `json:"group_overrides"`
	UserOverrides  []UserOverrideView  `json:"user_overrides"`
	Builtin        Fields              `json:"builtin"`
	Fallbacks      Fallbacks           `json:"fallbacks"`
}

// GroupOverrideView is one group override; Deleted marks a group that no
// longer exists (its override is ignored when resolving).
type GroupOverrideView struct {
	GroupID   int64   `json:"group_id"`
	GroupName *string `json:"group_name"`
	Deleted   bool    `json:"deleted"`
	Patch     Patch   `json:"patch"`
}

// UserOverrideView is one user override; Deleted marks a user that no longer
// exists.
type UserOverrideView struct {
	UserID  int64   `json:"user_id"`
	Email   *string `json:"email"`
	Deleted bool    `json:"deleted"`
	Patch   Patch   `json:"patch"`
}

// GET /api/v1/admin/claudex/policy
func (c *Component) adminGet(g *gin.Context) {
	ctx := g.Request.Context()
	// Read the database, not the 60 s cache: an administrator edits the
	// latest revision.
	doc, _, err := c.setting.GetRaw(ctx)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	view, err := c.adminView(ctx, doc)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	response.Success(g, view)
}

// PUT /api/v1/admin/claudex/policy (step-up)
func (c *Component) adminPut(g *gin.Context) {
	ctx := g.Request.Context()
	body, err := readBody(g.Request.Body)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	upd, err := ParseUpdate(body, true)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	cur, raw, err := c.setting.GetRaw(ctx)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	if upd.Revision != cur.Revision {
		response.ErrorFrom(g, revisionConflict(cur.Revision))
		return
	}
	if err := c.checkReferences(ctx, &cur, upd, ""); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	var updatedBy *int64
	if adminID, ok := core.Subject(g); ok {
		updatedBy = &adminID
	}
	next := buildDocument(upd, cur.Revision+1, c.now(), updatedBy)
	if data, err := json.Marshal(next); err != nil || len(data) > maxPolicyBytes {
		response.ErrorFrom(g, invalid("", RuleTooLarge))
		return
	}
	saved, ok, err := c.swap(ctx, raw, next)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	if !ok {
		// Another write committed between our read and our write.
		current := cur.Revision + 1
		if latest, _, err := c.setting.GetRaw(ctx); err == nil {
			current = latest.Revision
		}
		response.ErrorFrom(g, revisionConflict(current))
		return
	}
	// config_version is on the upstream audit allowlist; "revision" is not.
	middleware.SetAuditExtra(g, map[string]any{"config_version": saved.Revision})
	view, err := c.adminView(ctx, saved)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	response.Success(g, view)
}

// PreviewResult is the answer of POST /api/v1/admin/claudex/policy/preview.
type PreviewResult struct {
	Policy Resolved `json:"policy"`
}

// POST /api/v1/admin/claudex/policy/preview
//
// With user_id the preview resolves exactly like GET /claudex/policy for that
// user (group_id is the requested group and goes through the plan resolver);
// with only group_id it applies that group's override; with neither only the
// defaults. draft is an unsaved PUT body checked like a PUT.
func (c *Component) adminPreview(g *gin.Context) {
	ctx := g.Request.Context()
	body, err := readBody(g.Request.Body)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	req, err := ParsePreview(body)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	if req.GroupID != nil {
		if err := c.requireGroup(ctx, "group_id", *req.GroupID); err != nil {
			response.ErrorFrom(g, err)
			return
		}
	}
	if req.UserID != nil {
		if err := c.requireUser(ctx, "user_id", *req.UserID); err != nil {
			response.ErrorFrom(g, err)
			return
		}
	}
	doc := c.setting.Cached(ctx)
	if req.Draft != nil {
		if err := c.checkReferences(ctx, &doc, *req.Draft, "draft"); err != nil {
			response.ErrorFrom(g, err)
			return
		}
		draft := buildDocument(*req.Draft, doc.Revision, c.now(), nil)
		if err := validateDocument(&draft); err != nil {
			response.ErrorFrom(g, err)
			return
		}
		doc = draft
	}
	var res Resolved
	if req.UserID != nil {
		res, err = c.resolveForUser(ctx, &doc, *req.UserID, req.GroupID, req.Platform)
		if err != nil {
			response.ErrorFrom(g, err)
			return
		}
	} else {
		res = doc.Resolve(req.GroupID, 0, req.Platform, c.fallbacks(ctx))
	}
	response.Success(g, PreviewResult{Policy: res})
}

// buildDocument turns a parsed update into the stored document.
func buildDocument(u Update, revision int64, now time.Time, updatedBy *int64) Document {
	at := now.UTC().Truncate(time.Second)
	d := Document{
		Version:        documentVersion,
		Revision:       revision,
		UpdatedAt:      &at,
		UpdatedBy:      updatedBy,
		Defaults:       u.Defaults,
		GroupOverrides: make(map[string]Patch, len(u.Groups)),
		UserOverrides:  make(map[string]Patch, len(u.Users)),
	}
	for _, o := range u.Groups {
		d.GroupOverrides[overrideKey(o.ID)] = o.Patch
	}
	for _, o := range u.Users {
		d.UserOverrides[overrideKey(o.ID)] = o.Patch
	}
	return d
}

// checkReferences requires every group and user an update names to exist,
// except ids the stored document already has: an override whose group or
// user was deleted since is kept (ignored when resolving, labelled Deleted in
// the console) so it never blocks saving other changes (design 1.3).
func (c *Component) checkReferences(ctx context.Context, cur *Document, u Update, prefix string) error {
	var groups, users []int64
	for _, o := range u.Groups {
		if _, stored := cur.GroupOverrides[overrideKey(o.ID)]; !stored {
			groups = append(groups, o.ID)
		}
	}
	for _, o := range u.Users {
		if _, stored := cur.UserOverrides[overrideKey(o.ID)]; !stored {
			users = append(users, o.ID)
		}
	}
	groupInfo, err := c.lookupGroups(ctx, groups)
	if err != nil {
		return err
	}
	for _, id := range groups {
		if !groupInfo[id].exists {
			return groupNotFound(join(prefix, join("group_overrides", overrideKey(id))), id)
		}
	}
	userInfo, err := c.lookupUsers(ctx, users)
	if err != nil {
		return err
	}
	for _, id := range users {
		if !userInfo[id].exists {
			return userNotFound(join(prefix, join("user_overrides", overrideKey(id))), id)
		}
	}
	return nil
}

func (c *Component) requireGroup(ctx context.Context, field string, id int64) error {
	info, err := c.lookupGroups(ctx, []int64{id})
	if err != nil {
		return err
	}
	if !info[id].exists {
		return groupNotFound(field, id)
	}
	return nil
}

func (c *Component) requireUser(ctx context.Context, field string, id int64) error {
	info, err := c.lookupUsers(ctx, []int64{id})
	if err != nil {
		return err
	}
	if !info[id].exists {
		return userNotFound(field, id)
	}
	return nil
}

func (c *Component) adminView(ctx context.Context, d Document) (AdminView, error) {
	view := AdminView{
		Revision:       d.Revision,
		UpdatedAt:      d.UpdatedAt,
		UpdatedBy:      d.UpdatedBy,
		Defaults:       d.Defaults,
		GroupOverrides: make([]GroupOverrideView, 0, len(d.GroupOverrides)),
		UserOverrides:  make([]UserOverrideView, 0, len(d.UserOverrides)),
		Builtin:        Builtin(),
		Fallbacks:      c.fallbacks(ctx),
	}
	groupIDs := sortedIDs(d.GroupOverrides)
	groups, err := c.lookupGroups(ctx, groupIDs)
	if err != nil {
		return AdminView{}, err
	}
	for _, id := range groupIDs {
		info := groups[id]
		view.GroupOverrides = append(view.GroupOverrides, GroupOverrideView{
			GroupID: id, GroupName: info.label, Deleted: !info.exists, Patch: d.GroupOverrides[overrideKey(id)],
		})
	}
	userIDs := sortedIDs(d.UserOverrides)
	users, err := c.lookupUsers(ctx, userIDs)
	if err != nil {
		return AdminView{}, err
	}
	for _, id := range userIDs {
		info := users[id]
		view.UserOverrides = append(view.UserOverrides, UserOverrideView{
			UserID: id, Email: info.label, Deleted: !info.exists, Patch: d.UserOverrides[overrideKey(id)],
		})
	}
	return view, nil
}

func sortedIDs(m map[string]Patch) []int64 {
	ids := make([]int64, 0, len(m))
	for key := range m {
		if id, ok := parseOverrideID(key); ok {
			ids = append(ids, id)
		}
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids
}

// refInfo is the result of one group or user lookup.
type refInfo struct {
	exists bool
	label  *string // group name or user email
}

var errLookupUnavailable = infraerrors.ServiceUnavailable("CLAUDEX_POLICY_LOOKUP_UNAVAILABLE",
	"Groups and users cannot be checked right now. Try again.")

func (c *Component) lookupGroups(ctx context.Context, ids []int64) (map[int64]refInfo, error) {
	if len(ids) == 0 {
		return map[int64]refInfo{}, nil
	}
	repo := c.env.GroupRepo
	if repo == nil {
		return nil, errLookupUnavailable
	}
	return lookupAll(ctx, ids, func(ctx context.Context, id int64) (refInfo, error) {
		grp, err := repo.GetByIDLite(ctx, id)
		switch {
		case errors.Is(err, service.ErrGroupNotFound) || (err == nil && grp == nil):
			return refInfo{}, nil
		case err != nil:
			return refInfo{}, err
		}
		name := grp.Name
		return refInfo{exists: true, label: &name}, nil
	})
}

func (c *Component) lookupUsers(ctx context.Context, ids []int64) (map[int64]refInfo, error) {
	if len(ids) == 0 {
		return map[int64]refInfo{}, nil
	}
	repo := c.env.UserRepo
	if repo == nil {
		return nil, errLookupUnavailable
	}
	return lookupAll(ctx, ids, func(ctx context.Context, id int64) (refInfo, error) {
		user, err := repo.GetByID(ctx, id)
		switch {
		case errors.Is(err, service.ErrUserNotFound) || (err == nil && user == nil):
			return refInfo{}, nil
		case err != nil:
			return refInfo{}, err
		}
		email := user.Email
		return refInfo{exists: true, label: &email}, nil
	})
}

// lookupAll runs fn for every id with bounded concurrency.
func lookupAll(ctx context.Context, ids []int64, fn func(context.Context, int64) (refInfo, error)) (map[int64]refInfo, error) {
	out := make(map[int64]refInfo, len(ids))
	var mu sync.Mutex
	eg, egCtx := errgroup.WithContext(ctx)
	eg.SetLimit(lookupConcurrency)
	for _, id := range ids {
		eg.Go(func() error {
			info, err := fn(egCtx, id)
			if err != nil {
				return err
			}
			mu.Lock()
			out[id] = info
			mu.Unlock()
			return nil
		})
	}
	if err := eg.Wait(); err != nil {
		return nil, err
	}
	return out, nil
}

// webSearchDefaultBreaksCode: a desktop app before 0.0.22 carries the draft's
// web search into a Code send, which its own engine then refuses ("This Web
// search control belongs to Chat and Cowork."), so it never gets the switch
// on by default.
func webSearchDefaultBreaksCode(platform, version string) bool {
	switch platform {
	case "darwin", "win32", "linux":
	default:
		return false
	}
	return version == "" || core.CompareVersions(version, "0.0.22") < 0
}
