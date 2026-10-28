package core

import (
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/hex"
	"strings"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/config"

	"github.com/stretchr/testify/require"
)

const secretBoxTestKey = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"

func secretBoxConfig(key string, configured bool) *config.Config {
	cfg := &config.Config{}
	cfg.Totp.EncryptionKey = key
	cfg.Totp.EncryptionKeyConfigured = configured
	return cfg
}

func TestSecretBoxRoundTrip(t *testing.T) {
	box := NewSecretBox(secretBoxConfig(secretBoxTestKey, true))
	require.True(t, box.CanStore())
	sealed, err := box.Seal("remember: prefers tabs")
	require.NoError(t, err)
	require.NotContains(t, sealed, "tabs")
	again, err := box.Seal("remember: prefers tabs")
	require.NoError(t, err)
	require.NotEqual(t, sealed, again, "a fresh nonce every time")
	plain, err := box.Open(sealed)
	require.NoError(t, err)
	require.Equal(t, "remember: prefers tabs", plain)

	empty, err := box.Seal("")
	require.NoError(t, err)
	plain, err = box.Open(empty)
	require.NoError(t, err)
	require.Equal(t, "", plain)
}

// The format is the upstream AESEncryptor's: base64(nonce | ciphertext | tag).
func TestSecretBoxFormatIsNonceCiphertextTag(t *testing.T) {
	box := NewSecretBox(secretBoxConfig(secretBoxTestKey, true))
	sealed, err := box.Seal("value")
	require.NoError(t, err)
	raw, err := base64.StdEncoding.DecodeString(sealed)
	require.NoError(t, err)
	key, _ := hex.DecodeString(secretBoxTestKey)
	block, err := aes.NewCipher(key)
	require.NoError(t, err)
	gcm, err := cipher.NewGCM(block)
	require.NoError(t, err)
	plain, err := gcm.Open(nil, raw[:gcm.NonceSize()], raw[gcm.NonceSize():], nil)
	require.NoError(t, err)
	require.Equal(t, "value", string(plain))
}

func TestSecretBoxRefusesToSealWithoutAFixedKey(t *testing.T) {
	for name, box := range map[string]*SecretBox{
		"nil config":    NewSecretBox(nil),
		"generated key": NewSecretBox(secretBoxConfig(secretBoxTestKey, false)),
		"not hex":       NewSecretBox(secretBoxConfig(strings.Repeat("zz", 32), true)),
		"short key":     NewSecretBox(secretBoxConfig("0011", true)),
		"nil box":       nil,
	} {
		require.False(t, box.CanStore(), name)
		_, err := box.Seal("x")
		require.ErrorIs(t, err, ErrSecretKeyMissing, name)
	}

	// A generated key still opens what was sealed under the same key; it only
	// refuses to seal new values.
	sealed, err := NewSecretBox(secretBoxConfig(secretBoxTestKey, true)).Seal("v")
	require.NoError(t, err)
	plain, err := NewSecretBox(secretBoxConfig(secretBoxTestKey, false)).Open(sealed)
	require.NoError(t, err)
	require.Equal(t, "v", plain)
}

func TestSecretBoxOpenFailures(t *testing.T) {
	box := NewSecretBox(secretBoxConfig(secretBoxTestKey, true))
	sealed, err := box.Seal("value")
	require.NoError(t, err)
	raw, err := base64.StdEncoding.DecodeString(sealed)
	require.NoError(t, err)
	raw[len(raw)-1] ^= 0xff
	tampered := base64.StdEncoding.EncodeToString(raw)

	other := NewSecretBox(secretBoxConfig(strings.Repeat("ab", 32), true))
	for name, tc := range map[string]struct {
		box   *SecretBox
		value string
	}{
		"other key":  {other, sealed},
		"not base64": {box, "!!"},
		"too short":  {box, base64.StdEncoding.EncodeToString([]byte("abc"))},
		"tampered":   {box, tampered},
		"no key":     {NewSecretBox(nil), sealed},
		"nil box":    {nil, sealed},
	} {
		_, err := tc.box.Open(tc.value)
		require.ErrorIs(t, err, ErrSecretUndecryptable, name)
	}
}
