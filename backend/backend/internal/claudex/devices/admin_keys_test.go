//go:build unit

package devices

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"regexp"
	"sort"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// recordingKeys is an apiKeyStore that records Create and Delete.
type recordingKeys struct {
	apiKeyStore
	groups  []service.Group
	created []service.CreateAPIKeyRequest
	deleted []int64
	err     error
}

func (k *recordingKeys) GetAvailableGroups(context.Context, int64) ([]service.Group, error) {
	return k.groups, nil
}

func (k *recordingKeys) Create(_ context.Context, userID int64, req service.CreateAPIKeyRequest) (*service.APIKey, error) {
	if k.err != nil {
		return nil, k.err
	}
	k.created = append(k.created, req)
	return &service.APIKey{ID: 41, UserID: userID, Key: "sk-admin-created-0123456789abcd", Name: req.Name, GroupID: req.GroupID,
		Status: service.StatusAPIKeyActive, Quota: req.Quota, CreatedAt: time.Date(2026, 9, 26, 4, 0, 0, 0, time.UTC)}, nil
}

func (k *recordingKeys) Delete(_ context.Context, id, _ int64) error {
	k.deleted = append(k.deleted, id)
	return nil
}

func adminKeysRouter(t *testing.T, c *Component, stepUp gin.HandlerFunc) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	admin := r.Group("/api/v1/admin/claudex")
	admin.Use(func(g *gin.Context) {
		g.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: 1})
		g.Next()
	})
	c.RegisterAdminRoutes(admin, stepUp)
	return r
}

func expectUser(mock sqlmock.Sqlmock, userID int64, exists bool) {
	mock.ExpectQuery(regexp.QuoteMeta(`SELECT EXISTS (SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL)`)).
		WithArgs(userID).WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(exists))
}

func TestReservedKeyName(t *testing.T) {
	for name, want := range map[string]bool{
		"claudex-device:0123abcd":    true,
		"  Claudex-Desktop:6f1c2a4e": true,
		"CLAUDEX-DEVICE:":            true,
		"claudex device":             false,
		"my claudex-device: key":     false,
		"CI script":                  false,
	} {
		require.Equal(t, want, ReservedKeyName(name), name)
	}
	require.True(t, ReservedKeyName(DeviceKeyName("abcdef0123456789")))
	require.True(t, ReservedKeyName(LegacyKeyName(testDevice)))
}

func TestCreateUserKeyRequestValidate(t *testing.T) {
	days := func(v int) *int { return &v }
	cases := []struct {
		req   CreateUserKeyRequest
		field string // "" = valid; "reserved" = CLAUDEX_RESERVED_KEY_NAME
	}{
		{CreateUserKeyRequest{Name: " CI script "}, ""},
		{CreateUserKeyRequest{Name: "x", Quota: 10, ExpiresInDays: days(30), IPWhitelist: []string{" 10.0.0.0/8 ", ""}}, ""},
		{CreateUserKeyRequest{Name: "   "}, "name"},
		{CreateUserKeyRequest{Name: string(make([]rune, 101))}, "name"},
		{CreateUserKeyRequest{Name: "claudex-device:abc"}, "reserved"},
		{CreateUserKeyRequest{Name: "x", Quota: -1}, "quota"},
		{CreateUserKeyRequest{Name: "x", ExpiresInDays: days(0)}, "expires_in_days"},
		{CreateUserKeyRequest{Name: "x", ExpiresInDays: days(3651)}, "expires_in_days"},
	}
	for _, tc := range cases {
		req := tc.req
		err := req.validate()
		switch tc.field {
		case "":
			require.NoError(t, err, "%+v", tc.req)
		case "reserved":
			require.ErrorIs(t, err, ErrReservedKeyName)
		default:
			require.Error(t, err)
			require.Equal(t, "CLAUDEX_API_KEY_INVALID", infraerrors.Reason(err), "%+v", tc.req)
			require.Equal(t, tc.field, infraerrors.FromError(err).Metadata["field"], "%+v", tc.req)
		}
	}
	req := CreateUserKeyRequest{Name: " CI ", IPWhitelist: []string{" 10.0.0.1 ", " "}, GroupID: int64p(0)}
	require.NoError(t, req.validate())
	require.Equal(t, "CI", req.Name)
	require.Equal(t, []string{"10.0.0.1"}, req.IPWhitelist)
	require.Nil(t, req.GroupID, "group 0 means none")
}

func TestAdminUserKeyWritesBehindStepUp(t *testing.T) {
	c := newTestComponent(core.Deps{SettingRepo: newMemSettings()})
	var stepped []string
	r := adminKeysRouter(t, c, func(g *gin.Context) {
		stepped = append(stepped, g.Request.Method+" "+g.FullPath())
		g.AbortWithStatus(http.StatusTeapot)
	})
	require.Equal(t, http.StatusTeapot, call(r, http.MethodPost, "/api/v1/admin/claudex/users/7/api-keys", nil, `{"name":"x"}`).Code)
	require.Equal(t, http.StatusTeapot, call(r, http.MethodDelete, "/api/v1/admin/claudex/users/7/api-keys/3", nil, "").Code)
	require.Equal(t, []string{
		"POST /api/v1/admin/claudex/users/:user_id/api-keys",
		"DELETE /api/v1/admin/claudex/users/:user_id/api-keys/:key_id",
	}, stepped)
	// The list is a read: no step-up (and no storage here).
	require.Equal(t, http.StatusServiceUnavailable, call(r, http.MethodGet, "/api/v1/admin/claudex/users/7/api-keys", nil, "").Code)
	require.Len(t, stepped, 2)
}

func TestAdminCreateUserKeyIgnoresTheUserGate(t *testing.T) {
	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	defer func() { _ = db.Close() }()
	// user_api_keys_enabled is off (owner decision 17): users cannot create keys.
	c := newTestComponent(core.Deps{DB: db, SettingRepo: newMemSettings()})
	require.Error(t, c.AllowUserAPIKeyCreate(context.Background(), 7, false))
	keys := &recordingKeys{groups: []service.Group{
		{ID: 4, Status: service.StatusActive},
		{ID: 5, Status: service.StatusDisabled},
	}}
	c.UseKeyStore(keys)
	r := adminKeysRouter(t, c, func(g *gin.Context) { g.Next() })
	path := "/api/v1/admin/claudex/users/7/api-keys"

	expectUser(mock, 7, true)
	rec := call(r, http.MethodPost, path, nil, `{"name":" CI script ","group_id":4,"quota":5,"expires_in_days":30}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
	var out CreatedUserKeyJSON
	require.NoError(t, json.Unmarshal(decode(t, rec).Data, &out))
	require.Equal(t, CreatedUserKeyJSON{ID: 41, Name: "CI script", Key: "sk-admin-created-0123456789abcd", GroupID: int64p(4),
		Status: service.StatusAPIKeyActive, Quota: 5, CreatedAt: time.Date(2026, 9, 26, 4, 0, 0, 0, time.UTC)}, out)
	require.Len(t, keys.created, 1)
	require.Equal(t, "CI script", keys.created[0].Name)
	require.Equal(t, 30, *keys.created[0].ExpiresInDays)
	require.Nil(t, keys.created[0].CustomKey, "the service generates the key")

	for _, tc := range []struct {
		body, reason string
		status       int
	}{
		{`{"name":"claudex-desktop:6f1c2a4e"}`, "CLAUDEX_RESERVED_KEY_NAME", http.StatusBadRequest},
		{`{"name":"x","group_id":5}`, "CLAUDEX_GROUP_NOT_ALLOWED", http.StatusBadRequest},
		{`{"name":"x","group_id":99}`, "CLAUDEX_GROUP_NOT_ALLOWED", http.StatusBadRequest},
		{`[1]`, "CLAUDEX_API_KEY_INVALID", http.StatusBadRequest},
	} {
		expectUser(mock, 7, true)
		rec := call(r, http.MethodPost, path, nil, tc.body)
		require.Equal(t, tc.status, rec.Code, tc.body)
		require.Equal(t, tc.reason, decode(t, rec).Reason, tc.body)
	}
	require.Len(t, keys.created, 1, "refused requests create nothing")

	expectUser(mock, 8, false)
	rec = call(r, http.MethodPost, "/api/v1/admin/claudex/users/8/api-keys", nil, `{"name":"x"}`)
	require.Equal(t, "CLAUDEX_USER_NOT_FOUND", decode(t, rec).Reason)

	// An IP pattern the upstream service rejects is a field error.
	keys.err = service.ErrInvalidIPPattern
	expectUser(mock, 7, true)
	rec = call(r, http.MethodPost, path, nil, `{"name":"x","ip_whitelist":["nope"]}`)
	require.Equal(t, http.StatusBadRequest, rec.Code)
	require.Equal(t, "ip_whitelist", decode(t, rec).Metadata["field"])
	require.NoError(t, mock.ExpectationsWereMet())
}

func TestAdminDeleteUserKeyRefusesDeviceKeys(t *testing.T) {
	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	defer func() { _ = db.Close() }()
	c := newTestComponent(core.Deps{DB: db, SettingRepo: newMemSettings()})
	keys := &recordingKeys{}
	c.UseKeyStore(keys)
	r := adminKeysRouter(t, c, func(g *gin.Context) { g.Next() })
	owner := regexp.QuoteMeta(`SELECT k.user_id, EXISTS`)

	expectUser(mock, 7, true)
	mock.ExpectQuery(owner).WithArgs(int64(3)).WillReturnRows(sqlmock.NewRows([]string{"user_id", "device"}).AddRow(int64(7), true))
	rec := call(r, http.MethodDelete, "/api/v1/admin/claudex/users/7/api-keys/3", nil, "")
	require.Equal(t, http.StatusForbidden, rec.Code)
	require.Equal(t, "CLAUDEX_DEVICE_KEY_MANAGED", decode(t, rec).Reason)

	expectUser(mock, 7, true)
	mock.ExpectQuery(owner).WithArgs(int64(4)).WillReturnRows(sqlmock.NewRows([]string{"user_id", "device"}).AddRow(int64(8), false))
	rec = call(r, http.MethodDelete, "/api/v1/admin/claudex/users/7/api-keys/4", nil, "")
	require.Equal(t, http.StatusNotFound, rec.Code, "another user's key")
	require.Equal(t, "CLAUDEX_API_KEY_NOT_FOUND", decode(t, rec).Reason)

	expectUser(mock, 7, true)
	mock.ExpectQuery(owner).WithArgs(int64(5)).WillReturnRows(sqlmock.NewRows([]string{"user_id", "device"}))
	rec = call(r, http.MethodDelete, "/api/v1/admin/claudex/users/7/api-keys/5", nil, "")
	require.Equal(t, http.StatusNotFound, rec.Code, "no such key")

	expectUser(mock, 7, true)
	rec = call(r, http.MethodDelete, "/api/v1/admin/claudex/users/7/api-keys/abc", nil, "")
	require.Equal(t, http.StatusNotFound, rec.Code)
	require.Empty(t, keys.deleted)

	expectUser(mock, 7, true)
	mock.ExpectQuery(owner).WithArgs(int64(6)).WillReturnRows(sqlmock.NewRows([]string{"user_id", "device"}).AddRow(int64(7), false))
	rec = call(r, http.MethodDelete, "/api/v1/admin/claudex/users/7/api-keys/6", nil, "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.JSONEq(t, `{"deleted":true}`, string(decode(t, rec).Data))
	require.Equal(t, []int64{6}, keys.deleted)
	require.NoError(t, mock.ExpectationsWereMet())
}

func TestAdminListUserKeysHidesDeviceKeys(t *testing.T) {
	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	defer func() { _ = db.Close() }()
	c := newTestComponent(core.Deps{DB: db, SettingRepo: newMemSettings()})
	r := adminKeysRouter(t, c, func(g *gin.Context) { g.Next() })
	created := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)

	expectUser(mock, 7, true)
	mock.ExpectQuery(`NOT EXISTS \(SELECT 1 FROM claudex_devices d WHERE d.api_key_id = k.id\)`).WithArgs(int64(7), int64(userKeyListLimit)).
		WillReturnRows(sqlmock.NewRows([]string{"id", "name", "prefix", "last4", "group_id", "group_name", "status", "quota",
			"quota_used", "expires_at", "last_used_at", "created_at"}).
			AddRow(int64(9), "R&amp;D", "sk-", "a1b2", int64(4), "claudex-pro", "active", 5.0, 1.25, nil, nil, created))
	rec := call(r, http.MethodGet, "/api/v1/admin/claudex/users/7/api-keys", nil, "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var out struct {
		Items []UserKeyJSON `json:"items"`
	}
	require.NoError(t, json.Unmarshal(decode(t, rec).Data, &out))
	require.Equal(t, []UserKeyJSON{{ID: 9, Name: "R&D", KeyHint: "sk-…a1b2", GroupID: int64p(4), GroupName: "claudex-pro",
		Status: "active", Quota: 5, QuotaUsed: 1.25, CreatedAt: created}}, out.Items)
	require.NoError(t, mock.ExpectationsWereMet())
}

// TestUserKeyFixturesMatchTheTypes locks the contract fixtures of the create
// endpoint (request and answer) to the Go types, field for field.
func TestUserKeyFixturesMatchTheTypes(t *testing.T) {
	keysOf := func(raw []byte) []string {
		var m map[string]json.RawMessage
		require.NoError(t, json.Unmarshal(raw, &m))
		out := make([]string, 0, len(m))
		for k := range m {
			out = append(out, k)
		}
		sort.Strings(out)
		return out
	}
	req, err := os.ReadFile("../contract/testdata/admin-user-api-key.create-request.json")
	require.NoError(t, err)
	var body CreateUserKeyRequest
	require.NoError(t, json.Unmarshal(req, &body))
	require.NoError(t, body.validate())
	own, err := json.Marshal(body)
	require.NoError(t, err)
	require.Equal(t, keysOf(own), keysOf(req))

	resp, err := os.ReadFile("../contract/testdata/admin-user-api-key.create-response.json")
	require.NoError(t, err)
	var env struct {
		Data json.RawMessage `json:"data"`
	}
	require.NoError(t, json.Unmarshal(resp, &env))
	expires := time.Now()
	own, err = json.Marshal(CreatedUserKeyJSON{GroupID: int64p(4), ExpiresAt: &expires})
	require.NoError(t, err)
	require.Equal(t, keysOf(own), keysOf(env.Data))
}
