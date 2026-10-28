package status

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func day(t *testing.T, loc *time.Location, s string) time.Time {
	d, err := time.ParseInLocation("2006-01-02", s, loc)
	require.NoError(t, err)
	return d
}

func TestLevelOf(t *testing.T) {
	require.Equal(t, LevelNone, levelOf(0, 0))
	require.Equal(t, LevelOperational, levelOf(100, 0))
	require.Equal(t, LevelOperational, levelOf(100, 10), "90% is operational")
	require.Equal(t, LevelDegraded, levelOf(100, 11))
	require.Equal(t, LevelDegraded, levelOf(100, 50), "50% is degraded")
	require.Equal(t, LevelOutage, levelOf(100, 51), "below 50% is an outage")
	require.Equal(t, LevelOperational, levelOf(3, 0))
	// Fewer than two checks: degraded at worst, even with none passing.
	require.Equal(t, LevelDegraded, levelOf(1, 1), "one failed check is not an outage")
	require.Equal(t, LevelOperational, levelOf(1, 0))
	require.Equal(t, LevelOutage, levelOf(2, 2), "two failed checks are")
}

func TestCurrentLevel(t *testing.T) {
	require.Equal(t, LevelNone, currentLevel(nil))
	require.Equal(t, LevelOperational, currentLevel([]string{"operational", "error"}))
	require.Equal(t, LevelDegraded, currentLevel([]string{"degraded"}))
	require.Equal(t, LevelDegraded, currentLevel([]string{"error", "operational"}), "one failure")
	require.Equal(t, LevelOutage, currentLevel([]string{"failed", "error", "operational"}), "twice in a row")
}

func TestBuildOverview(t *testing.T) {
	loc, _ := time.LoadLocation(Timezone)
	start, end := day(t, loc, "2026-09-28"), day(t, loc, "2026-09-30")
	now := end.Add(12 * time.Hour)
	channels := []Channel{
		{ID: 1, Name: "codex", Platform: "openai", Model: "gpt-6-sol"},
		{ID: 2, Name: "grok", Platform: "grok", Model: "grok-4.6"},
	}
	counts := []DayCounts{
		{MonitorID: 1, Model: "gpt-6-sol", Day: day(t, loc, "2026-09-29"), Total: 100, Operational: 100},
		{MonitorID: 1, Model: "gpt-6-sol", Day: day(t, loc, "2026-09-30"), Total: 100, Operational: 80, Failed: 20},
		{MonitorID: 2, Model: "grok-4.6", Day: day(t, loc, "2026-09-30"), Total: 50, Operational: 49, Failed: 1},
		// Outside the window: ignored.
		{MonitorID: 1, Model: "gpt-6-sol", Day: day(t, loc, "2026-09-01"), Total: 100, Failed: 100},
	}
	latest := map[key][]string{
		{1, "gpt-6-sol"}: {"error", "failed"},
		{2, "grok-4.6"}:  {"operational"},
	}
	incidents := []Incident{{ID: 7, Title: "xAI slow", Platform: "grok", Impact: ImpactDegraded,
		StartedAt: day(t, loc, "2026-09-28").Add(3 * time.Hour), ResolvedAt: ptr(day(t, loc, "2026-09-28").Add(5 * time.Hour))}}

	o := BuildOverview(channels, counts, latest, incidents, dayWindow(start, end), loc, now)
	require.Equal(t, "2026-09-28", o.Start)
	require.Equal(t, "2026-09-30", o.End)
	require.Len(t, o.Platforms, 2)
	// One row a channel, by its name, in the channels' order.
	openai, xai := o.Platforms[0], o.Platforms[1]
	require.Equal(t, "codex", openai.Name)
	require.Equal(t, "openai", openai.Provider)
	require.Equal(t, LevelOperational, openai.Level, "the mark follows the window's uptime: 90%")
	require.InDelta(t, 90, *openai.Uptime, 0.001, "the uptime beside it is the window's")
	require.Equal(t, 100, openai.Recent.Checks)
	require.Equal(t, 20, openai.Recent.Failed)
	require.Equal(t, []string{LevelNone, LevelOperational, LevelDegraded},
		[]string{openai.Days[0].Level, openai.Days[1].Level, openai.Days[2].Level})
	require.Len(t, openai.Components, 1)
	require.Equal(t, "gpt-6-sol", openai.Components[0].Name)
	require.Equal(t, "codex", openai.Components[0].Channel)

	require.Equal(t, "grok", xai.Name)
	require.Equal(t, LevelOperational, xai.Level, "the incident is resolved")
	require.Equal(t, LevelNone, xai.Days[0].Level, "the colour is the uptime alone")
	require.Equal(t, []int64{7}, xai.Days[0].Incidents)
	require.Equal(t, LevelOperational, xai.Days[2].Level, "98% of the checks passed")
	require.Equal(t, LevelOperational, o.Level, "every channel at 90% or more")
}

func TestHourlyWindow(t *testing.T) {
	loc, _ := time.LoadLocation(Timezone)
	end := time.Date(2026, 9, 30, 14, 0, 0, 0, loc)
	w := Window{Start: end.Add(-23 * time.Hour), Step: time.Hour, Count: 24, Hourly: true}
	counts := []DayCounts{
		{MonitorID: 1, Model: "m", Day: end, Total: 12, Operational: 10, Failed: 2},
		{MonitorID: 1, Model: "m", Day: end.Add(-time.Hour), Total: 12, Operational: 12},
		// Outside the 24 hours: ignored.
		{MonitorID: 1, Model: "m", Day: end.Add(-24 * time.Hour), Total: 12, Failed: 12},
	}
	o := BuildOverview([]Channel{{ID: 1, Name: "codex", Platform: "openai", Model: "m"}}, counts,
		map[key][]string{{1, "m"}: {"error", "error"}}, nil, w, loc, end.Add(30*time.Minute))
	require.True(t, o.Hourly)
	require.Equal(t, 60, o.StepMinutes)
	require.Equal(t, "2026-09-29T15:00", o.Start)
	require.Equal(t, "2026-09-30T14:00", o.End)
	p := o.Platforms[0]
	require.Len(t, p.Days, 24)
	require.Equal(t, LevelDegraded, p.Days[23].Level, "10 of 12 passed: 83%")
	require.Equal(t, LevelOperational, p.Days[22].Level)
	require.Equal(t, LevelNone, p.Days[0].Level)
	require.Equal(t, 24, p.Checks)
	require.Equal(t, 2, p.Failed)
	require.Equal(t, LevelOperational, p.Level, "the mark follows the window: 91.7%, though the last hour had 10 of 12")
	require.Equal(t, RecentView{Checks: 12, Failed: 2, Uptime: p.Recent.Uptime}, p.Recent)
}

func TestTenMinuteWindow(t *testing.T) {
	loc, _ := time.LoadLocation(Timezone)
	end := time.Date(2026, 9, 30, 14, 50, 0, 0, loc)
	step := 10 * time.Minute
	w := Window{Start: end.Add(-143 * step), Step: step, Count: 144, Hourly: true}
	counts := []DayCounts{
		{MonitorID: 1, Model: "m", Day: end, Total: 3, Operational: 1, Failed: 2},
		{MonitorID: 1, Model: "m", Day: end.Add(-step), Total: 2, Operational: 2},
	}
	o := BuildOverview([]Channel{{ID: 1, Name: "codex", Platform: "openai", Model: "m"}}, counts,
		map[key][]string{{1, "m"}: {"operational"}}, nil, w, loc, end.Add(5*time.Minute))
	require.Equal(t, 10, o.StepMinutes)
	require.Equal(t, "2026-09-29T15:00", o.Start)
	require.Equal(t, "2026-09-30T14:50", o.End)
	p := o.Platforms[0]
	require.Len(t, p.Days, 144)
	require.Equal(t, LevelOutage, p.Days[143].Level, "one of three passed")
	require.Equal(t, LevelOperational, p.Days[142].Level)
	require.Equal(t, "2026-09-30T14:40", p.Days[142].Date)
}

func TestTheMarkIsTheWindowsUptime(t *testing.T) {
	loc, _ := time.LoadLocation(Timezone)
	end := time.Date(2026, 9, 30, 14, 50, 0, 0, loc)
	step := 10 * time.Minute
	w := Window{Start: end.Add(-143 * step), Step: step, Count: 144, Hourly: true}
	build := func(failedSlots int) PlatformView {
		var counts []DayCounts
		for i := 0; i < 144; i++ {
			c := DayCounts{MonitorID: 1, Model: "m", Day: w.slot(i), Total: 2, Operational: 2}
			if i < failedSlots {
				c.Operational, c.Failed = 0, 2
			}
			counts = append(counts, c)
		}
		return BuildOverview([]Channel{{ID: 1, Name: "grok", Platform: "grok", Model: "m"}}, counts,
			map[key][]string{{1, "m"}: {"operational"}}, nil, w, loc, end.Add(5*time.Minute)).Platforms[0]
	}
	// Failing all morning, fine in the last hour: the window's uptime decides.
	p := build(138)
	require.Equal(t, LevelOutage, p.Level, "4% over the window")
	require.Equal(t, 12, p.Recent.Checks)
	require.Equal(t, 0, p.Recent.Failed)
	require.InDelta(t, 100*12.0/288, *p.Uptime, 0.001)
	require.Equal(t, LevelOutage, p.Components[0].Level)
	require.Equal(t, LevelOperational, build(14).Level, "90.3%")
	require.Equal(t, LevelDegraded, build(15).Level, "89.6%")
	require.Equal(t, LevelDegraded, build(28).Level, "80.6%")
	require.Equal(t, LevelOutage, build(29).Level, "79.9%")
}

func TestOpenIncidentRaisesItsProvider(t *testing.T) {
	loc, _ := time.LoadLocation(Timezone)
	end := day(t, loc, "2026-09-30")
	o := BuildOverview([]Channel{{ID: 1, Name: "codex", Platform: "openai", Model: "m"}}, nil,
		map[key][]string{{1, "m"}: {"operational"}},
		[]Incident{{ID: 1, Platform: "", Impact: ImpactOutage, StartedAt: end}}, dayWindow(end, end), loc, end.Add(time.Hour))
	require.Equal(t, LevelOutage, o.Platforms[0].Level, "an incident for every service touches every provider")
	require.Equal(t, LevelNone, o.Platforms[0].Days[0].Level, "no checks that day")
	require.Equal(t, []int64{1}, o.Platforms[0].Days[0].Incidents)
}

func TestDecide(t *testing.T) {
	// Channel "openai" checks two models, "grok" one.
	channels := []Channel{
		{ID: 1, Name: "openai", Platform: "openai", Model: "a"},
		{ID: 1, Name: "openai", Platform: "openai", Model: "b"},
		{ID: 3, Name: "grok", Platform: "grok", Model: "c"},
	}
	down := map[key][]string{
		{1, "a"}: {"error", "error"},
		{1, "b"}: {"operational", "operational"},
		{3, "c"}: {"operational", "degraded"},
	}
	acts := decide(channels, down, nil)
	require.Equal(t, []action{{platform: "openai", open: true, impact: ImpactDegraded}}, acts)

	// Already covered by an open incident: nothing new.
	require.Empty(t, decide(channels, down, []Incident{{ID: 4, Platform: "openai"}}))
	require.Empty(t, decide(channels, down, []Incident{{ID: 4, Platform: ""}}), "an incident for every service covers it")

	// Every channel down: an outage.
	all := map[key][]string{{1, "a"}: {"failed", "error"}, {1, "b"}: {"error", "failed"}, {3, "c"}: {"operational", "operational"}}
	require.Equal(t, ImpactOutage, decide(channels, all, nil)[0].impact)

	// Healthy again: its own incident resolves, one an administrator took over stays.
	healthy := map[key][]string{{1, "a"}: {"operational", "degraded"}, {1, "b"}: {"operational", "operational"},
		{3, "c"}: {"operational", "operational"}}
	require.Equal(t, []action{{platform: "openai", resolve: 9}},
		decide(channels, healthy, []Incident{{ID: 9, Platform: "openai", Auto: true}}))
	require.Empty(t, decide(channels, healthy, []Incident{{ID: 9, Platform: "openai", Auto: true, touched: true}}))
	require.Empty(t, decide(channels, healthy, []Incident{{ID: 9, Platform: "openai"}}), "not its own")
	// Recovered once only: not yet.
	once := map[key][]string{{1, "a"}: {"operational", "error"}, {1, "b"}: {"operational", "operational"}}
	require.Empty(t, decide(channels[:2], once, []Incident{{ID: 9, Platform: "openai", Auto: true}}))
}

func TestIncidentInput(t *testing.T) {
	_, err := IncidentInput{}.normalize(true)
	require.Error(t, err, "a title is needed")
	in, err := IncidentInput{Title: " API errors ", Platform: " OpenAI "}.normalize(true)
	require.NoError(t, err)
	require.Equal(t, "API errors", in.Title)
	require.Equal(t, "openai", in.Platform)
	require.Equal(t, ImpactDegraded, in.Impact)
	require.Equal(t, StatusInvestigating, in.Status)
	_, err = IncidentInput{Title: "x", Status: "fixed"}.normalize(true)
	require.Error(t, err)
	_, err = IncidentInput{Impact: "minor"}.normalize(false)
	require.Error(t, err)
	partial, err := IncidentInput{Status: "Monitoring"}.normalize(false)
	require.NoError(t, err)
	require.Equal(t, StatusMonitoring, partial.Status)
	require.Equal(t, "", partial.Impact, "an update leaves the impact as it is")
}

func ptr[T any](v T) *T { return &v }

func TestUptimeLevelFollowsTheShownUptime(t *testing.T) {
	require.Equal(t, LevelNone, uptimeLevel(0, 0))
	require.Equal(t, LevelOperational, uptimeLevel(1000, 66), "93.4% is operational")
	require.Equal(t, LevelOperational, uptimeLevel(100, 10), "90% is operational")
	require.Equal(t, LevelDegraded, uptimeLevel(1000, 108), "89.2% is degraded")
	require.Equal(t, LevelDegraded, uptimeLevel(100, 20), "80% is degraded")
	require.Equal(t, LevelOutage, uptimeLevel(100, 21))
}
