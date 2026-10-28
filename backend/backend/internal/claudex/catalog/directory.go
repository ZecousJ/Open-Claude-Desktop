package catalog

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/mail"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type directoryInput struct {
	Kind              string               `json:"kind"`
	Name              string               `json:"name"`
	Slug              string               `json:"slug"`
	URL               string               `json:"url"`
	Description       string               `json:"description"`
	Examples          string               `json:"examples"`
	Email             string               `json:"email"`
	License           string               `json:"license"`
	TermsAcknowledged bool                 `json:"termsAcknowledged"`
	ToolsVerified     bool                 `json:"toolsVerified"`
	ServerName        string               `json:"serverName,omitempty"`
	Author            string               `json:"author,omitempty"`
	SupportURL        string               `json:"supportUrl,omitempty"`
	DocumentationURL  string               `json:"documentationUrl,omitempty"`
	IsAuthless        *bool                `json:"isAuthless,omitempty"`
	Tools             []string             `json:"tools"`
	ServerURLType     string               `json:"serverUrlType,omitempty"`
	RemoteURLOptions  []directoryURLOption `json:"remoteUrlOptions,omitempty"`
	RemoteURLRegex    string               `json:"remoteUrlRegex,omitempty"`
	RemoteURLTemplate string               `json:"remoteUrlTemplate,omitempty"`
	RemoteUserConfig  *directoryUserConfig `json:"remoteUserConfig,omitempty"`
	TestServerURL     string               `json:"testServerUrl,omitempty"`
	Curation          *directoryCuration   `json:"curation,omitempty"`
}

type directoryURLOption struct {
	URL   string `json:"url"`
	Label string `json:"label,omitempty"`
}

type directoryUserConfig struct {
	Title       string `json:"title"`
	Description string `json:"description"`
	Placeholder string `json:"placeholder"`
	Pattern     string `json:"pattern"`
}

var directoryTemplateSlot = regexp.MustCompile(`\$\{user_config\.([a-z][a-z0-9_]{0,31})\}|\{([a-z][a-z0-9_]{0,31})\}`)
var directoryPatternDomain = regexp.MustCompile(`(?:^|\\\.(?:\)[+*?]?)?)(?:[a-z0-9-]+\\\.)+[a-z0-9-]+$`)
var directoryUnsafeSubdomain = regexp.MustCompile(`(^|[^\\])\.|\\[SDW]|\[\^|/`)
var directoryAllowedCharacters = regexp.MustCompile(`^\^\[((?:[A-Za-z0-9_]|[a-z]-[a-z]|[A-Z]-[A-Z]|[0-9]-[0-9])+-?)\](\+|\{[0-9]+\}|\{[0-9]+,[0-9]+\})\$$`)

func validDirectoryURL(address string) bool {
	parsed, err := url.Parse(address)
	return err == nil && parsed.Scheme == "https" && parsed.Hostname() != "" && parsed.User == nil
}

func validDirectoryURLConfiguration(input directoryInput) bool {
	switch input.ServerURLType {
	case "", "universal":
		return true
	case "multiple":
		if len(input.RemoteURLOptions) == 0 || len(input.RemoteURLOptions) > 10 {
			return false
		}
		matched := false
		for _, option := range input.RemoteURLOptions {
			if len(option.URL) > 2048 || len(option.Label) > 80 || !validDirectoryURL(option.URL) {
				return false
			}
			matched = matched || option.URL == input.URL
		}
		return matched
	case "regex":
		pattern := input.RemoteURLRegex
		if len(pattern) > 200 || !strings.HasPrefix(pattern, "^https://") || !strings.HasSuffix(pattern, "$") || strings.ContainsAny(pattern, "|@") {
			return false
		}
		compiled, err := regexp.Compile(pattern)
		host := strings.SplitN(pattern[9:], "/", 2)[0]
		domain := directoryPatternDomain.FindStringIndex(host)
		if domain == nil || directoryUnsafeSubdomain.MatchString(host[:domain[0]]) {
			return false
		}
		return err == nil && compiled.MatchString(input.URL) && len(input.TestServerURL) <= 2048 && validDirectoryURL(input.TestServerURL) && compiled.MatchString(input.TestServerURL)
	case "template":
		config := input.RemoteUserConfig
		if config == nil || len(input.RemoteURLTemplate) > 400 || len(directoryTemplateSlot.FindAllString(input.RemoteURLTemplate, -1)) != 1 || len(config.Title) == 0 || len(config.Title) > 80 || len(config.Description) == 0 || len(config.Description) > 120 || len(config.Placeholder) == 0 || len(config.Placeholder) > 253 || len(config.Pattern) > 200 {
			return false
		}
		compiled, err := regexp.Compile(config.Pattern)
		if err != nil || !directoryAllowedCharacters.MatchString(config.Pattern) || !compiled.MatchString(config.Placeholder) {
			return false
		}
		parts := directoryTemplateSlot.Split(input.RemoteURLTemplate, -1)
		if !strings.HasPrefix(input.URL, parts[0]) || !strings.HasSuffix(input.URL, parts[1]) || len(input.URL) < len(parts[0])+len(parts[1]) {
			return false
		}
		value := input.URL[len(parts[0]) : len(input.URL)-len(parts[1])]
		return compiled.MatchString(value) && validDirectoryURL(directoryTemplateSlot.ReplaceAllStringFunc(input.RemoteURLTemplate, func(string) string { return config.Placeholder }))
	default:
		return false
	}
}

type directoryCuration struct {
	Topic            string   `json:"topic,omitempty"`
	PublisherURL     string   `json:"publisherUrl,omitempty"`
	SupportURL       string   `json:"supportUrl,omitempty"`
	Categories       []string `json:"categories,omitempty"`
	PrivacyPolicyURL string   `json:"privacyPolicyUrl,omitempty"`
	IconURL          string   `json:"iconUrl,omitempty"`
	RelatedIDs       []string `json:"relatedIds,omitempty"`
	IsTrending       bool     `json:"isTrending,omitempty"`
	IsNew            bool     `json:"isNew,omitempty"`
	InChatUI         bool     `json:"inChatUi,omitempty"`
	Popular          bool     `json:"popular,omitempty"`
	Featured         *struct {
		Title     string    `json:"title"`
		Subtitle  string    `json:"subtitle"`
		Curator   string    `json:"curator,omitempty"`
		MemberIDs *[]string `json:"memberIds,omitempty"`
	} `json:"featured,omitempty"`
}

func validDirectoryCuration(curation *directoryCuration) bool {
	if curation == nil {
		return true
	}
	if len(curation.Topic) > 200 || len(curation.Categories) > 20 || len(curation.RelatedIDs) > 50 {
		return false
	}
	for _, address := range []string{curation.PublisherURL, curation.PrivacyPolicyURL, curation.IconURL} {
		if address != "" && (len(address) > 2000 || !validDirectoryURL(address)) {
			return false
		}
	}
	if curation.SupportURL != "" && !validDirectoryURL(curation.SupportURL) {
		link, err := url.Parse(curation.SupportURL)
		if err != nil || link.Scheme != "mailto" || link.RawQuery != "" || link.Fragment != "" {
			return false
		}
		if _, err := mail.ParseAddress(link.Opaque); err != nil {
			return false
		}
	}
	if len(curation.SupportURL) > 2000 {
		return false
	}
	for _, category := range curation.Categories {
		if strings.TrimSpace(category) == "" || len(category) > 200 {
			return false
		}
	}
	for _, id := range curation.RelatedIDs {
		if strings.TrimSpace(id) == "" || len(id) > 256 {
			return false
		}
	}
	if curation.Featured != nil && curation.Featured.MemberIDs != nil {
		if len(*curation.Featured.MemberIDs) > 50 {
			return false
		}
		for _, id := range *curation.Featured.MemberIDs {
			if strings.TrimSpace(id) == "" || len(id) > 256 {
				return false
			}
		}
	}
	return curation.Featured == nil || (strings.TrimSpace(curation.Featured.Title) != "" && len(curation.Featured.Title) <= 200 && len(curation.Featured.Subtitle) <= 2000 && len(curation.Featured.Curator) <= 200)
}

type directorySubmission struct {
	directoryInput
	ID           string `json:"id"`
	UserID       int64  `json:"userId,omitempty"`
	Status       string `json:"status"`
	ReviewerNote string `json:"reviewerNote"`
	UpdatedAt    int64  `json:"updatedAt"`
}

var directorySlug = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

func validDirectoryInput(input directoryInput, submit bool) bool {
	if input.Kind != "plugin" && input.Kind != "mcp" {
		return false
	}
	for _, field := range []struct {
		value string
		limit int
	}{{input.Name, 200}, {input.Slug, 100}, {input.URL, 2000}, {input.Description, 10000}, {input.Examples, 10000}, {input.Email, 254}, {input.License, 200}, {input.ServerName, 200}} {
		if len(field.value) > field.limit {
			return false
		}
	}
	if !directorySlug.MatchString(input.Slug) || len(input.Tools) > 2000 {
		return false
	}
	if len(input.Author) > 200 {
		return false
	}
	for _, address := range []string{input.SupportURL, input.DocumentationURL} {
		if address == "" {
			continue
		}
		parsed, err := url.Parse(address)
		if len(address) > 2000 || err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil {
			return false
		}
	}
	for _, tool := range input.Tools {
		if len(tool) == 0 || len(tool) > 200 {
			return false
		}
	}
	if !submit {
		if len(input.RemoteURLRegex) > 200 || len(input.RemoteURLTemplate) > 400 || len(input.TestServerURL) > 2048 || len(input.RemoteURLOptions) > 10 {
			return false
		}
		return true
	}
	if input.Kind == "mcp" && !validDirectoryURLConfiguration(input) {
		return false
	}
	parsed, err := url.Parse(input.URL)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil {
		return false
	}
	_, err = mail.ParseAddress(input.Email)
	return err == nil && input.TermsAcknowledged && strings.TrimSpace(input.Name) != "" && strings.TrimSpace(input.Description) != "" && (input.Kind != "mcp" || (input.ToolsVerified && len(input.Tools) > 0))
}

func (c *Component) registerDirectoryRoutes(g *gin.RouterGroup) {
	g.GET("/directory", c.directoryApproved)
	g.GET("/directory/submissions", c.directoryList)
	g.POST("/directory/submissions", c.directorySave)
	g.PUT("/directory/submissions/:id", c.directorySave)
	g.DELETE("/directory/submissions/:id", c.directoryWithdraw)
	g.POST("/skills/scan", c.scanSkill)
}

func (c *Component) registerDirectoryAdminRoutes(g *gin.RouterGroup, stepUp gin.HandlerFunc) {
	g.GET("/directory/submissions", c.directoryAdminList)
	g.PUT("/directory/submissions/:id/review", stepUp, c.directoryReview)
}

func (c *Component) directoryDB(g *gin.Context) *sql.DB {
	if c.env == nil || c.env.DB == nil {
		response.Error(g, http.StatusServiceUnavailable, "Failed to submit. You can try again.")
		return nil
	}
	g.Header("Cache-Control", "no-store")
	return c.env.DB
}

const directoryColumns = `id, user_id, input, status, reviewer_note, updated_at`

func readDirectoryRow(row interface{ Scan(...any) error }) (directorySubmission, error) {
	var submission directorySubmission
	var input []byte
	var updated time.Time
	err := row.Scan(&submission.ID, &submission.UserID, &input, &submission.Status, &submission.ReviewerNote, &updated)
	if err == nil {
		err = json.Unmarshal(input, &submission.directoryInput)
	}
	submission.UpdatedAt = updated.UnixMilli()
	return submission, err
}

func (c *Component) directoryRows(g *gin.Context, filter string, args ...any) {
	db := c.directoryDB(g)
	if db == nil {
		return
	}
	rows, err := db.QueryContext(g.Request.Context(), `SELECT `+directoryColumns+` FROM claudex_directory_submissions WHERE withdrawn_at IS NULL AND `+filter+` ORDER BY updated_at DESC`, args...)
	if err != nil {
		response.Error(g, 500, "Failed to load submissions")
		return
	}
	defer rows.Close()
	items := []directorySubmission{}
	for rows.Next() {
		item, err := readDirectoryRow(rows)
		if err != nil {
			response.Error(g, 500, "Failed to load submissions")
			return
		}
		items = append(items, item)
	}
	if rows.Err() != nil {
		response.Error(g, 500, "Failed to load submissions")
		return
	}
	response.Success(g, items)
}

func (c *Component) directoryList(g *gin.Context) {
	userID, ok := core.Subject(g)
	if !ok {
		response.Error(g, 401, "Unauthorized")
		return
	}
	c.directoryRows(g, "user_id=$1", userID)
}

func (c *Component) directoryAdminList(g *gin.Context) { c.directoryRows(g, "status <> 'draft'") }

func (c *Component) directoryApproved(g *gin.Context) {
	db := c.directoryDB(g)
	if db == nil {
		return
	}
	rows, err := db.QueryContext(g.Request.Context(), `SELECT id, input, updated_at FROM claudex_directory_submissions WHERE status='approved' AND withdrawn_at IS NULL ORDER BY updated_at DESC`)
	if err != nil {
		response.Error(g, 500, "Failed to load submissions")
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id string
		var raw []byte
		var updated time.Time
		var input directoryInput
		if rows.Scan(&id, &raw, &updated) != nil || json.Unmarshal(raw, &input) != nil {
			response.Error(g, 500, "Failed to load submissions")
			return
		}
		item := map[string]any{"id": id, "kind": input.Kind, "name": input.Name, "slug": input.Slug, "description": input.Description, "url": input.URL, "added": updated.UTC().Format(time.RFC3339), "tools": input.Tools}
		if input.Author != "" {
			item["author"] = input.Author
		}
		if input.SupportURL != "" {
			item["supportUrl"] = input.SupportURL
		}
		if input.DocumentationURL != "" {
			item["documentationUrl"] = input.DocumentationURL
		}
		if input.IsAuthless != nil {
			item["isAuthless"] = *input.IsAuthless
		}
		if input.Curation != nil {
			item["curation"] = input.Curation
		}
		if input.ServerURLType != "" && input.ServerURLType != "universal" {
			item["serverUrlType"] = input.ServerURLType
			item["remoteUrlOptions"] = input.RemoteURLOptions
			item["remoteUrlRegex"] = input.RemoteURLRegex
			item["remoteUrlTemplate"] = input.RemoteURLTemplate
			item["remoteUserConfig"] = input.RemoteUserConfig
			item["testServerUrl"] = input.TestServerURL
		}
		items = append(items, item)
	}
	if rows.Err() != nil {
		response.Error(g, 500, "Failed to load submissions")
		return
	}
	response.Success(g, items)
}

func (c *Component) directorySave(g *gin.Context) {
	userID, ok := core.Subject(g)
	if !ok {
		response.Error(g, 401, "Unauthorized")
		return
	}
	var body struct {
		Input  directoryInput `json:"input"`
		Submit bool           `json:"submit"`
	}
	g.Request.Body = http.MaxBytesReader(g.Writer, g.Request.Body, 512*1024)
	if g.ShouldBindJSON(&body) != nil || !validDirectoryInput(body.Input, body.Submit) {
		response.Error(g, 400, "Failed to submit. You can try again.")
		return
	}
	db := c.directoryDB(g)
	if db == nil {
		return
	}
	status := "draft"
	if body.Submit {
		status = "submitted"
	}
	body.Input.Curation = nil
	input, _ := json.Marshal(body.Input)
	id := g.Param("id")
	var row *sql.Row
	if id == "" {
		id = uuid.NewString()
		row = db.QueryRowContext(g.Request.Context(), `INSERT INTO claudex_directory_submissions (id,user_id,input,status) VALUES ($1,$2,$3,$4) RETURNING `+directoryColumns, id, userID, input, status)
	} else {
		if _, err := uuid.Parse(id); err != nil {
			response.Error(g, 404, "That submission wasn’t found in this organization.")
			return
		}
		row = db.QueryRowContext(g.Request.Context(), `UPDATE claudex_directory_submissions SET input=$3,status=$4,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND status IN ('draft','submitted') AND withdrawn_at IS NULL RETURNING `+directoryColumns, id, userID, input, status)
	}
	submission, err := readDirectoryRow(row)
	if errors.Is(err, sql.ErrNoRows) {
		response.Error(g, 409, "That submission wasn’t found in this organization.")
		return
	}
	if err != nil {
		response.Error(g, 409, "Failed to submit. You can try again.")
		return
	}
	response.Success(g, submission)
}

func (c *Component) directoryWithdraw(g *gin.Context) {
	userID, ok := core.Subject(g)
	if !ok {
		response.Error(g, 401, "Unauthorized")
		return
	}
	if _, err := uuid.Parse(g.Param("id")); err != nil {
		response.Error(g, 404, "That submission wasn’t found in this organization.")
		return
	}
	db := c.directoryDB(g)
	if db == nil {
		return
	}
	result, err := db.ExecContext(g.Request.Context(), `UPDATE claudex_directory_submissions SET withdrawn_at=NOW(),updated_at=NOW() WHERE id=$1 AND user_id=$2 AND withdrawn_at IS NULL`, g.Param("id"), userID)
	if err != nil {
		response.Error(g, 500, "Failed to submit. You can try again.")
		return
	}
	count, _ := result.RowsAffected()
	if count == 0 {
		response.Error(g, 404, "That submission wasn’t found in this organization.")
		return
	}
	response.Success(g, true)
}

func (c *Component) directoryReview(g *gin.Context) {
	reviewerID, ok := core.Subject(g)
	if !ok {
		response.Error(g, 401, "Unauthorized")
		return
	}
	var body struct {
		Status   string             `json:"status"`
		Note     string             `json:"note"`
		Curation *directoryCuration `json:"curation"`
	}
	g.Request.Body = http.MaxBytesReader(g.Writer, g.Request.Body, 32*1024)
	if g.ShouldBindJSON(&body) != nil || (body.Status != "in_review" && body.Status != "approved" && body.Status != "rejected") || len(body.Note) > 10000 || !validDirectoryCuration(body.Curation) {
		response.Error(g, 400, "Failed to submit. You can try again.")
		return
	}
	if _, err := uuid.Parse(g.Param("id")); err != nil {
		response.Error(g, 404, "That submission wasn’t found in this organization.")
		return
	}
	db := c.directoryDB(g)
	if db == nil {
		return
	}
	var curation any
	if body.Curation != nil {
		encoded, _ := json.Marshal(body.Curation)
		curation = string(encoded)
	}
	row := db.QueryRowContext(g.Request.Context(), `UPDATE claudex_directory_submissions SET status=$2,reviewer_note=$3,reviewer_id=$4,input=CASE WHEN $5::jsonb IS NULL THEN input ELSE jsonb_set(input,'{curation}',$5::jsonb) END,updated_at=NOW() WHERE id=$1 AND status <> 'draft' AND withdrawn_at IS NULL RETURNING `+directoryColumns, g.Param("id"), body.Status, body.Note, reviewerID, curation)
	submission, err := readDirectoryRow(row)
	if errors.Is(err, sql.ErrNoRows) {
		response.Error(g, 404, "That submission wasn’t found in this organization.")
		return
	}
	if err != nil {
		response.Error(g, 500, "Failed to submit. You can try again.")
		return
	}
	response.Success(g, submission)
}
