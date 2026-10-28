//go:build unit

package service

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestRefundMoneyText(t *testing.T) {
	require.Equal(t, "¥1.00", refundMoneyText(1, "CNY"))
	require.Equal(t, "$12.50", refundMoneyText(12.5, "USD"))
}

func TestRefundEmailTemplatesAreValid(t *testing.T) {
	for _, locale := range notificationEmailLocales {
		tmpl, ok := notificationEmailOfficialTemplates[NotificationEmailEventBalanceRefundSuccess][locale]
		require.True(t, ok, locale)
		require.NoError(t, validateNotificationEmailTemplate(NotificationEmailEventBalanceRefundSuccess, tmpl.Subject, tmpl.HTML), locale)
	}
	// Payment emails go out in Chinese.
	require.Equal(t, notificationEmailLocaleChinese, paymentEmailLocale)
}
