package webstore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/attachmentstore"
)

func (c *Component) migrateAttachmentObjects(ctx context.Context) (int, error) {
	rows, err := c.store.db.QueryContext(ctx, `SELECT user_id,id,sha256,size FROM claudex_web_files
WHERE state='ready' AND NOT object_storage AND organization_id IS NULL AND size>0 ORDER BY updated_at LIMIT 24`)
	if err != nil {
		return 0, err
	}
	type entry struct {
		user, size int64
		id, sha    string
	}
	var batch []entry
	for rows.Next() {
		var row entry
		if err := rows.Scan(&row.user, &row.id, &row.sha, &row.size); err != nil {
			_ = rows.Close()
			return 0, err
		}
		batch = append(batch, row)
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	count := 0
	var failure error
	for _, row := range batch {
		fctx, cancel := context.WithTimeout(ctx, 90*time.Second)
		ok, err := c.copyLegacyAttachment(fctx, row.user, row.id, row.sha, row.size)
		cancel()
		if err != nil {
			failure = errors.Join(failure, err)
		}
		if ok {
			count++
		}
	}
	return count, failure
}

func (c *Component) copyLegacyAttachment(ctx context.Context, userID int64, id, sha string, size int64) (bool, error) {
	if !ValidFileID(id) || !shaPattern.MatchString(sha) {
		return false, nil
	}
	file, err := os.Open(c.blobs.blobPath(userID, sha))
	if err != nil {
		return false, err
	}
	defer file.Close()
	var candidate bool
	err = c.store.tx(ctx, userID, func(tx *sql.Tx) error {
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM claudex_web_files
WHERE user_id=$1 AND id=$2 AND sha256=$3 AND state='ready' AND NOT object_storage AND organization_id IS NULL)`, userID, id, sha).Scan(&candidate); err != nil || !candidate {
			return err
		}
		return recordAttachmentObject(ctx, tx, userID, id)
	})
	if err != nil || !candidate {
		return false, err
	}
	key := attachmentstore.Key(userID, id)
	if err := c.objects.CopyFrom(ctx, key, file, size, sha); err != nil {
		return false, err
	}
	remoteSize, err := c.objects.Size(ctx, key)
	if err != nil {
		return false, err
	}
	if remoteSize != size {
		return false, fmt.Errorf("attachment copy has an unexpected size")
	}
	remote, err := c.objects.Open(ctx, key, "bytes=0-0")
	if err != nil {
		return false, err
	}
	var first [1]byte
	_, err = io.ReadFull(remote, first[:])
	_ = remote.Close()
	if err != nil {
		return false, err
	}
	changed, err := c.store.db.ExecContext(ctx, `UPDATE claudex_web_files SET object_storage=TRUE
WHERE user_id=$1 AND id=$2 AND sha256=$3 AND state='ready' AND NOT object_storage AND organization_id IS NULL`, userID, id, sha)
	if err != nil {
		return false, err
	}
	count, err := changed.RowsAffected()
	return count == 1, err
}
