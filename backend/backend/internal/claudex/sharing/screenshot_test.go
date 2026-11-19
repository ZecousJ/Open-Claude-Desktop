package sharing

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/png"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestPublishedScreenshotPersistsAndRevokesWithShare(t *testing.T) {
	f := newFixture(t)
	f.enable(nil)
	var imageBytes bytes.Buffer
	require.NoError(t, png.Encode(&imageBytes, image.NewNRGBA(image.Rect(0, 0, 600, 315))))
	data := "data:image/png;base64," + base64.StdEncoding.EncodeToString(imageBytes.Bytes())
	var body map[string]any
	require.NoError(t, json.Unmarshal([]byte(artifactBody("screenshot")), &body))
	body["snapshot"].(map[string]any)["screenshot"] = data
	raw, err := json.Marshal(body)
	require.NoError(t, err)
	res := f.do(http.MethodPost, "/api/v1/claudex/shares", string(raw))
	require.Equal(t, http.StatusCreated, res.Status, res.Raw)
	var share ShareDTO
	res.into(t, &share)
	require.Contains(t, share.ScreenshotURL, share.Path+"/screenshot")
	imageResponse := f.serve(http.MethodGet, share.Path+"/screenshot", "")
	require.Equal(t, http.StatusOK, imageResponse.Code)
	require.Equal(t, "image/png", imageResponse.Header().Get("Content-Type"))
	require.Equal(t, imageBytes.Bytes(), imageResponse.Body.Bytes())
	page := f.serve(http.MethodGet, share.Path, "")
	require.Contains(t, page.Body.String(), `property="og:image"`)
	require.Contains(t, page.Body.String(), share.ScreenshotURL)
	f.do(http.MethodDelete, "/api/v1/claudex/shares/"+itoa64(share.ID), "")
	require.Equal(t, http.StatusNotFound, f.serve(http.MethodGet, share.Path+"/screenshot", "").Code)
}

func TestScreenshotRejectsInvalidDataAndPrivateShareDoesNotLeak(t *testing.T) {
	f, _ := inviteFixture(t)
	var body map[string]any
	require.NoError(t, json.Unmarshal([]byte(artifactBody("private-screenshot")), &body))
	snapshot := body["snapshot"].(map[string]any)
	for _, data := range []string{"https://example.com/pixel.png", "data:image/png;base64,AAAA"} {
		snapshot["screenshot"] = data
		raw, err := json.Marshal(body)
		require.NoError(t, err)
		require.Equal(t, http.StatusBadRequest, f.do(http.MethodPost, "/api/v1/claudex/shares", string(raw)).Status)
	}
	delete(snapshot, "screenshot")
	body["access"] = "invited"
	raw, err := json.Marshal(body)
	require.NoError(t, err)
	res := f.do(http.MethodPost, "/api/v1/claudex/shares", string(raw))
	var share ShareDTO
	res.into(t, &share)
	require.Equal(t, http.StatusNotFound, f.serve(http.MethodGet, share.Path+"/screenshot", "").Code)
}
