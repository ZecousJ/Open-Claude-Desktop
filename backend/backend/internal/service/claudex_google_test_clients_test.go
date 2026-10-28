// CLAUDEX: file added by the Claudex fork (see backend/CLAUDEX_CHANGES.md).

package service

import (
	"os"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/pkg/antigravity"
	"github.com/Wei-Shaw/sub2api/internal/pkg/geminicli"
)

// The repository ships no built-in Google clients, so tests run with stand-in client ids.
func TestMain(m *testing.M) {
	geminicli.GeminiCLIOAuthClientID = "test-gemini-cli-client.apps.googleusercontent.com"
	antigravity.ClientID = "test-antigravity-client.apps.googleusercontent.com"
	os.Exit(m.Run())
}
