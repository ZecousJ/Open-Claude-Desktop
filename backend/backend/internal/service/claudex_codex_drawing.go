package service

// Claudex: an upstream that draws only for Codex (the "黑化 Pro" account adds
// its own image tool to a Codex client's requests) is marked in its Extra
// with codex_image_generation_supported: true. /v1/images asks such an
// upstream through the Codex bridge (claudex_images_codex_bridge.go). Chat
// requests that ask for a picture are no longer steered to it (owner,
// 2026-10-03: every picture goes through the drawing group's /v1/images).

const featureKeyCodexImageGenerationSupported = "codex_image_generation_supported"

// CodexImageGenerationSupportedExtraKey is kept in the scheduler's account
// projection, where drawing accounts are picked (repository/scheduler_cache.go).
const CodexImageGenerationSupportedExtraKey = featureKeyCodexImageGenerationSupported

// CodexDraws reports whether the account's upstream answers Codex requests
// with its own image tool (Extra codex_image_generation_supported, at the top
// or under "openai").
func (a *Account) CodexDraws() bool {
	if a == nil || a.Extra == nil {
		return false
	}
	if v, ok := a.Extra[featureKeyCodexImageGenerationSupported].(bool); ok {
		return v
	}
	openaiConfig, _ := a.Extra[PlatformOpenAI].(map[string]any)
	v, _ := openaiConfig[featureKeyCodexImageGenerationSupported].(bool)
	return v
}
