package ghconn

// Claudex: what the model may do on a cloud Code session's GitHub repository
// besides cloning it (owner, 2026-10-03): push its commits, open pull
// requests and issues, comment, and read an issue or pull request. The
// runner asks on the link for the user it serves:
//   - "github.push" leases a credential like "github.clone" (the user must be
//     able to push); the runner runs git push outside the sandbox with it.
//   - "github.api" performs one action with the user's own token; the token
//     never leaves the service.
// Only the session's repository is named by the runner, and the user's
// token decides what GitHub allows.

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
)

// ReasonGitHubRefused is a request GitHub turned down (its own message).
const ReasonGitHubRefused = "CLAUDEX_GITHUB_REFUSED"

// apiRequest is the body of "github.api".
type apiRequest struct {
	ThreadID   string   `json:"threadId,omitempty"`
	CheckRunID int      `json:"checkRunId,omitempty"`
	CommentID  int      `json:"commentId,omitempty"`
	CommitSHA  string   `json:"commitSha,omitempty"`
	Line       int      `json:"line,omitempty"`
	StartLine  int      `json:"startLine,omitempty"`
	Side       string   `json:"side,omitempty"`
	Event      string   `json:"event,omitempty"`
	Branch     string   `json:"branch,omitempty"`
	Path       string   `json:"path,omitempty"`
	URL        string   `json:"url"`
	Action     string   `json:"action"`
	Title      string   `json:"title,omitempty"`
	Body       string   `json:"body,omitempty"`
	Head       string   `json:"head,omitempty"`
	Base       string   `json:"base,omitempty"`
	Draft      bool     `json:"draft,omitempty"`
	Number     int      `json:"number,omitempty"`
	Labels     []string `json:"labels,omitempty"`
}

// The limits of what the model may send.
const (
	maxTitleLength = 256
	maxBodyLength  = 65536
	maxLabels      = 20
)

// servePush leases a push credential for the session's repository.
func (c *Component) servePush(ctx context.Context, userID int64, body json.RawMessage) (any, error) {
	var req cloneRequest
	if err := json.Unmarshal(body, &req); err != nil {
		return nil, infraerrors.BadRequest(ReasonBadRepo, "The repository request is not valid.")
	}
	ref, err := parseRepoURL(req.URL, c.gh.webBase)
	if err != nil {
		return nil, infraerrors.BadRequest(ReasonBadRepo, "That isn't a GitHub repository address.")
	}
	token, err := c.accessToken(ctx, userID)
	if err != nil {
		return nil, err
	}
	repo, err := c.gh.repo(ctx, token, ref.Owner, ref.Name)
	if err != nil {
		return nil, c.mapUpstream(ctx, userID, err)
	}
	if !repo.Permissions.Push {
		return nil, infraerrors.Forbidden(ReasonNoAccess, "Your GitHub account can't push to "+repo.FullName+".")
	}
	expires := c.clock().Add(CloneLease)
	slog.Info("claudex github: push credential issued", "user_id", userID, "repository", repo.FullName)
	return CloneGrant{
		URL:      c.webBaseURL() + "/" + repo.FullName + ".git",
		Username: "x-access-token", Token: token,
		ExpiresAt:  expires.UTC().Format(time.RFC3339),
		Repository: repo.FullName, DefaultBranch: repo.DefaultBranch,
		CanPush: true,
	}, nil
}

// serveAPI performs one action on the session's repository.
func (c *Component) serveAPI(ctx context.Context, userID int64, body json.RawMessage) (any, error) {
	var req apiRequest
	if err := json.Unmarshal(body, &req); err != nil {
		return nil, infraerrors.BadRequest(ReasonBadRepo, "The GitHub request is not valid.")
	}
	ref, err := parseRepoURL(req.URL, c.gh.webBase)
	if err != nil {
		return nil, infraerrors.BadRequest(ReasonBadRepo, "That isn't a GitHub repository address.")
	}
	token, err := c.accessToken(ctx, userID)
	if err != nil {
		return nil, err
	}
	base := "/repos/" + url.PathEscape(ref.Owner) + "/" + url.PathEscape(ref.Name)
	title := strings.TrimSpace(req.Title)
	if len(title) > maxTitleLength || len(req.Body) > maxBodyLength || len(req.Labels) > maxLabels {
		return nil, infraerrors.BadRequest(ReasonBadRepo, "The title or text is too long.")
	}
	var out map[string]any
	switch req.Action {
	case "pr.autoFixFacts":
		return c.serveAutoFixFacts(ctx, userID, token, ref.Owner, ref.Name, req.Number)
	case "pr.files", "pr.timeline", "pr.comments", "pr.checks", "pr.annotations", "pr.rerun", "pr.comment", "pr.reply", "pr.review", "pr.threads", "pr.resolve", "pr.threadReply":
		return c.serveReview(ctx, userID, token, base, req)
	case "repository.tree", "repository.file":
		endpoint, query, inputError := repositoryReadEndpoint(base, req)
		if inputError != nil {
			return nil, inputError
		}
		if err = c.gh.get(ctx, token, endpoint, query, &out); err != nil {
			return nil, c.mapUpstream(ctx, userID, err)
		}
		return out, nil
	case "pr.create":
		if title == "" || !validRef(req.Head) || req.Head == "" || !validRef(req.Base) {
			return nil, infraerrors.BadRequest(ReasonBadRepo, "A pull request needs a title and valid branch names.")
		}
		baseBranch := req.Base
		if baseBranch == "" {
			repo, err := c.gh.repo(ctx, token, ref.Owner, ref.Name)
			if err != nil {
				return nil, c.mapUpstream(ctx, userID, err)
			}
			baseBranch = repo.DefaultBranch
		}
		err = c.gh.send(ctx, token, http.MethodPost, base+"/pulls", map[string]any{
			"title": title, "body": req.Body, "head": req.Head, "base": baseBranch, "draft": req.Draft,
		}, &out)
	case "issue.create":
		if title == "" {
			return nil, infraerrors.BadRequest(ReasonBadRepo, "An issue needs a title.")
		}
		payload := map[string]any{"title": title, "body": req.Body}
		if len(req.Labels) > 0 {
			payload["labels"] = req.Labels
		}
		err = c.gh.send(ctx, token, http.MethodPost, base+"/issues", payload, &out)
	case "comment.create":
		if req.Number <= 0 || strings.TrimSpace(req.Body) == "" {
			return nil, infraerrors.BadRequest(ReasonBadRepo, "A comment needs an issue or pull request number and text.")
		}
		err = c.gh.send(ctx, token, http.MethodPost, base+"/issues/"+strconv.Itoa(req.Number)+"/comments",
			map[string]any{"body": req.Body}, &out)
	case "pr.get":
		// A pull request's state, for the session that opened it (the runner
		// reads it after each turn; Conversation.pullRequests).
		if req.Number <= 0 {
			return nil, infraerrors.BadRequest(ReasonBadRepo, "Name a pull request number.")
		}
		err = c.gh.get(ctx, token, base+"/pulls/"+strconv.Itoa(req.Number), nil, &out)
	case "issue.get":
		if req.Number <= 0 {
			return nil, infraerrors.BadRequest(ReasonBadRepo, "Name an issue or pull request number.")
		}
		err = c.gh.get(ctx, token, base+"/issues/"+strconv.Itoa(req.Number), nil, &out)
		if err == nil {
			var comments []map[string]any
			q := url.Values{"per_page": {"30"}}
			if c.gh.get(ctx, token, base+"/issues/"+strconv.Itoa(req.Number)+"/comments", q, &comments) == nil {
				out["comments_list"] = summarizeComments(comments)
			}
		}
	default:
		return nil, infraerrors.BadRequest(ReasonBadRepo, "Unknown GitHub action.")
	}
	if err != nil {
		var refused errRefused
		if ok := asRefused(err, &refused); ok {
			return nil, infraerrors.BadRequest(ReasonGitHubRefused, "GitHub refused it: "+refused.message)
		}
		return nil, c.mapUpstream(ctx, userID, err)
	}
	slog.Info("claudex github: action done", "user_id", userID, "repository", ref.FullName(), "action", req.Action)
	return summarizeIssue(out), nil
}

func repositoryReadEndpoint(base string, req apiRequest) (string, url.Values, error) {
	invalid := func() (string, url.Values, error) {
		return "", nil, infraerrors.BadRequest(ReasonBadRepo, "The GitHub request is not valid.")
	}
	if req.Branch == "" || len(req.Branch) > 200 || !validRef(req.Branch) {
		return invalid()
	}
	if req.Action == "repository.tree" {
		return base + "/git/trees/" + url.PathEscape(req.Branch), url.Values{"recursive": {"1"}}, nil
	}
	if req.Path == "" || len(req.Path) > 4096 || strings.HasPrefix(req.Path, "/") || strings.Contains(req.Path, "\\") || strings.IndexFunc(req.Path, func(char rune) bool { return char < 0x20 || char == 0x7f }) >= 0 {
		return invalid()
	}
	segments := strings.Split(req.Path, "/")
	for index, segment := range segments {
		if segment == ".." || segment == "." || segment == "" {
			return invalid()
		}
		segments[index] = url.PathEscape(segment)
	}
	return base + "/contents/" + strings.Join(segments, "/"), url.Values{"ref": {req.Branch}}, nil
}

// summarizeIssue keeps what the model needs of an issue, pull request or
// comment.
func summarizeIssue(v map[string]any) map[string]any {
	out := map[string]any{}
	for _, k := range []string{"number", "html_url", "title", "state", "body", "draft", "merged", "comments", "created_at"} {
		if x, ok := v[k]; ok && x != nil {
			out[k] = x
		}
	}
	if u, ok := v["user"].(map[string]any); ok {
		out["author"] = u["login"]
	}
	if _, ok := v["pull_request"]; ok {
		out["is_pull_request"] = true
	}
	if head, ok := v["head"].(map[string]any); ok {
		if ref, ok := head["ref"].(string); ok && ref != "" {
			out["head_ref"] = ref
		}
	}
	if list, ok := v["comments_list"]; ok {
		out["comments_list"] = list
	}
	return out
}

func summarizeComments(list []map[string]any) []map[string]any {
	out := make([]map[string]any, 0, len(list))
	for _, c := range list {
		item := map[string]any{"body": c["body"], "created_at": c["created_at"]}
		if u, ok := c["user"].(map[string]any); ok {
			item["author"] = u["login"]
		}
		out = append(out, item)
	}
	return out
}

// errRefused is GitHub's 422 (validation) with its message, which names
// what is wrong ("A pull request already exists", "No commits between …")
// and never a token.
type errRefused struct{ message string }

func (e errRefused) Error() string { return "ghconn: GitHub refused: " + e.message }

func asRefused(err error, out *errRefused) bool {
	r, ok := err.(errRefused)
	if ok {
		*out = r
	}
	return ok
}

// send makes a JSON request; a 422's message comes back as errRefused.
func (c *client) send(ctx context.Context, token, method, path string, payload, out any) error {
	return c.sendTo(ctx, token, method, c.apiBase+path, payload, out)
}

// sendTo is send to a full address (GitHub's GraphQL endpoint is not under
// the REST base on GitHub Enterprise). A merge GitHub can't do (405) or a
// head that moved (409) comes back as errRefused too, with GitHub's words.
func (c *client) sendTo(ctx context.Context, token, method, address string, payload, out any) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, method, address, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	resp, err := c.http.Do(req)
	if err != nil {
		return errUpstream{}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, maxAPIBody))
	switch {
	case resp.StatusCode == http.StatusUnauthorized:
		return errRevoked
	case resp.StatusCode == http.StatusNotFound:
		return errNotFound
	case resp.StatusCode == http.StatusUnprocessableEntity || resp.StatusCode == http.StatusForbidden ||
		resp.StatusCode == http.StatusMethodNotAllowed || resp.StatusCode == http.StatusConflict:
		var v struct {
			Message string `json:"message"`
			Errors  []struct {
				Message string `json:"message"`
			} `json:"errors"`
		}
		_ = json.Unmarshal(body, &v)
		msg := v.Message
		for _, e := range v.Errors {
			if e.Message != "" {
				msg += ": " + e.Message
			}
		}
		if msg == "" {
			msg = "status " + strconv.Itoa(resp.StatusCode)
		}
		if len(msg) > 500 {
			msg = msg[:500]
		}
		return errRefused{message: msg}
	case resp.StatusCode < 200 || resp.StatusCode > 299:
		return errUpstream{status: resp.StatusCode}
	}
	if out != nil && len(body) > 0 {
		if err := json.Unmarshal(body, out); err != nil {
			return errUpstream{status: resp.StatusCode}
		}
	}
	return nil
}
