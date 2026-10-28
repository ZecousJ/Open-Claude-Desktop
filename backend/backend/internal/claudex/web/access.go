package web

import "context"

// CheckWebAccess reports whether the user may use the web app right now: nil,
// or the 403 CLAUDEX_WEB_DISABLED / CLAUDEX_WEB_NOT_ALLOWED error. The web
// relay (W-RELAY, internal/claudex/webhost) calls it for every RPC call,
// upload, preview and events socket, so it reads the cached setting (an
// admin PUT invalidates the cache at once).
func (c *Component) CheckWebAccess(ctx context.Context, userID int64, email string, isAdmin bool) error {
	s := c.setting.Cached(ctx)
	if !s.Enabled {
		return errDisabled
	}
	if !s.allows(userID, email, isAdmin) {
		return errNotAllowed
	}
	return nil
}
