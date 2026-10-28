package sharing

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"log/slog"
	"net/http"
	"net/mail"
	"net/url"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
)

// Invited people: a conversation share can be limited to addresses the owner
// invites. Such a share has no public page. The people invited read it in
// the web app (/shared/<token>) after signing in with the invited address,
// and are told by e-mail when the server can send mail.

// AppSharePath is where the web app shows a share to an invited person.
const AppSharePath = "/shared"

const (
	maxInvitesPerShare = 50
	maxInviteEmail     = 254
	inviteBodyLimit    = 4 << 10
)

// AccessLink and AccessInvited are the two ways a share can be reached.
const (
	AccessLink    = "link"
	AccessInvited = "invited"
)

var (
	errInviteInvalid = infraerrors.BadRequest("CLAUDEX_SHARE_INVITE_INVALID", "Enter a valid e-mail address.")
	errInviteSelf    = infraerrors.BadRequest("CLAUDEX_SHARE_INVITE_SELF", "You already own this chat.")
	errInviteLimit   = infraerrors.Conflict("CLAUDEX_SHARE_INVITE_LIMIT", "A chat can be shared with up to 50 people.")
	errAccessInvalid = infraerrors.BadRequest("CLAUDEX_SHARE_ACCESS_INVALID", "access must be link or invited.")
)

// normalizeEmail lower-cases and checks an address: one plain mailbox.
func normalizeEmail(raw string) (string, bool) {
	value := strings.ToLower(strings.TrimSpace(raw))
	if value == "" || len(value) > maxInviteEmail || strings.ContainsAny(value, " \t\r\n<>,;\"") {
		return "", false
	}
	parsed, err := mail.ParseAddress(value)
	if err != nil || parsed.Address != value || parsed.Name != "" {
		return "", false
	}
	at := strings.LastIndex(value, "@")
	if at < 1 || !strings.Contains(value[at+1:], ".") || strings.HasSuffix(value, ".") {
		return "", false
	}
	return value, true
}

// invitesOf lists a share's invited addresses (empty when the read fails:
// the list is a convenience, never a reason to fail a request).
func (c *Component) invitesOf(ctx context.Context, id int64) []string {
	list, err := c.store.invites(ctx, id)
	if err != nil || list == nil {
		return []string{}
	}
	return list
}

// shareView is shareDTO with the invited people and access.
func (c *Component) shareView(ctx context.Context, r *shareRow, base string) ShareDTO {
	dto := shareDTO(r, base)
	dto.InvitedOnly = r.InvitedOnly
	dto.Invites = c.invitesOf(ctx, r.ID)
	dto.InviteRoles, _ = c.store.inviteRoles(ctx, r.ID)
	if r.Kind == KindArtifact {
		if snapshot, err := c.store.content(ctx, r.ID); err == nil && snapshot != nil && snapshot.Screenshot != "" {
			dto.ScreenshotURL = joinBase(base, sharePath(r.Token)+"/screenshot")
		}
	}
	return dto
}

// emailOf is the address of a signed-in user (lower-case), "" when unknown.
func (c *Component) emailOf(ctx context.Context, userID int64) string {
	return strings.ToLower(strings.TrimSpace(c.userEmails(ctx, []int64{userID})[userID]))
}

func (c *Component) sendMail(ctx context.Context, to, subject, body string) error {
	if c.mailer != nil {
		return c.mailer(ctx, to, subject, body)
	}
	if c.env == nil || c.env.Email == nil {
		return errors.New("no mail service")
	}
	return c.env.Email.SendEmail(ctx, to, subject, body)
}

// inviteMail is the message an invited person gets.
func inviteMail(owner, title, link string, options inviteRequest, kinds ...Kind) (subject, body string) {
	noun, nounCN, heading, fallback := "chat", "对话", "A chat was shared with you", "a chat"
	if len(kinds) > 0 && kinds[0] == KindArtifact {
		noun, nounCN, heading, fallback = "artifact", "作品", "An artifact was shared with you", "an artifact"
	}
	who := html.EscapeString(owner)
	name := html.EscapeString(title)
	if strings.TrimSpace(title) == "" {
		name = fallback
	} else {
		name = "“" + name + "”"
	}
	subject = owner + " shared " + fallback + " with you"
	// The logo comes from the service the link points at.
	site := ""
	if u, err := url.Parse(link); err == nil && u.Scheme != "" && u.Host != "" {
		site = u.Scheme + "://" + u.Host
	}
	role := map[string]string{"view": "Can view", "comment": "Can comment", "edit": "Can edit"}[options.Role]
	message := html.EscapeString(strings.TrimSpace(options.Message))
	extra := ""
	if role != "" {
		extra += `<p class="muted">Role: <strong>` + role + `</strong></p>`
	}
	if message != "" {
		extra += `<p style="white-space:pre-wrap;">` + message + `</p>`
	}
	body = service.ClaudexEmailHTML(service.ClaudexEmailLayout{
		SiteName: "Claudex",
		SiteURL:  html.EscapeString(site),
		Title:    "有人与你分享了" + nounCN + " / " + heading,
		Content: fmt.Sprintf(`<p><strong>%s</strong> 在 Claudex 上与你分享了 %s。<br><span style="color:#6b6a65;"><strong>%s</strong> shared %s with you on Claudex.</span></p>
%s
<p class="muted" style="color:#6b6a65;font-size:13px;line-height:20px;">使用这个邮箱地址登录即可查看。如果你不认识对方，可以忽略这封邮件。Sign in with this e-mail address to read it. If you don't expect this, you can ignore the message.</p>`,
			who, name, who, name, extra+service.ClaudexEmailButton(link, "打开"+nounCN+" / Open the "+noun)),
	})
	return subject, body
}

// appBase is where links to the web app point: the public base URL when the
// administrator set one, else the address the request came in on.
func (c *Component) appBase(ctx context.Context, g *gin.Context) string {
	base, _ := c.publicBase(ctx, c.setting.Cached(ctx))
	if base != "" {
		return strings.TrimRight(base, "/")
	}
	scheme := "https"
	if g.Request.TLS == nil && g.GetHeader("X-Forwarded-Proto") == "" && strings.HasPrefix(g.Request.Host, "127.") {
		scheme = "http"
	}
	if proto := g.GetHeader("X-Forwarded-Proto"); proto == "http" || proto == "https" {
		scheme = proto
	}
	return scheme + "://" + g.Request.Host
}

type accessRequest struct {
	Access string `json:"access"`
}

type inviteRequest struct {
	Email   string `json:"email"`
	Role    string `json:"role"`
	Notify  *bool  `json:"notify"`
	Message string `json:"message"`
}

func readSmallJSON(g *gin.Context, into any) error {
	raw, err := io.ReadAll(http.MaxBytesReader(g.Writer, requestBody(g), inviteBodyLimit))
	if err != nil {
		return invalidShare("body", "The request body can't be read.")
	}
	if err := json.Unmarshal(raw, into); err != nil {
		return invalidShare("body", "The request must be a JSON object.")
	}
	return nil
}

// ownerShare finds the caller's live conversation share, or writes why not.
func (c *Component) ownerShare(g *gin.Context) (*shareRow, int64, bool) {
	userID, ok := core.Subject(g)
	if !ok {
		response.ErrorFrom(g, infraerrors.Unauthorized("UNAUTHORIZED", "Sign in first."))
		return nil, 0, false
	}
	id, ok := idParam(g, "id")
	if !ok || !c.hasDB() {
		response.ErrorFrom(g, ErrShareNotFound)
		return nil, 0, false
	}
	row, err := c.store.getLive(g.Request.Context(), userID, id)
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return nil, 0, false
	}
	if row == nil || row.expired(c.now()) || row.Status != StatusActive {
		response.ErrorFrom(g, ErrShareNotFound)
		return nil, 0, false
	}
	return row, userID, true
}

// PUT /api/v1/claudex/shares/:id/access {access: link|invited}
func (c *Component) putAccess(g *gin.Context) {
	row, userID, ok := c.ownerShare(g)
	if !ok {
		return
	}
	if row.Kind != KindConversation && row.Kind != KindArtifact {
		response.ErrorFrom(g, ErrShareNotFound)
		return
	}
	var req accessRequest
	if err := readSmallJSON(g, &req); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	if req.Access != AccessLink && req.Access != AccessInvited {
		response.ErrorFrom(g, errAccessInvalid)
		return
	}
	ctx := g.Request.Context()
	// Opening the public link again is publishing: the switches apply.
	if req.Access == AccessLink && row.InvitedOnly {
		if err := c.canPublish(ctx, c.setting.Cached(ctx), userID, row.Kind); err != nil {
			response.ErrorFrom(g, err)
			return
		}
	}
	updated, err := c.store.setInvitedOnly(ctx, userID, row.ID, req.Access == AccessInvited, c.now())
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	if updated == nil {
		response.ErrorFrom(g, ErrShareNotFound)
		return
	}
	base, _ := c.publicBase(ctx, c.setting.Cached(ctx))
	response.Success(g, c.shareView(ctx, updated, base))
}

// POST /api/v1/claudex/shares/:id/invites {email}
func (c *Component) postInvite(g *gin.Context) {
	row, userID, ok := c.ownerShare(g)
	if !ok {
		return
	}
	ctx := g.Request.Context()
	s := c.setting.Cached(ctx)
	if err := c.canPublish(ctx, s, userID, row.Kind); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	var req inviteRequest
	if err := readSmallJSON(g, &req); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	if req.Role != "" && req.Role != "view" && req.Role != "comment" && req.Role != "edit" {
		response.ErrorFrom(g, errInviteInvalid)
		return
	}
	if len(req.Message) > 300 {
		response.ErrorFrom(g, errInviteInvalid)
		return
	}
	email, valid := normalizeEmail(req.Email)
	if !valid {
		response.ErrorFrom(g, errInviteInvalid)
		return
	}
	owner := c.emailOf(ctx, userID)
	if owner != "" && email == owner {
		if row.Kind == KindArtifact {
			response.ErrorFrom(g, infraerrors.BadRequest("CLAUDEX_SHARE_INVITE_SELF", "You already own this artifact."))
			return
		}
		response.ErrorFrom(g, errInviteSelf)
		return
	}
	existing := c.invitesOf(ctx, row.ID)
	alreadyInvited := false
	for _, address := range existing {
		alreadyInvited = alreadyInvited || address == email
	}
	if !alreadyInvited && len(existing) >= maxInvitesPerShare {
		if row.Kind == KindArtifact {
			response.ErrorFrom(g, infraerrors.Conflict("CLAUDEX_SHARE_INVITE_LIMIT", "An artifact can be shared with up to 50 people."))
			return
		}
		response.ErrorFrom(g, errInviteLimit)
		return
	}
	added, err := c.store.addInvite(ctx, row.ID, email, c.now(), req.Role)
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	mailed := false
	if added {
		link := c.appBase(ctx, g) + AppSharePath + "/" + row.Token
		subject, body := inviteMail(owner, row.Title, link, req, row.Kind)
		// Sending can be slow (an SMTP server); the answer does not wait for
		// it, and a failure is a log line, not the person's problem: the
		// invitation stands and appears under Shared with you.
		// An account can turn off "Artifacts shared with you".
		wanted := row.Kind != KindArtifact || c.artifactMailPrefs(ctx, c.userIDOf(ctx, email)).Shares
		if (req.Notify == nil || *req.Notify) && wanted {
			go func() {
				mailCtx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
				defer cancel()
				defer func() { _ = recover() }()
				if err := c.sendMail(mailCtx, email, subject, body); err != nil {
					slog.Warn("claudex sharing: invitation e-mail not sent", "reason", err.Error())
				}
			}()
			mailed = c.canSendMail(ctx)
		}
	}
	base, _ := c.publicBase(ctx, s)
	dto := c.shareView(ctx, row, base)
	response.Success(g, gin.H{"share": dto, "added": added, "mailed": mailed})
}

// canSendMail tells whether an invitation e-mail can go out.
func (c *Component) canSendMail(ctx context.Context) bool {
	if c.mailer != nil {
		return true
	}
	if c.env == nil || c.env.Email == nil {
		return false
	}
	cfg, err := c.env.Email.GetSMTPConfig(ctx)
	return err == nil && cfg != nil && strings.TrimSpace(cfg.Host) != ""
}

// DELETE /api/v1/claudex/shares/:id/invites?email=
func (c *Component) deleteInvite(g *gin.Context) {
	row, _, ok := c.ownerShare(g)
	if !ok {
		return
	}
	ctx := g.Request.Context()
	email, valid := normalizeEmail(g.Query("email"))
	if !valid {
		response.ErrorFrom(g, errInviteInvalid)
		return
	}
	if _, err := c.store.removeInvite(ctx, row.ID, email); err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	base, _ := c.publicBase(ctx, c.setting.Cached(ctx))
	response.Success(g, c.shareView(ctx, row, base))
}

// SharedDTO is a share in an invited person's list.
type SharedDTO struct {
	Token      string    `json:"token"`
	Kind       Kind      `json:"kind"`
	Title      string    `json:"title"`
	Owner      string    `json:"owner"`
	SnapshotAt time.Time `json:"snapshot_at"`
}

// GET /api/v1/claudex/sharing/shared-with-me
func (c *Component) listSharedWithMe(g *gin.Context) {
	userID, ok := core.Subject(g)
	if !ok {
		response.ErrorFrom(g, infraerrors.Unauthorized("UNAUTHORIZED", "Sign in first."))
		return
	}
	ctx := g.Request.Context()
	items := []SharedDTO{}
	if c.hasDB() && c.setting.Cached(ctx).Enabled {
		if email := c.emailOf(ctx, userID); email != "" {
			rows, err := c.store.sharedWith(ctx, email, c.now())
			if err != nil {
				response.ErrorFrom(g, errStoreFailed.WithCause(err))
				return
			}
			for _, r := range rows {
				snapshot, err := c.store.content(ctx, r.ID)
				if err != nil || snapshot == nil {
					continue
				}
				allowed, err := c.canReadCode(ctx, r.UserID, userID, snapshot)
				if err != nil || !allowed {
					continue
				}
				owner, err := c.codeDisplayName(ctx, r.UserID, snapshot)
				if err != nil {
					continue
				}
				items = append(items, SharedDTO{Token: r.Token, Kind: r.Kind, Title: r.Title,
					Owner: owner, SnapshotAt: r.SnapshotAt.UTC()})
			}
		}
	}
	g.Header("Cache-Control", "no-store")
	response.Success(g, items)
}

// SharedContentDTO is one share shown to an invited person. Reportable: the
// administrator takes reports, so the app offers Report chat.
type SharedContentDTO struct {
	SharedDTO
	Snapshot           *Snapshot           `json:"snapshot"`
	Reportable         bool                `json:"reportable"`
	CanEdit            bool                `json:"can_edit"`
	CanComment         bool                `json:"can_comment"`
	CanRequestEdit     bool                `json:"can_request_edit"`
	EditRequestPending bool                `json:"edit_request_pending"`
	EditRequests       []EditAccessRequest `json:"edit_requests,omitempty"`
}

// sharedWithMe resolves :token to a live share the signed-in
// user may read (its own, or one the user's address is invited to). On any
// other answer it writes the error and returns nil.
func (c *Component) sharedWithMe(g *gin.Context) (*shareRow, int64) {
	userID, ok := core.Subject(g)
	if !ok {
		response.ErrorFrom(g, infraerrors.Unauthorized("UNAUTHORIZED", "Sign in first."))
		return nil, 0
	}
	ctx := g.Request.Context()
	s := c.setting.Cached(ctx)
	token := g.Param("token")
	if !s.Enabled || !ValidToken(token) || !c.hasDB() {
		response.ErrorFrom(g, ErrShareNotFound)
		return nil, 0
	}
	row, err := c.store.byToken(ctx, token)
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return nil, 0
	}
	if row == nil || row.Status != StatusActive || row.expired(c.now()) || row.AuthorGone || (row.Kind == KindConversation && !s.Conversations) || (row.Kind == KindArtifact && !s.Artifacts) {
		response.ErrorFrom(g, ErrShareNotFound)
		return nil, 0
	}
	email := c.emailOf(ctx, userID)
	snapshot, err := c.store.content(ctx, row.ID)
	if err != nil || snapshot == nil {
		response.ErrorFrom(g, ErrShareNotFound)
		return nil, 0
	}
	allowed := row.UserID == userID || (!row.InvitedOnly && (row.Kind == KindArtifact || snapshot.Mode == "code"))
	if !allowed && email != "" {
		if allowed, err = c.store.invited(ctx, row.ID, email); err != nil {
			response.ErrorFrom(g, errStoreFailed.WithCause(err))
			return nil, 0
		}
	}
	if !allowed {
		// The same answer as a share that never existed.
		response.ErrorFrom(g, ErrShareNotFound)
		return nil, 0
	}
	allowed, err = c.canReadCode(ctx, row.UserID, userID, snapshot)
	if err != nil || !allowed {
		response.ErrorFrom(g, ErrShareNotFound)
		return nil, 0
	}
	return row, userID
}

// GET /api/v1/claudex/sharing/shared-with-me/:token: the snapshot, for the
// address the signed-in user is invited with (and for the owner).
func (c *Component) getSharedWithMe(g *gin.Context) {
	row, userID := c.sharedWithMe(g)
	if row == nil {
		return
	}
	ctx := g.Request.Context()
	snapshot, err := c.store.content(ctx, row.ID)
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	if snapshot == nil {
		response.ErrorFrom(g, ErrShareNotFound)
		return
	}
	owner, err := c.codeDisplayName(ctx, row.UserID, snapshot)
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	canEdit := row.UserID == userID
	canComment := canEdit
	canRequestEdit := false
	var requests []EditAccessRequest
	pending := false
	if row.Kind == KindArtifact {
		if !canEdit {
			roles, roleErr := c.store.inviteRoles(ctx, row.ID)
			err = roleErr
			role := roles[c.emailOf(ctx, userID)]
			canEdit = artifactRoleAllows(role, "edit")
			canComment = artifactRoleAllows(role, "comment")
			canRequestEdit = role == "" && !row.InvitedOnly
			if err != nil {
				response.ErrorFrom(g, errStoreFailed.WithCause(err))
				return
			}
		}
		all, err := c.store.editAccessRequests(ctx, row.ID)
		if err != nil {
			response.ErrorFrom(g, errStoreFailed.WithCause(err))
			return
		}
		for _, request := range all {
			if row.UserID == userID && request.Status == "pending" {
				requests = append(requests, request)
			}
			if request.Email == c.emailOf(ctx, userID) && request.Status == "pending" {
				pending = true
			}
		}
	}
	g.Header("Cache-Control", "no-store")
	response.Success(g, SharedContentDTO{
		SharedDTO:  SharedDTO{Token: row.Token, Kind: row.Kind, Title: row.Title, Owner: owner, SnapshotAt: row.SnapshotAt.UTC()},
		Snapshot:   snapshot,
		Reportable: c.setting.Cached(ctx).AllowReports,
		CanEdit:    canEdit, CanComment: canComment, CanRequestEdit: canRequestEdit,
		EditRequestPending: pending, EditRequests: requests,
	})
}

// reportCategories are the categories of the live claude.ai report form
// (2026-10-12) that the form takes, lower-cased, each with the service
// reason it is filed under. Copyright, trademark, private information and
// court orders are not taken by that form, so they are not here.
var reportCategories = map[string]string{
	"child_safety":                    "illegal",
	"fraud":                           "illegal",
	"sexually_explicit_content":       "harmful",
	"non_consensual_intimate_imagery": "harmful",
	"violence_and_hate":               "harmful",
	"illegal_goods":                   "illegal",
	"defamation":                      "illegal",
	"other_illegal":                   "illegal",
	"violation_of_terms":              "other",
}

// sharedReportRequest is the body of the app's Report chat dialog.
type sharedReportRequest struct {
	Category         string `json:"category"`
	Notes            string `json:"notes"`
	ReporterName     string `json:"reporter_name"`
	ReporterEmail    string `json:"reporter_email"`
	OptOutOfTraining bool   `json:"opt_out_of_training"`
}

// POST /api/v1/claudex/sharing/shared-with-me/:token/report: someone who can
// read the share reports it (the app's Report chat). 404 as for reading it
// or when reports are off, 400 for an unknown category, 429 over 10 reports
// an hour. A second report of the same share on the same day is accepted
// and not stored again.
func (c *Component) postSharedWithMeReport(g *gin.Context) {
	row, userID := c.sharedWithMe(g)
	if row == nil {
		return
	}
	ctx := g.Request.Context()
	if !c.setting.Cached(ctx).AllowReports {
		response.ErrorFrom(g, ErrShareNotFound)
		return
	}
	if g.Request.Body == nil {
		g.Request.Body = http.NoBody
	}
	raw, err := io.ReadAll(http.MaxBytesReader(g.Writer, g.Request.Body, maxReportBodyBytes))
	if err != nil {
		response.ErrorFrom(g, invalidReport("body"))
		return
	}
	var body sharedReportRequest
	if err := json.Unmarshal(raw, &body); err != nil {
		response.ErrorFrom(g, invalidReport("body"))
		return
	}
	category := strings.ToLower(strings.TrimSpace(body.Category))
	reason, ok := reportCategories[category]
	if !ok {
		response.ErrorFrom(g, invalidReport("category"))
		return
	}
	reporter := userID
	in := reportInput{
		Reason: reason, Category: category, Detail: body.Notes,
		ReporterName: body.ReporterName, ReporterEmail: body.ReporterEmail,
		ReporterUserID: &reporter, OptOutOfTraining: body.OptOutOfTraining,
	}
	switch c.fileReport(ctx, row.ID, in, "user:"+itoa64(userID)) {
	case reportAccepted:
		response.Success(g, gin.H{"reported": true})
	case reportBadInput:
		response.ErrorFrom(g, invalidReport("body"))
	case reportLimited:
		response.ErrorFrom(g, infraerrors.TooManyRequests("CLAUDEX_RATE_LIMITED", "Too many reports. Try again later."))
	default:
		response.ErrorFrom(g, errStoreFailed)
	}
}
