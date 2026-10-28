package policy

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestDeveloperModePolicy(t *testing.T) {
	patch, err := ParsePatch(json.RawMessage(`{"developer_mode_enabled":false}`), "defaults")
	require.NoError(t, err)
	require.NotNil(t, patch.DeveloperModeEnabled)
	require.False(t, *patch.DeveloperModeEnabled)
	document := doc(t, `{"defaults":{"developer_mode_enabled":false},"user_overrides":{"1":{"developer_mode_enabled":true}}}`)
	require.False(t, document.Resolve(nil, 2, "darwin", Fallbacks{}).DeveloperModeEnabled)
	require.True(t, document.Resolve(nil, 1, "darwin", Fallbacks{}).DeveloperModeEnabled)
	_, err = ParsePatch(json.RawMessage(`{"developer_mode_enabled":"false"}`), "defaults")
	require.Error(t, err)
}

func TestManagedDeviceExtensionsPolicy(t *testing.T) {
	document := doc(t, `{"defaults":{"desktop_extensions_enabled":false,"developer_mcp_enabled":false},"user_overrides":{"1":{"developer_mcp_enabled":true}}}`)
	managed := document.Resolve(nil, 2, "darwin", Fallbacks{})
	require.False(t, managed.DesktopExtensionsEnabled)
	require.False(t, managed.DeveloperMCPEnabled)
	require.True(t, document.Resolve(nil, 1, "darwin", Fallbacks{}).DeveloperMCPEnabled)
	_, err := ParsePatch(json.RawMessage(`{"desktop_extensions_enabled":"false"}`), "defaults")
	require.Error(t, err)
}
