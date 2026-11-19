//go:build integration

package catalog

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/migrations"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestIntegrationDirectorySubmissionLifecycle(t *testing.T) {
	db := startPostgres(t)
	apply := func(name string) {
		t.Helper()
		script, err := migrations.FS.ReadFile(name)
		require.NoError(t, err)
		_, err = db.Exec(string(script))
		require.NoError(t, err)
	}
	_, err := db.Exec(`INSERT INTO users (email) VALUES ('author@example.com'), ('other@example.com')`)
	require.NoError(t, err)
	apply("claudex_0013_directory_submissions.sql")
	_, err = db.Exec(`INSERT INTO claudex_directory_submissions (id,user_id,input,status) VALUES
		('00000000-0000-4000-8000-000000000001',2,'{"kind":"mcp","slug":"existing","name":"Existing"}','approved')`)
	require.NoError(t, err)
	apply("claudex_0014_directory_publication.sql")

	r := gin.New()
	r.Use(func(g *gin.Context) {
		id := int64(2)
		if g.GetHeader("X-Actor") == "other" {
			id = 3
		}
		g.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: id})
	})
	c := New(&core.Env{Deps: core.Deps{DB: db}})
	c.RegisterUserRoutes(r.Group("/user"))
	admin := r.Group("/admin", func(g *gin.Context) {
		if actor := g.GetHeader("X-Actor"); actor != "reviewer" && actor != "reviewer-unconfirmed" {
			g.AbortWithStatus(403)
			return
		}
		g.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: 1})
	})
	c.RegisterAdminRoutes(admin, func(g *gin.Context) {
		if g.GetHeader("X-Review-Step-Up") != "confirmed" {
			g.AbortWithStatus(403)
			return
		}
		g.Next()
	})

	request := func(actor, method, path, body string, wantStatus int) *httptest.ResponseRecorder {
		t.Helper()
		w := httptest.NewRecorder()
		q := httptest.NewRequest(method, path, strings.NewReader(body))
		q.Header.Set("Content-Type", "application/json")
		q.Header.Set("X-Actor", actor)
		if actor == "reviewer" && method != "GET" {
			q.Header.Set("X-Review-Step-Up", "confirmed")
		}
		r.ServeHTTP(w, q)
		require.Equal(t, wantStatus, w.Code, "%s %s %s", method, path, w.Body.String())
		return w
	}
	ownerPath := "/user/directory/submissions"
	adminPath := "/admin/directory/submissions"
	public := func() []directorySubmission {
		w := request("other", "GET", "/user/directory", "", 200)
		require.NotContains(t, w.Body.String(), "author@example.com")
		require.NotContains(t, w.Body.String(), "primary_contact_email")
		require.NotContains(t, w.Body.String(), `"original"`)
		return decodeDirectoryData[[]directorySubmission](t, w)
	}
	statuses := func(actor, path string) []directorySubmission {
		return decodeDirectoryData[[]directorySubmission](t, request(actor, "GET", path, "", 200))
	}
	write := func(input directoryInput, submit bool) string {
		t.Helper()
		body, err := json.Marshal(map[string]any{"input": input, "submit": submit})
		require.NoError(t, err)
		return string(body)
	}
	approved := public()
	require.Len(t, approved, 1)
	require.Equal(t, "existing", approved[0].Slug)

	partial := directoryInput{Kind: "mcp", Original: json.RawMessage(`{"data":{"description":"Partial editor","remote":{"user_config":{"password":{"type":"string","title":"Test label","description":"URL field","required":true}}}},"submission_data":{}}`)}
	first := decodeDirectoryData[directorySubmission](t, request("author", "POST", ownerPath, write(partial, false), 200))
	second := decodeDirectoryData[directorySubmission](t, request("author", "POST", ownerPath, write(partial, false), 200))
	require.NotEqual(t, first.ID, second.ID)
	require.Equal(t, "draft", first.Status)
	require.JSONEq(t, string(partial.Original), string(first.Original))
	require.Empty(t, statuses("other", ownerPath))
	require.Len(t, statuses("reviewer", adminPath), 1)
	request("author", "POST", ownerPath, write(partial, true), 400)
	request("author", "DELETE", ownerPath+"/"+second.ID, "", 200)

	input := validSubmission()
	input.Kind, input.ToolsVerified, input.Tools = "mcp", true, []string{"read"}
	input.Slug, input.Email = "modern", "author@example.com"
	input.Original = json.RawMessage(`{"data":{"name":"Modern"},"submission_data":{"primary_contact_email":"author@example.com","server_snapshot":{"tools":[{"name":"read","inputSchema":{"properties":{"password":{"type":"string"}}}}]}}}`)
	path := ownerPath + "/" + first.ID
	reviewPath := adminPath + "/" + first.ID + "/review"
	publishPath := path + "/publish"
	request("other", "PUT", path, write(input, true), 409)
	request("author", "PUT", path, write(validSubmission(), true), 409)
	row := decodeDirectoryData[directorySubmission](t, request("author", "PUT", path, write(input, true), 200))
	require.Equal(t, "submitted", row.Status)
	require.Equal(t, first.CreatedAt, row.CreatedAt)
	request("author", "POST", publishPath, "", 409)
	request("author", "PUT", reviewPath, `{"status":"approved"}`, 403)
	request("reviewer-unconfirmed", "PUT", reviewPath, `{"status":"approved"}`, 403)
	require.Len(t, public(), 1)

	review := func(status, note string, updatedAt int64, want int) *httptest.ResponseRecorder {
		return request("reviewer", "PUT", reviewPath, fmt.Sprintf(`{"status":%q,"note":%q,"expectedUpdatedAt":%d}`, status, note, updatedAt), want)
	}
	row = decodeDirectoryData[directorySubmission](t, request("reviewer", "PUT", reviewPath, fmt.Sprintf(`{"status":"in_review","note":"Under review","curation":{"topic":"Developer tools"},"expectedUpdatedAt":%d}`, row.UpdatedAt), 200))
	require.Equal(t, "in_review", row.Status)
	_, err = db.Exec(`UPDATE claudex_directory_submissions SET updated_at='2026-01-01T00:00:00Z' WHERE id=$1`, row.ID)
	require.NoError(t, err)
	stale := statuses("author", ownerPath)[0].UpdatedAt
	request("author", "PUT", path, write(partial, false), 409)
	input.Description = "Corrected during review"
	row = decodeDirectoryData[directorySubmission](t, request("author", "PUT", path, write(input, false), 200))
	require.Equal(t, "in_review", row.Status)
	require.Equal(t, "Developer tools", row.Curation.Topic)
	require.Contains(t, review("approved", "", stale, 409).Body.String(), "DIRECTORY_SUBMISSION_CHANGED")
	row = decodeDirectoryData[directorySubmission](t, review("rejected", "Add context", row.UpdatedAt, 200))
	require.Equal(t, "rejected", row.Status)
	input.Description = "Corrected with context"
	row = decodeDirectoryData[directorySubmission](t, request("author", "PUT", path, write(input, false), 200))
	require.Equal(t, "rejected", row.Status)
	require.Equal(t, "Add context", row.ReviewerNote)
	review("approved", "", row.UpdatedAt, 409)
	require.Len(t, public(), 1)

	row = decodeDirectoryData[directorySubmission](t, request("author", "PUT", path, write(input, true), 200))
	require.Equal(t, first.ID, row.ID)
	require.Equal(t, "submitted", row.Status)
	require.Empty(t, row.ReviewerNote)
	row = decodeDirectoryData[directorySubmission](t, review("approved", "Good", row.UpdatedAt, 200))
	require.Equal(t, "approved", row.Status)
	require.Nil(t, row.PublishedAt)
	apply("claudex_0014_directory_publication.sql")
	require.Len(t, public(), 1)
	request("other", "POST", publishPath, "", 409)
	request("author", "DELETE", path, "", 404)
	input.Description = "Revised before publish"
	row = decodeDirectoryData[directorySubmission](t, request("author", "PUT", path, write(input, false), 200))
	require.Equal(t, "draft", row.Status)
	require.Empty(t, row.ReviewerNote)
	request("author", "POST", publishPath, "", 409)
	row = decodeDirectoryData[directorySubmission](t, request("author", "PUT", path, write(input, true), 200))
	review("approved", "Good", row.UpdatedAt, 200)
	row = decodeDirectoryData[directorySubmission](t, request("author", "POST", publishPath, "", 200))
	require.NotNil(t, row.PublishedAt)
	retry := decodeDirectoryData[directorySubmission](t, request("author", "POST", publishPath, "", 200))
	require.Equal(t, row.PublishedAt, retry.PublishedAt)
	require.Equal(t, row.UpdatedAt, retry.UpdatedAt)
	require.Len(t, statuses("author", ownerPath), 2)
	discover := public()
	require.Len(t, discover, 2)
	require.Equal(t, "modern", discover[0].Slug)
	require.Equal(t, "Revised before publish", discover[0].Description)
	request("author", "PUT", path, write(input, false), 409)
	request("author", "DELETE", path, "", 404)

	plugin := validSubmission()
	plugin.Original = json.RawMessage(`{"supported_platforms":["claude_cowork"]}`)
	pluginRow := decodeDirectoryData[directorySubmission](t, request("author", "POST", ownerPath, write(plugin, true), 200))
	pluginRow = decodeDirectoryData[directorySubmission](t, request("reviewer", "PUT", adminPath+"/"+pluginRow.ID+"/review", `{"status":"approved"}`, 200))
	require.NotNil(t, pluginRow.PublishedAt)
	require.Len(t, public(), 3)
	request("author", "DELETE", ownerPath+"/"+pluginRow.ID, "", 200)
	require.Len(t, public(), 2)
}

func decodeDirectoryData[T any](t *testing.T, w *httptest.ResponseRecorder) T {
	t.Helper()
	var result struct {
		Data T `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &result))
	return result.Data
}
