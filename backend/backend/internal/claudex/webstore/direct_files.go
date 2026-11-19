package webstore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/attachmentstore"
)

func (c *Component) BeginDirectUpload(ctx context.Context, userID int64, name, mime string, size int64, sha string) (FileInfo, *attachmentstore.Upload, error) {
	return c.beginObjectFile(ctx, userID, name, mime, size, sha, OriginUpload, "")
}

func (c *Component) beginObjectFile(ctx context.Context, userID int64, name, mime string, size int64, sha, origin, stableID string) (FileInfo, *attachmentstore.Upload, error) {
	if c.objects == nil || size == 0 || sha == "" {
		return FileInfo{}, nil, nil
	}
	if size < 0 || !shaPattern.MatchString(sha) {
		return FileInfo{}, nil, badRequest("The upload was not valid.")
	}
	info, err := c.beginFile(ctx, userID, name, mime, size, origin, sha, stableID)
	if err != nil {
		return FileInfo{}, nil, err
	}
	if info.Complete {
		return info, nil, nil
	}
	address, err := c.objects.UploadURL(ctx, attachmentstore.Key(userID, info.ID), size, sha)
	if err != nil {
		return FileInfo{}, nil, failed(err)
	}
	return info, &address, nil
}

func (c *Component) CompleteDirectUpload(ctx context.Context, userID int64, id string) (FileInfo, error) {
	if c.objects == nil {
		return FileInfo{}, failed(errors.New("attachment object storage unavailable"))
	}
	var info FileInfo
	err := c.store.tx(ctx, userID, func(tx *sql.Tx) error {
		row := tx.QueryRowContext(ctx, `SELECT `+fileColumns+` FROM claudex_web_files
WHERE user_id = $1 AND id = $2 AND organization_id IS NULL AND object_storage FOR UPDATE`, userID, id)
		var err error
		info, err = scanFile(row)
		if errors.Is(err, sql.ErrNoRows) {
			return notFound("file")
		}
		if err != nil {
			return failed(err)
		}
		if info.Complete {
			return nil
		}
		size, err := c.objects.Size(ctx, attachmentstore.Key(userID, id))
		if err != nil {
			return failed(err)
		}
		if size != info.Size {
			return badRequest("The upload does not match the declared size.")
		}
		if _, err := tx.ExecContext(ctx, `UPDATE claudex_web_files SET state='ready', received=size, updated_at=NOW()
WHERE user_id=$1 AND id=$2`, userID, id); err != nil {
			return failed(err)
		}
		info.Received, info.Complete = size, true
		return nil
	})
	return info, err
}

func (c *Component) downloadURL(ctx context.Context, userID int64, info FileInfo, asDownload bool) (string, error) {
	if !info.Complete {
		return "", notFound("file")
	}
	if c.objects == nil {
		return "", failed(errors.New("attachment object storage unavailable"))
	}
	var contentType, disposition string
	if asDownload {
		contentType = "application/octet-stream"
		disposition = fmt.Sprintf(`attachment; filename="%s"; filename*=UTF-8''%s`, asciiName(info.Name), url.PathEscape(info.Name))
	}
	address, err := c.objects.DownloadURL(ctx, attachmentstore.Key(userID, info.ID), contentType, disposition)
	if err != nil {
		return "", failed(err)
	}
	return address, nil
}

func recordAttachmentObject(ctx context.Context, tx *sql.Tx, userID int64, id string) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO claudex_web_attachment_objects(user_id,file_id) VALUES($1,$2)
ON CONFLICT(user_id,file_id) DO UPDATE SET recorded_at=NOW()`, userID, id)
	if err != nil {
		return failed(err)
	}
	return nil
}

func (c *Component) deleteQueuedObjects(ctx context.Context) error {
	if c.objects == nil {
		return nil
	}
	cutoff := c.now().Add(-15 * time.Minute)
	rows, err := c.store.db.QueryContext(ctx, `SELECT o.user_id,o.file_id FROM claudex_web_attachment_objects o
WHERE recorded_at <= $1 AND NOT EXISTS (SELECT 1 FROM claudex_web_files f WHERE f.user_id=o.user_id AND f.id=o.file_id)
ORDER BY recorded_at LIMIT 100`, cutoff)
	if err != nil {
		return err
	}
	type entry struct {
		user int64
		id   string
	}
	var batch []entry
	for rows.Next() {
		var row entry
		if err := rows.Scan(&row.user, &row.id); err != nil {
			_ = rows.Close()
			return err
		}
		batch = append(batch, row)
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	var failure error
	for _, row := range batch {
		dctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		err := c.store.tx(dctx, row.user, func(tx *sql.Tx) error {
			var pending bool
			if err := tx.QueryRowContext(dctx, `SELECT EXISTS(SELECT 1 FROM claudex_web_attachment_objects
WHERE user_id=$1 AND file_id=$2 AND recorded_at<=$3) AND NOT EXISTS(
SELECT 1 FROM claudex_web_files WHERE user_id=$1 AND id=$2)`, row.user, row.id, cutoff).Scan(&pending); err != nil || !pending {
				return err
			}
			if err := c.objects.Delete(dctx, attachmentstore.Key(row.user, row.id)); err != nil {
				return err
			}
			_, err := tx.ExecContext(dctx, "DELETE FROM claudex_web_attachment_objects WHERE user_id=$1 AND file_id=$2", row.user, row.id)
			return err
		})
		cancel()
		if err != nil {
			failure = errors.Join(failure, err)
		}
	}
	return failure
}
