//go:build unit

// CLAUDEX: Request-scoped group failover with one shared generation budget.
package service

import (
	"context"
	"errors"
	"net/http/httptest"
	"testing"
	"testing/synctest"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/pkg/requestbudget"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestGroupRequestBudgetPreservesRequestSentSafety(t *testing.T) {
	ctx, cancel := requestbudget.Start(context.Background())
	defer cancel()
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest("POST", "/v1/responses", nil).WithContext(ctx)
	svc := &OpenAIGatewayService{}
	original := &PluginTransportError{Code: "after_send", Message: "transport disconnected", RequestSent: true}
	err := svc.handleOpenAIUpstreamTransportError(ctx, c, &Account{ID: 1, Platform: PlatformOpenAI}, original, false)
	require.Same(t, original, err)
	var failover *UpstreamFailoverError
	require.False(t, errors.As(err, &failover), "a sent request must not be replayed on another account")
}

func TestGroupRequestBudgetDetachReleaseDoesNotCancelForward(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := requestbudget.Start(context.Background())
		defer cancel()
		upstream, release := detachStreamUpstreamContext(ctx, true)
		release() // Existing forwarders release immediately after constructing the request.
		require.NoError(t, upstream.Err())
		require.True(t, groupRequestSingleAttempt(upstream))
		time.Sleep(requestbudget.Total)
		synctest.Wait()
		require.ErrorIs(t, upstream.Err(), context.DeadlineExceeded)
		require.True(t, requestbudget.Expired(upstream))
	})
}

func TestGroupRequestBudgetDoesNotCancelAccountingCleanup(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := requestbudget.Start(context.Background())
		time.Sleep(requestbudget.Total)
		cancel()
		billing, stop := detachedBillingContext(ctx)
		defer stop()
		require.NoError(t, billing.Err())
		deadline, ok := billing.Deadline()
		require.True(t, ok)
		require.Equal(t, postUsageBillingTimeout, time.Until(deadline))
	})
}

func TestGroupRequestBudgetNativeWSDrainKeepsRemainingDeadline(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		parent, disconnect := context.WithCancel(context.Background())
		ctx, cancel := requestbudget.Start(parent)
		defer cancel()
		deadline, _ := ctx.Deadline()
		time.Sleep(20 * time.Second)
		disconnect()
		drain, release := detachUpstreamContext(ctx)
		defer release()
		require.NoError(t, drain.Err(), "client disconnect still permits bounded usage drain")
		remaining, ok := drain.Deadline()
		require.True(t, ok)
		require.Equal(t, deadline, remaining)
		require.Equal(t, requestbudget.Total-20*time.Second, time.Until(remaining))
		<-drain.Done()
		require.ErrorIs(t, drain.Err(), context.DeadlineExceeded)
	})
}
