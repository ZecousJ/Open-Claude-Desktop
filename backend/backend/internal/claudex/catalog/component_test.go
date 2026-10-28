package catalog

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// stepUpSettings is an in-memory setting repository holding step_up_enabled.
type stepUpSettings struct {
	mu     sync.Mutex
	values map[string]string
}

func (s *stepUpSettings) Get(ctx context.Context, key string) (*service.Setting, error) {
	v, err := s.GetValue(ctx, key)
	if err != nil {
		return nil, err
	}
	return &service.Setting{Key: key, Value: v}, nil
}
func (s *stepUpSettings) GetValue(_ context.Context, key string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.values[key]
	if !ok {
		return "", service.ErrSettingNotFound
	}
	return v, nil
}
func (s *stepUpSettings) Set(_ context.Context, key, value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.values[key] = value
	return nil
}
func (s *stepUpSettings) GetMultiple(context.Context, []string) (map[string]string, error) {
	return nil, errors.New("not used")
}
func (s *stepUpSettings) SetMultiple(context.Context, map[string]string) error {
	return errors.New("not used")
}
func (s *stepUpSettings) GetAll(context.Context) (map[string]string, error) {
	return nil, errors.New("not used")
}
func (s *stepUpSettings) Delete(context.Context, string) error { return errors.New("not used") }

// stepUpAdmins serves the administrator the step-up middleware loads (TOTP on).
type stepUpAdmins struct{ service.UserRepository }

func (stepUpAdmins) GetByID(_ context.Context, id int64) (*service.User, error) {
	return &service.User{ID: id, Role: service.RoleAdmin, Status: service.StatusActive, TotpEnabled: true}, nil
}

func (stepUpAdmins) GetUserAvatar(context.Context, int64) (*service.UserAvatar, error) {
	return nil, nil
}

// stepUpGrants answers HasStepUpGrant with a switch (the upstream TOTP cache).
type stepUpGrants struct {
	service.TotpCache
	granted bool
}

func (g *stepUpGrants) HasStepUpGrant(context.Context, int64, string) (bool, error) {
	return g.granted, nil
}

// TestAdminWritesRequireStepUp: creating, changing and deleting catalog
// entries go through the upstream step-up gate (R13); reads do not.
func TestAdminWritesRequireStepUp(t *testing.T) {
	h := newHarness(t)
	h.seed()
	var target int64
	for rowID := range h.store.rows {
		if target == 0 || rowID < target {
			target = rowID
		}
	}
	require.Positive(t, target)
	id := strconv.FormatInt(target, 10)

	settings := &stepUpSettings{values: map[string]string{service.SettingKeyStepUpEnabled: "true"}}
	settingService := service.NewSettingService(settings, nil)
	grants := &stepUpGrants{}
	stepUp := gin.HandlerFunc(middleware.NewStepUpAuthMiddleware(
		service.NewTotpService(stepUpAdmins{}, nil, grants, settingService, nil, nil),
		service.NewUserService(stepUpAdmins{}, nil, nil, nil), settingService))
	r := gin.New()
	admin := r.Group("/api/v1/admin/claudex")
	admin.Use(func(c *gin.Context) {
		c.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: adminUserID})
		c.Set(string(middleware.ContextKeyUserRole), service.RoleAdmin)
		c.Next()
	})
	h.c.RegisterAdminRoutes(admin, stepUp)
	serve := func(method, path, body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		r.ServeHTTP(rec, req)
		return rec
	}
	writes := []struct{ method, path, body string }{
		{http.MethodPost, "/api/v1/admin/claudex/models", `{"model_id":"gpt-5.5-nano","group_id":4}`},
		{http.MethodPut, "/api/v1/admin/claudex/models/" + id, `{"display_name":"Renamed"}`},
		{http.MethodDelete, "/api/v1/admin/claudex/models/" + id, ""},
	}
	before := len(h.store.rows)
	for _, w := range writes {
		rec := serve(w.method, w.path, w.body)
		require.Equal(t, http.StatusForbidden, rec.Code, "%s %s: %s", w.method, w.path, rec.Body.String())
		require.Contains(t, rec.Body.String(), "STEP_UP_REQUIRED")
	}
	require.Len(t, h.store.rows, before, "nothing changed without step-up")
	for _, path := range []string{"/api/v1/admin/claudex/models", "/api/v1/admin/claudex/models/candidates?group_id=4"} {
		rec := serve(http.MethodGet, path, "")
		require.Equal(t, http.StatusOK, rec.Code, "%s needs no step-up: %s", path, rec.Body.String())
	}

	grants.granted = true
	for _, w := range writes {
		rec := serve(w.method, w.path, w.body)
		require.Equal(t, http.StatusOK, rec.Code, "%s %s: %s", w.method, w.path, rec.Body.String())
	}
	_, kept := h.store.rows[target]
	require.False(t, kept, "the verified delete went through")
}
