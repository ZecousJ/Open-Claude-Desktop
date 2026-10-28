package onboarding

import (
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
)

// WorkFunctions are the roles of "What kind of work do you do?" and of the
// Settings work type, as the original stores them (live claude.ai bundle,
// 2026-10-12: shared-4 `Ok`, the work_function values).
var WorkFunctions = []string{
	"Product Management", "Engineering", "Human Resources", "Finance", "Marketing",
	"Sales", "Operations", "Data Science", "Design", "Legal", "Scientist", "Student",
	"Founder", "Healthcare", "Writer", "Educator", "Consultant", "Researcher",
	"SoftwareEngineer", "Other",
}

// HearAboutSources are the answers to "How did you get here?" (live claude.ai
// bundle, 2026-10-12: c10bf8b47 `Fo`).
var HearAboutSources = []string{
	"word_of_mouth", "work_employer", "social_media", "news_article", "search_engine",
	"online_ad", "tv", "podcast", "professional_event", "influencer", "other",
}

// HearAboutPlatforms are the answers to "Which one?" after Social media
// (c10bf8b47 `Io`).
var HearAboutPlatforms = []string{"x_twitter", "reddit", "youtube", "tiktok", "linkedin", "instagram", "other"}

// ScienceFields are the answers to "What kind of science do you do?" under
// the Scientist role (live claude.ai bundle, 2026-10-14, c10bf8b47 Dc).
var ScienceFields = []string{
	"biology", "chemistry", "clinical_medical", "computer_science_ml", "engineering",
	"materials_science", "mathematics", "physics", "social_sciences", "other",
}

// CodeSetups record what "Set up and start coding" led to.
var CodeSetups = []string{"desktop", "web", "skipped"}

// Limits.
const (
	maxOtherText   = 200
	maxTools       = 20
	maxToolName    = 100
	maxFirstTask   = 60
	requestBodyMax = 16 << 10
)

var firstTaskPattern = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)

// Answers are the stored answers; "" (or no tools) means not answered.
type Answers struct {
	WorkFunction      string   `json:"work_function"`
	HearAbout         string   `json:"hear_about"`
	HearAboutPlatform string   `json:"hear_about_platform"`
	HearAboutOther    string   `json:"hear_about_other"`
	CodeSetup         string   `json:"code_setup"`
	ConnectedTools    []string `json:"connected_tools"`
	FirstTask         string   `json:"first_task"`
	ScienceFields     []string `json:"science_fields"`
}

// row is one account's onboarding as stored.
type row struct {
	UserID     int64
	Answers    Answers
	StartedAt  time.Time
	FinishedAt *time.Time
	UpdatedAt  time.Time
}

// UserDTO is what the apps read.
type UserDTO struct {
	// Pending: the account signed up and has not finished; the apps show the
	// onboarding.
	Pending bool    `json:"pending"`
	Answers Answers `json:"answers"`
}

// AdminDTO is what the console's user dialog reads.
type AdminDTO struct {
	Found      bool       `json:"found"`
	Answers    Answers    `json:"answers"`
	StartedAt  *time.Time `json:"started_at"`
	FinishedAt *time.Time `json:"finished_at"`
}

// patch is a PUT body: only the fields present change. hear_about carries
// its platform and Other text with it (the original posts the three together).
type patch struct {
	WorkFunction      *string   `json:"work_function"`
	HearAbout         *string   `json:"hear_about"`
	HearAboutPlatform string    `json:"hear_about_platform"`
	HearAboutOther    string    `json:"hear_about_other"`
	CodeSetup         *string   `json:"code_setup"`
	ConnectedTools    *[]string `json:"connected_tools"`
	FirstTask         *string   `json:"first_task"`
	ScienceFields     *[]string `json:"science_fields"`
	// Finished ends the onboarding; it is never shown again.
	Finished bool `json:"finished"`
}

var (
	errUnavailable = infraerrors.ServiceUnavailable("CLAUDEX_ONBOARDING_UNAVAILABLE",
		"Onboarding answers need the database.")
	errStoreFailed = infraerrors.InternalServer("CLAUDEX_ONBOARDING_STORE_FAILED",
		"The onboarding answers couldn't be read or saved.")
)

func invalid(field, message string) error {
	return infraerrors.New(http.StatusBadRequest, "CLAUDEX_ONBOARDING_INVALID", message).
		WithMetadata(map[string]string{"field": field})
}

func oneOf(value string, allowed []string) bool {
	for _, a := range allowed {
		if value == a {
			return true
		}
	}
	return false
}

// cleanText trims a free answer, drops control characters and cuts it to
// limit runes.
func cleanText(value string, limit int) string {
	value = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, value)
	value = strings.Join(strings.Fields(value), " ")
	if utf8.RuneCountInString(value) > limit {
		value = string([]rune(value)[:limit])
	}
	return value
}

// apply checks the patch and writes it over a. It returns the first problem.
func (p *patch) apply(a *Answers) error {
	if p.WorkFunction != nil {
		v := strings.TrimSpace(*p.WorkFunction)
		if v != "" && !oneOf(v, WorkFunctions) {
			return invalid("work_function", "That isn't one of the work types.")
		}
		a.WorkFunction = v
	}
	if p.HearAbout != nil {
		v := strings.TrimSpace(*p.HearAbout)
		if v != "" && !oneOf(v, HearAboutSources) {
			return invalid("hear_about", "That isn't one of the answers.")
		}
		platform := ""
		if v == "social_media" {
			platform = strings.TrimSpace(p.HearAboutPlatform)
			if platform != "" && !oneOf(platform, HearAboutPlatforms) {
				return invalid("hear_about_platform", "That isn't one of the platforms.")
			}
		}
		other := ""
		if v == "other" || platform == "other" {
			other = cleanText(p.HearAboutOther, maxOtherText)
		}
		a.HearAbout, a.HearAboutPlatform, a.HearAboutOther = v, platform, other
	}
	if p.CodeSetup != nil {
		v := strings.TrimSpace(*p.CodeSetup)
		if v != "" && !oneOf(v, CodeSetups) {
			return invalid("code_setup", "That isn't one of the answers.")
		}
		a.CodeSetup = v
	}
	if p.ConnectedTools != nil {
		tools := []string{}
		seen := map[string]bool{}
		for _, raw := range *p.ConnectedTools {
			name := cleanText(raw, maxToolName)
			if name == "" || seen[name] {
				continue
			}
			if len(tools) == maxTools {
				return invalid("connected_tools", "Too many connectors.")
			}
			seen[name] = true
			tools = append(tools, name)
		}
		a.ConnectedTools = tools
	}
	if p.ScienceFields != nil {
		fields := []string{}
		seen := map[string]bool{}
		for _, raw := range *p.ScienceFields {
			v := strings.TrimSpace(raw)
			if !oneOf(v, ScienceFields) {
				return invalid("science_fields", "That isn't one of the fields.")
			}
			if !seen[v] {
				seen[v] = true
				fields = append(fields, v)
			}
		}
		a.ScienceFields = fields
	}
	if p.FirstTask != nil {
		v := strings.TrimSpace(*p.FirstTask)
		if v != "" && (len(v) > maxFirstTask || !firstTaskPattern.MatchString(v)) {
			return invalid("first_task", "That isn't a starter task.")
		}
		a.FirstTask = v
	}
	return nil
}

func (r *row) user() UserDTO {
	if r == nil {
		return UserDTO{Answers: Answers{ConnectedTools: []string{}, ScienceFields: []string{}}}
	}
	out := UserDTO{Pending: r.FinishedAt == nil, Answers: r.Answers}
	if out.Answers.ConnectedTools == nil {
		out.Answers.ConnectedTools = []string{}
	}
	if out.Answers.ScienceFields == nil {
		out.Answers.ScienceFields = []string{}
	}
	return out
}

func (r *row) admin() AdminDTO {
	if r == nil {
		return AdminDTO{Answers: Answers{ConnectedTools: []string{}, ScienceFields: []string{}}}
	}
	started := r.StartedAt
	out := AdminDTO{Found: true, Answers: r.Answers, StartedAt: &started, FinishedAt: r.FinishedAt}
	if out.Answers.ConnectedTools == nil {
		out.Answers.ConnectedTools = []string{}
	}
	if out.Answers.ScienceFields == nil {
		out.Answers.ScienceFields = []string{}
	}
	return out
}
