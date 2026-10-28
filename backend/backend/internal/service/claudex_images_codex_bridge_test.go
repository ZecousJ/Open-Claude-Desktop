package service

import (
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/tidwall/gjson"
)

func TestClaudexImagesBridgeRequestAsksInWordsWithoutTools(t *testing.T) {
	body, err := buildClaudexImagesBridgeRequest(&OpenAIImagesRequest{
		Endpoint: "/v1/images/generations",
		Prompt:   "一只在雪地里的小狐狸",
		Size:     "1024x1024",
		Quality:  "high",
	})
	require.NoError(t, err)
	require.Equal(t, claudexImagesBridgeMainModelDefault, gjson.GetBytes(body, "model").String())
	require.True(t, gjson.GetBytes(body, "stream").Bool())
	require.Equal(t, 0, len(gjson.GetBytes(body, "tools").Array()), "the upstream adds its own image tool")
	text := gjson.GetBytes(body, "input.0.content.0.text").String()
	require.Contains(t, text, "一只在雪地里的小狐狸")
	require.Contains(t, text, "Size: 1024x1024")
	require.Contains(t, text, "Quality: high")

	_, err = buildClaudexImagesBridgeRequest(&OpenAIImagesRequest{Endpoint: "/v1/images/generations"})
	require.Error(t, err)
}

func TestClaudexImagesBridgeRequestCarriesReferenceImages(t *testing.T) {
	body, err := buildClaudexImagesBridgeRequest(&OpenAIImagesRequest{
		Endpoint:       "/v1/images/edits",
		Prompt:         "make it night",
		InputImageURLs: []string{"data:image/png;base64,AAAA"},
	})
	require.NoError(t, err)
	require.Equal(t, "input_image", gjson.GetBytes(body, "input.0.content.1.type").String())
	require.Contains(t, gjson.GetBytes(body, "input.0.content.0.text").String(), "Edit the attached image")
}
