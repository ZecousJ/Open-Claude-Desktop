package routinemail

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	middleware "github.com/Wei-Shaw/sub2api/internal/server/middleware"

	"github.com/gin-gonic/gin"
)

type mail struct{ to, subject, body string }

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
	req := httptest.NewRequest(http.MethodPost, "/api/v1/claudex/routines/email", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	return w
}

func TestRunMailGoesToTheCallerOnly(t *testing.T) {
	var sent []mail
	c := New(&core.Env{Now: time.Now})
	c.mailer = func(_ context.Context, to, subject, body string) error {
		sent = append(sent, mail{to, subject, body})
		return nil
	}
	c.address = func(_ context.Context, id int64) string {
		if id == 7 {
			return "owner@example.com"
		}
		return ""
	}
	w := post(router(c, 7), `{"task":"Daily <digest>","outcome":"completed","summary":"3 items","link":"https://claudex.example.com/c/1","to":"other@example.com"}`)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"sent":true`) {
		t.Fatalf("status %d %s", w.Code, w.Body.String())
	}
	if len(sent) != 1 || sent[0].to != "owner@example.com" {
		t.Fatalf("mail went to %+v", sent)
	}
	if !strings.Contains(sent[0].subject, "Your scheduled task finished: Daily <digest>") ||
		strings.Contains(sent[0].body, "<digest>") || !strings.Contains(sent[0].body, "Open in Claudex") {
		t.Fatalf("message %+v", sent[0])
	}
	// Only https links, known outcomes, signed-in callers.
	if w := post(router(c, 7), `{"task":"x","outcome":"deleted"}`); w.Code != http.StatusBadRequest {
		t.Fatalf("bad outcome: %d", w.Code)
	}
	if w := post(router(c, 0), `{"task":"x","outcome":"failed"}`); w.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous: %d", w.Code)
	}
	subject, body := runMail(runRequest{Task: "t", Outcome: "failed", Link: "javascript:alert(1)"})
	if !strings.Contains(subject, "didn’t finish") || strings.Contains(body, "javascript") {
		t.Fatalf("unsafe link kept: %s", body)
	}
}

func TestRunMailIsCappedPerHour(t *testing.T) {
	count := 0
	c := New(&core.Env{Now: time.Now})
	c.mailer = func(context.Context, string, string, string) error { count++; return nil }
	c.address = func(context.Context, int64) string { return "a@example.com" }
	r := router(c, 3)
	for i := 0; i < perHour+5; i++ {
		post(r, `{"task":"t","outcome":"completed"}`)
	}
	if count != perHour {
		t.Fatalf("sent %d", count)
	}
}
