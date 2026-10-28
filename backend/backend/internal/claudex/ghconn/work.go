package ghconn

// Claudex: what a Code session's window reads from GitHub with the user's
// own connection (owner, 2026-10-12), beside cloning and the model's own
// tools (actions.go): the open issues of a repository for Import GitHub
// issue and one issue's text (the branch row's pull request is pulls.go).
// Both are reads; the token never leaves the service, and GitHub's answers
// are cut down to what the window shows.

import (
	"errors"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"

	"github.com/gin-gonic/gin"
)

const (
	// maxIssueQuery is the longest search text the list takes.
	maxIssueQuery = 200
	// issuesPerPage is how many issues the list shows (one GitHub page).
	issuesPerPage = 50
	// maxIssueBody cuts an issue's text; the window trims further for the model.
	maxIssueBody = 100_000
)

var (
	issueNumberQuery = regexp.MustCompile(`^#?(\d{1,9})$`)
	commitSHA        = regexp.MustCompile(`^[0-9a-fA-F]{7,64}$`)
)

// Issue is one row of the Import GitHub issue list.
type Issue struct {
	Number     int      `json:"number"`
	Title      string   `json:"title"`
	State      string   `json:"state"`
	Repository string   `json:"repository"`
	URL        string   `json:"url"`
	Labels     []string `json:"labels"`
}

// IssueDetail is an issue with the text an imported issue carries.
type IssueDetail struct {
	Issue
	Body              string `json:"body"`
	Author            string `json:"author"`
	AuthorAssociation string `json:"author_association"`
}

// IssuesPage is the answer of GET .../web/github/issues.
type IssuesPage struct {
	Items []Issue `json:"items"`
}

// wireIssue is GitHub's issue object (a search hit has the same fields).
type wireIssue struct {
	Number            int     `json:"number"`
	Title             string  `json:"title"`
	State             string  `json:"state"`
	HTMLURL           string  `json:"html_url"`
	Body              *string `json:"body"`
	AuthorAssociation string  `json:"author_association"`
	User              *struct {
		Login string `json:"login"`
	} `json:"user"`
	Labels []struct {
		Name string `json:"name"`
	} `json:"labels"`
	// PullRequest is present when the "issue" is a pull request.
	PullRequest map[string]any `json:"pull_request"`
}

func (w wireIssue) isPull() bool { return w.PullRequest != nil }

func (w wireIssue) issue(repo string) Issue {
	labels := make([]string, 0, len(w.Labels))
	for _, l := range w.Labels {
		labels = append(labels, l.Name)
	}
	state := "open"
	if strings.EqualFold(w.State, "closed") {
		state = "closed"
	}
	return Issue{Number: w.Number, Title: w.Title, State: state, Repository: repo, URL: w.HTMLURL, Labels: labels}
}

// repoParam reads ?repo=owner/name; it answers the 400 itself when the
// parameter is not a repository.
func repoParam(g *gin.Context) (RepoRef, bool) {
	parts := strings.Split(g.Query("repo"), "/")
	if len(parts) != 2 || !validOwner(parts[0]) || !validName(parts[1]) {
		response.ErrorFrom(g, infraerrors.BadRequest(ReasonBadRepo, "repo must be owner/name"))
		return RepoRef{}, false
	}
	return RepoRef{Owner: parts[0], Name: parts[1]}, true
}

func repoPath(ref RepoRef) string {
	return "/repos/" + url.PathEscape(ref.Owner) + "/" + url.PathEscape(ref.Name)
}

// issueSearchQuery is the search text of the list: the person's own, else
// what involves them (the original lists "involves:@me" until they type).
func issueSearchQuery(ref RepoRef, text string) string {
	if text == "" {
		text = "involves:@me"
	}
	return "repo:" + ref.FullName() + " is:issue is:open " + text
}

// cleanQuery folds line breaks into spaces and trims the search text.
func cleanQuery(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

// listIssues answers the open issues of a repository: those the user is
// involved with, or any that match the search text. A search text that is a
// number also finds that issue (GitHub's search matches words, not numbers).
func (c *Component) listIssues(g *gin.Context) {
	uid, ok := c.userID(g)
	if !ok {
		return
	}
	ref, ok := repoParam(g)
	if !ok {
		return
	}
	text := cleanQuery(g.Query("query"))
	if len(text) > maxIssueQuery {
		response.ErrorFrom(g, infraerrors.BadRequest(ReasonBadRepo, "The search text is too long."))
		return
	}
	ctx := g.Request.Context()
	token, err := c.accessToken(ctx, uid)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	out := IssuesPage{Items: []Issue{}}
	repo := ref.FullName()
	if m := issueNumberQuery.FindStringSubmatch(text); m != nil {
		var w wireIssue
		switch err := c.gh.get(ctx, token, repoPath(ref)+"/issues/"+m[1], nil, &w); {
		case err == nil:
			if !w.isPull() && strings.EqualFold(w.State, "open") {
				out.Items = append(out.Items, w.issue(repo))
			}
		case errors.Is(err, errNotFound):
			// No such issue: the search may still find the number in a title.
		default:
			response.ErrorFrom(g, c.mapUpstream(ctx, uid, err))
			return
		}
	}
	var found struct {
		Items []wireIssue `json:"items"`
	}
	q := url.Values{"q": {issueSearchQuery(ref, text)}, "per_page": {strconv.Itoa(issuesPerPage)}}
	if err := c.gh.get(ctx, token, "/search/issues", q, &found); err != nil {
		response.ErrorFrom(g, c.mapUpstream(ctx, uid, err))
		return
	}
	for _, w := range found.Items {
		if w.isPull() || hasIssue(out.Items, w.Number) {
			continue
		}
		out.Items = append(out.Items, w.issue(repo))
	}
	response.Success(g, out)
}

func hasIssue(items []Issue, number int) bool {
	for _, it := range items {
		if it.Number == number {
			return true
		}
	}
	return false
}

// numberParam reads ?number=N (a positive issue or pull request number).
func numberParam(g *gin.Context) (int, bool) {
	n, err := strconv.Atoi(g.Query("number"))
	if err != nil || n < 1 || n > 999_999_999 {
		response.ErrorFrom(g, infraerrors.BadRequest(ReasonBadRepo, "number must be an issue number"))
		return 0, false
	}
	return n, true
}

// getIssue answers one issue with its text, for importing it into a
// message. A pull request is not an issue here.
func (c *Component) getIssue(g *gin.Context) {
	uid, ok := c.userID(g)
	if !ok {
		return
	}
	ref, ok := repoParam(g)
	if !ok {
		return
	}
	number, ok := numberParam(g)
	if !ok {
		return
	}
	ctx := g.Request.Context()
	token, err := c.accessToken(ctx, uid)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	var w wireIssue
	if err := c.gh.get(ctx, token, repoPath(ref)+"/issues/"+strconv.Itoa(number), nil, &w); err != nil {
		response.ErrorFrom(g, c.mapUpstream(ctx, uid, err))
		return
	}
	if w.isPull() {
		response.ErrorFrom(g, infraerrors.NotFound(ReasonNoAccess, "That is a pull request, not an issue."))
		return
	}
	detail := IssueDetail{Issue: w.issue(ref.FullName()), AuthorAssociation: w.AuthorAssociation}
	if w.Body != nil {
		detail.Body = truncate(*w.Body, maxIssueBody)
	}
	if w.User != nil {
		detail.Author = w.User.Login
	}
	response.Success(g, detail)
}
