package status

import (
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
)

// Handling statuses of an incident, in order.
const (
	StatusInvestigating = "investigating"
	StatusIdentified    = "identified"
	StatusMonitoring    = "monitoring"
	StatusResolved      = "resolved"
)

var statuses = map[string]bool{
	StatusInvestigating: true, StatusIdentified: true, StatusMonitoring: true, StatusResolved: true,
}

// Impacts of an incident.
const (
	ImpactDegraded = "degraded"
	ImpactOutage   = "outage"
)

// Levels of a day, a channel or a provider.
const (
	LevelNone        = "none" // no checks that day
	LevelOperational = "operational"
	LevelDegraded    = "degraded"
	LevelOutage      = "outage"
)

// Channel check statuses (Sub2API's MonitorStatus*).
const (
	checkOperational = "operational"
	checkDegraded    = "degraded"
	checkFailed      = "failed"
	checkError       = "error"
)

const (
	maxTitle        = 200
	maxMessage      = 5000
	maxPlatform     = 100
	requestBodySize = 64 << 10
	// DefaultDays is how many days the page shows; MaxDays the most it asks.
	DefaultDays = 90
	MaxDays     = 366
	// MaxHours: Sub2API keeps 30 days of checks.
	MaxHours = 720
	// DefaultStepMinutes is a bar's length within ?hours=; ?step= may ask
	// for one of stepMinutes instead.
	DefaultStepMinutes = 60
	// keepDays is how long the daily counts are kept.
	keepDays = 400
)

// stepMinutes are the bar lengths ?step= accepts (they divide an hour).
var stepMinutes = map[int]bool{10: true, 15: true, 20: true, 30: true, 60: true}

// Timezone is where a day starts for the bars (the service's people are in China).
const Timezone = "Asia/Shanghai"

// DayCounts is one channel's checks on one day.
type DayCounts struct {
	MonitorID   int64
	Model       string
	Day         time.Time
	Total       int
	Operational int
	Degraded    int
	Failed      int
}

// Channel is an enabled Sub2API channel monitor.
type Channel struct {
	ID       int64
	Name     string
	Platform string
	Model    string
}

// Incident is one incident with its updates, newest update first.
type Incident struct {
	ID       int64  `json:"id"`
	Title    string `json:"title"`
	Platform string `json:"platform"`
	Impact   string `json:"impact"`
	Status   string `json:"status"`
	Auto     bool   `json:"auto"`
	// Published: people see it; the ones the checks open start as drafts.
	Published  bool       `json:"published"`
	StartedAt  time.Time  `json:"started_at"`
	ResolvedAt *time.Time `json:"resolved_at"`
	UpdatedAt  time.Time  `json:"updated_at"`
	// Message is the latest update's message.
	Message string   `json:"message"`
	Updates []Update `json:"updates"`
	// touched: an administrator changed it (auto incidents then stay open until they resolve them).
	touched bool
}

// Update is one step of an incident's handling.
type Update struct {
	Status    string    `json:"status"`
	Message   string    `json:"message"`
	CreatedAt time.Time `json:"created_at"`
}

// IncidentInput is what an administrator writes.
type IncidentInput struct {
	Title    string `json:"title"`
	Platform string `json:"platform"`
	Impact   string `json:"impact"`
	Status   string `json:"status"`
	Message  string `json:"message"`
	// Published: nil keeps it as it is (a new incident is published unless false).
	Published *bool `json:"published"`
}

// Errors.
var (
	ErrNotFound    = infraerrors.NotFound("CLAUDEX_STATUS_INCIDENT_NOT_FOUND", "That incident doesn't exist.")
	ErrUnavailable = infraerrors.ServiceUnavailable("CLAUDEX_STATUS_UNAVAILABLE", "Service status needs the database.")
	errStoreFailed = infraerrors.InternalServer("CLAUDEX_STATUS_STORE_FAILED", "The service status couldn't be read or saved.")
)

func invalid(field, message string) error {
	return infraerrors.New(http.StatusBadRequest, "CLAUDEX_STATUS_INVALID", message).
		WithMetadata(map[string]string{"field": field})
}

// normalize checks a new incident (full) or an update (partial: empty fields keep theirs).
func (in IncidentInput) normalize(full bool) (IncidentInput, error) {
	out := IncidentInput{
		Title:     strings.TrimSpace(in.Title),
		Platform:  strings.ToLower(strings.TrimSpace(in.Platform)),
		Impact:    strings.ToLower(strings.TrimSpace(in.Impact)),
		Status:    strings.ToLower(strings.TrimSpace(in.Status)),
		Message:   strings.TrimSpace(in.Message),
		Published: in.Published,
	}
	if full {
		if out.Title == "" {
			return out, invalid("title", "Give the incident a title.")
		}
		if out.Impact == "" {
			out.Impact = ImpactDegraded
		}
		if out.Status == "" {
			out.Status = StatusInvestigating
		}
	}
	switch {
	case utf8.RuneCountInString(out.Title) > maxTitle:
		return out, invalid("title", "The title can be up to 200 characters.")
	case utf8.RuneCountInString(out.Message) > maxMessage:
		return out, invalid("message", "The message can be up to 5,000 characters.")
	case len(out.Platform) > maxPlatform:
		return out, invalid("platform", "That channel isn't known.")
	case out.Impact != "" && out.Impact != ImpactDegraded && out.Impact != ImpactOutage:
		return out, invalid("impact", "The impact is degraded or outage.")
	case out.Status != "" && !statuses[out.Status]:
		return out, invalid("status", "The status is investigating, identified, monitoring or resolved.")
	}
	return out, nil
}
