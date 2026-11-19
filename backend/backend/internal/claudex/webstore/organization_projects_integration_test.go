//go:build integration

package webstore

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestOrganizationProjectSharing(t *testing.T) {
	c := newIT(t, 0, 0)
	actors := users(t, 6)
	owner, editor, viewer, member, admin, outsider := actors[0], actors[1], actors[2], actors[3], actors[4], actors[5]
	org, otherOrg := uuid.NewString(), uuid.NewString()
	_, err := itDB.Exec(`INSERT INTO claudex_plugin_organizations (id, name) VALUES ($1, 'Sharing team'), ($2, 'Other team')`, org, otherOrg)
	require.NoError(t, err)
	_, err = itDB.Exec(`INSERT INTO claudex_plugin_organization_members (organization_id, user_id, role) VALUES
	($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'member'), ($1, $6, 'member'), ($1, $7, 'admin'),
	($2, $8, 'admin'), ($2, $4, 'member')`, org, otherOrg, owner, editor, viewer, member, admin, outsider)
	require.NoError(t, err)

	r := gin.New()
	r.Use(func(g *gin.Context) {
		var id int64
		if _, err := fmt.Sscan(g.GetHeader("Fixture-Actor"), &id); err == nil {
			g.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: id})
		}
		g.Next()
	})
	c.RegisterUserRoutes(r.Group("/api/v1/claudex"))

	base := "/api/v1/claudex/project-organizations"
	request := func(actor int64, method, path, body string, want int) json.RawMessage {
		t.Helper()
		req := httptest.NewRequest(method, base+path, strings.NewReader(body))
		if actor != 0 {
			req.Header.Set("Fixture-Actor", fmt.Sprint(actor))
		}
		res := httptest.NewRecorder()
		r.ServeHTTP(res, req)
		require.Equal(t, want, res.Code, "%s %s: %s", method, path, res.Body.String())
		var envelope struct {
			Data json.RawMessage `json:"data"`
		}
		require.NoError(t, json.Unmarshal(res.Body.Bytes(), &envelope))
		return envelope.Data
	}
	var workspaces []projectOrganization
	request(0, http.MethodGet, "", "", http.StatusUnauthorized)
	require.NoError(t, json.Unmarshal(request(editor, http.MethodGet, "", "", http.StatusOK), &workspaces))
	require.Len(t, workspaces, 2)
	require.Equal(t, org, workspaces[1].ID)
	require.True(t, workspaces[1].PublicProjectsEnabled)

	memberPath := "/" + org + "/members"
	var page projectOrganizationMembersPage
	require.NoError(t, json.Unmarshal(request(owner, http.MethodGet, memberPath+"?q=user&limit=1", "", http.StatusOK), &page))
	require.Len(t, page.Members, 1)
	require.Equal(t, 1, *page.NextOffset)
	var email string
	require.NoError(t, itDB.QueryRow("SELECT email FROM users WHERE id=$1", viewer).Scan(&email))
	require.NoError(t, json.Unmarshal(request(owner, http.MethodGet, memberPath+"?emails="+strings.ToUpper(email), "", http.StatusOK), &page))
	require.Len(t, page.Members, 1)
	require.Equal(t, viewer, page.Members[0].UserID)
	request(outsider, http.MethodGet, memberPath, "", http.StatusNotFound)

	projectBase := "/" + org + "/projects"
	creationID := uuid.NewString()
	create := fmt.Sprintf(`{"name":"Draft contract","starred":true,"clientCreationId":%q}`, creationID)
	var created, replay ProjectShareAccess
	require.NoError(t, json.Unmarshal(request(owner, http.MethodPost, projectBase, create, http.StatusCreated), &created))
	require.Equal(t, creationID, created.ID)
	require.True(t, created.Starred)
	require.NoError(t, json.Unmarshal(request(owner, http.MethodPost, projectBase, create, http.StatusCreated), &replay))
	require.Equal(t, created, replay)
	request(owner, http.MethodPost, projectBase,
		fmt.Sprintf(`{"name":"Different project","clientCreationId":%q}`, creationID), http.StatusConflict)
	request(owner, http.MethodDelete, projectBase+"/"+creationID, "", http.StatusOK)
	var project ProjectShareAccess
	require.NoError(t, json.Unmarshal(request(owner, http.MethodPost, projectBase, `{"name":"Release","instructions":"Initial notes"}`, http.StatusCreated), &project))
	require.Equal(t, owner, project.Creator.UserID)
	require.Equal(t, ProjectRoleOwner, project.Role)
	require.Equal(t, ProjectRoleNone, project.AudienceRole)
	detail := projectBase + "/" + project.ID
	resolve := "/resolve/" + project.ID
	request(admin, http.MethodGet, detail, "", http.StatusNotFound)
	request(viewer, http.MethodGet, resolve, "", http.StatusNotFound)
	request(editor, http.MethodGet, "/"+otherOrg+"/projects/"+project.ID, "", http.StatusNotFound)
	require.JSONEq(t, `[]`, string(request(viewer, http.MethodGet, projectBase, "", http.StatusOK)))

	payload := fmt.Sprintf(`{"targets":[%q,%d],"role":"view"}`, strings.ToUpper(email), outsider)
	request(owner, http.MethodPost, detail+"/accounts_bulk", payload, http.StatusNotFound)
	request(viewer, http.MethodGet, resolve, "", http.StatusNotFound)
	payload = fmt.Sprintf(`{"targets":[%q,%d],"role":"view"}`, strings.ToUpper(email), editor)
	request(owner, http.MethodPost, detail+"/accounts_bulk", payload, http.StatusOK)
	view, err := c.ShareAccess(context.Background(), viewer, org, project.ID)
	require.NoError(t, err)
	require.True(t, view.CanChat())
	require.False(t, view.CanEditContent())
	require.Equal(t, ProjectRoleView, view.DirectRole)
	request(viewer, http.MethodPatch, detail, `{"instructions":"Changed"}`, http.StatusForbidden)
	request(viewer, http.MethodPut, fmt.Sprintf("%s/accounts/%d", detail, member), `{"role":"view"}`, http.StatusForbidden)
	request(viewer, http.MethodPatch, detail, `{"starred":true}`, http.StatusOK)
	require.NoError(t, json.Unmarshal(request(viewer, http.MethodGet, resolve, "", http.StatusOK), &view))
	require.True(t, view.Starred)
	require.NoError(t, json.Unmarshal(request(owner, http.MethodGet, detail, "", http.StatusOK), &project))
	require.False(t, project.Starred)

	editorAccount := fmt.Sprintf("%s/accounts/%d", detail, editor)
	request(owner, http.MethodPut, editorAccount, `{"role":"user"}`, http.StatusOK)
	request(editor, http.MethodPatch, detail, `{"instructions":"Shared notes","audienceRole":"view"}`, http.StatusOK)
	var teamViewer ProjectShareAccess
	require.NoError(t, json.Unmarshal(request(member, http.MethodGet, resolve, "", http.StatusOK), &teamViewer))
	require.Equal(t, "Shared notes", teamViewer.Instructions)
	require.Equal(t, ProjectRoleView, teamViewer.Role)
	require.Equal(t, ProjectRoleNone, teamViewer.DirectRole)
	request(editor, http.MethodPatch, detail, `{"name":"Changed"}`, http.StatusForbidden)
	request(editor, http.MethodPatch, detail, `{"archived":true}`, http.StatusForbidden)
	request(editor, http.MethodDelete, detail, "", http.StatusForbidden)

	var accounts []projectShareAccount
	require.NoError(t, json.Unmarshal(request(viewer, http.MethodGet, detail+"/accounts", "", http.StatusOK), &accounts))
	require.Len(t, accounts, 3)
	require.Equal(t, owner, accounts[0].UserID)
	require.Equal(t, ProjectRoleOwner, accounts[0].Role)
	request(editor, http.MethodPut, fmt.Sprintf("%s/accounts/%d", detail, owner), `{"role":"none"}`, http.StatusForbidden)

	policyPath := "/" + org + "/policy"
	request(owner, http.MethodPut, policyPath, `{"publicProjectsEnabled":false}`, http.StatusForbidden)
	require.JSONEq(t, `{"sharingEnabled":true,"publicProjectsEnabled":false}`,
		string(request(admin, http.MethodPut, policyPath, `{"publicProjectsEnabled":false}`, http.StatusOK)))
	request(member, http.MethodGet, resolve, "", http.StatusNotFound)
	request(viewer, http.MethodGet, resolve, "", http.StatusOK)
	request(owner, http.MethodPost, projectBase, `{"name":"Denied","audienceRole":"view"}`, http.StatusForbidden)
	request(owner, http.MethodPatch, detail, `{"audienceRole":"user"}`, http.StatusForbidden)
	memberAccount := fmt.Sprintf("%s/accounts/%d", detail, member)
	request(editor, http.MethodPut, memberAccount, `{"role":"view"}`, http.StatusOK)

	require.JSONEq(t, `{"sharingEnabled":true,"publicProjectsEnabled":true}`,
		string(request(admin, http.MethodPut, policyPath, `{"publicProjectsEnabled":true}`, http.StatusOK)))
	request(owner, http.MethodPatch, detail, `{"audienceRole":"user"}`, http.StatusOK)
	require.NoError(t, json.Unmarshal(request(viewer, http.MethodGet, resolve, "", http.StatusOK), &view))
	require.Equal(t, ProjectRoleUser, view.Role)
	require.Equal(t, ProjectRoleView, view.DirectRole)
	request(owner, http.MethodPut, memberAccount, `{"role":"none"}`, http.StatusOK)

	require.JSONEq(t, `{"sharingEnabled":false,"publicProjectsEnabled":false}`,
		string(request(admin, http.MethodPut, policyPath, `{"sharingEnabled":false}`, http.StatusOK)))
	request(member, http.MethodGet, resolve, "", http.StatusNotFound)
	request(editor, http.MethodPut, memberAccount, `{"role":"view"}`, http.StatusForbidden)
	viewerAccount := fmt.Sprintf("%s/accounts/%d", detail, viewer)
	request(editor, http.MethodPut, viewerAccount, `{"role":"user"}`, http.StatusOK)
	request(viewer, http.MethodPatch, detail, `{"instructions":"Revised notes"}`, http.StatusOK)
	request(editor, http.MethodPut, viewerAccount, `{"role":"none"}`, http.StatusOK)
	request(viewer, http.MethodGet, resolve, "", http.StatusNotFound)

	_, err = itDB.Exec("DELETE FROM claudex_plugin_organization_members WHERE organization_id=$1 AND user_id=$2", org, editor)
	require.NoError(t, err)
	request(editor, http.MethodGet, resolve, "", http.StatusNotFound)
	_, err = itDB.Exec("INSERT INTO claudex_plugin_organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member')", org, editor)
	require.NoError(t, err)
	request(editor, http.MethodGet, resolve, "", http.StatusNotFound)

	ctx := context.Background()
	personal := json.RawMessage(fmt.Sprintf(`{"id":%q,"name":"Personal","instructions":""}`, project.ID))
	require.Error(t, c.store.putProject(ctx, owner, project.ID, 0, personal, c.Limits(ctx)))
	_, err = c.store.deleteProject(ctx, owner, project.ID, true)
	require.NoError(t, err)
	require.NoError(t, c.store.putProject(ctx, viewer, project.ID, 0, personal, c.Limits(ctx)))
	rows, _, err := c.store.listProjects(ctx, owner, "")
	require.NoError(t, err)
	require.Empty(t, rows)
	rows, _, err = c.store.listProjects(ctx, viewer, "")
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.JSONEq(t, string(personal), string(rows[0]))
	require.Positive(t, usageNow(t, c, owner).DocBytes)
	require.NoError(t, json.Unmarshal(request(owner, http.MethodPatch, detail, `{"archived":true}`, http.StatusOK), &project))
	require.NotNil(t, project.ArchivedAt)
	require.Equal(t, "Revised notes", project.Instructions)
	request(owner, http.MethodDelete, detail, "", http.StatusOK)
	request(owner, http.MethodGet, resolve, "", http.StatusNotFound)
	require.Zero(t, usageNow(t, c, owner).DocBytes)
	rows, _, err = c.store.listProjects(ctx, viewer, "")
	require.NoError(t, err)
	require.Len(t, rows, 1)
}
