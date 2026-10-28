/**
 * CLAUDEX: W-CONSOLE the console routes must fit the site URL layout in
 * reserved_paths.json (W-SITE). The Go site server hands the console index only
 * to /admin/* and to console_root_pages; every other path goes to the web app,
 * so a Vue route outside those would never be reached.
 */
import { describe, expect, it, vi } from 'vitest'
import type { RouteRecordRaw } from 'vue-router'
import reservedPaths from '../../../../backend/internal/web/sitepaths/reserved_paths.json'

const authStore = vi.hoisted(() => ({
  checkAuth: vi.fn(),
  isAuthenticated: false,
  isAdmin: false,
  isSimpleMode: false
}))

vi.mock('@/stores/auth', () => ({ useAuthStore: () => authStore }))
vi.mock('@/stores/app', () => ({
  useAppStore: () => ({ siteName: 'Sub2API', backendModeEnabled: false, cachedPublicSettings: null })
}))
vi.mock('@/stores/adminSettings', () => ({
  useAdminSettingsStore: () => ({ customMenuItems: [] })
}))
vi.mock('@/composables/useNavigationLoading', () => ({
  useNavigationLoadingState: () => ({
    startNavigation: vi.fn(),
    endNavigation: vi.fn(),
    isLoading: { value: false }
  })
}))
vi.mock('@/composables/useRoutePrefetch', () => ({
  useRoutePrefetch: () => ({
    triggerPrefetch: vi.fn(),
    cancelPendingPrefetch: vi.fn(),
    resetPrefetchState: vi.fn()
  })
}))

const CONSOLE_BASE = reservedPaths.console.base
const ROOT_EXACT = new Set<string>(reservedPaths.console_root_pages.exact)
const ROOT_PREFIXES: string[] = reservedPaths.console_root_pages.prefixes

/** Every path a route record answers to: its path, its aliases, and its children's. */
function collectPaths(records: readonly RouteRecordRaw[], parent = ''): string[] {
  const paths: string[] = []
  for (const record of records) {
    const own = [record.path, ...(record.alias ? ([] as string[]).concat(record.alias) : [])]
    for (const p of own) {
      const full = p.startsWith('/') ? p : `${parent.replace(/\/$/, '')}/${p}`
      paths.push(full)
      if (record.children) paths.push(...collectPaths(record.children, full))
    }
  }
  return paths
}

function isServedByConsole(path: string): boolean {
  if (path === CONSOLE_BASE || path.startsWith(`${CONSOLE_BASE}/`)) return true
  if (ROOT_EXACT.has(path)) return true
  // A dynamic root page such as /legal/:documentId is covered by its prefix.
  return ROOT_PREFIXES.some((prefix) => path.startsWith(prefix))
}

describe('console routes and reserved_paths.json', () => {
  it('reads the console base from the shared file', () => {
    expect(CONSOLE_BASE).toBe('/admin')
  })

  it('puts every route under /admin or on a console root page', async () => {
    const { default: router } = await import('@/router')
    const paths = collectPaths(router.options.routes)
    expect(paths.length).toBeGreaterThan(20)

    // The catch-all is the only route that matches anything; its guard sends
    // non-console paths back to the web app. /reset-password is the web app's
    // own page; the console keeps its route for a server without the web app.
    const outside = paths.filter(
      (p) => p !== '/:pathMatch(.*)*' && p !== '/reset-password' && !isServedByConsole(p)
    )
    expect(outside).toEqual([])
  })

  it('has no route at the site root', async () => {
    const { default: router } = await import('@/router')
    expect(collectPaths(router.options.routes)).not.toContain('/')
  })

  it('resolves every legacy redirect target to a real route', async () => {
    const { default: router } = await import('@/router')
    const targets = [
      ...Object.values(reservedPaths.legacy_redirects.exact),
      // Prefix redirects keep the rest of the path; check a sample id.
      ...Object.values(reservedPaths.legacy_redirects.prefixes).map((to) => `${to}sample-id`)
    ]
    const unresolved = targets.filter((target) => {
      const resolved = router.resolve(target)
      return resolved.matched.length === 0 || resolved.name === 'NotFound'
    })
    expect(unresolved).toEqual([])
  })

  it('resolves the admin login redirect target', async () => {
    const { default: router } = await import('@/router')
    const resolved = router.resolve(reservedPaths.admin_login_redirect.to)
    expect(resolved.name).not.toBe('NotFound')
    expect(resolved.path).toBe('/admin/login')
  })

  it('resolves every console root page to a real route', async () => {
    const { default: router } = await import('@/router')
    const pages = [...ROOT_EXACT, ...ROOT_PREFIXES.map((prefix) => `${prefix}sample`)]
    const unresolved = pages.filter((page) => router.resolve(page).name === 'NotFound')
    expect(unresolved).toEqual([])
  })
})
