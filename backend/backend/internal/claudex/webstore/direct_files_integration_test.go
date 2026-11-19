//go:build integration

package webstore

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/attachmentstore"
	"github.com/stretchr/testify/require"
)

func TestDirectAttachmentAndLegacyCopy(t *testing.T) {
	if os.Getenv("CLAUDEX_ATTACHMENTS_S3_BUCKET") == "" {
		t.Skip("private attachment test bucket is not configured")
	}
	c := newIT(t, 1024, 1024)
	require.NotNil(t, c.objects)
	client := &http.Client{Timeout: 15 * time.Second}
	if raw := os.Getenv("CLAUDEX_ATTACHMENTS_S3_PROXY"); raw != "" {
		proxy, err := url.Parse(raw)
		require.NoError(t, err)
		transport := http.DefaultTransport.(*http.Transport).Clone()
		transport.Proxy = http.ProxyURL(proxy)
		client.Transport = transport
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	ids := users(t, 2)
	owner, other := ids[0], ids[1]
	body := []byte("attachment integration test")
	sha := fmt.Sprintf("%x", sha256.Sum256(body))
	info, upload, err := c.BeginDirectUpload(ctx, owner, "说明.txt", "text/plain", int64(len(body)), sha)
	require.NoError(t, err)
	require.NotNil(t, upload)
	require.False(t, info.Complete)
	key := attachmentstore.Key(owner, info.ID)
	t.Cleanup(func() { _ = c.objects.Delete(context.Background(), key) })
	_, err = c.CompleteDirectUpload(ctx, other, info.ID)
	require.Error(t, err)
	_, err = c.WriteUpload(ctx, owner, info.ID, 0, body)
	require.Error(t, err)
	require.NoError(t, c.objects.CopyFrom(ctx, key, bytes.NewReader(body), int64(len(body)), sha))
	_, err = c.CompleteDirectUpload(ctx, owner, info.ID)
	require.NoError(t, err)
	complete, err := c.CompleteDirectUpload(ctx, owner, info.ID)
	require.NoError(t, err)
	require.True(t, complete.Complete)
	_, err = call(t, c, other, "store.files.get", map[string]any{"id": info.ID, "direct": true})
	require.Error(t, err)
	value := must(t, c, owner, "store.files.get", map[string]any{"id": info.ID, "direct": true})
	var address string
	require.NoError(t, json.Unmarshal(value["url"], &address))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	require.NoError(t, err)
	req.Header.Set("Range", "bytes=1-5")
	response, err := client.Do(req)
	require.NoError(t, err)
	defer response.Body.Close()
	require.Equal(t, http.StatusPartialContent, response.StatusCode)
	data, err := io.ReadAll(response.Body)
	require.NoError(t, err)
	require.Equal(t, body[1:6], data)
	anonymous, err := client.Get(strings.SplitN(address, "?", 2)[0])
	require.NoError(t, err)
	defer anonymous.Body.Close()
	require.Equal(t, http.StatusForbidden, anonymous.StatusCode)

	old, err := c.BeginUpload(ctx, owner, "legacy.txt", "text/plain", int64(len(body)))
	require.NoError(t, err)
	old, err = c.WriteUpload(ctx, owner, old.ID, 0, body)
	require.NoError(t, err)
	t.Cleanup(func() { _ = c.objects.Delete(context.Background(), attachmentstore.Key(owner, old.ID)) })
	ok, err := c.copyLegacyAttachment(ctx, owner, old.ID, old.SHA256, old.Size)
	require.NoError(t, err)
	require.True(t, ok)
	migrated, err := c.File(ctx, owner, old.ID)
	require.NoError(t, err)
	require.Equal(t, old.ID, migrated.ID)
	require.True(t, migrated.ObjectStorage)
	require.FileExists(t, c.blobs.blobPath(owner, old.SHA256))
	_, data, err = c.ReadFile(ctx, owner, old.ID, 2, 4)
	require.NoError(t, err)
	require.Equal(t, body[2:6], data)

	require.NoError(t, c.DeleteFile(ctx, owner, info.ID))
	_, err = call(t, c, owner, "store.files.get", map[string]any{"id": info.ID, "direct": true})
	require.Error(t, err)
}
