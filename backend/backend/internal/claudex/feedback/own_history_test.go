package feedback

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestB34OwnHistoryRefusesUnauthenticated(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	New(nil).RegisterUserRoutes(r.Group("/api/v1/claudex"))
	for _, method := range []string{http.MethodGet, http.MethodDelete} {
		route := "/api/v1/claudex/feedback/history"
		if method == http.MethodDelete {
			route += "/eb526839-061b-44e0-9fe2-621d8d80f116"
		}
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(method, route, nil))
		require.Equal(t, 401, w.Code)
	}
}

func TestB34OwnHistoryValidationAndUnavailable(t *testing.T) {
	f := newFixture(t)
	for _, query := range []string{"?limit=0", "?limit=101", "?limit=no", "?cursor=bad", "?cursor=" + base64.RawURLEncoding.EncodeToString([]byte(`{"u":99,"i":1,"t":"2026-01-01T00:00:00Z"}`))} {
		require.Equal(t, 400, f.do("GET", "/api/v1/claudex/feedback/history"+query, "").Status)
	}
	require.Equal(t, 500, f.do("GET", "/api/v1/claudex/feedback/history", "").Status)
	require.Equal(t, 404, f.do("DELETE", "/api/v1/claudex/feedback/history/invalid", "").Status)
}

func TestB34OwnHistoryUsesSubjectAndProjectsOnlyPublicFields(t *testing.T) {
	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	defer func() { _ = db.Close() }()
	f := newFixture(t, fixtureOptions{db: db})
	at := time.Date(2026, 10, 19, 2, 3, 4, 0, time.UTC)
	columns := []string{"id", "feedback_uuid", "user_id", "rating", "categories", "comment", "model", "request_id", "has_excerpt", "app_version", "platform", "created_at"}
	rows := sqlmock.NewRows(columns).
		AddRow(9, "eb526839-061b-44e0-9fe2-621d8d80f116", 7, "down", `["wrong"]`, "public comment", "private-model", "private-request", true, "v", "mac", at).
		AddRow(8, "eb526839-061b-44e0-9fe2-621d8d80f117", 7, "up", `[]`, "", "", "", false, "v", "mac", at)
	mock.ExpectQuery("SELECT .* FROM claudex_feedback WHERE user_id = \\$1 ORDER BY created_at DESC, id DESC LIMIT \\$2").WithArgs(int64(7), 2).WillReturnRows(rows)
	res := f.do("GET", "/api/v1/claudex/feedback/history?limit=1&user_id=99", "")
	require.Equal(t, 200, res.Status)
	require.Equal(t, "no-store", res.Header.Get("Cache-Control"))
	var page struct {
		Version int              `json:"version"`
		Items   []map[string]any `json:"items"`
		Next    string           `json:"nextCursor"`
	}
	res.into(t, &page)
	require.Equal(t, 1, page.Version)
	require.Len(t, page.Items, 1)
	require.NotEmpty(t, page.Next)
	for _, field := range []string{"user_id", "user_email", "model", "request_id", "conversation_excerpt"} {
		require.NotContains(t, page.Items[0], field)
	}
	data, err := base64.RawURLEncoding.DecodeString(page.Next)
	require.NoError(t, err)
	var cursor historyCursor
	require.NoError(t, json.Unmarshal(data, &cursor))
	require.Equal(t, int64(7), cursor.User)
	require.NoError(t, mock.ExpectationsWereMet())
}
