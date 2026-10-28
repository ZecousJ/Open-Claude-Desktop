package payment

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	dbent "github.com/Wei-Shaw/sub2api/ent"
	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/alicebob/miniredis/v2"
	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
)

const (
	ownerID        = int64(7)
	stripeTrade    = "pi_3QabcDEF"
	stripeSecret   = "pi_3QabcDEF_secret_XyZ123"
	awxTrade       = "int_hkdm8vx2"
	awxSecret      = "awx_cs_4f1e"
	stripeResume   = "resume-stripe"
	awxResume      = "resume-awx"
	publishableKey = "pk_test_51Q"
)

var testNow = time.Date(2026, 9, 26, 2, 10, 0, 0, time.UTC)

// fakeOrders stands in for service.PaymentService: resume token -> order.
type fakeOrders struct {
	orders map[string]*dbent.PaymentOrder
	err    error
	calls  int
}

func (f *fakeOrders) GetPublicOrderByResumeToken(_ context.Context, token string) (*dbent.PaymentOrder, error) {
	f.calls++
	if f.err != nil {
		return nil, f.err
	}
	o, ok := f.orders[token]
	if !ok {
		return nil, infraerrors.BadRequest("INVALID_RESUME_TOKEN", "resume token payload is invalid")
	}
	cp := *o
	return &cp, nil
}

type fakeConfig struct {
	key       string
	err       error
	instances []service.ProviderInstanceResponse
	listErr   error
}

func (f *fakeConfig) GetPaymentConfig(context.Context) (*service.PaymentConfig, error) {
	if f.err != nil {
		return nil, f.err
	}
	return &service.PaymentConfig{StripePublishableKey: f.key}, nil
}

func (f *fakeConfig) ListProviderInstancesWithConfig(context.Context) ([]service.ProviderInstanceResponse, error) {
	return f.instances, f.listErr
}

func strPtr(s string) *string { return &s }

func stripeOrder() *dbent.PaymentOrder {
	return &dbent.PaymentOrder{
		ID: 1024, UserID: ownerID, Amount: 20, PayAmount: 20.6, PaymentType: "stripe",
		PaymentTradeNo: stripeTrade, ProviderKey: strPtr("stripe"), ProviderInstanceID: strPtr("3"),
		ProviderSnapshot: map[string]any{"schema_version": 2, "provider_key": "stripe", "currency": "USD"},
		Status:           service.OrderStatusPending, ExpiresAt: testNow.Add(50 * time.Minute),
	}
}

func airwallexOrder() *dbent.PaymentOrder {
	return &dbent.PaymentOrder{
		ID: 2048, UserID: ownerID, Amount: 88, PayAmount: 88, PaymentType: "airwallex",
		PaymentTradeNo: awxTrade, ProviderKey: strPtr("airwallex"),
		ProviderSnapshot: map[string]any{"schema_version": 2, "provider_key": "airwallex", "currency": "HKD"},
		Status:           service.OrderStatusPending, ExpiresAt: testNow.Add(20 * time.Minute),
	}
}

type harness struct {
	t      *testing.T
	mr     *miniredis.Miniredis
	rdb    *redis.Client
	orders *fakeOrders
	config *fakeConfig
	comp   *Component
	router *gin.Engine
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	gin.SetMode(gin.TestMode)
	mr := miniredis.RunT(t)
	mr.SetTime(testNow) // the component's clock, for absolute expiries (EXAT)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })
	h := &harness{
		t: t, mr: mr, rdb: rdb,
		orders: &fakeOrders{orders: map[string]*dbent.PaymentOrder{stripeResume: stripeOrder(), awxResume: airwallexOrder()}},
		config: &fakeConfig{key: publishableKey},
	}
	env := &core.Env{Deps: core.Deps{Redis: rdb}, Now: func() time.Time { return testNow }}
	h.comp = New(env)
	h.comp.orders = h.orders
	h.comp.configs = h.config

	r := gin.New()
	r.Use(gin.Recovery())
	user := r.Group("/api/v1/claudex")
	user.Use(func(c *gin.Context) {
		if id := c.GetHeader("X-Test-User"); id != "" {
			uid, _ := strconv.ParseInt(id, 10, 64)
			c.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: uid})
		}
		c.Next()
	})
	h.comp.RegisterUserRoutes(user)
	h.comp.RegisterPublicRoutes(r.Group("/api/v1/claudex"))
	h.router = r
	return h
}

type envelope struct {
	Code     int               `json:"code"`
	Message  string            `json:"message"`
	Reason   string            `json:"reason"`
	Metadata map[string]string `json:"metadata"`
	Data     json.RawMessage   `json:"data"`
}

func (h *harness) post(path string, user int64, body any) (*httptest.ResponseRecorder, envelope) {
	h.t.Helper()
	var raw []byte
	switch b := body.(type) {
	case string:
		raw = []byte(b)
	default:
		var err error
		raw, err = json.Marshal(b)
		require.NoError(h.t, err)
	}
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	if user > 0 {
		req.Header.Set("X-Test-User", strconv.FormatInt(user, 10))
	}
	rec := httptest.NewRecorder()
	h.router.ServeHTTP(rec, req)
	var env envelope
	_ = json.Unmarshal(rec.Body.Bytes(), &env)
	return rec, env
}

// checkoutKeys lists the stored checkout tokens (the rate limiter keeps its
// own counters in the same Redis).
func (h *harness) checkoutKeys() []string {
	var keys []string
	for _, k := range h.mr.Keys() {
		if strings.HasPrefix(k, storeKeyPrefix) {
			keys = append(keys, k)
		}
	}
	return keys
}

func (h *harness) link(user int64, req LinkRequest) (*httptest.ResponseRecorder, envelope) {
	return h.post("/api/v1/claudex/payment/checkout-links", user, req)
}

func (h *harness) checkout(token string) (*httptest.ResponseRecorder, envelope) {
	return h.post("/api/v1/claudex/payment/checkout", 0, CheckoutRequest{Token: token})
}

func stripeLink() LinkRequest {
	return LinkRequest{OrderID: 1024, ResumeToken: stripeResume, ClientSecret: stripeSecret, Currency: "USD"}
}

func awxLink() LinkRequest {
	return LinkRequest{OrderID: 2048, ResumeToken: awxResume, ClientSecret: awxSecret, IntentID: awxTrade,
		Currency: "HKD", CountryCode: "hk", PaymentEnv: "prod"}
}

func (h *harness) mustLink(req LinkRequest) LinkView {
	h.t.Helper()
	rec, env := h.link(ownerID, req)
	require.Equal(h.t, http.StatusOK, rec.Code, rec.Body.String())
	var view LinkView
	require.NoError(h.t, json.Unmarshal(env.Data, &view))
	return view
}

func requireUnavailable(t *testing.T, rec *httptest.ResponseRecorder, env envelope, rule string) {
	t.Helper()
	require.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())
	require.Equal(t, "CLAUDEX_CHECKOUT_UNAVAILABLE", env.Reason)
	require.Equal(t, rule, env.Metadata["rule"], rec.Body.String())
}

func requireNotFound(t *testing.T, rec *httptest.ResponseRecorder, env envelope) {
	t.Helper()
	require.Equal(t, http.StatusNotFound, rec.Code, rec.Body.String())
	require.Equal(t, "CLAUDEX_CHECKOUT_NOT_FOUND", env.Reason)
}

func TestCheckoutLinkForStripeOrder(t *testing.T) {
	h := newHarness(t)
	rec, env := h.link(ownerID, stripeLink())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
	var view LinkView
	require.NoError(t, json.Unmarshal(env.Data, &view))
	require.Regexp(t, `^[A-Za-z0-9_-]{43}$`, view.Token)
	require.Equal(t, testNow.Add(maxLinkTTL), view.ExpiresAt, "30 minutes when the order lives longer")

	// Stored under the token's hash, never under the token itself.
	keys := h.checkoutKeys()
	require.Len(t, keys, 1)
	require.Equal(t, storeKey(view.Token), keys[0])
	require.NotContains(t, keys[0], view.Token)
	require.Equal(t, maxLinkTTL, h.mr.TTL(keys[0]))

	// Every link is a new token.
	other := h.mustLink(stripeLink())
	require.NotEqual(t, view.Token, other.Token)
}

func TestCheckoutLinkRefusals(t *testing.T) {
	cases := []struct {
		name  string
		user  int64
		req   func() LinkRequest
		order func(o *dbent.PaymentOrder)
		rule  string
	}{
		{name: "another user's order", user: ownerID + 1, req: stripeLink, rule: ruleOwner},
		{name: "order id does not match the resume token", user: ownerID, req: func() LinkRequest {
			r := stripeLink()
			r.OrderID = 99
			return r
		}, rule: ruleOrder},
		{name: "unknown or forged resume token", user: ownerID, req: func() LinkRequest {
			r := stripeLink()
			r.ResumeToken = "forged"
			return r
		}, rule: ruleOrder},
		{name: "completed order", user: ownerID, req: stripeLink, order: func(o *dbent.PaymentOrder) { o.Status = service.OrderStatusCompleted }, rule: ruleStatus},
		{name: "paid order", user: ownerID, req: stripeLink, order: func(o *dbent.PaymentOrder) { o.Status = service.OrderStatusPaid }, rule: ruleStatus},
		{name: "expired order", user: ownerID, req: stripeLink, order: func(o *dbent.PaymentOrder) { o.Status = service.OrderStatusExpired }, rule: ruleStatus},
		{name: "cancelled order", user: ownerID, req: stripeLink, order: func(o *dbent.PaymentOrder) { o.Status = service.OrderStatusCancelled }, rule: ruleStatus},
		{name: "pending past its expiry", user: ownerID, req: stripeLink, order: func(o *dbent.PaymentOrder) { o.ExpiresAt = testNow.Add(-time.Second) }, rule: ruleExpired},
		{name: "less than a second left", user: ownerID, req: stripeLink, order: func(o *dbent.PaymentOrder) { o.ExpiresAt = testNow.Add(900 * time.Millisecond) }, rule: ruleExpired},
		{name: "client secret of another payment intent", user: ownerID, req: func() LinkRequest {
			r := stripeLink()
			r.ClientSecret = "pi_3Qother_secret_XyZ123"
			return r
		}, rule: ruleSecret},
		{name: "client secret without the secret part", user: ownerID, req: func() LinkRequest {
			r := stripeLink()
			r.ClientSecret = stripeTrade + "_secret_"
			return r
		}, rule: ruleSecret},
		{name: "client secret equal to the intent id", user: ownerID, req: func() LinkRequest {
			r := stripeLink()
			r.ClientSecret = stripeTrade
			return r
		}, rule: ruleSecret},
		{name: "order without a payment intent yet", user: ownerID, req: stripeLink, order: func(o *dbent.PaymentOrder) { o.PaymentTradeNo = "" }, rule: ruleSecret},
		{name: "alipay order", user: ownerID, req: stripeLink, order: func(o *dbent.PaymentOrder) {
			o.PaymentType, o.ProviderKey, o.ProviderSnapshot = "alipay", strPtr("alipay"), map[string]any{"provider_key": "alipay"}
		}, rule: ruleProvider},
		{name: "easypay order", user: ownerID, req: stripeLink, order: func(o *dbent.PaymentOrder) {
			o.PaymentType, o.ProviderKey, o.ProviderSnapshot = "alipay", strPtr("easypay"), nil
		}, rule: ruleProvider},
		{name: "wxpay order by payment type only", user: ownerID, req: stripeLink, order: func(o *dbent.PaymentOrder) {
			o.PaymentType, o.ProviderKey, o.ProviderSnapshot = "wxpay_direct", nil, nil
		}, rule: ruleProvider},
		{name: "missing client secret", user: ownerID, req: func() LinkRequest {
			r := stripeLink()
			r.ClientSecret = " "
			return r
		}, rule: ruleRequest},
		{name: "missing resume token", user: ownerID, req: func() LinkRequest {
			r := stripeLink()
			r.ResumeToken = ""
			return r
		}, rule: ruleRequest},
		{name: "missing order id", user: ownerID, req: func() LinkRequest {
			r := stripeLink()
			r.OrderID = 0
			return r
		}, rule: ruleRequest},
		{name: "oversized client secret", user: ownerID, req: func() LinkRequest {
			r := stripeLink()
			r.ClientSecret = stripeTrade + "_secret_" + strings.Repeat("x", maxClientSecretLen)
			return r
		}, rule: ruleRequest},
		{name: "malformed country code", user: ownerID, req: func() LinkRequest {
			r := awxLink()
			r.CountryCode = "HKG"
			return r
		}, rule: ruleRequest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			if tc.order != nil {
				tc.order(h.orders.orders[stripeResume])
			}
			rec, env := h.link(tc.user, tc.req())
			requireUnavailable(t, rec, env, tc.rule)
			require.Empty(t, h.checkoutKeys(), "nothing stored")
		})
	}
}

func TestCheckoutLinkRefusesAirwallexMismatch(t *testing.T) {
	h := newHarness(t)
	req := awxLink()
	req.IntentID = "int_someone_else"
	rec, env := h.link(ownerID, req)
	requireUnavailable(t, rec, env, ruleSecret)

	req = awxLink()
	req.IntentID = ""
	rec, env = h.link(ownerID, req)
	requireUnavailable(t, rec, env, ruleSecret)
	require.Empty(t, h.checkoutKeys())
}

func TestCheckoutLinkNeedsStripePublishableKey(t *testing.T) {
	h := newHarness(t)
	h.config.key = "  "
	rec, env := h.link(ownerID, stripeLink())
	requireUnavailable(t, rec, env, ruleConfig)
	require.Contains(t, env.Message, "isn't set up")

	// Airwallex does not need it.
	h.mustLink(awxLink())
}

func TestCheckoutLinkUsesThePublishableKeyOfTheOrdersStripeAccount(t *testing.T) {
	instance := func(id int64, provider, key string) service.ProviderInstanceResponse {
		return service.ProviderInstanceResponse{ID: id, ProviderKey: provider, Config: map[string]string{"publishableKey": key}}
	}
	cases := []struct {
		name      string
		instances []service.ProviderInstanceResponse
		listErr   error
		snapshot  string
		want      string
	}{
		{name: "the order's instance", instances: []service.ProviderInstanceResponse{instance(1, "stripe", "pk_first"), instance(3, "stripe", "pk_order")}, want: "pk_order"},
		{name: "the snapshot's instance wins", instances: []service.ProviderInstanceResponse{instance(3, "stripe", "pk_order"), instance(5, "stripe", "pk_snapshot")}, snapshot: "5", want: "pk_snapshot"},
		{name: "instance gone", instances: []service.ProviderInstanceResponse{instance(1, "stripe", "pk_first")}, want: publishableKey},
		{name: "instance without a key", instances: []service.ProviderInstanceResponse{instance(3, "stripe", " ")}, want: publishableKey},
		{name: "not a Stripe instance", instances: []service.ProviderInstanceResponse{instance(3, "airwallex", "pk_wrong")}, want: publishableKey},
		{name: "instances unreadable", listErr: errors.New("decrypt failed"), want: publishableKey},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			h.config.instances, h.config.listErr = tc.instances, tc.listErr
			if tc.snapshot != "" {
				h.orders.orders[stripeResume].ProviderSnapshot["provider_instance_id"] = tc.snapshot
			}
			token := h.mustLink(stripeLink()).Token
			_, env := h.checkout(token)
			var view CheckoutView
			require.NoError(t, json.Unmarshal(env.Data, &view))
			require.Equal(t, tc.want, view.Stripe.PublishableKey)
		})
	}
}

func TestCheckoutLinkSurfacesServerErrors(t *testing.T) {
	h := newHarness(t)
	h.orders.err = errors.New("database is down")
	rec, _ := h.link(ownerID, stripeLink())
	require.Equal(t, http.StatusInternalServerError, rec.Code)

	h.orders.err = infraerrors.ServiceUnavailable("PAYMENT_RESUME_NOT_CONFIGURED", "resume signing key is not configured")
	rec, env := h.link(ownerID, stripeLink())
	require.Equal(t, http.StatusServiceUnavailable, rec.Code)
	require.Equal(t, "PAYMENT_RESUME_NOT_CONFIGURED", env.Reason)

	h.orders.err = nil
	h.config.err = errors.New("settings unreadable")
	rec, _ = h.link(ownerID, stripeLink())
	require.Equal(t, http.StatusInternalServerError, rec.Code)
	require.Empty(t, h.checkoutKeys())
}

func TestCheckoutLinkRejectsMalformedBodies(t *testing.T) {
	h := newHarness(t)
	rec, _ := h.post("/api/v1/claudex/payment/checkout-links", ownerID, `{"order_id":`)
	require.Equal(t, http.StatusBadRequest, rec.Code)
	rec, _ = h.post("/api/v1/claudex/payment/checkout-links", ownerID, `{"order_id":"1024"}`)
	require.Equal(t, http.StatusBadRequest, rec.Code)
	big := `{"order_id":1024,"resume_token":"` + strings.Repeat("a", maxBodyBytes) + `"}`
	rec, _ = h.post("/api/v1/claudex/payment/checkout-links", ownerID, big)
	require.Equal(t, http.StatusBadRequest, rec.Code)
	require.Zero(t, h.orders.calls)
}

func TestCheckoutLinkIsRateLimitedPerUser(t *testing.T) {
	h := newHarness(t)
	for i := 0; i < linkRateLimit; i++ {
		rec, _ := h.link(ownerID, stripeLink())
		require.Equal(t, http.StatusOK, rec.Code, "request %d", i+1)
	}
	rec, env := h.link(ownerID, stripeLink())
	require.Equal(t, http.StatusTooManyRequests, rec.Code)
	require.Equal(t, "CLAUDEX_RATE_LIMITED", env.Reason)
	require.NotEmpty(t, rec.Header().Get("Retry-After"))

	// Another user has their own budget (and gets a 409 for an order that is not theirs).
	rec, env = h.link(ownerID+1, stripeLink())
	requireUnavailable(t, rec, env, ruleOwner)
}

func TestCheckoutTokenNeverOutlivesTheOrder(t *testing.T) {
	for _, left := range []time.Duration{90 * time.Second, 10*time.Minute + 700*time.Millisecond, 29 * time.Minute, 30 * time.Minute, 31 * time.Minute, 3 * time.Hour} {
		t.Run(left.String(), func(t *testing.T) {
			h := newHarness(t)
			order := h.orders.orders[stripeResume]
			order.ExpiresAt = testNow.Add(left)
			view := h.mustLink(stripeLink())
			require.False(t, view.ExpiresAt.After(order.ExpiresAt), "token expiry %s after order expiry %s", view.ExpiresAt, order.ExpiresAt)
			require.LessOrEqual(t, view.ExpiresAt.Sub(testNow), maxLinkTTL)
			ttl := h.mr.TTL(storeKey(view.Token))
			require.Positive(t, ttl)
			require.LessOrEqual(t, ttl, order.ExpiresAt.Sub(testNow))
			require.LessOrEqual(t, ttl, maxLinkTTL)
			require.Equal(t, view.ExpiresAt.Sub(testNow), ttl, "the reported expiry is the Redis expiry")
			require.Equal(t, view.ExpiresAt, view.ExpiresAt.Truncate(time.Second))
		})
	}
}

func TestCheckoutReturnsStripeRenderData(t *testing.T) {
	h := newHarness(t)
	link := h.mustLink(stripeLink())

	for i := 0; i < 2; i++ { // a page refresh reads the same token again
		rec, env := h.checkout(link.Token)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		require.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
		var view CheckoutView
		require.NoError(t, json.Unmarshal(env.Data, &view))
		require.Equal(t, int64(1024), view.OrderID)
		require.Equal(t, service.OrderStatusPending, view.Status)
		require.Equal(t, ProviderStripe, view.Provider)
		require.Equal(t, 20.0, view.Amount)
		require.Equal(t, 20.6, view.PayAmount)
		require.Equal(t, "USD", view.Currency)
		require.Equal(t, testNow.Add(50*time.Minute), view.ExpiresAt)
		require.Equal(t, &StripeView{PublishableKey: publishableKey, ClientSecret: stripeSecret}, view.Stripe)
		require.Nil(t, view.Airwallex)
		require.Equal(t, "/payment/result?resume_token="+stripeResume, view.ResultPath)
		require.Contains(t, string(env.Data), `"airwallex":null`)
	}
	require.Equal(t, 3, h.orders.calls, "each read re-checks the order")
}

func TestCheckoutReturnsAirwallexRenderData(t *testing.T) {
	h := newHarness(t)
	link := h.mustLink(awxLink())
	require.Equal(t, testNow.Add(20*time.Minute), link.ExpiresAt, "bounded by the order expiry")
	rec, env := h.checkout(link.Token)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var view CheckoutView
	require.NoError(t, json.Unmarshal(env.Data, &view))
	require.Equal(t, ProviderAirwallex, view.Provider)
	require.Nil(t, view.Stripe)
	require.Equal(t, &AirwallexView{Env: "prod", IntentID: awxTrade, ClientSecret: awxSecret, Currency: "HKD", CountryCode: "HK"}, view.Airwallex)
	require.Contains(t, string(env.Data), `"stripe":null`)

	// Any env other than prod is the demo environment, like the upstream page.
	h2 := newHarness(t)
	req := awxLink()
	req.PaymentEnv = "sandbox"
	link = h2.mustLink(req)
	_, env = h2.checkout(link.Token)
	require.NoError(t, json.Unmarshal(env.Data, &view))
	require.Equal(t, "demo", view.Airwallex.Env)
}

func TestCheckoutUsesRequestedCurrencyOnlyWithoutSnapshot(t *testing.T) {
	h := newHarness(t)
	h.orders.orders[stripeResume].ProviderSnapshot = nil
	link := h.mustLink(stripeLink())
	_, env := h.checkout(link.Token)
	var view CheckoutView
	require.NoError(t, json.Unmarshal(env.Data, &view))
	require.Equal(t, "USD", view.Currency, "falls back to the create-order currency")

	// With a snapshot the order's own currency wins over the request.
	h = newHarness(t)
	req := stripeLink()
	req.Currency = "EUR"
	link = h.mustLink(req)
	_, env = h.checkout(link.Token)
	require.NoError(t, json.Unmarshal(env.Data, &view))
	require.Equal(t, "USD", view.Currency)
}

func TestCheckoutLinkStoresOnlyAValidRequestedCurrency(t *testing.T) {
	h := newHarness(t)
	h.orders.orders[stripeResume].ProviderSnapshot = nil
	req := stripeLink()
	req.Currency = " eur "
	link := h.mustLink(req)
	_, env := h.checkout(link.Token)
	var view CheckoutView
	require.NoError(t, json.Unmarshal(env.Data, &view))
	require.Equal(t, "EUR", view.Currency)

	// Junk is dropped rather than stored: the record stays small and the
	// page gets the order's own (default) currency.
	h = newHarness(t)
	h.orders.orders[stripeResume].ProviderSnapshot = nil
	req = stripeLink()
	req.Currency = strings.Repeat("X", 12<<10)
	link = h.mustLink(req)
	raw, err := h.mr.Get(storeKey(link.Token))
	require.NoError(t, err)
	require.Less(t, len(raw), 1024)
	require.NotContains(t, raw, "requested_currency")
	_, env = h.checkout(link.Token)
	require.NoError(t, json.Unmarshal(env.Data, &view))
	require.Equal(t, service.PaymentOrderCurrency(h.orders.orders[stripeResume]), view.Currency)
}

func TestCheckoutHidesSecretsOnceTheOrderIsNotPending(t *testing.T) {
	for _, status := range []string{service.OrderStatusPaid, service.OrderStatusRecharging, service.OrderStatusCompleted,
		service.OrderStatusExpired, service.OrderStatusCancelled, service.OrderStatusFailed, service.OrderStatusRefunded} {
		t.Run(status, func(t *testing.T) {
			h := newHarness(t)
			stripeToken := h.mustLink(stripeLink()).Token
			awxToken := h.mustLink(awxLink()).Token
			h.orders.orders[stripeResume].Status = status
			h.orders.orders[awxResume].Status = status
			for _, token := range []string{stripeToken, awxToken} {
				rec, env := h.checkout(token)
				require.Equal(t, http.StatusOK, rec.Code)
				body := rec.Body.String()
				for _, secret := range []string{stripeSecret, awxSecret, publishableKey, awxTrade, "client_secret", "publishable_key"} {
					require.NotContains(t, body, secret)
				}
				var view CheckoutView
				require.NoError(t, json.Unmarshal(env.Data, &view))
				require.Equal(t, status, view.Status)
				require.Nil(t, view.Stripe)
				require.Nil(t, view.Airwallex)
				require.NotEmpty(t, view.ResultPath)
			}
		})
	}
}

func TestCheckoutHidesSecretsPastTheOrderExpiry(t *testing.T) {
	h := newHarness(t)
	token := h.mustLink(stripeLink()).Token
	h.comp.now = func() time.Time { return testNow.Add(51 * time.Minute) } // Redis still has it (clock skew)
	rec, env := h.checkout(token)
	require.Equal(t, http.StatusOK, rec.Code)
	require.NotContains(t, rec.Body.String(), stripeSecret)
	var view CheckoutView
	require.NoError(t, json.Unmarshal(env.Data, &view))
	require.Nil(t, view.Stripe)
}

func TestCheckoutRejectsBadAndExpiredTokens(t *testing.T) {
	h := newHarness(t)
	token := h.mustLink(stripeLink()).Token

	tampered := []byte(token)
	if tampered[0] == 'A' {
		tampered[0] = 'B'
	} else {
		tampered[0] = 'A'
	}
	for _, bad := range []string{"", "short", string(tampered), token + "x", token[:42], strings.ReplaceAll(token, token[:1], "+"), storeKey(token)} {
		rec, env := h.checkout(bad)
		requireNotFound(t, rec, env)
	}
	rec, _ := h.post("/api/v1/claudex/payment/checkout", 0, `{"token":`)
	require.Equal(t, http.StatusBadRequest, rec.Code)

	rec, _ = h.checkout(token)
	require.Equal(t, http.StatusOK, rec.Code)

	h.mr.FastForward(maxLinkTTL)
	rec, env := h.checkout(token)
	requireNotFound(t, rec, env)
}

func TestCheckoutRejectsStaleOrForeignRecords(t *testing.T) {
	t.Run("the order moved to another payment intent", func(t *testing.T) {
		h := newHarness(t)
		token := h.mustLink(stripeLink()).Token
		h.orders.orders[stripeResume].PaymentTradeNo = "pi_new"
		rec, env := h.checkout(token)
		requireNotFound(t, rec, env)
		require.NotContains(t, rec.Body.String(), stripeSecret)
	})
	t.Run("the resume token no longer resolves", func(t *testing.T) {
		h := newHarness(t)
		token := h.mustLink(stripeLink()).Token
		delete(h.orders.orders, stripeResume)
		rec, env := h.checkout(token)
		requireNotFound(t, rec, env)
	})
	t.Run("the order changed hands", func(t *testing.T) {
		h := newHarness(t)
		token := h.mustLink(stripeLink()).Token
		h.orders.orders[stripeResume].UserID = ownerID + 1
		rec, env := h.checkout(token)
		requireNotFound(t, rec, env)
	})
	t.Run("an unreadable record", func(t *testing.T) {
		h := newHarness(t)
		token := h.mustLink(stripeLink()).Token
		require.NoError(t, h.mr.Set(storeKey(token), "{not json"))
		rec, env := h.checkout(token)
		requireNotFound(t, rec, env)
	})
	t.Run("a lookup failure is not a 404", func(t *testing.T) {
		h := newHarness(t)
		token := h.mustLink(stripeLink()).Token
		h.orders.err = errors.New("database is down")
		rec, _ := h.checkout(token)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
		require.NotContains(t, rec.Body.String(), stripeSecret)
	})
	t.Run("Redis down", func(t *testing.T) {
		h := newHarness(t)
		token := h.mustLink(stripeLink()).Token
		h.mr.Close()
		rec, _ := h.checkout(token)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})
}

func TestCheckoutResultPathEscapesTheResumeToken(t *testing.T) {
	h := newHarness(t)
	const resume = "eyJ+a/b=c&d"
	h.orders.orders[resume] = stripeOrder()
	req := stripeLink()
	req.ResumeToken = resume
	token := h.mustLink(req).Token
	_, env := h.checkout(token)
	var view CheckoutView
	require.NoError(t, json.Unmarshal(env.Data, &view))
	u, err := url.Parse(view.ResultPath)
	require.NoError(t, err)
	require.Equal(t, "/payment/result", u.Path)
	require.Equal(t, resume, u.Query().Get("resume_token"))
	require.Len(t, u.Query(), 1, "no order_id: the result page must not fall back to the JWT order API")
}

func TestCheckoutWithoutDependencies(t *testing.T) {
	gin.SetMode(gin.TestMode)
	comp := New(&core.Env{})
	r := gin.New()
	r.Use(gin.Recovery(), func(c *gin.Context) {
		c.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: ownerID})
		c.Next()
	})
	comp.RegisterUserRoutes(r.Group("/api/v1/claudex"))
	comp.RegisterPublicRoutes(r.Group("/api/v1/claudex"))
	for path, body := range map[string]any{
		"/api/v1/claudex/payment/checkout-links": stripeLink(),
		"/api/v1/claudex/payment/checkout":       CheckoutRequest{Token: strings.Repeat("a", 43)},
	} {
		raw, _ := json.Marshal(body)
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, path, bytes.NewReader(raw)))
		require.Equal(t, http.StatusInternalServerError, rec.Code, path)
	}
	require.Equal(t, core.NamePayment, comp.Name())
}
