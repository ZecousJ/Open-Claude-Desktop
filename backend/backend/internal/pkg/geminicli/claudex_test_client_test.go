// CLAUDEX: file added by the Claudex fork (see backend/CLAUDEX_CHANGES.md).

package geminicli

import (
	"os"
	"testing"
)

// The repository ships no built-in Google client, so tests run with a stand-in client id.
func TestMain(m *testing.M) {
	GeminiCLIOAuthClientID = "test-gemini-cli-client.apps.googleusercontent.com"
	os.Exit(m.Run())
}
