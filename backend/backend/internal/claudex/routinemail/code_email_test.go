package routinemail

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
)

func codePost(c *Component, user int64, body string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/claudex/code/email", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	router(c, user).ServeHTTP(w, req)
	return w
}

func TestCodeEmailOwnCloudPreferenceAndAddress(t *testing.T) {
	c := New(&core.Env{})
	var sent []mail
	enabled := true
	c.address = func(_ context.Context, user int64) string {
		return fmt.Sprintf("owner%d@example.test", user)
	}
	c.codeState = func(_ context.Context, user int64, conversation string) (bool, string, error) {
		return enabled && user == 7 && conversation == "owned", "My <Code> session\r\nHeader", nil
	}
	c.mailer = func(_ context.Context, to, subject, body string) error {
		sent = append(sent, mail{to, subject, body})
		return nil
	}
	input := `{"conversationId":"owned","eventId":"turn:1","outcome":"completed","to":"other@example.test","title":"arbitrary"}`
	for _, user := range []int64{7, 7, 8} {
		if w := codePost(c, user, input); w.Code != http.StatusOK {
			t.Fatal(w.Body.String())
		}
	}
	if len(sent) != 1 || sent[0].to != "owner7@example.test" || strings.Contains(sent[0].subject, "\n") || strings.Contains(sent[0].body, "<Code>") || strings.Contains(sent[0].body, "arbitrary") {
		t.Fatalf("unexpected messages: %+v", sent)
	}
	if w := codePost(c, 7, `{"conversationId":"another","eventId":"approval:2","outcome":"needs_attention"}`); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"sent":false`) {
		t.Fatal(w.Body.String())
	}
	enabled = false
	codePost(c, 7, `{"conversationId":"owned","eventId":"turn:2","outcome":"failed"}`)
	if len(sent) != 1 {
		t.Fatal("disabled preference sent mail")
	}
	if w := codePost(c, 0, input); w.Code != http.StatusUnauthorized {
		t.Fatal(w.Code)
	}
	if w := codePost(c, 7, `{"conversationId":"owned","eventId":"turn:2","outcome":"deleted"}`); w.Code != http.StatusBadRequest {
		t.Fatal(w.Code)
	}
}

func TestCodeEmailStatusFailuresAndHourlyCap(t *testing.T) {
	c := New(&core.Env{})
	c.address = func(context.Context, int64) string { return "owner@example.test" }
	c.codeState = func(context.Context, int64, string) (bool, string, error) { return true, "Task", nil }
	failed := true
	count := 0
	c.mailer = func(context.Context, string, string, string) error {
		if failed {
			return errors.New("SMTP error")
		}
		count++
		return nil
	}
	w := httptest.NewRecorder()
	router(c, 7).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/claudex/code/email", nil))
	if !strings.Contains(w.Body.String(), `"available":true`) {
		t.Fatal(w.Body.String())
	}
	input := `{"conversationId":"owned","eventId":"turn:1","outcome":"completed"}`
	if w := codePost(c, 7, input); w.Code != http.StatusServiceUnavailable {
		t.Fatal(w.Code)
	}
	failed = false
	if w := codePost(c, 7, input); !strings.Contains(w.Body.String(), `"sent":true`) {
		t.Fatal(w.Body.String())
	}
	for i := 2; i <= perHour+5; i++ {
		codePost(c, 7, fmt.Sprintf(`{"conversationId":"owned","eventId":"turn:%d","outcome":"failed"}`, i))
	}
	if count != perHour-1 || len(c.codeSent) > perHour {
		t.Fatalf("unbounded email: sent=%d tracked=%d", count, len(c.codeSent))
	}
	c.codeState = func(context.Context, int64, string) (bool, string, error) { return false, "", errors.New("DB failed") }
	if w := codePost(c, 7, input); w.Code != http.StatusServiceUnavailable {
		t.Fatal(w.Code)
	}
	c.address = func(context.Context, int64) string { return "" }
	w = httptest.NewRecorder()
	router(c, 7).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/claudex/code/email", nil))
	if !strings.Contains(w.Body.String(), `"available":false`) {
		t.Fatal(w.Body.String())
	}
}
