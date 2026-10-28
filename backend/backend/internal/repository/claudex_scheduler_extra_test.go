//go:build unit

package repository

import (
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/stretchr/testify/require"
)

// The scheduler picks drawing accounts on its projection, so the flag must
// survive the projection's key filter.
func TestSchedulerProjectionKeepsTheDrawingFlag(t *testing.T) {
	filtered := filterSchedulerExtra(map[string]any{
		service.CodexImageGenerationSupportedExtraKey: true,
		"unrelated": "dropped",
	})
	require.Equal(t, true, filtered[service.CodexImageGenerationSupportedExtraKey])
	require.NotContains(t, filtered, "unrelated")
}
