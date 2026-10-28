// CLAUDEX: Request-scoped group failover with one shared generation budget.
package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/pkg/requestbudget"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
)

const groupRequestWriterKey = "claudex.group_request_writer"

// Begin once at HTTP ingress, before body parsing, eligibility checks and queue
// waits. The same context follows every account attempt and protocol dispatch.
func beginGroupFailoverRequest(c *gin.Context) func() {
	return beginGroupFailoverRequestWithin(c, requestbudget.Total)
}

// beginGroupFailoverRequestWithin is beginGroupFailoverRequest with another
// budget (an image request's, requestbudget.ImagesTotal).
func beginGroupFailoverRequestWithin(c *gin.Context, total time.Duration) func() {
	if _, exists := requestbudget.Deadline(c.Request.Context()); exists {
		return func() {}
	}
	ctx, cancel := requestbudget.StartWithin(c.Request.Context(), total)
	c.Request = c.Request.WithContext(ctx)
	deadline, _ := requestbudget.Deadline(ctx)
	controller := http.NewResponseController(c.Writer)
	// Context cancellation alone cannot interrupt a slow upload. Gin exposes
	// Unwrap, allowing the HTTP server's connection/stream read deadline to apply.
	_ = controller.SetReadDeadline(deadline)
	body := c.Request.Body
	stopBody := context.AfterFunc(ctx, func() {
		if body != nil {
			_ = body.Close()
		}
	})
	writer := &groupBudgetWriter{ResponseWriter: c.Writer, ctx: ctx, path: c.Request.URL.Path,
		responseID: synthesizeResponseID(c)}
	c.Writer = writer
	c.Set(groupRequestWriterKey, writer)
	return func() {
		service.StopOpenAICompactSSEKeepaliveCommitted(c)
		// Headers and keepalive bytes alone are not a completed response.
		writer.finish()
		stopBody()
		_ = controller.SetReadDeadline(time.Time{})
		cancel()
	}
}

// The service may write its own 400/502 before returning a deadline error. This
// writer maps that first expired write to a timeout, without starting a second
// handler goroutine or racing an unsynchronized ResponseWriter.
type groupBudgetWriter struct {
	gin.ResponseWriter
	mu             sync.Mutex
	ctx            context.Context
	path           string
	responseID     string
	timedOut       bool
	payloadWritten bool
	terminal       bool
	sseBuffer      []byte
}

func (w *groupBudgetWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *groupBudgetWriter) timeoutLocked() bool {
	if w.timedOut {
		return true
	}
	if !requestbudget.Expired(w.ctx) {
		return false
	}
	w.timedOut = true
	if w.terminal {
		return true
	}
	errorObject := gin.H{"type": "timeout_error", "code": "request_timeout", "message": "Request timed out"}
	payload := gin.H{"error": errorObject}
	if strings.Contains(w.path, "/models/") {
		payload = gin.H{"error": gin.H{"code": http.StatusGatewayTimeout, "status": "DEADLINE_EXCEEDED", "message": "Request timed out"}}
	} else if strings.Contains(w.path, "/messages") {
		payload["type"] = "error"
	}
	data, _ := json.Marshal(payload)
	stream := w.Written() && strings.Contains(w.Header().Get("Content-Type"), "text/event-stream")
	if stream {
		if strings.HasSuffix(strings.TrimRight(w.path, "/"), "/responses") || strings.Contains(w.path, "/responses/") {
			data, _ = json.Marshal(responsesFailedEvent{Type: "response.failed", Response: responsesFailedBody{
				ID: w.responseID, Object: "response", CreatedAt: time.Now().Unix(), Status: "failed", Output: []any{},
				Error: responsesFailedError{Code: "request_timeout", Message: "Request timed out"},
			}})
			_, _ = fmt.Fprintf(w.ResponseWriter, "event: response.failed\ndata: %s\n\n", data)
		} else if strings.Contains(w.path, "/models/") {
			_, _ = fmt.Fprintf(w.ResponseWriter, "data: %s\n\n", data)
		} else {
			_, _ = fmt.Fprintf(w.ResponseWriter, "event: error\ndata: %s\n\n", data)
		}
		w.ResponseWriter.Flush()
	} else if !w.payloadWritten {
		w.Header().Del("Content-Length")
		w.Header().Set("Content-Type", "application/json")
		w.ResponseWriter.WriteHeader(http.StatusGatewayTimeout)
		_, _ = w.ResponseWriter.Write(data)
	}
	return true
}

func (w *groupBudgetWriter) WriteHeader(status int) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.timeoutLocked() {
		w.ResponseWriter.WriteHeader(status)
	}
}
func (w *groupBudgetWriter) WriteHeaderNow() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.timeoutLocked() {
		w.ResponseWriter.WriteHeaderNow()
	}
}
func (w *groupBudgetWriter) Write(data []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.timeoutLocked() {
		return 0, context.DeadlineExceeded
	}
	trimmed := bytes.TrimSpace(data)
	isStream := strings.Contains(w.Header().Get("Content-Type"), "text/event-stream")
	if len(trimmed) > 0 && (!isStream || !bytes.HasPrefix(trimmed, []byte(":")) && !bytes.HasPrefix(trimmed, []byte("event: ping"))) {
		if !w.payloadWritten {
			// Output has started: the answer is no longer timed, however long it runs.
			requestbudget.Disarm(w.ctx)
		}
		w.payloadWritten = true
	}
	w.observeTerminal(data)
	return w.ResponseWriter.Write(data)
}
func (w *groupBudgetWriter) WriteString(data string) (int, error) { return w.Write([]byte(data)) }
func (w *groupBudgetWriter) Flush() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.timeoutLocked() {
		w.ResponseWriter.Flush()
	}
}
func (w *groupBudgetWriter) finish() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.payloadWritten || (!w.terminal && strings.Contains(w.Header().Get("Content-Type"), "text/event-stream")) {
		w.timeoutLocked()
	}
}

// observeTerminal recognizes protocol frames rather than matching user text.
// Keeping only an unfinished SSE frame also supports split writes.
func (w *groupBudgetWriter) observeTerminal(data []byte) {
	if !strings.Contains(w.Header().Get("Content-Type"), "text/event-stream") {
		return
	}
	w.sseBuffer = append(w.sseBuffer, data...)
	w.sseBuffer = bytes.ReplaceAll(w.sseBuffer, []byte("\r\n"), []byte("\n"))
	for {
		end := bytes.Index(w.sseBuffer, []byte("\n\n"))
		if end < 0 {
			break
		}
		frame := w.sseBuffer[:end]
		w.sseBuffer = w.sseBuffer[end+2:]
		var payload []byte
		for _, line := range bytes.Split(frame, []byte("\n")) {
			if bytes.HasPrefix(line, []byte("data:")) {
				payload = append(payload, bytes.TrimSpace(line[5:])...)
			}
		}
		if bytes.Equal(payload, []byte("[DONE]")) {
			w.terminal = true
			continue
		}
		var event struct {
			Type       string          `json:"type"`
			Error      json.RawMessage `json:"error"`
			Candidates []struct {
				FinishReason string `json:"finishReason"`
			} `json:"candidates"`
		}
		if json.Unmarshal(payload, &event) != nil {
			continue
		}
		switch event.Type {
		case "response.completed", "response.failed", "response.incomplete", "response.cancelled", "message_stop", "error":
			w.terminal = true
		}
		if len(event.Error) > 0 && !bytes.Equal(bytes.TrimSpace(event.Error), []byte("null")) {
			w.terminal = true
		}

	}
	// A malformed/unbounded frame must not retain the whole generated response.
	if len(w.sseBuffer) > 1<<20 {
		w.sseBuffer = nil
	}
}

// All timeout exits use the same writer encoder, including service-level errors
// and a handler that returns after headers, keepalive, or partial SSE output.
func writeGroupRequestTimeout(c *gin.Context) bool {
	if c == nil || c.Request == nil || !requestbudget.Expired(c.Request.Context()) {
		return false
	}
	service.StopOpenAICompactSSEKeepaliveCommitted(c)
	if stored, ok := c.Get(groupRequestWriterKey); ok {
		if writer, ok := stored.(*groupBudgetWriter); ok {
			writer.mu.Lock()
			defer writer.mu.Unlock()
			writer.timeoutLocked()
			return true
		}
	}
	return false
}

// Gemini has no connection-level terminal frame: a candidate finishReason may
// precede other candidates. Only successful forward completion proves the entire
// response ended, so partial candidate output cannot suppress a deadline error.
func markGroupRequestSucceeded(c *gin.Context) {
	if stored, ok := c.Get(groupRequestWriterKey); ok {
		writer, ok := stored.(*groupBudgetWriter)
		if !ok {
			return
		}
		writer.mu.Lock()
		writer.terminal = true
		writer.mu.Unlock()
	}
}
