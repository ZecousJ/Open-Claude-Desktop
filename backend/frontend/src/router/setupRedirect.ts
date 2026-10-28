export function resolveCompletedSetupRedirectPath(
  isAuthenticated: boolean,
  isAdmin: boolean,
  adminOnly = false // CLAUDEX: web_console_admin_only (router/webConsole.ts)
): string {
  if (!isAuthenticated) {
    return '/admin/login' // CLAUDEX: W-CONSOLE
  }

  // CLAUDEX: while the web console is for admins only, a signed-in non-admin goes to the web app (W-CONSOLE: was /desktop-only)
  if (adminOnly && !isAdmin) {
    return '/'
  }

  return isAdmin ? '/admin/dashboard' : '/admin/my/dashboard' // CLAUDEX: W-CONSOLE
}
