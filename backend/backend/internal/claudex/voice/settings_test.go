package voice

import (
	"strings"
	"testing"

	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"

	"github.com/stretchr/testify/require"
)

func TestDefaultsKeepDictationOff(t *testing.T) {
	s := defaultSettings()
	normalize(&s)
	require.NoError(t, validate(&s))
	require.False(t, s.Transcription.Enabled)
	require.False(t, s.Transcription.KeyConfigured())
	require.Equal(t, DefaultUpstreamURL, s.Transcription.UpstreamURL)
	require.Equal(t, int64(300*32000), s.Transcription.MaxBytes)
}

func TestValidateRejectsEveryOutOfRangeField(t *testing.T) {
	for _, tc := range []struct {
		field string
		edit  func(*TranscriptionSettings)
	}{
		{"transcription.upstream_url", func(t *TranscriptionSettings) { t.UpstreamURL = ""; t.Enabled = true }},
		{"transcription.upstream_url", func(t *TranscriptionSettings) { t.UpstreamURL = "https://transcribe.example.com/v1" }},
		{"transcription.upstream_url", func(t *TranscriptionSettings) { t.UpstreamURL = "ws://transcribe.example.com/v1" }},
		{"transcription.upstream_url", func(t *TranscriptionSettings) { t.UpstreamURL = "wss://user:pw@transcribe.example.com/v1" }},
		{"transcription.upstream_url", func(t *TranscriptionSettings) { t.UpstreamURL = "wss://transcribe.example.com/v1?api_key=x" }},
		{"transcription.upstream_url", func(t *TranscriptionSettings) { t.UpstreamURL = "wss:///nohost" }},
		{"transcription.upstream_url", func(t *TranscriptionSettings) { t.UpstreamURL = "wss://h/" + strings.Repeat("a", 2048) }},
		{"transcription.max_session_seconds", func(t *TranscriptionSettings) { t.MaxSessionSeconds = 9 }},
		{"transcription.max_session_seconds", func(t *TranscriptionSettings) { t.MaxSessionSeconds = 3601 }},
		{"transcription.max_bytes", func(t *TranscriptionSettings) { t.MaxBytes = 31999 }},
		{"transcription.max_bytes", func(t *TranscriptionSettings) { t.MaxBytes = 3600*32000 + 1 }},
		{"transcription.idle_timeout_seconds", func(t *TranscriptionSettings) { t.IdleTimeoutSeconds = 4 }},
		{"transcription.idle_timeout_seconds", func(t *TranscriptionSettings) { t.IdleTimeoutSeconds = 301 }},
		{"transcription.api_key", func(t *TranscriptionSettings) {
			t.UpstreamURL = "wss://transcribe.example.com/v1"
			t.Enabled = true
		}},
	} {
		s := defaultSettings()
		tc.edit(&s.Transcription)
		normalize(&s)
		err := validate(&s)
		require.Error(t, err, tc.field)
		require.Equal(t, ReasonInvalid, infraerrors.Reason(err))
		require.Equal(t, tc.field, infraerrors.FromError(err).Metadata["field"], tc.field)
	}
}

func TestValidateAcceptsTheBoundaries(t *testing.T) {
	s := defaultSettings()
	s.Transcription = TranscriptionSettings{
		Enabled: true, UpstreamURL: " ws://127.0.0.1:9000/v1/audio/realtime/transcriptions ", APIKeyCiphertext: "x",
		MaxSessionSeconds: 10, MaxBytes: 32000, IdleTimeoutSeconds: 5,
	}
	normalize(&s)
	require.NoError(t, validate(&s))
	require.Equal(t, "ws://127.0.0.1:9000/v1/audio/realtime/transcriptions", s.Transcription.UpstreamURL)
	s.Transcription.UpstreamURL = "ws://localhost/x"
	s.Transcription.MaxSessionSeconds, s.Transcription.MaxBytes, s.Transcription.IdleTimeoutSeconds = 3600, 3600*32000, 300
	require.NoError(t, validate(&s))
}

func TestNormalizeDropsTheHintWithoutAKey(t *testing.T) {
	s := defaultSettings()
	s.Transcription.APIKeyHint = "abcd"
	normalize(&s)
	require.Empty(t, s.Transcription.APIKeyHint)
}

func TestKeyHint(t *testing.T) {
	require.Equal(t, "", keyHint("sk-short-key"))
	require.Equal(t, "wxyz", keyHint("sk-0123456789-wxyz"))
}

func TestSecretBoxRoundTrip(t *testing.T) {
	box := newSecretBox(fixedKeyConfig())
	require.True(t, box.canStore())
	sealed, err := box.seal("sk-secret-value")
	require.NoError(t, err)
	require.NotContains(t, sealed, "sk-secret")
	again, err := box.seal("sk-secret-value")
	require.NoError(t, err)
	require.NotEqual(t, sealed, again, "a fresh nonce every time")
	plain, err := box.open(sealed)
	require.NoError(t, err)
	require.Equal(t, "sk-secret-value", plain)

	_, err = box.open("!!")
	require.Error(t, err)
	_, err = newSecretBox(nil).open(sealed)
	require.Error(t, err)
	_, err = newSecretBox(nil).seal("x")
	require.Equal(t, ReasonEncryptionKeyMissing, infraerrors.Reason(err))
}
