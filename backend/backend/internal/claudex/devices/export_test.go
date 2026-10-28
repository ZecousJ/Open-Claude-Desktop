package devices

import (
	"context"
	"time"
)

// Test hooks for the external test package (devices_test, integration tests).

// UseKeyStore replaces the API key service (to inject failures).
func (c *Component) UseKeyStore(k apiKeyStore) { c.keyStore = k }

// UseClock replaces the clock.
func (c *Component) UseClock(now func() time.Time) { c.clock = now }

// ReconcileNow runs one reconciliation pass.
func (c *Component) ReconcileNow(ctx context.Context) (int, error) { return c.reconcile(ctx) }

// CleanupNow drops expired signed-out sessions.
func (c *Component) CleanupNow(ctx context.Context) error { return c.cleanupRevokedSessions(ctx) }
