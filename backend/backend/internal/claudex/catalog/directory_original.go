package catalog

import (
	"encoding/json"
	"net/url"
	"strings"
)

func validDirectoryOriginal(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return true
	}
	if len(raw) > 128*1024 || raw[0] != '{' {
		return false
	}
	var original map[string]any
	return json.Unmarshal(raw, &original) == nil && validDirectoryOriginalValue(original)
}

func validDirectoryOriginalValue(value any) bool {
	switch value := value.(type) {
	case map[string]any:
		for key, child := range value {
			switch strings.ReplaceAll(strings.ToLower(key), "_", "") {
			case "staticcredential", "staticcredentialdraft", "clientsecret", "headervalues", "accesstoken", "refreshtoken", "bearertoken", "authorization", "apikey", "password":
				return false
			case "inputschema", "outputschema":
				continue
			case "userconfig":
				if !validDirectoryTemplateFields(child) {
					return false
				}
				continue
			case "url", "urltemplate", "remoteurl", "testserverurl", "pluginlink", "pluginhomepage", "privacypolicyurl", "termsofserviceurl":
				if address, ok := child.(string); ok && hasDirectoryURLCredentials(address) {
					return false
				}
			}
			if !validDirectoryOriginalValue(child) {
				return false
			}
		}
	case []any:
		for _, child := range value {
			if !validDirectoryOriginalValue(child) {
				return false
			}
		}
	}
	return true
}

func validDirectoryTemplateFields(value any) bool {
	if value == nil {
		return true
	}
	fields, ok := value.(map[string]any)
	if !ok {
		return false
	}
	for _, declaration := range fields {
		field, ok := declaration.(map[string]any)
		if !ok || !validDirectoryOriginalValue(field) {
			return false
		}
	}
	return true
}

func hasDirectoryURLCredentials(address string) bool {
	parsed, err := url.Parse(directoryTemplateSlot.ReplaceAllString(strings.TrimSpace(address), "example"))
	return err == nil && parsed.User != nil
}
