// Package payment is the B10 component: the desktop checkout for orders paid
// with Stripe or Airwallex (design 2.11, owner decision 2).
//
// The upstream /payment/stripe and /payment/airwallex pages cannot serve the
// desktop app: they need a web session (JWT) or the web checkout's
// localStorage, and the order table never stores client_secret or intent_id
// (they only appear in the create-order response). So the desktop app hands
// the create-order fields to POST /api/v1/claudex/payment/checkout-links
// (JWT); the server checks them against the order and keeps what the page
// needs in Redis under a random token. The public page /desktop-pay reads the
// token from its URL fragment and loads the render data with the public
// POST /api/v1/claudex/payment/checkout, token in the body.
package payment

import (
	"context"
	"time"

	dbent "github.com/Wei-Shaw/sub2api/ent"
	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
)

// orderLookup is the part of service.PaymentService the component uses.
type orderLookup interface {
	// GetPublicOrderByResumeToken verifies the signed resume token and loads
	// its order; for pending orders it asks the payment provider first.
	GetPublicOrderByResumeToken(ctx context.Context, token string) (*dbent.PaymentOrder, error)
}

// configLookup is the part of service.PaymentConfigService the component uses.
type configLookup interface {
	GetPaymentConfig(ctx context.Context) (*service.PaymentConfig, error)
	// ListProviderInstancesWithConfig lists the provider instances with their
	// non-secret config (the Stripe publishable key is not a secret).
	ListProviderInstancesWithConfig(ctx context.Context) ([]service.ProviderInstanceResponse, error)
}

// Component is the B10 component.
type Component struct {
	env *core.Env

	// Test seams; nil means the services and Redis client of env.
	orders  orderLookup
	configs configLookup
	rdb     *redis.Client
	now     func() time.Time
}

// New builds the component. It must not call its dependencies or env.Peers:
// ProvideModule binds the peers after every component is built, and tests
// pass empty Deps.
func New(env *core.Env) *Component { return &Component{env: env} }

// Name implements core.Feature.
func (c *Component) Name() string { return core.NamePayment }

// RegisterUserRoutes adds POST /api/v1/claudex/payment/checkout-links (JWT;
// the module keeps its body out of audit_logs).
func (c *Component) RegisterUserRoutes(g *gin.RouterGroup) {
	g.POST("/payment/checkout-links", c.env.RateLimitPerUser("payment.checkout_links", linkRateLimit, time.Minute), c.createLink)
}

// RegisterPublicRoutes adds the public POST /api/v1/claudex/payment/checkout
// (per-IP panel rate limit from the module; the token travels in the body so
// it never reaches access logs).
func (c *Component) RegisterPublicRoutes(g *gin.RouterGroup) {
	g.POST("/payment/checkout", c.getCheckout)
}

func (c *Component) orderLookup() orderLookup {
	if c.orders != nil {
		return c.orders
	}
	if c.env != nil && c.env.Payment != nil {
		return c.env.Payment
	}
	return nil
}

func (c *Component) configLookup() configLookup {
	if c.configs != nil {
		return c.configs
	}
	if c.env != nil && c.env.PaymentConfig != nil {
		return c.env.PaymentConfig
	}
	return nil
}

func (c *Component) redis() *redis.Client {
	if c.rdb != nil {
		return c.rdb
	}
	if c.env != nil {
		return c.env.Redis
	}
	return nil
}

func (c *Component) clock() time.Time {
	switch {
	case c.now != nil:
		return c.now()
	case c.env != nil && c.env.Now != nil:
		return c.env.Now()
	}
	return time.Now()
}

var (
	_ core.Feature      = (*Component)(nil)
	_ core.UserRouter   = (*Component)(nil)
	_ core.PublicRouter = (*Component)(nil)
	_ orderLookup       = (*service.PaymentService)(nil)
	_ configLookup      = (*service.PaymentConfigService)(nil)
)
