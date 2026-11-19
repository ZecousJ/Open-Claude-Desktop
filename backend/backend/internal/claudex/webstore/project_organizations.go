package webstore

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/lib/pq"
)

var (
	errProjectOrganizationNotFound = infraerrors.NotFound("CLAUDEX_PROJECT_ORGANIZATION_NOT_FOUND", "Organization not found.")
	errProjectMemberNotFound       = infraerrors.NotFound("CLAUDEX_PROJECT_MEMBER_NOT_FOUND", "Organization member not found.")
	errProjectForbidden            = infraerrors.Forbidden("CLAUDEX_PROJECT_FORBIDDEN", "You do not have permission to make this change.")
	errProjectSharingDisabled      = infraerrors.Forbidden("CLAUDEX_PROJECT_SHARING_DISABLED", "Project sharing is turned off by your administrator.")
	errPublicProjectsDisabled      = infraerrors.Forbidden("CLAUDEX_PUBLIC_PROJECTS_DISABLED", "Public projects are turned off by your administrator.")
)

type projectOrganizationPolicy struct {
	SharingEnabled        bool `json:"sharingEnabled"`
	PublicProjectsEnabled bool `json:"publicProjectsEnabled"`
}

type projectOrganization struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Role string `json:"role"`
	projectOrganizationPolicy
}

type projectPolicyPatch struct {
	SharingEnabled        *bool `json:"sharingEnabled"`
	PublicProjectsEnabled *bool `json:"publicProjectsEnabled"`
}

type ProjectOrganizationMember struct {
	UserID int64  `json:"userId"`
	Email  string `json:"email"`
	Name   string `json:"name"`
}

type projectOrganizationMembersPage struct {
	Members    []ProjectOrganizationMember `json:"members"`
	NextOffset *int                        `json:"nextOffset,omitempty"`
}

const selectProjectOrganization = `SELECT o.id, o.name, m.role,
	COALESCE(policy.sharing_enabled, TRUE), COALESCE(policy.public_projects_enabled, TRUE)
FROM claudex_plugin_organization_members m
JOIN claudex_plugin_organizations o ON o.id = m.organization_id
JOIN users u ON u.id = m.user_id AND u.deleted_at IS NULL
LEFT JOIN claudex_web_project_policies policy ON policy.organization_id = o.id
WHERE m.user_id = $1`

func readProjectOrganization(ctx context.Context, q querier, actor int64, orgID string) (projectOrganization, error) {
	var org projectOrganization
	err := q.QueryRowContext(ctx, selectProjectOrganization+` AND o.id = $2`, actor, orgID).
		Scan(&org.ID, &org.Name, &org.Role, &org.SharingEnabled, &org.PublicProjectsEnabled)
	if errors.Is(err, sql.ErrNoRows) {
		return org, errProjectOrganizationNotFound
	}
	return org, err
}

func (s *store) projectOrganizations(ctx context.Context, actor int64) ([]projectOrganization, error) {
	if err := s.ok(); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, selectProjectOrganization+` ORDER BY o.name, o.id`, actor)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []projectOrganization{}
	for rows.Next() {
		var org projectOrganization
		if err := rows.Scan(&org.ID, &org.Name, &org.Role, &org.SharingEnabled, &org.PublicProjectsEnabled); err != nil {
			return nil, err
		}
		out = append(out, org)
	}
	return out, rows.Err()
}

func (s *store) projectOrganization(ctx context.Context, actor int64, orgID string) (projectOrganization, error) {
	if err := s.ok(); err != nil {
		return projectOrganization{}, err
	}
	return readProjectOrganization(ctx, s.db, actor, orgID)
}

func (s *store) organizationProjectTx(ctx context.Context, actor int64, orgID string, changePolicy bool, run func(*sql.Tx, projectOrganization) error) error {
	if err := s.ok(); err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	lock := " FOR SHARE OF o"
	if changePolicy {
		lock = " FOR UPDATE OF o"
	}
	var locked string
	err = tx.QueryRowContext(ctx, `SELECT o.id FROM claudex_plugin_organizations o
JOIN claudex_plugin_organization_members m ON m.organization_id = o.id
JOIN users u ON u.id = m.user_id AND u.deleted_at IS NULL
WHERE m.user_id = $1 AND o.id = $2`+lock, actor, orgID).Scan(&locked)
	if errors.Is(err, sql.ErrNoRows) {
		return errProjectOrganizationNotFound
	}
	if err != nil {
		return err
	}
	org, err := readProjectOrganization(ctx, tx, actor, orgID)
	if err != nil {
		return err
	}
	if err := run(tx, org); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *store) updateProjectOrganizationPolicy(ctx context.Context, actor int64, orgID string, patch projectPolicyPatch) (projectOrganizationPolicy, error) {
	var policy projectOrganizationPolicy
	err := s.organizationProjectTx(ctx, actor, orgID, true, func(tx *sql.Tx, org projectOrganization) error {
		if org.Role != "admin" {
			return errProjectForbidden
		}
		policy = org.projectOrganizationPolicy
		if patch.SharingEnabled != nil {
			policy.SharingEnabled = *patch.SharingEnabled
		}
		if patch.PublicProjectsEnabled != nil {
			policy.PublicProjectsEnabled = *patch.PublicProjectsEnabled
		}
		if !policy.SharingEnabled {
			if patch.PublicProjectsEnabled != nil && *patch.PublicProjectsEnabled {
				return errProjectSharingDisabled
			}
			policy.PublicProjectsEnabled = false
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO claudex_web_project_policies
	(organization_id, sharing_enabled, public_projects_enabled) VALUES ($1, $2, $3)
ON CONFLICT (organization_id) DO UPDATE SET
	sharing_enabled = EXCLUDED.sharing_enabled, public_projects_enabled = EXCLUDED.public_projects_enabled`,
			orgID, policy.SharingEnabled, policy.PublicProjectsEnabled); err != nil {
			return err
		}
		if !policy.PublicProjectsEnabled {
			_, err := tx.ExecContext(ctx, `UPDATE claudex_web_projects SET organization_role = 'none', updated_at = NOW()
WHERE organization_id = $1 AND organization_role <> 'none'`, orgID)
			return err
		}
		return nil
	})
	return policy, err
}

func (s *store) projectOrganizationMembers(ctx context.Context, actor int64, orgID, query string, emails []string, offset, limit int) (projectOrganizationMembersPage, error) {
	page := projectOrganizationMembersPage{Members: []ProjectOrganizationMember{}}
	if _, err := s.projectOrganization(ctx, actor, orgID); err != nil {
		return page, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT u.id, u.email, COALESCE(NULLIF(u.username, ''), u.email)
FROM claudex_plugin_organization_members m
JOIN users u ON u.id = m.user_id AND u.deleted_at IS NULL
WHERE m.organization_id = $2 AND EXISTS (`+selectProjectOrganization+` AND o.id = $2)
	AND ($3 = '' OR strpos(lower(u.email), lower($3)) > 0 OR strpos(lower(u.username), lower($3)) > 0)
	AND (COALESCE(cardinality($4::text[]), 0) = 0 OR lower(u.email) = ANY($4))
ORDER BY lower(COALESCE(NULLIF(u.username, ''), u.email)), u.id
LIMIT $5 OFFSET $6`, actor, orgID, query, pq.Array(emails), limit+1, offset)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	for rows.Next() {
		var member ProjectOrganizationMember
		if err := rows.Scan(&member.UserID, &member.Email, &member.Name); err != nil {
			return page, err
		}
		if len(page.Members) == limit {
			next := offset + limit
			page.NextOffset = &next
			break
		}
		page.Members = append(page.Members, member)
	}
	return page, rows.Err()
}

type projectGrantTarget struct {
	UserID int64
	Email  string
}

func resolveGrantTargets(ctx context.Context, tx *sql.Tx, orgID string, targets []projectGrantTarget) ([]int64, error) {
	ids := []int64{}
	emails := []string{}
	for _, target := range targets {
		if target.UserID != 0 {
			ids = append(ids, target.UserID)
		} else {
			emails = append(emails, target.Email)
		}
	}
	rows, err := tx.QueryContext(ctx, `SELECT u.id, lower(u.email)
FROM claudex_plugin_organization_members m
JOIN users u ON u.id = m.user_id AND u.deleted_at IS NULL
WHERE m.organization_id = $1 AND (u.id = ANY($2) OR lower(u.email) = ANY($3))`, orgID, pq.Array(ids), pq.Array(emails))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	found := map[int64]bool{}
	byEmail := map[string]int64{}
	out := []int64{}
	for rows.Next() {
		var id int64
		var email string
		if err := rows.Scan(&id, &email); err != nil {
			return nil, err
		}
		found[id] = true
		if previous, ok := byEmail[email]; ok && previous != id {
			byEmail[email] = 0
		} else {
			byEmail[email] = id
		}
		out = append(out, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, id := range ids {
		if !found[id] {
			return nil, errProjectMemberNotFound
		}
	}
	for _, email := range emails {
		if byEmail[email] == 0 {
			return nil, errProjectMemberNotFound
		}
	}
	return out, nil
}

func normalizeProjectEmail(s string) string {
	return strings.ToLower(strings.TrimSpace(s))
}
