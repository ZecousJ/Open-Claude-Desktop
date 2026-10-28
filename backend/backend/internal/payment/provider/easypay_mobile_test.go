package provider

import (
	"context"
	"strings"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/payment"
)

// CLAUDEX: a phone cannot scan a QR code on its own screen, so WeChat Pay
// and Alipay from a phone go through the hosted page (submit.php) like
// a Z-Pay checkout; a computer keeps the mapi.php QR code.
func TestEasyPayMobileWechatUsesTheHostedPage(t *testing.T) {
	t.Parallel()

	provider, origin := newEasyPayMapiStub(t, "",
		`{"code":1,"trade_no":"TRADE_NO","payurl":"","qrcode":"weixin://wxpay/bizpayurl?pr=abc"}`)
	request := payment.CreatePaymentRequest{
		OrderID:     "sub2-mobile-wx",
		Amount:      "1.00",
		PaymentType: payment.TypeWxpay,
		Subject:     "Credit",
		IsMobile:    true,
	}

	resp, err := provider.CreatePayment(context.Background(), request)
	if err != nil {
		t.Fatalf("CreatePayment (phone): %v", err)
	}
	if !strings.HasPrefix(resp.PayURL, origin+"/submit.php?") || !strings.Contains(resp.PayURL, "device=mobile") {
		t.Fatalf("PayURL = %q, want the hosted page for a phone", resp.PayURL)
	}
	if resp.QRCode != "" {
		t.Fatalf("QRCode = %q, want none on a phone", resp.QRCode)
	}

	request.IsMobile = false
	resp, err = provider.CreatePayment(context.Background(), request)
	if err != nil {
		t.Fatalf("CreatePayment (computer): %v", err)
	}
	if resp.QRCode != "weixin://wxpay/bizpayurl?pr=abc" {
		t.Fatalf("QRCode = %q, want the mapi.php code on a computer", resp.QRCode)
	}

	request.IsMobile, request.PaymentType = true, payment.TypeAlipay
	resp, err = provider.CreatePayment(context.Background(), request)
	if err != nil {
		t.Fatalf("CreatePayment (phone, Alipay): %v", err)
	}
	if !strings.HasPrefix(resp.PayURL, origin+"/submit.php?") || !strings.Contains(resp.PayURL, "type=alipay") || resp.QRCode != "" {
		t.Fatalf("PayURL = %q, QRCode = %q, want Alipay's hosted page on a phone", resp.PayURL, resp.QRCode)
	}

	request.IsMobile = false
	resp, err = provider.CreatePayment(context.Background(), request)
	if err != nil {
		t.Fatalf("CreatePayment (computer, Alipay): %v", err)
	}
	if strings.Contains(resp.PayURL, "/submit.php") || resp.QRCode == "" {
		t.Fatalf("PayURL = %q, QRCode = %q, want the mapi.php code on a computer", resp.PayURL, resp.QRCode)
	}
}
