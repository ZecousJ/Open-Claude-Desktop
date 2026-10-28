package service

import (
	"context"
	"fmt"
	"html"
	"log/slog"
	"strconv"
	"strings"
	"time"
)

const (
	emailSendTimeout = 30 * time.Second

	// Threshold type values
	thresholdTypeFixed      = "fixed"
	thresholdTypePercentage = "percentage"

	// Quota dimension labels
	quotaDimDaily  = "daily"
	quotaDimWeekly = "weekly"
	quotaDimTotal  = "total"

	defaultSiteName = "Claudex"
)

// quotaDimLabels maps dimension names to display labels.
var quotaDimLabels = map[string]string{
	quotaDimDaily:  "日限额 / Daily",
	quotaDimWeekly: "周限额 / Weekly",
	quotaDimTotal:  "总限额 / Total",
}

// AccountQuotaReader provides read access to account quota data.
type AccountQuotaReader interface {
	GetByID(ctx context.Context, id int64) (*Account, error)
}

// BalanceNotifyService handles balance and quota threshold notifications.
type BalanceNotifyService struct {
	emailService             *EmailService
	settingRepo              SettingRepository
	accountRepo              AccountQuotaReader
	notificationEmailService *NotificationEmailService
}

// NewBalanceNotifyService creates a new BalanceNotifyService.
func NewBalanceNotifyService(emailService *EmailService, settingRepo SettingRepository, accountRepo AccountQuotaReader) *BalanceNotifyService {
	return &BalanceNotifyService{
		emailService: emailService,
		settingRepo:  settingRepo,
		accountRepo:  accountRepo,
	}
}

func (s *BalanceNotifyService) SetNotificationEmailService(notificationEmailService *NotificationEmailService) {
	s.notificationEmailService = notificationEmailService
}

// resolveBalanceThreshold returns the effective balance threshold.
// For percentage type, it computes threshold = totalRecharged * percentage / 100.
func resolveBalanceThreshold(threshold float64, thresholdType string, totalRecharged float64) float64 {
	if thresholdType == thresholdTypePercentage && totalRecharged > 0 {
		return totalRecharged * threshold / 100
	}
	return threshold
}

// CheckBalanceAfterDeduction checks if balance crossed below threshold after deduction.
// Notification is sent only on first crossing: oldBalance >= threshold && newBalance < threshold.
func (s *BalanceNotifyService) CheckBalanceAfterDeduction(ctx context.Context, user *User, oldBalance, cost float64) {
	if !s.canNotifyBalance(user) {
		return
	}
	effectiveThreshold, rechargeURL, ok := s.resolveUserEffectiveThreshold(ctx, user)
	if !ok {
		return
	}
	newBalance := oldBalance - cost
	if !crossedDownward(oldBalance, newBalance, effectiveThreshold) {
		return
	}
	s.dispatchBalanceLowEmail(ctx, user, newBalance, effectiveThreshold, rechargeURL)
}

// canNotifyBalance checks nil guards and user-level toggle.
func (s *BalanceNotifyService) canNotifyBalance(user *User) bool {
	if user == nil || s.emailService == nil || s.settingRepo == nil {
		return false
	}
	return user.BalanceNotifyEnabled
}

// resolveUserEffectiveThreshold reads global + user config, returns the effective threshold.
// Returns ok=false when notifications should be skipped.
func (s *BalanceNotifyService) resolveUserEffectiveThreshold(ctx context.Context, user *User) (effectiveThreshold float64, rechargeURL string, ok bool) {
	globalEnabled, globalThreshold, rechargeURL := s.getBalanceNotifyConfig(ctx)
	if !globalEnabled {
		return 0, "", false
	}
	threshold := globalThreshold
	if user.BalanceNotifyThreshold != nil {
		threshold = *user.BalanceNotifyThreshold
	}
	if threshold <= 0 {
		return 0, "", false
	}
	effectiveThreshold = resolveBalanceThreshold(threshold, user.BalanceNotifyThresholdType, user.TotalRecharged)
	if effectiveThreshold <= 0 {
		return 0, "", false
	}
	return effectiveThreshold, rechargeURL, true
}

// crossedDownward returns true when oldV was at-or-above threshold but newV dropped below it.
func crossedDownward(oldV, newV, threshold float64) bool {
	return oldV >= threshold && newV < threshold
}

// dispatchBalanceLowEmail collects recipients and sends the alert in a goroutine.
func (s *BalanceNotifyService) dispatchBalanceLowEmail(ctx context.Context, user *User, newBalance, threshold float64, rechargeURL string) {
	siteName := s.getSiteName(ctx)
	recipients := s.collectBalanceNotifyRecipients(user)
	slog.Info("CheckBalanceAfterDeduction: sending notification",
		"user_id", user.ID, "recipients", recipients, "new_balance", newBalance, "threshold", threshold)
	go func() {
		defer func() {
			if r := recover(); r != nil {
				slog.Error("panic in balance notification", "recover", r)
			}
		}()
		s.sendBalanceLowEmails(recipients, user.ID, user.Username, user.Email, newBalance, threshold, siteName, rechargeURL)
	}()
}

// quotaDim describes one quota dimension for notification checking.
type quotaDim struct {
	name          string
	enabled       bool
	threshold     float64
	thresholdType string // "fixed" (default) or "percentage"
	currentUsed   float64
	limit         float64
}

// resolvedThreshold converts the user-facing "remaining" threshold into a usage-based trigger point.
// The threshold represents how much quota REMAINS when the alert fires:
//   - Fixed ($): threshold=400, limit=1000 → fires when usage reaches 600 (remaining drops to 400)
//   - Percentage (%): threshold=30, limit=1000 → fires when usage reaches 700 (remaining drops to 30%)
func (d quotaDim) resolvedThreshold() float64 {
	if d.limit <= 0 {
		return 0
	}
	if d.thresholdType == thresholdTypePercentage {
		return d.limit * (1 - d.threshold/100)
	}
	return d.limit - d.threshold
}

// buildQuotaDims returns the three quota dimensions for notification checking.
func buildQuotaDims(account *Account) []quotaDim {
	return []quotaDim{
		{quotaDimDaily, account.GetQuotaNotifyDailyEnabled(), account.GetQuotaNotifyDailyThreshold(), account.GetQuotaNotifyDailyThresholdType(), account.GetQuotaDailyUsed(), account.GetQuotaDailyLimit()},
		{quotaDimWeekly, account.GetQuotaNotifyWeeklyEnabled(), account.GetQuotaNotifyWeeklyThreshold(), account.GetQuotaNotifyWeeklyThresholdType(), account.GetQuotaWeeklyUsed(), account.GetQuotaWeeklyLimit()},
		{quotaDimTotal, account.GetQuotaNotifyTotalEnabled(), account.GetQuotaNotifyTotalThreshold(), account.GetQuotaNotifyTotalThresholdType(), account.GetQuotaUsed(), account.GetQuotaLimit()},
	}
}

// buildQuotaDimsFromState builds quota dimensions using DB transaction state instead of account snapshot.
// Notification settings (enabled, threshold, thresholdType) come from the account; usage values from quotaState.
func buildQuotaDimsFromState(account *Account, state *AccountQuotaState) []quotaDim {
	return []quotaDim{
		{quotaDimDaily, account.GetQuotaNotifyDailyEnabled(), account.GetQuotaNotifyDailyThreshold(), account.GetQuotaNotifyDailyThresholdType(), state.DailyUsed, state.DailyLimit},
		{quotaDimWeekly, account.GetQuotaNotifyWeeklyEnabled(), account.GetQuotaNotifyWeeklyThreshold(), account.GetQuotaNotifyWeeklyThresholdType(), state.WeeklyUsed, state.WeeklyLimit},
		{quotaDimTotal, account.GetQuotaNotifyTotalEnabled(), account.GetQuotaNotifyTotalThreshold(), account.GetQuotaNotifyTotalThresholdType(), state.TotalUsed, state.TotalLimit},
	}
}

// CheckAccountQuotaAfterIncrement checks if any quota dimension crossed above its notify threshold.
// When quotaState is non-nil (from DB transaction RETURNING), it is used directly for threshold
// checking, avoiding a separate DB read. Otherwise it falls back to fetching fresh account data.
func (s *BalanceNotifyService) CheckAccountQuotaAfterIncrement(ctx context.Context, account *Account, cost float64, quotaState *AccountQuotaState) {
	if account == nil || s.emailService == nil || s.settingRepo == nil || cost <= 0 {
		return
	}
	if !s.isAccountQuotaNotifyEnabled(ctx) {
		return
	}
	adminEmails := s.getAccountQuotaNotifyEmails(ctx)
	if len(adminEmails) == 0 {
		return
	}

	siteName := s.getSiteName(ctx)
	var dims []quotaDim
	if quotaState != nil {
		dims = buildQuotaDimsFromState(account, quotaState)
	} else {
		freshAccount := s.fetchFreshAccount(ctx, account)
		dims = buildQuotaDims(freshAccount)
		account = freshAccount // use fresh data for alert metadata
	}
	s.checkQuotaDimCrossings(account, dims, cost, adminEmails, siteName)
}

// fetchFreshAccount loads the latest account from DB; falls back to the snapshot on error.
func (s *BalanceNotifyService) fetchFreshAccount(ctx context.Context, snapshot *Account) *Account {
	if s.accountRepo == nil {
		return snapshot
	}
	fresh, err := s.accountRepo.GetByID(ctx, snapshot.ID)
	if err != nil {
		slog.Warn("failed to fetch fresh account for quota notify, using snapshot",
			"account_id", snapshot.ID, "error", err)
		return snapshot
	}
	return fresh
}

// checkQuotaDimCrossings iterates pre-built quota dimensions and sends alerts for threshold crossings.
// Pre-increment value is reconstructed as currentUsed - cost to detect the crossing moment.
func (s *BalanceNotifyService) checkQuotaDimCrossings(account *Account, dims []quotaDim, cost float64, adminEmails []string, siteName string) {
	for _, dim := range dims {
		if !dim.enabled || dim.threshold <= 0 {
			continue
		}
		effectiveThreshold := dim.resolvedThreshold()
		if effectiveThreshold <= 0 {
			continue
		}
		newUsed := dim.currentUsed
		oldUsed := dim.currentUsed - cost
		if oldUsed < effectiveThreshold && newUsed >= effectiveThreshold {
			s.asyncSendQuotaAlert(adminEmails, account.ID, account.Name, account.Platform, dim, newUsed, effectiveThreshold, siteName)
		}
	}
}

// asyncSendQuotaAlert sends quota alert email in a goroutine with panic recovery.
func (s *BalanceNotifyService) asyncSendQuotaAlert(adminEmails []string, accountID int64, accountName, platform string, dim quotaDim, newUsed, effectiveThreshold float64, siteName string) {
	go func() {
		defer func() {
			if r := recover(); r != nil {
				slog.Error("panic in quota notification", "recover", r)
			}
		}()
		s.sendQuotaAlertEmails(adminEmails, accountID, accountName, platform, dim, newUsed, siteName)
	}()
}

// getBalanceNotifyConfig reads global balance notification settings.
func (s *BalanceNotifyService) getBalanceNotifyConfig(ctx context.Context) (enabled bool, threshold float64, rechargeURL string) {
	keys := []string{SettingKeyBalanceLowNotifyEnabled, SettingKeyBalanceLowNotifyThreshold, SettingKeyBalanceLowNotifyRechargeURL}
	settings, err := s.settingRepo.GetMultiple(ctx, keys)
	if err != nil {
		return false, 0, ""
	}
	enabled = settings[SettingKeyBalanceLowNotifyEnabled] == "true"
	if v := settings[SettingKeyBalanceLowNotifyThreshold]; v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			threshold = f
		}
	}
	rechargeURL = settings[SettingKeyBalanceLowNotifyRechargeURL]
	return
}

// isAccountQuotaNotifyEnabled checks the global account quota notification toggle.
func (s *BalanceNotifyService) isAccountQuotaNotifyEnabled(ctx context.Context) bool {
	val, err := s.settingRepo.GetValue(ctx, SettingKeyAccountQuotaNotifyEnabled)
	if err != nil {
		return false
	}
	return val == "true"
}

// getAccountQuotaNotifyEmails reads admin notification emails from settings,
// filtering out disabled and unverified entries.
func (s *BalanceNotifyService) getAccountQuotaNotifyEmails(ctx context.Context) []string {
	raw, err := s.settingRepo.GetValue(ctx, SettingKeyAccountQuotaNotifyEmails)
	if err != nil || strings.TrimSpace(raw) == "" || raw == "[]" {
		return nil
	}

	entries := ParseNotifyEmails(raw)
	if len(entries) == 0 {
		return nil
	}

	return filterVerifiedEmails(entries)
}

// getSiteName reads site name from settings with fallback.
func (s *BalanceNotifyService) getSiteName(ctx context.Context) string {
	name, err := s.settingRepo.GetValue(ctx, SettingKeySiteName)
	if err != nil || name == "" {
		return defaultSiteName
	}
	return name
}

// filterVerifiedEmails returns deduplicated, non-disabled, verified emails.
func filterVerifiedEmails(entries []NotifyEmailEntry) []string {
	var recipients []string
	seen := make(map[string]bool)
	for _, entry := range entries {
		if entry.Disabled || !entry.Verified {
			continue
		}
		email := strings.TrimSpace(entry.Email)
		if email == "" {
			continue
		}
		lower := strings.ToLower(email)
		if seen[lower] {
			continue
		}
		seen[lower] = true
		recipients = append(recipients, email)
	}
	return recipients
}

// collectBalanceNotifyRecipients returns verified, non-disabled email recipients.
// Only emails with verified=true and disabled=false are included.
func (s *BalanceNotifyService) collectBalanceNotifyRecipients(user *User) []string {
	return filterVerifiedEmails(user.BalanceNotifyExtraEmails)
}

// sendEmails sends an email to all recipients with shared timeout and error logging.
func (s *BalanceNotifyService) sendEmails(recipients []string, subject, body string, logAttrs ...any) {
	if len(recipients) == 0 {
		slog.Warn("sendEmails: no recipients", "subject", subject)
		return
	}
	for _, to := range recipients {
		ctx, cancel := context.WithTimeout(context.Background(), emailSendTimeout)
		if err := s.emailService.SendEmail(ctx, to, subject, body); err != nil {
			attrs := append([]any{"to", to, "error", err}, logAttrs...)
			slog.Error("failed to send notification", attrs...)
		} else {
			slog.Info("notification email sent successfully", "to", to, "subject", subject)
		}
		cancel()
	}
}

// sendBalanceLowEmails sends balance low notification to all recipients.
func (s *BalanceNotifyService) sendBalanceLowEmails(recipients []string, userID int64, userName, userEmail string, balance, threshold float64, siteName, rechargeURL string) {
	displayName := userName
	if displayName == "" {
		displayName = userEmail
	}
	if s.notificationEmailService != nil {
		fallbackRecipients := make([]string, 0, len(recipients))
		for _, to := range recipients {
			ctx, cancel := context.WithTimeout(context.Background(), emailSendTimeout)
			err := s.notificationEmailService.Send(ctx, NotificationEmailSendInput{
				Event:          NotificationEmailEventBalanceLow,
				RecipientEmail: to,
				RecipientName:  displayName,
				UserID:         userID,
				SourceType:     "balance_low",
				SourceID:       firstNonEmpty(strconv.FormatInt(userID, 10), userEmail),
				ReminderKey:    time.Now().UTC().Format("2006-01-02"),
				Variables: map[string]string{
					"current_balance": fmt.Sprintf("%.2f", balance),
					"threshold":       fmt.Sprintf("%.2f", threshold),
					"recharge_url":    rechargeURL,
				},
			})
			cancel()
			if err != nil {
				if shouldFallbackNotificationEmail(err) {
					slog.Warn("template balance low notification failed; falling back to built-in body", "to", to, "err", err.Error())
					fallbackRecipients = append(fallbackRecipients, to)
				} else {
					slog.Warn("template balance low notification delivery failed; not sending fallback to avoid duplicates", "to", to, "err", err.Error())
				}
			}
		}
		if len(fallbackRecipients) == 0 {
			return
		}
		recipients = fallbackRecipients
	}
	subject := fmt.Sprintf("[%s] 余额不足提醒 / Balance Low Alert", sanitizeEmailHeader(siteName))
	body := s.buildBalanceLowEmailBody(html.EscapeString(displayName), balance, threshold, html.EscapeString(siteName), rechargeURL)
	s.sendEmails(recipients, subject, body, "user_email", userEmail, "balance", balance)
}

// sendQuotaAlertEmails sends quota alert notification to admin emails.
func (s *BalanceNotifyService) sendQuotaAlertEmails(adminEmails []string, accountID int64, accountName, platform string, dim quotaDim, used float64, siteName string) {
	dimLabel := quotaDimLabels[dim.name]
	if dimLabel == "" {
		dimLabel = dim.name
	}

	// Format the remaining-based threshold for display
	thresholdDisplay := fmt.Sprintf("$%.2f", dim.threshold)
	if dim.thresholdType == thresholdTypePercentage {
		thresholdDisplay = fmt.Sprintf("%.0f%%", dim.threshold)
	}
	remaining := dim.limit - used
	if remaining < 0 {
		remaining = 0
	}

	if s.notificationEmailService != nil {
		fallbackRecipients := make([]string, 0, len(adminEmails))
		for _, to := range adminEmails {
			ctx, cancel := context.WithTimeout(context.Background(), emailSendTimeout)
			err := s.notificationEmailService.Send(ctx, NotificationEmailSendInput{
				Event:          NotificationEmailEventAccountQuotaAlert,
				RecipientEmail: to,
				RecipientName:  emailRecipientName(to),
				SourceType:     "account_quota",
				SourceID:       fmt.Sprintf("%d-%s", accountID, dim.name),
				ReminderKey:    time.Now().UTC().Format("2006-01-02"),
				Variables: map[string]string{
					"account_id":      strconv.FormatInt(accountID, 10),
					"account_name":    accountName,
					"platform":        platform,
					"quota_dimension": dimLabel,
					"quota_used":      fmt.Sprintf("%.2f", used),
					"quota_limit":     fmt.Sprintf("%.2f", dim.limit),
					"quota_remaining": fmt.Sprintf("%.2f", remaining),
					"quota_threshold": thresholdDisplay,
				},
			})
			cancel()
			if err != nil {
				if shouldFallbackNotificationEmail(err) {
					slog.Warn("template account quota alert failed; falling back to built-in body", "to", to, "account_id", accountID, "dimension", dim.name, "err", err.Error())
					fallbackRecipients = append(fallbackRecipients, to)
				} else {
					slog.Warn("template account quota alert delivery failed; not sending fallback to avoid duplicates", "to", to, "account_id", accountID, "dimension", dim.name, "err", err.Error())
				}
			}
		}
		if len(fallbackRecipients) == 0 {
			return
		}
		adminEmails = fallbackRecipients
	}

	subject := fmt.Sprintf("[%s] 账号限额告警 / Account Quota Alert - %s", sanitizeEmailHeader(siteName), sanitizeEmailHeader(accountName))
	body := s.buildQuotaAlertEmailBody(accountID, html.EscapeString(accountName), html.EscapeString(platform), html.EscapeString(dimLabel), used, dim.limit, remaining, thresholdDisplay, html.EscapeString(siteName))
	s.sendEmails(adminEmails, subject, body, "account", accountName, "dimension", dim.name)
}

// sanitizeEmailHeader removes CR/LF characters to prevent SMTP header injection.
func sanitizeEmailHeader(s string) string {
	return strings.NewReplacer("\r", "", "\n", "").Replace(s)
}

// emailSiteURL is the service's address for the email layout's logo.
func (s *BalanceNotifyService) emailSiteURL() string {
	if s == nil || s.settingRepo == nil {
		return ""
	}
	for _, key := range []string{SettingKeyAPIBaseURL, SettingKeyFrontendURL} {
		if value, err := s.settingRepo.GetValue(context.Background(), key); err == nil && strings.TrimSpace(value) != "" {
			return strings.TrimRight(strings.TrimSpace(value), "/")
		}
	}
	return ""
}

// emailRows renders label/value pairs as the layout's rows (values already HTML).
func emailRows(rows [][2]string) string {
	var b strings.Builder
	b.WriteString(`<table class="cx-rows" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse;margin:8px 0 18px;">`)
	for _, r := range rows {
		b.WriteString(`<tr><td style="padding:8px 0;border-bottom:1px solid #eeece4;color:#6b6a65;font-size:14px;">` + r[0] +
			`</td><td align="right" style="padding:8px 0;border-bottom:1px solid #eeece4;color:#141413;font-size:14px;font-weight:600;">` + r[1] + `</td></tr>`)
	}
	b.WriteString(`</table>`)
	return b.String()
}

// buildBalanceLowEmailBody builds HTML email for balance low notification
// (CLAUDEX: Claudex email layout, bilingual as before).
func (s *BalanceNotifyService) buildBalanceLowEmailBody(userName string, balance, threshold float64, siteName, rechargeURL string) string {
	content := fmt.Sprintf(`<p>%s，你的账户余额不足。<br><span style="color:#6b6a65;">Dear %s, your balance is running low.</span></p>
<p class="amount" style="margin:18px 0;padding:18px 12px;border-radius:12px;background:#f5f4ef;font-size:30px;line-height:36px;font-weight:600;text-align:center;color:#b3261e;">$%.2f</p>
<p>账户余额已低于提醒阈值 <strong>$%.2f</strong>，请及时充值以免服务中断。<br><span style="color:#6b6a65;">Your balance has fallen below the alert threshold of <strong>$%.2f</strong>. Please top up to avoid interruption.</span></p>`,
		userName, userName, balance, threshold, threshold)
	if rechargeURL != "" {
		content += "\n" + ClaudexEmailButton(rechargeURL, "立即充值 / Top Up Now")
	}
	return ClaudexEmailHTML(ClaudexEmailLayout{
		SiteName: siteName,
		SiteURL:  html.EscapeString(s.emailSiteURL()),
		Title:    "余额不足提醒 / Balance low",
		Accent:   EmailAccentWarning,
		Content:  content,
	})
}

// buildQuotaAlertEmailBody builds HTML email for account quota alert
// (CLAUDEX: Claudex email layout).
func (s *BalanceNotifyService) buildQuotaAlertEmailBody(accountID int64, accountName, platform, dimLabel string, used, limit, remaining float64, thresholdDisplay, siteName string) string {
	limitStr := fmt.Sprintf("$%.2f", limit)
	if limit <= 0 {
		limitStr = "无限制 / Unlimited"
	}
	content := `<p>账号剩余额度已低于提醒阈值，请及时关注。<br><span style="color:#6b6a65;">An account's remaining quota has fallen below the alert threshold.</span></p>
` + emailRows([][2]string{
		{"账号 ID / Account ID", fmt.Sprintf("#%d", accountID)},
		{"账号 / Account", accountName},
		{"平台 / Platform", platform},
		{"维度 / Dimension", dimLabel},
		{"已使用 / Used", fmt.Sprintf("$%.2f", used)},
		{"限额 / Limit", limitStr},
		{"剩余额度 / Remaining", fmt.Sprintf("$%.2f", remaining)},
		{"提醒阈值 / Alert threshold", thresholdDisplay},
	})
	return ClaudexEmailHTML(ClaudexEmailLayout{
		SiteName: siteName,
		SiteURL:  html.EscapeString(s.emailSiteURL()),
		Title:    "账号限额告警 / Account quota alert",
		Accent:   EmailAccentDanger,
		Content:  content,
	})
}
