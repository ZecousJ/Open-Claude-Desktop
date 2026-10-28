// CLAUDEX: Request-scoped group failover with one shared generation budget.
package requestbudget

import (
	"context"
	"testing"
	"testing/synctest"
	"time"
)

func TestTurnsShareDeadlineAcrossAccountAttempts(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, turns := NewTurns(context.Background())
		defer turns.Stop()
		started := time.Now()
		turns.Begin(started)
		for i := 0; i < 5; i++ {
			time.Sleep(10 * time.Second)
			turns.Begin(time.Now())
		}
		deadline, _ := Deadline(ctx)
		if deadline != started.Add(Total) {
			t.Fatal("account attempt restarted turn deadline")
		}
		<-ctx.Done()
		if time.Since(started) != Total || !Expired(ctx) {
			t.Fatal("active turn escaped its budget")
		}
	})
}

func TestIdleWebSocketSurvivesAndNextTurnGetsFreshBudget(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, turns := NewTurns(context.Background())
		defer turns.Stop()
		turns.Begin(time.Now())
		time.Sleep(20 * time.Second)
		turns.Complete()
		time.Sleep(10 * time.Minute)
		if ctx.Err() != nil {
			t.Fatal("idle connection timed out")
		}
		if _, ok := Deadline(ctx); ok {
			t.Fatal("idle connection retains active budget")
		}
		start := time.Now()
		turns.Begin(start)
		<-ctx.Done()
		if time.Since(start) != Total {
			t.Fatal("next turn did not receive a fresh budget")
		}
	})
}

func TestTurnParentCancellationAndShorterDeadline(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		parent, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		ctx, turns := NewTurns(parent)
		defer turns.Stop()
		turns.Begin(time.Now())
		<-ctx.Done()
		if !Expired(ctx) {
			t.Fatal("shorter parent deadline was not preserved")
		}
	})
}
