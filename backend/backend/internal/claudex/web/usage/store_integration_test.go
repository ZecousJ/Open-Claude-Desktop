//go:build integration

package usage

import (
	"context"
	"log"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core/testsupport"

	_ "github.com/lib/pq"
	"github.com/stretchr/testify/require"
)

// TestIntegrationWebUsageStore runs claudex_0082_web_usage.sql (twice) on
// PostgreSQL and checks links, runner records and the summaries.
func TestIntegrationWebUsageStore(t *testing.T) {
	ctx := context.Background()
	pg, err := testsupport.StartPostgres(ctx, "claudex_web_usage_test")
	if err != nil {
		if testsupport.Skip(err) {
			log.Printf("docker is not available; skipping: %v", err)
			t.Skip("docker is not available")
		}
		t.Fatalf("start postgres: %v", err)
	}
	t.Cleanup(func() { pg.Terminate(context.Background()) })
	db, err := pg.Open(ctx)
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })

	_, err = db.ExecContext(ctx, `CREATE TABLE users (id BIGSERIAL PRIMARY KEY, email VARCHAR(255) NOT NULL);
INSERT INTO users (id, email) VALUES (70, 'seventy@example.com'), (71, 'other@example.com');`)
	require.NoError(t, err)
	migration, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "migrations", "claudex_0082_web_usage.sql"))
	require.NoError(t, err)
	for i := 0; i < 2; i++ {
		_, err = db.ExecContext(ctx, string(migration))
		require.NoError(t, err, "the migration is idempotent")
	}

	c, _ := newTestComponent(t, "")
	c.db = db
	st := c.store()
	at := time.Date(2026, 9, 28, 8, 0, 0, 0, time.UTC)
	link := usageLink{RequestID: "client:a", APIKeyID: 7, UserID: 70, Conversation: "conv-1", WebSession: "ws", Model: "gpt-5", CostUSD: 0.125, At: at}
	require.NoError(t, st.insertLink(ctx, link))
	require.NoError(t, st.insertLink(ctx, link), "a request is linked once")
	require.NoError(t, st.insertLink(ctx, usageLink{RequestID: "client:b", APIKeyID: 7, UserID: 70, Conversation: "conv-1", Model: "grok-4", CostUSD: 0.5, At: at.Add(time.Minute)}))
	require.NoError(t, st.insertLink(ctx, usageLink{RequestID: "client:c", APIKeyID: 9, UserID: 71, Conversation: "conv-1", Model: "gpt-5", CostUSD: 9, At: at}))

	require.NoError(t, c.RecordRunnerUsage(ctx, RunnerUsage{UserID: 70, ConversationID: "conv-1", RunnerID: "dc6", Mode: ModeChat,
		StartedAt: at, EndedAt: at.Add(2 * time.Minute), CPUSeconds: 4, ExitReason: "completed"}))
	require.NoError(t, c.RecordRunnerUsage(ctx, RunnerUsage{UserID: 71, RunnerID: "dc6", Mode: ModeCowork, StartedAt: at, EndedAt: at.Add(time.Minute)}))

	conv, err := st.conversation(ctx, 70, "conv-1")
	require.NoError(t, err)
	require.Equal(t, int64(2), conv.Requests, "only the user's own requests")
	require.InDelta(t, 0.625, conv.CostUSD, 1e-9)
	require.Equal(t, []ModelUsage{{Model: "gpt-5", Requests: 1, CostUSD: 0.125}, {Model: "grok-4", Requests: 1, CostUSD: 0.5}}, conv.Models)
	require.Equal(t, RunnerTotals{Runs: 1, WallSeconds: 120, CPUSeconds: 4}, conv.Runner)
	require.True(t, conv.FirstAt.Equal(at))
	require.True(t, conv.LastAt.Equal(at.Add(time.Minute)))

	none, err := st.conversation(ctx, 70, "nothing")
	require.NoError(t, err)
	require.Equal(t, int64(0), none.Requests)
	require.Empty(t, none.Models)

	rows, err := st.conversations(ctx, 0, at.Add(-time.Hour), 10)
	require.NoError(t, err)
	require.Len(t, rows, 2)
	require.Equal(t, int64(70), rows[0].UserID, "latest first")
	require.Equal(t, "seventy@example.com", rows[0].UserEmail)
	rows, err = st.conversations(ctx, 71, at.Add(-time.Hour), 10)
	require.NoError(t, err)
	require.Len(t, rows, 1)

	sum, err := st.runnerSummary(ctx, 0, at.Add(-time.Hour))
	require.NoError(t, err)
	require.Len(t, sum, 2)
	require.Equal(t, ModeChat, sum[0].Mode)
	require.Equal(t, int64(1), sum[0].Users)
	require.InDelta(t, 60, sum[1].WallSeconds, 1e-9)

	// Deleting a user drops their rows.
	_, err = db.ExecContext(ctx, `DELETE FROM users WHERE id = 71`)
	require.NoError(t, err)
	rows, err = st.conversations(ctx, 71, at.Add(-time.Hour), 10)
	require.NoError(t, err)
	require.Empty(t, rows)
}
