package service

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestCodexDraws(t *testing.T) {
	require.True(t, (&Account{Extra: map[string]any{"codex_image_generation_supported": true}}).CodexDraws())
	require.True(t, (&Account{Extra: map[string]any{"openai": map[string]any{"codex_image_generation_supported": true}}}).CodexDraws())
	require.False(t, (&Account{Extra: map[string]any{}}).CodexDraws())
	require.False(t, (*Account)(nil).CodexDraws())
}

func TestADrawingAccountServesImageModels(t *testing.T) {
	drawing := &Account{Platform: PlatformOpenAI, Type: AccountTypeAPIKey,
		Credentials: map[string]any{"model_mapping": map[string]any{"gpt-6.1-sol": "gpt-6.1-sol"}},
		Extra:       map[string]any{"codex_image_generation_supported": true}}
	require.True(t, drawing.IsModelSupported("gpt-image-2"))
	require.True(t, drawing.IsModelSupported("gpt-6.1-sol"))
	require.False(t, drawing.IsModelSupported("gpt-5.5"))
	plain := &Account{Platform: PlatformOpenAI, Type: AccountTypeAPIKey,
		Credentials: map[string]any{"model_mapping": map[string]any{"gpt-6.1-sol": "gpt-6.1-sol"}}}
	require.False(t, plain.IsModelSupported("gpt-image-2"))
}
