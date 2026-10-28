package status

import (
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestWindowQuery(t *testing.T) {
	loc, _ := time.LoadLocation(Timezone)
	now := time.Date(2026, 9, 30, 14, 37, 12, 0, loc)
	c := &Component{loc: loc, clock: func() time.Time { return now }}
	window := func(query string) Window {
		g, _ := gin.CreateTestContext(httptest.NewRecorder())
		g.Request = httptest.NewRequest("GET", "/status?"+query, nil)
		return c.window(g)
	}

	// Ten minutes a bar: 144 bars, the last one the current ten minutes.
	w := window("hours=24&step=10")
	require.Equal(t, 144, w.Count)
	require.Equal(t, 10*time.Minute, w.Step)
	require.Equal(t, time.Date(2026, 9, 30, 14, 30, 0, 0, loc), w.slot(w.Count-1))
	require.Equal(t, time.Date(2026, 9, 29, 14, 40, 0, 0, loc), w.Start)
	// An earlier page ends where asked (on a bar's start); the hour form still reads.
	w = window("hours=24&step=10&end=2026-09-29T14:35")
	require.Equal(t, time.Date(2026, 9, 29, 14, 30, 0, 0, loc), w.slot(w.Count-1))
	w = window("hours=24&end=2026-09-29T14")
	require.Equal(t, 24, w.Count)
	require.Equal(t, time.Hour, w.Step)
	require.Equal(t, time.Date(2026, 9, 29, 14, 0, 0, 0, loc), w.slot(w.Count-1))
	// A step that does not divide an hour is an hour; a later end is now.
	w = window("hours=2&step=7&end=2026-10-02T00:00")
	require.Equal(t, time.Hour, w.Step)
	require.Equal(t, time.Date(2026, 9, 30, 14, 0, 0, 0, loc), w.slot(w.Count-1))
	// Days as before.
	w = window("days=3")
	require.False(t, w.Hourly)
	require.Equal(t, 3, w.Count)
}
