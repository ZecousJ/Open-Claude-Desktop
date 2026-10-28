package status

import (
	"time"
)

// DayView is one bar: a channel's or a provider's checks on a day.
type DayView struct {
	Date     string   `json:"date"`
	Level    string   `json:"level"`
	Uptime   *float64 `json:"uptime"`
	Checks   int      `json:"checks"`
	Degraded int      `json:"degraded"`
	Failed   int      `json:"failed"`
	// Incidents are the ids of the incidents that were open that day.
	Incidents []int64 `json:"incidents"`
}

// RecentView is the last hour of a window (the last day for a window of
// days): what a channel's mark and its info say.
type RecentView struct {
	Checks int      `json:"checks"`
	Failed int      `json:"failed"`
	Uptime *float64 `json:"uptime"`
}

// ComponentView is one channel's model.
type ComponentView struct {
	MonitorID int64  `json:"monitor_id"`
	Name      string `json:"name"`
	Channel   string `json:"channel"`
	// Level is the mark: the last hour's checks (Recent).
	Level  string     `json:"level"`
	Uptime *float64   `json:"uptime"`
	Recent RecentView `json:"recent"`
	Days   []DayView  `json:"days"`
}

// PlatformView is one Sub2API channel (a channel monitor) with the models it
// checks. Platform is its key (the monitor's name, what incidents name);
// Provider is the Sub2API platform it belongs to.
type PlatformView struct {
	Platform string `json:"platform"`
	Name     string `json:"name"`
	Provider string `json:"provider"`
	// Checks and Failed are the window's totals (the uptime beside the name).
	Checks int `json:"checks"`
	Failed int `json:"failed"`
	// Level is the mark: the last hour's checks (Recent) and open incidents.
	Level      string          `json:"level"`
	Uptime     *float64        `json:"uptime"`
	Recent     RecentView      `json:"recent"`
	Components []ComponentView `json:"components"`
	Days       []DayView       `json:"days"`
}

// Overview is what the apps' Service status page shows.
type Overview struct {
	Timezone string `json:"timezone"`
	Start    string `json:"start"`
	End      string `json:"end"`
	// Hourly: a bar is part of a day (labels "2006-01-02T15:04"), StepMinutes
	// long; else a day.
	Hourly      bool           `json:"hourly"`
	StepMinutes int            `json:"step_minutes"`
	GeneratedAt time.Time      `json:"generated_at"`
	Level       string         `json:"level"`
	Platforms   []PlatformView `json:"platforms"`
	// Incidents: the open ones and those resolved in the window, newest first.
	Incidents []Incident `json:"incidents"`
	// IQ: the latest IQ checks (iq.go), newest first; only on the user route.
	IQ []IQRun `json:"iq,omitempty"`
	// IQGroups: each check group's latest runs (iq.go iqGroups); user route.
	IQGroups []IQGroupRuns `json:"iq_groups,omitempty"`
	// IQExamples: the fixed normal and dumbed-down pages (iq.go); user route.
	IQExamples []IQExample `json:"iq_examples,omitempty"`
}

var levelRank = map[string]int{LevelNone: 0, LevelOperational: 1, LevelDegraded: 2, LevelOutage: 3}

func worse(a, b string) string {
	if levelRank[b] > levelRank[a] {
		return b
	}
	return a
}

// levelOf reads a stretch's success rate (the checks that passed; slow ones
// pass): 90% and up is operational, from 50% degraded, below 50% an outage
// (owner, 2026-10-02). A stretch with fewer than two checks is never an
// outage, only degraded, however they went (owner, 2026-10-03): one failed
// check is not enough to call it down.
func levelOf(total, failed int) string {
	passed := total - failed
	switch {
	case total == 0:
		return LevelNone
	case passed*10 >= total*9:
		return LevelOperational
	case passed*2 >= total, total < minOutageChecks:
		return LevelDegraded
	default:
		return LevelOutage
	}
}

// uptimeLevel is a channel's mark from the uptime shown beside it (the
// window's): below 90% degraded, below 80% an outage (owner, 2026-10-03).
func uptimeLevel(total, failed int) string {
	passed := total - failed
	switch {
	case total == 0:
		return LevelNone
	case passed*10 >= total*9:
		return LevelOperational
	case passed*10 >= total*8:
		return LevelDegraded
	default:
		return LevelOutage
	}
}

// minOutageChecks is the fewest checks a stretch needs to be an outage.
const minOutageChecks = 2

func uptime(total, failed int) *float64 {
	if total == 0 {
		return nil
	}
	u := float64(total-failed) / float64(total) * 100
	return &u
}

// currentLevel reads a channel's latest checks, newest first: failing twice
// in a row is an outage, once or slow is degraded.
func currentLevel(latest []string) string {
	if len(latest) == 0 {
		return LevelNone
	}
	failing := func(s string) bool { return s == checkFailed || s == checkError }
	switch {
	case failing(latest[0]) && len(latest) > 1 && failing(latest[1]):
		return LevelOutage
	case failing(latest[0]) || latest[0] == checkDegraded:
		return LevelDegraded
	default:
		return LevelOperational
	}
}

func impactLevel(impact string) string {
	if impact == ImpactOutage {
		return LevelOutage
	}
	return LevelDegraded
}

// Window is the stretch the bars cover: Count slots of Step each, the
// first starting at Start (in the service's time zone).
type Window struct {
	Start time.Time
	Step  time.Duration
	Count int
	// Hourly: the slots are parts of a day, Step long (labels
	// "2006-01-02T15:04"), else days.
	Hourly bool
}

func (w Window) slot(i int) time.Time {
	if w.Hourly {
		return w.Start.Add(time.Duration(i) * w.Step)
	}
	return w.Start.AddDate(0, 0, i)
}

func (w Window) label(t time.Time) string {
	if w.Hourly {
		return t.Format("2006-01-02T15:04")
	}
	return t.Format("2006-01-02")
}

// dayWindow is the days from start to end, inclusive.
func dayWindow(start, end time.Time) Window {
	n := 0
	for d := start; !d.After(end); d = d.AddDate(0, 0, 1) {
		n++
	}
	return Window{Start: start, Step: 24 * time.Hour, Count: n}
}

type key struct {
	monitor int64
	model   string
}

// BuildOverview puts the channels, their counts per slot, their latest
// checks and the incidents together for the window (in loc). A channel's
// state (its mark) follows the window's uptime shown beside it
// (uptimeLevel); a channel without checks in the window takes its latest
// checks.
func BuildOverview(channels []Channel, counts []DayCounts, latest map[key][]string, incidents []Incident,
	w Window, loc *time.Location, now time.Time) Overview {
	labels := make([]string, w.Count)
	index := map[string]int{}
	for i := range labels {
		labels[i] = w.label(w.slot(i))
		index[labels[i]] = i
	}
	byKey := map[key][]DayCounts{}
	for _, c := range counts {
		byKey[key{c.MonitorID, c.Model}] = append(byKey[key{c.MonitorID, c.Model}], c)
	}
	// The incidents open in each slot, and which channel they touch.
	type slotIncident struct {
		id       int64
		platform string
	}
	open := make([][]slotIncident, w.Count)
	for _, inc := range incidents {
		from := inc.StartedAt.In(loc)
		to := now.In(loc)
		if inc.ResolvedAt != nil {
			to = inc.ResolvedAt.In(loc)
		}
		for i := 0; i < w.Count; i++ {
			start := w.slot(i)
			next := w.slot(i + 1)
			if from.Before(next) && !to.Before(start) {
				open[i] = append(open[i], slotIncident{inc.ID, inc.Platform})
			}
		}
	}
	withIncidents := func(platform string, row []DayView) {
		for i := range row {
			for _, inc := range open[i] {
				if inc.platform != "" && inc.platform != platform {
					continue
				}
				// The bar's colour is the slot's uptime; the incident is listed with it.
				row[i].Incidents = append(row[i].Incidents, inc.id)
			}
		}
	}

	platforms := map[string]*PlatformView{}
	var order []string
	for _, ch := range channels {
		p := platforms[ch.Name]
		if p == nil {
			p = &PlatformView{Platform: ch.Name, Name: ch.Name, Provider: ch.Platform, Level: LevelNone,
				Components: []ComponentView{}, Days: emptyDays(labels)}
			platforms[ch.Name] = p
			order = append(order, ch.Name)
		}
		comp := ComponentView{MonitorID: ch.ID, Name: ch.Model, Channel: ch.Name, Days: emptyDays(labels)}
		var total, failed int
		for _, c := range byKey[key{ch.ID, ch.Model}] {
			i, ok := index[w.label(c.Day.In(loc))]
			if !ok {
				continue
			}
			addCounts(&comp.Days[i], c)
			addCounts(&p.Days[i], c)
			total += c.Total
			failed += c.Failed
		}
		finishDays(comp.Days)
		comp.Uptime = uptime(total, failed)
		comp.Recent = recent(comp.Days, w.recentSlots())
		comp.Level = uptimeLevel(total, failed)
		if total == 0 {
			comp.Level = currentLevel(latest[key{ch.ID, ch.Model}])
		}
		p.Components = append(p.Components, comp)
	}
	out := Overview{Timezone: loc.String(), Start: labels[0], End: labels[len(labels)-1], Hourly: w.Hourly,
		GeneratedAt: now, Level: LevelOperational, Platforms: []PlatformView{}, Incidents: incidents}
	if w.Hourly {
		out.StepMinutes = int(w.Step / time.Minute)
	}
	if out.Incidents == nil {
		out.Incidents = []Incident{}
	}
	// In the channels' own order (Sub2API's monitor ids).
	for _, name := range order {
		p := platforms[name]
		finishDays(p.Days)
		var total, failed int
		for _, d := range p.Days {
			total += d.Checks
			failed += d.Failed
		}
		p.Uptime = uptime(total, failed)
		p.Checks, p.Failed = total, failed
		p.Recent = recent(p.Days, w.recentSlots())
		p.Level = uptimeLevel(total, failed)
		if total == 0 {
			for _, comp := range p.Components {
				p.Level = worse(p.Level, comp.Level)
			}
		}
		withIncidents(p.Platform, p.Days)
		for i := range p.Components {
			withIncidents(p.Platform, p.Components[i].Days)
		}
		for _, inc := range incidents {
			if inc.ResolvedAt == nil && (inc.Platform == "" || inc.Platform == p.Platform) {
				p.Level = worse(p.Level, impactLevel(inc.Impact))
			}
		}
		if p.Level == LevelNone {
			p.Level = LevelOperational
		}
		out.Level = worse(out.Level, p.Level)
		out.Platforms = append(out.Platforms, *p)
	}
	for _, inc := range incidents {
		if inc.ResolvedAt == nil {
			out.Level = worse(out.Level, impactLevel(inc.Impact))
		}
	}
	return out
}

// recentSlots is how many of a window's last slots make its last hour (one
// slot for a window of days).
func (w Window) recentSlots() int {
	if !w.Hourly || w.Step <= 0 || w.Step >= time.Hour {
		return 1
	}
	return int(time.Hour / w.Step)
}

// recent sums the last n slots of a row.
func recent(row []DayView, n int) RecentView {
	var r RecentView
	for i := len(row) - n; i < len(row); i++ {
		if i < 0 {
			continue
		}
		r.Checks += row[i].Checks
		r.Failed += row[i].Failed
	}
	r.Uptime = uptime(r.Checks, r.Failed)
	return r
}

func emptyDays(days []string) []DayView {
	out := make([]DayView, len(days))
	for i, d := range days {
		out[i] = DayView{Date: d, Level: LevelNone, Incidents: []int64{}}
	}
	return out
}

func addCounts(d *DayView, c DayCounts) {
	d.Checks += c.Total
	d.Degraded += c.Degraded
	d.Failed += c.Failed
}

func finishDays(row []DayView) {
	for i := range row {
		row[i].Level = levelOf(row[i].Checks, row[i].Failed)
		row[i].Uptime = uptime(row[i].Checks, row[i].Failed)
	}
}
