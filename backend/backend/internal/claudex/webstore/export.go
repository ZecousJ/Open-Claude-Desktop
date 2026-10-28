package webstore

import (
	"archive/zip"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"

	"github.com/gin-gonic/gin"
)

// httpError answers an OpError with the matching HTTP status.
func httpError(g *gin.Context, err error) {
	e := asOpError(err)
	if e.cause != nil {
		slogWarn("webstore: download failed", e.cause)
	}
	switch e.Code {
	case ErrCodeNotFound:
		response.ErrorFrom(g, infraerrors.NotFound(e.Code, e.Message))
	case webproto.ErrCodeBadRequest:
		response.ErrorFrom(g, infraerrors.BadRequest(e.Code, e.Message))
	default:
		response.ErrorFrom(g, infraerrors.InternalServer(e.Code, e.Message))
	}
}

// downloadHeaders keep a download from ever rendering in the app's origin.
func downloadHeaders(g *gin.Context, name string) {
	h := g.Writer.Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Set("Content-Disposition", "attachment; filename=\""+asciiName(name)+"\"; filename*=UTF-8''"+url.PathEscape(name))
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	h.Set("Cache-Control", "private, no-store")
	h.Set("Cross-Origin-Resource-Policy", "same-origin")
}

func asciiName(name string) string {
	return strings.Map(func(r rune) rune {
		if r < 0x20 || r > 0x7e || r == '"' || r == '\\' {
			return '_'
		}
		return r
	}, name)
}

// GET /api/v1/claudex/web/downloads/files/:id: one of the user's files.
func (c *Component) downloadFile(g *gin.Context) {
	userID, ok := core.Subject(g)
	if !ok {
		response.ErrorFrom(g, infraerrors.Unauthorized("UNAUTHORIZED", "Sign in first."))
		return
	}
	info, f, err := c.OpenFile(g.Request.Context(), userID, g.Param("id"))
	if err != nil {
		httpError(g, err)
		return
	}
	defer func() { _ = f.Close() }()
	downloadHeaders(g, info.Name)
	g.Writer.Header().Set("Content-Length", strconv.FormatInt(info.Size, 10))
	g.Status(http.StatusOK)
	_, _ = io.Copy(g.Writer, f)
}

// ExportFormat names the export archive's layout.
const ExportFormat = "claudex-web-export"

// GET /api/v1/claudex/web/downloads/export: the user's whole account as a
// zip archive, streamed:
//
//	manifest.json                    format, version, time, counts
//	settings.json                    the settings document (null when none)
//	projects.json                    the projects, in order
//	conversations/<id>.json          each conversation with its turns (the
//	                                 shape of shared/types.ts Conversation)
//	artifacts/<id>.json              each artifact's kept versions
//	files/<id>/<name>                each complete file
func (c *Component) export(g *gin.Context) {
	userID, ok := core.Subject(g)
	if !ok {
		response.ErrorFrom(g, infraerrors.Unauthorized("UNAUTHORIZED", "Sign in first."))
		return
	}
	ctx := g.Request.Context()
	if err := c.store.ok(); err != nil {
		httpError(g, err)
		return
	}
	// Read the first rows before any byte is written, so an unavailable
	// database still gets a JSON error.
	settings, err := c.store.getSettings(ctx, userID)
	if err != nil {
		httpError(g, err)
		return
	}
	downloadHeaders(g, "claudex-export-"+c.now().Format("2006-01-02")+".zip")
	g.Writer.Header().Set("Content-Type", "application/zip")
	g.Status(http.StatusOK)
	if err := c.WriteExport(ctx, userID, settings, g.Writer); err != nil {
		// The status is already sent; the archive is left incomplete, which
		// the zip reader reports.
		slogWarn("webstore: export failed", err)
	}
}

// WriteExport writes the export archive of the user to w (settings as read
// by the caller, nil to read them here).
func (c *Component) WriteExport(ctx context.Context, userID int64, settings json.RawMessage, w io.Writer) error {
	if settings == nil {
		var err error
		if settings, err = c.store.getSettings(ctx, userID); err != nil {
			return err
		}
	}
	zw := zip.NewWriter(w)
	now := c.now()
	put := func(name string, v any) error {
		f, err := zw.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Deflate, Modified: now})
		if err != nil {
			return err
		}
		enc := json.NewEncoder(f)
		enc.SetIndent("", "  ")
		return enc.Encode(v)
	}
	if settings == nil {
		settings = json.RawMessage("null")
	}
	if err := put("settings.json", settings); err != nil {
		return err
	}

	projects := []json.RawMessage{}
	for cursor := ""; ; {
		list, next, err := c.store.listProjects(ctx, userID, cursor)
		if err != nil {
			return err
		}
		projects = append(projects, list...)
		if next == "" {
			break
		}
		cursor = next
	}
	if err := put("projects.json", projects); err != nil {
		return err
	}

	conversations := 0
	for cursor := ""; ; {
		rows, next, err := c.store.listConversations(ctx, userID, cursor)
		if err != nil {
			return err
		}
		for _, row := range rows {
			var doc struct {
				Conversation struct {
					ID string `json:"id"`
				} `json:"conversation"`
			}
			if json.Unmarshal(row.Doc, &doc) != nil || !docID.MatchString(doc.Conversation.ID) {
				continue
			}
			full, err := c.loadConversation(ctx, userID, doc.Conversation.ID)
			if err != nil {
				return err
			}
			raw, err := full.JSON()
			if err != nil {
				return err
			}
			if err := put("conversations/"+doc.Conversation.ID+".json", raw); err != nil {
				return err
			}
			conversations++
		}
		if next == "" {
			break
		}
		cursor = next
	}

	artifacts := 0
	for cursor := ""; ; {
		list, next, err := c.store.listArtifacts(ctx, userID, nil, cursor)
		if err != nil {
			return err
		}
		for _, a := range list {
			var head struct {
				ID string `json:"id"`
			}
			if json.Unmarshal(a.Artifact, &head) != nil || !docID.MatchString(head.ID) {
				continue
			}
			versions, err := c.store.listArtifactVersions(ctx, userID, head.ID)
			if err != nil {
				return err
			}
			if err := put("artifacts/"+head.ID+".json", map[string]any{"versions": versions}); err != nil {
				return err
			}
			artifacts++
		}
		if next == "" {
			break
		}
		cursor = next
	}

	files, err := c.listFiles(ctx, c.store.db, userID)
	if err != nil {
		return err
	}
	exported := 0
	for _, info := range files {
		if !info.Complete {
			continue
		}
		_, f, err := c.OpenFile(ctx, userID, info.ID)
		if err != nil {
			continue // deleted meanwhile
		}
		dst, err := zw.CreateHeader(&zip.FileHeader{Name: "files/" + info.ID + "/" + zipName(info.Name), Method: zip.Store, Modified: info.CreatedAt})
		if err == nil {
			_, err = io.Copy(dst, f)
		}
		_ = f.Close()
		if err != nil {
			return err
		}
		exported++
	}

	if err := put("manifest.json", map[string]any{
		"format": ExportFormat, "version": 1, "exportedAt": now.Format(time.RFC3339),
		"projects": len(projects), "conversations": conversations, "artifacts": artifacts, "files": exported,
	}); err != nil {
		return err
	}
	return zw.Close()
}

// zipName is a file name safe inside the archive (no directories).
func zipName(name string) string {
	name = strings.NewReplacer("/", "_", `\`, "_").Replace(name)
	if name == "" || name == "." || name == ".." {
		return "file"
	}
	return name
}
