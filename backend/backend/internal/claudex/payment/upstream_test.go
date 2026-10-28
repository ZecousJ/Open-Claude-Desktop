package payment

// These tests run the component against the real upstream PaymentService and
// PaymentConfigService (ent on in-memory SQLite, Redis via miniredis), so the
// resume-token lookup, the order fields and the Stripe publishable key are the
// ones the server really uses.

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"testing"
	"time"

	dbent "github.com/Wei-Shaw/sub2api/ent"
	"github.com/Wei-Shaw/sub2api/ent/enttest"
	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/payment"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
	_ "modernc.org/sqlite"
)

const upstreamSigningKey = "claudex-b10-resume-signing-key-for-tests"

type upstreamSettings struct {
	service.SettingRepository
}

func (upstreamSettings) GetMultiple(_ context.Context, keys []string) (map[string]string, error) {
	return map[string]string{service.SettingPaymentEnabled: "true"}, nil
}

func (upstreamSettings) GetValue(context.Context, string) (string, error) { return "", nil }

type upstreamFixture struct {
	client  *dbent.Client
	comp    *Component
	mr      *miniredis.Miniredis
	resume  *service.PaymentResumeService
	userID  int64
	otherID int64
}

func newUpstreamFixture(t *testing.T) *upstreamFixture {
	t.Helper()
	t.Setenv("PAYMENT_RESUME_SIGNING_KEY", upstreamSigningKey)
	ctx := context.Background()

	db, err := sql.Open("sqlite", fmt.Sprintf("file:%s?mode=memory&cache=shared", strings.NewReplacer("/", "_", " ", "_").Replace(t.Name())))
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	_, err = db.Exec("PRAGMA foreign_keys = ON")
	require.NoError(t, err)
	client := enttest.NewClient(t, enttest.WithOptions(dbent.Driver(entsql.OpenDB(dialect.SQLite, db))))
	t.Cleanup(func() { _ = client.Close() })

	encryptionKey := []byte("0123456789abcdef0123456789abcdef")
	configs := service.NewPaymentConfigService(client, upstreamSettings{}, encryptionKey)
	payments := service.NewPaymentService(client, payment.NewRegistry(), nil, nil, nil, configs, nil, nil, nil)

	// The instance GetPaymentConfig takes the publishable key from. Orders
	// below point at instance 999, which does not exist, so the pending-order
	// lookup never calls Stripe.
	_, err = client.PaymentProviderInstance.Create().
		SetProviderKey(payment.TypeStripe).
		SetName("Stripe").
		SetConfig(`{"publishableKey":"pk_test_upstream","secretKey":"sk_test_upstream"}`).
		SetSupportedTypes("card").
		SetEnabled(true).
		Save(ctx)
	require.NoError(t, err)

	mkUser := func(email string) int64 {
		u, err := client.User.Create().SetEmail(email).SetPasswordHash("hash").SetUsername(email).Save(ctx)
		require.NoError(t, err)
		return u.ID
	}
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })
	env := &core.Env{Deps: core.Deps{Payment: payments, PaymentConfig: configs, Redis: rdb}, Now: time.Now}
	return &upstreamFixture{
		client: client, comp: New(env), mr: mr,
		resume: service.NewPaymentResumeService([]byte(upstreamSigningKey)),
		userID: mkUser("desktop@example.com"), otherID: mkUser("other@example.com"),
	}
}

// order creates a pending order the way PaymentService.invokeProvider leaves
// it, and the resume token the create-order response carries.
func (f *upstreamFixture) order(t *testing.T, provider, paymentType, tradeNo string) (*dbent.PaymentOrder, string) {
	t.Helper()
	ctx := context.Background()
	o, err := f.client.PaymentOrder.Create().
		SetUserID(f.userID).
		SetUserEmail("desktop@example.com").
		SetUserName("desktop").
		SetAmount(20).
		SetPayAmount(20.6).
		SetFeeRate(3).
		SetRechargeCode(fmt.Sprintf("PAY-%s-%d", provider, time.Now().UnixNano())).
		SetOutTradeNo(fmt.Sprintf("sub2_%s_%d", provider, time.Now().UnixNano())).
		SetPaymentType(paymentType).
		SetPaymentTradeNo(tradeNo).
		SetOrderType(payment.OrderTypeBalance).
		SetStatus(service.OrderStatusPending).
		SetExpiresAt(time.Now().Add(50 * time.Minute)).
		SetClientIP("127.0.0.1").
		SetSrcHost("pay.example.com").
		SetProviderInstanceID("999").
		SetProviderKey(provider).
		Save(ctx)
	require.NoError(t, err)
	token, err := f.resume.CreateToken(service.ResumeTokenClaims{
		OrderID:            o.ID,
		UserID:             f.userID,
		ProviderInstanceID: "999",
		ProviderKey:        provider,
		PaymentType:        paymentType,
		CanonicalReturnURL: "https://pay.example.com/payment/result",
	})
	require.NoError(t, err)
	return o, token
}

func requireReason(t *testing.T, err error, status int, reason string) {
	t.Helper()
	require.Error(t, err)
	require.Equal(t, status, infraerrors.Code(err), err.Error())
	require.Equal(t, reason, infraerrors.Reason(err))
}

func TestCheckoutAgainstUpstreamStripeOrder(t *testing.T) {
	f := newUpstreamFixture(t)
	ctx := context.Background()
	order, resume := f.order(t, payment.TypeStripe, payment.TypeStripe, "pi_3Qupstream")
	req := LinkRequest{OrderID: order.ID, ResumeToken: resume, ClientSecret: "pi_3Qupstream_secret_abc", Currency: "CNY"}

	_, err := f.comp.link(ctx, f.otherID, req)
	requireReason(t, err, 409, "CLAUDEX_CHECKOUT_UNAVAILABLE")

	bad := req
	bad.ResumeToken = resume[:len(resume)-2] + "xx"
	_, err = f.comp.link(ctx, f.userID, bad)
	requireReason(t, err, 409, "CLAUDEX_CHECKOUT_UNAVAILABLE")

	bad = req
	bad.ClientSecret = "pi_3Qother_secret_abc"
	_, err = f.comp.link(ctx, f.userID, bad)
	requireReason(t, err, 409, "CLAUDEX_CHECKOUT_UNAVAILABLE")

	link, err := f.comp.link(ctx, f.userID, req)
	require.NoError(t, err)
	require.False(t, link.ExpiresAt.After(order.ExpiresAt))
	require.LessOrEqual(t, f.mr.TTL(storeKey(link.Token)), maxLinkTTL)

	view, err := f.comp.checkout(ctx, link.Token)
	require.NoError(t, err)
	require.Equal(t, service.OrderStatusPending, view.Status)
	require.Equal(t, &StripeView{PublishableKey: "pk_test_upstream", ClientSecret: "pi_3Qupstream_secret_abc"}, view.Stripe)
	require.Equal(t, "/payment/result?resume_token="+resume, view.ResultPath)
	require.Equal(t, order.ID, view.OrderID)

	// Once paid, the same token only reports the status.
	_, err = f.client.PaymentOrder.UpdateOneID(order.ID).SetStatus(service.OrderStatusCompleted).Save(ctx)
	require.NoError(t, err)
	view, err = f.comp.checkout(ctx, link.Token)
	require.NoError(t, err)
	require.Equal(t, service.OrderStatusCompleted, view.Status)
	require.Nil(t, view.Stripe)
	require.Nil(t, view.Airwallex)

	// And no new link can be made for it.
	_, err = f.comp.link(ctx, f.userID, req)
	requireReason(t, err, 409, "CLAUDEX_CHECKOUT_UNAVAILABLE")

	_, err = f.comp.checkout(ctx, strings.Repeat("A", 43))
	requireReason(t, err, 404, "CLAUDEX_CHECKOUT_NOT_FOUND")
}

func TestCheckoutAgainstUpstreamAirwallexAndOtherOrders(t *testing.T) {
	f := newUpstreamFixture(t)
	ctx := context.Background()

	order, resume := f.order(t, payment.TypeAirwallex, payment.TypeAirwallex, "int_upstream")
	req := LinkRequest{OrderID: order.ID, ResumeToken: resume, ClientSecret: "awx_secret", IntentID: "int_upstream",
		Currency: "USD", CountryCode: "US", PaymentEnv: "demo"}
	link, err := f.comp.link(ctx, f.userID, req)
	require.NoError(t, err)
	view, err := f.comp.checkout(ctx, link.Token)
	require.NoError(t, err)
	require.Nil(t, view.Stripe)
	require.Equal(t, &AirwallexView{Env: "demo", IntentID: "int_upstream", ClientSecret: "awx_secret", Currency: "USD", CountryCode: "US"}, view.Airwallex)

	req.IntentID = "int_other"
	_, err = f.comp.link(ctx, f.userID, req)
	requireReason(t, err, 409, "CLAUDEX_CHECKOUT_UNAVAILABLE")

	// An Alipay order has no client secret flow.
	alipay, alipayResume := f.order(t, payment.TypeAlipay, payment.TypeAlipay, "2026092622001")
	_, err = f.comp.link(ctx, f.userID, LinkRequest{OrderID: alipay.ID, ResumeToken: alipayResume, ClientSecret: "2026092622001_secret_x"})
	requireReason(t, err, 409, "CLAUDEX_CHECKOUT_UNAVAILABLE")

	// An expired order.
	expired, expiredResume := f.order(t, payment.TypeStripe, payment.TypeCard, "pi_expired")
	_, err = f.client.PaymentOrder.UpdateOneID(expired.ID).SetStatus(service.OrderStatusExpired).Save(ctx)
	require.NoError(t, err)
	_, err = f.comp.link(ctx, f.userID, LinkRequest{OrderID: expired.ID, ResumeToken: expiredResume, ClientSecret: "pi_expired_secret_x"})
	requireReason(t, err, 409, "CLAUDEX_CHECKOUT_UNAVAILABLE")
}
