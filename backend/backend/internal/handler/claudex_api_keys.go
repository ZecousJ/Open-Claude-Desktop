package handler

// CLAUDEX: file added by the Claudex fork (see backend/CLAUDEX_CHANGES.md).
//
// H13: guards on the user API-key endpoints (/api/v1/keys) and on the usage
// records that embed API keys (/api/v1/usage):
//   - a Claudex device key (claudex_devices.api_key_id, B4) is read-only for
//     its user: PUT and DELETE answer 403 CLAUDEX_DEVICE_KEY_MANAGED, and every
//     answer shows it masked; its plaintext only ever appears in the
//     POST /api/v1/claudex/devices response (owner decisions 13 and 14);
//   - creating keys through /api/v1/keys is off for non-admins unless the
//     administrator turns it on (owner decision 17); device keys are created
//     by B4 through the service and never pass this handler.
// Admin endpoints are not affected. Without the Claudex module every helper
// is a no-op.

import (
	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	claudexhook "github.com/Wei-Shaw/sub2api/internal/claudex/hook"
	"github.com/Wei-Shaw/sub2api/internal/handler/dto"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	middleware2 "github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
)

// claudexRefuseAPIKeyCreate answers the creation refusal and reports whether
// it did.
func claudexRefuseAPIKeyCreate(c *gin.Context, userID int64) bool {
	role, _ := middleware2.GetUserRoleFromContext(c)
	if err := claudexhook.CreateAPIKeyAllowed(c.Request.Context(), userID, role == service.RoleAdmin); err != nil {
		response.ErrorFrom(c, err)
		return true
	}
	return false
}

// claudexRefuseManagedKey answers 403 CLAUDEX_DEVICE_KEY_MANAGED when keyID is
// one of the user's Claudex device keys, and reports whether it did.
func claudexRefuseManagedKey(c *gin.Context, userID, keyID int64) bool {
	if claudexhook.ManagedAPIKey(c.Request.Context(), userID, keyID) {
		response.ErrorFrom(c, core.ErrDeviceKeyManaged)
		return true
	}
	return false
}

// claudexMaskManagedKeys masks the device keys among keys in place.
func claudexMaskManagedKeys(c *gin.Context, userID int64, keys ...*dto.APIKey) {
	ids := make([]int64, 0, len(keys))
	for _, k := range keys {
		if k != nil {
			ids = append(ids, k.ID)
		}
	}
	if len(ids) == 0 {
		return
	}
	managed := claudexhook.ManagedAPIKeyIDs(c.Request.Context(), userID, ids)
	for _, k := range keys {
		if k != nil && managed[k.ID] {
			k.Key = claudexhook.MaskKey(k.Key)
		}
	}
}

// claudexMaskKeyList masks the device keys of a list answer in place.
func claudexMaskKeyList(c *gin.Context, userID int64, keys []dto.APIKey) {
	ptrs := make([]*dto.APIKey, 0, len(keys))
	for i := range keys {
		ptrs = append(ptrs, &keys[i])
	}
	claudexMaskManagedKeys(c, userID, ptrs...)
}

// claudexMaskKey masks key when it is a device key and returns it.
func claudexMaskKey(c *gin.Context, userID int64, key *dto.APIKey) *dto.APIKey {
	claudexMaskManagedKeys(c, userID, key)
	return key
}

// claudexMaskUsageLogKeys masks the device keys embedded in usage records of
// the signed-in user.
func claudexMaskUsageLogKeys(c *gin.Context, logs ...*dto.UsageLog) {
	subject, ok := middleware2.GetAuthSubjectFromContext(c)
	if !ok {
		return
	}
	keys := make([]*dto.APIKey, 0, len(logs))
	for _, l := range logs {
		if l != nil && l.APIKey != nil {
			keys = append(keys, l.APIKey)
		}
	}
	claudexMaskManagedKeys(c, subject.UserID, keys...)
}

// claudexMaskUsageLogList is claudexMaskUsageLogKeys for a list answer.
func claudexMaskUsageLogList(c *gin.Context, logs []dto.UsageLog) {
	ptrs := make([]*dto.UsageLog, 0, len(logs))
	for i := range logs {
		ptrs = append(ptrs, &logs[i])
	}
	claudexMaskUsageLogKeys(c, ptrs...)
}

// claudexMaskUsageLog is claudexMaskUsageLogKeys for one record.
func claudexMaskUsageLog(c *gin.Context, l *dto.UsageLog) *dto.UsageLog {
	claudexMaskUsageLogKeys(c, l)
	return l
}
