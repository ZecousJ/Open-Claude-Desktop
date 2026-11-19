package webstore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/google/uuid"
	"github.com/lib/pq"
)

var ErrProjectNotFound = infraerrors.NotFound("CLAUDEX_PROJECT_NOT_FOUND", "Project not found.")

type ProjectShareRole string

const (
	ProjectRoleNone  ProjectShareRole = "none"
	ProjectRoleView  ProjectShareRole = "view"
	ProjectRoleUser  ProjectShareRole = "user"
	ProjectRoleOwner ProjectShareRole = "owner"
)

func (role ProjectShareRole) isGrant() bool {
	return role == ProjectRoleView || role == ProjectRoleUser || role == ProjectRoleNone
}

type OrganizationProjectContent struct {
	Name         string `json:"name"`
	Description  string `json:"description"`
	Instructions string `json:"instructions"`
	ArchivedAt   *int64 `json:"archivedAt,omitempty"`
}

type ProjectShareAccess struct {
	ID             string                    `json:"id"`
	OrganizationID string                    `json:"organizationId"`
	OwnerID        int64                     `json:"ownerId"`
	Creator        ProjectOrganizationMember `json:"creator"`
	Kind           string                    `json:"kind"`
	OrganizationProjectContent
	CreatedAt    int64            `json:"createdAt"`
	UpdatedAt    int64            `json:"updatedAt"`
	Starred      bool             `json:"starred"`
	AudienceRole ProjectShareRole `json:"audienceRole"`
	DirectRole   ProjectShareRole `json:"directRole"`
	Role         ProjectShareRole `json:"role"`
}

func (a ProjectShareAccess) CanChat() bool {
	return a.Role == ProjectRoleOwner || a.Role == ProjectRoleUser || a.Role == ProjectRoleView
}

func (a ProjectShareAccess) CanEditContent() bool {
	return a.Role == ProjectRoleOwner || a.Role == ProjectRoleUser
}

type sharedProjectRow struct {
	ProjectShareAccess
	bytes int64
}

const selectProjectShare = `SELECT p.id, p.organization_id, p.user_id, owner.email, COALESCE(NULLIF(owner.username, ''), owner.email),
	p.doc, p.bytes, p.created_at, p.updated_at, stars.user_id IS NOT NULL,
	p.organization_role, COALESCE(grants.role, 'none'),
	CASE
		WHEN p.user_id = $1 THEN 'owner'
		WHEN grants.role = 'user' OR p.organization_role = 'user' THEN 'user'
		ELSE 'view'
	END
FROM claudex_web_projects p
JOIN claudex_plugin_organization_members m ON m.organization_id = p.organization_id AND m.user_id = $1
JOIN users actor ON actor.id = m.user_id AND actor.deleted_at IS NULL
JOIN users owner ON owner.id = p.user_id AND owner.deleted_at IS NULL
LEFT JOIN claudex_web_project_grants grants
	ON grants.organization_id = p.organization_id AND grants.project_id = p.id AND grants.user_id = $1
LEFT JOIN claudex_web_project_stars stars
	ON stars.organization_id = p.organization_id AND stars.project_id = p.id AND stars.user_id = $1
WHERE (NULLIF($2::text, '') IS NULL OR p.organization_id = NULLIF($2::text, '')::uuid)
	AND (p.user_id = $1 OR grants.user_id IS NOT NULL OR p.organization_role <> 'none')`

func scanProjectShare(row interface{ Scan(...any) error }) (sharedProjectRow, error) {
	p := sharedProjectRow{ProjectShareAccess: ProjectShareAccess{Kind: "chat"}}
	var doc []byte
	var created, updated time.Time
	err := row.Scan(&p.ID, &p.OrganizationID, &p.OwnerID, &p.Creator.Email, &p.Creator.Name,
		&doc, &p.bytes, &created, &updated, &p.Starred, &p.AudienceRole, &p.DirectRole, &p.Role)
	if errors.Is(err, sql.ErrNoRows) {
		return p, ErrProjectNotFound
	}
	if err != nil {
		return p, err
	}
	if err := json.Unmarshal(doc, &p.OrganizationProjectContent); err != nil {
		return p, err
	}
	p.Creator.UserID = p.OwnerID
	p.CreatedAt = created.UnixMilli()
	p.UpdatedAt = updated.UnixMilli()
	return p, nil
}

func readProjectShare(ctx context.Context, q querier, actor int64, orgID, projectID string, lock bool) (sharedProjectRow, error) {
	if lock {
		var id string
		err := q.QueryRowContext(ctx, `SELECT id FROM claudex_web_projects WHERE organization_id = $1 AND id = $2
FOR UPDATE`, orgID, projectID).Scan(&id)
		if errors.Is(err, sql.ErrNoRows) {
			return sharedProjectRow{}, ErrProjectNotFound
		}
		if err != nil {
			return sharedProjectRow{}, err
		}
	}
	return scanProjectShare(q.QueryRowContext(ctx, selectProjectShare+` AND p.id = $3`, actor, orgID, projectID))
}

// ShareAccess resolves the current actor's project rights. An empty organization
// ID looks up the service-wide project UUID across the actor's organizations.
func (c *Component) ShareAccess(ctx context.Context, actor int64, orgID, projectID string) (ProjectShareAccess, error) {
	if orgID != "" {
		org, err := uuid.Parse(orgID)
		if err != nil {
			return ProjectShareAccess{}, ErrProjectNotFound
		}
		orgID = org.String()
	}
	id, err := uuid.Parse(projectID)
	if err != nil {
		return ProjectShareAccess{}, ErrProjectNotFound
	}
	if err := c.store.ok(); err != nil {
		return ProjectShareAccess{}, err
	}
	p, err := readProjectShare(ctx, c.store.db, actor, orgID, id.String(), false)
	return p.ProjectShareAccess, err
}

func (s *store) listOrganizationProjects(ctx context.Context, actor int64, orgID string) ([]ProjectShareAccess, error) {
	if _, err := s.projectOrganization(ctx, actor, orgID); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, selectProjectShare+` ORDER BY p.updated_at DESC, p.id`, actor, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ProjectShareAccess{}
	for rows.Next() {
		p, err := scanProjectShare(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p.ProjectShareAccess)
	}
	return out, rows.Err()
}

type organizationProjectCreate struct {
	ClientCreationID string           `json:"clientCreationId"`
	Name             string           `json:"name"`
	Description      string           `json:"description"`
	Instructions     string           `json:"instructions"`
	AudienceRole     ProjectShareRole `json:"audienceRole"`
	Starred          bool             `json:"starred"`
}

type organizationProjectPatch struct {
	Name         *string           `json:"name"`
	Description  *string           `json:"description"`
	Instructions *string           `json:"instructions"`
	AudienceRole *ProjectShareRole `json:"audienceRole"`
	Archived     *bool             `json:"archived"`
	Starred      *bool             `json:"starred"`
}

func projectAudienceAllowed(org projectOrganization, role ProjectShareRole) error {
	if role == ProjectRoleNone {
		return nil
	}
	if !org.SharingEnabled {
		return errProjectSharingDisabled
	}
	if !org.PublicProjectsEnabled {
		return errPublicProjectsDisabled
	}
	return nil
}

func encodeOrganizationProject(doc OrganizationProjectContent) (string, error) {
	raw, err := json.Marshal(doc)
	if err != nil {
		return "", err
	}
	if len(raw) > projectBytes {
		return "", tooLarge("project")
	}
	return string(jsonbSafe(raw)), nil
}

func (s *store) createOrganizationProject(ctx context.Context, actor int64, orgID string, request organizationProjectCreate, limits Limits) (ProjectShareAccess, error) {
	id := request.ClientCreationID
	if id == "" {
		id = uuid.NewString()
	}
	conflict := infraerrors.Conflict("CLAUDEX_PROJECT_CREATION_CONFLICT", "This project was already created with different details.")
	doc, err := encodeOrganizationProject(OrganizationProjectContent{
		Name: request.Name, Description: request.Description, Instructions: request.Instructions,
	})
	if err != nil {
		return ProjectShareAccess{}, err
	}
	size := int64(len(doc))
	var p sharedProjectRow
	err = s.organizationProjectTx(ctx, actor, orgID, false, func(tx *sql.Tx, org projectOrganization) error {
		if err := lockUserStorage(ctx, tx, actor); err != nil {
			return err
		}
		if request.ClientCreationID != "" {
			existing, err := readProjectShare(ctx, tx, actor, orgID, id, false)
			if err == nil {
				if existing.OwnerID != actor || existing.Name != request.Name ||
					existing.Description != request.Description || existing.Instructions != request.Instructions ||
					existing.AudienceRole != request.AudienceRole {
					return conflict
				}
				p = existing
				return nil
			}
			if !errors.Is(err, ErrProjectNotFound) {
				return err
			}
		}
		if err := projectAudienceAllowed(org, request.AudienceRole); err != nil {
			return err
		}
		if err := checkQuota(ctx, tx, actor, size, limits, quotaStrict); err != nil {
			return err
		}
		inserted, err := tx.ExecContext(ctx, `INSERT INTO claudex_web_projects (user_id, id, doc, bytes, organization_id, organization_role)
VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`, actor, id, doc, size, orgID, request.AudienceRole)
		if err != nil {
			return err
		}
		count, err := inserted.RowsAffected()
		if err != nil {
			return err
		}
		if count != 1 {
			return conflict
		}
		if err := addUsage(ctx, tx, actor, size, 0); err != nil {
			return err
		}
		if request.Starred {
			if err := writeOrganizationProjectStar(ctx, tx, actor, orgID, id, true); err != nil {
				return err
			}
		}
		p, err = readProjectShare(ctx, tx, actor, orgID, id, false)
		return err
	})
	return p.ProjectShareAccess, err
}

func (s *store) updateOrganizationProject(ctx context.Context, actor int64, orgID, projectID string, patch organizationProjectPatch, now time.Time, limits Limits) (*ProjectShareAccess, error) {
	var result *ProjectShareAccess
	err := s.organizationProjectTx(ctx, actor, orgID, false, func(tx *sql.Tx, org projectOrganization) error {
		p, err := readProjectShare(ctx, tx, actor, orgID, projectID, true)
		if err != nil {
			return err
		}
		if (patch.Name != nil || patch.Description != nil || patch.Archived != nil) && p.Role != ProjectRoleOwner {
			return errProjectForbidden
		}
		if (patch.Instructions != nil || patch.AudienceRole != nil) && !p.CanEditContent() {
			return errProjectForbidden
		}

		if patch.Name != nil {
			p.Name = *patch.Name
		}
		if patch.Description != nil {
			p.Description = *patch.Description
		}
		if patch.Instructions != nil {
			p.Instructions = *patch.Instructions
		}
		if patch.Archived != nil {
			if *patch.Archived && p.ArchivedAt == nil {
				at := now.UnixMilli()
				p.ArchivedAt = &at
			} else if !*patch.Archived {
				p.ArchivedAt = nil
			}
		}
		if patch.AudienceRole != nil {
			if err := projectAudienceAllowed(org, *patch.AudienceRole); err != nil {
				return err
			}
			p.AudienceRole = *patch.AudienceRole
		}

		if patch.Name != nil || patch.Description != nil || patch.Instructions != nil || patch.Archived != nil {
			doc, err := encodeOrganizationProject(p.OrganizationProjectContent)
			if err != nil {
				return err
			}
			delta := int64(len(doc)) - p.bytes
			if delta != 0 {
				if err := lockUserStorage(ctx, tx, p.OwnerID); err != nil {
					return err
				}
				if err := checkQuota(ctx, tx, p.OwnerID, delta, limits, quotaGrace); err != nil {
					return err
				}
				if err := addUsage(ctx, tx, p.OwnerID, delta, 0); err != nil {
					return err
				}
			}
			if _, err := tx.ExecContext(ctx, `UPDATE claudex_web_projects SET doc = $3, bytes = $4,
	organization_role = $5, updated_at = NOW() WHERE organization_id = $1 AND id = $2`,
				orgID, projectID, doc, len(doc), p.AudienceRole); err != nil {
				return err
			}
		} else if patch.AudienceRole != nil {
			if _, err := tx.ExecContext(ctx, `UPDATE claudex_web_projects SET organization_role = $3, updated_at = NOW()
WHERE organization_id = $1 AND id = $2 AND organization_role <> $3`, orgID, projectID, p.AudienceRole); err != nil {
				return err
			}
		}
		if patch.Starred != nil {
			if err := writeOrganizationProjectStar(ctx, tx, actor, orgID, projectID, *patch.Starred); err != nil {
				return err
			}
		}
		after, err := readProjectShare(ctx, tx, actor, orgID, projectID, false)
		if errors.Is(err, ErrProjectNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		result = &after.ProjectShareAccess
		return nil
	})
	return result, err
}

func writeOrganizationProjectStar(ctx context.Context, tx *sql.Tx, actor int64, orgID, projectID string, starred bool) error {
	if starred {
		_, err := tx.ExecContext(ctx, `INSERT INTO claudex_web_project_stars (organization_id, project_id, user_id)
VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, orgID, projectID, actor)
		return err
	}
	_, err := tx.ExecContext(ctx, `DELETE FROM claudex_web_project_stars
WHERE organization_id = $1 AND project_id = $2 AND user_id = $3`, orgID, projectID, actor)
	return err
}

func (s *store) deleteOrganizationProject(ctx context.Context, actor int64, orgID, projectID string) error {
	return s.organizationProjectTx(ctx, actor, orgID, false, func(tx *sql.Tx, _ projectOrganization) error {
		p, err := readProjectShare(ctx, tx, actor, orgID, projectID, true)
		if err != nil {
			return err
		}
		if p.Role != ProjectRoleOwner {
			return errProjectForbidden
		}
		if err := lockUserStorage(ctx, tx, p.OwnerID); err != nil {
			return err
		}
		knowledgeBytes, err := projectKnowledgeBytes(ctx, tx, orgID, projectID)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM claudex_web_projects WHERE organization_id = $1 AND id = $2`, orgID, projectID); err != nil {
			return err
		}
		return addUsage(ctx, tx, p.OwnerID, -p.bytes, -knowledgeBytes)
	})
}

type projectShareAccount struct {
	ProjectOrganizationMember
	Role ProjectShareRole `json:"role"`
}

func (s *store) organizationProjectAccounts(ctx context.Context, actor int64, orgID, projectID string) ([]projectShareAccount, error) {
	if err := s.ok(); err != nil {
		return nil, err
	}
	p, err := readProjectShare(ctx, s.db, actor, orgID, projectID, false)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT u.id, u.email, COALESCE(NULLIF(u.username, ''), u.email), g.role
FROM claudex_web_project_grants g
JOIN users u ON u.id = g.user_id AND u.deleted_at IS NULL
WHERE g.organization_id = $2 AND g.project_id = $3
	AND EXISTS (`+selectProjectShare+` AND p.id = $3)
ORDER BY lower(COALESCE(NULLIF(u.username, ''), u.email)), u.id`, actor, orgID, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	accounts := []projectShareAccount{{ProjectOrganizationMember: p.Creator, Role: ProjectRoleOwner}}
	for rows.Next() {
		var account projectShareAccount
		if err := rows.Scan(&account.UserID, &account.Email, &account.Name, &account.Role); err != nil {
			return nil, err
		}
		accounts = append(accounts, account)
	}
	return accounts, rows.Err()
}

func (s *store) writeOrganizationProjectGrants(ctx context.Context, actor int64, orgID, projectID string, targets []projectGrantTarget, role ProjectShareRole) error {
	return s.organizationProjectTx(ctx, actor, orgID, false, func(tx *sql.Tx, org projectOrganization) error {
		p, err := readProjectShare(ctx, tx, actor, orgID, projectID, true)
		if err != nil {
			return err
		}
		if !p.CanEditContent() {
			return errProjectForbidden
		}
		ids, err := resolveGrantTargets(ctx, tx, orgID, targets)
		if err != nil {
			return err
		}
		for _, id := range ids {
			if id == p.OwnerID {
				return errProjectForbidden
			}
		}
		if role == ProjectRoleNone {
			_, err := tx.ExecContext(ctx, `DELETE FROM claudex_web_project_grants
WHERE organization_id = $1 AND project_id = $2 AND user_id = ANY($3)`, orgID, projectID, pq.Array(ids))
			return err
		}
		if !org.SharingEnabled {
			result, err := tx.ExecContext(ctx, `UPDATE claudex_web_project_grants SET role = $4
WHERE organization_id = $1 AND project_id = $2 AND user_id = ANY($3)`, orgID, projectID, pq.Array(ids), role)
			if err != nil {
				return err
			}
			n, err := result.RowsAffected()
			if err == nil && n != int64(len(ids)) {
				return errProjectSharingDisabled
			}
			return err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO claudex_web_project_grants (organization_id, project_id, user_id, role)
SELECT $1, $2, target, $4 FROM unnest($3::bigint[]) AS target
ON CONFLICT (organization_id, project_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
			orgID, projectID, pq.Array(ids), role)
		return err
	})
}
