package webhost

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"time"
)

const privateUploadPrefix = "private_"
const privateUploadLifetime = 5 * time.Minute
const privateUploadLimit = 64 << 20
const privateUploadGlobalLimit = 256 << 20

type privateUpload struct {
	user     int64
	size     int64
	data     []byte
	sha      string
	complete bool
	timer    *time.Timer
}
type privateUploadSet struct {
	mu       sync.Mutex
	rows     map[string]*privateUpload
	reserved int64
	users    map[int64]int64
}

func (s *privateUploadSet) removeLocked(id string) {
	row := s.rows[id]
	if row == nil {
		return
	}
	delete(s.rows, id)
	s.reserved -= row.size
	s.users[row.user] -= row.size
	if s.users[row.user] == 0 {
		delete(s.users, row.user)
	}
	if row.timer != nil {
		row.timer.Stop()
	}
}
func (s *privateUploadSet) begin(user, size int64, sha string) (string, error) {
	if size <= 0 || size > privateUploadLimit || !shaPattern.MatchString(sha) {
		return "", errors.New("invalid private upload size")
	}
	var b [24]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	id := privateUploadPrefix + base64.RawURLEncoding.EncodeToString(b[:])
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.rows == nil {
		s.rows = make(map[string]*privateUpload)
		s.users = make(map[int64]int64)
	}
	if s.reserved+size > privateUploadGlobalLimit || s.users[user]+size > privateUploadLimit {
		return "", errors.New("private upload capacity exhausted")
	}
	row := &privateUpload{user: user, size: size, sha: sha}
	s.rows[id] = row
	s.reserved += size
	s.users[user] += size
	row.timer = time.AfterFunc(privateUploadLifetime, func() { s.mu.Lock(); defer s.mu.Unlock(); s.removeLocked(id) })
	return id, nil
}
func (s *privateUploadSet) write(user int64, id string, offset int64, data []byte) (int64, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	row := s.rows[id]
	if row == nil || row.user != user || row.complete || offset != int64(len(row.data)) || offset+int64(len(data)) > row.size {
		return 0, false, errors.New("invalid private upload")
	}
	row.data = append(row.data, data...)
	return int64(len(row.data)), int64(len(row.data)) == row.size, nil
}
func (s *privateUploadSet) finish(user int64, id string) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	row := s.rows[id]
	if row == nil || row.user != user || int64(len(row.data)) != row.size {
		return 0, errors.New("invalid private upload")
	}
	sum := sha256.Sum256(row.data)
	if row.sha == "" || hex.EncodeToString(sum[:]) != row.sha {
		s.removeLocked(id)
		return 0, errors.New("invalid private upload checksum")
	}
	row.complete = true
	return row.size, nil
}
func (s *privateUploadSet) serve(user int64, op string, body json.RawMessage) (any, bool, error) {
	var req struct {
		ID     string `json:"id"`
		Offset int64  `json:"offset"`
		Length int64  `json:"length"`
	}
	if json.Unmarshal(body, &req) != nil || !strings.HasPrefix(req.ID, privateUploadPrefix) {
		return nil, false, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	row := s.rows[req.ID]
	if row == nil || row.user != user {
		return nil, true, errors.New("private upload unavailable")
	}
	if op == "store.files.delete" {
		s.removeLocked(req.ID)
		return map[string]any{}, true, nil
	}
	if op != "store.files.get" || !row.complete || req.Offset < 0 || req.Length < 0 || req.Length > 4<<20 || req.Offset > row.size {
		return nil, true, errors.New("invalid private upload read")
	}
	end := req.Offset + req.Length
	if end > row.size {
		end = row.size
	}
	data := row.data[req.Offset:end]
	return map[string]any{"size": row.size, "bytes": map[string]string{"$bytes": base64.StdEncoding.EncodeToString(data)}}, true, nil
}
