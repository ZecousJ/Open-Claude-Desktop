package accountguard

import (
	"sort"
	"time"
)

// Thresholds (owner, 2026-10-10: an account that keeps failing is taken out
// of scheduling and comes back once a probe answers again).
const (
	window          = 10 * time.Minute
	consecutiveTrip = 3 // the last three attempts failed
	ratioMinSamples = 6 // or more than half of at least six attempts
	ratioMinFails   = 3

	// Probes: a paused account is asked every minute at first, then twice
	// as rarely after each failed probe, at most hourly; an account the
	// service marked as broken (401 and the like) every ten minutes. Two
	// probes in a row must answer before it is scheduled again.
	degradedFirstProbe = time.Minute
	errorFirstProbe    = 10 * time.Minute
	maxProbeGap        = time.Hour
	// Three answers a minute apart: a relay that was paused and answered two
	// quick probes was back within two minutes and slow again (2026-10-10).
	recoverAfterOK = 3
	confirmGap     = time.Minute
	// pauseHold keeps a paused account unschedulable between probes; each
	// failed probe renews it, recovery clears it.
	pauseHold = 6 * time.Hour

	// A served request counts as failed when it crawled (owner, 2026-10-10):
	// a stream's first token after slowStreamMs, at any reasoning effort
	// (owner, 2026-10-14: high effort's first output comes as soon as the
	// others', 97% within 25 s, and the gateway now fails over at 20 s for
	// every effort); a
	// short reply (under slowShortReply tokens), streamed or not, after
	// slowShortMs in all (a relay that stalls after its first token, 14:18:
	// 3-token replies in 20 to 125 s); or a longer stream slower than
	// slowShortMs plus slowPerTokenMs a token. Over a day the short rule marks
	// 6 of 黑化 Pro's 366 and 0 of 大白's 30 against 20 to 24 of each relay's
	// 48 to 107, the long one 2 of 黑化 Pro's 316 against 25 of aijws's 301.
	// A probe slower than slowProbe does not count as an answer.
	slowStreamMs   = 20000
	slowShortMs    = 15000
	slowShortReply = 100
	slowPerTokenMs = 100
	slowProbe      = 10 * time.Second
)

// event is one attempt on an account: a failure the account is to blame for,
// or a request it served.
type event struct {
	at     time.Time
	failed bool
}

// verdict says whether the attempts in the window call for a pause, and why.
type verdict struct {
	trip        bool
	consecutive int
	fails       int
	total       int
}

// decide looks at an account's attempts of the last window.
func decide(events []event, now time.Time) verdict {
	recent := make([]event, 0, len(events))
	for _, e := range events {
		if now.Sub(e.at) <= window {
			recent = append(recent, e)
		}
	}
	sort.Slice(recent, func(i, j int) bool { return recent[i].at.After(recent[j].at) })
	v := verdict{total: len(recent)}
	counting := true
	for _, e := range recent {
		if e.failed {
			v.fails++
			if counting {
				v.consecutive++
			}
		} else {
			counting = false
		}
	}
	v.trip = v.consecutive >= consecutiveTrip ||
		(v.total >= ratioMinSamples && v.fails >= ratioMinFails && v.fails*2 > v.total)
	return v
}

// nextGap is the wait before the next probe after a failed one.
func nextGap(previous time.Duration) time.Duration {
	gap := previous * 2
	if gap <= 0 {
		gap = degradedFirstProbe
	}
	if gap > maxProbeGap {
		gap = maxProbeGap
	}
	return gap
}
