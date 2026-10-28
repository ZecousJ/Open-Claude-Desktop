// CLAUDEX: Request-scoped group failover with one shared generation budget.
package service

import (
	"context"

	"github.com/Wei-Shaw/sub2api/internal/pkg/requestbudget"
)

// Group traversal owns retry decisions for bounded gateway requests. Service
// adapters must return eligible failures instead of replaying the same account.
func groupRequestSingleAttempt(ctx context.Context) bool {
	_, bounded := requestbudget.Deadline(ctx)
	return bounded
}
