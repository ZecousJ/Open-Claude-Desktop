package policy

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestScheduledApprovalLifetime(t *testing.T) {
	patch, err := ParsePatch(json.RawMessage(`{"scheduled_tasks":{"approval_lifetime_days":7}}`), "defaults")
	require.NoError(t, err)
	require.Equal(t, Some(7), patch.ScheduledTasks.ApprovalLifetimeDays)
	document := doc(t, `{"defaults":{"scheduled_tasks":{"enabled":false,"max_tasks":3,"approval_lifetime_days":7}},"user_overrides":{"1":{"scheduled_tasks":{"approval_lifetime_days":0}},"2":{"scheduled_tasks":{"approval_lifetime_days":null}}}}`)
	resolved := document.Resolve(nil, 1, "darwin", Fallbacks{})
	require.Equal(t, 0, *resolved.ScheduledTasks.ApprovalLifetimeDays)
	require.False(t, resolved.ScheduledTasks.Enabled)
	require.Equal(t, 3, *resolved.ScheduledTasks.MaxTasks)
	require.Nil(t, document.Resolve(nil, 2, "darwin", Fallbacks{}).ScheduledTasks.ApprovalLifetimeDays)
	for _, value := range []string{"-1", "1.5", "36501", `"7"`, "true"} {
		_, err := ParsePatch(json.RawMessage(`{"scheduled_tasks":{"approval_lifetime_days":`+value+`}}`), "defaults")
		require.Error(t, err)
	}
}
