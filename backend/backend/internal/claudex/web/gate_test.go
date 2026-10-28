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

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	claudexhook "github.com/Wei-Shaw/sub2api/internal/claudex/hook"
	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

type gateUsers struct {
	service.UserRepository
	users map[int64]*service.User
}

func (r gateUsers) GetByID(_ context.Context, id int64) (*service.User, error) {
	u, ok := r.users[id]
	if !ok {
		return nil, service.ErrUserNotFound
	}
	cp := *u
	return &cp, nil
}

func (gateUsers) GetUserAvatar(context.Context, int64) (*service.UserAvatar, error) { return nil, nil }

type gateFixture struct {
	c        *Component
	mock     sqlmock.Sqlmock
	settings *memSettings
	revoked  claudexhook.SessionState
}

func newGateFixture(t *testing.T, stored *Settings) *gateFixture {
	t.Helper()
	gin.SetMode(gin.TestMode)
	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	f := &gateFixture{mock: mock, settings: &memSettings{values: map[string]string{}}}
	data, err := json.Marshal(stored)
	require.NoError(t, err)
	f.settings.values[SettingKey] = string(data)
	users := gateUsers{users: map[int64]*service.User{
		7: {ID: 7, Email: "a@example.com", Status: service.StatusActive, Role: service.RoleUser},
		8: {ID: 8, Email: "b@example.com", Status: service.StatusActive, Role: service.RoleUser},
		9: {ID: 9, Email: "c@example.com", Status: "disabled", Role: service.RoleUser},
	}}
	cfg := &config.Config{}
	cfg.Server.FrontendURL = testOrigin
	env := &core.Env{Deps: core.Deps{SettingRepo: f.settings, Config: cfg, DB: db,
		Users: service.NewUserService(users, nil, nil, nil)}}
	env.Now = func() time.Time { return time.Date(2026, 9, 28, 8, 0, 0, 0, time.UTC) }
	f.c = New(env)
	claudexhook.Install(claudexhook.Hooks{JWTRevoked: func(context.Context, int64, time.Time, string) claudexhook.SessionState {
		return f.revoked
	}})
	t.Cleanup(claudexhook.Reset)
	return f
}

var sessionByFamily = regexp.QuoteMeta(`SELECT ` + sessionColumns + ` FROM claudex_web_sessions WHERE family_id = $1`)

func (f *gateFixture) expectSession(family string, userID int64, revoked bool) {
	now := time.Date(2026, 9, 28, 8, 0, 0, 0, time.UTC)
	var revokedAt sql.NullTime
	reason := ""
	if revoked {
		revokedAt = sql.NullTime{Time: now.Add(-time.Minute), Valid: true}
		reason = RevokedLogout
	}
	f.mock.ExpectQuery(sessionByFamily).WithArgs(family).WillReturnRows(sqlmock.NewRows(
		[]string{"id", "user_id", "family_id", "user_agent", "ip", "created_at", "last_seen_at", "expires_at", "revoked_at", "revoked_reason"}).
		AddRow(1, userID, family, "ua", "1.2.3.4", now.Add(-time.Hour), now.Add(-time.Hour), now.Add(time.Hour), revokedAt, reason))
}

func TestCheckWebCaller(t *testing.T) {
	ctx := context.Background()
	iat := time.Date(2026, 9, 28, 7, 0, 0, 0, time.UTC)
	f := newGateFixture(t, enabled)

	f.expectSession("fam-a", 7, false)
	require.NoError(t, f.c.CheckWebCaller(ctx, 7, "fam-a", iat))

	f.expectSession("fam-a", 7, true)
	require.ErrorIs(t, f.c.CheckWebCaller(ctx, 7, "fam-a", iat), ErrNoWebSession, "signed-out session")

	f.expectSession("fam-b", 8, false)
	require.ErrorIs(t, f.c.CheckWebCaller(ctx, 7, "fam-b", iat), ErrNoWebSession, "another user's session")

	f.mock.ExpectQuery(sessionByFamily).WithArgs("fam-x").WillReturnError(sql.ErrNoRows)
	require.ErrorIs(t, f.c.CheckWebCaller(ctx, 7, "fam-x", iat), ErrNoWebSession, "no such session")

	f.revoked = claudexhook.Revoked
	require.ErrorIs(t, f.c.CheckWebCaller(ctx, 7, "fam-a", iat), ErrNoWebSession, "log out of all devices")
	f.revoked = claudexhook.CheckFailed
	require.ErrorIs(t, f.c.CheckWebCaller(ctx, 7, "fam-a", iat), errUnavailable)
	f.revoked = claudexhook.Valid

	require.ErrorIs(t, f.c.CheckWebCaller(ctx, 9, "fam-a", iat), ErrNoWebSession, "inactive user")
	require.ErrorIs(t, f.c.CheckWebCaller(ctx, 404, "fam-a", iat), ErrNoWebSession, "deleted user")
	require.ErrorIs(t, f.c.CheckWebCaller(ctx, 7, "", iat), ErrNoWebSession, "a token without a session")
	require.NoError(t, f.mock.ExpectationsWereMet())

	allowlist := *enabled
	allowlist.Mode, allowlist.AllowlistUserIDs = ModeAllowlist, []int64{8}
	f = newGateFixture(t, &allowlist)
	require.ErrorIs(t, f.c.CheckWebCaller(ctx, 7, "fam-a", iat), errNotAllowed)

	off := *enabled
	off.Enabled = false
	f = newGateFixture(t, &off)
	require.ErrorIs(t, f.c.CheckWebCaller(ctx, 7, "fam-a", iat), errDisabled)
}

func TestAuthorizeWebPostChecksCSRFAndTheSwitchFirst(t *testing.T) {
	serve := func(f *gateFixture, headers map[string]string) (int, string, bool) {
		r := gin.New()
		var passed bool
		r.POST("/p", func(g *gin.Context) { _, _, _, passed = f.c.AuthorizeWebPost(g) })
		req := httptest.NewRequest(http.MethodPost, "/p", nil)
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		var env struct {
			Reason string `json:"reason"`
		}
		_ = json.Unmarshal(w.Body.Bytes(), &env)
		return w.Code, env.Reason, passed
	}
	f := newGateFixture(t, enabled)
	code, _, ok := serve(f, map[string]string{"Origin": testOrigin})
	require.Equal(t, http.StatusForbidden, code, "no X-Claudex-Web")
	require.False(t, ok)
	code, _, _ = serve(f, map[string]string{webproto.HeaderWeb: "1", "Origin": "https://evil.example"})
	require.Equal(t, http.StatusForbidden, code, "foreign origin")
	code, _, _ = serve(f, map[string]string{webproto.HeaderWeb: "1", "Origin": testOrigin})
	require.Equal(t, http.StatusServiceUnavailable, code, "no auth service in this fixture: the bearer check fails closed")

	off := *enabled
	off.Enabled = false
	f = newGateFixture(t, &off)
	code, reason, _ := serve(f, webHeaders())
	require.Equal(t, http.StatusForbidden, code)
	require.Equal(t, webproto.ErrCodeDisabled, reason)
}
