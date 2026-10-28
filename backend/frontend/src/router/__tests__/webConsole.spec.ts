// CLAUDEX: unit tests for the web_console_admin_only rules (router/webConsole.ts),
// the setting store (stores/webConsole.ts) and the public API calls behind them.
// guards.spec.ts runs the same rules through the real router guard.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  ADMIN_ONLY_WEB_ALLOWED_PATHS,
  isAdminOnlyWebRouteAllowed,
  resolveAdminOnlyProtectedRedirect,
  resolveAdminOnlyPublicRedirect,
  resolveAdminOnlyRootPath,
  resolvePostLoginTarget,
  type WebConsoleAccess
} from '@/router/webConsole'
import { resolveCompletedSetupRedirectPath } from '@/router/setupRedirect'

const api = vi.hoisted(() => ({ get: vi.fn() }))

vi.mock('@/api/client', () => ({ apiClient: { get: (...args: unknown[]) => api.get(...args) } }))

// CLAUDEX: W-CONSOLE pending sign-in pages moved under /admin; callbacks stay at the root
const LISTS = {
  callbackPaths: ['/auth/callback', '/auth/linuxdo/callback', '/auth/dingtalk/email-completion'],
  pendingAuthPaths: ['/admin/register', '/admin/email-verify']
}

function access(overrides: Partial<WebConsoleAccess> = {}): WebConsoleAccess {
  return { adminOnly: true, isAuthenticated: false, isAdmin: false, hasPendingAuthSession: false, ...overrides }
}

const anonymous = access()
const user = access({ isAuthenticated: true })
const admin = access({ isAuthenticated: true, isAdmin: true })

describe('isAdminOnlyWebRouteAllowed', () => {
  it.each(ADMIN_ONLY_WEB_ALLOWED_PATHS)('allows %s', (path) => {
    expect(isAdminOnlyWebRouteAllowed(path, false, LISTS)).toBe(true)
  })

  it('allows sub-paths of an entry but not look-alike prefixes', () => {
    expect(isAdminOnlyWebRouteAllowed('/legal/terms', false, LISTS)).toBe(true)
    expect(isAdminOnlyWebRouteAllowed('/admin/login-help', false, LISTS)).toBe(false)
    expect(isAdminOnlyWebRouteAllowed('/legalese', false, LISTS)).toBe(false)
    expect(isAdminOnlyWebRouteAllowed('/admin/payment/qrcode', false, LISTS)).toBe(false)
  })

  it('allows /desktop-pay but not the upstream Stripe and Airwallex pages', () => {
    expect(isAdminOnlyWebRouteAllowed('/desktop-pay', false, LISTS)).toBe(true)
    for (const path of ['/admin/payment/stripe', '/admin/payment/airwallex', '/admin/payment/stripe-popup']) {
      expect(isAdminOnlyWebRouteAllowed(path, false, LISTS), path).toBe(false)
    }
  })

  it('ignores case and a trailing slash', () => {
    expect(isAdminOnlyWebRouteAllowed('/Reset-Password/', false, LISTS)).toBe(true)
    expect(isAdminOnlyWebRouteAllowed('/AUTH/CALLBACK', false, LISTS)).toBe(true)
  })

  it('allows the sign-in callbacks exactly', () => {
    expect(isAdminOnlyWebRouteAllowed('/auth/linuxdo/callback', false, LISTS)).toBe(true)
    expect(isAdminOnlyWebRouteAllowed('/auth/linuxdo/callback/x', false, LISTS)).toBe(false)
  })

  it('allows the pending sign-in pages only with a pending session', () => {
    expect(isAdminOnlyWebRouteAllowed('/admin/register', false, LISTS)).toBe(false)
    expect(isAdminOnlyWebRouteAllowed('/admin/register', true, LISTS)).toBe(true)
    expect(isAdminOnlyWebRouteAllowed('/admin/email-verify', true, LISTS)).toBe(true)
  })

  it('blocks the user pages and the landing pages', () => {
    for (const path of ['/', '/admin', '/admin/home', '/admin/my/dashboard', '/admin/key-usage', '/admin/model-plaza', '/admin/my/profile']) {
      expect(isAdminOnlyWebRouteAllowed(path, false, LISTS), path).toBe(false)
    }
  })
})

describe('resolveAdminOnlyPublicRedirect', () => {
  it('does nothing while the setting is off', () => {
    const off = { ...user, adminOnly: false }
    expect(resolveAdminOnlyPublicRedirect({ path: '/admin/home' }, off, LISTS)).toBeNull()
    expect(resolveAdminOnlyPublicRedirect({ path: '/admin/login' }, off, LISTS)).toBeNull()
    expect(
      resolveAdminOnlyPublicRedirect({ path: '/admin/dashboard', redirectedFrom: '/admin' }, { ...admin, adminOnly: false }, LISTS)
    ).toBeNull()
  })

  // CLAUDEX: W-CONSOLE anonymous visitors go to the console sign-in at /admin/login
  it('sends anonymous visitors of other public pages to /admin/login', () => {
    expect(resolveAdminOnlyPublicRedirect({ path: '/admin/home' }, anonymous, LISTS)).toBe('/admin/login')
    expect(resolveAdminOnlyPublicRedirect({ path: '/admin/login' }, anonymous, LISTS)).toBeNull()
  })

  // CLAUDEX: W-CONSOLE signed-in non-admins go to the web app at '/'
  it('sends signed-in non-admins to the web app, including from /admin/login and /admin/register', () => {
    expect(resolveAdminOnlyPublicRedirect({ path: '/admin/home' }, user, LISTS)).toBe('/')
    expect(resolveAdminOnlyPublicRedirect({ path: '/admin/login' }, user, LISTS)).toBe('/')
    expect(
      resolveAdminOnlyPublicRedirect({ path: '/admin/register' }, { ...user, hasPendingAuthSession: true }, LISTS)
    ).toBe('/')
    expect(resolveAdminOnlyPublicRedirect({ path: '/reset-password' }, user, LISTS)).toBeNull()
    expect(resolveAdminOnlyPublicRedirect({ path: '/desktop-only' }, user, LISTS)).toBeNull()
  })

  it('leaves admins alone except for the /admin root redirect', () => {
    expect(resolveAdminOnlyPublicRedirect({ path: '/admin/home' }, admin, LISTS)).toBeNull()
    expect(resolveAdminOnlyPublicRedirect({ path: '/admin/home', redirectedFrom: '/admin' }, admin, LISTS)).toBe(
      '/admin/dashboard'
    )
  })

  it('maps /admin by viewer', () => {
    expect(resolveAdminOnlyPublicRedirect({ path: '/admin/home', redirectedFrom: '/admin' }, anonymous, LISTS)).toBe(
      '/admin/login'
    )
    expect(resolveAdminOnlyPublicRedirect({ path: '/admin/home', redirectedFrom: '/admin' }, user, LISTS)).toBe('/')
  })

  it('treats a stale admin role without a session as signed out', () => {
    expect(resolveAdminOnlyPublicRedirect({ path: '/admin/home' }, access({ isAdmin: true }), LISTS)).toBe('/admin/login')
  })
})

describe('resolveAdminOnlyRootPath', () => {
  it('follows the setting and the viewer', () => {
    expect(resolveAdminOnlyRootPath({ ...anonymous, adminOnly: false })).toBeNull()
    expect(resolveAdminOnlyRootPath(anonymous)).toBe('/admin/login') // CLAUDEX: W-CONSOLE
    expect(resolveAdminOnlyRootPath(user)).toBe('/')
    expect(resolveAdminOnlyRootPath(admin)).toBe('/admin/dashboard')
  })
})

describe('resolveAdminOnlyProtectedRedirect', () => {
  it('sends only signed-in non-admins to the web app, and only while the setting is on', () => {
    expect(resolveAdminOnlyProtectedRedirect(user)).toBe('/') // CLAUDEX: W-CONSOLE
    expect(resolveAdminOnlyProtectedRedirect(admin)).toBeNull()
    expect(resolveAdminOnlyProtectedRedirect(anonymous)).toBeNull()
    expect(resolveAdminOnlyProtectedRedirect({ ...user, adminOnly: false })).toBeNull()
  })
})

describe('resolvePostLoginTarget', () => {
  it('sends admins to the redirect query or the admin dashboard', () => {
    expect(resolvePostLoginTarget({ isAdmin: true, adminOnly: true })).toEqual({ path: '/admin/dashboard', signOut: false })
    expect(resolvePostLoginTarget({ isAdmin: true, adminOnly: true, redirect: '/admin/users?page=2' })).toEqual({
      path: '/admin/users?page=2',
      signOut: false
    })
    expect(resolvePostLoginTarget({ isAdmin: true, adminOnly: false, redirect: ['/profile'] })).toEqual({
      path: '/profile',
      signOut: false
    })
  })

  // CLAUDEX: W-CONSOLE a non-admin leaves the console for the web app at '/'
  it('signs a non-admin out and sends them to the web app while the setting is on', () => {
    expect(resolvePostLoginTarget({ isAdmin: false, adminOnly: true, redirect: '/admin/my/keys' })).toEqual({
      path: '/',
      signOut: true
    })
  })

  it('keeps the upstream destination for non-admins while the setting is off', () => {
    expect(resolvePostLoginTarget({ isAdmin: false, adminOnly: false })).toEqual({ path: '/admin/my/dashboard', signOut: false })
    expect(resolvePostLoginTarget({ isAdmin: false, adminOnly: false, redirect: '/admin/my/keys' })).toEqual({
      path: '/admin/my/keys',
      signOut: false
    })
  })

  it('ignores redirects that leave the app', () => {
    for (const redirect of ['https://evil.example', '//evil.example', '/\\evil.example', '/\t/evil.example', '/\n/evil.example', 'javascript:alert(1)', 42]) {
      expect(resolvePostLoginTarget({ isAdmin: true, adminOnly: true, redirect }).path, String(redirect)).toBe(
        '/admin/dashboard'
      )
    }
  })
})

describe('resolveCompletedSetupRedirectPath with web_console_admin_only', () => {
  // CLAUDEX: W-CONSOLE the web app replaces /desktop-only; console pages under /admin
  it('sends a signed-in non-admin to the web app only while the setting is on', () => {
    expect(resolveCompletedSetupRedirectPath(true, false, true)).toBe('/')
    expect(resolveCompletedSetupRedirectPath(true, false, false)).toBe('/admin/my/dashboard')
    expect(resolveCompletedSetupRedirectPath(true, false)).toBe('/admin/my/dashboard')
    expect(resolveCompletedSetupRedirectPath(true, true, true)).toBe('/admin/dashboard')
    expect(resolveCompletedSetupRedirectPath(false, false, true)).toBe('/admin/login')
  })
})

describe('useWebConsoleStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    api.get.mockReset()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  async function loadWith(answer: () => Promise<unknown>) {
    api.get.mockImplementation(answer)
    const { useWebConsoleStore } = await import('@/stores/webConsole')
    const store = useWebConsoleStore()
    expect(store.adminOnly).toBe(true)
    await store.ensureLoaded()
    return store
  }

  it('asks GET /claudex/web-console with a 3 second timeout', async () => {
    await loadWith(async () => ({ data: { admin_only: true } }))
    expect(api.get).toHaveBeenCalledWith('/claudex/web-console', { timeout: 3000 })
  })

  it('opens the console only on an explicit admin_only: false', async () => {
    const store = await loadWith(async () => ({ data: { admin_only: false } }))
    expect(store.adminOnly).toBe(false)
    expect(store.loaded).toBe(true)
  })

  it.each([
    ['true', async () => ({ data: { admin_only: true } })],
    ['a missing field', async () => ({ data: {} })],
    ['an empty answer', async () => ({ data: null })],
    ['a non-boolean', async () => ({ data: { admin_only: 'no' } })]
  ])('keeps the console for admins only on %s', async (_name, answer) => {
    const store = await loadWith(answer)
    expect(store.adminOnly).toBe(true)
  })

  it('fails closed when the server has no such setting or cannot be reached', async () => {
    const store = await loadWith(async () => {
      throw { status: 404, message: 'Not Found' }
    })
    expect(store.adminOnly).toBe(true)
    expect(store.loaded).toBe(false)
  })

  it('reads the setting once per page load, even when calls overlap', async () => {
    api.get.mockResolvedValue({ data: { admin_only: false } })
    const { useWebConsoleStore } = await import('@/stores/webConsole')
    const store = useWebConsoleStore()
    await Promise.all([store.ensureLoaded(), store.ensureLoaded()])
    await store.ensureLoaded()
    expect(api.get).toHaveBeenCalledTimes(1)
  })

  it('applies a value the admin saved without another request', async () => {
    const store = await loadWith(async () => ({ data: { admin_only: true } }))
    store.setAdminOnly(false)
    await store.ensureLoaded()
    expect(store.adminOnly).toBe(false)
    expect(api.get).toHaveBeenCalledTimes(1)
  })
})

describe('getClientRelease', () => {
  beforeEach(() => api.get.mockReset())

  it('sends only the known platform fields', async () => {
    api.get.mockResolvedValue({ data: { api_version: 1, server: { version: '0.2.8', build_type: 'source' } } })
    const { getClientRelease } = await import('@/api/claudexPublic')
    const release = await getClientRelease({ platform: 'darwin', arch: undefined })
    expect(api.get).toHaveBeenCalledWith('/claudex/release', { params: { platform: 'darwin' } })
    expect(release.api_version).toBe(1)
  })
})
