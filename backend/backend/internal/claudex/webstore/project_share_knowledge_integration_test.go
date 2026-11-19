//go:build integration

package webstore

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestOrganizationProjectKnowledge(t *testing.T) {
	ctx := context.Background()
	people := users(t, 5)
	owner, editor, viewer, noGrant, outsider := people[0], people[1], people[2], people[3], people[4]
	orgID := uuid.NewString()
	_, err := itDB.Exec(`INSERT INTO claudex_plugin_organizations (id, name) VALUES ($1, 'Knowledge')`, orgID)
	require.NoError(t, err)
	for _, member := range people[:4] {
		_, err := itDB.Exec(`INSERT INTO claudex_plugin_organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member')`, orgID, member)
		require.NoError(t, err)
	}
	c := newIT(t, 4096, 64)
	project, err := c.store.createOrganizationProject(ctx, owner, orgID, organizationProjectCreate{Name: "Knowledge", AudienceRole: ProjectRoleNone}, c.Limits(ctx))
	require.NoError(t, err)
	other, err := c.store.createOrganizationProject(ctx, owner, orgID, organizationProjectCreate{Name: "Other project", AudienceRole: ProjectRoleNone}, c.Limits(ctx))
	require.NoError(t, err)
	for actor, role := range map[int64]ProjectShareRole{editor: ProjectRoleUser, viewer: ProjectRoleView} {
		_, err := itDB.Exec(`INSERT INTO claudex_web_project_grants (organization_id, project_id, user_id, role) VALUES ($1, $2, $3, $4)`, orgID, project.ID, actor, role)
		require.NoError(t, err)
	}
	newRouter := func(component *Component) *gin.Engine {
		r := gin.New()
		api := r.Group("/api/v1/claudex", func(g *gin.Context) {
			if actor, err := strconv.ParseInt(g.GetHeader("X-Test-Actor"), 10, 64); err == nil {
				g.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: actor})
			}
		})
		component.RegisterUserRoutes(api)
		return r
	}
	router := newRouter(c)
	request := func(actor int64, method, path, contentType string, body []byte, want int) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, "/api/v1/claudex"+path, bytes.NewReader(body))
		r.Header.Set("X-Test-Actor", strconv.FormatInt(actor, 10))
		r.Header.Set("Content-Type", contentType)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		require.Equal(t, want, w.Code, "%s %s: %s", method, path, w.Body.String())
		return w
	}
	base := "/project-organizations/" + orgID + "/projects/"
	collection := base + project.ID + "/knowledge"
	text := []byte("项目资料\nCopper orchid")
	textPath := collection + "?name=" + url.QueryEscape("资料.txt")
	binary := []byte{0, 128, 255, 3}
	binaryPath := collection + "?name=file.bin"
	request(viewer, http.MethodPost, textPath, "text/plain", text, http.StatusForbidden)
	request(noGrant, http.MethodGet, collection, "", nil, http.StatusNotFound)
	request(outsider, http.MethodGet, collection, "", nil, http.StatusNotFound)
	var doc projectKnowledgeInfo
	w := request(editor, http.MethodPost, textPath, "text/plain; charset=utf-8", text, http.StatusOK)
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &doc))
	require.Equal(t, "资料.txt", doc.File.Name)
	require.Equal(t, int64(len(text)), doc.File.Size)
	_, err = uuid.Parse(doc.File.ID)
	require.NoError(t, err)
	require.Equal(t, int64(len(text)), usageNow(t, c, owner).FileBytes)
	require.Zero(t, usageNow(t, c, editor).FileBytes)
	filePath := collection + "/" + doc.File.ID
	w = request(viewer, http.MethodGet, filePath, "", nil, http.StatusOK)
	require.Equal(t, text, w.Body.Bytes())
	require.Equal(t, "text/plain", w.Header().Get("Content-Type"))
	require.Equal(t, "private, no-store", w.Header().Get("Cache-Control"))
	w = request(viewer, http.MethodHead, filePath, "", nil, http.StatusOK)
	require.Empty(t, w.Body.Bytes())
	require.Equal(t, strconv.Itoa(len(text)), w.Header().Get("Content-Length"))
	var list projectKnowledgeList
	w = request(viewer, http.MethodGet, collection, "", nil, http.StatusOK)
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &list))
	require.Len(t, list.Files, 1)
	require.Equal(t, doc.File.ID, list.Files[0].ID)
	require.Equal(t, int64(100_000_000), list.LimitBytes)
	require.Equal(t, int64(64), list.FileLimitBytes)
	request(viewer, http.MethodPut, filePath, "text/plain", []byte("hidden edit"), http.StatusForbidden)
	request(viewer, http.MethodDelete, filePath, "", nil, http.StatusForbidden)
	request(owner, http.MethodGet, base+other.ID+"/knowledge/"+doc.File.ID, "", nil, http.StatusNotFound)
	request(owner, http.MethodGet, "/web/downloads/files/"+doc.File.ID, "", nil, http.StatusNotFound)
	require.NoError(t, c.DeleteFile(ctx, owner, doc.File.ID))
	_, err = c.WriteUpload(ctx, owner, doc.File.ID, 0, []byte("injected"))
	require.Error(t, err)
	w = request(owner, http.MethodPost, binaryPath, "application/octet-stream", binary, http.StatusOK)
	var bin projectKnowledgeInfo
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &bin))
	binPath := collection + "/" + bin.File.ID
	request(owner, http.MethodPost, binaryPath, "application/octet-stream", bytes.Repeat([]byte{1}, 65), http.StatusRequestEntityTooLarge)
	w = request(viewer, http.MethodGet, binPath, "", nil, http.StatusOK)
	require.Equal(t, binary, w.Body.Bytes())
	before := usageNow(t, c, owner)
	regularLimits := c.limits
	c.limits = func(context.Context) Limits { return Limits{QuotaBytes: before.Total(), MaxFileBytes: 64} }
	request(editor, http.MethodPut, binPath, "application/octet-stream", bytes.Repeat([]byte{1}, 5), http.StatusRequestEntityTooLarge)
	c.limits = regularLimits
	updated := []byte("updated")
	w = request(editor, http.MethodPost, textPath, "text/plain", updated, http.StatusOK)
	var replacement projectKnowledgeInfo
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &replacement))
	require.Equal(t, doc.File.ID, replacement.File.ID)
	require.Equal(t, doc.File.CreatedAt, replacement.File.CreatedAt)
	require.True(t, replacement.File.UpdatedAt.After(doc.File.UpdatedAt))
	updated = []byte("edited by id")
	w = request(editor, http.MethodPut, filePath, "", updated, http.StatusOK)
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &replacement))
	require.Equal(t, doc.File.ID, replacement.File.ID)
	require.Equal(t, doc.File.Name, replacement.File.Name)
	require.Equal(t, "text/plain", replacement.File.MIME)
	require.Equal(t, int64(len(updated)+len(binary)), usageNow(t, c, owner).FileBytes)
	var folderDocs []projectKnowledgeInfo
	for _, name := range []string{"Finance/Notes.md", "People/Notes.md"} {
		w = request(editor, http.MethodPost, collection+"?name="+url.QueryEscape(name), "text/plain", []byte(name), http.StatusOK)
		var folderDoc projectKnowledgeInfo
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &folderDoc))
		require.Equal(t, name, folderDoc.File.Name)
		folderDocs = append(folderDocs, folderDoc)
	}
	require.NotEqual(t, folderDocs[0].File.ID, folderDocs[1].File.ID)
	for _, doc := range folderDocs {
		link := collection + "/" + doc.File.ID
		w = request(viewer, http.MethodGet, link, "", nil, http.StatusOK)
		require.Equal(t, doc.File.Name, w.Body.String())
		request(editor, http.MethodDelete, link, "", nil, http.StatusNoContent)
	}
	restarted := New(&core.Env{Deps: core.Deps{DB: itDB}})
	restarted.blobs = c.blobs
	restarted.limits = c.limits
	router = newRouter(restarted)
	w = request(viewer, http.MethodGet, filePath, "", nil, http.StatusOK)
	require.Equal(t, updated, w.Body.Bytes())
	private, err := c.BeginUpload(ctx, owner, "private.txt", "text/plain", int64(len(updated)))
	require.NoError(t, err)
	_, err = c.WriteUpload(ctx, owner, private.ID, 0, updated)
	require.NoError(t, err)
	request(viewer, http.MethodGet, collection+"/"+private.ID, "", nil, http.StatusNotFound)
	w = request(owner, http.MethodGet, "/web/downloads/export", "", nil, http.StatusOK)
	archive, err := zip.NewReader(bytes.NewReader(w.Body.Bytes()), int64(w.Body.Len()))
	require.NoError(t, err)
	var exportFiles []string
	for _, file := range archive.File {
		if strings.HasPrefix(file.Name, "files/") {
			exportFiles = append(exportFiles, file.Name)
		}
	}
	require.Equal(t, []string{"files/" + private.ID + "/private.txt"}, exportFiles)
	require.NoError(t, c.DeleteFile(ctx, owner, private.ID))
	w = request(viewer, http.MethodGet, filePath, "", nil, http.StatusOK)
	require.Equal(t, updated, w.Body.Bytes())
	_, err = itDB.Exec(`DELETE FROM claudex_web_project_grants WHERE organization_id = $1 AND project_id = $2 AND user_id = $3`, orgID, project.ID, viewer)
	require.NoError(t, err)
	request(viewer, http.MethodGet, collection, "", nil, http.StatusNotFound)
	request(viewer, http.MethodGet, filePath, "", nil, http.StatusNotFound)
	request(viewer, http.MethodHead, filePath, "", nil, http.StatusNotFound)
	request(editor, http.MethodDelete, binPath, "", nil, http.StatusNoContent)
	request(editor, http.MethodGet, binPath, "", nil, http.StatusNotFound)
	require.Equal(t, int64(len(updated)), usageNow(t, c, owner).FileBytes)
	request(owner, http.MethodDelete, base+project.ID, "", nil, http.StatusOK)
	request(editor, http.MethodGet, collection, "", nil, http.StatusNotFound)
	require.Zero(t, usageNow(t, c, owner).FileBytes)

	staged := c.blobs.tmpPath(owner, projectKnowledgeTempPrefix+"abandoned")
	require.NoError(t, os.WriteFile(staged, []byte("stale upload"), 0o600))
	old := time.Now().Add(-2 * staleUpload)
	require.NoError(t, os.Chtimes(staged, old, old))
	stale, err := c.dropStaleUploads(ctx)
	require.NoError(t, err)
	require.Positive(t, stale)
	require.NoFileExists(t, staged)
}
