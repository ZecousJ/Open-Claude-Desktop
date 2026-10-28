package sharing

import (
	"net/http"

	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
)

// Errors of the sharing API (design R1 2.1). The desktop app maps the reasons
// to its own messages; the console maps them to admin.claudexSharing.errors.
var (
	// ErrSharingDisabled: the administrator has not turned sharing on.
	ErrSharingDisabled = infraerrors.Forbidden("CLAUDEX_SHARING_DISABLED",
		"Sharing is turned off on this server.")
	// ErrKindDisabled: sharing this kind (conversations or artifacts) is off.
	ErrKindDisabled = infraerrors.Forbidden("CLAUDEX_SHARING_KIND_DISABLED",
		"Sharing this kind of content is turned off on this server.")
	// ErrUserBlocked: the administrator turned sharing off for this account.
	ErrUserBlocked = infraerrors.Forbidden("CLAUDEX_SHARING_USER_BLOCKED",
		"Your administrator has turned off sharing for your account.")
	// ErrTooLarge: the snapshot or one artifact is over the size limit.
	ErrTooLarge = infraerrors.New(http.StatusRequestEntityTooLarge, "CLAUDEX_SHARE_TOO_LARGE",
		"This content is too large to share.")
	// ErrQuota: the user has as many live shares as allowed.
	ErrQuota = infraerrors.Conflict("CLAUDEX_SHARE_QUOTA",
		"You have reached the maximum number of shared links. Stop sharing something first.")
	// ErrShareNotFound: no live share with that id belongs to the user.
	ErrShareNotFound = infraerrors.NotFound("CLAUDEX_SHARE_NOT_FOUND",
		"That shared link doesn't exist or was deleted.")
	// ErrShareDisabled: the administrator took this share down, so it cannot
	// be updated (the author can still stop sharing it).
	ErrShareDisabled = infraerrors.Conflict("CLAUDEX_SHARE_DISABLED",
		"This shared link was removed by the administrator.")
	// ErrReportNotFound: no report with that id (admin).
	ErrReportNotFound = infraerrors.NotFound("CLAUDEX_SHARE_REPORT_NOT_FOUND",
		"That report doesn't exist.")
	// ErrUnavailable: the server has no database for sharing (tests, broken
	// deployments).
	ErrUnavailable = infraerrors.ServiceUnavailable("CLAUDEX_SHARING_UNAVAILABLE",
		"Sharing is unavailable on this server right now.")
	errStoreFailed = infraerrors.InternalServer("CLAUDEX_SHARING_STORE_FAILED",
		"Couldn't read or save shared links. Try again later.")
	errSettingsFailed = infraerrors.InternalServer("CLAUDEX_SHARING_SETTINGS_FAILED",
		"Couldn't read or save the sharing settings.")
)

// invalidShare is the 400 for a malformed share request (metadata: field).
func invalidShare(field, message string) error {
	return infraerrors.BadRequest("CLAUDEX_SHARE_INVALID", message).
		WithMetadata(map[string]string{"field": field})
}

// tooLarge is ErrTooLarge with the limit that was exceeded.
func tooLarge(field string, limit int64) error {
	return ErrTooLarge.WithMetadata(map[string]string{"field": field, "limit_bytes": itoa64(limit)})
}

func invalidReport(field string) error {
	return infraerrors.BadRequest("CLAUDEX_SHARE_REPORT_INVALID", "Invalid report: "+field+".").
		WithMetadata(map[string]string{"field": field})
}

func invalidFilter(field string) error {
	return infraerrors.BadRequest("CLAUDEX_SHARE_FILTER_INVALID", "Invalid filter: "+field+".").
		WithMetadata(map[string]string{"field": field})
}
