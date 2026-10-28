package webhost

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"sync"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
	"github.com/Wei-Shaw/sub2api/internal/claudex/webstore"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"

	"github.com/gin-gonic/gin"
)

// Uploads (web plan §1.2): the browser sends bytes larger than an RPC body
// holds in 1 MiB chunks into the user's webstore file area; the call then
// names the upload ({"$upload": id}) and the runner reads it back through
// store.files.get. Routes (user group, JWT):
//
//	POST uploads                      {name, size, type, sha256} → {id}
//	PUT  uploads/:id/chunks/:index    raw bytes, ≤ webproto.UploadChunkBytes
//	POST uploads/:id/complete         {} → {id} (the SHA-256 must match)
//
// Answers use the RPC envelope ({ok, value} / {ok:false, error}).

var (
	errUploadsOff  = infraerrors.ServiceUnavailable(webproto.ErrCodeRunnerUnavailable, "Uploads are not available right now. Try again later.")
	errBadUpload   = infraerrors.BadRequest(webproto.ErrCodeBadRequest, "The upload was not valid.")
	errBadChecksum = infraerrors.BadRequest(webproto.ErrCodeBadRequest, "The upload arrived damaged. Try again.")
	errIncomplete  = infraerrors.BadRequest(webproto.ErrCodeBadRequest, "The upload is not complete.")
	shaPattern     = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// uploadSums remembers the SHA-256 each upload declared (memory, 24 h).
type uploadSums struct {
	mu sync.Mutex
	m  map[string]uploadSum
}

type uploadSum struct {
	sha     string
	expires time.Time
}

func (u *uploadSums) put(userID int64, id, sha string, now time.Time) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.m == nil {
		u.m = map[string]uploadSum{}
	}
	for k, v := range u.m {
		if now.After(v.expires) {
			delete(u.m, k)
		}
	}
	u.m[strconv.FormatInt(userID, 10)+":"+id] = uploadSum{sha: sha, expires: now.Add(24 * time.Hour)}
}

func (u *uploadSums) take(userID int64, id string) (string, bool) {
	u.mu.Lock()
	defer u.mu.Unlock()
	k := strconv.FormatInt(userID, 10) + ":" + id
	v, ok := u.m[k]
	delete(u.m, k)
	return v.sha, ok
}

func uploadError(g *gin.Context, err error) {
	var op *webstore.OpError
	if errors.As(err, &op) {
		status := http.StatusBadRequest
		switch op.Code {
		case webstore.ErrCodeNotFound:
			status = http.StatusNotFound
		case webproto.ErrCodeTooLarge:
			status = http.StatusRequestEntityTooLarge
		case webproto.ErrCodeQuotaExceeded:
			status = http.StatusInsufficientStorage
		case webproto.ErrCodeHandlerFailed:
			status = http.StatusServiceUnavailable
		}
		g.Header("Cache-Control", "no-store")
		g.AbortWithStatusJSON(status, webproto.RPCResponse{OK: false, Error: op.RPCError()})
		return
	}
	rpcFail(g, err)
}

func (c *Component) uploadStore(g *gin.Context) (caller, UploadStore, bool) {
	who, ok := c.authorize(g)
	if !ok {
		return caller{}, nil, false
	}
	up := c.backends().Uploads
	if up == nil {
		rpcFail(g, errUploadsOff)
		return caller{}, nil, false
	}
	return who, up, true
}

// POST /web/uploads
func (c *Component) beginUpload(g *gin.Context) {
	who, up, ok := c.uploadStore(g)
	if !ok {
		return
	}
	var in struct {
		Name   string `json:"name"`
		Size   int64  `json:"size"`
		Type   string `json:"type"`
		SHA256 string `json:"sha256"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(g.Writer, g.Request.Body, 8<<10))
	if err := dec.Decode(&in); err != nil || in.Size < 0 || (in.SHA256 != "" && !shaPattern.MatchString(in.SHA256)) {
		rpcFail(g, errBadUpload)
		return
	}
	info, err := up.BeginUpload(g.Request.Context(), who.userID, in.Name, in.Type, in.Size)
	if err != nil {
		uploadError(g, err)
		return
	}
	if in.SHA256 != "" {
		c.sums.put(who.userID, info.ID, in.SHA256, c.now())
	}
	rpcOK(g, gin.H{"id": info.ID})
}

// PUT /web/uploads/:id/chunks/:index
func (c *Component) uploadChunk(g *gin.Context) {
	who, up, ok := c.uploadStore(g)
	if !ok {
		return
	}
	id := g.Param("id")
	index, err := strconv.ParseInt(g.Param("index"), 10, 64)
	if !webstore.ValidFileID(id) || err != nil || index < 0 || index > 1<<20 {
		rpcFail(g, errBadUpload)
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(g.Writer, g.Request.Body, webproto.UploadChunkBytes))
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			rpcFail(g, errTooLarge)
		} else {
			rpcFail(g, errBadUpload)
		}
		return
	}
	info, err := up.WriteUpload(g.Request.Context(), who.userID, id, index*webproto.UploadChunkBytes, data)
	if err != nil {
		uploadError(g, err)
		return
	}
	rpcOK(g, gin.H{"id": info.ID, "received": info.Received, "complete": info.Complete})
}

// POST /web/uploads/:id/complete
func (c *Component) completeUpload(g *gin.Context) {
	who, up, ok := c.uploadStore(g)
	if !ok {
		return
	}
	id := g.Param("id")
	if !webstore.ValidFileID(id) {
		rpcFail(g, errBadUpload)
		return
	}
	ctx := g.Request.Context()
	info, err := up.File(ctx, who.userID, id)
	if err != nil {
		uploadError(g, err)
		return
	}
	if !info.Complete {
		rpcFail(g, errIncomplete)
		return
	}
	if want, ok := c.sums.take(who.userID, id); ok && subtle.ConstantTimeCompare([]byte(want), []byte(info.SHA256)) != 1 {
		dctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		_ = up.DeleteFile(dctx, who.userID, id)
		cancel()
		rpcFail(g, errBadChecksum)
		return
	}
	rpcOK(g, gin.H{"id": info.ID, "size": info.Size})
}
