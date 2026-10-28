package service

// Claudex: an email when an upstream says an account's quota or balance is
// used up (owner, 2026-10-03). Every upstream error passes through
// RateLimitService.HandleUpstreamError; the ones that read as "out of quota"
// (402, or the words providers and relays use for it) send one email to the
// addresses in the setting claudex_upstream_quota_alert_emails (comma or
// space separated), at most once per account every six hours.

import (
	"context"
	"fmt"
	"html"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
)

// SettingKeyClaudexUpstreamQuotaAlertEmails lists who is told.
const SettingKeyClaudexUpstreamQuotaAlertEmails = "claudex_upstream_quota_alert_emails"

// upstreamQuotaAlertInterval is how long one account stays quiet after an email.
const upstreamQuotaAlertInterval = 6 * time.Hour

// What reads as an exhausted quota or balance (not a rate limit).
var upstreamQuotaExhausted = regexp.MustCompile(`(?i)insufficient[_ ]quota|insufficient[_ ](user[_ ])?quota|insufficient[_ ](account[_ ])?balance|exceeded your current quota|credit balance is too low|quota (is )?not enough|not enough quota|quota[_ ]exhausted|billing[_ ]hard[_ ]limit|余额不足|额度不足|额度已用尽|额度用尽|配额不足|欠费`)

// upstreamQuotaExhaustedError reports whether an upstream error says the
// account's quota or balance is used up.
func upstreamQuotaExhaustedError(statusCode int, body []byte) bool {
	if statusCode == http.StatusPaymentRequired {
		return true
	}
	if statusCode < 400 || len(body) == 0 {
		return false
	}
	text := body
	if len(text) > 16*1024 {
		text = text[:16*1024]
	}
	return upstreamQuotaExhausted.Match(text)
}

// upstreamQuotaAlerts remembers when each account was last reported.
type upstreamQuotaAlerts struct {
	mu   sync.Mutex
	last map[int64]time.Time
}

// due marks the account reported now, unless it was within the interval.
func (a *upstreamQuotaAlerts) due(accountID int64, now time.Time) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.last == nil {
		a.last = map[int64]time.Time{}
	}
	if at, ok := a.last[accountID]; ok && now.Sub(at) < upstreamQuotaAlertInterval {
		return false
	}
	a.last[accountID] = now
	return true
}

// SetEmailService sets the mail sender for upstream quota alerts (optional).
func (s *RateLimitService) SetEmailService(emailService *EmailService) {
	s.emailService = emailService
}

// alertUpstreamQuotaExhausted emails the configured addresses when the error
// says the account is out of quota; never blocks the request.
func (s *RateLimitService) alertUpstreamQuotaExhausted(account *Account, statusCode int, body []byte) {
	if s == nil || account == nil || s.emailService == nil || s.settingService == nil || s.settingService.settingRepo == nil {
		return
	}
	if !upstreamQuotaExhaustedError(statusCode, body) {
		return
	}
	if !s.upstreamQuotaAlerts.due(account.ID, time.Now()) {
		return
	}
	message := extractUpstreamErrorMessage(body)
	if message == "" {
		message = string(body)
	}
	message = sanitizeUpstreamErrorMessage(strings.TrimSpace(message))
	if r := []rune(message); len(r) > 500 {
		message = string(r[:500]) + "…"
	}
	accountID, name, platform := account.ID, account.Name, account.Platform
	go func() {
		defer func() {
			if r := recover(); r != nil {
				slog.Error("panic in upstream quota alert", "recover", r)
			}
		}()
		repo := s.settingService.settingRepo
		raw, err := repo.GetValue(context.Background(), SettingKeyClaudexUpstreamQuotaAlertEmails)
		if err != nil {
			return
		}
		recipients := strings.FieldsFunc(raw, func(r rune) bool {
			return r == ',' || r == ';' || r == ' ' || r == '\n' || r == '\t'
		})
		if len(recipients) == 0 {
			return
		}
		siteURL := ""
		for _, key := range []string{SettingKeyAPIBaseURL, SettingKeyFrontendURL} {
			if value, err := repo.GetValue(context.Background(), key); err == nil && strings.TrimSpace(value) != "" {
				siteURL = strings.TrimRight(strings.TrimSpace(value), "/")
				break
			}
		}
		subject := sanitizeEmailHeader(fmt.Sprintf("[%s] 上游额度不足 / Upstream out of quota - %s", defaultSiteName, name))
		content := `<p>上游报告该账号额度或余额不足，请及时充值或调整渠道。同一账号 6 小时内只提醒一次。<br><span style="color:#6b6a65;">An upstream reported that this account is out of quota or balance.</span></p>
` + emailRows([][2]string{
			{"账号 ID / Account ID", fmt.Sprintf("#%d", accountID)},
			{"账号 / Account", html.EscapeString(name)},
			{"平台 / Platform", html.EscapeString(platform)},
			{"状态码 / Status", fmt.Sprintf("%d", statusCode)},
			{"上游消息 / Message", html.EscapeString(message)},
			{"时间 / Time", time.Now().Format("2006-01-02 15:04:05 MST")},
		})
		body := ClaudexEmailHTML(ClaudexEmailLayout{
			SiteName: defaultSiteName,
			SiteURL:  html.EscapeString(siteURL),
			Title:    "上游额度不足 / Upstream out of quota",
			Accent:   EmailAccentDanger,
			Content:  content,
		})
		for _, to := range recipients {
			ctx, cancel := context.WithTimeout(context.Background(), emailSendTimeout)
			if err := s.emailService.SendEmail(ctx, to, subject, body); err != nil {
				slog.Error("upstream quota alert not sent", "to", to, "account_id", accountID, "error", err)
			} else {
				slog.Info("upstream quota alert sent", "to", to, "account_id", accountID)
			}
			cancel()
		}
	}()
}
