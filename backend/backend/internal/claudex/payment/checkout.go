package payment

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	dbent "github.com/Wei-Shaw/sub2api/ent"
	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/payment"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
)

const (
	// linkRateLimit is the number of checkout links a user may create per minute.
	linkRateLimit = 20
	// maxLinkTTL caps how long a checkout token lives (never past the order expiry).
	maxLinkTTL = 30 * time.Minute
	// tokenBytes is the size of the random checkout token (43 base64url characters).
	tokenBytes = 32
	// maxBodyBytes bounds both request bodies.
	maxBodyBytes = 16 << 10
	// storeKeyPrefix is followed by the hex SHA-256 of the token, so the raw
	// token never appears in Redis key listings or monitoring output.
	storeKeyPrefix = "claudex:checkout:"
	// resultPath is the upstream public payment result page; it resolves the
	// order from the resume token without a sign-in.
	resultPath = "/payment/result"

	maxResumeTokenLen  = 4096
	maxClientSecretLen = 512
	maxIntentIDLen     = 256
)

// Providers the desktop checkout page can mount.
const (
	ProviderStripe    = payment.TypeStripe
	ProviderAirwallex = payment.TypeAirwallex
)

// Rules reported in the metadata of CLAUDEX_CHECKOUT_UNAVAILABLE (409), so the
// desktop app can tell the cases apart.
const (
	ruleRequest  = "request"  // required fields missing or malformed
	ruleOrder    = "order"    // the resume token does not resolve to order_id
	ruleOwner    = "owner"    // the order belongs to another user
	ruleStatus   = "status"   // the order is no longer pending
	ruleExpired  = "expired"  // the order (or what is left of it) has expired
	ruleProvider = "provider" // the order is not a Stripe or Airwallex order
	ruleSecret   = "secret"   // client_secret / intent_id do not match the order
	ruleConfig   = "config"   // the server has no Stripe publishable key
)

var tokenPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

func errUnavailable(rule string) error {
	msg := "This order can't be paid in the browser. Go back to Claudex and try again."
	if rule == ruleConfig {
		msg = "Paying by card in the browser isn't set up on this server. Choose another way to pay in Claudex."
	}
	return infraerrors.Conflict("CLAUDEX_CHECKOUT_UNAVAILABLE", msg).WithMetadata(map[string]string{"rule": rule})
}

var errNotFound = infraerrors.NotFound("CLAUDEX_CHECKOUT_NOT_FOUND",
	"This checkout link has expired or isn't valid. Go back to Claudex to try again.")

var errNotConfigured = errors.New("claudex checkout: payment services or Redis are not available")

// LinkRequest is the body of POST /api/v1/claudex/payment/checkout-links: the
// fields of the upstream create-order response, passed through unchanged.
type LinkRequest struct {
	OrderID      int64  `json:"order_id"`
	ResumeToken  string `json:"resume_token"`
	ClientSecret string `json:"client_secret"`
	IntentID     string `json:"intent_id"`
	Currency     string `json:"currency"`
	CountryCode  string `json:"country_code"`
	PaymentEnv   string `json:"payment_env"`
}

// LinkView is the answer of POST /api/v1/claudex/payment/checkout-links. The
// desktop app opens <service>/desktop-pay#t=<token>.
type LinkView struct {
	Token     string    `json:"token"`
	ExpiresAt time.Time `json:"expires_at"` // when the token stops working (<= the order expiry)
}

// CheckoutRequest is the body of POST /api/v1/claudex/payment/checkout.
type CheckoutRequest struct {
	Token string `json:"token"`
}

// StripeView is what the page needs to mount the Stripe Payment Element.
type StripeView struct {
	PublishableKey string `json:"publishable_key"`
	ClientSecret   string `json:"client_secret"`
}

// AirwallexView is what the page needs to open the Airwallex checkout.
type AirwallexView struct {
	Env          string `json:"env"` // prod | demo
	IntentID     string `json:"intent_id"`
	ClientSecret string `json:"client_secret"`
	Currency     string `json:"currency"`
	CountryCode  string `json:"country_code"`
}

// CheckoutView is the answer of POST /api/v1/claudex/payment/checkout. Stripe
// or Airwallex is filled only while the order can still be paid; otherwise
// the page shows the status and no payment form.
type CheckoutView struct {
	OrderID    int64          `json:"order_id"`
	Status     string         `json:"status"`
	Provider   string         `json:"provider"`
	Amount     float64        `json:"amount"`
	PayAmount  float64        `json:"pay_amount"`
	Currency   string         `json:"currency"`
	ExpiresAt  time.Time      `json:"expires_at"` // order expiry
	Stripe     *StripeView    `json:"stripe"`
	Airwallex  *AirwallexView `json:"airwallex"`
	ResultPath string         `json:"result_path"`
}

// checkoutRecord is what a token maps to in Redis.
type checkoutRecord struct {
	V              int       `json:"v"`
	UserID         int64     `json:"user_id"`
	OrderID        int64     `json:"order_id"`
	ResumeToken    string    `json:"resume_token"`
	Provider       string    `json:"provider"`
	ClientSecret   string    `json:"client_secret"`
	IntentID       string    `json:"intent_id,omitempty"`
	PublishableKey string    `json:"publishable_key,omitempty"`
	CountryCode    string    `json:"country_code,omitempty"`
	PaymentEnv     string    `json:"payment_env,omitempty"`
	RequestedCur   string    `json:"requested_currency,omitempty"`
	ExpiresAt      time.Time `json:"expires_at"`
}

func storeKey(token string) string {
	sum := sha256.Sum256([]byte(token))
	return storeKeyPrefix + hex.EncodeToString(sum[:])
}

func newToken() (string, error) {
	b := make([]byte, tokenBytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// orderProvider is the payment provider an order was placed with: the
// provider snapshot, then the order's provider key, then the payment type.
func orderProvider(order *dbent.PaymentOrder) string {
	if order == nil {
		return ""
	}
	if raw, ok := order.ProviderSnapshot["provider_key"].(string); ok && strings.TrimSpace(raw) != "" {
		return strings.ToLower(strings.TrimSpace(raw))
	}
	if order.ProviderKey != nil && strings.TrimSpace(*order.ProviderKey) != "" {
		return strings.ToLower(strings.TrimSpace(*order.ProviderKey))
	}
	return payment.GetBasePaymentType(strings.ToLower(strings.TrimSpace(order.PaymentType)))
}

// orderInstanceID is the provider instance an order was placed with.
func orderInstanceID(order *dbent.PaymentOrder) int64 {
	raw := ""
	if v, ok := order.ProviderSnapshot["provider_instance_id"].(string); ok {
		raw = strings.TrimSpace(v)
	}
	if raw == "" && order.ProviderInstanceID != nil {
		raw = strings.TrimSpace(*order.ProviderInstanceID)
	}
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || id <= 0 {
		return 0
	}
	return id
}

// stripePublishableKey is the publishable key of the Stripe account that
// created the order's payment intent: the key of the order's own provider
// instance when it has one, else the key the upstream checkout uses (the
// first enabled Stripe instance, PaymentConfig.stripe_publishable_key).
func stripePublishableKey(ctx context.Context, configs configLookup, order *dbent.PaymentOrder) (string, error) {
	if id := orderInstanceID(order); id > 0 {
		instances, err := configs.ListProviderInstancesWithConfig(ctx)
		if err != nil {
			slog.Warn("claudex checkout: provider instances unreadable, using the default Stripe key", "error", err)
		}
		for _, inst := range instances {
			if inst.ID == id && strings.EqualFold(inst.ProviderKey, ProviderStripe) {
				if key := strings.TrimSpace(inst.Config[payment.ConfigKeyPublishableKey]); key != "" {
					return key, nil
				}
			}
		}
	}
	cfg, err := configs.GetPaymentConfig(ctx)
	if err != nil {
		return "", err
	}
	if cfg == nil {
		return "", nil
	}
	return strings.TrimSpace(cfg.StripePublishableKey), nil
}

// orderCurrency is the currency of the order's payment intent: the provider
// snapshot when it records one (like the upstream order API), else the
// currency of the create-order response, else the upstream default.
func orderCurrency(order *dbent.PaymentOrder, requested string) string {
	if raw, ok := order.ProviderSnapshot["currency"].(string); ok && strings.TrimSpace(raw) != "" {
		return service.PaymentOrderCurrency(order)
	}
	if strings.TrimSpace(requested) != "" {
		if cur, err := payment.NormalizePaymentCurrency(requested); err == nil {
			return cur
		}
	}
	return service.PaymentOrderCurrency(order)
}

// secretMatches checks the client secret / intent id from the create-order
// response against the order's payment_trade_no (the provider's intent id).
func secretMatches(provider, tradeNo, clientSecret, intentID string) bool {
	tradeNo = strings.TrimSpace(tradeNo)
	if tradeNo == "" || clientSecret == "" {
		return false
	}
	switch provider {
	case ProviderStripe:
		return strings.HasPrefix(clientSecret, tradeNo+"_secret_") && len(clientSecret) > len(tradeNo)+len("_secret_")
	case ProviderAirwallex:
		return intentID == tradeNo
	}
	return false
}

func validCountry(code string) bool {
	if len(code) != 2 {
		return false
	}
	for _, ch := range code {
		if ch < 'A' || ch > 'Z' {
			return false
		}
	}
	return true
}

// isClientError reports whether err is a 4xx application error (a bad,
// expired or foreign resume token, a missing order, ...), as opposed to an
// infrastructure failure that should surface as-is.
func isClientError(err error) bool {
	code := infraerrors.Code(err)
	return code >= 400 && code < 500
}

func decodeBody(c *gin.Context, v any) bool {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxBodyBytes)
	if err := json.NewDecoder(c.Request.Body).Decode(v); err != nil {
		response.BadRequest(c, "Invalid request")
		return false
	}
	return true
}

// POST /api/v1/claudex/payment/checkout-links (user).
func (c *Component) createLink(g *gin.Context) {
	g.Header("Cache-Control", "no-store")
	userID, ok := core.Subject(g)
	if !ok {
		response.Unauthorized(g, "User not authenticated")
		return
	}
	var req LinkRequest
	if !decodeBody(g, &req) {
		return
	}
	view, err := c.link(g.Request.Context(), userID, req)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	response.Success(g, view)
}

func (c *Component) link(ctx context.Context, userID int64, req LinkRequest) (*LinkView, error) {
	orders, configs, rdb := c.orderLookup(), c.configLookup(), c.redis()
	if orders == nil || configs == nil || rdb == nil {
		return nil, errNotConfigured
	}
	req.ResumeToken = strings.TrimSpace(req.ResumeToken)
	req.ClientSecret = strings.TrimSpace(req.ClientSecret)
	req.IntentID = strings.TrimSpace(req.IntentID)
	req.CountryCode = strings.ToUpper(strings.TrimSpace(req.CountryCode))
	req.PaymentEnv = strings.ToLower(strings.TrimSpace(req.PaymentEnv))
	if req.OrderID <= 0 || req.ResumeToken == "" || len(req.ResumeToken) > maxResumeTokenLen ||
		req.ClientSecret == "" || len(req.ClientSecret) > maxClientSecretLen || len(req.IntentID) > maxIntentIDLen ||
		(req.CountryCode != "" && !validCountry(req.CountryCode)) {
		return nil, errUnavailable(ruleRequest)
	}

	order, err := orders.GetPublicOrderByResumeToken(ctx, req.ResumeToken)
	if err != nil {
		if isClientError(err) {
			return nil, errUnavailable(ruleOrder)
		}
		return nil, err
	}
	now := c.clock()
	switch {
	case order == nil || order.ID != req.OrderID:
		return nil, errUnavailable(ruleOrder)
	case order.UserID != userID:
		return nil, errUnavailable(ruleOwner)
	case order.Status != service.OrderStatusPending:
		return nil, errUnavailable(ruleStatus)
	case !now.Before(order.ExpiresAt):
		return nil, errUnavailable(ruleExpired)
	}
	provider := orderProvider(order)
	if provider != ProviderStripe && provider != ProviderAirwallex {
		return nil, errUnavailable(ruleProvider)
	}
	if !secretMatches(provider, order.PaymentTradeNo, req.ClientSecret, req.IntentID) {
		return nil, errUnavailable(ruleSecret)
	}

	rec := checkoutRecord{
		V:            1,
		UserID:       userID,
		OrderID:      order.ID,
		ResumeToken:  req.ResumeToken,
		Provider:     provider,
		ClientSecret: req.ClientSecret,
	}
	// Keep only a valid ISO code (orderCurrency ignores anything else), so the
	// stored record stays small whatever the request carried.
	if strings.TrimSpace(req.Currency) != "" {
		if cur, err := payment.NormalizePaymentCurrency(req.Currency); err == nil {
			rec.RequestedCur = cur
		}
	}
	switch provider {
	case ProviderStripe:
		key, err := stripePublishableKey(ctx, configs, order)
		if err != nil {
			return nil, err
		}
		if key == "" {
			return nil, errUnavailable(ruleConfig)
		}
		rec.PublishableKey = key
	case ProviderAirwallex:
		rec.IntentID = req.IntentID
		rec.CountryCode = req.CountryCode
		rec.PaymentEnv = "demo"
		if req.PaymentEnv == "prod" {
			rec.PaymentEnv = "prod"
		}
	}

	// The token lives at most 30 minutes and never past the order expiry;
	// whole seconds, rounded down, so the reported time is never late.
	expires := now.Add(maxLinkTTL)
	if order.ExpiresAt.Before(expires) {
		expires = order.ExpiresAt
	}
	expires = expires.Truncate(time.Second)
	ttl := expires.Sub(now)
	if ttl < time.Second {
		return nil, errUnavailable(ruleExpired)
	}
	rec.ExpiresAt = expires.UTC()
	raw, err := json.Marshal(rec)
	if err != nil {
		return nil, err
	}
	for attempt := 0; attempt < 3; attempt++ {
		token, err := newToken()
		if err != nil {
			return nil, err
		}
		// An absolute expiry (SET ... NX EXAT), so the time the request took
		// never pushes the key past the reported (and order) expiry.
		err = rdb.SetArgs(ctx, storeKey(token), raw, redis.SetArgs{Mode: "NX", ExpireAt: expires}).Err()
		if err == nil {
			return &LinkView{Token: token, ExpiresAt: rec.ExpiresAt}, nil
		}
		if !errors.Is(err, redis.Nil) { // redis.Nil: the key exists (NX)
			return nil, err
		}
	}
	return nil, errors.New("claudex checkout: could not allocate a unique token")
}

// POST /api/v1/claudex/payment/checkout (public).
func (c *Component) getCheckout(g *gin.Context) {
	g.Header("Cache-Control", "no-store")
	g.Header("Referrer-Policy", "no-referrer")
	var req CheckoutRequest
	if !decodeBody(g, &req) {
		return
	}
	view, err := c.checkout(g.Request.Context(), strings.TrimSpace(req.Token))
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	response.Success(g, view)
}

func (c *Component) checkout(ctx context.Context, token string) (*CheckoutView, error) {
	if !tokenPattern.MatchString(token) {
		return nil, errNotFound
	}
	orders, rdb := c.orderLookup(), c.redis()
	if orders == nil || rdb == nil {
		return nil, errNotConfigured
	}
	raw, err := rdb.Get(ctx, storeKey(token)).Bytes()
	if err != nil {
		if errors.Is(err, redis.Nil) {
			return nil, errNotFound
		}
		return nil, err
	}
	var rec checkoutRecord
	if err := json.Unmarshal(raw, &rec); err != nil || rec.OrderID <= 0 || rec.ResumeToken == "" {
		slog.Warn("claudex checkout: unreadable checkout record")
		return nil, errNotFound
	}

	// Every read re-checks the order (for pending orders the upstream lookup
	// asks the payment provider), so a paid order never hands out a secret.
	order, err := orders.GetPublicOrderByResumeToken(ctx, rec.ResumeToken)
	if err != nil {
		if isClientError(err) {
			return nil, errNotFound
		}
		return nil, err
	}
	if order == nil || order.ID != rec.OrderID || order.UserID != rec.UserID {
		return nil, errNotFound
	}

	view := &CheckoutView{
		OrderID:    order.ID,
		Status:     order.Status,
		Provider:   rec.Provider,
		Amount:     order.Amount,
		PayAmount:  order.PayAmount,
		Currency:   orderCurrency(order, rec.RequestedCur),
		ExpiresAt:  order.ExpiresAt.UTC().Truncate(time.Second),
		ResultPath: resultPath + "?resume_token=" + url.QueryEscape(rec.ResumeToken),
	}
	if order.Status != service.OrderStatusPending || !c.clock().Before(order.ExpiresAt) {
		return view, nil
	}
	if !secretMatches(rec.Provider, order.PaymentTradeNo, rec.ClientSecret, rec.IntentID) {
		// The order moved to another payment intent: this link is stale.
		return nil, errNotFound
	}
	switch rec.Provider {
	case ProviderStripe:
		view.Stripe = &StripeView{PublishableKey: rec.PublishableKey, ClientSecret: rec.ClientSecret}
	case ProviderAirwallex:
		view.Airwallex = &AirwallexView{
			Env:          rec.PaymentEnv,
			IntentID:     rec.IntentID,
			ClientSecret: rec.ClientSecret,
			Currency:     view.Currency,
			CountryCode:  rec.CountryCode,
		}
	default:
		return nil, errNotFound
	}
	return view, nil
}
