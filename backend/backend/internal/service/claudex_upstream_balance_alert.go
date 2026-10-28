package service

// Claudex: an email when an upstream's wallet runs low (owner, 2026-10-03).
// Each billing probe of a Sub2API upstream also reads the key's /v1/usage,
// whose "balance" is the upstream wallet; the value is kept in the probe's
// snapshot (wallet_balance). Below the setting
// claudex_upstream_balance_alert_threshold (USD, 10 when unset) the
// addresses in claudex_upstream_quota_alert_emails get one email per upstream
// host every twelve hours while it stays low; a balance back above the
// threshold rearms the host.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/pkg/tlsfingerprint"
)

// SettingKeyClaudexUpstreamBalanceAlertThreshold is the wallet balance (USD)
// below which an upstream is reported.
const SettingKeyClaudexUpstreamBalanceAlertThreshold = "claudex_upstream_balance_alert_threshold"

const (
	defaultUpstreamBalanceAlertThreshold = 10.0
	upstreamBalanceAlertInterval         = 12 * time.Hour
	upstreamBalanceWalletKey             = "wallet_balance"
)

// upstreamBalanceAlerts remembers, per upstream host, when it was reported.
type upstreamBalanceAlerts struct {
	mu   sync.Mutex
	last map[string]time.Time
}

// due reports whether the host should be reported now; a balance at or above
// the threshold forgets the host so the next drop is reported at once.
func (a *upstreamBalanceAlerts) due(host string, low bool, now time.Time) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.last == nil {
		a.last = map[string]time.Time{}
	}
	if !low {
		delete(a.last, host)
		return false
	}
	if at, ok := a.last[host]; ok && now.Sub(at) < upstreamBalanceAlertInterval {
		return false
	}
	a.last[host] = now
	return true
}

// SetEmailService sets the mail sender for low-balance alerts (optional).
func (s *UpstreamBillingProbeService) SetEmailService(emailService *EmailService) {
	s.emailService = emailService
}

// readUpstreamWalletBalance reads the key's wallet balance from the upstream
// Sub2API's /v1/usage ("balance", else the key's "remaining").
func (s *UpstreamBillingProbeService) readUpstreamWalletBalance(ctx context.Context, account *Account, baseURL, apiKey, proxyURL string, tlsProfile *tlsfingerprint.Profile) (float64, bool) {
	reqCtx, cancel := context.WithTimeout(ctx, upstreamBillingProbeRequestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, buildOpenAIEndpointURL(baseURL, "/v1/usage"), bytes.NewReader(nil))
	if err != nil {
		return 0, false
	}
	profile := HTTPUpstreamProfileDefault
	if account.Platform == PlatformOpenAI {
		profile = HTTPUpstreamProfileOpenAI
	}
	req = req.WithContext(WithHTTPUpstreamRedirectsDisabled(WithHTTPUpstreamProfile(req.Context(), profile)))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)
	account.ApplyHeaderOverrides(req.Header)
	resp, err := s.accountTestService.httpUpstream.DoWithTLS(req, proxyURL, account.ID, account.Concurrency, tlsProfile)
	if err != nil || resp == nil || resp.Body == nil {
		return 0, false
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return 0, false
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, upstreamBillingProbeMaxBodyBytes))
	if err != nil {
		return 0, false
	}
	return parseUpstreamWalletBalance(body)
}

// parseUpstreamWalletBalance reads "balance" (else "remaining") from a
// Sub2API /v1/usage answer.
func parseUpstreamWalletBalance(body []byte) (float64, bool) {
	var payload map[string]any
	if json.Unmarshal(body, &payload) != nil {
		return 0, false
	}
	for _, key := range []string{"balance", "remaining"} {
		if v, ok := payload[key].(float64); ok {
			return v, true
		}
	}
	return 0, false
}

// upstreamBalanceAlertThreshold is the configured threshold, 10 when unset.
func (s *UpstreamBillingProbeService) upstreamBalanceAlertThreshold(ctx context.Context) float64 {
	if s.settingService == nil || s.settingService.settingRepo == nil {
		return defaultUpstreamBalanceAlertThreshold
	}
	raw, err := s.settingService.settingRepo.GetValue(ctx, SettingKeyClaudexUpstreamBalanceAlertThreshold)
	if err != nil {
		return defaultUpstreamBalanceAlertThreshold
	}
	v, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
	if err != nil || v < 0 {
		return defaultUpstreamBalanceAlertThreshold
	}
	return v
}

// checkUpstreamBalance emails when the wallet is below the threshold; never
// blocks the probe.
func (s *UpstreamBillingProbeService) checkUpstreamBalance(ctx context.Context, account *Account, baseURL string, balance float64) {
	if s == nil || account == nil {
		return
	}
	threshold := s.upstreamBalanceAlertThreshold(ctx)
	host := baseURL
	if u, err := url.Parse(baseURL); err == nil && u.Host != "" {
		host = u.Host
	}
	if !s.balanceAlerts.due(host, balance < threshold, s.currentTime()) {
		return
	}
	if s.emailService == nil || s.settingService == nil || s.settingService.settingRepo == nil {
		return
	}
	name, platform := account.Name, account.Platform
	go func() {
		defer func() {
			if r := recover(); r != nil {
				slog.Error("panic in upstream balance alert", "recover", r)
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
		subject, body := upstreamBalanceAlertEmail(host, name, platform, balance, threshold, siteURL, time.Now())
		for _, to := range recipients {
			sendCtx, cancel := context.WithTimeout(context.Background(), emailSendTimeout)
			if err := s.emailService.SendEmail(sendCtx, to, subject, body); err != nil {
				slog.Error("upstream balance alert not sent", "to", to, "host", host, "error", err)
			} else {
				slog.Info("upstream balance alert sent", "to", to, "host", host)
			}
			cancel()
		}
	}()
}

// upstreamBalanceAlertEmail is the alert's subject and HTML body.
func upstreamBalanceAlertEmail(host, accountName, platform string, balance, threshold float64, siteURL string, at time.Time) (string, string) {
	subject := sanitizeEmailHeader(fmt.Sprintf("[%s] 上游余额不足 / Upstream balance low - %s $%.2f", defaultSiteName, host, balance))
	content := fmt.Sprintf(`<p>上游钱包余额已低于 $%.2f，请及时充值，以免请求失败。余额低于阈值期间，同一上游每 12 小时提醒一次。<br><span style="color:#6b6a65;">An upstream wallet is below the alert threshold.</span></p>
`, threshold) + emailRows([][2]string{
		{"上游 / Upstream", html.EscapeString(host)},
		{"余额 / Balance", fmt.Sprintf("$%.2f", balance)},
		{"提醒阈值 / Threshold", fmt.Sprintf("$%.2f", threshold)},
		{"检测账号 / Account", html.EscapeString(accountName) + " (" + html.EscapeString(platform) + ")"},
		{"时间 / Time", at.Format("2006-01-02 15:04:05 MST")},
	})
	body := ClaudexEmailHTML(ClaudexEmailLayout{
		SiteName: defaultSiteName,
		SiteURL:  html.EscapeString(siteURL),
		Title:    "上游余额不足 / Upstream balance low",
		Accent:   EmailAccentDanger,
		Content:  content,
	})
	return subject, body
}
