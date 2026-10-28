package sharing

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/gin-gonic/gin"
)

func (c *Component) putSharedArtifact(g *gin.Context) {
	row, userID := c.sharedWithMe(g)
	if row == nil {
		return
	}
	if row.Kind != KindArtifact {
		response.ErrorFrom(g, ErrShareNotFound)
		return
	}
	ctx := g.Request.Context()
	s := c.setting.Cached(ctx)
	if err := c.canPublish(ctx, s, userID, KindArtifact); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	var patch struct {
		Content *string `json:"content"`
		Comment string  `json:"comment"`
	}
	raw, err := io.ReadAll(http.MaxBytesReader(g.Writer, requestBody(g), s.MaxSnapshotBytes+requestOverheadBytes))
	if err != nil || json.Unmarshal(raw, &patch) != nil || len(patch.Comment) > 4000 {
		response.ErrorFrom(g, invalidShare("body", "The request failed."))
		return
	}
	email := c.emailOf(ctx, userID)
	var earlier []SnapshotComment
	permission := "comment"
	if patch.Content != nil {
		permission = "edit"
	}
	err = c.store.editArtifact(ctx, userID, email, row.ID, permission, func(snapshot *Snapshot) error {
		if len(snapshot.Artifacts) != 1 {
			return ErrShareNotFound
		}
		if patch.Content != nil {
			snapshot.Artifacts[0].Content = *patch.Content
		}
		if comment := strings.TrimSpace(dropNUL(patch.Comment)); comment != "" {
			earlier = append([]SnapshotComment{}, snapshot.Comments...)
			if len(snapshot.Comments) >= maxMessages {
				return invalidShare("comment", "The request failed.")
			}
			snapshot.Comments = append(snapshot.Comments, SnapshotComment{Author: email, Text: comment})
		}
		_, err := normalizeSnapshot(snapshot, KindArtifact, row.Title, limitsOf(s))
		return err
	}, c.now())
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	if comment := strings.TrimSpace(dropNUL(patch.Comment)); comment != "" {
		c.mailComment(row, c.appBase(ctx, g)+AppSharePath+"/"+row.Token, email, comment, earlier)
	}
	response.Success(g, gin.H{})
}
