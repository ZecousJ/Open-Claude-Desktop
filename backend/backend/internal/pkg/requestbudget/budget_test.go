// CLAUDEX: Request-scoped group failover with one shared generation budget.
package requestbudget

import (
	"context"
	"testing"
	"testing/synctest"
	"time"
)

func TestTotalBudgetSharedAcrossAttempts(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		start := time.Now()
		ctx, cancel := Start(context.Background())
		defer cancel()
		deadline, _ := Deadline(ctx)
		if deadline.Sub(start) != Total {
			t.Fatal("expected one budget of Total")
		}
		attempts := 0
		for ctx.Err() == nil {
			next, stop := Start(ctx)
			if actual, _ := next.Deadline(); actual != deadline {
				t.Fatal("attempt reset deadline")
			}
			attempts++
			select {
			case <-time.After(11 * time.Second):
			case <-next.Done():
			}
			stop()
		}
		if attempts != int((Total+11*time.Second-1)/(11*time.Second)) || time.Since(start) != Total || !Expired(ctx) {
			t.Fatalf("attempts=%d elapsed=%v expired=%v", attempts, time.Since(start), Expired(ctx))
		}
	})
}

func TestEarlierCallerDeadlineWins(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		parent, done := context.WithTimeout(context.Background(), 7*time.Second)
		defer done()
		ctx, cancel := Start(parent)
		defer cancel()
		deadline, _ := parent.Deadline()
		if actual, _ := ctx.Deadline(); actual != deadline {
			t.Fatal("extended caller deadline")
		}
		<-ctx.Done()
		if !Expired(ctx) {
			t.Fatal("earlier deadline must be a timeout")
		}
	})
}

func TestDetachKeepsBudgetButAllowsUsageDrainOnCancellation(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		parent, disconnect := context.WithCancel(context.Background())
		ctx, cancel := Start(parent)
		defer cancel()
		detached, stop := Detach(ctx)
		defer stop()
		disconnect()
		if ctx.Err() != context.Canceled || detached.Err() != nil || Expired(ctx) {
			t.Fatal("client cancellation lost")
		}
		<-detached.Done()
		if detached.Err() != context.DeadlineExceeded {
			t.Fatal("detached request escaped budget")
		}
	})
}

func TestStartAtDoesNotRefreshBudget(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := Start(context.Background())
		defer cancel()
		first, _ := Deadline(ctx)
		time.Sleep(20 * time.Second)
		next, stop := StartAt(ctx, time.Now().Add(Total))
		defer stop()
		if actual, _ := Deadline(next); actual != first {
			t.Fatal("failover refreshed turn deadline")
		}
	})
}
