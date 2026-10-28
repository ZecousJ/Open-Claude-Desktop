package webstore

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

// Cleanup: every hour (first run 5 minutes after start).
const (
	cleanupFirstRun = 5 * time.Minute
	cleanupInterval = time.Hour
	cleanupTimeout  = 15 * time.Minute
	// Uploads not finished within a day are dropped (and their reservation
	// released).
	staleUpload = 24 * time.Hour
	// Blobs without a file row are removed once this old (a blob that was
	// just written belongs to a transaction that may still commit).
	orphanBlobAge  = time.Hour
	cleanupBatch   = 500
	cleanupMaxUser = 1000
)

func slogWarn(msg string, err error) { slog.Warn(msg, "error", err) }

func (c *Component) cleanupLoop(ctx context.Context) {
	timer := time.NewTimer(cleanupFirstRun)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		runCtx, cancel := context.WithTimeout(ctx, cleanupTimeout)
		stats, err := c.Cleanup(runCtx)
		cancel()
		if err != nil {
			slogWarn("claudex webstore: cleanup failed", err)
		} else if stats != (CleanupStats{}) {
			slog.Info("claudex webstore: cleanup", "stale_uploads", stats.StaleUploads,
				"deleted_accounts", stats.DeletedAccounts, "orphan_blobs", stats.OrphanBlobs)
		}
		timer.Reset(cleanupInterval)
	}
}

// CleanupStats counts what a cleanup removed.
type CleanupStats struct {
	StaleUploads    int
	DeletedAccounts int
	OrphanBlobs     int
}

// Cleanup drops abandoned uploads, removes every row and file of deleted
// accounts, and removes blobs no file row refers to.
func (c *Component) Cleanup(ctx context.Context) (CleanupStats, error) {
	var st CleanupStats
	if err := c.store.ok(); err != nil {
		return st, err
	}
	n, err := c.dropStaleUploads(ctx)
	st.StaleUploads = n
	if err != nil {
		return st, err
	}
	n, err = c.purgeDeletedAccounts(ctx)
	st.DeletedAccounts = n
	if err != nil {
		return st, err
	}
	st.OrphanBlobs, err = c.removeOrphanBlobs(ctx)
	return st, err
}

func (c *Component) dropStaleUploads(ctx context.Context) (int, error) {
	rows, err := c.store.db.QueryContext(ctx, `SELECT user_id, id FROM claudex_web_files
WHERE state = 'uploading' AND updated_at < $1 ORDER BY updated_at LIMIT $2`, c.now().Add(-staleUpload), cleanupBatch)
	if err != nil {
		return 0, err
	}
	type key struct {
		user int64
		id   string
	}
	var stale []key
	for rows.Next() {
		var k key
		if err := rows.Scan(&k.user, &k.id); err != nil {
			_ = rows.Close()
			return 0, err
		}
		stale = append(stale, k)
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	for _, k := range stale {
		if err := c.DeleteFile(ctx, k.user, k.id); err != nil {
			return 0, err
		}
	}
	return len(stale), nil
}

// accountGone reports whether the user row is missing or soft-deleted.
func (c *Component) accountGone(ctx context.Context, userID int64) (bool, error) {
	var deleted bool
	err := c.store.db.QueryRowContext(ctx, `SELECT deleted_at IS NOT NULL FROM users WHERE id = $1`, userID).Scan(&deleted)
	if errors.Is(err, sql.ErrNoRows) {
		return true, nil
	}
	return deleted, err
}

// PurgeUser removes every webstore row and file of a user (the account was
// deleted). Users cannot delete their own account (owner decision), so only
// the cleanup calls it.
func (c *Component) PurgeUser(ctx context.Context, userID int64) error {
	err := c.store.tx(ctx, userID, func(tx *sql.Tx) error {
		for _, table := range []string{
			"claudex_web_artifacts", "claudex_web_conversations", "claudex_web_projects",
			"claudex_web_settings", "claudex_web_files", "claudex_web_store_usage",
		} {
			// Turns and artifact versions go with their parents (cascade).
			if _, err := tx.ExecContext(ctx, `DELETE FROM `+table+` WHERE user_id = $1`, userID); err != nil {
				return failed(err)
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	if err := os.RemoveAll(c.blobs.userDir(userID)); err != nil {
		return failed(err)
	}
	return nil
}

func (c *Component) purgeDeletedAccounts(ctx context.Context) (int, error) {
	// Accounts with rows (soft-deleted users keep their rows until here;
	// hard-deleted ones lost them through ON DELETE CASCADE) and accounts
	// with a folder on disk.
	candidates := map[int64]bool{}
	rows, err := c.store.db.QueryContext(ctx, `SELECT s.user_id FROM claudex_web_store_usage s
LEFT JOIN users u ON u.id = s.user_id WHERE u.id IS NULL OR u.deleted_at IS NOT NULL LIMIT $1`, cleanupMaxUser)
	if err != nil {
		return 0, err
	}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return 0, err
		}
		candidates[id] = true
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	if entries, err := os.ReadDir(c.blobs.root); err == nil {
		for _, e := range entries {
			if len(candidates) >= cleanupMaxUser {
				break
			}
			id, err := strconv.ParseInt(e.Name(), 10, 64)
			if err != nil || id < 1 || !e.IsDir() {
				continue
			}
			gone, err := c.accountGone(ctx, id)
			if err != nil {
				return 0, err
			}
			if gone {
				candidates[id] = true
			}
		}
	}
	n := 0
	for id := range candidates {
		if err := c.PurgeUser(ctx, id); err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}

func (c *Component) removeOrphanBlobs(ctx context.Context) (int, error) {
	entries, err := os.ReadDir(c.blobs.root)
	if err != nil {
		return 0, nil // nothing stored yet
	}
	removed := 0
	cutoff := time.Now().Add(-orphanBlobAge)
	for _, e := range entries {
		id, err := strconv.ParseInt(e.Name(), 10, 64)
		if err != nil || id < 1 || !e.IsDir() {
			continue
		}
		dir := filepath.Join(c.blobs.userDir(id), "blobs")
		blobsOnDisk, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, b := range blobsOnDisk {
			if !shaPattern.MatchString(b.Name()) {
				continue
			}
			info, err := b.Info()
			if err != nil || info.ModTime().After(cutoff) {
				continue
			}
			err = c.store.tx(ctx, id, func(tx *sql.Tx) error {
				var refs int
				if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM claudex_web_files WHERE user_id = $1 AND sha256 = $2`, id, b.Name()).Scan(&refs); err != nil {
					return failed(err)
				}
				if refs == 0 {
					if err := os.Remove(filepath.Join(dir, b.Name())); err == nil {
						removed++
					}
				}
				return nil
			})
			if err != nil {
				return removed, err
			}
		}
	}
	return removed, nil
}
