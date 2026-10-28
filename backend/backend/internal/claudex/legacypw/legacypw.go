// Package legacypw verifies password hashes imported from another service
// (package ZMIG), so migrated users sign in with their existing passwords.
//
// Sub2API stores standard bcrypt ("$2a$"/"$2b$"/"$2y$"). Imported users may
// instead carry one of these formats until their first successful sign-in,
// when the auth service rehashes the password to standard bcrypt:
//
//   - passlib bcrypt_sha256 v2: $bcrypt-sha256$v=2,t=2b,r=<rounds>$<salt22>$<checksum31>
//     bcrypt($2b$<rounds>$<salt><checksum>) over
//     base64std(HMAC-SHA256(key=salt ASCII, msg=password UTF-8)).
//   - passlib bcrypt_sha256 v1: $bcrypt-sha256$2b,<rounds>$<salt22>$<checksum31>
//     bcrypt over base64std(SHA-256(password)).
//   - werkzeug pbkdf2: pbkdf2:<sha1|sha256|sha512>:<iterations>$<salt>$<hex>
//     PBKDF2-HMAC with the salt as ASCII bytes, hex digest of the hash size.
//   - werkzeug scrypt: scrypt:<N>:<r>:<p>$<salt>$<hex>, 64-byte key.
//
// The package only depends on the standard library and golang.org/x/crypto so
// the upstream service layer can call it without an import cycle.
package legacypw

import (
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"hash"
	"strconv"
	"strings"

	"golang.org/x/crypto/bcrypt"
	"golang.org/x/crypto/scrypt"
)

// Scheme names a recognised password hash format.
type Scheme string

const (
	SchemeUnknown        Scheme = ""
	SchemeBcrypt         Scheme = "bcrypt"
	SchemeBcryptSHA256V1 Scheme = "bcrypt_sha256_v1"
	SchemeBcryptSHA256V2 Scheme = "bcrypt_sha256_v2"
	SchemePBKDF2         Scheme = "werkzeug_pbkdf2"
	SchemeScrypt         Scheme = "werkzeug_scrypt"
)

// Work limits: stored hashes come from an export file, so a malformed or
// hostile record must not make a sign-in attempt burn unbounded CPU or memory.
const (
	maxPBKDF2Iterations = 5_000_000
	maxScryptN          = 1 << 20
	maxScryptR          = 32
	maxScryptP          = 16
	maxScryptMemory     = 256 << 20 // 128*N*r*p bytes
	scryptKeyLen        = 64
	bcryptSaltLen       = 22
	bcryptChecksumLen   = 31
)

// Detect returns the scheme of hash, or SchemeUnknown.
func Detect(hash string) Scheme {
	switch {
	case strings.HasPrefix(hash, "$2a$"), strings.HasPrefix(hash, "$2b$"), strings.HasPrefix(hash, "$2y$"):
		return SchemeBcrypt
	case strings.HasPrefix(hash, "$bcrypt-sha256$v=2,"):
		return SchemeBcryptSHA256V2
	case strings.HasPrefix(hash, "$bcrypt-sha256$"):
		return SchemeBcryptSHA256V1
	case strings.HasPrefix(hash, "pbkdf2:"):
		return SchemePBKDF2
	case strings.HasPrefix(hash, "scrypt:"):
		return SchemeScrypt
	}
	return SchemeUnknown
}

// IsLegacy reports whether hash is a recognised non-bcrypt format that should
// be replaced by standard bcrypt after a successful sign-in.
func IsLegacy(hash string) bool {
	s := Detect(hash)
	return s != SchemeUnknown && s != SchemeBcrypt
}

// Verify reports whether password matches hash. For standard bcrypt it is
// exactly bcrypt.CompareHashAndPassword; unknown formats never match.
func Verify(password, hash string) bool {
	switch Detect(hash) {
	case SchemeBcrypt:
		return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil
	case SchemeBcryptSHA256V2:
		return verifyBcryptSHA256(password, hash, 2)
	case SchemeBcryptSHA256V1:
		return verifyBcryptSHA256(password, hash, 1)
	case SchemePBKDF2:
		return verifyPBKDF2(password, hash)
	case SchemeScrypt:
		return verifyScrypt(password, hash)
	}
	// Anything else keeps the upstream behavior (bcrypt rejects it).
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil
}

// verifyBcryptSHA256 handles passlib's bcrypt_sha256:
// v2 "$bcrypt-sha256$v=2,t=2b,r=12$<salt>$<checksum>" and
// v1 "$bcrypt-sha256$2b,12$<salt>$<checksum>".
func verifyBcryptSHA256(password, stored string, version int) bool {
	parts := strings.Split(strings.TrimPrefix(stored, "$bcrypt-sha256$"), "$")
	if len(parts) != 3 {
		return false
	}
	params, salt, checksum := parts[0], parts[1], parts[2]
	if len(salt) != bcryptSaltLen || len(checksum) != bcryptChecksumLen {
		return false
	}
	var ident string
	var rounds int
	switch version {
	case 2:
		kv := map[string]string{}
		for _, field := range strings.Split(params, ",") {
			k, v, ok := strings.Cut(field, "=")
			if !ok {
				return false
			}
			kv[k] = v
		}
		if kv["v"] != "2" {
			return false
		}
		ident = kv["t"]
		r, err := strconv.Atoi(kv["r"])
		if err != nil {
			return false
		}
		rounds = r
	default:
		identStr, roundsStr, ok := strings.Cut(params, ",")
		if !ok {
			return false
		}
		r, err := strconv.Atoi(roundsStr)
		if err != nil {
			return false
		}
		ident, rounds = identStr, r
	}
	if ident != "2a" && ident != "2b" {
		return false
	}
	if rounds < bcrypt.MinCost || rounds > bcrypt.MaxCost {
		return false
	}

	var digest []byte
	if version == 2 {
		mac := hmac.New(sha256.New, []byte(salt))
		mac.Write([]byte(password))
		digest = mac.Sum(nil)
	} else {
		sum := sha256.Sum256([]byte(password))
		digest = sum[:]
	}
	pre := base64.StdEncoding.EncodeToString(digest)
	inner := "$" + ident + "$" + twoDigits(rounds) + "$" + salt + checksum
	// bcrypt.CompareHashAndPassword compares in constant time.
	return bcrypt.CompareHashAndPassword([]byte(inner), []byte(pre)) == nil
}

// verifyPBKDF2 handles werkzeug "pbkdf2:<hash>:<iterations>$<salt>$<hex>".
func verifyPBKDF2(password, stored string) bool {
	method, salt, wantHex, ok := splitWerkzeug(stored)
	if !ok {
		return false
	}
	fields := strings.Split(method, ":")
	if len(fields) != 3 || fields[0] != "pbkdf2" {
		return false
	}
	var newHash func() hash.Hash
	switch fields[1] {
	case "sha1":
		newHash = sha1.New
	case "sha256":
		newHash = sha256.New
	case "sha512":
		newHash = sha512.New
	default:
		return false
	}
	iterations, err := strconv.Atoi(fields[2])
	if err != nil || iterations < 1 || iterations > maxPBKDF2Iterations {
		return false
	}
	want, err := hex.DecodeString(wantHex)
	if err != nil || len(want) != newHash().Size() {
		return false
	}
	got, err := pbkdf2.Key(newHash, password, []byte(salt), iterations, len(want))
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(got, want) == 1
}

// verifyScrypt handles werkzeug "scrypt:<N>:<r>:<p>$<salt>$<hex>".
func verifyScrypt(password, stored string) bool {
	method, salt, wantHex, ok := splitWerkzeug(stored)
	if !ok {
		return false
	}
	fields := strings.Split(method, ":")
	if len(fields) != 4 || fields[0] != "scrypt" {
		return false
	}
	n, errN := strconv.Atoi(fields[1])
	r, errR := strconv.Atoi(fields[2])
	p, errP := strconv.Atoi(fields[3])
	if errN != nil || errR != nil || errP != nil {
		return false
	}
	if n < 2 || n > maxScryptN || n&(n-1) != 0 || r < 1 || r > maxScryptR || p < 1 || p > maxScryptP {
		return false
	}
	if int64(128)*int64(n)*int64(r)*int64(p) > maxScryptMemory {
		return false
	}
	want, err := hex.DecodeString(wantHex)
	if err != nil || len(want) != scryptKeyLen {
		return false
	}
	got, err := scrypt.Key([]byte(password), []byte(salt), n, r, p, scryptKeyLen)
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(got, want) == 1
}

func splitWerkzeug(stored string) (method, salt, digestHex string, ok bool) {
	parts := strings.Split(stored, "$")
	if len(parts) != 3 || parts[1] == "" || parts[2] == "" {
		return "", "", "", false
	}
	return parts[0], parts[1], strings.ToLower(parts[2]), true
}

func twoDigits(n int) string {
	if n < 10 {
		return "0" + strconv.Itoa(n)
	}
	return strconv.Itoa(n)
}
