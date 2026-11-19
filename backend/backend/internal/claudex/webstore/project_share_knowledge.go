package webstore

import (
	"context"
	"database/sql"
	"errors"
	"io"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/lib/pq"
)

const (
	projectKnowledgeMaxBytes   = 100_000_000
	projectKnowledgeMaxFile    = 30 << 20
	projectKnowledgeTempPrefix = ".knowledge-"
	projectKnowledgeColumns    = `id, name, mime, size, created_at, updated_at`
)

var errProjectKnowledgeEdit = infraerrors.Forbidden("PROJECT_KNOWLEDGE_EDIT_REQUIRED", "You do not have permission to edit this project's knowledge.")

type projectKnowledgeFile struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	MIME      string    `json:"mime"`
	Size      int64     `json:"size"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type projectKnowledgeList struct {
	Files          []projectKnowledgeFile `json:"files"`
	LimitBytes     int64                  `json:"limitBytes"`
	FileLimitBytes int64                  `json:"fileLimitBytes"`
}

type projectKnowledgeInfo struct {
	File projectKnowledgeFile `json:"file"`
}

func (c *Component) registerProjectShareKnowledgeRoutes(projects *gin.RouterGroup) {
	projects.GET("/knowledge", c.handleProjectKnowledge)
	projects.POST("/knowledge", c.handleProjectKnowledge)
	projects.GET("/knowledge/:fileId", c.handleProjectKnowledge)
	projects.HEAD("/knowledge/:fileId", c.handleProjectKnowledge)
	projects.PUT("/knowledge/:fileId", c.handleProjectKnowledge)
	projects.DELETE("/knowledge/:fileId", c.handleProjectKnowledge)
}

func projectKnowledgeName(name string) (string, error) {
	if strings.TrimSpace(name) == "" {
		return "", nil
	}
	if !strings.Contains(name, "/") {
		return cleanName(name), nil
	}
	if path.IsAbs(name) || path.Clean(name) != name || strings.HasPrefix(name, "../") ||
		strings.ContainsAny(name, "\\<>:\"|?*") || strings.IndexFunc(name, unicode.IsControl) >= 0 ||
		!utf8.ValidString(name) || utf8.RuneCountInString(name) > 255 {
		return "", badRequest("Choose a relative file name up to 255 characters.")
	}
	return name, nil
}

func (c *Component) handleProjectKnowledge(g *gin.Context) {
	actor, ok := core.Subject(g)
	if !ok {
		response.ErrorFrom(g, infraerrors.Unauthorized("UNAUTHORIZED", "Sign in first."))
		return
	}
	ctx := g.Request.Context()
	access, err := c.ShareAccess(ctx, actor, g.Param("org"), g.Param("project"))
	if err != nil {
		projectKnowledgeHTTPError(g, err)
		return
	}
	g.Header("Cache-Control", "private, no-store")
	id := g.Param("fileId")
	if id != "" && !ValidFileID(id) {
		projectKnowledgeHTTPError(g, notFound("file"))
		return
	}
	limits := c.Limits(ctx)
	limits.MaxFileBytes = min(limits.MaxFileBytes, projectKnowledgeMaxFile)
	switch g.Request.Method {
	case http.MethodGet, http.MethodHead:
		if id == "" {
			files, err := c.listProjectKnowledge(ctx, access)
			if err != nil {
				projectKnowledgeHTTPError(g, err)
				return
			}
			g.JSON(http.StatusOK, projectKnowledgeList{files, projectKnowledgeMaxBytes, limits.MaxFileBytes})
			return
		}
		file, body, err := c.openProjectKnowledge(ctx, access, id)
		if err != nil {
			projectKnowledgeHTTPError(g, err)
			return
		}
		defer body.Close()
		downloadHeaders(g, file.Name)
		g.Header("Content-Type", file.MIME)
		http.ServeContent(g.Writer, g.Request, file.Name, time.Time{}, body)
	case http.MethodPost, http.MethodPut:
		if !access.CanEditContent() {
			projectKnowledgeHTTPError(g, errProjectKnowledgeEdit)
			return
		}
		if g.Request.ContentLength > limits.MaxFileBytes {
			projectKnowledgeHTTPError(g, tooLarge("file"))
			return
		}
		name, err := projectKnowledgeName(g.Query("name"))
		if err != nil {
			projectKnowledgeHTTPError(g, err)
			return
		}
		if id == "" && name == "" {
			projectKnowledgeHTTPError(g, badRequest("Enter a file name."))
			return
		}
		file, err := c.saveProjectKnowledge(ctx, actor, access, id, name, g.GetHeader("Content-Type"), g.Request.Body, limits)
		if err != nil {
			projectKnowledgeHTTPError(g, err)
			return
		}
		g.JSON(http.StatusOK, projectKnowledgeInfo{file})
	case http.MethodDelete:
		err := c.projectKnowledgeWrite(ctx, actor, access, func(tx *sql.Tx) error {
			var size int64
			err := tx.QueryRowContext(ctx, `DELETE FROM claudex_web_files
WHERE user_id = $1 AND organization_id = $2 AND project_id = $3 AND id = $4 RETURNING size`, access.OwnerID, access.OrganizationID, access.ID, id).Scan(&size)
			if errors.Is(err, sql.ErrNoRows) {
				return notFound("file")
			}
			if err != nil {
				return failed(err)
			}
			if err := addUsage(ctx, tx, access.OwnerID, 0, -size); err != nil {
				return failed(err)
			}
			return nil
		})
		if err != nil {
			projectKnowledgeHTTPError(g, err)
			return
		}
		g.Status(http.StatusNoContent)
	}
}

func (c *Component) listProjectKnowledge(ctx context.Context, access ProjectShareAccess) ([]projectKnowledgeFile, error) {
	rows, err := c.store.db.QueryContext(ctx, `SELECT `+projectKnowledgeColumns+` FROM claudex_web_files
WHERE user_id = $1 AND organization_id = $2 AND project_id = $3 ORDER BY created_at DESC, id`, access.OwnerID, access.OrganizationID, access.ID)
	if err != nil {
		return nil, failed(err)
	}
	defer rows.Close()
	files := []projectKnowledgeFile{}
	for rows.Next() {
		var f projectKnowledgeFile
		if err := rows.Scan(&f.ID, &f.Name, &f.MIME, &f.Size, &f.CreatedAt, &f.UpdatedAt); err != nil {
			return nil, failed(err)
		}
		files = append(files, f)
	}
	if err := rows.Err(); err != nil {
		return nil, failed(err)
	}
	return files, nil
}

func (c *Component) openProjectKnowledge(ctx context.Context, access ProjectShareAccess, id string) (projectKnowledgeFile, *os.File, error) {
	var f projectKnowledgeFile
	var sha string
	err := c.store.db.QueryRowContext(ctx, `SELECT `+projectKnowledgeColumns+`, sha256 FROM claudex_web_files
WHERE user_id = $1 AND organization_id = $2 AND project_id = $3 AND id = $4`, access.OwnerID, access.OrganizationID, access.ID, id).
		Scan(&f.ID, &f.Name, &f.MIME, &f.Size, &f.CreatedAt, &f.UpdatedAt, &sha)
	if errors.Is(err, sql.ErrNoRows) {
		return f, nil, notFound("file")
	}
	if err != nil {
		return f, nil, failed(err)
	}
	body, err := os.Open(c.blobs.blobPath(access.OwnerID, sha))
	if errors.Is(err, os.ErrNotExist) {
		return f, nil, notFound("file")
	}
	if err != nil {
		return f, nil, failed(err)
	}
	return f, body, nil
}

func (c *Component) projectKnowledgeWrite(ctx context.Context, actor int64, access ProjectShareAccess, write func(*sql.Tx) error) error {
	return c.store.organizationProjectTx(ctx, actor, access.OrganizationID, false, func(tx *sql.Tx, _ projectOrganization) error {
		project, err := readProjectShare(ctx, tx, actor, access.OrganizationID, access.ID, true)
		if err != nil {
			return err
		}
		if !project.CanEditContent() {
			return errProjectKnowledgeEdit
		}
		if err := lockUserStorage(ctx, tx, project.OwnerID); err != nil {
			return failed(err)
		}
		return write(tx)
	})
}

func projectKnowledgeBytes(ctx context.Context, q querier, organizationID, projectID string) (int64, error) {
	var total int64
	err := q.QueryRowContext(ctx, `SELECT COALESCE(SUM(size), 0) FROM claudex_web_files
WHERE organization_id = $1 AND project_id = $2`, organizationID, projectID).Scan(&total)
	return total, err
}

func (c *Component) saveProjectKnowledge(ctx context.Context, actor int64, access ProjectShareAccess, id, name, contentType string, body io.Reader, limits Limits) (projectKnowledgeFile, error) {
	var f projectKnowledgeFile
	dir := filepath.Dir(c.blobs.tmpPath(access.OwnerID, projectKnowledgeTempPrefix))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return f, failed(err)
	}
	tmp, err := os.CreateTemp(dir, projectKnowledgeTempPrefix)
	if err != nil {
		return f, failed(err)
	}
	defer os.Remove(tmp.Name())
	size, err := io.Copy(tmp, io.LimitReader(body, limits.MaxFileBytes+1))
	closeErr := tmp.Close()
	var tooBig *http.MaxBytesError
	if errors.As(err, &tooBig) {
		return f, tooLarge("file")
	}
	if err != nil {
		return f, failed(err)
	}
	if closeErr != nil {
		return f, failed(closeErr)
	}
	if size > limits.MaxFileBytes {
		return f, tooLarge("file")
	}
	err = c.projectKnowledgeWrite(ctx, actor, access, func(tx *sql.Tx) error {
		column, value := "id", id
		if id == "" {
			column, value = "name", name
		}
		var oldID, oldName string
		var oldSize int64
		err := tx.QueryRowContext(ctx, `SELECT id, name, size FROM claudex_web_files
WHERE user_id = $1 AND organization_id = $2 AND project_id = $3 AND `+column+` = $4`, access.OwnerID, access.OrganizationID, access.ID, value).
			Scan(&oldID, &oldName, &oldSize)
		if errors.Is(err, sql.ErrNoRows) {
			if id != "" {
				return notFound("file")
			}
		} else if err != nil {
			return failed(err)
		}
		if name == "" {
			name = oldName
		}
		if contentType == "" {
			contentType = mime.TypeByExtension(filepath.Ext(name))
		}
		contentType = cleanMime(contentType)
		grow := size - oldSize
		if grow > 0 {
			total, err := projectKnowledgeBytes(ctx, tx, access.OrganizationID, access.ID)
			if err != nil {
				return failed(err)
			}
			if total+grow > projectKnowledgeMaxBytes {
				return tooLarge("project knowledge base")
			}
			if err := checkQuota(ctx, tx, access.OwnerID, grow, limits, quotaStrict); err != nil {
				return err
			}
		}
		sha, err := c.publishBlob(access.OwnerID, tmp.Name(), size)
		if err != nil {
			return err
		}
		if oldID == "" {
			err = tx.QueryRowContext(ctx, `INSERT INTO claudex_web_files
(user_id, organization_id, project_id, id, name, mime, size, received, sha256, state)
VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, 'ready') RETURNING `+projectKnowledgeColumns,
				access.OwnerID, access.OrganizationID, access.ID, uuid.NewString(), name, contentType, size, sha).
				Scan(&f.ID, &f.Name, &f.MIME, &f.Size, &f.CreatedAt, &f.UpdatedAt)
		} else {
			err = tx.QueryRowContext(ctx, `UPDATE claudex_web_files SET name = $5, mime = $6, size = $7, received = $7, sha256 = $8, updated_at = NOW()
WHERE user_id = $1 AND organization_id = $2 AND project_id = $3 AND id = $4 RETURNING `+projectKnowledgeColumns,
				access.OwnerID, access.OrganizationID, access.ID, oldID, name, contentType, size, sha).
				Scan(&f.ID, &f.Name, &f.MIME, &f.Size, &f.CreatedAt, &f.UpdatedAt)
		}
		var pqErr *pq.Error
		if errors.As(err, &pqErr) && pqErr.Constraint == "claudex_web_files_project_name" {
			return infraerrors.Conflict("PROJECT_KNOWLEDGE_NAME_EXISTS", "This project already has a file with that name.")
		}
		if err != nil {
			return failed(err)
		}
		if err := addUsage(ctx, tx, access.OwnerID, 0, grow); err != nil {
			return failed(err)
		}
		return nil
	})
	return f, err
}

func projectKnowledgeHTTPError(g *gin.Context, err error) {
	var op *OpError
	if !errors.As(err, &op) {
		response.ErrorFrom(g, err)
		return
	}
	switch op.Code {
	case webproto.ErrCodeTooLarge, webproto.ErrCodeQuotaExceeded:
		response.ErrorWithDetails(g, http.StatusRequestEntityTooLarge, op.Message, op.Code, nil)
	default:
		httpError(g, op)
	}
}
