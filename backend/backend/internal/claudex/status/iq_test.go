package status

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestExtractHTML(t *testing.T) {
	doc := "<!DOCTYPE html>\n<html><body><svg><circle r=\"4\"/></svg></body></html>"
	// A fenced document wins over words around it.
	require.Equal(t, doc, ExtractHTML("好的，这是页面：\n```html\n"+doc+"\n```\n希望你喜欢。"))
	// No fence: the document in the text.
	require.Equal(t, doc, ExtractHTML("Here it is:\n"+doc+"\nEnjoy"))
	// A fence that is not a page is passed over.
	require.Equal(t, doc, ExtractHTML("```css\nbody{}\n```\n```html\n"+doc+"\n```"))
	// A bare SVG is put in a page.
	page := ExtractHTML("```svg\n<svg viewBox=\"0 0 10 10\"></svg>\n```")
	require.True(t, strings.HasPrefix(page, "<svg") || strings.Contains(page, "<body"), page)
	require.Contains(t, ExtractHTML("<svg viewBox=\"0 0 10 10\"></svg>"), "<!doctype html>")
	require.Empty(t, ExtractHTML("I can't do that."))
	require.Empty(t, ExtractHTML("<html>"+strings.Repeat("x", iqHTMLBytes)+"</html>"))
}

func TestReadResponsesText(t *testing.T) {
	stream := strings.Join([]string{
		`event: response.created`,
		`data: {"type":"response.created"}`,
		``,
		`data: {"type":"response.output_text.delta","delta":"<html>"}`,
		`data: {"type":"response.output_text.delta","delta":"</html>"}`,
		`data: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"<html></html>"}]}]}}`,
		`data: [DONE]`,
	}, "\n")
	text, err := ReadResponsesText(strings.NewReader(stream))
	require.NoError(t, err)
	require.Equal(t, "<html></html>", text)

	// Only the completed response: its message.
	text, err = ReadResponsesText(strings.NewReader(`data: {"type":"response.completed","response":{"output":[{"type":"reasoning","content":[]},{"type":"message","content":[{"type":"output_text","text":"done"}]}]}}`))
	require.NoError(t, err)
	require.Equal(t, "done", text)

	_, err = ReadResponsesText(strings.NewReader(`data: {"type":"response.failed","response":{"error":{"message":"model overloaded"}}}`))
	require.ErrorContains(t, err, "model overloaded")
}

func TestIQExamplesAreEmbedded(t *testing.T) {
	examples := IQExamples()
	require.Len(t, examples, 2)
	require.Equal(t, "normal", examples[0].Kind)
	require.Equal(t, "gpt-6-astra", examples[0].Model)
	require.Equal(t, "degraded", examples[1].Kind)
	for _, e := range examples {
		require.Contains(t, strings.ToLower(e.HTML), "<svg")
		require.Less(t, len(e.HTML), iqHTMLBytes)
	}
}

func TestIQAskRetriesUntilAPage(t *testing.T) {
	var calls atomic.Int32
	var broken atomic.Bool
	page := `data: {"type":"response.output_text.delta","delta":"<html><body>ok</body></html>"}` + "\n\ndata: [DONE]\n\n"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)
		if broken.Load() {
			http.Error(w, "upstream busy", http.StatusBadGateway)
			return
		}
		switch n {
		case 1:
			http.Error(w, "upstream busy", http.StatusBadGateway)
		case 2:
			_, _ = io.WriteString(w, `data: {"type":"response.output_text.delta","delta":"Sorry, no page."}`+"\n\n")
		default:
			_, _ = io.WriteString(w, page)
		}
	}))
	defer server.Close()
	t.Setenv("CLAUDEX_STATUS_IQ_GATEWAY", server.URL)
	t.Setenv("CLAUDEX_STATUS_IQ_KEY", "k")
	c := &Component{}

	html, err := c.iqAskRetrying(context.Background(), iqGroups[0], time.Millisecond)
	require.NoError(t, err)
	require.Contains(t, html, "<body>ok</body>")
	require.EqualValues(t, 3, calls.Load())

	// Never a page: the error says how many times it asked.
	broken.Store(true)
	calls.Store(0)
	_, err = c.iqAskRetrying(context.Background(), iqGroups[0], time.Millisecond)
	require.ErrorContains(t, err, "3 attempts")
	require.EqualValues(t, 3, calls.Load())
}
