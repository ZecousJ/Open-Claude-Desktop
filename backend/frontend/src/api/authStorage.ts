/**
 * CLAUDEX: W-CONSOLE where the console keeps its sign-in tokens.
 *
 * The console (/admin) shares its origin with the Claudex web app, so its
 * tokens live in sessionStorage instead of localStorage: they are scoped to
 * the tab and gone when it closes, which narrows what a script running
 * elsewhere on the origin could read later (W-SRV design 4.3).
 *
 * Keys keep their upstream names. `pending_auth_session` (third-party sign-in
 * in progress) stays in localStorage because that flow may finish in another tab.
 */

export const AUTH_TOKEN_KEY = 'auth_token'
export const AUTH_USER_KEY = 'auth_user'
export const REFRESH_TOKEN_KEY = 'refresh_token'
export const TOKEN_EXPIRES_AT_KEY = 'token_expires_at'

export const AUTH_STORAGE_KEYS = [AUTH_TOKEN_KEY, AUTH_USER_KEY, REFRESH_TOKEN_KEY, TOKEN_EXPIRES_AT_KEY] as const

/** The storage holding the console tokens. Resolved per call so tests can swap it. */
export function authStorage(): Storage {
  return globalThis.sessionStorage
}

/** Removes every console token from this tab. */
export function clearAuthStorage(): void {
  const storage = authStorage()
  for (const key of AUTH_STORAGE_KEYS) {
    storage.removeItem(key)
  }
}

let legacyPurged = false

/**
 * Drops tokens an older console build left in localStorage. They are never
 * read again, and leaving them would keep a long-lived admin refresh token
 * readable on the shared origin. Runs once per page load.
 */
export function purgeLegacyAuthStorage(): void {
  if (legacyPurged) return
  legacyPurged = true
  try {
    for (const key of AUTH_STORAGE_KEYS) {
      globalThis.localStorage?.removeItem(key)
    }
  } catch {
    // Storage may be unavailable (privacy mode); nothing to purge then.
  }
}
