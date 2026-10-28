// CLAUDEX: file added by the Claudex fork (see backend/CLAUDEX_CHANGES.md).

package antigravity

import (
	"os"
	"testing"
)

// The repository ships no built-in Google client, so tests run with a stand-in one.
func TestMain(m *testing.M) {
	ClientID = "test-antigravity-client.apps.googleusercontent.com"
	defaultClientSecret = "test-antigravity-secret"
	os.Exit(m.Run())
}
