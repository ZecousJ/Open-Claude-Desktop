//go:build unit

package usage

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/lib/pq"
	"github.com/stretchr/testify/require"
)

var sessionNow = time.Date(2026, 10, 12, 9, 0, 0, 0, time.UTC)

func TestParseSessionUsageQuery(t *testing.T) {
	ids, since, err := parseSessionUsageQuery([]string{" thread-a ", "", "thread-b", "thread-a"}, "2026-10-12T08:00:00.000Z", sessionNow)
	require.NoError(t, err)
	require.Equal(t, []string{"thread-a", "thread-b"}, ids)
	require.Equal(t, time.Date(2026, 10, 12, 8, 0, 0, 0, time.UTC), since)

	// A start further back than the bound is brought forward to it.
	_, since, err = parseSessionUsageQuery([]string{"thread-a"}, "2020-01-01T00:00:00Z", sessionNow)
	require.NoError(t, err)
	require.Equal(t, sessionNow.Add(-maxSessionUsageAge), since)

	tooMany := make([]string, maxSessionUsageIDs+1)
	for i := range tooMany {
		tooMany[i] = "thread-" + strings.Repeat("x", i+1)
	}
	for name, tc := range map[string]struct {
		ids   []string
		since string
	}{
		"no ids":       {nil, "2026-10-12T08:00:00Z"},
		"blank ids":    {[]string{" ", ""}, "2026-10-12T08:00:00Z"},
		"too many ids": {tooMany, "2026-10-12T08:00:00Z"},
		"id too long":  {[]string{strings.Repeat("a", maxSessionIDLength+1)}, "2026-10-12T08:00:00Z"},
		"no start":     {[]string{"thread-a"}, ""},
		"bad start":    {[]string{"thread-a"}, "yesterday"},
		"future start": {[]string{"thread-a"}, "2026-10-12T10:00:00Z"},
	} {
		_, _, err := parseSessionUsageQuery(tc.ids, tc.since, sessionNow)
		require.ErrorIs(t, err, errBadSessionUsageQuery, name)
	}
}

func TestSessionUsageRoute(t *testing.T) {
	c, _ := newTestComponent(newFakeStore(), sessionNow)
	var gotUser int64
	var gotIDs []string
	var gotSince time.Time
	c.readSessionUsage = func(_ context.Context, userID int64, ids []string, since time.Time) ([]SessionUsageModel, error) {
		gotUser, gotIDs, gotSince = userID, ids, since
		return []SessionUsageModel{{Model: "gpt-5.5", Requests: 3, InputTokens: 1200, OutputTokens: 300, CacheReadTokens: 9000, CacheWriteTokens: 0, ActualCost: 0.42, DurationMs: 61000}}, nil
	}
	r := statusRouter(c, 11)

	rec := getJSON(r, "/api/v1/claudex/session-usage?session_id=thread-a&session_id=thread-b&since=2026-10-12T08:00:00Z")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
	require.Equal(t, int64(11), gotUser)
	require.Equal(t, []string{"thread-a", "thread-b"}, gotIDs)
	require.Equal(t, time.Date(2026, 10, 12, 8, 0, 0, 0, time.UTC), gotSince)
	var body struct {
		Code int          `json:"code"`
		Data SessionUsage `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Equal(t, 0, body.Code)
	require.Len(t, body.Data.Models, 1)
	require.Equal(t, int64(9000), body.Data.Models[0].CacheReadTokens)
	require.Contains(t, rec.Body.String(), `"cache_creation_tokens":0`)
	require.Contains(t, rec.Body.String(), `"duration_ms":61000`)

	// Nothing recorded yet: an empty list, never null.
	c.readSessionUsage = func(context.Context, int64, []string, time.Time) ([]SessionUsageModel, error) { return nil, nil }
	rec = getJSON(r, "/api/v1/claudex/session-usage?session_id=thread-a&since=2026-10-12T08:00:00Z")
	require.Equal(t, http.StatusOK, rec.Code)
	require.Contains(t, rec.Body.String(), `"models":[]`)

	rec = getJSON(r, "/api/v1/claudex/session-usage?since=2026-10-12T08:00:00Z")
	require.Equal(t, http.StatusBadRequest, rec.Code)

	c.readSessionUsage = func(context.Context, int64, []string, time.Time) ([]SessionUsageModel, error) { return nil, errTestDB }
	rec = getJSON(r, "/api/v1/claudex/session-usage?session_id=thread-a&since=2026-10-12T08:00:00Z")
	require.Equal(t, http.StatusInternalServerError, rec.Code)
}

func TestSessionUsageRouteNeedsSignIn(t *testing.T) {
	c, _ := newTestComponent(newFakeStore(), sessionNow)
	c.readSessionUsage = func(context.Context, int64, []string, time.Time) ([]SessionUsageModel, error) {
		t.Fatal("must not read without a user")
		return nil, nil
	}
	rec := getJSON(statusRouter(c, 0), "/api/v1/claudex/session-usage?session_id=thread-a&since=2026-10-12T08:00:00Z")
	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestSQLSessionUsage(t *testing.T) {
	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	defer func() { _ = db.Close() }()
	since := time.Date(2026, 10, 12, 8, 0, 0, 0, time.UTC)
	mock.ExpectQuery(regexp.QuoteMeta(selectSessionUsage)).
		WithArgs(int64(11), since, pq.Array([]string{"thread-a"}), maxSessionUsageModels).
		WillReturnRows(sqlmock.NewRows([]string{"usage_model", "count", "input", "output", "cache_read", "cache_write", "cost", "duration"}).
			AddRow("gpt-5.5", int64(3), int64(1200), int64(300), int64(9000), int64(0), 0.42, int64(61000)).
			AddRow("gpt-5.5-mini", int64(1), int64(50), int64(20), int64(0), int64(0), 0.01, int64(900)))
	store := sqlStore{db: func() *sql.DB { return db }}
	models, err := store.sessionUsage(context.Background(), 11, []string{"thread-a"}, since)
	require.NoError(t, err)
	require.Equal(t, []SessionUsageModel{
		{Model: "gpt-5.5", Requests: 3, InputTokens: 1200, OutputTokens: 300, CacheReadTokens: 9000, ActualCost: 0.42, DurationMs: 61000},
		{Model: "gpt-5.5-mini", Requests: 1, InputTokens: 50, OutputTokens: 20, ActualCost: 0.01, DurationMs: 900},
	}, models)
	require.NoError(t, mock.ExpectationsWereMet())

	_, err = sqlStore{}.sessionUsage(context.Background(), 11, []string{"thread-a"}, since)
	require.ErrorIs(t, err, errNoDB)
}
