package sharing

import (
	"context"
	"database/sql"
	"errors"
	"regexp"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/gin-gonic/gin"
)

// Account sharing controls (live claude.ai bundle, 2026-10-14, c71860c77-BUhAcWeF.js).
type CodeSharingSettings struct {
	RequireRepositoryAccess bool `json:"requireRepositoryAccess"`
	ShowName                bool `json:"showName"`
}

type codeSettingsPatch struct {
	RequireRepositoryAccess *bool `json:"requireRepositoryAccess"`
	ShowName                *bool `json:"showName"`
}

type codeSettingsStore interface {
	getCodeSettings(context.Context, int64) (CodeSharingSettings, error)
	putCodeSettings(context.Context, int64, codeSettingsPatch) (CodeSharingSettings, error)
}

func defaultCodeSettings() CodeSharingSettings {
	return CodeSharingSettings{RequireRepositoryAccess: true, ShowName: true}
}

func (s *sqlStore) getCodeSettings(ctx context.Context, userID int64) (CodeSharingSettings, error) {
	settings := defaultCodeSettings()
	if s == nil || s.db == nil {
		return settings, nil
	}
	err := s.db.QueryRowContext(ctx, `SELECT require_repository_access, show_name FROM claudex_code_sharing_settings WHERE user_id=$1`, userID).Scan(&settings.RequireRepositoryAccess, &settings.ShowName)
	if errors.Is(err, sql.ErrNoRows) {
		err = nil
	}
	return settings, err
}

func (s *sqlStore) putCodeSettings(ctx context.Context, userID int64, patch codeSettingsPatch) (CodeSharingSettings, error) {
	settings := CodeSharingSettings{}
	err := s.db.QueryRowContext(ctx, `INSERT INTO claudex_code_sharing_settings (user_id, require_repository_access, show_name)
	 VALUES ($1, COALESCE($2, TRUE), COALESCE($3, TRUE)) ON CONFLICT (user_id) DO UPDATE SET
	 require_repository_access=COALESCE($2, claudex_code_sharing_settings.require_repository_access),
	 show_name=COALESCE($3, claudex_code_sharing_settings.show_name)
	 RETURNING require_repository_access, show_name`, userID, patch.RequireRepositoryAccess, patch.ShowName).Scan(&settings.RequireRepositoryAccess, &settings.ShowName)
	return settings, err
}

func (c *Component) codeSharingSettings(ctx context.Context, userID int64) (CodeSharingSettings, error) {
	if c.codeSettings == nil {
		return defaultCodeSettings(), nil
	}
	return c.codeSettings.getCodeSettings(ctx, userID)
}

func (c *Component) getCodeSettings(g *gin.Context) {
	userID, ok := core.Subject(g)
	if !ok {
		response.ErrorFrom(g, ErrShareNotFound)
		return
	}
	settings, err := c.codeSharingSettings(g.Request.Context(), userID)
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	g.Header("Cache-Control", "no-store")
	response.Success(g, settings)
}

func (c *Component) patchCodeSettings(g *gin.Context) {
	userID, ok := core.Subject(g)
	if !ok {
		response.ErrorFrom(g, ErrShareNotFound)
		return
	}
	var patch codeSettingsPatch
	if err := readSmallJSON(g, &patch); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	if c.codeSettings == nil {
		response.ErrorFrom(g, errStoreFailed)
		return
	}
	settings, err := c.codeSettings.putCodeSettings(g.Request.Context(), userID, patch)
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	g.Header("Cache-Control", "no-store")
	response.Success(g, settings)
}

var codeRepositoryName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_.-]+$`)

type codeRepositoryReader interface {
	CanReadCodeRepositories(context.Context, int64, []string) bool
}

func (c *Component) canReadCode(ctx context.Context, ownerID, viewerID int64, snapshot *Snapshot) (bool, error) {
	if snapshot.Mode != "code" || ownerID == viewerID {
		return true, nil
	}
	settings, err := c.codeSharingSettings(ctx, ownerID)
	if err != nil {
		return false, err
	}
	if !settings.RequireRepositoryAccess {
		return true, nil
	}
	if viewerID == 0 || len(snapshot.Repositories) == 0 || c.env == nil {
		return false, nil
	}
	for _, component := range c.env.Components {
		if reader, ok := component.(codeRepositoryReader); ok {
			return reader.CanReadCodeRepositories(ctx, viewerID, snapshot.Repositories), nil
		}
	}
	return false, nil
}

func (c *Component) codeDisplayName(ctx context.Context, userID int64, snapshot *Snapshot) (string, error) {
	if snapshot.Mode != "code" {
		return c.emailOf(ctx, userID), nil
	}
	settings, err := c.codeSharingSettings(ctx, userID)
	if err != nil || !settings.ShowName {
		return "", err
	}
	if c.env == nil || c.env.UserRepo == nil {
		return "", nil
	}
	user, err := c.env.UserRepo.GetByIDIncludeDeleted(ctx, userID)
	if err != nil || user == nil {
		return "", err
	}
	return user.Username, nil
}
