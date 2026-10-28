package release

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/service"
)

// MemorySettingRepo is an in-memory service.SettingRepository that records
// the update time of every row (exported for the module-level tests in
// package release_test).
type MemorySettingRepo struct {
	mu     sync.Mutex
	rows   map[string]service.Setting
	Now    func() time.Time
	GetErr error
}

// NewMemorySettingRepo returns an empty repository.
func NewMemorySettingRepo() *MemorySettingRepo {
	return &MemorySettingRepo{rows: map[string]service.Setting{}, Now: time.Now}
}

func (r *MemorySettingRepo) Get(_ context.Context, key string) (*service.Setting, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.GetErr != nil {
		return nil, r.GetErr
	}
	row, ok := r.rows[key]
	if !ok {
		return nil, service.ErrSettingNotFound
	}
	return &row, nil
}

func (r *MemorySettingRepo) GetValue(ctx context.Context, key string) (string, error) {
	row, err := r.Get(ctx, key)
	if err != nil {
		return "", err
	}
	return row.Value, nil
}

func (r *MemorySettingRepo) Set(_ context.Context, key, value string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.rows[key] = service.Setting{Key: key, Value: value, UpdatedAt: r.Now()}
	return nil
}

func (r *MemorySettingRepo) GetMultiple(context.Context, []string) (map[string]string, error) {
	return nil, errors.New("not used")
}

func (r *MemorySettingRepo) SetMultiple(context.Context, map[string]string) error {
	return errors.New("not used")
}

func (r *MemorySettingRepo) GetAll(context.Context) (map[string]string, error) {
	return nil, errors.New("not used")
}

func (r *MemorySettingRepo) Delete(context.Context, string) error { return errors.New("not used") }

// Raw returns the stored text of key ("" when missing).
func (r *MemorySettingRepo) Raw(key string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.rows[key].Value
}

var _ service.SettingRepository = (*MemorySettingRepo)(nil)
