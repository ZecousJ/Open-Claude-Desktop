package legacypw

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	"golang.org/x/crypto/bcrypt"
)

// Vectors generated with passlib 1.7.4 (bcrypt 4.0.1) and werkzeug 3.x:
// bcrypt_sha256.using(rounds=…).hash, bcrypt_sha256.using(version=1, …).hash,
// generate_password_hash(pw, method="pbkdf2:sha256:1000" | "scrypt:16384:8:1" | default).
// Each hash was checked with passlib/werkzeug's own verify before being copied here.
const (
	pwASCII   = "correct horse battery staple"
	pwUnicode = "pässwörd-密码-🔑"
)

var pwLong = strings.Repeat("x", 100) // longer than bcrypt's 72-byte limit

var vectors = []struct {
	name   string
	scheme Scheme
	pw     string
	hash   string
}{
	{"passlib v2 r4", SchemeBcryptSHA256V2, pwASCII, "$bcrypt-sha256$v=2,t=2b,r=4$g.KXyKrsnYGb4dyhquY11e$vQZL03xE38FkuJqXiDwqw3DjVW9JjNy"},
	{"passlib v2 unicode r5", SchemeBcryptSHA256V2, pwUnicode, "$bcrypt-sha256$v=2,t=2b,r=5$iMgpJAmWcj3b84WIVLqBle$xwIEln1lhRNmXeWu.RGEieYRYa.OcbW"},
	{"passlib v2 long", SchemeBcryptSHA256V2, pwLong, "$bcrypt-sha256$v=2,t=2b,r=4$ah1bFqzM4CxEjIHBvN8XXu$xkkFcdzFrLFyn6H7xsBMOatu163XInK"},
	{"passlib v2 default rounds", SchemeBcryptSHA256V2, pwASCII, "$bcrypt-sha256$v=2,t=2b,r=12$fG4muOz/iMdJhMMZONeU2O$zelKectgCdheX0jtwg7mpct4Mrg8Xoa"},
	{"passlib v1", SchemeBcryptSHA256V1, pwASCII, "$bcrypt-sha256$2b,4$2onUP5eRmwuVIRe4Rvi7H.$qD2G1tIXHdLdvpn7MLQnCHNTkBgsKE."},
	{"passlib v1 unicode", SchemeBcryptSHA256V1, pwUnicode, "$bcrypt-sha256$2b,4$rAmuxAKKlivdhlhwCqd/.O$TclmD2IdGJ9d9QuIBqXk2mw0vvV6wlW"},
	{"passlib plain bcrypt", SchemeBcrypt, pwASCII, "$2b$04$D7il.1HCzPugQNs5PCa6PO7BTKDYjyzZlJPYFn9o.Eq2/.BTiU6eK"},
	{"werkzeug pbkdf2 sha256", SchemePBKDF2, pwASCII, "pbkdf2:sha256:1000$bwIAYKGbSgQQsupq$625ad9f533557de84af07b881de4dbb259f7e9d43bfffb4b9720628cf91f0d72"},
	{"werkzeug pbkdf2 unicode", SchemePBKDF2, pwUnicode, "pbkdf2:sha256:1000$R7mOjnRpJvUnVyoq$7cbc77c5c0a6aa8bb9dd9b40925df1d5ea8f85c7001a63618d97744c01af91d5"},
	{"werkzeug pbkdf2 sha512", SchemePBKDF2, pwASCII, "pbkdf2:sha512:2000$9iFOlkTlYYHeHm0p$55451fdd838452efb2e03deffda86c1342a8d70317442b2ac462debb133880ee427a0a2193fe0910bd2c6c37842c5c1feb4bf52939ab7adb2e21acb32a8f2f4a"},
	{"werkzeug default scrypt", SchemeScrypt, pwASCII, "scrypt:32768:8:1$g6RJ9i5T0YxClqag$585443a703776aab889aec6356d5250230112706106e7e6726f5b73c4bb74dd5119d8c9ffdcac042ad1098e16b185807dc234f6c4eff179877305ec6decce929"},
	{"werkzeug scrypt", SchemeScrypt, pwASCII, "scrypt:16384:8:1$v0GGKq0YNOQ9GtD0$21824d26992edc5dbf55d788ec6249f51e00f0b6955d262b5acbd01ab82510843fd5e41587bfc31ce188a8c229445c22ba7252e1d288c16841f972d87975b438"},
	{"werkzeug scrypt unicode", SchemeScrypt, pwUnicode, "scrypt:16384:8:1$xayK6ImhlasSrCMO$70e4ea417b546a453181bb343888f521c6996f5720bf5b72c5eba5c013a3871b64f156cb1aacac35a1752d830f3804ad1498d87d7784c41c2907d601e92aa16b"},
}

func TestVerifyAcceptsReferenceVectors(t *testing.T) {
	for _, v := range vectors {
		t.Run(v.name, func(t *testing.T) {
			require.Equal(t, v.scheme, Detect(v.hash))
			require.Equal(t, v.scheme != SchemeBcrypt, IsLegacy(v.hash))
			require.True(t, Verify(v.pw, v.hash))
		})
	}
}

func TestVerifyRejectsWrongPasswords(t *testing.T) {
	for _, v := range vectors {
		t.Run(v.name, func(t *testing.T) {
			require.False(t, Verify(v.pw+"!", v.hash))
			require.False(t, Verify("", v.hash))
			require.False(t, Verify(strings.ToUpper(v.pw), v.hash))
		})
	}
}

func TestVerifyBcryptSHA256DoesNotTruncateAt72Bytes(t *testing.T) {
	// Plain bcrypt would only look at the first 72 bytes; bcrypt_sha256 hashes the
	// whole password first, so a password sharing the first 72 bytes must fail.
	h := vectors[2].hash
	require.False(t, Verify(strings.Repeat("x", 99)+"y", h))
}

func TestVerifyStandardBcryptUnchanged(t *testing.T) {
	h, err := bcrypt.GenerateFromPassword([]byte("secret-1"), bcrypt.MinCost)
	require.NoError(t, err)
	require.True(t, Verify("secret-1", string(h)))
	require.False(t, Verify("secret-2", string(h)))
	require.False(t, IsLegacy(string(h)))
}

func TestVerifyRejectsMalformedHashes(t *testing.T) {
	bad := []string{
		"",
		"plaintext",
		"$bcrypt-sha256$v=2,t=2b,r=4$short$vQZL03xE38FkuJqXiDwqw3DjVW9JjNy",
		"$bcrypt-sha256$v=2,t=2b,r=99$g.KXyKrsnYGb4dyhquY11e$vQZL03xE38FkuJqXiDwqw3DjVW9JjNy",
		"$bcrypt-sha256$v=2,t=2x,r=4$g.KXyKrsnYGb4dyhquY11e$vQZL03xE38FkuJqXiDwqw3DjVW9JjNy",
		"$bcrypt-sha256$v=3,t=2b,r=4$g.KXyKrsnYGb4dyhquY11e$vQZL03xE38FkuJqXiDwqw3DjVW9JjNy",
		"$bcrypt-sha256$2b$g.KXyKrsnYGb4dyhquY11e$vQZL03xE38FkuJqXiDwqw3DjVW9JjNy",
		"pbkdf2:sha256$bwIAYKGbSgQQsupq$625ad9f533557de84af07b881de4dbb259f7e9d43bfffb4b9720628cf91f0d72",
		"pbkdf2:md5:1000$bwIAYKGbSgQQsupq$625ad9f533557de84af07b881de4dbb2",
		"pbkdf2:sha256:999999999$bwIAYKGbSgQQsupq$625ad9f533557de84af07b881de4dbb259f7e9d43bfffb4b9720628cf91f0d72",
		"pbkdf2:sha256:1000$bwIAYKGbSgQQsupq$zz",
		"scrypt:16385:8:1$v0GGKq0YNOQ9GtD0$21824d26992edc5dbf55d788ec6249f51e00f0b6955d262b5acbd01ab82510843fd5e41587bfc31ce188a8c229445c22ba7252e1d288c16841f972d87975b438",
		"scrypt:4194304:8:1$v0GGKq0YNOQ9GtD0$21824d26992edc5dbf55d788ec6249f51e00f0b6955d262b5acbd01ab82510843fd5e41587bfc31ce188a8c229445c22ba7252e1d288c16841f972d87975b438",
		"scrypt:16384:8$v0GGKq0YNOQ9GtD0$21824d26",
	}
	for _, h := range bad {
		require.False(t, Verify(pwASCII, h), h)
	}
}
