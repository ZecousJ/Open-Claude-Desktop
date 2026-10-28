package voice

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"

	"github.com/Wei-Shaw/sub2api/internal/config"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
)

// ReasonEncryptionKeyMissing refuses storing an upstream API key while the
// server has no fixed secret encryption key.
const ReasonEncryptionKeyMissing = "CLAUDEX_VOICE_ENCRYPTION_KEY_MISSING"

var errEncryptionKeyMissing = infraerrors.BadRequest(ReasonEncryptionKeyMissing,
	"Cannot store the upstream API key: the server has no fixed secret encryption key, so an auto-generated key would change on restart "+
		"and make the stored key unreadable. Set TOTP_ENCRYPTION_KEY (for example `openssl rand -hex 32`) and try again").
	WithMetadata(map[string]string{"field": "transcription.api_key", "rule": "encryption_key"})

// errUndecryptable means the stored key was encrypted with another
// encryption key (the server key changed).
var errUndecryptable = errors.New("voice: the stored upstream API key cannot be decrypted")

// secretBox encrypts the upstream API key with AES-256-GCM using the
// server's TOTP encryption key, in the format of the upstream AESEncryptor
// (base64(nonce | ciphertext | tag)); components may not import the
// repository package that holds it.
type secretBox struct {
	key        []byte
	configured bool
}

func newSecretBox(cfg *config.Config) *secretBox {
	if cfg == nil {
		return &secretBox{}
	}
	key, err := hex.DecodeString(cfg.Totp.EncryptionKey)
	if err != nil || len(key) != 32 {
		return &secretBox{}
	}
	return &secretBox{key: key, configured: cfg.Totp.EncryptionKeyConfigured}
}

// canStore reports whether keys stored now stay readable after a restart.
func (b *secretBox) canStore() bool { return b != nil && b.configured && len(b.key) == 32 }

func (b *secretBox) aead() (cipher.AEAD, error) {
	if b == nil || len(b.key) != 32 {
		return nil, errUndecryptable
	}
	block, err := aes.NewCipher(b.key)
	if err != nil {
		return nil, fmt.Errorf("voice: cipher: %w", err)
	}
	return cipher.NewGCM(block)
}

func (b *secretBox) seal(plaintext string) (string, error) {
	if !b.canStore() {
		return "", errEncryptionKeyMissing
	}
	gcm, err := b.aead()
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", fmt.Errorf("voice: nonce: %w", err)
	}
	return base64.StdEncoding.EncodeToString(gcm.Seal(nonce, nonce, []byte(plaintext), nil)), nil
}

func (b *secretBox) open(ciphertext string) (string, error) {
	gcm, err := b.aead()
	if err != nil {
		return "", err
	}
	raw, err := base64.StdEncoding.DecodeString(ciphertext)
	if err != nil || len(raw) < gcm.NonceSize() {
		return "", errUndecryptable
	}
	plain, err := gcm.Open(nil, raw[:gcm.NonceSize()], raw[gcm.NonceSize():], nil)
	if err != nil {
		return "", errUndecryptable
	}
	return string(plain), nil
}
