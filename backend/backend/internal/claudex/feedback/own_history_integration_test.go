//go:build integration

package feedback

import (
	"context"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestB34SQLWithdrawalOwnershipReplayAndConcurrentIntake(t *testing.T) {
	db := freshDB(t, false)
	store := &sqlStore{db: db}
	ctx := context.Background()
	id := "eb526839-061b-44e0-9fe2-621d8d80f116"
	excerpt := "synthetic private excerpt"
	row := feedbackRow{FeedbackUUID: id, Rating: "down", Comment: "synthetic comment", ConversationExcerpt: &excerpt}
	res, err := store.insertFeedback(ctx, 1, row, 100)
	require.NoError(t, err)
	require.Equal(t, 1, res.Accepted)
	require.ErrorIs(t, store.withdrawFeedback(ctx, 2, id), ErrReportNotFound)
	rows, err := store.listOwnFeedback(ctx, 2, nil, 50)
	require.NoError(t, err)
	require.Empty(t, rows)
	rows, err = store.listOwnFeedback(ctx, 1, nil, 50)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	var wg sync.WaitGroup
	errs := make(chan error, 9)
	wg.Add(1)
	go func() { defer wg.Done(); errs <- store.withdrawFeedback(ctx, 1, id) }()
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, e := store.insertFeedback(ctx, 1, row, 100); errs <- e }()
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		require.NoError(t, e)
	}
	store = &sqlStore{db: db}
	require.NoError(t, store.withdrawFeedback(ctx, 1, id))
	res, err = store.insertFeedback(ctx, 1, row, 100)
	require.NoError(t, err)
	require.Equal(t, 1, res.Duplicates)
	require.Zero(t, res.Accepted)
	rows, err = store.listOwnFeedback(ctx, 1, nil, 50)
	require.NoError(t, err)
	require.Empty(t, rows)
	var count int
	require.NoError(t, db.QueryRow(`SELECT COUNT(*) FROM claudex_feedback`).Scan(&count))
	require.Zero(t, count)
	require.NoError(t, db.QueryRow(`SELECT COUNT(*) FROM claudex_feedback_withdrawals WHERE user_id=1`).Scan(&count))
	require.Equal(t, 1, count)
	res, err = store.insertFeedback(ctx, 2, row, 100)
	require.NoError(t, err)
	require.Equal(t, 1, res.Accepted)
	require.ErrorIs(t, store.withdrawFeedback(ctx, 3, id), ErrReportNotFound)
}

func TestB34SQLHistoryPagesWhileCollectionDisabled(t *testing.T) {
	db := freshDB(t, false)
	store := &sqlStore{db: db}
	ctx := context.Background()
	for _, id := range []string{"eb526839-061b-44e0-9fe2-621d8d80f116", "eb526839-061b-44e0-9fe2-621d8d80f117", "eb526839-061b-44e0-9fe2-621d8d80f118"} {
		_, err := store.insertFeedback(ctx, 1, feedbackRow{FeedbackUUID: id, Rating: "up", Comment: id}, 100)
		require.NoError(t, err)
	}
	f := newFixture(t, fixtureOptions{db: db})
	f.userID = 1
	seen := map[string]bool{}
	cursor := ""
	for i := 0; i < 3; i++ {
		response := f.do("GET", "/api/v1/claudex/feedback/history?limit=1&cursor="+cursor, "")
		require.Equal(t, 200, response.Status)
		var page struct {
			Items []ownFeedbackItem `json:"items"`
			Next  string            `json:"nextCursor"`
		}
		response.into(t, &page)
		require.Len(t, page.Items, 1)
		require.False(t, seen[page.Items[0].ID])
		seen[page.Items[0].ID] = true
		cursor = page.Next
		if i == 0 {
			f.userID = 2
			require.Equal(t, 400, f.do("GET", "/api/v1/claudex/feedback/history?cursor="+cursor, "").Status)
			f.userID = 1
		}
	}
	require.Empty(t, cursor)
	require.Len(t, seen, 3)
	f.userID = 2
	require.Equal(t, 404, f.do("DELETE", "/api/v1/claudex/feedback/history/eb526839-061b-44e0-9fe2-621d8d80f116", "").Status)
	f.userID = 1
	require.Equal(t, 200, f.do("DELETE", "/api/v1/claudex/feedback/history/eb526839-061b-44e0-9fe2-621d8d80f116", "").Status)
	require.Equal(t, 200, f.do("DELETE", "/api/v1/claudex/feedback/history/eb526839-061b-44e0-9fe2-621d8d80f116", "").Status)
}

func TestB34SQLWithdrawalWriteFailureRollsBackTombstone(t *testing.T) {
	db := freshDB(t, false)
	store := &sqlStore{db: db}
	ctx := context.Background()
	id := "eb526839-061b-44e0-9fe2-621d8d80f116"
	_, err := store.insertFeedback(ctx, 1, feedbackRow{FeedbackUUID: id, Rating: "down", Comment: "retained until committed"}, 100)
	require.NoError(t, err)
	_, err = db.Exec(`CREATE FUNCTION deny_feedback_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic write failure'; END $$; CREATE TRIGGER deny_feedback_delete BEFORE DELETE ON claudex_feedback FOR EACH ROW EXECUTE FUNCTION deny_feedback_delete()`)
	require.NoError(t, err)
	require.Error(t, store.withdrawFeedback(ctx, 1, id))
	var count int
	require.NoError(t, db.QueryRow(`SELECT COUNT(*) FROM claudex_feedback_withdrawals`).Scan(&count))
	require.Zero(t, count)
	rows, err := store.listOwnFeedback(ctx, 1, nil, 10)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	_, err = db.Exec(`DROP TRIGGER deny_feedback_delete ON claudex_feedback`)
	require.NoError(t, err)
	require.NoError(t, store.withdrawFeedback(ctx, 1, id))
}
