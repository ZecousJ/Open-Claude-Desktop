package announce

import (
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
)

// Status of an announcement as stored. "expired" is never stored: a
// published announcement past expires_at reads as expired.
const (
	StatusDraft     = "draft"
	StatusPublished = "published"
	StatusWithdrawn = "withdrawn"
	StatusExpired   = "expired"
)

// Body formats.
const (
	FormatText = "text"
	FormatHTML = "html"
)

// Read actions the apps report.
var readActions = map[string]bool{"primary": true, "dismiss": true, "close": true}

// Limits.
const (
	maxTitle        = 200
	maxBadge        = 40
	maxLabel        = 60
	maxURL          = 2048
	maxBodyHTML     = 200_000
	maxMailSubject  = 200
	maxMailHTML     = 500_000
	maxRecipients   = 500
	maxDurationHrs  = 24 * 366
	requestBodySize = 1 << 20
)

// row is one claudex_announcements row.
type row struct {
	ID           int64
	Title        string
	Badge        string
	BodyHTML     string
	BodyFormat   string
	ImageURL     string
	PrimaryLabel string
	PrimaryURL   string
	DismissLabel string
	Status       string
	PublishedAt  *time.Time
	ExpiresAt    *time.Time
	CreatedBy    int64
	CreatedAt    time.Time
	UpdatedAt    time.Time
	// Reads counts the users who closed it (admin list only).
	Reads int64
}

// state is the status as people see it at now.
func (r *row) state(now time.Time) string {
	if r.Status == StatusPublished && r.ExpiresAt != nil && !now.Before(*r.ExpiresAt) {
		return StatusExpired
	}
	return r.Status
}

// Content is what an administrator writes (create and update bodies).
type Content struct {
	Title    string `json:"title"`
	Badge    string `json:"badge"`
	BodyHTML string `json:"body_html"`
	// BodyFormat: "text" (the default template: the lines become paragraphs)
	// or "html" (the administrator's own HTML, drawn in a frame).
	BodyFormat   string `json:"body_format"`
	ImageURL     string `json:"image_url"`
	PrimaryLabel string `json:"primary_label"`
	PrimaryURL   string `json:"primary_url"`
	DismissLabel string `json:"dismiss_label"`
}

// AdminDTO is an announcement in the admin API.
type AdminDTO struct {
	ID int64 `json:"id"`
	Content
	Status      string     `json:"status"`
	PublishedAt *time.Time `json:"published_at"`
	ExpiresAt   *time.Time `json:"expires_at"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
	Reads       int64      `json:"reads"`
}

// UserDTO is an announcement the apps show.
type UserDTO struct {
	ID int64 `json:"id"`
	Content
	PublishedAt *time.Time `json:"published_at"`
	ExpiresAt   *time.Time `json:"expires_at"`
}

func (r *row) content() Content {
	return Content{
		Title: r.Title, Badge: r.Badge, BodyHTML: r.BodyHTML, BodyFormat: r.BodyFormat, ImageURL: r.ImageURL,
		PrimaryLabel: r.PrimaryLabel, PrimaryURL: r.PrimaryURL, DismissLabel: r.DismissLabel,
	}
}

func (r *row) admin(now time.Time) AdminDTO {
	return AdminDTO{
		ID: r.ID, Content: r.content(), Status: r.state(now), PublishedAt: r.PublishedAt,
		ExpiresAt: r.ExpiresAt, CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt, Reads: r.Reads,
	}
}

func (r *row) user() UserDTO {
	return UserDTO{ID: r.ID, Content: r.content(), PublishedAt: r.PublishedAt, ExpiresAt: r.ExpiresAt}
}

// mailRow is one claudex_announcement_mails row.
type mailRow struct {
	ID         int64      `json:"id"`
	Subject    string     `json:"subject"`
	BodyHTML   string     `json:"body_html"`
	Recipients int        `json:"recipients"`
	Sent       int        `json:"sent"`
	Failed     int        `json:"failed"`
	Status     string     `json:"status"`
	CreatedAt  time.Time  `json:"created_at"`
	FinishedAt *time.Time `json:"finished_at"`
}

// Errors.
var (
	ErrNotFound    = infraerrors.NotFound("CLAUDEX_ANNOUNCEMENT_NOT_FOUND", "That announcement doesn't exist.")
	ErrUnavailable = infraerrors.ServiceUnavailable("CLAUDEX_ANNOUNCEMENTS_UNAVAILABLE",
		"Announcements need the database.")
	ErrMailOff = infraerrors.Conflict("CLAUDEX_ANNOUNCEMENT_MAIL_OFF",
		"This service can't send e-mail: set up SMTP in the settings first.")
	errStoreFailed = infraerrors.InternalServer("CLAUDEX_ANNOUNCEMENTS_STORE_FAILED",
		"The announcements couldn't be read or saved.")
)

func invalid(field, message string) error {
	return infraerrors.New(http.StatusBadRequest, "CLAUDEX_ANNOUNCEMENT_INVALID", message).
		WithMetadata(map[string]string{"field": field})
}

func tooLong(value string, limit int) bool { return utf8.RuneCountInString(value) > limit }

// checkURL accepts "" or an absolute https (or http) address.
func checkURL(field, value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", nil
	}
	if len(value) > maxURL {
		return "", invalid(field, "That address is too long.")
	}
	u, err := url.Parse(value)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return "", invalid(field, "Use an https:// address.")
	}
	return value, nil
}

// normalize trims and checks what an administrator wrote.
func (in Content) normalize() (Content, error) {
	out := Content{
		Title:        strings.TrimSpace(in.Title),
		Badge:        strings.TrimSpace(in.Badge),
		BodyHTML:     in.BodyHTML,
		BodyFormat:   strings.ToLower(strings.TrimSpace(in.BodyFormat)),
		PrimaryLabel: strings.TrimSpace(in.PrimaryLabel),
		DismissLabel: strings.TrimSpace(in.DismissLabel),
	}
	if out.BodyFormat == "" {
		out.BodyFormat = FormatText
	}
	switch {
	case out.BodyFormat != FormatText && out.BodyFormat != FormatHTML:
		return Content{}, invalid("body_format", "The content is text or HTML.")
	case tooLong(out.Title, maxTitle):
		return Content{}, invalid("title", "The title can be up to 200 characters.")
	case tooLong(out.Badge, maxBadge):
		return Content{}, invalid("badge", "The badge can be up to 40 characters.")
	case len(out.BodyHTML) > maxBodyHTML:
		return Content{}, invalid("body_html", "The content can be up to 200 KB.")
	case tooLong(out.PrimaryLabel, maxLabel):
		return Content{}, invalid("primary_label", "The button text can be up to 60 characters.")
	case tooLong(out.DismissLabel, maxLabel):
		return Content{}, invalid("dismiss_label", "The button text can be up to 60 characters.")
	}
	if out.Title == "" && strings.TrimSpace(out.BodyHTML) == "" {
		return Content{}, invalid("title", "Write a title or some content.")
	}
	var err error
	if out.ImageURL, err = checkURL("image_url", in.ImageURL); err != nil {
		return Content{}, err
	}
	if out.PrimaryURL, err = checkURL("primary_url", in.PrimaryURL); err != nil {
		return Content{}, err
	}
	if out.PrimaryURL != "" && out.PrimaryLabel == "" {
		return Content{}, invalid("primary_label", "Give the button a text.")
	}
	return out, nil
}
