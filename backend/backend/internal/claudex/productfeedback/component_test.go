package productfeedback

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
)

func router(c *Component, userID int64) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	g := r.Group("/api/v1/claudex", func(ctx *gin.Context) {
		if userID > 0 {
			ctx.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: userID})
		}
	})
	c.RegisterUserRoutes(g)
	return r
}
func post(r *gin.Engine, body string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/claudex/product-feedback", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	return w
}

const validBody = `{"text":"explicit feedback only","app_version":"1.2.3","request_id":"12345678-1234-4234-8234-123456789012"}`

func TestHTTPAuthStrictPayloadAndEnvelope(t *testing.T) {
	calls := 0
	p, m := fixture(func(context.Context, string, string, string) error { calls++; return nil })
	c := &Component{processor: *p}
	if w := post(router(c, 0), validBody); w.Code != 401 {
		t.Fatal(w.Code)
	}
	for _, body := range []string{
		strings.Replace(validBody, `"text":`, `"to":"attacker@example.com","text":`, 1),
		strings.Replace(validBody, `"text":`, `"logs":true,"text":`, 1),
		validBody + `{}`, `null`, strings.Replace(validBody, "explicit feedback only", strings.Repeat("x", 4097), 1),
	} {
		if w := post(router(c, 7), body); w.Code != 400 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	if calls != 0 || len(m.rows) != 0 {
		t.Fatal("invalid request mutated")
	}
	w := post(router(c, 7), validBody)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"status":"sent"`) || !strings.Contains(w.Body.String(), `"feedback_id"`) {
		t.Fatal(w.Code, w.Body.String())
	}
	if calls != 1 {
		t.Fatal(calls)
	}
}
func TestHTTPUnavailableAndUnknown(t *testing.T) {
	if w := post(router(New(nil), 7), validBody); w.Code != 503 {
		t.Fatal(w.Code, w.Body.String())
	}
	p, _ := fixture(func(context.Context, string, string, string) error { return errUnknown })
	c := &Component{processor: *p}
	w := post(router(c, 7), validBody)
	if w.Code != 409 || !strings.Contains(w.Body.String(), "PRODUCT_FEEDBACK_DELIVERY_UNKNOWN") || strings.Contains(w.Body.String(), `"status":"sent"`) {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestHTTPRetryAfterSMTPNonAcceptance(t *testing.T) {
	for _, tc := range []struct {
		name          string
		releaseFails  bool
		initialStatus int
		initialReason string
		retryStatus   int
		calls         int
	}{
		{"released", false, http.StatusServiceUnavailable, "PRODUCT_FEEDBACK_UNAVAILABLE", http.StatusOK, 2},
		{"release failed", true, http.StatusConflict, "PRODUCT_FEEDBACK_DELIVERY_UNKNOWN", http.StatusConflict, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			p, m := fixture(func(_ context.Context, to, subject, body string) error {
				calls++
				if calls == 1 {
					return service.NewEmailService(nil, nil).SendEmailWithConfig(nil, to, subject, body)
				}
				return nil
			})
			m.releaseFails = tc.releaseFails
			r := router(&Component{processor: *p}, 7)
			if w := post(r, validBody); w.Code != tc.initialStatus || !strings.Contains(w.Body.String(), tc.initialReason) {
				t.Fatal(w.Code, w.Body.String())
			}
			if calls != 1 {
				t.Fatal(calls)
			}
			for i := 0; i < 2; i++ {
				if w := post(r, validBody); w.Code != tc.retryStatus {
					t.Fatal(w.Code, w.Body.String())
				}
			}
			if calls != tc.calls {
				t.Fatal(calls)
			}
		})
	}
}

type smtpSettings struct {
	service.SettingRepository
	from string
	port string
}

func (s smtpSettings) GetMultiple(context.Context, []string) (map[string]string, error) {
	return map[string]string{
		service.SettingKeySMTPHost: "127.0.0.1",
		service.SettingKeySMTPFrom: s.from,
		service.SettingKeySMTPPort: s.port,
	}, nil
}

func TestHTTPInvalidSMTPConfigurationDoesNotClaim(t *testing.T) {
	for name, cfg := range map[string]smtpSettings{
		"invalid sender":         {from: "invalid sender <>", port: "587"},
		"sender with line break": {from: "Name\r\n <sender@example.test>", port: "587"},
		"invalid port":           {from: "sender@example.test", port: "65536"},
	} {
		t.Run(name, func(t *testing.T) {
			_, receipts := fixture(nil)
			c := New(&core.Env{Deps: core.Deps{Email: service.NewEmailService(cfg, nil)}})
			c.processor.store = receipts
			w := post(router(c, 7), validBody)
			if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "PRODUCT_FEEDBACK_UNAVAILABLE") || len(receipts.rows) != 0 {
				t.Fatalf("invalid SMTP configuration got HTTP %d, body %s, receipts %d", w.Code, w.Body.String(), len(receipts.rows))
			}
		})
	}
}
