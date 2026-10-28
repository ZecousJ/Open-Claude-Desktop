package signin

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
)

// (live claude.ai bundle, 2026-10-14, shared-23-RHw-hr47.js, cc408eae6-CNTekrOx.js)
func (c *Component) actionSession(g *gin.Context) string {
	uid, _ := core.Subject(g)
	sid := core.SessionID(g)
	if sid == "" {
		sid = g.GetHeader("Authorization")
	}
	if uid == 0 || sid == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(strconv.FormatInt(uid, 10) + "\x00" + sid))
	return "claudex:action:" + hex.EncodeToString(sum[:])
}

func actionError(g *gin.Context, status int, code, label string, seconds int64) {
	g.Header("Cache-Control", "no-store")
	if seconds > 0 {
		g.Header("Retry-After", strconv.FormatInt(seconds, 10))
	}
	g.AbortWithStatusJSON(status, gin.H{"code": status, "reason": code, "message": "Confirm it’s you", "metadata": gin.H{"action_label": label, "retry_after_seconds": seconds}})
}

func (c *Component) ActionVerificationGuard(label string) gin.HandlerFunc {
	return func(g *gin.Context) {
		key := c.actionSession(g)
		if key != "" && c.env.Redis != nil {
			verified, err := c.env.Redis.Exists(g.Request.Context(), key+":verified").Result()
			if err == nil && verified == 1 {
				g.Next()
				return
			}
		}
		actionError(g, http.StatusForbidden, "action_verification_required", label, 0)
	}
}

func (c *Component) RegisterUserRoutes(g *gin.RouterGroup) {
	g.POST("/action-verification/send", c.actionSend)
	g.POST("/action-verification/confirm", c.actionConfirm)
}

func (c *Component) actionUser(g *gin.Context) (*service.User, string) {
	uid, ok := core.Subject(g)
	key := c.actionSession(g)
	if !ok || key == "" || c.env.Redis == nil || c.env.UserRepo == nil {
		actionError(g, 503, "unavailable", "", 0)
		return nil, ""
	}
	u, err := c.env.UserRepo.GetByID(g.Request.Context(), uid)
	if err != nil || u == nil || !u.IsActive() {
		actionError(g, 401, "unauthorized", "", 0)
		return nil, ""
	}
	if strings.TrimSpace(u.Email) == "" {
		actionError(g, 400, "no_email_address", "", 0)
		return nil, ""
	}
	return u, key
}

func (c *Component) actionSend(g *gin.Context) {
	u, key := c.actionUser(g)
	if u == nil {
		return
	}
	ctx := g.Request.Context()
	store := c.codes()
	wait, err := store.reserveSend(ctx, "action:"+store.id(u.Email))
	if err != nil {
		actionError(g, 503, "unavailable", "", 0)
		return
	}
	if wait > 0 {
		actionError(g, 429, "challenge_rate_limited", "", int64((wait+time.Second-1)/time.Second))
		return
	}
	code, err := newCode()
	if err != nil {
		actionError(g, 503, "unavailable", "", 0)
		return
	}
	hash := store.codeHash(key+"\x00"+u.Email, code)
	_, err = c.env.Redis.TxPipelined(ctx, func(p redis.Pipeliner) error {
		p.Del(ctx, key)
		p.HSet(ctx, key, "h", hash, "a", 0)
		p.Expire(ctx, key, codeTTL)
		return nil
	})
	if err != nil {
		actionError(g, 503, "unavailable", "", 0)
		return
	}
	body := service.ClaudexEmailHTML(service.ClaudexEmailLayout{SiteName: "Claudex", Title: "Confirm it’s you", Content: service.ClaudexEmailCode(code)})
	if err := c.mail(ctx, u.Email, "Confirm it’s you", body); err != nil {
		deleteIfScript.Run(ctx, c.env.Redis, []string{key}, hash)
		actionError(g, 503, "code_not_sent", "", 0)
		return
	}
	g.Header("Cache-Control", "no-store")
	// Only the masked destination is returned to the clients.
	response.Success(g, gin.H{"code_length": 6, "retry_after_seconds": 60, "expires_in_seconds": 600, "masked_email": maskEmail(u.Email)})
}

func maskEmail(email string) string {
	parts := strings.SplitN(strings.TrimSpace(email), "@", 2)
	if len(parts) != 2 || parts[0] == "" {
		return "your email address"
	}
	local := parts[0]
	if len(local) == 1 {
		return "*@" + parts[1]
	}
	return local[:1] + strings.Repeat("*", min(5, len(local)-1)) + "@" + parts[1]
}

var confirmActionScript = redis.NewScript(`
if redis.call('EXISTS', KEYS[1]) == 0 then return 'challenge_expired' end
if tonumber(redis.call('HGET', KEYS[1], 'a')) >= 5 then return 'challenge_locked' end
if redis.call('HGET', KEYS[1], 'used') == '1' then return 'challenge_expired' end
local attempts = redis.call('HINCRBY', KEYS[1], 'a', 1)
if redis.call('HGET', KEYS[1], 'h') ~= ARGV[1] then
  if attempts >= 5 then return 'challenge_locked' end
  return 'invalid_code'
end
redis.call('HSET', KEYS[1], 'used', '1')
redis.call('SET', KEYS[2], '1', 'EX', 600)
return 'verified'
`)

func (c *Component) actionConfirm(g *gin.Context) {
	u, key := c.actionUser(g)
	if u == nil {
		return
	}
	g.Request.Body = http.MaxBytesReader(g.Writer, g.Request.Body, 1024)
	var input struct {
		Code string `json:"code"`
	}
	if err := g.ShouldBindJSON(&input); err != nil || !validCode(input.Code) {
		actionError(g, 400, "invalid_code", "", 0)
		return
	}
	result, err := confirmActionScript.Run(g.Request.Context(), c.env.Redis, []string{key, key + ":verified"}, c.codes().codeHash(key+"\x00"+u.Email, input.Code)).Text()
	if err != nil {
		actionError(g, 503, "unavailable", "", 0)
		return
	}
	if result != "verified" {
		actionError(g, 400, result, "", 0)
		return
	}
	g.Header("Cache-Control", "no-store")
	response.Success(g, gin.H{"status": result})
}
