package webstore

import (
	"context"
	"os"
	"path/filepath"
	"strings"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
)

// Storage limits. The per-user quota and the per-file limit are read from
// the claudex_web setting (owned by the web component; the console's Web app
// page edits it): storage_quota_mb (default 1024) and max_upload_mb
// (default 30). Missing or out-of-range values fall back to the defaults.
const (
	DefaultQuotaMB   = 1024
	DefaultMaxFileMB = 30
	maxQuotaMB       = 1 << 20 // 1 TiB
	maxFileMBLimit   = 1 << 12 // 4 GiB

	// Documents may go this far past the quota before turn writes are
	// refused too (new conversations, projects and files stop at the quota
	// itself), so a reply that is streaming when the quota is reached can
	// still be saved.
	docGraceNum, docGraceDen = 11, 10

	settingsBytes       = 1 << 20 // one settings document
	projectBytes        = 1 << 20 // one project
	conversationBytes   = 1 << 20 // one conversation row (turns are separate)
	artifactBytes       = webproto.TurnDocBytes
	maxArtifactVersions = 20
	searchTextBytes     = 64 << 10 // search text kept per turn

	// Pages of the list ops: the runner link carries frames of at most
	// webproto.LinkFrameBytes.
	pageRows  = 200
	pageBytes = 8 << 20

	// files.get answers at most this much per request (the runner asks for
	// 4 MiB); files.put takes at most this much per request.
	fileReadBytes  = 4 << 20
	fileWriteBytes = 8 << 20

	maxNameBytes = 255
	maxMimeBytes = 128
	maxKeys      = 2000 // turn keys in one turns.delete
	maxTurnsPut  = 2000 // turns in one turns.put
	searchLimit  = 50
	maxQuery     = 200
)

// quotaView is the part of the claudex_web setting this component reads.
type quotaView struct {
	StorageQuotaMB int64 `json:"storage_quota_mb"`
	MaxUploadMB    int64 `json:"max_upload_mb"`
}

func defaultQuota() quotaView {
	return quotaView{StorageQuotaMB: DefaultQuotaMB, MaxUploadMB: DefaultMaxFileMB}
}

func normalizeQuota(q *quotaView) {
	if q.StorageQuotaMB <= 0 || q.StorageQuotaMB > maxQuotaMB {
		q.StorageQuotaMB = DefaultQuotaMB
	}
	if q.MaxUploadMB <= 0 || q.MaxUploadMB > maxFileMBLimit {
		q.MaxUploadMB = DefaultMaxFileMB
	}
}

// Limits are the effective storage limits of every user.
type Limits struct {
	QuotaBytes   int64 `json:"quota_bytes"`
	MaxFileBytes int64 `json:"max_file_bytes"`
}

// SettingKey is the setting the limits come from (read only here; the web
// component owns and writes it).
const SettingKey = "claudex_web"

// Limits returns the current limits (cached for 60 s like every setting).
func (c *Component) Limits(ctx context.Context) Limits {
	if c.limits != nil {
		return c.limits(ctx)
	}
	q := defaultQuota()
	if c.quota != nil {
		q = c.quota.Cached(ctx)
	}
	return Limits{QuotaBytes: q.StorageQuotaMB << 20, MaxFileBytes: q.MaxUploadMB << 20}
}

func newQuotaSetting(env *core.Env) *core.JSONSetting[quotaView] {
	if env == nil || env.SettingRepo == nil {
		return nil
	}
	return core.NewJSONSetting(env.SettingRepo, SettingKey, defaultQuota, core.WithNormalize(normalizeQuota))
}

// DirEnv overrides where file bytes are kept.
const DirEnv = "CLAUDEX_WEB_STORE_DIR"

// defaultDir is $CLAUDEX_WEB_STORE_DIR, else $DATA_DIR/claudex-web/files,
// else ./data/claudex-web/files.
func defaultDir() string {
	if d := strings.TrimSpace(os.Getenv(DirEnv)); d != "" {
		return filepath.Clean(d)
	}
	base := strings.TrimSpace(os.Getenv("DATA_DIR"))
	if base == "" {
		base = "./data"
	}
	return filepath.Join(base, "claudex-web", "files")
}
