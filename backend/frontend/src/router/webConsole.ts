/**
 * CLAUDEX: route rules for the public setting web_console_admin_only.
 *
 * With the setting on (the default), the web console is for administrators:
 * everyone else may only open the pages below (sign-in, first-run setup, legal
 * documents, password reset, sign-in callbacks, the payment result and the
 * desktop checkout page the desktop app opens in the browser) and is otherwise
 * sent to the Claudex web app at / (signed in) or /admin/login (signed out).
 * CLAUDEX: W-CONSOLE the console lives under /admin; root paths other than the
 * console root pages belong to the web app. Administrators keep
 * every page. The router (router/index.ts) calls these helpers; the setting
 * itself is read by stores/webConsole.ts and never restricts the JSON API.
 */

export const DESKTOP_ONLY_PATH = '/desktop-only'
/** Public checkout page for Stripe/Airwallex orders placed in the desktop app (B10). */
export const DESKTOP_CHECKOUT_PATH = '/desktop-pay'

/**
 * Pages anyone may open while the web console is for admins only. An entry
 * also covers its sub-paths ('/legal' covers '/legal/terms').
 *
 * The upstream /payment/stripe, /payment/airwallex and /payment/stripe-popup
 * pages are left out on purpose: they need a web session (or the web
 * checkout's localStorage) that a desktop user does not have in the browser,
 * and /payment/stripe takes the client_secret in its URL. Desktop orders are
 * paid on /desktop-pay instead.
 */
// CLAUDEX: W-CONSOLE sign-in, setup and forgot-password moved under /admin
export const ADMIN_ONLY_WEB_ALLOWED_PATHS: readonly string[] = [
  '/admin/login',
  '/admin/setup',
  '/admin/forgot-password',
  '/reset-password',
  '/legal',
  DESKTOP_ONLY_PATH,
  DESKTOP_CHECKOUT_PATH,
  '/payment/result',
  '/auth/wechat/payment/callback',
  // Alias of /auth/callback and the default return page of GitHub/Google sign-in,
  // which the upstream callback list (matched on the route path) does not name.
  '/auth/oauth/callback'
]

/** Route lists owned by the upstream router that these rules reuse. */
export interface AdminOnlyRouteLists {
  /** Sign-in callback pages (the router's BACKEND_MODE_CALLBACK_PATHS), matched exactly. */
  callbackPaths: readonly string[]
  /** Pages allowed while a third-party sign-in is pending (BACKEND_MODE_PENDING_AUTH_PATHS). */
  pendingAuthPaths: readonly string[]
}

export interface WebConsoleAccess {
  /** web_console_admin_only; true unless the server said false. */
  adminOnly: boolean
  isAuthenticated: boolean
  isAdmin: boolean
  hasPendingAuthSession: boolean
}

/** Paths compare case-insensitively (like the router) and ignore a trailing slash. */
function normalizePath(path: string): string {
  const lower = (path || '/').toLowerCase()
  return lower.length > 1 && lower.endsWith('/') ? lower.replace(/\/+$/, '') || '/' : lower
}

function matchesPrefix(path: string, prefix: string): boolean {
  const p = prefix.toLowerCase()
  return path === p || path.startsWith(`${p}/`)
}

function isSignedInAdmin(access: WebConsoleAccess): boolean {
  return access.isAuthenticated && access.isAdmin
}

/** Whether a non-admin (signed in or not) may open this public page while the console is for admins only. */
export function isAdminOnlyWebRouteAllowed(
  path: string,
  hasPendingAuthSession: boolean,
  lists: AdminOnlyRouteLists
): boolean {
  const p = normalizePath(path)
  if (ADMIN_ONLY_WEB_ALLOWED_PATHS.some((allowed) => matchesPrefix(p, allowed))) {
    return true
  }
  if (lists.callbackPaths.some((callback) => p === callback.toLowerCase())) {
    return true
  }
  return hasPendingAuthSession && lists.pendingAuthPaths.some((pending) => p === pending.toLowerCase())
}

/** CLAUDEX: W-CONSOLE the Claudex web app (the root of the site, served outside this SPA). */
export const WEB_APP_PATH = '/'
/** CLAUDEX: W-CONSOLE console sign-in page. */
export const CONSOLE_LOGIN_PATH = '/admin/login'

/**
 * Where a blocked visitor goes while the console is for admins only: admins
 * to the admin dashboard, signed-in non-admins to the web app (`/`, a
 * full-page load outside this SPA), everyone else to the console sign-in.
 * Returns null when the setting is off.
 */
export function resolveAdminOnlyRootPath(access: WebConsoleAccess): string | null {
  if (!access.adminOnly) return null
  if (isSignedInAdmin(access)) return '/admin/dashboard'
  return access.isAuthenticated ? WEB_APP_PATH : CONSOLE_LOGIN_PATH // CLAUDEX: W-CONSOLE
}

/**
 * Redirect for a public route (meta.requiresAuth === false), or null to let
 * the upstream rules decide. `redirectedFrom` is the path the navigation was
 * redirected from ('/admin' for the console root redirect).
 *
 * CLAUDEX: W-CONSOLE a result of WEB_APP_PATH ('/') is not a console route:
 * the router turns it into a full-page load of the web app.
 */
export function resolveAdminOnlyPublicRedirect(
  to: { path: string; redirectedFrom?: string | null },
  access: WebConsoleAccess,
  lists: AdminOnlyRouteLists
): string | null {
  if (!access.adminOnly) return null
  if (to.redirectedFrom != null && normalizePath(to.redirectedFrom) === '/admin') { // CLAUDEX: W-CONSOLE
    const root = resolveAdminOnlyRootPath(access)
    if (root && normalizePath(root) !== normalizePath(to.path)) return root
  }
  if (isSignedInAdmin(access)) return null

  const path = normalizePath(to.path)
  // CLAUDEX: W-CONSOLE signed-in non-admins go to the web app instead of /desktop-only
  if (access.isAuthenticated && (path === CONSOLE_LOGIN_PATH || path === '/admin/register')) {
    return WEB_APP_PATH
  }
  if (isAdminOnlyWebRouteAllowed(path, access.hasPendingAuthSession, lists)) {
    return null
  }
  return access.isAuthenticated ? WEB_APP_PATH : CONSOLE_LOGIN_PATH
}

/**
 * Redirect for a signed-in user on a protected route, or null. Runs before
 * the upstream admin check, whose '/admin/my/dashboard' fallback would loop for a
 * non-admin while the user pages are closed.
 */
export function resolveAdminOnlyProtectedRedirect(access: WebConsoleAccess): string | null {
  if (!access.adminOnly || !access.isAuthenticated || access.isAdmin) return null
  return WEB_APP_PATH // CLAUDEX: W-CONSOLE
}

/**
 * Where a successful web sign-in continues. Admins go to the `redirect`
 * query (an in-app path) or the admin dashboard. While the console is for
 * admins only, a non-admin is signed out of this console session (their web
 * app and desktop sessions are not affected) and sent to the web app at `/`
 * with a full-page load; otherwise the upstream default applies (`redirect`
 * or /admin/my/dashboard).
 */
export function resolvePostLoginTarget(input: {
  isAdmin: boolean
  adminOnly: boolean
  redirect?: unknown
}): { path: string; signOut: boolean } {
  const redirect = safeInAppRedirect(input.redirect)
  if (input.isAdmin) {
    return { path: redirect ?? '/admin/dashboard', signOut: false }
  }
  if (input.adminOnly) {
    return { path: WEB_APP_PATH, signOut: true } // CLAUDEX: W-CONSOLE
  }
  return { path: redirect ?? '/admin/my/dashboard', signOut: false } // CLAUDEX: W-CONSOLE
}

/**
 * Accepts only an in-app absolute path ('/x'), never '//host' or a URL. Control
 * characters are refused too: URL parsing drops tabs and newlines, so '/\t/host'
 * would otherwise become '//host'.
 */
function safeInAppRedirect(value: unknown): string | null {
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.startsWith('/\\')) return null
  return trimmed
}
