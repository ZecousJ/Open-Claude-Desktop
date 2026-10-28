package service

// Claudex: /v1/images on an upstream that draws only for Codex (owner,
// 2026-10-03: every picture is GPT's, whatever the conversation's model).
// Such an upstream (a Sub2API of its own, account flag
// codex_image_generation_supported) refuses /images and an explicit
// image_generation tool for our key's group, but adds the tool itself to a
// Codex client's /responses request and draws. The images request is sent
// that way: a Codex request with the prompt and no tools; the image comes
// back as an image_generation_call, read by the same code as the ChatGPT
// path (forwardOpenAIImagesOAuth).

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/pkg/logger"
	"github.com/gin-gonic/gin"
	"github.com/tidwall/sjson"
)

// The chat model the drawing request runs under; the upstream draws with its
// own image model (gpt-image-2).
const claudexImagesBridgeMainModelDefault = "gpt-6.1-sol"

func claudexImagesBridgeMainModel() string {
	if v := strings.TrimSpace(os.Getenv("CLAUDEX_IMAGES_BRIDGE_MODEL")); v != "" {
		return v
	}
	return claudexImagesBridgeMainModelDefault
}

// buildClaudexImagesBridgeRequest is a Codex /responses request that asks for
// the picture in words (no tools: the upstream adds its own).
func buildClaudexImagesBridgeRequest(parsed *OpenAIImagesRequest) ([]byte, error) {
	if parsed == nil {
		return nil, fmt.Errorf("parsed images request is required")
	}
	prompt := strings.TrimSpace(parsed.Prompt)
	if prompt == "" {
		return nil, fmt.Errorf("prompt is required")
	}
	images := make([]string, 0, len(parsed.InputImageURLs)+len(parsed.Uploads))
	for _, imageURL := range parsed.InputImageURLs {
		if trimmed := strings.TrimSpace(imageURL); trimmed != "" {
			images = append(images, trimmed)
		}
	}
	for _, upload := range parsed.Uploads {
		dataURL, err := openAIImageUploadToDataURL(upload)
		if err != nil {
			return nil, err
		}
		images = append(images, dataURL)
	}
	if parsed.IsEdits() && len(images) == 0 {
		return nil, fmt.Errorf("image input is required")
	}
	var text strings.Builder
	if parsed.IsEdits() {
		_, _ = text.WriteString("Edit the attached image(s) with the image generation tool. Make exactly one image and no text reply.\n")
	} else {
		_, _ = text.WriteString("Generate an image with the image generation tool. Make exactly one image and no text reply.\n")
	}
	_, _ = text.WriteString("Use this prompt verbatim:\n")
	_, _ = text.WriteString(prompt)
	if size := strings.TrimSpace(parsed.Size); size != "" && size != "auto" {
		_, _ = text.WriteString("\nSize: " + size)
	}
	if quality := strings.TrimSpace(parsed.Quality); quality != "" && quality != "auto" {
		_, _ = text.WriteString("\nQuality: " + quality)
	}
	if background := strings.TrimSpace(parsed.Background); background != "" && background != "auto" {
		_, _ = text.WriteString("\nBackground: " + background)
	}

	req := []byte(`{"model":"","instructions":"You are Codex.","stream":true,"store":false,"tools":[],"input":[]}`)
	req, _ = sjson.SetBytes(req, "model", claudexImagesBridgeMainModel())
	input := []byte(`[{"type":"message","role":"user","content":[{"type":"input_text","text":""}]}]`)
	input, _ = sjson.SetBytes(input, "0.content.0.text", text.String())
	for index, imageURL := range images {
		part := []byte(`{"type":"input_image","image_url":""}`)
		part, _ = sjson.SetBytes(part, "image_url", imageURL)
		input, _ = sjson.SetRawBytes(input, fmt.Sprintf("0.content.%d", index+1), part)
	}
	req, _ = sjson.SetRawBytes(req, "input", input)
	return req, nil
}

func (s *OpenAIGatewayService) forwardOpenAIImagesCodexBridge(
	ctx context.Context,
	c *gin.Context,
	account *Account,
	parsed *OpenAIImagesRequest,
	channelMappedModel string,
) (*OpenAIForwardResult, error) {
	startTime := time.Now()
	requestModel := strings.TrimSpace(parsed.Model)
	if mapped := strings.TrimSpace(channelMappedModel); mapped != "" {
		requestModel = mapped
	}
	if requestModel == "" {
		requestModel = "gpt-image-2"
	}
	upstreamModel := requestModel
	SetOpsUpstreamModel(c, upstreamModel)
	logger.LegacyPrintf("service.openai_gateway",
		"[OpenAI] Images via Codex bridge request_model=%s endpoint=%s account=%d uploads=%d",
		requestModel, parsed.Endpoint, account.ID, len(parsed.Uploads))

	upstreamCtx, releaseUpstreamCtx := detachUpstreamContext(ctx)
	defer releaseUpstreamCtx()
	token, _, err := s.GetAccessToken(upstreamCtx, account)
	if err != nil {
		return nil, err
	}
	body, err := buildClaudexImagesBridgeRequest(parsed)
	if err != nil {
		return nil, err
	}
	upstreamCtx = withOpenAIImagesSelfBuiltRequest(upstreamCtx)
	upstreamReq, err := s.buildUpstreamRequest(upstreamCtx, c, account, body, token, true, parsed.StickySessionSeed(), true)
	if err != nil {
		return nil, err
	}
	// The upstream's Codex detection is what adds the image tool.
	upstreamReq.Header.Set("Content-Type", "application/json")
	upstreamReq.Header.Set("Accept", "text/event-stream")
	upstreamReq.Header.Set("User-Agent", CodexCanonicalUserAgent())
	upstreamReq.Header.Set("originator", "codex_cli_rs")

	proxyURL := ""
	if account.ProxyID != nil && account.Proxy != nil {
		proxyURL = account.Proxy.URL()
	}
	upstreamStart := time.Now()
	resp, err := s.doOpenAIUpstream(upstreamReq, proxyURL, account)
	SetOpsLatencyMs(c, OpsUpstreamLatencyMsKey, time.Since(upstreamStart).Milliseconds())
	if err != nil {
		safeErr := sanitizeUpstreamErrorMessage(err.Error())
		setOpsUpstreamError(c, 0, safeErr, "")
		return nil, fmt.Errorf("upstream request failed: %s", safeErr)
	}
	if resp.StatusCode >= 400 {
		respBody := s.readUpstreamErrorBody(resp)
		_ = resp.Body.Close()
		upstreamMsg := sanitizeUpstreamErrorMessage(strings.TrimSpace(extractUpstreamErrorMessage(respBody)))
		if s.shouldFailoverOpenAIUpstreamResponse(account, resp.StatusCode, upstreamMsg, respBody) {
			shouldDisable := s.handleFailoverSideEffects(upstreamCtx, resp, account, respBody, upstreamModel)
			return nil, s.newOpenAIAccountFailoverError(
				account, resp.StatusCode, resp.Header, respBody, upstreamMsg, shouldDisable,
				!shouldDisable && account.IsPoolMode() && account.IsPoolModeRetryableStatus(resp.StatusCode),
			)
		}
		resp.Body = io.NopCloser(bytes.NewReader(respBody))
		return s.handleOpenAIImagesErrorResponse(upstreamCtx, resp, c, account, upstreamModel)
	}
	defer func() { _ = resp.Body.Close() }()

	var (
		usage            OpenAIUsage
		imageCount       int
		imageOutputSizes []string
		firstTokenMs     *int
	)
	writerSizeBeforeResponse := OpenAIImagesJSONKeepaliveAdjustedWrittenSize(c)
	if parsed.Stream {
		usage, imageCount, imageOutputSizes, firstTokenMs, err = s.handleOpenAIImagesOAuthStreamingResponse(resp, c, startTime, parsed.ResponseFormat, openAIImagesStreamPrefix(parsed), upstreamModel)
	} else {
		usage, imageCount, imageOutputSizes, err = s.handleOpenAIImagesOAuthNonStreamingResponse(resp, c, parsed.ResponseFormat, requestModel)
	}
	if err != nil {
		if imageCount > 0 {
			return &OpenAIForwardResult{
				RequestID: resp.Header.Get("x-request-id"), UpstreamHeaders: resp.Header, Usage: usage,
				Model: requestModel, UpstreamModel: upstreamModel, UpstreamEndpoint: upstreamReq.URL.Path,
				Stream: parsed.Stream, ResponseHeaders: resp.Header.Clone(), Duration: time.Since(startTime),
				FirstTokenMs: firstTokenMs, ImageCount: imageCount, ImageSize: parsed.SizeTier,
				ImageInputSize: parsed.Size, ImageOutputSizes: imageOutputSizes,
			}, err
		}
		return nil, s.handleOpenAIImagesOAuthResponseError(
			upstreamCtx, c, account, upstreamModel, safeUpstreamURL(upstreamReq.URL.String()),
			resp, writerSizeBeforeResponse, err,
		)
	}
	if imageCount <= 0 {
		return nil, fmt.Errorf("the upstream returned no image")
	}
	return &OpenAIForwardResult{
		RequestID:        resp.Header.Get("x-request-id"),
		UpstreamHeaders:  resp.Header,
		Usage:            usage,
		Model:            requestModel,
		UpstreamModel:    upstreamModel,
		UpstreamEndpoint: upstreamReq.URL.Path,
		Stream:           parsed.Stream,
		ResponseHeaders:  resp.Header.Clone(),
		Duration:         time.Since(startTime),
		FirstTokenMs:     firstTokenMs,
		ImageCount:       imageCount,
		ImageSize:        parsed.SizeTier,
		ImageInputSize:   parsed.Size,
		ImageOutputSizes: imageOutputSizes,
	}, nil
}
