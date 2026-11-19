package webhost

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
	"net/http"
	"strings"
	"testing"
)

func TestPrivateUploadLifecycle(t *testing.T) {
	var s privateUploadSet
	data := []byte("private fixture")
	sum := sha256.Sum256(data)
	id, err := s.begin(1, int64(len(data)), hex.EncodeToString(sum[:]))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(id, privateUploadPrefix) {
		t.Fatal("missing private prefix")
	}
	if _, _, err = s.write(2, id, 0, data); err == nil {
		t.Fatal("foreign upload accepted")
	}
	if _, _, err = s.write(1, id, 0, data); err != nil {
		t.Fatal(err)
	}
	if _, err = s.finish(1, id); err != nil {
		t.Fatal(err)
	}
	req, _ := json.Marshal(map[string]any{"id": id, "offset": 0, "length": len(data)})
	if _, handled, err := s.serve(2, "store.files.get", req); !handled || err == nil {
		t.Fatal("foreign read accepted")
	}
	value, handled, err := s.serve(1, "store.files.get", req)
	if !handled || err != nil || value == nil {
		t.Fatal("owned read failed", err)
	}
	if _, _, err = s.serve(1, "store.files.delete", req); err != nil {
		t.Fatal(err)
	}
	if _, handled, err = s.serve(1, "store.files.get", req); !handled || err == nil {
		t.Fatal("deleted upload remained available")
	}
	if s.reserved != 0 || s.users[1] != 0 {
		t.Fatal("upload reservation leaked")
	}
}
func TestPrivateUploadRejectsBadDigest(t *testing.T) {
	var s privateUploadSet
	id, err := s.begin(1, 1, strings.Repeat("0", 64))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = s.write(1, id, 0, []byte("x")); err != nil {
		t.Fatal(err)
	}
	if _, err = s.finish(1, id); err == nil {
		t.Fatal("bad digest accepted")
	}
	if s.reserved != 0 {
		t.Fatal("invalid upload reservation leaked")
	}
}

func TestPrivateUploadHTTPBypassesPersistentStore(t *testing.T) {
	h := newHost(t)
	data := []byte("private multipart fixture")
	body, _ := json.Marshal(map[string]any{"name": "private.bin", "size": len(data), "type": "application/octet-stream", "sha256": sha256Hex(data), "private": true})
	status, res := h.post(userA, webproto.PathUploads, "application/json", body)
	if status != http.StatusOK {
		t.Fatalf("begin: %d %v", status, res.Error)
	}
	var v struct{ ID string }
	if err := json.Unmarshal(res.Value, &v); err != nil {
		t.Fatal(err)
	}
	status, _ = h.do(userA, http.MethodPut, webproto.PathUploads+"/"+v.ID+"/chunks/0", "application/octet-stream", data)
	if status != http.StatusOK {
		t.Fatalf("write: %d", status)
	}
	status, _ = h.post(userA, webproto.PathUploads+"/"+v.ID+"/complete", "application/json", []byte(`{}`))
	if status != http.StatusOK {
		t.Fatalf("complete: %d", status)
	}
	if _, err := h.uploads.File(context.Background(), userA, v.ID); err == nil {
		t.Fatal("private upload reached persistent store")
	}
	req, _ := json.Marshal(map[string]any{"id": v.ID, "offset": 0, "length": len(data)})
	if _, handled, err := h.c.privateUploads.serve(userA, "store.files.get", req); !handled || err != nil {
		t.Fatal("runner could not read private upload", err)
	}
}
