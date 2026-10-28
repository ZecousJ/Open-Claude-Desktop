package service

import (
	"os"
	"strconv"
	"strings"
)

// CLAUDEX: SMTP from the environment (/etc/claudex/claudex.env). Production
// sends through Resend's SMTP (smtp.resend.com:465, user "resend", the
// Resend API key as the password):
//
//	CLAUDEX_SMTP_TYPE          qq (default) | 163 | 126 | gmail | outlook | aliyun | custom
//	CLAUDEX_SMTP_FROM          the sending address (also the login when no username is set)
//	CLAUDEX_SMTP_USERNAME      the login, when it is not the address
//	CLAUDEX_SMTP_PASSWORD      the password, API key or authorisation code
//	CLAUDEX_SMTP_HOST / _PORT  needed for custom, optional otherwise
//	CLAUDEX_SMTP_USE_SSL       implicit TLS (true on 465)
//	CLAUDEX_SMTP_USE_STARTTLS  STARTTLS (true on 587)
//	CLAUDEX_SMTP_FROM_NAME     the display name (default Claudex)
//
// The settings an administrator saves in the console win; the environment
// answers only while the console has no SMTP host.

type smtpPreset struct {
	host     string
	port     int
	useSSL   bool
	startTLS bool
}

var smtpPresets = map[string]smtpPreset{
	"qq":      {"smtp.qq.com", 465, true, false},
	"163":     {"smtp.163.com", 465, true, false},
	"126":     {"smtp.126.com", 465, true, false},
	"gmail":   {"smtp.gmail.com", 465, true, false},
	"outlook": {"smtp.office365.com", 587, false, true},
	"aliyun":  {"smtp.aliyun.com", 465, true, false},
}

func envBool(value string, fallback bool) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	}
	return fallback
}

// smtpConfigFromEnv reads the CLAUDEX_SMTP_* variables; nil when the address
// or the code is missing, or the host cannot be worked out.
func smtpConfigFromEnv(get func(string) string) *SMTPConfig {
	email := strings.TrimSpace(get("CLAUDEX_SMTP_FROM"))
	code := strings.TrimSpace(get("CLAUDEX_SMTP_PASSWORD"))
	if email == "" || code == "" {
		return nil
	}
	kind := strings.ToLower(strings.TrimSpace(get("CLAUDEX_SMTP_TYPE")))
	if kind == "" {
		kind = "qq"
	}
	preset := smtpPresets[kind] // zero value for custom
	host := strings.TrimSpace(get("CLAUDEX_SMTP_HOST"))
	if host == "" {
		host = preset.host
	}
	if host == "" {
		return nil
	}
	port := preset.port
	if value := strings.TrimSpace(get("CLAUDEX_SMTP_PORT")); value != "" {
		if parsed, err := strconv.Atoi(value); err == nil && parsed > 0 && parsed < 65536 {
			port = parsed
		}
	}
	useSSL := envBool(get("CLAUDEX_SMTP_USE_SSL"), preset.useSSL)
	startTLS := envBool(get("CLAUDEX_SMTP_USE_STARTTLS"), preset.startTLS)
	if port == 0 {
		if useSSL {
			port = 465
		} else {
			port = 587
		}
	}
	username := strings.TrimSpace(get("CLAUDEX_SMTP_USERNAME"))
	if username == "" {
		username = email
	}
	fromName := strings.TrimSpace(get("CLAUDEX_SMTP_FROM_NAME"))
	if fromName == "" {
		fromName = "Claudex"
	}
	return &SMTPConfig{
		Host:     host,
		Port:     port,
		Username: username,
		Password: code,
		From:     email,
		FromName: fromName,
		// Both ways use an encrypted session; the connection code falls back
		// from implicit TLS to a required STARTTLS on its own.
		UseTLS: useSSL || startTLS,
	}
}

// environmentSMTPConfig is smtpConfigFromEnv over the process environment.
func environmentSMTPConfig() *SMTPConfig {
	return smtpConfigFromEnv(os.Getenv)
}
