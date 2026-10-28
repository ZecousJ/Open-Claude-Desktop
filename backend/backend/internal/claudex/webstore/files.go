package webstore

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Files: uploads from the browser (W-RELAY's chunked /web/uploads calls
// BeginUpload and WriteUpload) and files the runner stores (store.files.put).
// The bytes live on disk under the store directory, one folder per user:
//
//	<dir>/<user id>/tmp/<file id>     while the upload is in progress
//	<dir>/<user id>/blobs/<sha256>    once complete (shared by that user's
//	                                  files with the same bytes, never across
//	                                  users)
//
// Every file operation runs under the user's write lock (store.tx), so the
// quota reservation, the chunk offsets and the blob reference counting stay
// consistent. The declared size is reserved against the quota when the
// upload begins.

// File states.
const (
	stateUploading = "uploading"
	stateReady     = "ready"
)

// File origins.
const (
	OriginUpload = "upload" // the browser uploaded it
	OriginRunner = "runner" // the runner stored it (generated files)
)

var (
	fileIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	mimePattern   = regexp.MustCompile(`^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$`)
	shaPattern    = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// ValidFileID reports whether s can be a file id.
func ValidFileID(s string) bool { return fileIDPattern.MatchString(s) }

// FileInfo describes a stored file.
type FileInfo struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Mime      string    `json:"mime"`
	Size      int64     `json:"size"`
	Received  int64     `json:"received"`
	SHA256    string    `json:"sha256,omitempty"`
	Complete  bool      `json:"complete"`
	Origin    string    `json:"origin"`
	CreatedAt time.Time `json:"createdAt"`
}

type blobs struct{ root string }

func (b blobs) userDir(userID int64) string {
	return filepath.Join(b.root, strconv.FormatInt(userID, 10))
}

func (b blobs) tmpPath(userID int64, id string) string {
	return filepath.Join(b.userDir(userID), "tmp", id)
}

func (b blobs) blobPath(userID int64, sha string) string {
	return filepath.Join(b.userDir(userID), "blobs", sha)
}

func newFileID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b[:]), nil
}

// cleanName keeps the last path element of a file name, without control
// characters, at most 255 bytes.
func cleanName(name string) string {
	name = clean(name)
	if i := strings.LastIndexAny(name, `/\`); i >= 0 {
		name = name[i+1:]
	}
	name = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, name)
	name = strings.TrimSpace(name)
	if name == "" || name == "." || name == ".." {
		name = "file"
	}
	return truncateUTF8(name, maxNameBytes)
}

func cleanMime(mime string) string {
	mime = strings.ToLower(strings.TrimSpace(mime))
	if i := strings.IndexByte(mime, ';'); i >= 0 {
		mime = strings.TrimSpace(mime[:i])
	}
	if len(mime) > maxMimeBytes || !mimePattern.MatchString(mime) {
		return "application/octet-stream"
	}
	return mime
}

const fileColumns = `id, name, mime, size, received, sha256, state, origin, created_at`

func scanFile(sc interface{ Scan(...any) error }) (FileInfo, error) {
	var f FileInfo
	var state string
	err := sc.Scan(&f.ID, &f.Name, &f.Mime, &f.Size, &f.Received, &f.SHA256, &state, &f.Origin, &f.CreatedAt)
	f.Complete = state == stateReady
	return f, err
}

// BeginUpload starts a file of the declared size and reserves it against
// the user's quota. A file of size 0 is complete at once.
func (c *Component) BeginUpload(ctx context.Context, userID int64, name, mime string, size int64) (FileInfo, error) {
	return c.beginFile(ctx, userID, name, mime, size, OriginUpload)
}

func (c *Component) beginFile(ctx context.Context, userID int64, name, mime string, size int64, origin string) (FileInfo, error) {
	lim := c.Limits(ctx)
	if size < 0 {
		return FileInfo{}, badRequest("The file size is not valid.")
	}
	if size > lim.MaxFileBytes {
		return FileInfo{}, tooLarge("file")
	}
	id, err := newFileID()
	if err != nil {
		return FileInfo{}, failed(err)
	}
	var info FileInfo
	err = c.store.tx(ctx, userID, func(tx *sql.Tx) error {
		if err := checkQuota(ctx, tx, userID, size, lim, quotaStrict); err != nil {
			return err
		}
		row := tx.QueryRowContext(ctx, `INSERT INTO claudex_web_files (user_id, id, name, mime, size, origin)
VALUES ($1, $2, $3, $4, $5, $6) RETURNING `+fileColumns, userID, id, cleanName(name), cleanMime(mime), size, origin)
		var err error
		if info, err = scanFile(row); err != nil {
			return failed(err)
		}
		if err := addUsage(ctx, tx, userID, 0, size); err != nil {
			return failed(err)
		}
		if size == 0 {
			if err := os.MkdirAll(filepath.Dir(c.blobs.tmpPath(userID, id)), 0o700); err != nil {
				return failed(err)
			}
			if err := os.WriteFile(c.blobs.tmpPath(userID, id), nil, 0o600); err != nil {
				return failed(err)
			}
			return c.finishFile(ctx, tx, userID, &info)
		}
		return nil
	})
	return info, err
}

// WriteUpload adds the bytes at offset (the bytes received so far) to an
// upload in progress; the upload completes with its last byte. Sending the
// last chunk again answers the current state, so a retried request is safe.
func (c *Component) WriteUpload(ctx context.Context, userID int64, id string, offset int64, data []byte) (FileInfo, error) {
	if !ValidFileID(id) {
		return FileInfo{}, notFound("file")
	}
	var info FileInfo
	err := c.store.tx(ctx, userID, func(tx *sql.Tx) error {
		var state string
		row := tx.QueryRowContext(ctx, `SELECT `+fileColumns+` FROM claudex_web_files WHERE user_id = $1 AND id = $2 FOR UPDATE`, userID, id)
		var err error
		info, err = scanFile(row)
		if errors.Is(err, sql.ErrNoRows) {
			return notFound("file")
		}
		if err != nil {
			return failed(err)
		}
		if info.Complete {
			state = stateReady
		}
		n := int64(len(data))
		// A repeated chunk: nothing to write.
		if offset+n == info.Received && offset < info.Received {
			return nil
		}
		if state == stateReady {
			return badRequest("This file is already complete.")
		}
		if offset != info.Received {
			return badRequest("The upload expected the bytes from %d.", info.Received)
		}
		if n == 0 || info.Received+n > info.Size {
			return badRequest("The chunk doesn't fit the declared file size.")
		}
		path := c.blobs.tmpPath(userID, id)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return failed(err)
		}
		f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY, 0o600)
		if err != nil {
			return failed(err)
		}
		// Drop anything past the recorded length (a write that was never
		// committed), then write the chunk in place.
		if err := f.Truncate(info.Received); err != nil {
			_ = f.Close()
			return failed(err)
		}
		if _, err := f.WriteAt(data, info.Received); err != nil {
			_ = f.Close()
			return failed(err)
		}
		if err := f.Close(); err != nil {
			return failed(err)
		}
		info.Received += n
		if _, err := tx.ExecContext(ctx, `UPDATE claudex_web_files SET received = $3, updated_at = NOW() WHERE user_id = $1 AND id = $2`,
			userID, id, info.Received); err != nil {
			return failed(err)
		}
		if info.Received == info.Size {
			return c.finishFile(ctx, tx, userID, &info)
		}
		return nil
	})
	return info, err
}

// finishFile hashes a complete upload and moves it to its blob.
func (c *Component) finishFile(ctx context.Context, tx *sql.Tx, userID int64, info *FileInfo) error {
	tmp := c.blobs.tmpPath(userID, info.ID)
	f, err := os.Open(tmp)
	if err != nil {
		return failed(err)
	}
	h := sha256.New()
	n, err := io.Copy(h, f)
	_ = f.Close()
	if err != nil {
		return failed(err)
	}
	if n != info.Size {
		return failed(errors.New("webstore: upload size changed on disk"))
	}
	sum := hex.EncodeToString(h.Sum(nil))
	dst := c.blobs.blobPath(userID, sum)
	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		return failed(err)
	}
	if _, err := os.Stat(dst); err == nil {
		_ = os.Remove(tmp)
	} else if err := os.Rename(tmp, dst); err != nil {
		return failed(err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE claudex_web_files SET sha256 = $3, state = 'ready', received = size, updated_at = NOW()
WHERE user_id = $1 AND id = $2`, userID, info.ID, sum); err != nil {
		return failed(err)
	}
	info.SHA256, info.Complete, info.Received = sum, true, info.Size
	return nil
}

// File returns a file of the user.
func (c *Component) File(ctx context.Context, userID int64, id string) (FileInfo, error) {
	if !ValidFileID(id) {
		return FileInfo{}, notFound("file")
	}
	if err := c.store.ok(); err != nil {
		return FileInfo{}, err
	}
	info, err := scanFile(c.store.db.QueryRowContext(ctx, `SELECT `+fileColumns+` FROM claudex_web_files WHERE user_id = $1 AND id = $2`, userID, id))
	if errors.Is(err, sql.ErrNoRows) {
		return FileInfo{}, notFound("file")
	}
	if err != nil {
		return FileInfo{}, failed(err)
	}
	return info, nil
}

// OpenFile opens a complete file of the user for reading.
func (c *Component) OpenFile(ctx context.Context, userID int64, id string) (FileInfo, *os.File, error) {
	info, err := c.File(ctx, userID, id)
	if err != nil {
		return info, nil, err
	}
	if !info.Complete || !shaPattern.MatchString(info.SHA256) {
		return info, nil, notFound("file")
	}
	f, err := os.Open(c.blobs.blobPath(userID, info.SHA256))
	if errors.Is(err, os.ErrNotExist) {
		return info, nil, notFound("file")
	}
	if err != nil {
		return info, nil, failed(err)
	}
	return info, f, nil
}

// ReadFile reads up to length bytes of a complete file from offset.
func (c *Component) ReadFile(ctx context.Context, userID int64, id string, offset, length int64) (FileInfo, []byte, error) {
	if offset < 0 || length < 0 {
		return FileInfo{}, nil, badRequest("The range is not valid.")
	}
	if length > fileReadBytes {
		length = fileReadBytes
	}
	info, f, err := c.OpenFile(ctx, userID, id)
	if err != nil {
		return info, nil, err
	}
	defer func() { _ = f.Close() }()
	if offset > info.Size {
		return info, nil, badRequest("The range is not valid.")
	}
	if rest := info.Size - offset; length > rest {
		length = rest
	}
	buf := make([]byte, length)
	if _, err := f.ReadAt(buf, offset); err != nil && !errors.Is(err, io.EOF) {
		return info, nil, failed(err)
	}
	return info, buf, nil
}

// DeleteFile deletes a file of the user (and its bytes once no other file
// of the user has them). Deleting a missing file succeeds.
func (c *Component) DeleteFile(ctx context.Context, userID int64, id string) error {
	if !ValidFileID(id) {
		return nil
	}
	return c.store.tx(ctx, userID, func(tx *sql.Tx) error {
		return c.deleteFileTx(ctx, tx, userID, id)
	})
}

func (c *Component) deleteFileTx(ctx context.Context, tx *sql.Tx, userID int64, id string) error {
	var size int64
	var sha, state string
	err := tx.QueryRowContext(ctx, `DELETE FROM claudex_web_files WHERE user_id = $1 AND id = $2 RETURNING size, sha256, state`, userID, id).
		Scan(&size, &sha, &state)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return failed(err)
	}
	if err := addUsage(ctx, tx, userID, 0, -size); err != nil {
		return failed(err)
	}
	if state != stateReady {
		_ = os.Remove(c.blobs.tmpPath(userID, id))
		return nil
	}
	if !shaPattern.MatchString(sha) {
		return nil
	}
	var others int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM claudex_web_files WHERE user_id = $1 AND sha256 = $2 AND state = 'ready'`, userID, sha).
		Scan(&others); err != nil {
		return failed(err)
	}
	if others == 0 {
		_ = os.Remove(c.blobs.blobPath(userID, sha))
	}
	return nil
}

// listFiles lists the user's files, newest first.
func (c *Component) listFiles(ctx context.Context, q querier, userID int64) ([]FileInfo, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+fileColumns+` FROM claudex_web_files WHERE user_id = $1 ORDER BY created_at DESC, id`, userID)
	if err != nil {
		return nil, failed(err)
	}
	defer func() { _ = rows.Close() }()
	out := []FileInfo{}
	for rows.Next() {
		f, err := scanFile(rows)
		if err != nil {
			return nil, failed(err)
		}
		out = append(out, f)
	}
	if err := rows.Err(); err != nil {
		return nil, failed(err)
	}
	return out, nil
}
