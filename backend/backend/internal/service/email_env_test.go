package service

import "testing"

func envOf(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}

func TestSMTPFromEnvUsesClaudexVariables(t *testing.T) {
	config := smtpConfigFromEnv(envOf(map[string]string{
		"CLAUDEX_SMTP_FROM":     "team@example.com",
		"CLAUDEX_SMTP_PASSWORD": "auth-code",
	}))
	if config == nil {
		t.Fatal("config missing")
	}
	// qq is the default type: smtp.qq.com:465 over implicit TLS, the address is the login.
	if config.Host != "smtp.qq.com" || config.Port != 465 || !config.UseTLS ||
		config.Username != "team@example.com" || config.From != "team@example.com" ||
		config.Password != "auth-code" || config.FromName != "Claudex" {
		t.Fatalf("unexpected config %+v", config)
	}
}

func TestSMTPFromEnvPresetsAndOverrides(t *testing.T) {
	outlook := smtpConfigFromEnv(envOf(map[string]string{
		"CLAUDEX_SMTP_TYPE":     "outlook",
		"CLAUDEX_SMTP_FROM":     "a@outlook.com",
		"CLAUDEX_SMTP_PASSWORD": "x",
	}))
	if outlook == nil || outlook.Host != "smtp.office365.com" || outlook.Port != 587 || !outlook.UseTLS {
		t.Fatalf("outlook %+v", outlook)
	}
	custom := smtpConfigFromEnv(envOf(map[string]string{
		"CLAUDEX_SMTP_TYPE":         "custom",
		"CLAUDEX_SMTP_FROM":         "a@corp.test",
		"CLAUDEX_SMTP_USERNAME":     "robot",
		"CLAUDEX_SMTP_PASSWORD":     "x",
		"CLAUDEX_SMTP_HOST":         "mail.corp.test",
		"CLAUDEX_SMTP_PORT":         "2525",
		"CLAUDEX_SMTP_USE_SSL":      "false",
		"CLAUDEX_SMTP_USE_STARTTLS": "false",
		"CLAUDEX_SMTP_FROM_NAME":    "Corp",
	}))
	if custom == nil || custom.Host != "mail.corp.test" || custom.Port != 2525 || custom.UseTLS ||
		custom.Username != "robot" || custom.FromName != "Corp" {
		t.Fatalf("custom %+v", custom)
	}
}

func TestSMTPFromEnvNeedsAddressCodeAndHost(t *testing.T) {
	for name, values := range map[string]map[string]string{
		"no code":    {"CLAUDEX_SMTP_FROM": "a@b.test"},
		"no address": {"CLAUDEX_SMTP_PASSWORD": "x"},
		"custom without a host": {
			"CLAUDEX_SMTP_TYPE": "custom", "CLAUDEX_SMTP_FROM": "a@b.test", "CLAUDEX_SMTP_PASSWORD": "x",
		},
	} {
		if smtpConfigFromEnv(envOf(values)) != nil {
			t.Fatalf("%s: a config was made", name)
		}
	}
}
