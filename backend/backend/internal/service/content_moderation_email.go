package service

import (
	"fmt"
	"html"
	"strings"
	"time"
)

// CLAUDEX: the risk-control emails in the Claudex email layout
// (claudex_email_layout.go), with the same facts and wording as before.

// moderationNotice is one risk-control email: a lead paragraph, a titled
// list of facts, then any closing paragraphs (all already HTML).
func moderationNotice(siteName, title, lead, detailTitle string, rows [][2]string, closing string) string {
	content := `<p>` + lead + `</p>`
	if detailTitle != "" {
		content += `
<p style="margin:22px 0 4px;font-weight:600;color:#141413;">` + detailTitle + `</p>`
	}
	content += "\n" + emailRows(rows) + closing
	return ClaudexEmailHTML(ClaudexEmailLayout{
		SiteName: html.EscapeString(siteName),
		Title:    title,
		Accent:   EmailAccentDanger,
		Content:  content,
	})
}

// bannedNotice is the closing block for a banned account.
const bannedNotice = `<p style="margin:18px 0;padding:14px 16px;border-radius:12px;background:#fbeeec;color:#b3261e;font-weight:600;text-align:center;">账户当前处于封禁状态，所有 API 请求将被拒绝</p>`

func moderationUserName(log *ContentModerationLog) string {
	userName := strings.TrimSpace(log.UserEmail)
	if userName == "" && log.UserID != nil {
		userName = fmt.Sprintf("UID %d", *log.UserID)
	}
	return userName
}

func buildContentModerationViolationEmailBody(siteName string, log *ContentModerationLog, cfg *ContentModerationConfig) string {
	if log == nil {
		return ""
	}
	threshold := cfg.BanThreshold
	if threshold <= 0 {
		threshold = defaultContentModerationBanThreshold
	}
	closing := ""
	if log.AutoBanned {
		closing = bannedNotice
	}
	return moderationNotice(siteName, "账户触发内容审计规则",
		`尊敬的用户 <strong>`+html.EscapeString(moderationUserName(log))+`</strong>，您的 API 请求在内容审计中触发平台风控策略。详情如下。`,
		"触发详情",
		[][2]string{
			{"触发时间", html.EscapeString(time.Now().Format("2006-01-02 15:04:05"))},
			{"触发来源", "内容审核"},
			{"所属分组", html.EscapeString(defaultContentModerationString(log.GroupName, "-"))},
			{"命中类别", fmt.Sprintf("%s / %.3f", html.EscapeString(defaultContentModerationString(log.HighestCategory, "-")), log.HighestScore)},
			{"累计触发次数", fmt.Sprintf(`<span style="color:#b3261e;">%d 次（阈值 %d）</span>`, log.ViolationCount, threshold)},
		},
		closing)
}

func buildContentModerationAccountDisabledEmailBody(siteName string, log *ContentModerationLog, cfg *ContentModerationConfig) string {
	if log == nil {
		return ""
	}
	threshold := cfg.BanThreshold
	if threshold <= 0 {
		threshold = defaultContentModerationBanThreshold
	}
	return moderationNotice(siteName, "账户已被自动禁用",
		`尊敬的用户 <strong>`+html.EscapeString(moderationUserName(log))+`</strong>，您的账户在计数周期内多次触发平台风控策略，系统已自动禁用该账户。详情如下。`,
		"封禁详情",
		[][2]string{
			{"封禁时间", html.EscapeString(time.Now().Format("2006-01-02 15:04:05"))},
			{"触发来源", "内容审核"},
			{"所属分组", html.EscapeString(defaultContentModerationString(log.GroupName, "-"))},
			{"命中类别", fmt.Sprintf("%s / %.3f", html.EscapeString(defaultContentModerationString(log.HighestCategory, "-")), log.HighestScore)},
			{"累计触发次数", fmt.Sprintf(`<span style="color:#b3261e;">%d 次（阈值 %d）</span>`, log.ViolationCount, threshold)},
		},
		bannedNotice+`
<p>如需申诉或恢复账号，请联系平台管理员处理。</p>`)
}

func defaultContentModerationString(value string, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return strings.TrimSpace(value)
}

// buildCyberPolicyNoticeEmailBody 是 cyber_policy 通知邮件的内置兜底正文，
// 当 notification email 模板渲染失败时使用（与 sendViolationEmail 的兜底同理）。
func buildCyberPolicyNoticeEmailBody(siteName string, log *ContentModerationLog) string {
	if log == nil {
		return ""
	}
	return moderationNotice(siteName, "请求被网络安全策略拦截",
		`尊敬的用户 <strong>`+html.EscapeString(moderationUserName(log))+`</strong>，您的请求被上游网络安全策略（cyber policy）拦截。`,
		"",
		[][2]string{
			{"触发时间", html.EscapeString(log.CreatedAt.Format("2006-01-02 15:04:05"))},
			{"模型", html.EscapeString(defaultContentModerationString(log.Model, "-"))},
			{"上游说明", html.EscapeString(defaultContentModerationString(log.Error, "-"))},
		},
		`<p>如认为系误判，可调整请求措辞后重试，或申请获得授权的安全访问权限。</p>`)
}
