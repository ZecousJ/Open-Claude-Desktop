package memory

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestCoworkInputValidation(t *testing.T) {
	for _, key := range []string{"MEMORY.md", "work.md", "category/file.MD"} {
		require.True(t, validCoworkKey(key), key)
	}
	for _, key := range []string{"../a.md", "/a.md", "a/../b.md", "a\\b.md", "*.md", "file.txt", "x\x00.md"} {
		require.False(t, validCoworkKey(key), key)
	}
	for _, body := range []string{`null`, `{"expected_epoch":"0","entries":{"x.md":null}}`, `{"expected_epoch":"0","delete_keys":[null]}`, `{"expected_epoch":"0","entries":null}`, `{"expected_epoch":"0","unknown":true}`, "{\"expected_epoch\":\"0\",\"entries\":{\"x.md\":\"\xff\"}}"} {
		g, _ := gin.CreateTestContext(httptest.NewRecorder())
		g.Request = httptest.NewRequest("PUT", "/", strings.NewReader(body))
		var parsed coworkChange
		require.Error(t, readCoworkJSON(g, &parsed), body)
	}
	g, _ := gin.CreateTestContext(httptest.NewRecorder())
	g.Request = httptest.NewRequest("PUT", "/", strings.NewReader(`{"expected_epoch":"0","entries":{"MEMORY.md":"index"},"delete_keys":["x.md"]}`))
	var parsed coworkChange
	require.NoError(t, readCoworkJSON(g, &parsed))
	require.Equal(t, "index", parsed.Entries["MEMORY.md"])
	for _, token := range []string{"0", "1", "9223372036854775807"} {
		require.True(t, validCoworkToken(&token))
	}
	for _, token := range []string{"", "00", "-1", "9223372036854775808"} {
		require.False(t, validCoworkToken(&token))
	}
}
