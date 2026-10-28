package core

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
)

// ErrSecretKeyMissing means the server has no fixed secret encryption key
// (TOTP_ENCRYPTION_KEY): an auto-generated key changes on restart and would
// make everything sealed with it unreadable, so SecretBox refuses to seal.
// Components map it to their own reason code (for example
// CLAUDEX_MEMORY_ENCRYPTION_KEY_MISSING) and never store plaintext instead.
var ErrSecretKeyMissing = errors.New("claudex: the server has no fixed secret encryption key")

// ErrSecretUndecryptable means a sealed value cannot be opened: it was sealed
// with another key (the server key changed) or is corrupt.
var ErrSecretUndecryptable = errors.New("claudex: the stored secret cannot be decrypted")

// SecretBox encrypts small values (upstream API keys, memory text) with
// AES-256-GCM under the server's TOTP encryption key, in the format of the
// upstream AESEncryptor: base64(nonce | ciphertext | tag). Components may not
// import the repository package that holds that encryptor.
//
// It is a copy of voice/secret.go (round 2, B-S) for the components added in
// round 2; the voice package keeps its own copy until a later cleanup.
type SecretBox struct {
	key        []byte
	configured bool
}

// NewSecretBox reads the key from cfg. A nil config or a key that is not 32
// hex-encoded bytes gives a box that can neither seal nor open.
func NewSecretBox(cfg *config.Config) *SecretBox {
	if cfg == nil {
		return &SecretBox{}
	}
	key, err := hex.DecodeString(cfg.Totp.EncryptionKey)
	if err != nil || len(key) != 32 {
		return &SecretBox{}
	}
	return &SecretBox{key: key, configured: cfg.Totp.EncryptionKeyConfigured}
}

// CanStore reports whether values sealed now stay readable after a restart
// (the key was configured, not generated at start-up).
func (b *SecretBox) CanStore() bool { return b != nil && b.configured && len(b.key) == 32 }

func (b *SecretBox) aead() (cipher.AEAD, error) {
	if b == nil || len(b.key) != 32 {
		return nil, ErrSecretUndecryptable
	}
	block, err := aes.NewCipher(b.key)
	if err != nil {
		return nil, fmt.Errorf("claudex: cipher: %w", err)
	}
	return cipher.NewGCM(block)
}

// Seal encrypts plaintext with a random nonce. It returns ErrSecretKeyMissing
// when CanStore is false.
func (b *SecretBox) Seal(plaintext string) (string, error) {
	if !b.CanStore() {
		return "", ErrSecretKeyMissing
	}
	gcm, err := b.aead()
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", fmt.Errorf("claudex: nonce: %w", err)
	}
	return base64.StdEncoding.EncodeToString(gcm.Seal(nonce, nonce, []byte(plaintext), nil)), nil
}

// Open decrypts a value produced by Seal. It returns ErrSecretUndecryptable
// for a value sealed under another key, a corrupt value or a box without a
// key; it opens values sealed with a generated key as long as the process
// still has that key.
func (b *SecretBox) Open(ciphertext string) (string, error) {
	gcm, err := b.aead()
	if err != nil {
		return "", err
	}
	raw, err := base64.StdEncoding.DecodeString(ciphertext)
	if err != nil || len(raw) < gcm.NonceSize() {
		return "", ErrSecretUndecryptable
	}
	plain, err := gcm.Open(nil, raw[:gcm.NonceSize()], raw[gcm.NonceSize():], nil)
	if err != nil {
		return "", ErrSecretUndecryptable
	}
	return string(plain), nil
}
