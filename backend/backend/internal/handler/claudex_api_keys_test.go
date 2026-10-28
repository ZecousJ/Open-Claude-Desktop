//go:build unit

package handler

// CLAUDEX: tests for the H13 API-key guards (claudex_api_keys.go).

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	claudexhook "github.com/Wei-Shaw/sub2api/internal/claudex/hook"
	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/handler/dto"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/pagination"
	middleware2 "github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// claudexKeyRepo serves two keys of user 7: 1 is a Claudex device key, 2 a
// user-created key.
type claudexKeyRepo struct {
	service.APIKeyRepository
	updates, deletes int
}

func (r *claudexKeyRepo) keys() []service.APIKey {
	return []service.APIKey{
		{ID: 1, UserID: 7, Key: "sk-device0000000000000000dev1", Name: "claudex-device:abc", Status: service.StatusActive},
		{ID: 2, UserID: 7, Key: "sk-user000000000000000000usr2", Name: "my key", Status: service.StatusActive},
	}
}

func (r *claudexKeyRepo) ListByUserID(_ context.Context, _ int64, _ pagination.PaginationParams, _ service.APIKeyListFilters) ([]service.APIKey, *pagination.PaginationResult, error) {
	keys := r.keys()
	return keys, &pagination.PaginationResult{Total: int64(len(keys)), Page: 1, PageSize: 20, Pages: 1}, nil
}

func (r *claudexKeyRepo) GetByID(_ context.Context, id int64) (*service.APIKey, error) {
	for _, k := range r.keys() {
		if k.ID == id {
			return &k, nil
		}
	}
	return nil, service.ErrAPIKeyNotFound
}

func (r *claudexKeyRepo) Update(context.Context, *service.APIKey, service.APIKeyUpdateFields) error {
	r.updates++
	return nil
}

func (r *claudexKeyRepo) GetKeyAndOwnerID(ctx context.Context, id int64) (string, int64, error) {
	k, err := r.GetByID(ctx, id)
	if err != nil {
		return "", 0, err
	}
	return k.Key, k.UserID, nil
}

func (r *claudexKeyRepo) DeleteWithAudit(context.Context, int64) error {
	r.deletes++
	return nil
}

func claudexKeyRouter(repo *claudexKeyRepo, role string) *gin.Engine {
	gin.SetMode(gin.TestMode)
	h := NewAPIKeyHandler(service.NewAPIKeyService(repo, nil, nil, nil, nil, nil, &config.Config{}))
	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Set(string(middleware2.ContextKeyUser), middleware2.AuthSubject{UserID: 7})
		c.Set(string(middleware2.ContextKeyUserRole), role)
		c.Next()
	})
	r.GET("/keys", h.List)
	r.GET("/keys/:id", h.GetByID)
	r.POST("/keys", h.Create)
	r.PUT("/keys/:id", h.Update)
	r.DELETE("/keys/:id", h.Delete)
	return r
}

func serveKeys(r http.Handler, method, path, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(rec, req)
	return rec
}

func installDeviceKeyHooks(t *testing.T) {
	t.Helper()
	t.Cleanup(claudexhook.Reset)
	claudexhook.Install(claudexhook.Hooks{
		ManagedAPIKeyIDs: func(_ context.Context, userID int64, ids []int64) map[int64]bool {
			out := map[int64]bool{}
			for _, id := range ids {
				if userID == 7 && id == 1 {
					out[id] = true
				}
			}
			return out
		},
		CreateAPIKey: func(_ context.Context, _ int64, isAdmin bool) error {
			if isAdmin {
				return nil
			}
			return infraerrors.Forbidden("CLAUDEX_USER_API_KEYS_DISABLED", "Creating API keys is turned off on this server.")
		},
	})
}

func TestClaudexDeviceKeysAreMaskedAndReadOnly(t *testing.T) {
	installDeviceKeyHooks(t)
	repo := &claudexKeyRepo{}
	r := claudexKeyRouter(repo, service.RoleUser)

	rec := serveKeys(r, http.MethodGet, "/keys", "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.NotContains(t, rec.Body.String(), "sk-device0000000000000000dev1", "no device key plaintext in the list")
	require.Contains(t, rec.Body.String(), `"key":"sk-…dev1"`)
	require.Contains(t, rec.Body.String(), "sk-user000000000000000000usr2", "user-created keys are unchanged")

	rec = serveKeys(r, http.MethodGet, "/keys/1", "")
	require.Equal(t, http.StatusOK, rec.Code)
	require.NotContains(t, rec.Body.String(), "sk-device0000000000000000dev1")
	rec = serveKeys(r, http.MethodGet, "/keys/2", "")
	require.Contains(t, rec.Body.String(), "sk-user000000000000000000usr2")

	for _, method := range []string{http.MethodPut, http.MethodDelete} {
		rec = serveKeys(r, method, "/keys/1", `{"status":"active"}`)
		require.Equal(t, http.StatusForbidden, rec.Code, method)
		require.Contains(t, rec.Body.String(), "CLAUDEX_DEVICE_KEY_MANAGED")
	}
	require.Zero(t, repo.updates)
	require.Zero(t, repo.deletes)

	// User-created keys can still be deleted.
	rec = serveKeys(r, http.MethodDelete, "/keys/2", "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, 1, repo.deletes)
}

func TestClaudexUserKeyCreationSwitch(t *testing.T) {
	installDeviceKeyHooks(t)
	rec := serveKeys(claudexKeyRouter(&claudexKeyRepo{}, service.RoleUser), http.MethodPost, "/keys", `{"name":"k"}`)
	require.Equal(t, http.StatusForbidden, rec.Code)
	require.Contains(t, rec.Body.String(), "CLAUDEX_USER_API_KEYS_DISABLED")

	// Admins pass the switch (the invalid body then fails validation as usual).
	rec = serveKeys(claudexKeyRouter(&claudexKeyRepo{}, service.RoleAdmin), http.MethodPost, "/keys", `{}`)
	require.Equal(t, http.StatusBadRequest, rec.Code, rec.Body.String())

	// Without the Claudex module the upstream behavior is unchanged.
	claudexhook.Reset()
	rec = serveKeys(claudexKeyRouter(&claudexKeyRepo{}, service.RoleUser), http.MethodPost, "/keys", `{}`)
	require.Equal(t, http.StatusBadRequest, rec.Code)
	rec = serveKeys(claudexKeyRouter(&claudexKeyRepo{}, service.RoleUser), http.MethodGet, "/keys", "")
	require.Contains(t, rec.Body.String(), "sk-device0000000000000000dev1")
}

func TestClaudexUsageRecordsMaskDeviceKeys(t *testing.T) {
	installDeviceKeyHooks(t)
	gin.SetMode(gin.TestMode)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodGet, "/api/v1/usage", nil)
	c.Set(string(middleware2.ContextKeyUser), middleware2.AuthSubject{UserID: 7})

	logs := []dto.UsageLog{
		{ID: 1, APIKey: &dto.APIKey{ID: 1, Key: "sk-device0000000000000000dev1"}},
		{ID: 2, APIKey: &dto.APIKey{ID: 2, Key: "sk-user000000000000000000usr2"}},
		{ID: 3},
	}
	claudexMaskUsageLogList(c, logs)
	raw, err := json.Marshal(logs)
	require.NoError(t, err)
	require.False(t, strings.Contains(string(raw), "sk-device0000000000000000dev1"))
	require.Equal(t, "sk-…dev1", logs[0].APIKey.Key)
	require.Equal(t, "sk-user000000000000000000usr2", logs[1].APIKey.Key)

	one := &dto.UsageLog{APIKey: &dto.APIKey{ID: 1, Key: "sk-device0000000000000000dev1"}}
	require.Equal(t, "sk-…dev1", claudexMaskUsageLog(c, one).APIKey.Key)
}
