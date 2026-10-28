package ghconn

import (
	"context"
	"strings"
	"time"
)

// Shared Code sessions use the viewer's own GitHub connection, never the author's.
func (c *Component) CanReadCodeRepositories(ctx context.Context, userID int64, repositories []string) bool {
	if len(repositories) == 0 || len(repositories) > 20 {
		return false
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	token, err := c.accessToken(ctx, userID)
	if err != nil {
		return false
	}
	for _, repository := range repositories {
		parts := strings.Split(repository, "/")
		if len(parts) != 2 || parts[0] == "" || parts[1] == "" ||
			parts[0] == "." || parts[0] == ".." || parts[1] == "." || parts[1] == ".." {
			return false
		}
		if _, err := c.gh.repo(ctx, token, parts[0], parts[1]); err != nil {
			return false
		}
	}
	return true
}
