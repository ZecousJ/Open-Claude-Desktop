package signin

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

// Email code limits.
const (
	codeTTL      = 10 * time.Minute
	sendCooldown = 60 * time.Second
	sendsPerHour = 10
	sendWindow   = time.Hour
	maxAttempts  = 5
	codeDigits   = 6
)

const keyPrefix = "claudex:signin:"

// errNoCode: no matching code (none sent, expired or out of attempts).
var errNoCode = errors.New("signin: no usable code")
var errUsedCode = errors.New("signin: code already used")

// codeStore keeps the email codes in Redis. Nothing in Redis names the
// address: keys use an HMAC of it, and the code is stored only as an HMAC of
// the address and the code with a server key.
type codeStore struct {
	rdb *redis.Client
	key []byte
}

// newCode returns a uniformly random 6-digit code from crypto/rand.
func newCode() (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%0*d", codeDigits, n.Int64()), nil
}

// validCode reports whether s is exactly 6 ASCII digits.
func validCode(s string) bool {
	if len(s) != codeDigits {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

func (s *codeStore) mac(parts ...string) string {
	m := hmac.New(sha256.New, s.key)
	for _, p := range parts {
		m.Write([]byte(p))
		m.Write([]byte{0})
	}
	return hex.EncodeToString(m.Sum(nil))
}

// id names an address in Redis keys.
func (s *codeStore) id(email string) string { return s.mac("id", email)[:40] }

// codeHash is what is stored for a code sent to email.
func (s *codeStore) codeHash(email, code string) string { return s.mac("code", email, code) }

func codeKey(id string) string     { return keyPrefix + "code:" + id }
func cooldownKey(id string) string { return keyPrefix + "cool:" + id }
func hourKey(id string) string     { return keyPrefix + "hour:" + id }

// reserveSendScript applies the per-address cooldown and hourly cap. It
// returns 0 when a send may go ahead (and starts the cooldown), otherwise the
// milliseconds to wait.
var reserveSendScript = redis.NewScript(`
local ttl = redis.call('PTTL', KEYS[1])
if ttl > 0 then return ttl end
local n = redis.call('INCR', KEYS[2])
if n == 1 then redis.call('PEXPIRE', KEYS[2], ARGV[2]) end
if n > tonumber(ARGV[3]) then
  local left = redis.call('PTTL', KEYS[2])
  if left < 1 then left = tonumber(ARGV[2]) end
  return left
end
redis.call('SET', KEYS[1], '1', 'PX', ARGV[1])
return 0
`)

// reserveSend returns 0 when a code may be sent to the address now, or how
// long to wait. The cooldown and cap count every request for the address,
// whether or not an account uses it.
func (s *codeStore) reserveSend(ctx context.Context, id string) (time.Duration, error) {
	ms, err := reserveSendScript.Run(ctx, s.rdb, []string{cooldownKey(id), hourKey(id)},
		sendCooldown.Milliseconds(), sendWindow.Milliseconds(), sendsPerHour).Int64()
	if err != nil {
		return 0, err
	}
	return time.Duration(ms) * time.Millisecond, nil
}

// save stores a new code for the address, replacing any earlier one.
func (s *codeStore) save(ctx context.Context, id, hash string, userID int64, binding ...string) error {
	k := codeKey(id)
	_, err := s.rdb.TxPipelined(ctx, func(p redis.Pipeliner) error {
		p.Del(ctx, k)
		p.HSet(ctx, k, "h", hash, "u", strconv.FormatInt(userID, 10), "a", 0)
		// A link needs both the emailed code and the requesting window's proof.
		if len(binding) > 0 && binding[0] != "" {
			p.HSet(ctx, k, "binding", binding[0])
		}
		p.PExpire(ctx, k, codeTTL)
		return nil
	})
	return err
}

// takeAttemptScript spends one attempt before the code is compared, so at
// most maxAttempts comparisons ever run for a code, even concurrently. It
// returns {hash, user id, attempt} (-1 when spent), or nil without a code.
var takeAttemptScript = redis.NewScript(`
if redis.call('EXISTS', KEYS[1]) == 0 then return false end
if ARGV[2] ~= '' and redis.call('HGET', KEYS[1], 'binding') ~= ARGV[2] then return false end
if redis.call('HGET', KEYS[1], 'used') == '1' then
  return {redis.call('HGET', KEYS[1], 'h'), redis.call('HGET', KEYS[1], 'u'), -1}
end
local n = redis.call('HINCRBY', KEYS[1], 'a', 1)
if n > tonumber(ARGV[1]) then
  return false
end
return {redis.call('HGET', KEYS[1], 'h'), redis.call('HGET', KEYS[1], 'u'), n}
`)

// deleteIfScript deletes the code only while it is still the one compared
// (a newer send replaced it otherwise). Returns 1 when it deleted.
var deleteIfScript = redis.NewScript(`
if redis.call('HGET', KEYS[1], 'h') == ARGV[1] and redis.call('HGET', KEYS[1], 'used') ~= '1' then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
`)

// (live claude.ai bundle, 2026-10-14, c19e49841-CY7h9R_N.js)
var spendIfScript = redis.NewScript(`
if redis.call('HGET', KEYS[1], 'h') ~= ARGV[1] then return 0 end
if ARGV[2] ~= '' and redis.call('HGET', KEYS[1], 'binding') ~= ARGV[2] then return 0 end
if redis.call('HGET', KEYS[1], 'used') == '1' then return -1 end
redis.call('HSET', KEYS[1], 'used', '1')
return 1
`)

// verify checks code for email. On success the code is spent and the user id
// it was sent for is returned; a wrong code spends an attempt and the last
// allowed attempt voids the code.
func (s *codeStore) verify(ctx context.Context, email, code string, binding ...string) (int64, error) {
	id := s.id(email)
	k := codeKey(id)
	proof := ""
	if len(binding) > 0 {
		proof = binding[0]
	}
	res, err := takeAttemptScript.Run(ctx, s.rdb, []string{k}, maxAttempts, proof).Slice()
	if errors.Is(err, redis.Nil) {
		return 0, errNoCode
	}
	if err != nil {
		return 0, err
	}
	if len(res) != 3 {
		return 0, errNoCode
	}
	stored, _ := res[0].(string)
	uidText, _ := res[1].(string)
	attempt, _ := res[2].(int64)
	if stored == "" {
		return 0, errNoCode
	}
	if !hmac.Equal([]byte(stored), []byte(s.codeHash(email, code))) {
		if attempt >= maxAttempts {
			if _, err := deleteIfScript.Run(ctx, s.rdb, []string{k}, stored).Int(); err != nil {
				return 0, err
			}
		}
		return 0, errNoCode
	}
	if attempt == -1 {
		return 0, errUsedCode
	}
	deleted, err := spendIfScript.Run(ctx, s.rdb, []string{k}, stored, proof).Int()
	if err != nil {
		return 0, err
	}
	if deleted == -1 {
		return 0, errUsedCode
	}
	if deleted != 1 {
		// Replaced or voided in the meantime.
		return 0, errNoCode
	}
	uid, err := strconv.ParseInt(uidText, 10, 64)
	if err != nil || uid <= 0 {
		return 0, errNoCode
	}
	return uid, nil
}
