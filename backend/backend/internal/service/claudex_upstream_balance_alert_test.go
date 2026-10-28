//go:build unit

package service

import (
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestParseUpstreamWalletBalance(t *testing.T) {
	v, ok := parseUpstreamWalletBalance([]byte(`{"mode":"unrestricted","balance":15.21404957,"remaining":15.21404957}`))
	require.True(t, ok)
	require.InDelta(t, 15.214, v, 0.001)
	v, ok = parseUpstreamWalletBalance([]byte(`{"mode":"quota_limited","remaining":3.5}`))
	require.True(t, ok)
	require.InDelta(t, 3.5, v, 0.001)
	_, ok = parseUpstreamWalletBalance([]byte(`{"mode":"unrestricted"}`))
	require.False(t, ok)
	_, ok = parseUpstreamWalletBalance([]byte(`<html>`))
	require.False(t, ok)
}

func TestUpstreamBalanceAlertsOncePerHostUntilRefilled(t *testing.T) {
	var alerts upstreamBalanceAlerts
	now := time.Now()
	require.True(t, alerts.due("api.aijws.com", true, now))
	require.False(t, alerts.due("api.aijws.com", true, now.Add(time.Hour)), "same host within 12 hours")
	require.True(t, alerts.due("gptpro.live", true, now.Add(time.Hour)), "another host")
	require.False(t, alerts.due("api.aijws.com", false, now.Add(2*time.Hour)), "refilled")
	require.True(t, alerts.due("api.aijws.com", true, now.Add(3*time.Hour)), "low again after a refill")
	require.True(t, alerts.due("gptpro.live", true, now.Add(14*time.Hour)), "still low after 12 hours")
}

func TestUpstreamBalanceAlertEmail(t *testing.T) {
	subject, body := upstreamBalanceAlertEmail("api.aijws.com", "aijws <x>", "openai", 9.5, 10, "https://claudex.example.com", time.Now())
	require.Contains(t, subject, "api.aijws.com $9.50")
	require.NotContains(t, subject, "\n")
	require.Contains(t, body, "$9.50")
	require.Contains(t, body, "$10.00")
	require.Contains(t, body, "aijws &lt;x&gt;")
	require.False(t, strings.Contains(body, "aijws <x>"))
}
