package web

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"testing"
	"time"

	claudexhook "github.com/Wei-Shaw/sub2api/internal/claudex/hook"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

var nativeNow = time.Date(2026, 9, 28, 8, 0, 0, 0, time.UTC)

func nativeRouter(f *gateFixture, userID int64, sid string) *gin.Engine {
	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: userID})
		c.Set(middleware.ContextKeySessionID, sid)
	})
	g := r.Group("/api/v1/claudex")
	g.GET("/native-sessions", f.c.listNativeSessions)
	g.DELETE("/native-sessions/:id", f.c.deleteNativeSession)
	return r
}

func TestPhoneSignInsAreRecordedAndRefreshesTouchTheRow(t *testing.T) {
	f := newGateFixture(t, enabled)
	insert := regexp.QuoteMeta(`INSERT INTO claudex_native_sessions`)
	expires := nativeNow.Add(defaultRefreshTTL)
	f.mock.ExpectExec(insert).WithArgs(int64(7), "fam-1", "Claudex/12 CFNetwork/3826 Darwin/25.0.0", "203.0.113.9", nativeNow, expires).
		WillReturnResult(sqlmock.NewResult(1, 1))
	f.c.OnTokensIssued(context.Background(), claudexhook.TokenIssue{
		UserID: 7, SessionID: "fam-1", UserAgent: "Claudex/12 CFNetwork/3826 Darwin/25.0.0", IP: "203.0.113.9",
	})
	// The desktop app's sign-ins are its devices: nothing is written.
	f.c.OnTokensIssued(context.Background(), claudexhook.TokenIssue{UserID: 7, SessionID: "fam-2", Platform: "darwin"})
	require.NoError(t, f.mock.ExpectationsWereMet())
}

func TestLogOutEndsThePhoneRow(t *testing.T) {
	f := newGateFixture(t, enabled)
	f.mock.ExpectExec(regexp.QuoteMeta(`UPDATE claudex_native_sessions SET revoked_at = $3, revoked_reason = $4`)).
		WithArgs("fam-1", int64(7), nativeNow, RevokedLogout).WillReturnResult(sqlmock.NewResult(0, 1))
	f.c.OnTokensReturned(context.Background(), 7, "fam-1")
	require.NoError(t, f.mock.ExpectationsWereMet())
}

func TestPhoneSessionsListMarksTheCaller(t *testing.T) {
	f := newGateFixture(t, enabled)
	cols := []string{"id", "user_id", "family_id", "user_agent", "ip", "created_at", "last_seen_at", "expires_at", "revoked_at", "revoked_reason"}
	f.mock.ExpectQuery(regexp.QuoteMeta(`FROM claudex_native_sessions s`)).WithArgs(int64(7), nativeNow, maxListed).
		WillReturnRows(sqlmock.NewRows(cols).
			AddRow(4, 7, "fam-b", "okhttp/4.12.0", "1.1.1.1", nativeNow.Add(-2*time.Hour), nativeNow.Add(-time.Minute), nativeNow.Add(time.Hour), sql.NullTime{}, "").
			AddRow(3, 7, "fam-a", "Claudex/12 CFNetwork/3826 Darwin/25.0.0", "203.0.113.9", nativeNow.Add(-48*time.Hour), nativeNow.Add(-time.Hour), nativeNow.Add(time.Hour), sql.NullTime{}, ""))
	w := httptest.NewRecorder()
	nativeRouter(f, 7, "fam-a").ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/claudex/native-sessions", nil))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var out struct {
		Data NativeSessionList `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &out))
	require.Len(t, out.Data.Items, 2)
	require.False(t, out.Data.Items[0].Current)
	require.True(t, out.Data.Items[1].Current)
	require.Equal(t, int64(3), out.Data.CurrentSessionID)
	require.Equal(t, "okhttp/4.12.0", out.Data.Items[0].UserAgent)
	require.Equal(t, "Brisbane", out.Data.Items[0].LocationInfo.City)
	require.NoError(t, f.mock.ExpectationsWereMet())
}

func TestTerminatingAPhoneSessionRevokesItsFamily(t *testing.T) {
	f := newGateFixture(t, enabled)
	f.mock.ExpectBegin()
	f.mock.ExpectQuery(regexp.QuoteMeta(`UPDATE claudex_native_sessions SET revoked_at = $3, revoked_reason = 'user'`)).
		WithArgs(int64(3), int64(7), nativeNow).WillReturnRows(sqlmock.NewRows([]string{"family_id"}).AddRow("fam-a"))
	f.mock.ExpectExec(regexp.QuoteMeta(`INSERT INTO claudex_revoked_sessions`)).
		WithArgs("fam-a", int64(7), nativeNow, f.c.revokedUntil(nativeNow)).WillReturnResult(sqlmock.NewResult(0, 1))
	f.mock.ExpectCommit()
	w := httptest.NewRecorder()
	nativeRouter(f, 7, "").ServeHTTP(w, httptest.NewRequest(http.MethodDelete, "/api/v1/claudex/native-sessions/3", nil))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.NoError(t, f.mock.ExpectationsWereMet())

	// Another user's row, or one that already ended: 404.
	f.mock.ExpectBegin()
	f.mock.ExpectQuery(regexp.QuoteMeta(`UPDATE claudex_native_sessions`)).WithArgs(int64(4), int64(7), nativeNow).
		WillReturnError(sql.ErrNoRows)
	f.mock.ExpectRollback()
	w = httptest.NewRecorder()
	nativeRouter(f, 7, "").ServeHTTP(w, httptest.NewRequest(http.MethodDelete, "/api/v1/claudex/native-sessions/4", nil))
	require.Equal(t, http.StatusNotFound, w.Code, w.Body.String())
	require.NoError(t, f.mock.ExpectationsWereMet())
}

func TestBrowserSessionsIncludeCoarseLocation(t *testing.T) {
	f := newGateFixture(t, enabled)
	cols := []string{"id", "user_id", "family_id", "user_agent", "ip", "created_at", "last_seen_at", "expires_at", "revoked_at", "revoked_reason"}
	f.mock.ExpectQuery(regexp.QuoteMeta(`FROM claudex_web_sessions`)).WithArgs(int64(7), nativeNow, maxListed).
		WillReturnRows(sqlmock.NewRows(cols).
			AddRow(4, 7, "fam-web", "Firefox/100", "1.1.1.1", nativeNow, nativeNow, nativeNow.Add(time.Hour), sql.NullTime{}, "").
			AddRow(3, 7, "fam-private", "Firefox/100", "10.0.0.1", nativeNow, nativeNow, nativeNow.Add(time.Hour), sql.NullTime{}, ""))
	r := nativeRouter(f, 7, "fam-web")
	r.GET("/api/v1/claudex/web/sessions", f.c.listSessions)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/claudex/web/sessions", nil))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var out struct {
		Data SessionList `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &out))
	require.Len(t, out.Data.Items, 2)
	require.Equal(t, "Brisbane", out.Data.Items[0].LocationInfo.City)
	require.Equal(t, "Queensland", out.Data.Items[0].LocationInfo.Region)
	require.Equal(t, "Australia", out.Data.Items[0].LocationInfo.Country)
	require.Empty(t, out.Data.Items[1].LocationInfo.City)
	require.Empty(t, out.Data.Items[1].LocationInfo.Region)
	require.Empty(t, out.Data.Items[1].LocationInfo.Country)
	require.NoError(t, f.mock.ExpectationsWereMet())
}
