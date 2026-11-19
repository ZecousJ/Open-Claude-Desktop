package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/stretchr/testify/require"
	"github.com/zeromicro/go-zero/core/collection"
)

func TestProvideTimingWheelService_ReturnsError(t *testing.T) {
	original := newTimingWheel
	t.Cleanup(func() { newTimingWheel = original })

	newTimingWheel = func(_ time.Duration, _ int, _ collection.Execute) (*collection.TimingWheel, error) {
		return nil, errors.New("boom")
	}

	svc, err := ProvideTimingWheelService()
	if err == nil {
		t.Fatalf("期望返回 error，但得到 nil")
	}
	if svc != nil {
		t.Fatalf("期望返回 nil svc，但得到非空")
	}
}

func TestProvideTimingWheelService_Success(t *testing.T) {
	svc, err := ProvideTimingWheelService()
	if err != nil {
		t.Fatalf("期望 err 为 nil，但得到: %v", err)
	}
	if svc == nil {
		t.Fatalf("期望 svc 非空，但得到 nil")
	}
	svc.Stop()
}

func TestProvideAuthCacheWorkersByServerRole(t *testing.T) {
	for _, role := range []config.ServerRole{config.ServerRoleFull, config.ServerRoleModelGateway} {
		t.Run(string(role), func(t *testing.T) {
			cfg := &config.Config{Server: config.ServerConfig{Role: role}}
			cfg.APIKeyAuth.L1Size = 16
			cfg.APIKeyAuth.L1TTLSeconds = 60
			published := make(chan string, 1)
			cache := &authInvalidationCacheStub{
				publishFn: func(_ context.Context, key string) error {
					select {
					case published <- key:
					default:
					}
					return nil
				},
				subscribeFn: func(ctx context.Context, _ func(string)) error {
					NotifyAuthCacheSubscriptionReady(ctx)
					<-ctx.Done()
					return ctx.Err()
				},
			}
			apiKeys := NewAPIKeyService(nil, nil, nil, nil, nil, cache, cfg)
			ProvideAPIKeyAuthCacheInvalidator(apiKeys)
			t.Cleanup(apiKeys.StopAuthCacheInvalidationSubscriber)
			require.Eventually(t, func() bool {
				return apiKeys.AuthCacheInvalidationSubscriberHealth().Connected
			}, time.Second, time.Millisecond)

			repo := &authInvalidationRepoStub{events: []AuthCacheInvalidationEvent{{ID: 1, CacheKey: "key"}}}
			worker := ProvideAuthCacheInvalidationWorker(repo, cache, apiKeys, cfg)
			if role == config.ServerRoleFull {
				t.Cleanup(worker.Stop)
				select {
				case key := <-published:
					require.Equal(t, "key", key)
				case <-time.After(time.Second):
					t.Fatal("full server did not publish the pending invalidation")
				}
			} else {
				require.False(t, worker.Health(t.Context()).Running)
				worker.Stop()
				require.Empty(t, published)
			}
		})
	}
}

type gatewayAuditLogRepository struct {
	AuditLogRepository
	entries []*AuditLog
}

func (r *gatewayAuditLogRepository) BatchInsert(_ context.Context, entries []*AuditLog) (int64, error) {
	r.entries = append(r.entries, entries...)
	return int64(len(entries)), nil
}

func TestProvideAuditLogServiceFlushesGatewayEntries(t *testing.T) {
	cfg := &config.Config{Server: config.ServerConfig{Role: config.ServerRoleModelGateway}}
	repo := &gatewayAuditLogRepository{}
	audit := ProvideAuditLogService(repo, nil, cfg)
	audit.Record(&AuditLog{Action: "test.gateway"})
	audit.Stop()
	require.Len(t, repo.entries, 1)
	require.Equal(t, "test.gateway", repo.entries[0].Action)
}
