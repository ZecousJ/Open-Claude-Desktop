package webstore

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

const maxProjectGrantTargets = 200

func (c *Component) registerProjectOrganizationRoutes(g *gin.RouterGroup) {
	base := g.Group("/project-organizations", requireProjectActor)
	base.GET("", c.getProjectOrganizations)
	base.GET("/resolve/:project", projectUUID("project", ErrProjectNotFound), c.getOrganizationProject)

	org := base.Group("/:org", projectUUID("org", errProjectOrganizationNotFound))
	org.GET("/projects", c.getOrganizationProjects)
	org.POST("/projects", c.postOrganizationProject)
	org.GET("/members", c.getProjectOrganizationMembers)
	org.GET("/policy", c.getProjectOrganizationPolicy)
	org.PUT("/policy", c.putProjectOrganizationPolicy)

	project := org.Group("/projects/:project", projectUUID("project", ErrProjectNotFound))
	project.GET("", c.getOrganizationProject)
	project.PATCH("", c.patchOrganizationProject)
	project.DELETE("", c.removeOrganizationProject)
	project.GET("/accounts", c.getOrganizationProjectAccounts)
	project.PUT("/accounts/:target", c.putOrganizationProjectAccount)
	project.POST("/accounts_bulk", c.postOrganizationProjectAccounts)
	c.registerProjectShareKnowledgeRoutes(project)
}

func requireProjectActor(g *gin.Context) {
	g.Header("Cache-Control", "private, no-store")
	if _, ok := core.Subject(g); !ok {
		response.Unauthorized(g, "Sign in to continue.")
		g.Abort()
		return
	}
	g.Next()
}

func projectUUID(param string, notFound error) gin.HandlerFunc {
	return func(g *gin.Context) {
		id, err := uuid.Parse(g.Param(param))
		if err != nil {
			response.ErrorFrom(g, notFound)
			g.Abort()
			return
		}
		for i := range g.Params {
			if g.Params[i].Key == param {
				g.Params[i].Value = id.String()
				break
			}
		}
		g.Next()
	}
}

func writeOrganizationProjectResponse(g *gin.Context, data any, err error) {
	if err == nil {
		response.Success(g, data)
		return
	}
	var op *OpError
	if errors.As(err, &op) {
		switch op.Code {
		case webproto.ErrCodeBadRequest:
			err = infraerrors.BadRequest(op.Code, op.Message)
		case webproto.ErrCodeQuotaExceeded, webproto.ErrCodeTooLarge:
			err = infraerrors.New(http.StatusRequestEntityTooLarge, op.Code, op.Message)
		}
	}
	response.ErrorFrom(g, err)
}

func decodeProjectRequest(g *gin.Context, body any, maxBytes int64) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(g.Writer, g.Request.Body, maxBytes))
	decoder.DisallowUnknownFields()
	err := decoder.Decode(body)
	if err == nil {
		var trailing json.RawMessage
		err = decoder.Decode(&trailing)
		if err == io.EOF {
			return true
		}
	}
	var tooBig *http.MaxBytesError
	if errors.As(err, &tooBig) {
		writeOrganizationProjectResponse(g, nil, tooLarge("project request"))
	} else {
		response.BadRequest(g, "Enter a valid project request.")
	}
	return false
}

func (c *Component) getProjectOrganizations(g *gin.Context) {
	actor, _ := core.Subject(g)
	orgs, err := c.store.projectOrganizations(g.Request.Context(), actor)
	writeOrganizationProjectResponse(g, orgs, err)
}

func (c *Component) getOrganizationProjects(g *gin.Context) {
	actor, _ := core.Subject(g)
	projects, err := c.store.listOrganizationProjects(g.Request.Context(), actor, g.Param("org"))
	writeOrganizationProjectResponse(g, projects, err)
}

func (c *Component) getOrganizationProject(g *gin.Context) {
	actor, _ := core.Subject(g)
	project, err := c.ShareAccess(g.Request.Context(), actor, g.Param("org"), g.Param("project"))
	writeOrganizationProjectResponse(g, project, err)
}

func (c *Component) postOrganizationProject(g *gin.Context) {
	var body organizationProjectCreate
	if !decodeProjectRequest(g, &body, projectBytes) {
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	if body.Name == "" {
		response.BadRequest(g, "Enter a project name.")
		return
	}
	if body.ClientCreationID != "" {
		id, err := uuid.Parse(body.ClientCreationID)
		if err != nil || !strings.EqualFold(id.String(), body.ClientCreationID) {
			response.BadRequest(g, "Enter a valid project creation ID.")
			return
		}
		body.ClientCreationID = id.String()
	}
	if body.AudienceRole == "" {
		body.AudienceRole = ProjectRoleNone
	}
	if !body.AudienceRole.isGrant() {
		response.BadRequest(g, "Enter a valid project role.")
		return
	}
	actor, _ := core.Subject(g)
	ctx := g.Request.Context()
	project, err := c.store.createOrganizationProject(ctx, actor, g.Param("org"), body, c.Limits(ctx))
	if err != nil {
		writeOrganizationProjectResponse(g, nil, err)
		return
	}
	response.Created(g, project)
}

func (c *Component) patchOrganizationProject(g *gin.Context) {
	var body organizationProjectPatch
	if !decodeProjectRequest(g, &body, projectBytes) {
		return
	}
	if body.Name != nil {
		*body.Name = strings.TrimSpace(*body.Name)
		if *body.Name == "" {
			response.BadRequest(g, "Enter a project name.")
			return
		}
	}
	if body.AudienceRole != nil && !body.AudienceRole.isGrant() {
		response.BadRequest(g, "Enter a valid project role.")
		return
	}
	actor, _ := core.Subject(g)
	ctx := g.Request.Context()
	project, err := c.store.updateOrganizationProject(ctx, actor, g.Param("org"), g.Param("project"), body, c.now(), c.Limits(ctx))
	if project == nil {
		writeOrganizationProjectResponse(g, nil, err)
		return
	}
	writeOrganizationProjectResponse(g, project, err)
}

func (c *Component) removeOrganizationProject(g *gin.Context) {
	actor, _ := core.Subject(g)
	err := c.store.deleteOrganizationProject(g.Request.Context(), actor, g.Param("org"), g.Param("project"))
	writeOrganizationProjectResponse(g, nil, err)
}

func (c *Component) getProjectOrganizationPolicy(g *gin.Context) {
	actor, _ := core.Subject(g)
	org, err := c.store.projectOrganization(g.Request.Context(), actor, g.Param("org"))
	writeOrganizationProjectResponse(g, org.projectOrganizationPolicy, err)
}

func (c *Component) putProjectOrganizationPolicy(g *gin.Context) {
	var body projectPolicyPatch
	if !decodeProjectRequest(g, &body, 4096) {
		return
	}
	if body.SharingEnabled == nil && body.PublicProjectsEnabled == nil {
		response.BadRequest(g, "Enter a project policy to change.")
		return
	}
	actor, _ := core.Subject(g)
	policy, err := c.store.updateProjectOrganizationPolicy(g.Request.Context(), actor, g.Param("org"), body)
	writeOrganizationProjectResponse(g, policy, err)
}

func (c *Component) getProjectOrganizationMembers(g *gin.Context) {
	limit, limitErr := strconv.Atoi(g.DefaultQuery("limit", "25"))
	offset, offsetErr := strconv.Atoi(g.DefaultQuery("offset", "0"))
	query := strings.TrimSpace(g.Query("q"))
	emails := g.QueryArray("emails")
	if limitErr != nil || offsetErr != nil || limit < 1 || limit > maxProjectGrantTargets ||
		offset < 0 || len(query) > 255 || len(emails) > maxProjectGrantTargets {
		response.BadRequest(g, "Enter a valid member search.")
		return
	}
	for i, raw := range emails {
		emails[i] = normalizeProjectEmail(raw)
		if !validProjectEmail(emails[i]) {
			response.BadRequest(g, "Enter a valid member email.")
			return
		}
	}
	actor, _ := core.Subject(g)
	page, err := c.store.projectOrganizationMembers(g.Request.Context(), actor, g.Param("org"), query, emails, offset, limit)
	writeOrganizationProjectResponse(g, page, err)
}

func (c *Component) getOrganizationProjectAccounts(g *gin.Context) {
	actor, _ := core.Subject(g)
	accounts, err := c.store.organizationProjectAccounts(g.Request.Context(), actor, g.Param("org"), g.Param("project"))
	writeOrganizationProjectResponse(g, accounts, err)
}

func (c *Component) putOrganizationProjectAccount(g *gin.Context) {
	var body struct {
		Role ProjectShareRole `json:"role"`
	}
	if !decodeProjectRequest(g, &body, 4096) {
		return
	}
	target, err := strconv.ParseInt(g.Param("target"), 10, 64)
	if err != nil || target <= 0 || !body.Role.isGrant() {
		response.BadRequest(g, "Enter a valid organization member and project role.")
		return
	}
	c.updateOrganizationProjectAccounts(g, []projectGrantTarget{{UserID: target}}, body.Role)
}

func (c *Component) postOrganizationProjectAccounts(g *gin.Context) {
	var body struct {
		Targets []json.RawMessage `json:"targets"`
		Role    ProjectShareRole  `json:"role"`
	}
	if !decodeProjectRequest(g, &body, maxProjectGrantTargets*512) {
		return
	}
	if len(body.Targets) == 0 || len(body.Targets) > maxProjectGrantTargets || !body.Role.isGrant() {
		response.BadRequest(g, "Enter valid organization members and a project role.")
		return
	}
	targets := make([]projectGrantTarget, 0, len(body.Targets))
	for _, raw := range body.Targets {
		var id int64
		if json.Unmarshal(raw, &id) == nil && id > 0 {
			targets = append(targets, projectGrantTarget{UserID: id})
			continue
		}
		var email string
		if json.Unmarshal(raw, &email) == nil {
			email = normalizeProjectEmail(email)
			if validProjectEmail(email) {
				targets = append(targets, projectGrantTarget{Email: email})
				continue
			}
		}
		response.BadRequest(g, "Enter a valid organization member ID or email.")
		return
	}
	c.updateOrganizationProjectAccounts(g, targets, body.Role)
}

func validProjectEmail(email string) bool {
	name, domain, ok := strings.Cut(email, "@")
	return ok && name != "" && domain != "" && len(email) <= 255
}

func (c *Component) updateOrganizationProjectAccounts(g *gin.Context, targets []projectGrantTarget, role ProjectShareRole) {
	actor, _ := core.Subject(g)
	err := c.store.writeOrganizationProjectGrants(g.Request.Context(), actor, g.Param("org"), g.Param("project"), targets, role)
	writeOrganizationProjectResponse(g, nil, err)
}
