//go:build unit

package service

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestUpstreamQuotaExhaustedError(t *testing.T) {
	for _, tc := range []struct {
		status int
		body   string
		want   bool
	}{
		{402, `{}`, true},
		{429, `{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}`, true},
		{403, `{"error":{"message":"用户额度不足, 剩余额度: $0.01"}}`, true},
		{403, `{"error":{"code":"INSUFFICIENT_BALANCE","message":"Insufficient account balance"}}`, true},
		{400, `{"error":{"message":"Your credit balance is too low to access the Anthropic API."}}`, true},
		{429, `{"error":{"message":"Rate limit reached for requests"}}`, false},
		{500, `{"error":{"message":"upstream timeout"}}`, false},
		{200, `余额不足`, false},
	} {
		require.Equal(t, tc.want, upstreamQuotaExhaustedError(tc.status, []byte(tc.body)), tc.body)
	}
}

func TestUpstreamQuotaAlertsOncePerInterval(t *testing.T) {
	var alerts upstreamQuotaAlerts
	now := time.Now()
	require.True(t, alerts.due(1, now))
	require.False(t, alerts.due(1, now.Add(time.Hour)))
	require.True(t, alerts.due(2, now.Add(time.Hour)))
	require.True(t, alerts.due(1, now.Add(upstreamQuotaAlertInterval+time.Minute)))
}
