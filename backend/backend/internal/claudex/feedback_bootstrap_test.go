package claudex

// Added by B8 review: with the real module (B8 feedback and B9 bootstrap
// installed), a default install reports features.diagnostics/feedback false
// and turns them on only once the administrator enables them in
// claudex_feedback. Test only; uses the helpers of module_test.go.

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/stretchr/testify/require"
)

type feedbackSettingRepo struct {
	mu     sync.Mutex
	values map[string]string
}

func (r *feedbackSettingRepo) Get(ctx context.Context, key string) (*service.Setting, error) {
	v, err := r.GetValue(ctx, key)
	if err != nil {
		return nil, err
	}
	return &service.Setting{Key: key, Value: v}, nil
}

func (r *feedbackSettingRepo) GetValue(_ context.Context, key string) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	v, ok := r.values[key]
	if !ok {
		return "", service.ErrSettingNotFound
	}
	return v, nil
}

func (r *feedbackSettingRepo) Set(_ context.Context, key, value string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.values[key] = value
	return nil
}

func (r *feedbackSettingRepo) GetMultiple(context.Context, []string) (map[string]string, error) {
	return nil, errors.New("not implemented")
}
func (r *feedbackSettingRepo) SetMultiple(context.Context, map[string]string) error {
	return errors.New("not implemented")
}
func (r *feedbackSettingRepo) GetAll(context.Context) (map[string]string, error) {
	return nil, errors.New("not implemented")
}
func (r *feedbackSettingRepo) Delete(context.Context, string) error {
	return errors.New("not implemented")
}

func TestFeedbackFeaturesFollowTheAdminSetting(t *testing.T) {
	features := func(repo *feedbackSettingRepo) map[string]any {
		t.Helper()
		m := ProvideModule(Deps{SettingRepo: repo})
		r := testRouter(t, m, nil, nil)
		var boot struct {
			Features map[string]any `json:"features"`
			Feedback map[string]any `json:"feedback"`
		}
		decodeData(t, get(r, "/api/v1/claudex/bootstrap", map[string]string{"Authorization": "Bearer x"}), &boot)
		require.Contains(t, boot.Features, "diagnostics")
		require.Contains(t, boot.Features, "feedback")
		return boot.Features
	}

	// Default install: nothing is collected, both intake endpoints are 404.
	repo := &feedbackSettingRepo{values: map[string]string{}}
	f := features(repo)
	require.Equal(t, false, f["diagnostics"])
	require.Equal(t, false, f["feedback"])
	r := testRouter(t, ProvideModule(Deps{SettingRepo: repo}), nil, nil)
	for _, path := range []string{"/api/v1/claudex/diagnostics", "/api/v1/claudex/feedback"} {
		rec := do(r, http.MethodPost, path, map[string]string{"Authorization": "Bearer x", "Content-Type": "application/json"}, `{"consent":true}`)
		require.Equal(t, http.StatusNotFound, rec.Code, path)
		require.Contains(t, rec.Body.String(), "CLAUDEX_FEEDBACK_DISABLED", path)
	}

	// The administrator turns diagnostics on; reply feedback stays off.
	repo.values["claudex_feedback"] = `{"diagnostics":{"enabled":true,"retention_days":30,"max_per_user_per_day":200},` +
		`"feedback":{"enabled":false,"retention_days":180,"allow_conversation_excerpt":true,"max_per_user_per_day":100}}`
	f = features(repo)
	require.Equal(t, true, f["diagnostics"])
	require.Equal(t, false, f["feedback"])

	repo.values["claudex_feedback"] = `{"diagnostics":{"enabled":false,"retention_days":30,"max_per_user_per_day":200},` +
		`"feedback":{"enabled":true,"retention_days":180,"allow_conversation_excerpt":false,"max_per_user_per_day":100}}`
	f = features(repo)
	require.Equal(t, false, f["diagnostics"])
	require.Equal(t, true, f["feedback"])
}
