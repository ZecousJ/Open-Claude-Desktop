import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest' // CLAUDEX: beforeAll, afterAll
import { setActivePinia, createPinia } from 'pinia'
import { resolveCompletedSetupRedirectPath } from '@/router/setupRedirect'

// Mock 导航加载状态
vi.mock('@/composables/useNavigationLoading', () => {
  const mockStart = vi.fn()
  const mockEnd = vi.fn()
  return {
    useNavigationLoadingState: () => ({
      startNavigation: mockStart,
      endNavigation: mockEnd,
      isLoading: { value: false },
    }),
    useNavigationLoading: () => ({
      startNavigation: mockStart,
      endNavigation: mockEnd,
      isLoading: { value: false },
    }),
  }
})

// Mock 路由预加载
vi.mock('@/composables/useRoutePrefetch', () => ({
  useRoutePrefetch: () => ({
    triggerPrefetch: vi.fn(),
    cancelPendingPrefetch: vi.fn(),
    resetPrefetchState: vi.fn(),
  }),
}))

// Mock API 相关模块
vi.mock('@/api', () => ({
  authAPI: {
    getCurrentUser: vi.fn().mockResolvedValue({ data: {} }),
    logout: vi.fn(),
  },
  isTotp2FARequired: () => false,
}))

vi.mock('@/api/admin/system', () => ({
  checkUpdates: vi.fn(),
}))

vi.mock('@/api/auth', () => ({
  getPublicSettings: vi.fn(),
}))


// 用于测试的 auth 状态
interface MockAuthState {
  isAuthenticated: boolean
  isAdmin: boolean
  isSimpleMode: boolean
  backendModeEnabled: boolean
  hasPendingAuthSession: boolean
  setupNeedsSetup?: boolean
}

/**
 * 将 router/index.ts 中 beforeEach 守卫的核心逻辑提取为可测试的函数
 */
function simulateGuard(
  toPath: string,
  toMeta: Record<string, any>,
  authState: MockAuthState
): string | null {
  const requiresAuth = toMeta.requiresAuth !== false
  const requiresAdmin = toMeta.requiresAdmin === true

  if (toPath === '/setup' && authState.setupNeedsSetup === false) {
    return resolveCompletedSetupRedirectPath(authState.isAuthenticated, authState.isAdmin)
  }

  // 不需要认证的路由
  if (!requiresAuth) {
    if (
      authState.isAuthenticated &&
      (toPath === '/login' || toPath === '/register')
    ) {
      if (authState.backendModeEnabled && !authState.isAdmin) {
        return null
      }
      return authState.isAdmin ? '/admin/dashboard' : '/dashboard'
    }
    if (authState.backendModeEnabled && !authState.isAuthenticated) {
      const allowed = ['/login', '/key-usage', '/setup', '/payment/result']
      const callbackPaths = [
        '/auth/callback',
        '/auth/linuxdo/callback',
        '/auth/oidc/callback',
        '/auth/wechat/callback',
        '/auth/wechat/payment/callback',
      ]
      const pendingAuthPaths = ['/register', '/email-verify']
      const isAllowed =
        allowed.some((path) => toPath === path || toPath.startsWith(path)) ||
        callbackPaths.includes(toPath) ||
        (authState.hasPendingAuthSession && pendingAuthPaths.includes(toPath))
      if (!isAllowed) {
        return '/login'
      }
    }
    return null // 允许通过
  }

  // 需要认证但未登录
  if (!authState.isAuthenticated) {
    return '/login'
  }

  // 需要管理员但不是管理员
  if (requiresAdmin && !authState.isAdmin) {
    return '/dashboard'
  }

  // 简易模式限制
  if (authState.isSimpleMode) {
    const restrictedPaths = [
      '/admin/subscriptions',
      '/admin/redeem',
      '/subscriptions',
      '/redeem',
    ]
    if (restrictedPaths.some((path) => toPath.startsWith(path))) {
      return authState.isAdmin ? '/admin/dashboard' : '/dashboard'
    }
  }

  // Backend mode: admin gets full access, non-admin blocked
  if (authState.backendModeEnabled) {
    if (authState.isAuthenticated && authState.isAdmin) {
      return null
    }
    const allowed = ['/login', '/key-usage', '/setup', '/payment/result']
    const callbackPaths = [
      '/auth/callback',
      '/auth/linuxdo/callback',
      '/auth/oidc/callback',
      '/auth/wechat/callback',
      '/auth/wechat/payment/callback',
    ]
    const pendingAuthPaths = ['/register', '/email-verify']
    const isAllowed =
      allowed.some((path) => toPath === path || toPath.startsWith(path)) ||
      callbackPaths.includes(toPath) ||
      (authState.hasPendingAuthSession && pendingAuthPaths.includes(toPath))
    if (!isAllowed) {
      return '/login'
    }
  }

  return null // 允许通过
}

describe('路由守卫逻辑', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  // --- 未认证用户 ---

  describe('未认证用户', () => {
    const authState: MockAuthState = {
      isAuthenticated: false,
      isAdmin: false,
      isSimpleMode: false,
      backendModeEnabled: false,
      hasPendingAuthSession: false,
    }

    it('访问需要认证的页面重定向到 /login', () => {
      const redirect = simulateGuard('/dashboard', {}, authState)
      expect(redirect).toBe('/login')
    })

    it('访问管理页面重定向到 /login', () => {
      const redirect = simulateGuard('/admin/dashboard', { requiresAdmin: true }, authState)
      expect(redirect).toBe('/login')
    })

    it('访问公开页面允许通过', () => {
      const redirect = simulateGuard('/login', { requiresAuth: false }, authState)
      expect(redirect).toBeNull()
    })

    it('访问 /home 公开页面允许通过', () => {
      const redirect = simulateGuard('/home', { requiresAuth: false }, authState)
      expect(redirect).toBeNull()
    })
  })

  // --- 已认证普通用户 ---

  describe('已认证普通用户', () => {
    const authState: MockAuthState = {
      isAuthenticated: true,
      isAdmin: false,
      isSimpleMode: false,
      backendModeEnabled: false,
      hasPendingAuthSession: false,
    }

    it('访问 /login 重定向到 /dashboard', () => {
      const redirect = simulateGuard('/login', { requiresAuth: false }, authState)
      expect(redirect).toBe('/dashboard')
    })

    it('访问 /register 重定向到 /dashboard', () => {
      const redirect = simulateGuard('/register', { requiresAuth: false }, authState)
      expect(redirect).toBe('/dashboard')
    })

    it('访问 /dashboard 允许通过', () => {
      const redirect = simulateGuard('/dashboard', {}, authState)
      expect(redirect).toBeNull()
    })

    it('访问管理页面被拒绝，重定向到 /dashboard', () => {
      const redirect = simulateGuard('/admin/dashboard', { requiresAdmin: true }, authState)
      expect(redirect).toBe('/dashboard')
    })

    it('访问 /admin/users 被拒绝', () => {
      const redirect = simulateGuard('/admin/users', { requiresAdmin: true }, authState)
      expect(redirect).toBe('/dashboard')
    })
  })

  // --- 已认证管理员 ---

  describe('已认证管理员', () => {
    const authState: MockAuthState = {
      isAuthenticated: true,
      isAdmin: true,
      isSimpleMode: false,
      backendModeEnabled: false,
      hasPendingAuthSession: false,
    }

    it('访问 /login 重定向到 /admin/dashboard', () => {
      const redirect = simulateGuard('/login', { requiresAuth: false }, authState)
      expect(redirect).toBe('/admin/dashboard')
    })

    it('访问管理页面允许通过', () => {
      const redirect = simulateGuard('/admin/dashboard', { requiresAdmin: true }, authState)
      expect(redirect).toBeNull()
    })

    it('访问用户页面允许通过', () => {
      const redirect = simulateGuard('/dashboard', {}, authState)
      expect(redirect).toBeNull()
    })
  })

  // --- 简易模式 ---

  describe('简易模式受限路由', () => {
    it('普通用户简易模式访问 /subscriptions 重定向到 /dashboard', () => {
      const authState: MockAuthState = {
        isAuthenticated: true,
        isAdmin: false,
        isSimpleMode: true,
        backendModeEnabled: false,
        hasPendingAuthSession: false,
      }
      const redirect = simulateGuard('/subscriptions', {}, authState)
      expect(redirect).toBe('/dashboard')
    })

    it('普通用户简易模式访问 /redeem 重定向到 /dashboard', () => {
      const authState: MockAuthState = {
        isAuthenticated: true,
        isAdmin: false,
        isSimpleMode: true,
        backendModeEnabled: false,
        hasPendingAuthSession: false,
      }
      const redirect = simulateGuard('/redeem', {}, authState)
      expect(redirect).toBe('/dashboard')
    })

    it('管理员简易模式访问 /admin/groups 允许通过', () => {
      const authState: MockAuthState = {
        isAuthenticated: true,
        isAdmin: true,
        isSimpleMode: true,
        backendModeEnabled: false,
        hasPendingAuthSession: false,
      }
      const redirect = simulateGuard('/admin/groups', { requiresAdmin: true }, authState)
      expect(redirect).toBeNull()
    })

    it('管理员简易模式访问 /admin/subscriptions 重定向', () => {
      const authState: MockAuthState = {
        isAuthenticated: true,
        isAdmin: true,
        isSimpleMode: true,
        backendModeEnabled: false,
        hasPendingAuthSession: false,
      }
      const redirect = simulateGuard(
        '/admin/subscriptions',
        { requiresAdmin: true },
        authState
      )
      expect(redirect).toBe('/admin/dashboard')
    })

    it('简易模式下非受限页面正常访问', () => {
      const authState: MockAuthState = {
        isAuthenticated: true,
        isAdmin: false,
        isSimpleMode: true,
        backendModeEnabled: false,
        hasPendingAuthSession: false,
      }
      const redirect = simulateGuard('/dashboard', {}, authState)
      expect(redirect).toBeNull()
    })

    it('简易模式下 /keys 正常访问', () => {
      const authState: MockAuthState = {
        isAuthenticated: true,
        isAdmin: false,
        isSimpleMode: true,
        backendModeEnabled: false,
        hasPendingAuthSession: false,
      }
      const redirect = simulateGuard('/keys', {}, authState)
      expect(redirect).toBeNull()
    })
  })

  describe('Backend Mode', () => {
    it('unauthenticated: /home redirects to /login', () => {
      const authState: MockAuthState = {
        isAuthenticated: false,
        isAdmin: false,
        isSimpleMode: false,
        backendModeEnabled: true,
        hasPendingAuthSession: false,
      }
      const redirect = simulateGuard('/home', { requiresAuth: false }, authState)
      expect(redirect).toBe('/login')
    })

    it('unauthenticated: /login is allowed', () => {
      const authState: MockAuthState = {
        isAuthenticated: false,
        isAdmin: false,
        isSimpleMode: false,
        backendModeEnabled: true,
        hasPendingAuthSession: false,
      }
      const redirect = simulateGuard('/login', { requiresAuth: false }, authState)
      expect(redirect).toBeNull()
    })

    it('unauthenticated: /key-usage is allowed', () => {
      const authState: MockAuthState = {
        isAuthenticated: false,
        isAdmin: false,
        isSimpleMode: false,
        backendModeEnabled: true,
        hasPendingAuthSession: false,
      }
      const redirect = simulateGuard('/key-usage', { requiresAuth: false }, authState)
      expect(redirect).toBeNull()
    })

    it('unauthenticated: /setup is allowed', () => {
      const authState: MockAuthState = {
        isAuthenticated: false,
        isAdmin: false,
        isSimpleMode: false,
        backendModeEnabled: true,
        hasPendingAuthSession: false,
      }
      const redirect = simulateGuard('/setup', { requiresAuth: false }, authState)
      expect(redirect).toBeNull()
    })

    it('unauthenticated: initialized /setup redirects to /login', () => {
      const authState: MockAuthState = {
        isAuthenticated: false,
        isAdmin: false,
        isSimpleMode: false,
        backendModeEnabled: true,
        hasPendingAuthSession: false,
        setupNeedsSetup: false,
      }
      const redirect = simulateGuard('/setup', { requiresAuth: false }, authState)
      expect(redirect).toBe('/admin/login') // CLAUDEX: W-CONSOLE resolveCompletedSetupRedirectPath returns the console sign-in
    })

    it('admin: initialized /setup redirects to /admin/dashboard', () => {
      const authState: MockAuthState = {
        isAuthenticated: true,
        isAdmin: true,
        isSimpleMode: false,
        backendModeEnabled: true,
        hasPendingAuthSession: false,
        setupNeedsSetup: false,
      }
      const redirect = simulateGuard('/setup', { requiresAuth: false }, authState)
      expect(redirect).toBe('/admin/dashboard')
    })

    it('admin: /admin/dashboard is allowed', () => {
      const authState: MockAuthState = {
        isAuthenticated: true,
        isAdmin: true,
        isSimpleMode: false,
        backendModeEnabled: true,
        hasPendingAuthSession: false,
      }
      const redirect = simulateGuard('/admin/dashboard', { requiresAdmin: true }, authState)
      expect(redirect).toBeNull()
    })

    it('admin: /login redirects to /admin/dashboard', () => {
      const authState: MockAuthState = {
        isAuthenticated: true,
        isAdmin: true,
        isSimpleMode: false,
        backendModeEnabled: true,
        hasPendingAuthSession: false,
      }
      const redirect = simulateGuard('/login', { requiresAuth: false }, authState)
      expect(redirect).toBe('/admin/dashboard')
    })

    it('non-admin authenticated: /dashboard redirects to /login', () => {
      const authState: MockAuthState = {
        isAuthenticated: true,
        isAdmin: false,
        isSimpleMode: false,
        backendModeEnabled: true,
        hasPendingAuthSession: false,
      }
      const redirect = simulateGuard('/dashboard', {}, authState)
      expect(redirect).toBe('/login')
    })

    it('non-admin authenticated: /login is allowed (no redirect loop)', () => {
      const authState: MockAuthState = {
        isAuthenticated: true,
        isAdmin: false,
        isSimpleMode: false,
        backendModeEnabled: true,
        hasPendingAuthSession: false,
      }
      const redirect = simulateGuard('/login', { requiresAuth: false }, authState)
      expect(redirect).toBeNull()
    })

    it('non-admin authenticated: /key-usage is allowed', () => {
      const authState: MockAuthState = {
        isAuthenticated: true,
        isAdmin: false,
        isSimpleMode: false,
        backendModeEnabled: true,
        hasPendingAuthSession: false,
      }
      const redirect = simulateGuard('/key-usage', { requiresAuth: false }, authState)
      expect(redirect).toBeNull()
    })

    it('unauthenticated: callback routes are allowed', () => {
      const authState: MockAuthState = {
        isAuthenticated: false,
        isAdmin: false,
        isSimpleMode: false,
        backendModeEnabled: true,
        hasPendingAuthSession: false,
      }
      const redirect = simulateGuard('/auth/wechat/callback', { requiresAuth: false }, authState)
      expect(redirect).toBeNull()
    })

    it('unauthenticated: WeChat payment callback route is allowed', () => {
      const authState: MockAuthState = {
        isAuthenticated: false,
        isAdmin: false,
        isSimpleMode: false,
        backendModeEnabled: true,
        hasPendingAuthSession: false,
      }
      const redirect = simulateGuard('/auth/wechat/payment/callback', { requiresAuth: false }, authState)
      expect(redirect).toBeNull()
    })

    it('unauthenticated: /payment/result is allowed', () => {
      const authState: MockAuthState = {
        isAuthenticated: false,
        isAdmin: false,
        isSimpleMode: false,
        backendModeEnabled: true,
        hasPendingAuthSession: false,
      }
      const redirect = simulateGuard('/payment/result', { requiresAuth: false }, authState)
      expect(redirect).toBeNull()
    })

    it('unauthenticated: /register is allowed when a pending auth session exists', () => {
      const authState: MockAuthState = {
        isAuthenticated: false,
        isAdmin: false,
        isSimpleMode: false,
        backendModeEnabled: true,
        hasPendingAuthSession: true,
      }
      const redirect = simulateGuard('/register', { requiresAuth: false }, authState)
      expect(redirect).toBeNull()
    })

    it('unauthenticated: /email-verify is blocked without a pending auth session', () => {
      const authState: MockAuthState = {
        isAuthenticated: false,
        isAdmin: false,
        isSimpleMode: false,
        backendModeEnabled: true,
        hasPendingAuthSession: false,
      }
      const redirect = simulateGuard('/email-verify', { requiresAuth: false }, authState)
      expect(redirect).toBe('/login')
    })
  })
})

// ==================== CLAUDEX: web console for admins only ====================
// Runs the real beforeEach guard of router/index.ts (vue-router is mocked to
// capture the guard and the route table; the auth and app stores are mocked;
// the web console store is the real one reading a mocked
// GET /api/v1/claudex/web-console). A small resolver follows the route table's
// redirects so every navigation can be followed to its end.

type CapturedGuard = (
  to: Record<string, unknown>,
  from: Record<string, unknown>,
  next: ReturnType<typeof vi.fn>
) => Promise<void>

interface CapturedRoute {
  path: string
  name?: string
  alias?: string | string[]
  redirect?: string | ((to: unknown) => unknown)
  meta?: Record<string, unknown>
  beforeEnter?: (to: Record<string, unknown>) => unknown // CLAUDEX: W-CONSOLE the NotFound guard
}

const claudexRouter = vi.hoisted(() => ({
  guard: null as CapturedGuard | null,
  routes: [] as CapturedRoute[],
}))

const claudexAuth = vi.hoisted(() => ({
  checkAuth: vi.fn(),
  isAuthenticated: false,
  isAdmin: false,
  isSimpleMode: false,
  hasPendingAuthSession: false,
}))

const claudexApp = vi.hoisted(() => ({
  siteName: 'Sub2API',
  backendModeEnabled: false,
  publicSettingsLoaded: true,
  cachedPublicSettings: {} as Record<string, unknown>,
  fetchPublicSettings: vi.fn(),
}))

const claudexApi = vi.hoisted(() => ({
  getWebConsoleSetting: vi.fn(),
  getSetupStatus: vi.fn(),
}))

vi.mock('vue-router', () => ({
  createWebHistory: vi.fn(() => ({})),
  createRouter: vi.fn((options: { routes: CapturedRoute[] }) => {
    claudexRouter.routes = options.routes
    return {
      beforeEach: vi.fn((guard: CapturedGuard) => {
        claudexRouter.guard = guard
      }),
      afterEach: vi.fn(),
      onError: vi.fn(),
    }
  }),
}))

vi.mock('@/stores/auth', () => ({ useAuthStore: () => claudexAuth }))
vi.mock('@/stores/app', () => ({ useAppStore: () => claudexApp }))
vi.mock('@/stores/adminSettings', () => ({ useAdminSettingsStore: () => ({ customMenuItems: [] }) }))
vi.mock('@/stores/adminCompliance', () => ({
  useAdminComplianceStore: () => ({
    initialized: true,
    fetchStatus: vi.fn(),
    requireAcknowledgement: vi.fn(),
  }),
}))
vi.mock('@/api/claudexPublic', () => ({
  getWebConsoleSetting: (...args: unknown[]) => claudexApi.getWebConsoleSetting(...args),
}))
vi.mock('@/api/setup', () => ({
  getSetupStatus: (...args: unknown[]) => claudexApi.getSetupStatus(...args),
}))

function compileRoutePath(path: string): RegExp {
  if (path.startsWith('/:pathMatch')) return /^\/.*$/i
  const pattern = path
    .split('/')
    .map((segment) => (segment.startsWith(':') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/')
  return new RegExp(`^${pattern}/?$`, 'i')
}

/** Resolves a location against the captured route table, following record redirects. */
function resolveLocation(fullPath: string, redirectedFrom?: string): Record<string, any> {
  const [path, query = ''] = fullPath.split('?')
  for (const record of claudexRouter.routes) {
    const aliases = record.alias ? ([] as string[]).concat(record.alias) : []
    if (![record.path, ...aliases].some((candidate) => compileRoutePath(candidate).test(path))) continue
    if (record.redirect) {
      const target =
        typeof record.redirect === 'function' ? record.redirect({ path, fullPath }) : record.redirect
      return resolveLocation(String(target), redirectedFrom ?? path)
    }
    return {
      path,
      fullPath,
      name: record.name,
      params: {},
      query: Object.fromEntries(new URLSearchParams(query)),
      meta: record.meta ?? {},
      beforeEnter: record.beforeEnter, // CLAUDEX: W-CONSOLE
      redirectedFrom: redirectedFrom ? { path: redirectedFrom, fullPath: redirectedFrom } : undefined,
    }
  }
  throw new Error(`no route for ${fullPath}`)
}

function nextTarget(arg: unknown): string {
  if (typeof arg === 'string') return arg
  const location = arg as { path: string; query?: Record<string, string> }
  const query = location.query ? new URLSearchParams(location.query).toString() : ''
  return query ? `${location.path}?${query}` : location.path
}

// CLAUDEX: W-CONSOLE a redirect to the web app is a full-page window.location.replace('/')
// (the router then calls next(false)); navigate() reports it as WEB_APP.
const WEB_APP = 'web-app:/'
const locationReplace = vi.fn()

/** Navigates like the router would: runs the guard and follows its redirects. */
async function navigate(start: string): Promise<{ final: string; hops: string[] }> {
  if (!claudexRouter.guard) throw new Error('router guard was not registered')
  const hops: string[] = []
  let to = resolveLocation(start)
  for (let i = 0; i < 8; i++) {
    const next = vi.fn()
    locationReplace.mockClear()
    await claudexRouter.guard(to, {}, next)
    expect(next).toHaveBeenCalledTimes(1)
    const arg = next.mock.calls[0][0]
    if (arg === false) {
      expect(locationReplace).toHaveBeenCalledWith('/')
      hops.push(WEB_APP)
      return { final: WEB_APP, hops }
    }
    if (arg === undefined) {
      // CLAUDEX: W-CONSOLE the per-route guard of the NotFound page hands root paths to the web app.
      if (typeof to.beforeEnter === 'function' && to.beforeEnter(to) === false) {
        expect(locationReplace).toHaveBeenCalledWith('/')
        hops.push(WEB_APP)
        return { final: WEB_APP, hops }
      }
      return { final: to.path, hops }
    }
    const target = nextTarget(arg)
    hops.push(target)
    to = resolveLocation(target)
  }
  throw new Error(`redirect loop from ${start}: ${hops.join(' -> ')}`)
}

type Viewer = 'anonymous' | 'user' | 'admin'

function signInAs(viewer: Viewer, options: { pendingAuth?: boolean } = {}) {
  claudexAuth.isAuthenticated = viewer !== 'anonymous'
  claudexAuth.isAdmin = viewer === 'admin'
  claudexAuth.hasPendingAuthSession = options.pendingAuth === true
}

type SettingCase = 'on' | 'off' | 'missing' | 'malformed'

function serveSetting(setting: SettingCase) {
  claudexApi.getWebConsoleSetting.mockReset()
  if (setting === 'missing') {
    claudexApi.getWebConsoleSetting.mockRejectedValue({ status: 404, message: 'Not Found' })
  } else if (setting === 'malformed') {
    claudexApi.getWebConsoleSetting.mockResolvedValue({})
  } else {
    claudexApi.getWebConsoleSetting.mockResolvedValue({ admin_only: setting === 'on' })
  }
}

// CLAUDEX: W-CONSOLE console pages live under /admin; the others are console root pages
const ADMIN_ONLY_PUBLIC_PAGES = [
  '/admin/login',
  '/admin/setup',
  '/legal/terms',
  '/admin/forgot-password',
  '/reset-password',
  '/desktop-only',
  '/desktop-pay',
  '/payment/result',
  '/auth/wechat/payment/callback',
  '/auth/callback',
  '/auth/oauth/callback',
  '/auth/linuxdo/callback',
  '/auth/dingtalk/callback',
  '/auth/dingtalk/email-completion',
  '/auth/oidc/callback',
  '/auth/wechat/callback',
]

describe('Web console admin-only (CLAUDEX web_console_admin_only)', () => {
  const originalLocation = window.location

  beforeAll(async () => {
    await import('@/router')
  })

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, replace: locationReplace },
    })
    signInAs('anonymous')
    claudexApp.backendModeEnabled = false
    claudexApp.publicSettingsLoaded = true
    claudexApp.cachedPublicSettings = {}
    claudexApi.getSetupStatus.mockReset()
    claudexApi.getSetupStatus.mockResolvedValue({ needs_setup: false, step: '' })
    serveSetting('on')
  })

  afterAll(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation })
  })

  describe.each(['on', 'missing', 'malformed'] as SettingCase[])('setting %s: console for admins only', (setting) => {
    beforeEach(() => serveSetting(setting))

    it('anonymous: public pages outside the allow-list lead to /admin/login', async () => {
      for (const path of ['/admin/home', '/admin/key-usage', '/admin/model-plaza', '/admin/register', '/admin/email-verify']) {
        expect((await navigate(path)).final, path).toBe('/admin/login')
      }
    })

    it('anonymous: protected pages still ask to sign in', async () => {
      expect(await navigate('/admin/my/dashboard')).toEqual({
        final: '/admin/login',
        hops: ['/admin/login?redirect=%2Fadmin%2Fmy%2Fdashboard'],
      })
    })

    it('anonymous: /admin leads to /admin/login', async () => {
      expect((await navigate('/admin')).final).toBe('/admin/login')
    })

    it('non-admin: user and admin pages lead to the web app', async () => {
      signInAs('user')
      for (const path of ['/admin/my/dashboard', '/admin/my/keys', '/admin/my/profile', '/admin/my/purchase', '/admin/dashboard', '/admin/claudex/policy']) {
        expect(await navigate(path), path).toEqual({ final: WEB_APP, hops: [WEB_APP] })
      }
    })

    it('non-admin: /admin/login, /admin/register, /admin/home and /admin lead to the web app', async () => {
      signInAs('user')
      for (const path of ['/admin/login', '/admin/register', '/admin/home', '/admin']) {
        expect((await navigate(path)).final, path).toBe(WEB_APP)
      }
    })

    it('admin: every page stays reachable, /admin leads to the admin dashboard', async () => {
      signInAs('admin')
      for (const path of ['/admin/my/profile', '/admin/claudex/policy', '/admin/dashboard', '/admin/my/dashboard', '/admin/home', '/admin/settings']) {
        expect(await navigate(path), path).toEqual({ final: path, hops: [] })
      }
      expect((await navigate('/admin')).final).toBe('/admin/dashboard')
      expect((await navigate('/admin/login')).final).toBe('/admin/dashboard')
    })
  })

  describe('allowed public pages while the console is for admins only', () => {
    it.each(ADMIN_ONLY_PUBLIC_PAGES)('anonymous can open %s', async (path) => {
      claudexApi.getSetupStatus.mockResolvedValue({ needs_setup: true, step: 'database' })
      expect(await navigate(path)).toEqual({ final: path, hops: [] })
    })

    it.each(ADMIN_ONLY_PUBLIC_PAGES.filter((path) => path !== '/admin/login'))(
      'signed-in non-admin can open %s',
      async (path) => {
        signInAs('user')
        claudexApi.getSetupStatus.mockResolvedValue({ needs_setup: true, step: 'database' })
        expect(await navigate(path)).toEqual({ final: path, hops: [] })
      }
    )

    it.each(ADMIN_ONLY_PUBLIC_PAGES.filter((path) => path !== '/admin/login'))('admin can open %s', async (path) => {
      signInAs('admin')
      claudexApi.getSetupStatus.mockResolvedValue({ needs_setup: true, step: 'database' })
      expect(await navigate(path)).toEqual({ final: path, hops: [] })
    })

    it('matches case-insensitively and with a trailing slash', async () => {
      expect((await navigate('/Reset-Password/')).final).toBe('/Reset-Password/')
      expect((await navigate('/LEGAL/privacy')).final).toBe('/LEGAL/privacy')
    })

    it('keeps the upstream Stripe and Airwallex pages closed to non-admins (desktop orders use /desktop-pay)', async () => {
      const upstreamPaymentPages = ['/admin/payment/stripe', '/admin/payment/airwallex', '/admin/payment/stripe-popup']
      for (const path of upstreamPaymentPages) {
        signInAs('anonymous')
        expect((await navigate(`${path}?order_id=1&client_secret=pi_1_secret_2`)).final, path).toBe('/admin/login')
        signInAs('user')
        expect((await navigate(path)).final, path).toBe(WEB_APP)
        signInAs('admin')
        expect((await navigate(path)).final, path).toBe(path)
      }
    })

    it('allows /admin/register and /admin/email-verify only during a pending third-party sign-in', async () => {
      signInAs('anonymous', { pendingAuth: true })
      expect((await navigate('/admin/register')).final).toBe('/admin/register')
      expect((await navigate('/admin/email-verify')).final).toBe('/admin/email-verify')
    })

    it('sends a signed-in non-admin from a finished /admin/setup to the web app', async () => {
      signInAs('user')
      expect((await navigate('/admin/setup')).final).toBe(WEB_APP)
      signInAs('anonymous')
      expect((await navigate('/admin/setup')).final).toBe('/admin/login')
      signInAs('admin')
      expect((await navigate('/admin/setup')).final).toBe('/admin/dashboard')
    })
  })

  describe('setting off: upstream behavior', () => {
    beforeEach(() => serveSetting('off'))

    it('lets everyone use the user pages again', async () => {
      expect((await navigate('/admin/home')).final).toBe('/admin/home')
      signInAs('user')
      expect((await navigate('/admin/my/dashboard')).final).toBe('/admin/my/dashboard')
      expect((await navigate('/admin/login')).final).toBe('/admin/my/dashboard')
      expect((await navigate('/admin/dashboard')).final).toBe('/admin/my/dashboard')
      expect((await navigate('/admin/setup')).final).toBe('/admin/my/dashboard')
      signInAs('admin')
      expect((await navigate('/admin')).final).toBe('/admin/dashboard')
    })
  })

  // CLAUDEX: W-CONSOLE the root of the site belongs to the web app
  describe('root paths outside the console', () => {
    it('hands unknown root paths back to the web app instead of a 404', async () => {
      for (const viewer of ['anonymous', 'user', 'admin'] as Viewer[]) {
        signInAs(viewer)
        expect((await navigate('/does-not-exist')).final, viewer).toBe(WEB_APP)
      }
    })

    it('shows the 404 page for unknown paths under /admin', async () => {
      signInAs('admin')
      expect(await navigate('/admin/does-not-exist')).toEqual({ final: '/admin/does-not-exist', hops: [] })
    })

    it('has no console route at the site root', () => {
      expect(claudexRouter.routes.some((record) => record.path === '/')).toBe(false)
    })
  })

  it('reads the setting once per page load', async () => {
    await navigate('/admin/login')
    await navigate('/reset-password')
    signInAs('user')
    await navigate('/admin/my/dashboard')
    expect(claudexApi.getWebConsoleSetting).toHaveBeenCalledTimes(1)
  })

  it('keeps the console for admins only when the setting cannot be read', async () => {
    serveSetting('missing')
    signInAs('user')
    expect((await navigate('/admin/my/dashboard')).final).toBe(WEB_APP)
    expect(claudexApi.getWebConsoleSetting).toHaveBeenCalledTimes(1)
  })

  it('works together with Backend mode without loops', async () => {
    claudexApp.backendModeEnabled = true
    expect((await navigate('/admin/home')).final).toBe('/admin/login')
    signInAs('user')
    expect((await navigate('/admin/my/dashboard')).final).toBe(WEB_APP)
    expect((await navigate('/admin/login')).final).toBe(WEB_APP)
    signInAs('admin')
    expect((await navigate('/admin/claudex/overview')).final).toBe('/admin/claudex/overview')
  })

  describe('no redirect loops', () => {
    function staticPaths(): string[] {
      const paths = claudexRouter.routes
        .map((record) => record.path.replace(/:documentId/, 'terms').replace(/:id/, '1'))
        .filter((path) => !path.startsWith('/:pathMatch'))
      return [...new Set([...paths, '/admin/does-not-exist', '/does-not-exist'])]
    }

    it.each([
      ['on', 'anonymous'],
      ['on', 'user'],
      ['on', 'admin'],
      ['off', 'anonymous'],
      ['off', 'user'],
      ['off', 'admin'],
      ['missing', 'user'],
    ] as Array<[SettingCase, Viewer]>)('setting %s, %s: every route ends on a page the viewer may see', async (setting, viewer) => {
      serveSetting(setting)
      signInAs(viewer)
      claudexApi.getSetupStatus.mockResolvedValue({ needs_setup: false, step: '' })
      const adminOnly = setting !== 'off'
      for (const path of staticPaths()) {
        const { final, hops } = await navigate(path)
        expect(hops.length, `${path} -> ${hops.join(' -> ')}`).toBeLessThanOrEqual(2)
        const onAllowedPage = final === WEB_APP || ADMIN_ONLY_PUBLIC_PAGES.some((page) => final.startsWith(page))
        if (adminOnly && viewer === 'user') {
          expect(onAllowedPage, `${path} ended on ${final}`).toBe(true)
          expect(final, `${path}`).not.toBe('/admin/login')
        }
        if (adminOnly && viewer === 'anonymous') {
          expect(onAllowedPage, `${path} ended on ${final}`).toBe(true)
        }
        if (viewer === 'admin' && path !== '/does-not-exist') {
          expect(final, `${path}`).not.toBe(WEB_APP)
        }
      }
    })
  })
})
