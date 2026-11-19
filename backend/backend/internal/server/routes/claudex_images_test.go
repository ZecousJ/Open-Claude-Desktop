//go:build unit

package routes

import (
	"bytes"
	"context"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/iotest"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/gatewayhook"
	claudexhook "github.com/Wei-Shaw/sub2api/internal/claudex/hook"
	claudexusage "github.com/Wei-Shaw/sub2api/internal/claudex/usage"
	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/handler"
	"github.com/Wei-Shaw/sub2api/internal/securityaudit"
	servermiddleware "github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
	"github.com/tidwall/gjson"
)

const sunburstModel = "gpt-image-2.5-sunburst"

type claudexImagesCall struct {
	accountID   int64
	model       string
	path        string
	fileName    string
	image       []byte
	modelFields []string
}

type claudexImagesUpstream struct {
	service.HTTPUpstream
	calls []claudexImagesCall
	reply func(claudexImagesCall) *http.Response
}

func (u *claudexImagesUpstream) Do(req *http.Request, _ string, accountID int64, _ int) (*http.Response, error) {
	call := claudexImagesCall{accountID: accountID, path: req.URL.Path}
	if strings.HasPrefix(req.Header.Get("Content-Type"), "multipart/form-data") {
		reader, err := req.MultipartReader()
		if err != nil {
			return nil, err
		}
		form, err := reader.ReadForm(1 << 20)
		if err != nil {
			return nil, err
		}
		defer form.RemoveAll()
		call.model = form.Value["model"][0]
		call.modelFields = append(call.modelFields, form.Value["model"][1:]...)
		call.modelFields = append(call.modelFields, form.Value["MODEL"]...)
		image := form.File["image"][0]
		file, err := image.Open()
		if err != nil {
			return nil, err
		}
		defer file.Close()
		call.fileName = image.Filename
		call.image, err = io.ReadAll(file)
		if err != nil {
			return nil, err
		}
	} else {
		body, err := io.ReadAll(req.Body)
		if err != nil {
			return nil, err
		}
		call.model = gjson.GetBytes(body, "model").String()
		foundModel := false
		gjson.ParseBytes(body).ForEach(func(key, value gjson.Result) bool {
			if strings.EqualFold(key.String(), "model") {
				if foundModel || key.String() != "model" {
					call.modelFields = append(call.modelFields, value.String())
				}
				foundModel = true
			}
			return true
		})
	}
	u.calls = append(u.calls, call)
	if u.reply != nil {
		if response := u.reply(call); response != nil {
			return response, nil
		}
	}
	return claudexImagesResponse(http.StatusOK, "application/json", strings.NewReader(`{"data":[{"b64_json":"aW1hZ2U="}]}`)), nil
}

func claudexImagesResponse(status int, contentType string, body io.Reader) *http.Response {
	return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": {contentType}, "X-Request-Id": {"claudex-image-test"}}, Body: io.NopCloser(body)}
}

type claudexImagesSlots struct {
	service.ConcurrencyCache
	busyID int64
}

func (s claudexImagesSlots) AcquireAccountSlot(_ context.Context, id int64, _ int, _ string) (bool, error) {
	return id != s.busyID, nil
}

func (s claudexImagesSlots) ReleaseAccountSlot(context.Context, int64, string) error { return nil }

type claudexImagesChannels struct {
	service.ChannelRepository
	group   *service.Group
	channel service.Channel
}

func (r claudexImagesChannels) ListAll(context.Context) ([]service.Channel, error) {
	return []service.Channel{r.channel}, nil
}

func (r claudexImagesChannels) GetGroupPlatforms(context.Context, []int64) (map[int64]string, error) {
	return map[int64]string{r.group.ID: r.group.Platform}, nil
}

func claudexImagesTestRouter(t *testing.T, group *service.Group, accounts []service.Account, upstream *claudexImagesUpstream, slots *service.ConcurrencyService, resolver *service.CompositeRouteResolver, channels *service.ChannelService, audit *securityaudit.Coordinator) (*gin.Engine, *compatibleImagesUsage) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	cfg := &config.Config{RunMode: config.RunModeSimple, Gateway: config.GatewayConfig{MaxBodySize: 1 << 20}}
	repo := compatibleImagesAccounts{accounts: accounts}
	usage := &compatibleImagesUsage{}
	billingCache := service.NewBillingCacheService(nil, nil, nil, nil, nil, nil, cfg, nil)
	t.Cleanup(billingCache.Stop)
	if slots == nil {
		slots = service.NewConcurrencyService(nil)
	}
	openAI := service.NewOpenAIGatewayService(repo, usage, nil, nil, nil, nil, nil, cfg, nil, slots, service.NewBillingService(cfg, nil), nil, billingCache, upstream, &service.DeferredService{}, nil, nil, nil, channels, nil, nil, nil)
	gateway := service.NewGatewayService(repo, nil, nil, nil, nil, nil, nil, nil, cfg, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, resolver, nil, nil)
	apiKeys := service.NewAPIKeyService(nil, nil, nil, nil, nil, nil, cfg)
	handlers := &handler.Handlers{
		Gateway:       handler.NewGatewayHandler(gateway, openAI, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, cfg, nil),
		OpenAIGateway: handler.ProvideOpenAIGatewayHandler(openAI, nil, slots, billingCache, apiKeys, nil, nil, nil, nil, nil, cfg, audit),
		AsyncImage:    handler.NewAsyncImageHandler(nil, nil),
	}
	router := gin.New()
	RegisterGatewayRoutes(router, handlers, func(c *gin.Context) {
		if c.GetHeader("Authorization") != "Bearer drawing-key" {
			c.AbortWithStatus(http.StatusUnauthorized)
			return
		}
		c.Set(string(servermiddleware.ContextKeyAPIKey), &service.APIKey{ID: 2, GroupID: &group.ID, Group: group, User: &service.User{ID: 3}})
		c.Set(string(servermiddleware.ContextKeyUser), servermiddleware.AuthSubject{UserID: 3})
		c.Next()
	}, apiKeys, nil, nil, nil, resolver, cfg)
	return router, usage
}

func claudexImagesAccount(id int64, models map[string]any) service.Account {
	return service.Account{ID: id, Platform: service.PlatformOpenAI, Type: service.AccountTypeAPIKey, Status: service.StatusActive, Schedulable: true, Credentials: map[string]any{"api_key": "test", "base_url": "https://images.example/v1", "model_mapping": models}}
}

func requestClaudexImages(ctx context.Context, router *gin.Engine, path, contentType, authorization string, body io.Reader) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, path, body).WithContext(ctx)
	req.Header.Set("Authorization", authorization)
	req.Header.Set("Content-Type", contentType)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func claudexImagesMultipart(t *testing.T, model string, image []byte) (string, *bytes.Buffer) {
	t.Helper()
	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)
	require.NoError(t, writer.WriteField("model", model))
	require.NoError(t, writer.WriteField("MODEL", "retired-uppercase-model"))
	require.NoError(t, writer.WriteField("prompt", "Edit this"))
	part, err := writer.CreateFormFile("image", "reference.png")
	require.NoError(t, err)
	_, err = part.Write(image)
	require.NoError(t, err)
	require.NoError(t, writer.Close())
	return writer.FormDataContentType(), &buf
}

func TestClaudexImagesGenerationAndEditSkipQuotaPausedModel(t *testing.T) {
	group := &service.Group{ID: 5, Platform: service.PlatformOpenAI, AllowImageGeneration: true, ModelAllowlist: service.GroupModelAllowlist{Enabled: true, Models: []string{sunburstModel, "gpt-image-2.5"}}}
	paused := claudexImagesAccount(20, map[string]any{sunburstModel: sunburstModel})
	paused.Type = service.AccountTypeOAuth
	paused.Credentials["access_token"] = "test"
	now := time.Now()
	paused.Extra = map[string]any{
		"auto_pause_7d_threshold": 0.9,
		"codex_7d_used_percent":   100.0,
		"codex_7d_reset_at":       now.Add(time.Hour).Format(time.RFC3339),
		"codex_usage_updated_at":  now.Format(time.RFC3339),
	}
	upstream := &claudexImagesUpstream{}
	router, usage := claudexImagesTestRouter(t, group, []service.Account{paused, claudexImagesAccount(8, map[string]any{"gpt-image-2.5": "gpt-image-2.5"})}, upstream, nil, nil, nil, nil)
	ctx := context.Background()
	body := `{"model":"gpt-image-2.5-sunburst","prompt":"draw"}`
	const key = "Bearer drawing-key"
	explicit := requestClaudexImages(ctx, router, "/v1/images/generations", "application/json", key, strings.NewReader(body))
	require.Equal(t, http.StatusServiceUnavailable, explicit.Code, explicit.Body.String())
	require.Empty(t, upstream.calls)
	require.Empty(t, usage.logs)
	automatic := requestClaudexImages(ctx, router, "/v1/claudex/images/generations", "application/json", key, strings.NewReader(body))
	require.Equal(t, http.StatusOK, automatic.Code, automatic.Body.String())
	require.Contains(t, automatic.Body.String(), "aW1hZ2U=")
	require.Equal(t, []claudexImagesCall{{accountID: 8, model: "gpt-image-2.5", path: "/v1/images/generations"}}, upstream.calls)
	require.Len(t, usage.logs, 1)
	require.Equal(t, "gpt-image-2.5", usage.logs[0].RequestedModel)
	require.Equal(t, 1, usage.logs[0].ImageCount)

	image := []byte{0, 10, 13, 128, 255}
	contentType, editBody := claudexImagesMultipart(t, sunburstModel, image)
	edit := requestClaudexImages(ctx, router, "/v1/claudex/images/edits", contentType, key, editBody)
	require.Equal(t, http.StatusOK, edit.Code, edit.Body.String())
	require.Len(t, upstream.calls, 2)
	require.Equal(t, claudexImagesCall{accountID: 8, model: "gpt-image-2.5", path: "/v1/images/edits", fileName: "reference.png", image: image}, upstream.calls[1])
	require.Len(t, usage.logs, 2)
	require.Equal(t, "gpt-image-2.5", usage.logs[1].RequestedModel)

	paused.Extra["codex_7d_used_percent"] = 0.0
	explicit = requestClaudexImages(ctx, router, "/v1/images/generations", "application/json", key, strings.NewReader(body))
	require.Equal(t, http.StatusOK, explicit.Code, explicit.Body.String())
	require.Len(t, upstream.calls, 3)
	require.Equal(t, int64(20), upstream.calls[2].accountID)
	require.Equal(t, sunburstModel, upstream.calls[2].model)
}

func TestClaudexImagesMultipartResolvesAllowedCompositeModelAndChannel(t *testing.T) {
	const alias, routed, channelModel, upstreamModel = "public-image", "gpt-image-2.5", "gpt-image-2.5-channel", "gpt-image-2.5-upstream"
	group := &service.Group{ID: 5, Platform: service.PlatformComposite, AllowImageGeneration: true, ModelAllowlist: service.GroupModelAllowlist{Enabled: true, Models: []string{alias}}}
	resolver := service.NewCompositeRouteResolver(compositeRouteRepoStub{routes: []service.CompositeModelRoute{{ID: 1, GroupID: group.ID, PublicModel: alias, MatchType: service.CompositeRouteMatchExact, TargetPlatform: service.PlatformOpenAI, UpstreamModel: routed, Endpoint: service.CompositeRouteEndpointImages, Enabled: true}}})
	channel := service.Channel{ID: 9, GroupIDs: []int64{group.ID}, Status: service.StatusActive, ModelMapping: map[string]map[string]string{service.PlatformOpenAI: {routed: channelModel}}}
	channels := service.NewChannelService(claudexImagesChannels{group: group, channel: channel}, nil, nil, nil, nil)
	upstream := &claudexImagesUpstream{}
	accounts := []service.Account{claudexImagesAccount(1, map[string]any{"gpt-image-1": "gpt-image-1"}), claudexImagesAccount(8, map[string]any{routed: routed, channelModel: upstreamModel})}
	router, usage := claudexImagesTestRouter(t, group, accounts, upstream, nil, resolver, channels, nil)
	image := []byte{0, 10, 13, 128, 255}
	contentType, body := claudexImagesMultipart(t, "retired-model", image)
	rec := requestClaudexImages(context.Background(), router, "/v1/claudex/images/edits", contentType, "Bearer drawing-key", body)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Contains(t, rec.Body.String(), "aW1hZ2U=")
	require.Equal(t, []claudexImagesCall{{accountID: 8, model: upstreamModel, path: "/v1/images/edits", fileName: "reference.png", image: image}}, upstream.calls)
	require.Len(t, usage.logs, 1)
	require.Equal(t, alias, usage.logs[0].RequestedModel)
	require.Equal(t, upstreamModel, *usage.logs[0].UpstreamModel)
	require.Equal(t, channel.ID, *usage.logs[0].ChannelID)
	require.Equal(t, alias+"→"+channelModel+"→"+upstreamModel, *usage.logs[0].ModelMappingChain)
}

func TestClaudexImagesChoosesAvailableAccountAndOnlyRetriesBeforeOutput(t *testing.T) {
	for _, scenario := range []struct {
		name        string
		busyAccount int64
		reply       func(claudexImagesCall) *http.Response
		wantCalls   []claudexImagesCall
		wantModel   string
	}{
		{name: "prefer acquired account over wait plan", busyAccount: 1, wantCalls: []claudexImagesCall{{accountID: 8, model: "gpt-image-2.5", path: "/v1/images/generations"}}, wantModel: "gpt-image-2.5"},
		{name: "retry pre-output failover on another model", reply: func(call claudexImagesCall) *http.Response {
			if call.accountID == 1 {
				return claudexImagesResponse(http.StatusInternalServerError, "application/json", strings.NewReader(`{"error":{"message":"upstream failed"}}`))
			}
			return nil
		}, wantCalls: []claudexImagesCall{{accountID: 1, model: "gpt-image-1", path: "/v1/images/generations"}, {accountID: 8, model: "gpt-image-2.5", path: "/v1/images/generations"}}, wantModel: "gpt-image-2.5"},
		{name: "record delivered image when connection fails", reply: func(call claudexImagesCall) *http.Response {
			if call.accountID == 1 {
				body := strings.NewReader("data: {\"type\":\"image_generation.completed\",\"b64_json\":\"aW1hZ2U=\"}\n\n")
				return claudexImagesResponse(http.StatusOK, "text/event-stream", io.MultiReader(body, iotest.ErrReader(io.ErrUnexpectedEOF)))
			}
			return nil
		}, wantCalls: []claudexImagesCall{{accountID: 1, model: "gpt-image-1", path: "/v1/images/generations"}}, wantModel: "gpt-image-1"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			group := &service.Group{ID: 5, Platform: service.PlatformOpenAI, AllowImageGeneration: true}
			accounts := []service.Account{claudexImagesAccount(1, map[string]any{"gpt-image-1": "gpt-image-1"}), claudexImagesAccount(8, map[string]any{"gpt-image-2.5": "gpt-image-2.5"})}
			accounts[0].Concurrency = 1
			accounts[1].Concurrency = 1
			upstream := &claudexImagesUpstream{reply: scenario.reply}
			slots := service.NewConcurrencyService(claudexImagesSlots{busyID: scenario.busyAccount})
			router, usage := claudexImagesTestRouter(t, group, accounts, upstream, slots, nil, nil, nil)
			rec := requestClaudexImages(context.Background(), router, "/v1/claudex/images/generations", "application/json", "Bearer drawing-key", strings.NewReader(`{"prompt":"draw","stream":true}`))
			require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
			require.Contains(t, rec.Body.String(), "aW1hZ2U=")
			require.Equal(t, scenario.wantCalls, upstream.calls)
			require.Len(t, usage.logs, 1)
			require.Equal(t, scenario.wantModel, usage.logs[0].RequestedModel)
			require.Equal(t, 1, usage.logs[0].ImageCount)
		})
	}
}

func TestClaudexImagesKeepsAccountForOtherModelsAfterModelNotFound(t *testing.T) {
	group := &service.Group{ID: 5, Platform: service.PlatformOpenAI, AllowImageGeneration: true}
	account := claudexImagesAccount(8, map[string]any{"gpt-image-1": "gpt-image-1", "gpt-image-2.5": "gpt-image-2.5"})
	upstream := &claudexImagesUpstream{reply: func(call claudexImagesCall) *http.Response {
		if call.model == "gpt-image-1" {
			return claudexImagesResponse(http.StatusBadRequest, "application/json", strings.NewReader(`{"error":{"code":"model_not_found","message":"Unknown model"}}`))
		}
		return nil
	}}
	router, usage := claudexImagesTestRouter(t, group, []service.Account{account}, upstream, nil, nil, nil, nil)
	rec := requestClaudexImages(context.Background(), router, "/v1/claudex/images/generations", "application/json", "Bearer drawing-key", strings.NewReader(`{"prompt":"draw"}`))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, []claudexImagesCall{{accountID: 8, model: "gpt-image-1", path: "/v1/images/generations"}, {accountID: 8, model: "gpt-image-2.5", path: "/v1/images/generations"}}, upstream.calls)
	require.Len(t, usage.logs, 1)
	require.Equal(t, "gpt-image-2.5", usage.logs[0].RequestedModel)
}

func TestClaudexImagesChoosesConcreteModelForWildcardMapping(t *testing.T) {
	group := &service.Group{ID: 5, Platform: service.PlatformOpenAI, AllowImageGeneration: true, ModelAllowlist: service.GroupModelAllowlist{Enabled: true, Models: []string{"gpt-image-2.5-*"}}}
	account := claudexImagesAccount(8, map[string]any{"gpt-image-2.5-*": "gpt-image-2.5"})
	upstream := &claudexImagesUpstream{}
	router, usage := claudexImagesTestRouter(t, group, []service.Account{account}, upstream, nil, nil, nil, nil)
	rec := requestClaudexImages(context.Background(), router, "/v1/claudex/images/generations", "application/json", "Bearer drawing-key", strings.NewReader(`{"prompt":"draw"}`))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, []claudexImagesCall{{accountID: 8, model: "gpt-image-2.5", path: "/v1/images/generations"}}, upstream.calls)
	require.Len(t, usage.logs, 1)
	require.Contains(t, []string{"gpt-image-2.5-flare", sunburstModel}, usage.logs[0].RequestedModel)
}

func TestClaudexImagesRejectsWithoutEligibleGroupAccounts(t *testing.T) {
	for _, scenario := range []struct {
		name       string
		group      *service.Group
		key        string
		accounts   []service.Account
		wantStatus int
	}{
		{name: "unauthorized", group: &service.Group{Platform: service.PlatformOpenAI, AllowImageGeneration: true}, wantStatus: http.StatusUnauthorized},
		{name: "disabled images", group: &service.Group{Platform: service.PlatformOpenAI}, key: "Bearer drawing-key", wantStatus: http.StatusForbidden},
		{name: "empty pool", group: &service.Group{Platform: service.PlatformOpenAI, AllowImageGeneration: true}, key: "Bearer drawing-key", wantStatus: http.StatusServiceUnavailable},
		{name: "disallowed available model", group: &service.Group{Platform: service.PlatformOpenAI, AllowImageGeneration: true, ModelAllowlist: service.GroupModelAllowlist{Enabled: true, Models: []string{sunburstModel}}}, key: "Bearer drawing-key", accounts: []service.Account{claudexImagesAccount(8, map[string]any{"gpt-image-2.5": "gpt-image-2.5"})}, wantStatus: http.StatusServiceUnavailable},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			scenario.group.ID = 5
			upstream := &claudexImagesUpstream{}
			router, usage := claudexImagesTestRouter(t, scenario.group, scenario.accounts, upstream, nil, nil, nil, nil)
			rec := requestClaudexImages(context.Background(), router, "/v1/claudex/images/generations", "application/json", scenario.key, strings.NewReader(`{"model":"gpt-image-2.5","prompt":"draw"}`))
			require.Equal(t, scenario.wantStatus, rec.Code, rec.Body.String())
			if scenario.wantStatus == http.StatusServiceUnavailable {
				require.Equal(t, "No available image models", gjson.GetBytes(rec.Body.Bytes(), "error.message").String())
			}
			require.Empty(t, upstream.calls)
			require.Empty(t, usage.logs)
		})
	}
}

type claudexImageModeration struct {
	models []string
}

func (m *claudexImageModeration) Check(_ context.Context, req securityaudit.Request) (*securityaudit.LegacyDecision, error) {
	m.models = append(m.models, req.Model)
	if req.Model == "gpt-image-2.5" {
		return &securityaudit.LegacyDecision{Blocked: true, StatusCode: http.StatusForbidden, Message: "Image prompt blocked"}, nil
	}
	return &securityaudit.LegacyDecision{Allowed: true}, nil
}

func TestClaudexImagesAuditsAlternateModelBeforeForwarding(t *testing.T) {
	group := &service.Group{ID: 5, Platform: service.PlatformOpenAI, AllowImageGeneration: true}
	accounts := []service.Account{claudexImagesAccount(1, map[string]any{"gpt-image-1": "gpt-image-1"}), claudexImagesAccount(8, map[string]any{"gpt-image-2.5": "gpt-image-2.5"})}
	upstream := &claudexImagesUpstream{reply: func(call claudexImagesCall) *http.Response {
		if call.accountID == 1 {
			return claudexImagesResponse(http.StatusInternalServerError, "application/json", strings.NewReader(`{"error":{"message":"upstream failed"}}`))
		}
		return nil
	}}
	moderation := &claudexImageModeration{}
	router, usage := claudexImagesTestRouter(t, group, accounts, upstream, nil, nil, nil, securityaudit.NewCoordinator(moderation, nil))
	rec := requestClaudexImages(context.Background(), router, "/v1/claudex/images/generations", "application/json", "Bearer drawing-key", strings.NewReader(`{"prompt":"draw"}`))
	require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
	require.Equal(t, []string{"gpt-image-1", "gpt-image-2.5"}, moderation.models)
	require.Equal(t, []claudexImagesCall{{accountID: 1, model: "gpt-image-1", path: "/v1/images/generations"}}, upstream.calls)
	require.Empty(t, usage.logs)
}

func TestClaudexImagesChecksActualModelUsageBeforeForwarding(t *testing.T) {
	group := &service.Group{ID: 5, Platform: service.PlatformOpenAI, AllowImageGeneration: true}
	limitedModel := "gpt-image-1-relay"
	accounts := []service.Account{claudexImagesAccount(1, map[string]any{"gpt-image-1": limitedModel})}
	upstream := &claudexImagesUpstream{}
	claudexhook.Install(claudexhook.Hooks{PrecheckTurn: func(_ context.Context, _, _ int64, _ *int64, models []string) error {
		for _, model := range models {
			if model == limitedModel {
				return &claudexusage.LimitError{Detail: &gatewayhook.RefusalDetail{V: 1, RuleKind: claudexusage.KindModels, Reason: "RULE_LIMIT", RetryAfterSeconds: 60, Message: "Image usage limit reached"}}
			}
		}
		return nil
	}})
	t.Cleanup(claudexhook.Reset)
	const key = "Bearer drawing-key"
	const path = "/v1/claudex/images/generations"
	const body = `{"model":"retired-model","model":"gpt-image-1","MODEL":"gpt-image-1-relay","prompt":"draw"}`
	router, usage := claudexImagesTestRouter(t, group, accounts, upstream, nil, nil, nil, nil)
	blocked := requestClaudexImages(context.Background(), router, path, "application/json", key, strings.NewReader(body))
	require.Equal(t, http.StatusTooManyRequests, blocked.Code, blocked.Body.String())
	require.Equal(t, "60", blocked.Header().Get("Retry-After"))
	require.Equal(t, claudexusage.CodeLimitExceeded, gjson.GetBytes(blocked.Body.Bytes(), "code").String())
	require.Empty(t, upstream.calls)
	require.Empty(t, usage.logs)

	accounts = append(accounts, claudexImagesAccount(8, map[string]any{"gpt-image-2.5": "gpt-image-2.5"}))
	router, usage = claudexImagesTestRouter(t, group, accounts, upstream, nil, nil, nil, nil)
	rec := requestClaudexImages(context.Background(), router, path, "application/json", key, strings.NewReader(body))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, []claudexImagesCall{{accountID: 8, model: "gpt-image-2.5", path: "/v1/images/generations"}}, upstream.calls)
	require.Len(t, usage.logs, 1)
	require.Equal(t, "gpt-image-2.5", usage.logs[0].RequestedModel)
}
