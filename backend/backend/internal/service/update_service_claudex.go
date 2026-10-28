package service

// CLAUDEX: file added by the Claudex fork (see backend/CLAUDEX_CHANGES.md).
//
// Upstream Sub2API updates itself in place from the Wei-Shaw/sub2api GitHub
// releases. A Claudex server runs a modified fork, so installing an upstream
// release would silently drop every Claudex change. The production wiring
// (ProvideUpdateService) therefore turns online update and rollback off; the
// admin console shows the version with an "online update disabled" notice.

import infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"

// ErrSelfUpdateDisabled is returned by the update and rollback operations when
// online update is turned off.
var ErrSelfUpdateDisabled = infraerrors.Forbidden(
	"SELF_UPDATE_DISABLED",
	"online update is disabled in the Claudex build of Sub2API; deploy a new Claudex backend build instead",
)

// DisableSelfUpdate turns off online update and rollback for this service:
// CheckUpdate reports the running version without contacting GitHub,
// ListRollbackVersions returns an empty list, and PerformUpdate, Rollback and
// RollbackToVersion return ErrSelfUpdateDisabled without touching the binary.
func (s *UpdateService) DisableSelfUpdate() *UpdateService {
	s.selfUpdateDisabled = true
	return s
}

// SelfUpdateDisabled reports whether online update is turned off.
func (s *UpdateService) SelfUpdateDisabled() bool {
	return s != nil && s.selfUpdateDisabled
}

func (s *UpdateService) disabledUpdateInfo() *UpdateInfo {
	return &UpdateInfo{
		CurrentVersion: s.currentVersion,
		LatestVersion:  s.currentVersion,
		HasUpdate:      false,
		BuildType:      s.buildType,
		UpdateDisabled: true,
	}
}
